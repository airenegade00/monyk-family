// ═══════════════════════════════════════════════════════════════
// monyk-shared/pin.js — közös PIN + biometrikus zár modul
//
// A fő MONYK app és a MONYK Family PIN/biometria kódjából kiemelve
// (2026-07-05), ugyanazzal az elvvel, mint a monyk-shared/pairing.js:
// build-időben másolt közös fájl, NEM futásidejű megosztás.
//
// A két forrás (index.html, Monyk-family.html) szinte szó szerint
// azonos volt — ez a modul csak annyit paraméterez, ami ténylegesen
// eltért: localStorage-kulcsok, elem-ID prefix, saltn, toast-hívás,
// feliratok (i18n vagy hardcode-olt fallback), és egy opcionális
// extra render-hook (pl. onboarding UI frissítése).
//
// HASZNÁLAT (hívó app, pl. Monyk-family.html):
//
//   MonykPin.init({
//     idPrefix: 'fam',                       // '' a fő appban, 'fam' a Familyben
//     storageKey: 'familia_security',        // localStorage kulcs a beállításokhoz
//     bioCredKey: 'monyk_family_bio_cred',   // localStorage kulcs a WebAuthn fallback cred-hez
//     saltSuffix: 'monyk_family_salt',       // PIN hasheléshez hozzáfűzött salt
//     pinLength: 4,                          // opcionális, alapértelmezés 4
//     appName: 'MONYK Family',               // biometria promptok címéhez
//     showToast: (msg) => toast(msg),        // a hívó app toast-függvénye
//     t: (key) => t(key),                    // opcionális fordító; ha nincs, defaultLabels-ből jön
//     labels: { ... },                       // opcionális felirat-felülírás (ha nincs t())
//     onUnlock: () => { ... },               // opcionális, feloldás után (pl. afterUnlock)
//     onSecurityRendered: () => { ... }       // opcionális extra hook (pl. onboarding UI szinkron)
//   });
//
//   MonykPin.startupFlow();       // induláskor hívandó, miután a beállítások betöltődtek localStorage-ból
//   MonykPin.renderSecuritySettings();  // Beállítások képernyő megnyitásakor/nyelvváltáskor
//   MonykPin.handlePinButtonClick();    // "PIN be/kikapcsolása" gomb onclick
//   MonykPin.handleBioButtonClick();    // "Biometria be/kikapcsolása" gomb onclick
//
// A HÍVÓ APP FELELŐSSÉGE (nem kerül a modulba):
//   - secSettings betöltése/mentése localStorage-ból (app-specifikus kulcs alatt) —
//     a modul a cfg.getSettings()/cfg.saveSettings()-en keresztül éri el, hogy
//     a hívó app teljes kontrollal maradjon a saját state-je felett.
//   - a PIN-overlay és a Beállítások képernyő HTML/CSS-je marad a hívó appban
//     (a modul csak a meglévő elem-ID-kat manipulálja, nem generál új DOM-ot,
//     ellentétben a pairing.js-szel, mert itt app-specifikus vizuális helyeken
//     (Beállítások, onboarding) illeszkedik bele a UI, nem egy önálló overlay-be).
// ═══════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const defaultLabels = {
    pinTitleLock: 'MONYK zárolva',
    pinSubLock: 'Add meg a PIN kódot a feloldáshoz',
    pinTitleSetup1: 'Új PIN beállítása',
    pinSubSetup1: (len) => `Adj meg egy ${len} jegyű PIN kódot`,
    pinTitleSetup2: 'PIN megerősítése',
    pinSubSetup2: 'Add meg még egyszer az új PIN kódot',
    pinTitleDisable: 'PIN kikapcsolása',
    pinSubDisable: 'A kikapcsoláshoz add meg a jelenlegi PIN kódot',
    pinCancelBtn: 'Mégse',
    pinErrNoMatch: 'A két PIN nem egyezik — kezdd újra.',
    pinErrWrong: 'Helytelen PIN kód.',
    pinSetOkToast: '🔒 PIN kód beállítva',
    pinOffOkToast: '🔓 PIN kód kikapcsolva',
    secStatusOn: 'Bekapcsolva',
    secStatusOff: 'Kikapcsolva',
    secStatusUnavail: 'Nem elérhető',
    soPinOnBtn: 'PIN bekapcsolása',
    soPinOffBtn: 'PIN kikapcsolása',
    soBioOnBtn: 'Biometria bekapcsolása',
    soBioOffBtn: 'Biometria kikapcsolása',
    bioUnavailToast: '⚠️ Biometria nem elérhető ezen az eszközön',
    bioRegFailToast: '❌ Biometria engedélyezése sikertelen',
    bioAuthFailErr: '⚠️ Biometrikus azonosítás sikertelen'
  };

  let cfg = {};
  let secSettings = { pinEnabled: false, pinHash: '', biometricEnabled: false };
  let pinMode = null;      // 'unlock' | 'setup1' | 'setup2' | 'disable'
  let pinBuffer = '';
  let pinFirstEntry = '';

  function id(base) {
    if (!cfg.idPrefix) return base;
    return cfg.idPrefix + base[0].toUpperCase() + base.slice(1);
  }
  function el(base) { return document.getElementById(id(base)); }

  function label(key, ...args) {
    if (typeof cfg.t === 'function') {
      const v = cfg.t(key);
      if (v && v !== key) return v;
    }
    if (cfg.labels && cfg.labels[key] !== undefined) {
      const v = cfg.labels[key];
      return typeof v === 'function' ? v(...args) : v;
    }
    const dv = defaultLabels[key];
    return typeof dv === 'function' ? dv(...args) : dv;
  }

  function toast(msg) {
    if (typeof cfg.showToast === 'function') cfg.showToast(msg);
  }

  function saveSettings() {
    try { localStorage.setItem(cfg.storageKey, JSON.stringify(secSettings)); }
    catch (e) { console.warn('[MonykPin]', e); }
  }
  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(cfg.storageKey) || 'null');
      if (parsed) secSettings = parsed;
    } catch (e) { console.warn('[MonykPin]', e); }
  }

  async function hashPin(pin) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin + cfg.saltSuffix));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function isBiometricSupported() {
    if (global.AndroidBridge && typeof global.AndroidBridge.isBiometricAvailable === 'function') {
      try { return !!global.AndroidBridge.isBiometricAvailable(); }
      catch (e) { console.warn('[MonykPin]', e); return false; }
    }
    return !!(global.isSecureContext && global.PublicKeyCredential && navigator.credentials);
  }

  async function registerBiometric() {
    if (!isBiometricSupported()) { toast(label('bioUnavailToast')); return false; }
    if (global.AndroidBridge && typeof global.AndroidBridge.showBiometricPrompt === 'function') {
      return new Promise(resolve => {
        const cbName = '_monykPinBioRegCallback_' + (cfg.idPrefix || 'main');
        global[cbName] = function (success) {
          delete global[cbName];
          if (success) { secSettings.biometricEnabled = true; saveSettings(); }
          resolve(!!success);
        };
        try {
          global.AndroidBridge.showBiometricPrompt(
            `${cfg.appName} – Biometria engedélyezése`,
            'Azonosítsd magad az aktiváláshoz',
            cbName
          );
        } catch (e) { delete global[cbName]; console.warn('[MonykPin]', e); resolve(false); }
      });
    }
    // Web fallback: WebAuthn credential regisztráció.
    try {
      const challenge = new Uint8Array(32); crypto.getRandomValues(challenge);
      const userId = new Uint8Array(16); crypto.getRandomValues(userId);
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: cfg.appName, id: location.hostname || 'localhost' },
          user: { id: userId, name: 'monyk-user', displayName: cfg.appName },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'preferred' },
          timeout: 60000
        }
      });
      if (credential) {
        const b64 = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
        try { localStorage.setItem(cfg.bioCredKey, b64); } catch (e) { console.warn('[MonykPin]', e); }
        secSettings.biometricEnabled = true; saveSettings();
        return true;
      }
    } catch (e) { console.warn('[MonykPin]', e); toast(label('bioRegFailToast')); }
    return false;
  }

  function disableBiometric() {
    secSettings.biometricEnabled = false;
    saveSettings();
    try { localStorage.removeItem(cfg.bioCredKey); } catch (e) { console.warn('[MonykPin]', e); }
  }

  async function tryBiometric() {
    if (!isBiometricSupported()) return;
    if (global.AndroidBridge && typeof global.AndroidBridge.showBiometricPrompt === 'function') {
      const cbName = '_monykPinBioCallback_' + (cfg.idPrefix || 'main');
      global[cbName] = function (success, error) {
        delete global[cbName];
        if (success) {
          closePinOverlay();
          if (typeof cfg.onUnlock === 'function') cfg.onUnlock();
        } else if (error) {
          const userCanceled = ['User canceled', 'Cancel', 'Mégse'].some(s => String(error).includes(s));
          if (!userCanceled) { const e2 = el('pinError'); if (e2) e2.textContent = label('bioAuthFailErr'); }
        }
      };
      try { global.AndroidBridge.showBiometricPrompt(cfg.appName, 'Azonosítsd magad a belépéshez', cbName); }
      catch (e) { delete global[cbName]; console.warn('[MonykPin]', e); }
      return;
    }
    // Web fallback: WebAuthn.
    let credId = null;
    try { credId = localStorage.getItem(cfg.bioCredKey); } catch (e) { console.warn('[MonykPin]', e); }
    if (!credId) return;
    try {
      const challenge = new Uint8Array(32); crypto.getRandomValues(challenge);
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge, timeout: 60000,
          allowCredentials: [{ id: Uint8Array.from(atob(credId), c => c.charCodeAt(0)), type: 'public-key' }],
          userVerification: 'preferred'
        }
      });
      if (assertion) { closePinOverlay(); if (typeof cfg.onUnlock === 'function') cfg.onUnlock(); }
    } catch (e) { console.warn('[MonykPin]', e); }
  }

  // ── PIN overlay (zárolás / beállítás / kikapcsolás) ──
  function openPinOverlay(mode) {
    pinMode = mode;
    pinBuffer = '';
    const overlay = el('pinOverlay');
    if (overlay) overlay.classList.add('show');
    updatePinUI();
  }
  function closePinOverlay() {
    const overlay = el('pinOverlay');
    if (overlay) overlay.classList.remove('show');
    pinMode = null;
    pinBuffer = '';
  }
  function cancelPinOverlay() { closePinOverlay(); }

  function updatePinUI() {
    const titleEl = el('pinTitle');
    const subEl = el('pinSub');
    const errEl = el('pinError');
    if (errEl) errEl.textContent = '';
    const len = cfg.pinLength || 4;
    if (pinMode === 'unlock') { if (titleEl) titleEl.textContent = label('pinTitleLock'); if (subEl) subEl.textContent = label('pinSubLock'); }
    else if (pinMode === 'setup1') { if (titleEl) titleEl.textContent = label('pinTitleSetup1'); if (subEl) subEl.textContent = label('pinSubSetup1', len); }
    else if (pinMode === 'setup2') { if (titleEl) titleEl.textContent = label('pinTitleSetup2'); if (subEl) subEl.textContent = label('pinSubSetup2'); }
    else if (pinMode === 'disable') { if (titleEl) titleEl.textContent = label('pinTitleDisable'); if (subEl) subEl.textContent = label('pinSubDisable'); }
    const cancelBtn = el('pinCancelBtn');
    if (cancelBtn) {
      cancelBtn.textContent = label('pinCancelBtn');
      cancelBtn.style.display = (pinMode === 'unlock') ? 'none' : '';
    }
    const bioBtn = el('pinBioBtn');
    if (bioBtn) bioBtn.style.visibility = (pinMode === 'unlock' && secSettings.biometricEnabled && isBiometricSupported()) ? 'visible' : 'hidden';
    renderPinDots();
  }

  function dotClass() {
    if (cfg.dotClass) return cfg.dotClass;
    return cfg.idPrefix ? cfg.idPrefix.toLowerCase() + '-pin-dot' : 'pin-dot';
  }

  function renderPinDots() {
    const dotsEl = el('pinDots');
    if (!dotsEl) return;
    const len = cfg.pinLength || 4;
    const cls = dotClass();
    let html = '';
    for (let i = 0; i < len; i++) html += '<span class="' + cls + (i < pinBuffer.length ? ' filled' : '') + '"></span>';
    dotsEl.innerHTML = html;
  }

  function pinDigit(d) {
    const len = cfg.pinLength || 4;
    if (pinBuffer.length >= len) return;
    pinBuffer += d;
    renderPinDots();
    if (pinBuffer.length === len) setTimeout(handlePinComplete, 130);
  }
  function pinBackspace() {
    pinBuffer = pinBuffer.slice(0, -1);
    renderPinDots();
  }

  async function handlePinComplete() {
    const hash = await hashPin(pinBuffer);
    const errEl = el('pinError');

    if (pinMode === 'setup1') {
      pinFirstEntry = pinBuffer;
      pinBuffer = '';
      pinMode = 'setup2';
      updatePinUI();
      return;
    }

    if (pinMode === 'setup2') {
      if (pinBuffer !== pinFirstEntry) {
        if (errEl) errEl.textContent = label('pinErrNoMatch');
        pinBuffer = ''; pinFirstEntry = ''; pinMode = 'setup1';
        renderPinDots();
        return;
      }
      secSettings.pinHash = hash;
      secSettings.pinEnabled = true;
      saveSettings();
      closePinOverlay();
      renderSecuritySettings();
      toast(label('pinSetOkToast'));
      return;
    }

    if (pinMode === 'unlock') {
      if (hash === secSettings.pinHash) {
        pinBuffer = '';
        closePinOverlay();
        if (typeof cfg.onUnlock === 'function') cfg.onUnlock();
      } else {
        if (errEl) errEl.textContent = label('pinErrWrong');
        pinBuffer = '';
        renderPinDots();
        const wrap = el('pinWrap');
        if (wrap) { wrap.classList.add('shake'); setTimeout(() => wrap.classList.remove('shake'), 400); }
      }
      return;
    }

    if (pinMode === 'disable') {
      if (hash === secSettings.pinHash) {
        secSettings.pinEnabled = false;
        secSettings.pinHash = '';
        disableBiometric();
        closePinOverlay();
        renderSecuritySettings();
        toast(label('pinOffOkToast'));
      } else {
        if (errEl) errEl.textContent = label('pinErrWrong');
        pinBuffer = '';
        renderPinDots();
      }
      return;
    }
  }

  // ── Beállítások képernyő: Biztonság szekció ──
  function renderSecuritySettings() {
    const pinStatusEl = el('secPinStatus');
    const pinBtnEl = el('secPinBtn');
    const bioRowEl = el('secBioRow');
    const bioStatusEl = el('secBioStatus');
    const bioBtnEl = el('secBioBtn');
    if (!pinStatusEl || !pinBtnEl || !bioRowEl || !bioStatusEl || !bioBtnEl) return;

    pinStatusEl.textContent = secSettings.pinEnabled ? label('secStatusOn') : label('secStatusOff');
    pinStatusEl.classList.toggle('on', secSettings.pinEnabled);
    pinStatusEl.classList.toggle('off', !secSettings.pinEnabled);
    pinBtnEl.textContent = secSettings.pinEnabled ? label('soPinOffBtn') : label('soPinOnBtn');

    const bioAvailable = isBiometricSupported();
    bioRowEl.style.display = secSettings.pinEnabled ? '' : 'none';
    bioBtnEl.style.display = secSettings.pinEnabled ? '' : 'none';
    if (secSettings.pinEnabled) {
      bioStatusEl.textContent = !bioAvailable ? label('secStatusUnavail') : (secSettings.biometricEnabled ? label('secStatusOn') : label('secStatusOff'));
      bioStatusEl.classList.toggle('on', bioAvailable && secSettings.biometricEnabled);
      bioStatusEl.classList.toggle('off', !(bioAvailable && secSettings.biometricEnabled));
      bioBtnEl.textContent = secSettings.biometricEnabled ? label('soBioOffBtn') : label('soBioOnBtn');
      bioBtnEl.style.display = bioAvailable ? '' : 'none';
    }
    if (typeof cfg.onSecurityRendered === 'function') cfg.onSecurityRendered();
  }

  function handlePinButtonClick() {
    if (secSettings.pinEnabled) openPinOverlay('disable');
    else openPinOverlay('setup1');
  }
  async function handleBioButtonClick() {
    if (secSettings.biometricEnabled) {
      disableBiometric();
      renderSecuritySettings();
    } else {
      const ok = await registerBiometric();
      renderSecuritySettings();
      if (ok) toast(label('bioOnToast') || '👆 Biometria bekapcsolva');
    }
  }

  // ── indítási folyamat: PIN zár, mielőtt bármi más látszódna ──
  function startupFlow() {
    if (secSettings.pinEnabled && secSettings.pinHash) {
      openPinOverlay('unlock');
      if (secSettings.biometricEnabled && isBiometricSupported()) {
        setTimeout(tryBiometric, 400);
      }
    }
  }

  function init(options) {
    cfg = Object.assign({ pinLength: 4, appName: 'MONYK' }, options || {});
    loadSettings();
  }

  global.MonykPin = {
    init,
    startupFlow,
    renderSecuritySettings,
    handlePinButtonClick,
    handleBioButtonClick,
    openPinOverlay,
    closePinOverlay,
    cancelPinOverlay,
    pinDigit,
    pinBackspace,
    tryBiometric,
    isBiometricSupported,
    getSettings: () => secSettings
  };
})(window);
