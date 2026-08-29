/*
 * Admin view. Requires a signed-in admin session (GET /legacy/api/me
 * must return type: 'admin') -- anything else bounces back to sign-in.
 * All the data endpoints this page calls (/tenants, /maintenance, and
 * per-tenant detail) are separately gated server-side too.
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };
  let currentTenantId = null;
  let allMaintenance = [];

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

  function signOut(e) {
    if (e) e.preventDefault();
    fetch('/legacy/api/auth/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () { location.href = '/legacy/'; });
  }

  document.addEventListener('DOMContentLoaded', function () {
    fetch('/legacy/api/me')
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (!res.ok || res.data.type !== 'admin') {
          location.href = '/legacy/';
          return;
        }
        $('loadingMsg').hidden = true;
        $('app').hidden = false;
        init();
      })
      .catch(function () {
        location.href = '/legacy/';
      });
  });

  function init() {
    $('backLink').addEventListener('click', showList);
    $('tabPayments').addEventListener('click', function () { showTab('payments'); });
    $('tabMaintenance').addEventListener('click', function () { showTab('maintenance'); });
    $('navTenants').addEventListener('click', showTenantsView);
    $('navMaintenance').addEventListener('click', showMaintenanceView);
    $('maintenanceSearch').addEventListener('input', renderAllMaintenance);
    $('maintenanceStatusFilter').addEventListener('change', renderAllMaintenance);
    $('signOutLink').addEventListener('click', signOut);
    loadTenants();
  }

  function showTenantsView() {
    $('navTenants').className = 'active';
    $('navMaintenance').className = '';
    $('maintenanceList').className = '';
    document.getElementById('tenantList').style.display = '';
    $('tenantDetail').className = '';
  }

  function showMaintenanceView() {
    $('navTenants').className = '';
    $('navMaintenance').className = 'active';
    document.getElementById('tenantList').style.display = 'none';
    $('tenantDetail').className = '';
    $('maintenanceList').className = 'open';
    if (!allMaintenance.length) loadAllMaintenance();
  }

  function loadAllMaintenance() {
    $('allMaintenanceBody').innerHTML = '<tr><td colspan="5">Loading&hellip;</td></tr>';
    fetch('/legacy/api/maintenance')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        allMaintenance = data.requests || [];
        renderAllMaintenance();
      })
      .catch(function () {
        $('maintenanceApiNotice').textContent = 'Could not load maintenance requests.';
        $('maintenanceApiNotice').hidden = false;
      });
  }

  function renderAllMaintenance() {
    var q = ($('maintenanceSearch').value || '').trim().toLowerCase();
    var statusFilter = $('maintenanceStatusFilter').value;
    var filtered = allMaintenance.filter(function (r) {
      if (statusFilter && r.status !== statusFilter) return false;
      if (!q) return true;
      var haystack = (r.full_name + ' ' + (r.unit_label || '') + ' ' + r.description + ' ' + (r.issue_type || '')).toLowerCase();
      return haystack.indexOf(q) !== -1;
    });
    if (!filtered.length) {
      $('allMaintenanceBody').innerHTML = '<tr><td colspan="5">' +
        (allMaintenance.length ? 'No requests match your search.' : 'No maintenance requests yet.') + '</td></tr>';
      return;
    }
    $('allMaintenanceBody').innerHTML = filtered.map(function (r) {
      return '<tr><td>' + esc(r.full_name) + '</td><td>' + esc(r.unit_label || '—') + '</td><td>' +
        esc(r.description) + '</td><td>' + esc(r.issue_type || '—') + '</td><td>' +
        fmtDate(r.issue_started_on) + '</td><td><span class="pill ' + esc(r.status) + '">' + esc(r.status) +
        '</span></td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }).join('');
  }

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
      var statusPill = t.paidCurrentPeriod
        ? '<span class="pill current">Current</span>'
        : '<span class="pill late">Late</span>';
      return '<tr class="row-click" data-id="' + t.id + '" data-name="' + esc(t.fullName) + '" data-unit="' + esc(t.unitLabel || '') + '">' +
        '<td>' + esc(t.fullName) + '<br><span style="color:var(--muted);font-size:.8rem;">' + esc(t.email) + '</span></td>' +
        '<td>' + esc(t.unitLabel || '—') + '</td>' +
        '<td>' + money(t.rentAmountCents) + '</td>' +
        '<td>' + statusPill + '</td>' +
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
    currentTenantId = id;
    $('maintenanceList').className = '';
    document.getElementById('tenantList').style.display = 'none';
    $('tenantDetail').className = 'open';
    $('detailName').textContent = name;
    $('detailUnit').textContent = unit;
    showTab('payments');
  }

  function showTab(which) {
    $('tabPayments').className = which === 'payments' ? 'active' : '';
    $('tabMaintenance').className = which === 'maintenance' ? 'active' : '';
    $('paymentsTable').hidden = which !== 'payments';
    $('maintenanceTable').hidden = which !== 'maintenance';
    if (which === 'payments') loadPayments();
    else loadMaintenance();
  }

  function loadPayments() {
    $('detailBody').innerHTML = '<tr><td colspan="4">Loading&hellip;</td></tr>';
    fetch('/legacy/api/tenants/' + currentTenantId + '/payments')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderPayments(data.payments || []); })
      .catch(function () {
        $('detailBody').innerHTML = '<tr><td colspan="4">Could not load payment history.</td></tr>';
      });
  }

  function renderPayments(payments) {
    if (!payments.length) {
      $('detailBody').innerHTML = '<tr><td colspan="4">No payments yet.</td></tr>';
      return;
    }
    $('detailBody').innerHTML = payments.map(function (p) {
      var directTag = p.method && p.method !== 'stripe'
        ? ' <span class="pill" style="background:var(--bg);color:var(--muted);">paid direct</span>' : '';
      return '<tr><td>' + esc(p.period_label || '') + '</td><td>' + money(p.amount_cents) +
        '</td><td><span class="pill ' + esc(p.status) + '">' + esc(p.status) + '</span>' + directTag + '</td><td>' +
        fmtDate(p.paid_at || p.created_at) + '</td></tr>';
    }).join('');
  }

  function loadMaintenance() {
    $('maintenanceBody').innerHTML = '<tr><td colspan="3">Loading&hellip;</td></tr>';
    fetch('/legacy/api/tenants/' + currentTenantId + '/maintenance')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderMaintenance(data.requests || []); })
      .catch(function () {
        $('maintenanceBody').innerHTML = '<tr><td colspan="3">Could not load maintenance requests.</td></tr>';
      });
  }

  function renderMaintenance(requests) {
    if (!requests.length) {
      $('maintenanceBody').innerHTML = '<tr><td colspan="3">No requests yet.</td></tr>';
      return;
    }
    $('maintenanceBody').innerHTML = requests.map(function (r) {
      return '<tr><td>' + esc(r.description) + '</td><td>' + esc(r.issue_type || '—') + '</td><td>' +
        fmtDate(r.issue_started_on) + '</td><td><span class="pill ' + esc(r.status) + '">' +
        esc(r.status) + '</span></td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }).join('');
  }

  function showList() {
    showTenantsView();
  }
})();
