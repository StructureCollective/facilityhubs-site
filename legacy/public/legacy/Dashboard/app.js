/*
 * Tenant dashboard overview. Tenant identity comes from the signed-in
 * session (a legacy_session cookie) rather than a ?tenant_id= URL param
 * -- GET /legacy/api/tenants/me resolves to whichever tenant is signed
 * in. A 401 means there's no valid session, so we bounce to sign-in.
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };

  function money(cents) {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso + (iso.length <= 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  }

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

  // Shown only when an admin is viewing this page through Admin's "View
  // Tenant Portal" -- lets them get back to Admin without signing out.
  function showImpersonationBanner(tenantName) {
    var bar = document.createElement('div');
    bar.className = 'impersonation-banner';
    bar.innerHTML = 'Viewing as <strong>' + esc(tenantName) + '</strong> (admin preview) ' +
      '<button type="button" id="backToAdminBtn">Back to Admin</button>';
    document.querySelector('.topbar').insertAdjacentElement('afterend', bar);
    $('backToAdminBtn').addEventListener('click', function () {
      fetch('/legacy/api/auth/return-to-admin', { method: 'POST' })
        .then(function (r) { location.href = r.ok ? '/legacy/Admin/' : '/legacy/'; })
        .catch(function () { location.href = '/legacy/'; });
    });
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
          $('loadingMsg').textContent = 'Could not load this dashboard. Please reload the page.';
          return;
        }
        if (res.data.impersonating) showImpersonationBanner(res.data.tenant.fullName);
        render(res.data);
        return fetch('/legacy/api/tenants/me/maintenance')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            const open = (d.requests || []).filter(function (r) { return r.status === 'open'; }).length;
            $('openCount').textContent = open;
          });
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load this dashboard. Please reload the page.';
      });
  });

  function render(data) {
    const t = data.tenant;
    $('greeting').textContent = 'Hi, ' + (t.fullName ? t.fullName.split(' ')[0] : 'there');
    $('unitLabel').innerHTML = fmtAddress(t.unitLabel);

    let amount = t.rentAmountCents;
    let lateNote = '';
    if (t.lateFeeApplies) {
      amount += t.lateFeeCents;
      lateNote = ' — includes ' + money(t.lateFeeCents) + ' late fee';
    }
    $('rentAmount').textContent = money(amount);
    $('dueDate').textContent = fmtDate(t.nextDueDate);
    $('lateNote').textContent = lateNote;

    const payments = data.payments || [];
    // Pick by paid_at, not array order -- the API sorts by created_at
    // (when the payment was initiated), which isn't reliably the same
    // as when it was actually paid, especially for payments recorded
    // after the fact (e.g. paid direct to the landlord).
    const lastPaid = payments
      .filter(function (p) { return p.status === 'succeeded' && p.paid_at; })
      .sort(function (a, b) { return new Date(b.paid_at) - new Date(a.paid_at); })[0];
    $('lastPayment').textContent = lastPaid ? fmtDate(lastPaid.paid_at) : 'None yet';

    $('loadingMsg').hidden = true;
    $('app').hidden = false;
  }
})();
