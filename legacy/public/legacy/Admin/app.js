/*
 * Admin view. Requires a signed-in admin session (GET /legacy/api/me
 * must return type: 'admin') -- anything else bounces back to sign-in.
 * All the data endpoints this page calls (/tenants, /maintenance, and
 * per-tenant detail) are separately gated server-side too.
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };
  let currentTenantId = null;
  let currentTenantData = null;
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
    $('editRentBtn').addEventListener('click', openRentEditor);
    $('saveRentBtn').addEventListener('click', saveRentEdit);
    $('cancelRentBtn').addEventListener('click', closeRentEditor);
    $('addFeeBtn').addEventListener('click', addFee);
    $('viewAsBtn').addEventListener('click', viewTenantPortal);
    loadTenants();
  }

  // Signs the browser in as this tenant (see /tenants/:id/view-as),
  // stashing the admin's own session so the tenant-facing pages' "Back
  // to Admin" button can restore it.
  function viewTenantPortal() {
    $('viewAsBtn').disabled = true;
    fetch('/legacy/api/tenants/' + currentTenantId + '/view-as', { method: 'POST' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('viewAsBtn').disabled = false;
          window.alert(res.data.error || 'Could not open the tenant portal.');
          return;
        }
        location.href = '/legacy/Dashboard/';
      })
      .catch(function () {
        $('viewAsBtn').disabled = false;
        window.alert('Something went wrong. Please try again.');
      });
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
    currentTenantData = null;
    closeRentEditor();
    $('maintenanceList').className = '';
    document.getElementById('tenantList').style.display = 'none';
    $('tenantDetail').className = 'open';
    $('detailName').textContent = name;
    $('detailUnit').textContent = unit;
    showTab('payments');
  }

  function openRentEditor() {
    $('rentEditStatus').hidden = true;
    $('editRentBtn').disabled = true;
    fetch('/legacy/api/tenants/' + currentTenantId)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        $('editRentBtn').disabled = false;
        if (!res.ok) {
          $('rentEditStatus').textContent = 'Could not load current rent details.';
          $('rentEditStatus').hidden = false;
          return;
        }
        currentTenantData = res.data.tenant;
        $('rentAmountInput').value = (currentTenantData.rentAmountCents / 100).toFixed(2);
        $('lateFeeInput').value = (currentTenantData.lateFeeCents / 100).toFixed(2);
        $('lateFeeAfterDayInput').value = currentTenantData.lateFeeAfterDay || '';
        renderFeeList();
        $('editRentBtn').hidden = true;
        $('rentEditForm').hidden = false;
      })
      .catch(function () {
        $('editRentBtn').disabled = false;
        $('rentEditStatus').textContent = 'Could not load current rent details.';
        $('rentEditStatus').hidden = false;
      });
  }

  function closeRentEditor() {
    $('rentEditForm').hidden = true;
    $('editRentBtn').hidden = false;
    $('editRentBtn').disabled = false;
    $('rentEditStatus').hidden = true;
    $('feeAddStatus').hidden = true;
    $('feeLabelInput').value = '';
    $('feeAmountInput').value = '';
  }

  function renderFeeList() {
    var fees = (currentTenantData && currentTenantData.extraFees) || [];
    if (!fees.length) {
      $('feeList').innerHTML = '<li style="color:var(--muted);">No pending fees.</li>';
      return;
    }
    $('feeList').innerHTML = fees.map(function (f) {
      return '<li><span>' + esc(f.label) + ' &mdash; ' + money(f.amountCents) +
        '</span><button type="button" class="fee-remove" data-fee-id="' + f.id + '">Remove</button></li>';
    }).join('');
    document.querySelectorAll('#feeList .fee-remove').forEach(function (btn) {
      btn.addEventListener('click', function () { removeFee(btn.dataset.feeId); });
    });
  }

  // Re-fetches just the tenant (for its current extraFees) without
  // disturbing whatever the admin has typed into the rent/late-fee
  // fields above -- add/remove fee shouldn't blow away an in-progress
  // rent edit.
  function reloadTenantFees() {
    return fetch('/legacy/api/tenants/' + currentTenantId)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        currentTenantData = data.tenant;
        renderFeeList();
      })
      .catch(function () {});
  }

  function addFee() {
    var label = $('feeLabelInput').value.trim();
    var dollars = parseFloat($('feeAmountInput').value);

    if (!label) {
      $('feeAddStatus').textContent = 'Enter a label for this fee.';
      $('feeAddStatus').hidden = false;
      return;
    }
    if (label.length > 80) {
      $('feeAddStatus').textContent = 'Label must be 80 characters or fewer.';
      $('feeAddStatus').hidden = false;
      return;
    }
    if (!(dollars > 0)) {
      $('feeAddStatus').textContent = 'Enter a valid amount.';
      $('feeAddStatus').hidden = false;
      return;
    }

    var amountCents = Math.round(dollars * 100);
    var name = currentTenantData ? currentTenantData.fullName : 'this tenant';

    if (!window.confirm('Add "' + label + '" (' + money(amountCents) + ') to ' + name + '\'s next payment?')) {
      return;
    }
    if (!window.confirm('Please confirm once more to add this fee for ' + name + '.')) {
      return;
    }

    $('addFeeBtn').disabled = true;
    $('feeAddStatus').hidden = true;

    fetch('/legacy/api/tenants/' + currentTenantId + '/fees', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: label, amountCents: amountCents }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        $('addFeeBtn').disabled = false;
        if (!res.ok) {
          $('feeAddStatus').textContent = res.data.error || 'Could not add fee.';
          $('feeAddStatus').hidden = false;
          return;
        }
        $('feeLabelInput').value = '';
        $('feeAmountInput').value = '';
        reloadTenantFees();
      })
      .catch(function () {
        $('addFeeBtn').disabled = false;
        $('feeAddStatus').textContent = 'Something went wrong. Please try again.';
        $('feeAddStatus').hidden = false;
      });
  }

  function removeFee(feeId) {
    if (!window.confirm('Remove this fee before it\'s charged?')) return;
    fetch('/legacy/api/tenants/' + currentTenantId + '/fees/' + feeId, { method: 'DELETE' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('feeAddStatus').textContent = res.data.error || 'Could not remove fee.';
          $('feeAddStatus').hidden = false;
          return;
        }
        reloadTenantFees();
      })
      .catch(function () {
        $('feeAddStatus').textContent = 'Something went wrong. Please try again.';
        $('feeAddStatus').hidden = false;
      });
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function saveRentEdit() {
    var rentDollars = parseFloat($('rentAmountInput').value);
    var feeDollars = parseFloat($('lateFeeInput').value || '0');
    var afterDayRaw = $('lateFeeAfterDayInput').value.trim();

    if (!(rentDollars > 0)) {
      $('rentEditStatus').textContent = 'Enter a valid rent amount.';
      $('rentEditStatus').hidden = false;
      return;
    }
    if (isNaN(feeDollars) || feeDollars < 0) {
      $('rentEditStatus').textContent = 'Enter a valid late fee amount (or 0).';
      $('rentEditStatus').hidden = false;
      return;
    }
    var afterDay = null;
    if (afterDayRaw) {
      afterDay = parseInt(afterDayRaw, 10);
      if (!(afterDay >= 1 && afterDay <= 28)) {
        $('rentEditStatus').textContent = 'Late fee day must be between 1 and 28 (or left blank for no late fee).';
        $('rentEditStatus').hidden = false;
        return;
      }
    }

    var rentAmountCents = Math.round(rentDollars * 100);
    var lateFeeCents = Math.round(feeDollars * 100);
    var name = currentTenantData ? currentTenantData.fullName : 'this tenant';
    var summary = 'Rent: ' + money(rentAmountCents) +
      (lateFeeCents ? ', late fee: ' + money(lateFeeCents) + (afterDay ? ' after the ' + ordinal(afterDay) : '') : ', no late fee');

    if (!window.confirm('Change ' + name + '\'s rent and fees?\n\n' + summary + '\n\nThis applies to their upcoming payment.')) {
      return;
    }
    if (!window.confirm('Please confirm once more to save this change for ' + name + '. This cannot be undone automatically.')) {
      return;
    }

    $('saveRentBtn').disabled = true;
    $('cancelRentBtn').disabled = true;
    $('rentEditStatus').hidden = true;

    fetch('/legacy/api/tenants/' + currentTenantId + '/rent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rentAmountCents: rentAmountCents, lateFeeCents: lateFeeCents, lateFeeAfterDay: afterDay }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        $('saveRentBtn').disabled = false;
        $('cancelRentBtn').disabled = false;
        if (!res.ok) {
          $('rentEditStatus').textContent = res.data.error || 'Could not save changes.';
          $('rentEditStatus').hidden = false;
          return;
        }
        closeRentEditor();
        loadTenants();
      })
      .catch(function () {
        $('saveRentBtn').disabled = false;
        $('cancelRentBtn').disabled = false;
        $('rentEditStatus').textContent = 'Something went wrong. Please try again.';
        $('rentEditStatus').hidden = false;
      });
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
    $('detailBody').innerHTML = '<tr><td colspan="5">Loading&hellip;</td></tr>';
    fetch('/legacy/api/tenants/' + currentTenantId + '/payments')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderPayments(data.payments || []); })
      .catch(function () {
        $('detailBody').innerHTML = '<tr><td colspan="5">Could not load payment history.</td></tr>';
      });
  }

  function renderPayments(payments) {
    if (!payments.length) {
      $('detailBody').innerHTML = '<tr><td colspan="5">No payments yet.</td></tr>';
      return;
    }
    $('detailBody').innerHTML = payments.map(function (p) {
      var directTag = p.method && p.method !== 'stripe'
        ? ' <span class="pill" style="background:var(--bg);color:var(--muted);">paid direct</span>' : '';
      var receiptCell = p.receipt_url
        ? '<a href="' + esc(p.receipt_url) + '" target="_blank" rel="noopener">View / download</a>'
        : '\u2014';
      return '<tr><td>' + esc(p.period_label || '') + '</td><td>' + money(p.amount_cents) +
        '</td><td><span class="pill ' + esc(p.status) + '">' + esc(p.status) + '</span>' + directTag + '</td><td>' +
        fmtDate(p.paid_at || p.created_at) + '</td><td>' + receiptCell + '</td></tr>';
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
