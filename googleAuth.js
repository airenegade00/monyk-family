// monyk-shared/googleAuth.js
// ═══════════════════════════════════════════════════════════════
// Opcionális Google-fiók összekapcsolás a meglévő Firebase Anonymous Auth
// fiókhoz. Lásd: GOOGLE_SIGNIN_PLAN.md (a projekt gyökerében) a teljes
// tervért és indoklásért. Rövid összefoglaló:
//
//   - Az Anonymous Auth marad az alapértelmezett mindenhol, ez a modul
//     csak egy KIEGÉSZÍTŐ, opcionális réteg.
//   - linkCurrentAccount(): a meglévő anonim fiókhoz köti a Google-fiókot
//     (linkWithRedirect) — a `uid` és minden hozzá tartozó adat megmarad.
//   - signInExisting(): ha valaki egy vadonatúj telepítésen egyből a
//     korábban linkelt Google-fiókjával akar visszatérni (nem az aktuális
//     anonim fiókhoz linkel, hanem bejelentkezik azzal, amit már korábban
//     valahol linkelt).
//   - PWA-fókusz: mindenhol *Redirect* flow, NEM popup — iOS Safari
//     "Add to Home Screen" (standalone) módban a popup megbízhatatlan.
//
// Használat (app-oldali bekötés mintája, ld. Monyk-family.html):
//
//   MonykGoogleAuth.init({
//     firebase: firebase,
//     fbAuth: fbAuth,
//     showToast: showToast,        // opcionális, app-specifikus toast fv.
//     t: t,                        // opcionális, i18n fordító fv.
//     onLinked: (profile) => {...},      // sikeres linkCurrentAccount() után (redirect visszatéréskor)
//     onSignedIn: (profile) => {...},    // sikeres signInExisting() után (redirect visszatéréskor)
//     onLinkError: (error, friendlyMsg) => {...}
//   });
//
//   // Beállítások gombhoz:
//   MonykGoogleAuth.linkCurrentAccount();
//   MonykGoogleAuth.signInExisting();
//   MonykGoogleAuth.unlink();
//   MonykGoogleAuth.getLinkedProfile();  // { uid, displayName, photoUrl, email } | null
//
// FONTOS: az init() hívásnak MINDEN oldalbetöltéskor le kell futnia (nem
// csak akkor, ha valaki épp a Beállításokban van), mert a redirect-flow
// visszatérése az app gyökér-URL-jére történik, és csak ott lehet elkapni
// a getRedirectResult()-tal.

