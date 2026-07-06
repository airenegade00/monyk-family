// ══════════════════════════════════════════════════════════
// MONYK SHARED — pairing.js
// Build-időben bemásolt közös modul (NEM futásidejű megosztás).
// Forrás: Monyk-family.html (createFamily/joinFamilyByCode/showFamilyPairingUI
// és a hozzá tartozó QR-scan flow), generikusra emelve.
// Lásd: MONYK_Shared_Pairing_todo.md, 1. szakasz.
//
// Használat (app-oldalon, pl. Monyk-family.html-ben):
//
//   MonykPairing.init({
//     db: db,
//     firebase: firebase,
//     getUid: () => currentUid,
//     getDeviceName: getDeviceName,
//     collectionName: 'families',        // vagy 'duos', 'travelGroups'
//     role: 'parent',                     // a members/{uid} dokumentum role mezője
//     multiMember: false,                 // true = N-tagú csoport (pl. Travel), false = 2 fél (Family/Duo)
//     codeCharset: '0123456789',          // opcionális, alapértelmezett a tisztán numerikus kód (Family/Pro).
//                                          // Alfanumerikus, összetéveszthető karakterek nélküli kódhoz (mint a
//                                          // Travelben) add meg pl.: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
//                                          // (0/O/1/I szándékosan kihagyva).
//     codeLength: 6,                      // opcionális, alapértelmezett 6
//     labels: {
//       mainTitle: 'Család összekapcsolása',
//       mainSubtitle: 'Hozz létre új családot, vagy csatlakozz egy másik szülő által már létrehozotthoz.',
//       createBtn: '+ Új család létrehozása',
//       joinBtn: 'Csatlakozás kóddal',
//       createTitle: 'Új család',
//       createSubtitle: 'Adj nevet a családodnak.',
//       namePlaceholder: 'pl. Kovács család',
//       createSubmitBtn: 'Létrehozás',
//       joinTitle: 'Csatlakozás',
//       joinSubtitle: 'Írd be a másik szülőtől kapott 6-jegyű kódot, vagy olvasd be a QR-kódját.',
//       joinSubmitBtn: 'Csatlakozás',
//       scanBtn: '📷 QR-kód beolvasása',
//       doneTitle: 'Kész!',
//       doneSubtitle: 'Oszd meg ezt a kódot / QR-t a másik szülővel, hogy ő is csatlakozhasson.',
//       doneFinishBtn: 'Tovább az apphoz',
//       backBtn: 'Vissza'
//     },
//     extraCreateStepHtml: '<div class="fp-kassza-lbl">...</div><button ...>...',  // opcionális, app-specifikus extra UI a create lépésbe (pl. Family kassza-választó)
//     getExtraCreateData: () => ({ sharedKasse: fpSharedKasseChoice }), // opcionális, extra mezők a group dokumentumba
//     onCreated: ({ groupId, groupName, inviteCode }) => { ... },
//     onJoined: ({ groupId, groupName, groupData }) => { ... } // groupData = a teljes csoport-dokumentum (pl. sharedKasse), nem csak a name
//     checkJoinRateLimit: async () => { await checkJoinRateLimitCallable(); } // opcionális, ld. monyk-shared/functions/index.js
//   });
//
//   // Megnyitás:
//   MonykPairing.show();
//
// Amit ez a modul NEM tartalmaz (app-specifikus, a hívó appban marad):
//   - a group dokumentum további mezőinek jelentése (pl. Family sharedKasse logika)
//   - localStorage-kulcs neve, amivel a groupId-t az app elmenti
//   - a group-hoz tartozó real-time listenerek (attachFamilyListeners stb.)
//   - a Kids gyerek-eszköz párosítás (az egy külön, szülő-gyerek pairing, nem ez a modul dolga)
// ══════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const DEFAULT_LABELS = {
    mainTitle: 'Csoport összekapcsolása',
    mainSubtitle: 'Hozz létre új csoportot, vagy csatlakozz egy meglévőhöz.',
    createBtn: '+ Új csoport létrehozása',
    joinBtn: 'Csatlakozás kóddal',
    createTitle: 'Új csoport',
    createSubtitle: 'Adj nevet a csoportodnak.',
    namePlaceholder: 'Csoport neve',
    createSubmitBtn: 'Létrehozás',
    joinTitle: 'Csatlakozás',
    joinSubtitle: 'Írd be a kapott 6-jegyű kódot, vagy olvasd be a QR-kódját.',
    joinSubmitBtn: 'Csatlakozás',
    scanBtn: '📷 QR-kód beolvasása',
    doneTitle: 'Kész!',
    doneSubtitle: 'Oszd meg ezt a kódot / QR-t, hogy más(ok) is csatlakozhassanak.',
    doneFinishBtn: 'Tovább az apphoz',
    backBtn: 'Vissza'
  };

  let cfg = null;
  let _qrScanStream = null;
  let _qrScanRAF = null;
  let _pendingInviteCode = null;

  function L(key) {
    return (cfg.labels && cfg.labels[key] != null) ? cfg.labels[key] : DEFAULT_LABELS[key];
  }

  function toastFallback(msg) {
    if (typeof global.toast === 'function') { global.toast(msg); return; }
    console.warn('[MonykPairing]', msg);
  }

  // ── Kód generálás (ütközés-ellenőrzéssel) ──────────────────
  // codeCharset: alapértelmezésben tisztán numerikus (Family/Pro jelenlegi
  // viselkedése, visszafelé kompatibilis). Az app opcionálisan átadhat egy
  // saját karakterkészletet init({codeCharset: '...'})-ben — pl. a Travel
  // app 0/O/1/I nélküli alfanumerikus kódot használ, hogy QR nélküli,
  // kézzel beírt kódnál ne legyen összetéveszthető karakter.
  const DEFAULT_CODE_CHARSET = '0123456789';
  async function generateUniqueInviteCode() {
    const charset = cfg.codeCharset || DEFAULT_CODE_CHARSET;
    const len = cfg.codeLength || 6;
    for (let attempt = 0; attempt < 5; attempt++) {
      let code = '';
      for (let i = 0; i < len; i++) code += charset[Math.floor(Math.random() * charset.length)];
      const existing = await cfg.db.collection('inviteCodes').doc(code).get();
      if (!existing.exists) return code;
    }
    throw new Error('Nem sikerült egyedi kódot generálni');
  }

  // ── Csoport létrehozása ─────────────────────────────────────
  async function createGroup(name, extraData) {
    const uid = cfg.getUid();
    if (!uid) throw new Error('Nincs bejelentkezve (uid hiányzik)');
    const inviteCode = await generateUniqueInviteCode();

    const groupRef = cfg.db.collection(cfg.collectionName).doc();
    const groupId = groupRef.id;

    await groupRef.set(Object.assign(
      {
        name: name,
        inviteCode: inviteCode,
        createdAt: cfg.firebase.firestore.FieldValue.serverTimestamp()
      },
      extraData || {}
    ));

    // A member doc ID = uid (ez kell a security rules exists() ellenőrzéshez)
    await groupRef.collection('members').doc(uid).set({
      deviceName: cfg.getDeviceName ? cfg.getDeviceName() : 'Eszköz',
      joinedAt: cfg.firebase.firestore.FieldValue.serverTimestamp(),
      role: cfg.role || 'member'
    });

    await cfg.db.collection('inviteCodes').doc(inviteCode).set({
      collectionName: cfg.collectionName,
      groupId: groupId,
      // v-security: 48 órás lejárat, ugyanaz a minta, mint a Family kidInviteCodes-nál —
      // a rules ez alapján utasítja el a lejárt kódos csatlakozást (lásd firestore.rules).
      expiresAt: Date.now() + 48 * 60 * 60 * 1000
    });

    return { groupId, groupName: name, inviteCode };
  }

  // ── Csatlakozás kód alapján ──────────────────────────────────
  async function joinGroupByCode(code) {
    const uid = cfg.getUid();
    if (!uid) throw new Error('Nincs bejelentkezve (uid hiányzik)');

    // v-security: opcionális rate-limit hook — ha a hívó app átadott egy
    // `checkJoinRateLimit` callable Cloud Function-referenciát init()-ben
    // (lásd monyk-shared/functions/index.js), azt hívjuk meg először. Ha nincs
    // átadva (pl. a Functions még nincs deployolva), a régi, hook nélküli
    // viselkedés marad — ez szándékosan visszafelé kompatibilis, nem blokkoló.
    if (typeof cfg.checkJoinRateLimit === 'function') {
      await cfg.checkJoinRateLimit(); // dob, ha túl sok próbálkozás volt (HttpsError 'resource-exhausted')
    }

    const codeDoc = await cfg.db.collection('inviteCodes').doc(code).get();
    if (!codeDoc.exists) throw new Error('Érvénytelen kód');

    const { groupId, collectionName, expiresAt } = codeDoc.data();
    // v-security: lejárat-ellenőrzés — a rules is elutasítja a lejárt kódos csatlakozást,
    // de itt a kliens is előre jelzi, hogy ne fusson bele feleslegesen egy sikertelen
    // Firestore-írásba (jobb hibaüzenet a felhasználónak).
    if (typeof expiresAt === 'number' && Date.now() > expiresAt) {
      throw new Error('A kód lejárt, kérj újat');
    }

    const targetCollection = collectionName || cfg.collectionName;
    const groupRef = cfg.db.collection(targetCollection).doc(groupId);

    // Előbb írjuk be magunkat tagnak (uid alapján ezt a security rules engedi),
    // csak utána olvassuk be a csoport adatait — mert az olvasáshoz már tagság kell.
    await groupRef.collection('members').doc(uid).set({
      deviceName: cfg.getDeviceName ? cfg.getDeviceName() : 'Eszköz',
      joinedAt: cfg.firebase.firestore.FieldValue.serverTimestamp(),
      role: cfg.role || 'member'
    });

    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) throw new Error('A csoport már nem létezik');

    const groupData = groupDoc.data();
    // groupData: a teljes csoport-dokumentum (pl. Family `sharedKasse` mezője),
    // hogy a hívó app onJoined callback-je hozzáférjen bármilyen extra mezőhöz,
    // ne csak a groupName-hez. A groupName mező visszafelé-kompatibilitás miatt maradt.
    return { groupId, groupName: groupData.name, groupData };
  }

  // ── QR + kód megjelenítés ────────────────────────────────────
  function showInviteCodeUI(containerId, code) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
      <div style="text-align:center;padding:20px;">
        <div id="mpQrBox" style="display:inline-block;padding:12px;background:#fff;border-radius:12px;"></div>
        <div style="font-size:13px;color:var(--muted);margin:14px 0 6px;">Megosztási kód</div>
        <div style="font-size:32px;font-weight:900;letter-spacing:4px;">${code}</div>
      </div>`;
    try {
      new QRCode(document.getElementById('mpQrBox'), {
        text: code,
        width: 180,
        height: 180,
        colorDark: '#1B1B23',
        colorLight: '#ffffff'
      });
    } catch (e) { console.warn('[MonykPairing] QR generálás hiba:', e); }
  }

  // ── Fő UI (create/join/done lépések) ─────────────────────────
  function show() {
    const containerId = cfg.containerId || 'monykPairing';
    if (document.getElementById(containerId)) return;
    const el = document.createElement('div');
    el.id = containerId;
    el.innerHTML = `
