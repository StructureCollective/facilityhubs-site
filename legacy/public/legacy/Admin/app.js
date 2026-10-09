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
  let currentRequestId = null;
  let currentRequestData = null;
  // Where "back" from a request's detail view goes: the all-requests
  // list, or the tenant detail page it was opened from.
  let requestReturnTo = 'list';

  var STATUS_LABELS = { open: 'Open', scheduled: 'Scheduled', in_progress: 'In progress', closed: 'Closed' };
  function statusText(s) { return STATUS_LABELS[s] || s; }
  function statusPill(s) {
    return '<span class="pill ' + esc(s) + '">' + esc(statusText(s)) + '</span>';
  }

  // D1's datetime('now') values are UTC 'YYYY-MM-DD HH:MM:SS' -- shown
  // in the property's own time zone.
  function fmtDateTime(sqlUtc) {
    if (!sqlUtc) return '\u2014';
    return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    });
  }

  function fmtTime(hhmm) {
    if (!hhmm) return '';
    var parts = hhmm.split(':');
    var h = parseInt(parts[0], 10);
    return (h % 12 === 0 ? 12 : h % 12) + ':' + parts[1] + ' ' + (h >= 12 ? 'PM' : 'AM');
  }

  function fmtApptDate(iso) {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
  }

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
    $('sendOnboardingBtn').addEventListener('click', sendOnboardingEmail);
    $('editProfileBtn').addEventListener('click', openProfileEditor);
    $('saveProfileBtn').addEventListener('click', saveProfileEdit);
    $('cancelProfileBtn').addEventListener('click', closeProfileEditor);
    $('requestBackLink').addEventListener('click', closeRequest);
    $('saveStatusBtn').addEventListener('click', saveRequestStatus);
    $('addNoteBtn').addEventListener('click', addRequestNote);
    $('openApptBtn').addEventListener('click', openApptForm);
    $('cancelApptBtn').addEventListener('click', closeApptForm);
    $('sendApptBtn').addEventListener('click', sendAppointment);
    loadTenants();
  }

  // Prompts for a recipient (pre-filled with the tenant's email on
  // file, but editable -- e.g. to send it to a personal address before
  // their portal account email is finalized), then sends the branded
  // "how the portal works" email via POST /tenants/:id/send-onboarding-email.
  function sendOnboardingEmail() {
    var name = currentTenantData ? currentTenantData.fullName : 'this tenant';
    var defaultEmail = currentTenantData ? currentTenantData.email : '';
    var to = window.prompt('Send the onboarding email to ' + name + ' at:', defaultEmail || '');
    if (to === null) return;
    to = to.trim();
    if (!to) return;

    $('sendOnboardingBtn').disabled = true;

    fetch('/legacy/api/tenants/' + currentTenantId + '/send-onboarding-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: to }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        $('sendOnboardingBtn').disabled = false;
        if (!res.ok) {
          window.alert(res.data.error || 'Could not send the onboarding email.');
          return;
        }
        window.alert('Onboarding email sent to ' + res.data.sentTo + '.');
      })
      .catch(function () {
        $('sendOnboardingBtn').disabled = false;
        window.alert('Something went wrong. Please try again.');
      });
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
    $('requestDetail').className = '';
    $('navTenants').className = 'active';
    $('navMaintenance').className = '';
    $('maintenanceList').className = '';
    document.getElementById('tenantList').style.display = '';
    $('tenantDetail').className = '';
  }

  function showMaintenanceView() {
    $('requestDetail').className = '';
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
      return '<tr class="row-click" data-req-id="' + r.id + '"><td>' + esc(r.full_name) + '</td><td>' + esc(r.unit_label || '—') + '</td><td>' +
        esc(r.description) + '</td><td>' + esc(r.issue_type || '—') + '</td><td>' +
        fmtDate(r.issue_started_on) + '</td><td>' + statusPill(r.status) +
        '</td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }).join('');
    document.querySelectorAll('#allMaintenanceBody tr[data-req-id]').forEach(function (row) {
      row.addEventListener('click', function () { openRequest(row.dataset.reqId, 'list'); });
    });
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
    closeProfileEditor();
    $('requestDetail').className = '';
    $('maintenanceList').className = '';
    document.getElementById('tenantList').style.display = 'none';
    $('tenantDetail').className = 'open';
    $('detailName').textContent = name;
    $('detailUnit').textContent = unit;
    showTab('payments');
  }

  function openRentEditor() {
    closeProfileEditor();
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

  function openProfileEditor() {
    closeRentEditor();
    $('profileEditStatus').hidden = true;
    $('editProfileBtn').disabled = true;
    fetch('/legacy/api/tenants/' + currentTenantId)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        $('editProfileBtn').disabled = false;
        if (!res.ok) {
          $('profileEditStatus').textContent = 'Could not load this tenant\'s profile.';
          $('profileEditStatus').hidden = false;
          return;
        }
        currentTenantData = res.data.tenant;
        $('profileNameInput').value = currentTenantData.fullName || '';
        $('profileEmailInput').value = currentTenantData.email || '';
        $('profilePhoneInput').value = currentTenantData.phone || '';
        $('editProfileBtn').hidden = true;
        $('profileEditForm').hidden = false;
      })
      .catch(function () {
        $('editProfileBtn').disabled = false;
        $('profileEditStatus').textContent = 'Could not load this tenant\'s profile.';
        $('profileEditStatus').hidden = false;
      });
  }

  function closeProfileEditor() {
    $('profileEditForm').hidden = true;
    $('editProfileBtn').hidden = false;
    $('editProfileBtn').disabled = false;
    $('profileEditStatus').hidden = true;
  }

  function saveProfileEdit() {
    var fullName = $('profileNameInput').value.trim();
    var email = $('profileEmailInput').value.trim().toLowerCase();
    var phone = $('profilePhoneInput').value.trim();

    if (!fullName) {
      $('profileEditStatus').textContent = 'Enter the tenant\'s full name.';
      $('profileEditStatus').hidden = false;
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      $('profileEditStatus').textContent = 'Enter a valid email address.';
      $('profileEditStatus').hidden = false;
      return;
    }

    // The sign-in email is the one field here a mistake actually locks
    // the tenant out over -- worth a confirmation, unlike name/phone.
    var priorEmail = currentTenantData ? currentTenantData.email : null;
    if (priorEmail && email !== priorEmail) {
      if (!window.confirm('This changes the email ' + (fullName || 'this tenant') + ' signs in with, from ' + priorEmail + ' to ' + email + '. Continue?')) {
        return;
      }
    }

    $('saveProfileBtn').disabled = true;
    $('cancelProfileBtn').disabled = true;
    $('profileEditStatus').hidden = true;

    fetch('/legacy/api/tenants/' + currentTenantId + '/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: fullName, email: email, phone: phone }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        $('saveProfileBtn').disabled = false;
        $('cancelProfileBtn').disabled = false;
        if (!res.ok) {
          $('profileEditStatus').textContent = res.data.error || 'Could not save changes.';
          $('profileEditStatus').hidden = false;
          return;
        }
        $('detailName').textContent = fullName;
        closeProfileEditor();
        reloadTenantDetail();
        loadTenants();
      })
      .catch(function () {
        $('saveProfileBtn').disabled = false;
        $('cancelProfileBtn').disabled = false;
        $('profileEditStatus').textContent = 'Something went wrong. Please try again.';
        $('profileEditStatus').hidden = false;
      });
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

  // Re-fetches just the tenant (its current extraFees, or an updated
  // name/email/phone after a profile edit) without disturbing whatever
  // the admin has typed into the rent/late-fee fields above -- add/
  // remove fee or a profile save shouldn't blow away an in-progress
  // rent edit.
  function reloadTenantDetail() {
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
        reloadTenantDetail();
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
        reloadTenantDetail();
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
      var receiptCell = p.status === 'succeeded'
        ? '<a href="/legacy/api/tenants/' + currentTenantId + '/payments/' + p.id + '/receipt.pdf" target="_blank" rel="noopener">View / download</a>'
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
      return '<tr class="row-click" data-req-id="' + r.id + '"><td>' + esc(r.description) + '</td><td>' + esc(r.issue_type || '—') + '</td><td>' +
        fmtDate(r.issue_started_on) + '</td><td>' + statusPill(r.status) +
        '</td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }).join('');
    document.querySelectorAll('#maintenanceBody tr[data-req-id]').forEach(function (row) {
      row.addEventListener('click', function () { openRequest(row.dataset.reqId, 'tenant'); });
    });
  }


  // ---- Maintenance request detail ----

  function openRequest(id, returnTo) {
    currentRequestId = id;
    currentRequestData = null;
    requestReturnTo = returnTo;
    closeApptForm();
    ['noteMsg', 'statusMsg', 'apptMsg'].forEach(function (k) { $(k).hidden = true; });
    $('reqNotice').hidden = true;
    $('noteInput').value = '';
    $('requestBackLink').innerHTML = returnTo === 'tenant' ? '&larr; Back to tenant' : '&larr; Maintenance requests';
    document.getElementById('tenantList').style.display = 'none';
    $('maintenanceList').className = '';
    $('tenantDetail').className = '';
    $('requestDetail').className = 'open';
    $('reqTitle').textContent = 'Loading…';
    $('reqSub').textContent = '';
    window.scrollTo(0, 0);
    loadRequest();
  }

  function closeRequest() {
    $('requestDetail').className = '';
    if (requestReturnTo === 'tenant' && currentTenantId) {
      $('tenantDetail').className = 'open';
      showTab('maintenance');
    } else {
      $('maintenanceList').className = 'open';
      loadAllMaintenance();
    }
  }

  function loadRequest() {
    return fetch('/legacy/api/maintenance/' + currentRequestId)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('reqNotice').textContent = res.data.error || 'Could not load this request.';
          $('reqNotice').hidden = false;
          return;
        }
        currentRequestData = res.data;
        renderRequest();
      })
      .catch(function () {
        $('reqNotice').textContent = 'Could not load this request.';
        $('reqNotice').hidden = false;
      });
  }

  function renderRequest() {
    var d = currentRequestData;
    var req = d.request;
    var t = d.tenant;
    $('reqTitle').textContent = (req.issue_type || 'Maintenance') + ' — ' + t.full_name;
    $('reqSub').innerHTML = statusPill(req.status) + ' &nbsp;' + esc(t.unit_label || '');
    $('reqDescription').textContent = req.description;
    $('reqType').textContent = req.issue_type || '—';
    $('reqStarted').textContent = fmtDate(req.issue_started_on);
    $('reqSubmitted').textContent = fmtDateTime(req.created_at);
    $('reqUpdated').textContent = fmtDateTime(req.updated_at || req.created_at);
    $('reqStatusSelect').value = req.status;

    $('reqTenantName').textContent = t.full_name;
    $('reqTenantUnit').textContent = t.unit_label || '';
    $('reqTenantEmail').innerHTML = t.email ? '<a href="mailto:' + esc(t.email) + '">' + esc(t.email) + '</a>' : '';
    $('reqTenantPhone').innerHTML = t.phone ? '<a href="tel:' + esc(t.phone) + '">' + esc(t.phone) + '</a>' : '';

    var appts = d.appointments || [];
    if (!appts.length) {
      $('apptList').innerHTML = '<li style="color:var(--muted);">No appointment scheduled yet.</li>';
    } else {
      $('apptList').innerHTML = appts.map(function (a) {
        var pill = a.status === 'approved' ? '<span class="pill succeeded">Approved</span>'
          : a.status === 'pending' ? '<span class="pill pending">Awaiting approval</span>'
          : '<span class="pill superseded">Replaced</span>';
        var when = fmtApptDate(a.appointment_date) + ' · ' + fmtTime(a.start_time) +
          (a.end_time ? ' – ' + fmtTime(a.end_time) : '');
        var sub = 'Sent to ' + esc(a.sent_to) + ' on ' + fmtDateTime(a.created_at) +
          (a.status === 'approved' && a.responded_at ? '<br>Approved ' + fmtDateTime(a.responded_at) : '');
        return '<li' + (a.status === 'superseded' ? ' style="opacity:.6;"' : '') + '><div class="appt-when"><span>' +
          esc(when) + '</span>' + pill + '</div><div class="appt-sub">' + sub + '</div></li>';
      }).join('');
    }
    $('openApptBtn').textContent = appts.length ? 'Send a New Time' : 'Schedule Appointment';

    var notes = d.notes || [];
    if (!notes.length) {
      $('timeline').innerHTML = '<li style="color:var(--muted);border-top:none;">No notes yet.</li>';
    } else {
      $('timeline').innerHTML = notes.map(function (n) {
        var who = n.kind === 'note' ? (n.author || 'Admin') : (n.author ? n.author : 'System');
        return '<li class="' + (n.kind === 'event' ? 'event' : 'note') + '"><div class="tl-meta">' +
          esc(fmtDateTime(n.created_at)) + ' · ' + esc(who) + '</div><div class="tl-body">' + esc(n.body) + '</div></li>';
      }).join('');
    }
  }

  function showMsg(id, text, good) {
    $(id).textContent = text;
    $(id).className = 'req-msg ' + (good ? 'good' : 'error');
    $(id).hidden = false;
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
  }

  function saveRequestStatus() {
    var status = $('reqStatusSelect').value;
    if (currentRequestData && status === currentRequestData.request.status) {
      showMsg('statusMsg', 'Status is already ' + statusText(status) + '.', true);
      return;
    }
    $('saveStatusBtn').disabled = true;
    postJson('/legacy/api/maintenance/' + currentRequestId + '/status', { status: status })
      .then(function (res) {
        $('saveStatusBtn').disabled = false;
        if (!res.ok) { showMsg('statusMsg', res.data.error || 'Could not update status.'); return; }
        showMsg('statusMsg', 'Status updated to ' + statusText(status) + '.', true);
        allMaintenance = [];
        loadRequest();
      })
      .catch(function () {
        $('saveStatusBtn').disabled = false;
        showMsg('statusMsg', 'Something went wrong. Please try again.');
      });
  }

  function addRequestNote() {
    var text = $('noteInput').value.trim();
    if (!text) { showMsg('noteMsg', 'Type a note first.'); return; }
    $('addNoteBtn').disabled = true;
    $('noteMsg').hidden = true;
    postJson('/legacy/api/maintenance/' + currentRequestId + '/notes', { body: text })
      .then(function (res) {
        $('addNoteBtn').disabled = false;
        if (!res.ok) { showMsg('noteMsg', res.data.error || 'Could not save note.'); return; }
        $('noteInput').value = '';
        loadRequest();
      })
      .catch(function () {
        $('addNoteBtn').disabled = false;
        showMsg('noteMsg', 'Something went wrong. Please try again.');
      });
  }

  function openApptForm() {
    var tomorrow = new Date(Date.now() + 86400000);
    var iso = tomorrow.getFullYear() + '-' + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' +
      String(tomorrow.getDate()).padStart(2, '0');
    $('apptDate').value = iso;
    $('apptDate').min = new Date().toISOString().slice(0, 10);
    $('apptStart').value = '09:00';
    $('apptEnd').value = '12:00';
    $('apptMessage').value = '';
    $('apptEmail').value = (currentRequestData && currentRequestData.tenant.email) || '';
    $('apptMsg').hidden = true;
    $('openApptBtn').hidden = true;
    $('apptForm').hidden = false;
  }

  function closeApptForm() {
    $('apptForm').hidden = true;
    $('openApptBtn').hidden = false;
  }

  function sendAppointment() {
    var date = $('apptDate').value;
    var start = $('apptStart').value;
    var end = $('apptEnd').value;
    var email = $('apptEmail').value.trim().toLowerCase();
    if (!date) { showMsg('apptMsg', 'Choose a date.'); return; }
    if (!start) { showMsg('apptMsg', 'Choose a start time.'); return; }
    if (end && end <= start) { showMsg('apptMsg', 'End time must be after the start time.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg('apptMsg', 'Enter a valid email address.'); return; }

    var when = fmtApptDate(date) + ', ' + fmtTime(start) + (end ? ' – ' + fmtTime(end) : '');
    if (!window.confirm('Send this appointment to ' + email + '?\n\n' + when)) return;

    $('sendApptBtn').disabled = true;
    $('apptMsg').hidden = true;
    postJson('/legacy/api/maintenance/' + currentRequestId + '/appointments', {
      date: date, startTime: start, endTime: end || null,
      message: $('apptMessage').value.trim() || null, email: email,
    })
      .then(function (res) {
        $('sendApptBtn').disabled = false;
        if (!res.ok) {
          showMsg('apptMsg', res.data.error || 'Could not send the appointment.');
          loadRequest();
          return;
        }
        closeApptForm();
        loadRequest().then(function () {
          showMsg('apptMsg', 'Sent to ' + res.data.sentTo + '.', true);
        });
      })
      .catch(function () {
        $('sendApptBtn').disabled = false;
        showMsg('apptMsg', 'Something went wrong. Please try again.');
      });
  }

  function showList() {
    showTenantsView();
  }
})();
