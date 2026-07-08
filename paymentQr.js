/* ==========================================================================
   MONYK — paymentQr.js
   Közös, ingyenes, licenc nélküli fizetés-indítási segédmodul.

   FONTOS ELVI KORLÁTOK (lásd MONYK_Shared_Pairing_todo.md 14. szakasz):
   - A MONYK SOHA nem érinti, nem fogadja, nem továbbítja a pénzt.
   - Nincs automatikus visszaigazolás — a felhasználó kézzel jelöli
     "kifizetve"-nek a tételt a saját UI-jában, ahogy eddig is.
   - A banki QR (EPC/GiroCode) csak SEPA-térségbeli IBAN esetén jelenjen
     meg — csak akkor hívd meg, ha van megadott IBAN.
   - A PayPal-link/QR, a Revolut-link/QR és a Wise-link/QR mind sima,
     díjmentes személyes fizetési linkek — NEM API-integráción mennek,
     nincs webhook, nincs tranzakciós díj a MONYK oldalán.

   2026-07-07: egységesítve mindhárom app (Family, Finance/fő app, Travel)
   között — korábban a Travel saját, QR nélküli "nyitó linkes" megoldást
   használt Revolut/PayPal/Wise-hoz; mostantól mindhárom app ugyanezt a
   négy fület kínálja (Banki QR / PayPal / Revolut / Wise), amelyik adat
   éppen ki van töltve.

   Függőség: a qrcode.js (davidshimjs) könyvtárnak már be kell lennie töltve
   a HTML-ben, mielőtt ezt a fájlt betöltöd:
   <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
   ========================================================================== */

