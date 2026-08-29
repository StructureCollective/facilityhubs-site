/*
 * Tenant documents page. Tenant identity comes from the signed-in session
 * (GET /legacy/api/tenants/me) rather than ?tenant_id=.
 *
 * There's no documents backend yet (no D1 table, no storage, no API
 * endpoint) -- this page just shows the tenant's name/unit in the
 * sidebar, same as the other tenant pages, and a static empty state.
 * Wire up a real documents list here once that backend exists.
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };

  function esc(v) {
    return String(v).replace(/[&<>'"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c];
    });
  }

  function fmtAddress(label) {
    if (!label) return '';
    var idx = label.indexOf(',');
    if (idx === -1) return esc(label);
    return esc(label.slice(0, idx).trim()) + '<br>' + esc(label.slice(idx + 1).trim());
  }

  function signOut(e) {
    if (e) e.preventDefault();
    fetch('/legacy/api/auth/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () { location.href = '/legacy/'; });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('signOutLink').addEventListener('click', signOut);

    fetch('/legacy/api/tenants/me')
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 401) {
          location.href = '/legacy/';
          return;
        }
        if (!res.ok) {
          $('loadingMsg').textContent = 'Could not load this page. Please reload.';
          return;
        }
        const t = res.data.tenant;
        $('greeting').textContent = 'Hi, ' + (t.fullName ? t.fullName.split(' ')[0] : 'there');
        $('unitLabel').innerHTML = fmtAddress(t.unitLabel);
        $('loadingMsg').hidden = true;
        $('app').hidden = false;
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load this page. Please reload.';
      });
  });
})();