<style>
#${containerId} { position:fixed; inset:0; z-index:9500; background:var(--bg2); display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; font-family:var(--font-body); }
#${containerId} .mp-card { width:100%; max-width:360px; text-align:center; }
#${containerId} h2 { font-size:22px; font-weight:900; margin-bottom:8px; }
#${containerId} p { font-size:14px; color:var(--muted); margin-bottom:24px; }
#${containerId} button { width:100%; padding:16px; margin-bottom:12px; border:2px solid var(--border); border-radius:14px; background:var(--acc); color:#fff; font-weight:800; font-size:15px; font-family:inherit; cursor:pointer; }
#${containerId} button.secondary { background:transparent; color:var(--text); }
#${containerId} input { width:100%; padding:14px; margin-bottom:12px; border:2px solid var(--border); border-radius:12px; font-size:16px; text-align:center; letter-spacing:2px; font-family:inherit; }
#${containerId} .mp-err { color:var(--red); font-size:13px; margin-bottom:12px; min-height:16px; }
#${containerId} .mp-step { display:none; }
#${containerId} .mp-step.on { display:block; }
#${containerId} .mp-back { background:none; border:none; color:var(--muted); font-size:13px; margin-top:8px; }
</style>
<div class="mp-card">

  <div class="mp-step on" id="mpStepMain">
    <h2>${L('mainTitle')}</h2>
    <p>${L('mainSubtitle')}</p>
    <button onclick="MonykPairing._showStep('mpStepCreate')">${L('createBtn')}</button>
    <button class="secondary" onclick="MonykPairing._showStep('mpStepJoin')">${L('joinBtn')}</button>
  </div>

  <div class="mp-step" id="mpStepCreate">
    <h2>${L('createTitle')}</h2>
    <p>${L('createSubtitle')}</p>
    <input id="mpGroupName" placeholder="${L('namePlaceholder')}" maxlength="40">
    ${cfg.extraCreateStepHtml || ''}
    <div class="mp-err" id="mpCreateErr"></div>
    <button onclick="MonykPairing._doCreate()">${L('createSubmitBtn')}</button>
    <button class="mp-back" onclick="MonykPairing._showStep('mpStepMain')">${L('backBtn')}</button>
  </div>

  <div class="mp-step" id="mpStepJoin">
    <h2>${L('joinTitle')}</h2>
    <p>${L('joinSubtitle')}</p>
    <button type="button" class="secondary" id="mpScanBtn" onclick="MonykPairing._scanQr()" style="display:none;">${L('scanBtn')}</button>
    <input id="mpJoinCode" placeholder="${cfg.codeCharset && cfg.codeCharset !== DEFAULT_CODE_CHARSET ? 'ABC123' : '123456'}" maxlength="${cfg.codeLength || 6}" ${cfg.codeCharset && cfg.codeCharset !== DEFAULT_CODE_CHARSET ? 'style="text-transform:uppercase"' : 'inputmode="numeric"'}>
    <div class="mp-err" id="mpJoinErr"></div>
    <button onclick="MonykPairing._doJoin()">${L('joinSubmitBtn')}</button>
    <button class="mp-back" onclick="MonykPairing._showStep('mpStepMain')">${L('backBtn')}</button>
  </div>

  <div class="mp-step" id="mpStepDone">
    <h2>${L('doneTitle')}</h2>
    <p>${L('doneSubtitle')}</p>
    <div id="mpQrContainer"></div>
    <button onclick="MonykPairing._finish()">${L('doneFinishBtn')}</button>
  </div>

