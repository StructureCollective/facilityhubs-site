/*
 * Tenant dashboard overview -- TEMPORARY no-auth mode (see src/index.js
 * header). Which tenant to show comes from ?tenant_id=N in the URL
 * instead of a signed-in session.
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

  document.addEventListener('DOMContentLoaded', function () {
    const tenantId = new URLSearchParams(location.search).get('tenant_id');
    if (!tenantId) {
      showPicker();
      return;
    }

    fetch('/legacy/api/tenants/' + encodeURIComponent(tenantId))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('loadingMsg').textContent = 'Tenant not found.';
          return;
        }
        render(res.data, tenantId);
        return fetch('/legacy/api/tenants/' + encodeURIComponent(tenantId) + '/maintenance')
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

  function showPicker() {
    fetch('/legacy/api/tenants')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        $('loadingMsg').hidden = true;
        $('picker').hidden = false;
        const tenants = data.tenants || [];
        if (!tenants.length) {
          $('pickerList').innerHTML = '<li>No tenants yet. Add one in D1 -- see legacy/README.md.</li>';
          return;
        }
        $('pickerList').innerHTML = tenants.map(function (t) {
          return '<li style="margin-bottom:8px;"><a href="?tenant_id=' + t.id + '">' +
            esc(t.fullName) + (t.unitLabel ? ' — ' + esc(t.unitLabel) : '') + '</a></li>';
        }).join('');
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load tenants.';
      });
  }

  function render(data, tenantId) {
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
    $('payLink').href = '../Payments/?tenant_id=' + tenantId;

    const payments = data.payments || [];
    const lastPaid = payments.find(function (p) { return p.status === 'succeeded'; });
    $('lastPayment').textContent = lastPaid ? fmtDate(lastPaid.paid_at) : 'None yet';

    $('loadingMsg').hidden = true;
    $('app').hidden = false;
  }
})();
