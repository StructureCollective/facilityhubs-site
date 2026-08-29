/*
 * Admin view -- TEMPORARY no-auth mode (see src/index.js header). Loads
 * the full tenant list directly; there is no admin check right now, so
 * this page (and its API endpoints) are reachable by anyone with the
 * link until Google Sign-In is restored.
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };

  function money(cents) {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso + (iso.length <= 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  }

  function esc(v) {
    return String(v).replace(/[&<>'"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c];
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('backLink').addEventListener('click', showList);
    loadTenants();
  });

  function loadTenants() {
    fetch('/legacy/api/tenants')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderTenants(data.tenants || []); })
      .catch(function () {
        $('apiNotice').textContent = 'Could not load tenants.';
        $('apiNotice').hidden = false;
      });
  }

  function renderTenants(tenants) {
    if (!tenants.length) {
      $('tenantBody').innerHTML = '<tr><td colspan="5">No tenants yet. Add rows to the <code>tenants</code> table in D1 to get started.</td></tr>';
      return;
    }
    $('tenantBody').innerHTML = tenants.map(function (t) {
      return '<tr class="row-click" data-id="' + t.id + '" data-name="' + esc(t.full_name) + '" data-unit="' + esc(t.unit_label || '') + '">' +
        '<td>' + esc(t.full_name) + '<br><span style="color:var(--muted);font-size:.8rem;">' + esc(t.email) + '</span></td>' +
        '<td>' + esc(t.unit_label || '—') + '</td>' +
        '<td>' + money(t.rent_amount_cents) + '</td>' +
        '<td>' + fmtDate(t.nextDueDate) + '</td>' +
        '<td>' + fmtDate(t.last_paid_at) + '</td></tr>';
    }).join('');

    document.querySelectorAll('#tenantBody tr[data-id]').forEach(function (row) {
      row.addEventListener('click', function () {
        showDetail(row.dataset.id, row.dataset.name, row.dataset.unit);
      });
    });
  }

  function showDetail(id, name, unit) {
    $('tenantList').style.display = 'none';
    $('tenantDetail').className = 'open';
    $('detailName').textContent = name;
    $('detailUnit').textContent = unit;
    $('detailBody').innerHTML = '<tr><td colspan="4">Loading&hellip;</td></tr>';

    fetch('/legacy/api/tenants/' + id + '/payments')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderDetail(data.payments || []); })
      .catch(function () {
        $('detailBody').innerHTML = '<tr><td colspan="4">Could not load payment history.</td></tr>';
      });
  }

  function renderDetail(payments) {
    if (!payments.length) {
      $('detailBody').innerHTML = '<tr><td colspan="4">No payments yet.</td></tr>';
      return;
    }
    $('detailBody').innerHTML = payments.map(function (p) {
      return '<tr><td>' + esc(p.period_label || '') + '</td><td>' + money(p.amount_cents) +
        '</td><td><span class="pill ' + esc(p.status) + '">' + esc(p.status) + '</span></td><td>' +
        fmtDate(p.paid_at || p.created_at) + '</td></tr>';
    }).join('');
  }

  function showList() {
    $('tenantDetail').className = '';
    $('tenantList').style.display = '';
  }
})();
