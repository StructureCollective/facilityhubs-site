/*
 * Tenant documents page -- TEMPORARY no-auth mode (see src/index.js
 * header). Which tenant to show comes from ?tenant_id=N in the URL.
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

  document.addEventListener('DOMContentLoaded', function () {
    const tenantId = new URLSearchParams(location.search).get('tenant_id');
    if (!tenantId) {
      $('loadingMsg').innerHTML = 'No tenant selected. <a href="../Dashboard/">Go to Dashboard</a> to pick one.';
      return;
    }

    fetch('/legacy/api/tenants/' + encodeURIComponent(tenantId))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('loadingMsg').textContent = 'Tenant not found.';
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