(function (global) {
  'use strict';

  let cfg = null;

  function L(key, fallback) {
    if (cfg && typeof cfg.t === 'function') {
      const v = cfg.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  function toast(msg) {
    if (cfg && typeof cfg.showToast === 'function') cfg.showToast(msg);
    else console.log('[MonykGoogleAuth]', msg);
  }

  // A Google-adatok (név, fotó, email) a `providerData` tömbben vannak a
  // legmegbízhatóbban linkelés után is — a `user` gyökér-mezői esetenként
  // üresek maradnak az eredeti anonim fiókról.
  function extractProfile(user) {
    if (!user) return null;
    const gp = (user.providerData || []).find(function (p) { return p.providerId === 'google.com'; });
    const src = gp || user;
    return {
      uid: user.uid,
      displayName: src.displayName || null,
      photoUrl: src.photoURL || null,
      email: src.email || null
    };
  }

  function friendlyError(error) {
    if (!error || !error.code) {
      return L('googleAuthGenericError', 'Ismeretlen hiba történt a Google-bejelentkezés közben.');
    }
    switch (error.code) {
      case 'auth/credential-already-in-use':
        return L('googleAuthAlreadyLinked', 'Ez a Google-fiók már más MONYK-fiókhoz van társítva ebben az appban.');
      case 'auth/email-already-in-use':
        return L('googleAuthEmailInUse', 'Ez az email-cím már használatban van egy másik fiókhoz.');
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request':
        return L('googleAuthCancelled', 'Megszakítva.');
      case 'auth/network-request-failed':
        return L('googleAuthNetworkError', 'Hálózati hiba, próbáld újra.');
      case 'auth/user-token-expired':
      case 'auth/requires-recent-login':
        return L('googleAuthReauth', 'Ehhez újra be kell jelentkezned, próbáld meg még egyszer.');
      default:
        return L('googleAuthGenericError', 'Hiba történt: ') + error.message;
    }
  }

  // Saját jelző arra, hogy egy folyamatban lévő redirect linkelés volt-e
  // vagy sima bejelentkezés — a getRedirectResult() ezt önmagában nem
  // különbözteti meg minden böngészőben egyértelműen.
  var FLOW_KEY = 'monyk_google_auth_flow'; // 'link' | 'signin'

  function _handleRedirectResult() {
    return cfg.fbAuth.getRedirectResult().then(function (result) {
      var flow = sessionStorage.getItem(FLOW_KEY);
      sessionStorage.removeItem(FLOW_KEY);
      if (!result || !result.user) return; // nem volt függőben lévő redirect

      var profile = extractProfile(result.user);
      if (flow === 'link') {
        if (cfg.onLinked) cfg.onLinked(profile);
      } else {
        // 'signin', vagy ha a sessionStorage-jelző elveszett (pl. böngésző-
        // váltás közben) — mindkét esetben biztonságos "bejelentkezve"
        // eseményként kezelni.
        if (cfg.onSignedIn) cfg.onSignedIn(profile);
      }
    }).catch(function (e) {
      var flow = sessionStorage.getItem(FLOW_KEY);
      sessionStorage.removeItem(FLOW_KEY);
      if (flow && cfg.onLinkError) cfg.onLinkError(e, friendlyError(e));
    });
  }

  function init(options) {
    cfg = Object.assign({}, options);
    if (!cfg.firebase || !cfg.fbAuth) {
      throw new Error('MonykGoogleAuth.init: a "firebase" és "fbAuth" opciók kötelezők');
    }
    // Minden induláskor lefut — ha épp nincs függőben redirect-eredmény,
    // gyorsan, hatás nélkül visszatér.
    _handleRedirectResult();
  }

  function _googleProvider() {
    var provider = new cfg.firebase.auth.GoogleAuthProvider();
    // Mindig kérjen fiókválasztót, ne ugorjon automatikusan az utoljára
    // használt Google-fiókra — hasznos, ha valaki családi/közös eszközön
    // több Google-fiók közül választ.
    provider.setCustomParameters({ prompt: 'select_account' });
    return provider;
  }

  function linkCurrentAccount() {
    var user = cfg.fbAuth.currentUser;
    if (!user) {
      toast(L('googleAuthNoUser', 'Nincs aktív munkamenet, próbáld újraindítani az appot.'));
      return Promise.resolve();
    }
    sessionStorage.setItem(FLOW_KEY, 'link');
    return user.linkWithRedirect(_googleProvider()).catch(function (e) {
      sessionStorage.removeItem(FLOW_KEY);
      var msg = friendlyError(e);
      if (cfg.onLinkError) cfg.onLinkError(e, msg); else toast(msg);
    });
    // Innentől az oldal átirányul a Google-hoz, a folytatás a
    // _handleRedirectResult()-ban történik a visszatéréskor (a következő
    // init()-hívásnál, ami az app induláskor mindig lefut).
  }

  function signInExisting() {
    sessionStorage.setItem(FLOW_KEY, 'signin');
    return cfg.fbAuth.signInWithRedirect(_googleProvider()).catch(function (e) {
      sessionStorage.removeItem(FLOW_KEY);
      var msg = friendlyError(e);
      if (cfg.onLinkError) cfg.onLinkError(e, msg); else toast(msg);
    });
  }

  function unlink() {
    var user = cfg.fbAuth.currentUser;
    if (!user) return Promise.resolve(false);
    return user.unlink('google.com').then(function () {
      toast(L('googleAuthUnlinked', 'Google-fiók leválasztva.'));
      return true;
    }).catch(function (e) {
      toast(friendlyError(e));
      return false;
    });
  }

  function getLinkedProfile() {
    var user = cfg.fbAuth.currentUser;
    if (!user) return null;
    var hasGoogle = (user.providerData || []).some(function (p) { return p.providerId === 'google.com'; });
    if (!hasGoogle) return null;
    return extractProfile(user);
  }

  global.MonykGoogleAuth = {
    init: init,
    linkCurrentAccount: linkCurrentAccount,
    signInExisting: signInExisting,
    unlink: unlink,
    getLinkedProfile: getLinkedProfile
  };

})(window);