(function (global) {
  'use strict';

  // ── Karakterkészlet-tisztítás a SEPA közlemény/név mezőkhöz ──
  // A SEPA-szabvány csak korlátozott karakterkészletet enged: 0-9 A-Z a-z
  // ß / ? : ( ) . , ' + - és szóköz. Ékezetes betűket át kell írni, különben
  // egyes banki appok hibásan olvassák be vagy elutasítják a QR-t.
  const SEPA_CHAR_MAP = {
    'á':'a','é':'e','í':'i','ó':'o','ö':'oe','ő':'oe','ú':'u','ü':'ue','ű':'ue',
    'Á':'A','É':'E','Í':'I','Ó':'O','Ö':'OE','Ő':'OE','Ú':'U','Ü':'UE','Ű':'UE',
    'ä':'ae','Ä':'AE'
  };

  function sanitizeSepaText(str, maxLen) {
    if (!str) return '';
    let out = String(str).split('').map(ch => SEPA_CHAR_MAP[ch] !== undefined ? SEPA_CHAR_MAP[ch] : ch).join('');
    // Csak az engedélyezett karakterkészletet tartjuk meg
    out = out.replace(/[^0-9A-Za-z/?:().,'+\- ]/g, '');
    if (maxLen) out = out.slice(0, maxLen);
    return out.trim();
  }

  function sanitizeIban(iban) {
    return String(iban || '').replace(/\s+/g, '').toUpperCase();
  }

  // ── EPC-QR (GiroCode) szöveg összeállítása ──
  // Formátum: EPC069-12 guideline, "SCT" = sima SEPA-átutalás,
  // "INST" = azonnali (Echtzeit) átutalás, ha a bank támogatja.
  function buildEpcQrString({ iban, name, amount, reference, instant }) {
    const cleanIban = sanitizeIban(iban);
    if (!cleanIban) throw new Error('buildEpcQrString: hiányzó IBAN');
    const cleanName = sanitizeSepaText(name, 70) || 'MONYK';
    const cleanRef = sanitizeSepaText(reference, 140);
    const amountStr = 'EUR' + Number(amount || 0).toFixed(2);
    const lines = [
      'BCD',
      '002',
      '1',
      instant ? 'INST' : 'SCT',
      '',                 // BIC — 2016 óta elhagyható EU/EEA-n belül
      cleanName,
      cleanIban,
      amountStr,
      '',                 // opcionális "Purpose" kód — üresen hagyva
      cleanRef
    ];
    return lines.join('\n');
  }

  // ── PayPal.me link összeállítása ──
  // Sima, személyes fizetési link — a fogadó saját PayPal-fiókjába megy,
  // nincs API-integráció, nincs webhook, nincs tranzakciós díj (feltéve,
  // hogy a küldő egyenlegből/banki forrásból, nem kártyáról fizet, és
  // ugyanabban a pénznemben marad).
  function buildPaypalMeLink({ paypalUser, amount, currency }) {
    if (!paypalUser) throw new Error('buildPaypalMeLink: hiányzó PayPal felhasználónév');
    const cur = (currency || 'EUR').toUpperCase();
    const amt = Number(amount || 0).toFixed(2);
    const cleanUser = String(paypalUser).replace(/^@/, '').trim();
    return `https://paypal.me/${encodeURIComponent(cleanUser)}/${amt}${cur}`;
  }

  // ── Revolut.me link összeállítása ──
  // Sima, személyes fizetési link a fogadó saját Revolut-fiókjába — nincs
  // API-integráció, nincs webhook. Az összeg opcionális a linkben (ha nincs
  // megadva, a fogadó appjában kell majd beírni).
  function buildRevolutLink({ revolutUser, amount, currency }) {
    if (!revolutUser) throw new Error('buildRevolutLink: hiányzó Revolut felhasználónév');
    const cleanUser = String(revolutUser).replace(/^@/, '').trim();
    const amt = Number(amount || 0);
    const cur = (currency || 'EUR').toUpperCase();
    return `https://revolut.me/${encodeURIComponent(cleanUser)}${amt ? '/' + amt.toFixed(2) + cur : ''}`;
  }

  // ── Wise fizetési link összeállítása ──
  // A wise.com/pay/r/ link nem enged összeg-paramétert — a fogadó appjában
  // kell majd megadni.
  function buildWiseLink({ wiseUser }) {
    if (!wiseUser) throw new Error('buildWiseLink: hiányzó Wise felhasználónév');
    const cleanUser = String(wiseUser).replace(/^@/, '').trim();
    return `https://wise.com/pay/r/${encodeURIComponent(cleanUser)}`;
  }

  // ── Fizetési modal megjelenítése ──
  // opts: { iban, ibanName, paypalUser, revolutUser, wiseUser, amount,
  //         currency, reference, title }
  // A modal annyi fület kínál, amennyi adat elérhető: Banki QR / PayPal /
  // Revolut / Wise. Alapértelmezett fül prioritás: PayPal > Banki > Revolut > Wise.
  function showPaymentModal(opts) {
    opts = opts || {};
    const amount = Number(opts.amount || 0);
    const hasIban = !!sanitizeIban(opts.iban);
    const hasPaypal = !!opts.paypalUser;
    const hasRevolut = !!opts.revolutUser;
    const hasWise = !!opts.wiseUser;

    if (!hasIban && !hasPaypal && !hasRevolut && !hasWise) {
      if (typeof toast === 'function') toast('⚠️ Nincs megadva egyetlen fizetési adat sem ehhez a tételhez');
      return;
    }

    // Régi modal eltávolítása, ha nyitva maradt volna
    const old = document.getElementById('mpay-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mpay-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:var(--bg2,#fff);border-radius:18px;max-width:360px;width:100%;padding:22px;text-align:center;font-family:inherit;">
        <div style="font-weight:800;font-size:16px;margin-bottom:4px;">${opts.title || 'Utalás indítása'}</div>
        <div style="font-size:13px;opacity:.7;margin-bottom:14px;">${amount.toLocaleString('hu')} ${(opts.currency||'EUR')}</div>
        <div id="mpay-tabs" style="display:flex;gap:8px;justify-content:center;margin-bottom:14px;flex-wrap:wrap;"></div>
        <div id="mpay-body"></div>
        <div id="mpay-share-row" style="margin-top:14px;"></div>
        <button id="mpay-close" style="margin-top:16px;background:none;border:none;font-size:13px;opacity:.6;cursor:pointer;">Bezárás</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('mpay-close').onclick = () => overlay.remove();

    const tabsEl = document.getElementById('mpay-tabs');
    const bodyEl = document.getElementById('mpay-body');
    const shareRowEl = document.getElementById('mpay-share-row');

    function renderBank() {
      bodyEl.innerHTML = '<div id="mpay-qrbox" style="display:inline-block;padding:12px;background:#fff;border-radius:12px;"></div><div style="font-size:11px;opacity:.6;margin-top:8px;">Nyisd meg a banki appod, és szkenneld be a QR-kódot (GiroCode/EPC).</div>';
      const qrText = buildEpcQrString({
        iban: opts.iban,
        name: opts.ibanName || opts.recipientName,
        amount,
        reference: opts.reference
      });
      new QRCode(document.getElementById('mpay-qrbox'), {
        text: qrText, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M
      });
      renderShare(qrText, 'giro');
    }

    function renderPaypal() {
      const link = buildPaypalMeLink({ paypalUser: opts.paypalUser, amount, currency: opts.currency });
      bodyEl.innerHTML = `<div id="mpay-qrbox" style="display:inline-block;padding:12px;background:#fff;border-radius:12px;"></div>
        <div style="margin-top:10px;"><a href="${link}" target="_blank" style="font-weight:700;">PayPal megnyitása →</a></div>`;
      new QRCode(document.getElementById('mpay-qrbox'), {
        text: link, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M
      });
      renderShare(link, 'paypal');
    }

    function renderRevolut() {
      const link = buildRevolutLink({ revolutUser: opts.revolutUser, amount, currency: opts.currency });
      bodyEl.innerHTML = `<div id="mpay-qrbox" style="display:inline-block;padding:12px;background:#fff;border-radius:12px;"></div>
        <div style="margin-top:10px;"><a href="${link}" target="_blank" style="font-weight:700;">Revolut megnyitása →</a></div>`;
      new QRCode(document.getElementById('mpay-qrbox'), {
        text: link, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M
      });
      renderShare(link, 'revolut');
    }

    function renderWise() {
      const link = buildWiseLink({ wiseUser: opts.wiseUser });
      bodyEl.innerHTML = `<div id="mpay-qrbox" style="display:inline-block;padding:12px;background:#fff;border-radius:12px;"></div>
        <div style="margin-top:10px;"><a href="${link}" target="_blank" style="font-weight:700;">Wise megnyitása →</a></div>`;
      new QRCode(document.getElementById('mpay-qrbox'), {
        text: link, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M
      });
      renderShare(link, 'wise');
    }

    function renderShare(content, kind) {
      shareRowEl.innerHTML = '';

      // ── Segédfüggvény: canvas → PNG letöltés (fallback, ha nincs
      // fájl-megosztás támogatás) ──
      function downloadCanvasPng(canvas, filename) {
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        }, 'image/png');
      }

      // ── GiroCode/EPC-QR: a legtöbb banki app csak KÉPET tud beolvasni
      // vagy megnyitni fájlból, nyers szöveget nem — ezért itt a QR-t
      // képként (canvas → PNG fájl) osszuk meg, nem a nyers EPC-stringet. ──
      if (kind === 'giro') {
        const canvas = document.querySelector('#mpay-qrbox canvas');

        const btn = document.createElement('button');
        btn.style.cssText = 'background:var(--accent,#1B1B23);color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;';

        if (!canvas) {
          // Ha a QRCode könyvtár valamiért nem canvas-t renderelt (pl.
          // nagyon régi böngésző), nincs mit exportálni — nem mutatunk
          // megosztás gombot, mert a nyers szöveg megosztása félrevezető
          // lenne (nem olvasható be banki appal).
          return;
        }

        canvas.toBlob((blob) => {
          const file = blob ? new File([blob], 'monyk-girocode.png', { type: 'image/png' }) : null;
          const canShareFile = !!(file && navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch (e) { return false; } })());

          if (canShareFile) {
            btn.textContent = '📤 QR megosztása';
            btn.onclick = async () => {
              try {
                await navigator.share({
                  title: 'MONYK fizetés — GiroCode',
                  text: 'Szkenneld be a banki appoddal (GiroCode/EPC-QR).',
                  files: [file]
                });
              } catch (e) { /* felhasználó megszakította — nem hiba */ }
            };
          } else {
            // Fájl-megosztás nem támogatott (pl. desktop böngésző) —
            // helyette a QR-kép mentése kerül felajánlásra letöltésként,
            // amit utána a felhasználó a saját fájlkezelőjéből tud
            // megosztani/megnyitni a banki appban.
            btn.textContent = '💾 QR mentése képként';
            btn.onclick = () => downloadCanvasPng(canvas, 'monyk-girocode.png');
          }
          shareRowEl.appendChild(btn);
        }, 'image/png');
        return;
      }

      // ── PayPal / Revolut / Wise: ezek sima linkek, a link megosztása
      // helyes és elég — a fogadó fél appja (vagy böngésző) nyitja meg. ──
      if (navigator.share) {
        const btn = document.createElement('button');
        btn.textContent = '📤 Megosztás';
        btn.style.cssText = 'background:var(--accent,#1B1B23);color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;';
        btn.onclick = async () => {
          try {
            await navigator.share({ title: 'MONYK fizetés', url: content });
          } catch (e) { /* felhasználó megszakította — nem hiba */ }
        };
        shareRowEl.appendChild(btn);
      }
    }

    // ── Fülek kirakása — csak azok, amelyekhez van adat ──
    // Sorrend: Banki, PayPal, Revolut, Wise. Alapértelmezett aktív fül
    // prioritás: PayPal > Banki > Revolut > Wise (lásd todo 14. szakasz:
    // PayPal az elsődlegesen ajánlott opció, mert globálisan elérhető).
    const tabDefs = [];
    if (hasIban)    tabDefs.push({ label: '🏦 Banki QR', render: renderBank });
    if (hasPaypal)  tabDefs.push({ label: '💙 PayPal',   render: renderPaypal, preferred: true });
    if (hasRevolut) tabDefs.push({ label: '💜 Revolut',  render: renderRevolut });
    if (hasWise)    tabDefs.push({ label: '🟢 Wise',     render: renderWise });

    tabDefs.forEach(def => {
      const b = document.createElement('button');
      b.textContent = def.label;
      b.style.cssText = 'border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;';
      b.onclick = () => { setActive(b); def.render(); };
      def.btn = b;
      tabsEl.appendChild(b);
    });

    function setActive(activeBtn) {
      Array.from(tabsEl.children).forEach(c => c.style.opacity = c === activeBtn ? '1' : '.5');
    }

    const defaultDef = tabDefs.find(d => d.preferred) || tabDefs[0];
    setActive(defaultDef.btn);
    defaultDef.render();
  }

  global.MonykPaymentQr = {
    sanitizeSepaText,
    sanitizeIban,
    buildEpcQrString,
    buildPaypalMeLink,
    buildRevolutLink,
    buildWiseLink,
    showPaymentModal
  };
})(window);
