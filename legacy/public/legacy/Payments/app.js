/*
 * Tenant payments page -- TEMPORARY no-auth mode (see src/index.js
 * header). Which tenant to show comes from ?tenant_id=N in the URL.
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
        render(res.data);
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load payments. Please reload the page.';
      });

    $('payBtn').addEventListener('click', function () {
      $('payBtn').disabled = true;
      $('payStatus').textContent = 'Redirecting to secure checkout…';
      fetch('/legacy/api/tenants/' + encodeURIComponent(tenantId) + '/pay', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.data.url) {
            $('payStatus').textContent = res.data.error || 'Could not start checkout.';
            $('payBtn').disabled = false;
            return;
          }
          location.href = res.data.url;
        })
        .catch(function () {
          $('payStatus').textContent = 'Something went wrong. Please try again.';
          $('payBtn').disabled = false;
        });
    });
  });

  function render(data) {
    const t = data.tenant;
    $('greeting').textContent = 'Hi, ' + (t.fullName ? t.fullName.split(' ')[0] : 'there');
    $('unitLabel').innerHTML = fmtAddress(t.unitLabel);

    let amount = t.rentAmountCents;
    if (t.lateFeeApplies) amount += t.lateFeeCents;
    $('rentAmount').textContent = money(amount);
    $('dueSub').textContent = t.lateFeeApplies
      ? 'Includes ' + money(t.lateFeeCents) + ' late fee (past the ' + ordinal(t.lateFeeAfterDay) + ')'
      : 'Due ' + fmtDate(t.nextDueDate);

    const params = new URLSearchParams(location.search);
    if (params.get('paid') === '1') {
      $('statusNotice').textContent = 'Payment received — thank you! It may take a minute to reflect below.';
      $('statusNotice').hidden = false;
    } else if (params.get('canceled') === '1') {
      $('statusNotice').className = 'notice warn';
      $('statusNotice').textContent = 'Checkout was canceled.';
      $('statusNotice').hidden = false;
    }

    renderHistory(data.payments || []);
    $('loadingMsg').hidden = true;
    $('app').hidden = false;
  }

  function ordinal(n) {
    if (!n) return '';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderHistory(payments) {
    if (!payments.length) {
      $('historyBody').innerHTML = '<tr><td colspan="4">No payments yet.</td></tr>';
      return;
    }
    $('historyBody').innerHTML = payments.map(function (p) {
      return '<tr><td>' + esc(p.period_label || '') + '</td><td>' + money(p.amount_cents) +
        '</td><td><span class="pill ' + esc(p.status) + '">' + esc(p.status) + '</span></td><td>' +
        fmtDate(p.paid_at || p.created_at) + '</td></tr>';
    }).join('');
  }
})();
