/*
 * Tenant dashboard -- TEMPORARY no-auth mode (see src/index.js header).
 * Which tenant to show comes from ?tenant_id=N in the URL instead of a
 * signed-in session. With no tenant_id, this shows a picker (pulled from
 * the open tenant list) so you can preview any tenant's view -- that
 * picker should go away once sign-in comes back and this reads the
 * signed-in tenant directly instead.
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
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load this dashboard. Please reload the page.';
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

  function showPicker() {
    fetch('/legacy/api/tenants')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        $('loadingMsg').hidden = true;
        $('picker').hidden = false;
        const tenants = data.tenants || [];
        if (!tenants.length) {
          $('pickerList').innerHTML = '<li>No tenants yet. Add one in D1 -- see worker/README.md.</li>';
          return;
        }
        $('pickerList').innerHTML = tenants.map(function (t) {
          return '<li style="margin-bottom:8px;"><a href="?tenant_id=' + t.id + '">' +
            esc(t.full_name) + (t.unit_label ? ' — ' + esc(t.unit_label) : '') + '</a></li>';
        }).join('');
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load tenants.';
      });
  }

  function render(data, tenantId) {
    const t = data.tenant;
    $('greeting').textContent = t.fullName ? 'Hi, ' + t.fullName.split(' ')[0] : 'Your rent';
    $('unitLabel').textContent = t.unitLabel || '';
    $('rentAmount').textContent = money(t.rentAmountCents);
    $('dueDate').textContent = fmtDate(t.nextDueDate);

    const params = new URLSearchParams(location.search);
    if (params.get('paid') === '1') {
      $('dueSub').textContent = 'Payment received — thank you! It may take a minute to reflect below.';
    } else if (params.get('canceled') === '1') {
      $('dueSub').textContent = 'Checkout was canceled.';
    }

    renderHistory(data.payments || []);
    $('loadingMsg').hidden = true;
    $('app').hidden = false;
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