</div>`;
    document.body.appendChild(el);
    // A QR-beolvasó gomb akkor jelenik meg, ha a böngésző/PWA tudja használni a
    // kamerát (getUserMedia) — PWA-ban és Capacitor WebView-ban is működik, natív híd nélkül.
    const scanBtn = document.getElementById('mpScanBtn');
    if (scanBtn && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      scanBtn.style.display = '';
    }
  }

  function _showStep(stepId) {
    const containerId = cfg.containerId || 'monykPairing';
    document.querySelectorAll(`#${containerId} .mp-step`).forEach(s => s.classList.remove('on'));
    document.getElementById(stepId).classList.add('on');
  }

  async function _doCreate() {
    const nameInput = document.getElementById('mpGroupName');
    const errEl = document.getElementById('mpCreateErr');
    const name = nameInput.value.trim();
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Adj meg egy nevet.'; return; }
    try {
      const extraData = cfg.getExtraCreateData ? cfg.getExtraCreateData() : {};
      const { groupId, groupName, inviteCode } = await createGroup(name, extraData);
      _pendingInviteCode = inviteCode;
      _showStep('mpStepDone');
      showInviteCodeUI('mpQrContainer', inviteCode);
      if (typeof cfg.onCreated === 'function') cfg.onCreated({ groupId, groupName, inviteCode });
    } catch (e) {
      console.error('[MonykPairing] createGroup hiba:', e);
      errEl.textContent = 'Hiba: ' + (e.code || '') + ' ' + (e.message || e);
    }
  }

  // ── QR-BEOLVASÁS (böngésző/PWA-kamera, jsQR) ──────────────────
  function _scanQr() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      toastFallback('⚠️ A kamera nem érhető el ezen az eszközön/böngészőben');
      return;
    }
    _openQrScanOverlay();
  }

  function _openQrScanOverlay() {
    if (document.getElementById('mpQrScanOverlay')) return;
    const el = document.createElement('div');
    el.id = 'mpQrScanOverlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9700;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;';
    el.innerHTML = `
      <video id="mpQrScanVideo" playsinline autoplay muted style="width:100%;max-width:420px;border-radius:16px;"></video>
      <div id="mpQrScanErr" style="color:#fff;font-size:13px;margin-top:14px;min-height:16px;text-align:center;padding:0 24px;"></div>
      <button type="button" onclick="MonykPairing._closeQrScanOverlay()" style="margin-top:18px;padding:14px 28px;border:2px solid rgba(255,255,255,.4);border-radius:14px;background:transparent;color:#fff;font-weight:800;font-size:14px;font-family:inherit;cursor:pointer;">Mégse</button>
    `;
    document.body.appendChild(el);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        _qrScanStream = stream;
        const video = document.getElementById('mpQrScanVideo');
        if (!video) { _stopQrStream(); return; }
        video.srcObject = stream;
        video.setAttribute('playsinline', true);
        video.play();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const tick = () => {
          if (!document.getElementById('mpQrScanOverlay')) return; // overlay bezárva
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result = typeof jsQR === 'function' ? jsQR(imageData.data, imageData.width, imageData.height) : null;
            if (result && result.data) {
              _closeQrScanOverlay();
              _onQrScanResult(result.data);
              return;
            }
          }
          _qrScanRAF = requestAnimationFrame(tick);
        };
        _qrScanRAF = requestAnimationFrame(tick);
      })
      .catch(err => {
        console.error('[MonykPairing] getUserMedia hiba:', err);
        const errEl = document.getElementById('mpQrScanErr');
        if (errEl) errEl.textContent = 'Nem sikerült elérni a kamerát (engedély hiányzik?)';
      });
  }

  function _stopQrStream() {
    if (_qrScanRAF) { cancelAnimationFrame(_qrScanRAF); _qrScanRAF = null; }
    if (_qrScanStream) { _qrScanStream.getTracks().forEach(t => t.stop()); _qrScanStream = null; }
  }

  function _closeQrScanOverlay() {
    _stopQrStream();
    const el = document.getElementById('mpQrScanOverlay');
    if (el) el.remove();
  }

  // A dekódolt QR-tartalmat ez dolgozza fel (a meghívó-kód QR-je a konfigurált
  // hosszúságú/karakterkészletű kód — a biztonság kedvéért kiszűrjük belőle az
  // első illeszkedő szeletet, ha esetleg más szöveg is kerülne bele, pl. egy
  // teljes csatlakozási URL query-paraméterként hordozza a kódot).
  function _onQrScanResult(text) {
    const codeInput = document.getElementById('mpJoinCode');
    const errEl = document.getElementById('mpJoinErr');
    if (!codeInput) return; // nem a csatlakozás képernyőn vagyunk épp
    const len = cfg.codeLength || 6;
    const charset = cfg.codeCharset || DEFAULT_CODE_CHARSET;
    const isNumeric = _isNumericCharset();
    const escaped = charset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`[${escaped}]{${len}}`, isNumeric ? '' : 'i');
    const raw = _normalizeCodeInput(String(text || ''));
    const match = raw.match(re);
    if (!match) {
      if (errEl) errEl.textContent = 'A beolvasott kód nem érvényes.';
      return;
    }
    codeInput.value = match[0];
    if (errEl) errEl.textContent = '';
    _doJoin();
  }

  function _isNumericCharset() {
    return (cfg.codeCharset || DEFAULT_CODE_CHARSET) === DEFAULT_CODE_CHARSET;
  }
  function _normalizeCodeInput(raw) {
    const s = (raw || '').trim();
    return _isNumericCharset() ? s : s.toUpperCase();
  }
  function _isValidCode(code) {
    const len = cfg.codeLength || 6;
    const charset = cfg.codeCharset || DEFAULT_CODE_CHARSET;
    if (code.length !== len) return false;
    for (const ch of code) if (charset.indexOf(ch) === -1) return false;
    return true;
  }

  async function _doJoin() {
    const codeInput = document.getElementById('mpJoinCode');
    const errEl = document.getElementById('mpJoinErr');
    const code = _normalizeCodeInput(codeInput.value);
    errEl.textContent = '';
    if (!_isValidCode(code)) { errEl.textContent = `A kód ${cfg.codeLength || 6} karakterből áll.`; return; }
    try {
      const { groupId, groupName, groupData } = await joinGroupByCode(code);
      if (typeof cfg.onJoined === 'function') cfg.onJoined({ groupId, groupName, groupData });
      _finish();
    } catch (e) {
      console.error('[MonykPairing] joinGroupByCode hiba:', e);
      errEl.textContent = 'Hiba: ' + (e.code || '') + ' ' + (e.message || e);
    }
  }

  function _finish() {
    const containerId = cfg.containerId || 'monykPairing';
    const el = document.getElementById(containerId);
    if (el) el.remove();
    if (typeof cfg.onFinish === 'function') cfg.onFinish();
  }

  function init(options) {
    if (!options || !options.db || !options.firebase || typeof options.getUid !== 'function') {
      throw new Error('[MonykPairing] init() hiányzó kötelező paraméter(ek): db, firebase, getUid');
    }
    cfg = Object.assign({
      collectionName: 'families',
      role: 'member',
      multiMember: false,
      containerId: 'monykPairing'
    }, options);
  }

  global.MonykPairing = {
    init,
    show,
    // belső, a beszúrt onclick-attribútumok által hívott metódusok:
    _showStep: _showStep,
    _doCreate: _doCreate,
    _scanQr: _scanQr,
    _closeQrScanOverlay: _closeQrScanOverlay,
    _doJoin: _doJoin,
    _finish: _finish,
    // app-oldalon is hasznos lehet közvetlenül (pl. teszthez, vagy egy
    // meglévő csoporthoz utólag friss kód generálásához — ld. Family app
    // "Új meghívókód generálása" funkciója):
    generateUniqueInviteCode,
    createGroup,
    joinGroupByCode,
    showInviteCodeUI
  };

})(window);
