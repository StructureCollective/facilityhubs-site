/*
 * Shared Google Sign-In gate for the GFS Facility Hub (/gfs/*).
 * Loaded on every protected page (Dashboard, VendorSync, OfficeSync) and
 * on the login page. Depends on auth-config.js being loaded first.
 *
 * How it works:
 *  - Sign-in happens once on /gfs/login/ via Google Identity Services.
 *  - On success we check the signed-in email against GFS_AUTH_CONFIG,
 *    then store the Google ID token in sessionStorage for this tab.
 *  - Every protected page calls GFSAuth.requireAuth() before rendering
 *    anything; if there's no valid, still-allowed session, it redirects
 *    back to the login page.
 *  - Each app's app.js calls GFSAuth.getAuthParam() and sends the ID
 *    token to the backend as a normal request parameter (NOT a header --
 *    Apps Script's doGet(e)/doPost(e) can't read custom HTTP headers, and
 *    a custom Authorization header would also trigger a CORS preflight
 *    that Apps Script Web Apps don't handle, breaking the request) on
 *    every request, so the backend can verify it too. IMPORTANT: a
 *    front-end gate alone only hides the page -- it does not protect the
 *    data, since apiUrl and apiToken in config.js are visible to anyone
 *    who views source. The Apps Script backend needs the matching
 *    verification step (see the snippet delivered alongside this file)
 *    before this is a real security boundary, not just a cosmetic one.
 */
(function (global) {
  const SESSION_KEY = 'gfs_auth';
  const LOGIN_PATH = '/gfs/login/';

  function decodeJwt(token) {
    try {
      const payload = token.split('.')[1];
      const json = decodeURIComponent(
        atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function isAllowed(claims) {
    if (!claims || !claims.email || claims.email_verified === false) return false;
    // GFS_AUTH_CONFIG is declared with `const` in auth-config.js, so it's a
    // global lexical binding, NOT a window property -- window.GFS_AUTH_CONFIG
    // is always undefined. Read the bare identifier instead.
    const cfg = (typeof GFS_AUTH_CONFIG !== 'undefined' ? GFS_AUTH_CONFIG : {}) || {};
    const email = claims.email.toLowerCase();
    const domain = email.split('@')[1] || '';
    const allowedDomain = (cfg.allowedDomain || '').toLowerCase();
    const allowedEmails = (cfg.allowedEmails || []).map(function (e) {
      return String(e).toLowerCase();
    });

    if (!allowedDomain && !allowedEmails.length) return false; // not configured -> fail closed
    if (allowedDomain && domain === allowedDomain) return true;
    if (allowedEmails.indexOf(email) !== -1) return true;
    return false;
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (!session || !session.idToken || !session.exp) return null;
      if (session.exp * 1000 <= Date.now()) return null;
      return session;
    } catch (e) {
      return null;
    }
  }

  function setSession(idToken, claims) {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ idToken: idToken, email: claims.email, exp: claims.exp })
    );
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function redirectToLogin() {
    const next = encodeURIComponent(location.pathname);
    location.replace(LOGIN_PATH + '?next=' + next);
  }

  // Call at the top of every protected page, before anything else renders.
  function requireAuth() {
    const session = getSession();
    if (!session) {
      redirectToLogin();
      return;
    }
    const claims = decodeJwt(session.idToken);
    if (!isAllowed(claims)) {
      clearSession();
      redirectToLogin();
      return;
    }
    const gate = document.getElementById('authCheck');
    if (gate) gate.hidden = true;
  }

  // Call from app.js before each API request to the Apps Script backend.
  // Returns a plain object to merge into the query string (GET) or JSON
  // body (POST) -- not a header, see the file header comment for why.
  function getAuthParam() {
    const session = getSession();
    return session ? { googleIdToken: session.idToken } : {};
  }

  function signOut() {
    clearSession();
    if (global.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
    redirectToLogin();
  }

  global.GFSAuth = {
    decodeJwt: decodeJwt,
    isAllowed: isAllowed,
    getSession: getSession,
    setSession: setSession,
    clearSession: clearSession,
    requireAuth: requireAuth,
    getAuthParam: getAuthParam,
    signOut: signOut,
  };
})(window);
