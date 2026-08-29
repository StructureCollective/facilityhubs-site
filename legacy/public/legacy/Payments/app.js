/*
 * Tenant payments page -- custom embedded checkout via Stripe Elements'
 * Payment Element (mounted right here), not a redirect to a
 * Stripe-hosted Checkout page. Tenant identity comes from the
 * signed-in session (GET /legacy/api/tenants/me).
 */
(function () {
  const $ = function (id) { return document.getElementById(id); };
  let allPayments = [];
  let stripe = null;
  let stripeLoadPromise = null;
  let elements = null;

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

  // Loads Stripe.js's publishable key from the backend and initializes
  // `stripe` exactly once, however many times this gets called.
  function ensureStripe() {
    if (stripe) return Promise.resolve(stripe);
    if (stripeLoadPromise) return stripeLoadPromise;
    stripeLoadPromise = fetch('/legacy/api/stripe/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg.publishableKey) throw new Error('Stripe is not configured yet.');
        if (typeof Stripe !== 'function') throw new Error('Stripe.js failed to load.');
        stripe = Stripe(cfg.publishableKey);
        return stripe;
      });
    return stripeLoadPromise;
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
          $('loadingMsg').textContent = 'Could not load payments. Please reload the page.';
          return;
        }
        render(res.data);
        maybeShowReturnStatus();
      })
      .catch(function () {
        $('loadingMsg').textContent = 'Could not load payments. Please reload the page.';
      });

    $('historySearch').addEventListener('input', renderHistory);
    $('historyStatusFilter').addEventListener('change', renderHistory);
    $('payBtn').addEventListener('click', startPayment);
    $('confirmPayBtn').addEventListener('click', submitPayment);
    $('cancelPayBtn').addEventListener('click', cancelPaymentForm);
  });

  function startPayment() {
    $('payBtn').disabled = true;
    $('payStatus').textContent = 'Loading secure payment form…';

    ensureStripe()
      .then(function () {
        return fetch('/legacy/api/tenants/me/pay', { method: 'POST' });
      })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.clientSecret) {
          $('payStatus').textContent = res.data.error || 'Could not start payment.';
          $('payBtn').disabled = false;
          return;
        }
        elements = stripe.elements({
          clientSecret: res.data.clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: '#0d2b5c',
              colorText: '#12192b',
              colorDanger: '#9a2f24',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
              borderRadius: '8px',
            },
          },
        });
        elements.create('payment').mount('#paymentElement');
        $('payStatus').textContent = '';
        $('paymentFormSection').hidden = false;
        $('paymentFormSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (err) {
        $('payStatus').textContent = (err && err.message) || 'Something went wrong. Please try again.';
        $('payBtn').disabled = false;
      });
  }

  function submitPayment() {
    if (!stripe || !elements) return;
    $('confirmPayBtn').disabled = true;
    $('cancelPayBtn').disabled = true;
    $('confirmPayStatus').textContent = 'Processing…';

    stripe.confirmPayment({
      elements: elements,
      confirmParams: { return_url: location.origin + '/legacy/Payments/' },
      // Only bounces to a redirect when a payment method actually
      // requires it (3-D Secure, some bank-debit flows) -- otherwise
      // resolves right here, no page navigation.
      redirect: 'if_required',
    }).then(function (result) {
      if (result.error) {
        $('confirmPayStatus').textContent = result.error.message || 'Payment failed. Please try again.';
        $('confirmPayBtn').disabled = false;
        $('cancelPayBtn').disabled = false;
        return;
      }
      resetPaymentForm();
      showStatus('good', statusMessageFor(result.paymentIntent && result.paymentIntent.status));
      refreshTenant();
    }).catch(function () {
      $('confirmPayStatus').textContent = 'Something went wrong. Please try again.';
      $('confirmPayBtn').disabled = false;
      $('cancelPayBtn').disabled = false;
    });
  }

  function cancelPaymentForm() {
    resetPaymentForm();
    $('payStatus').textContent = '';
  }

  function resetPaymentForm() {
    $('paymentFormSection').hidden = true;
    $('paymentElement').innerHTML = '';
    elements = null;
    $('confirmPayBtn').disabled = false;
    $('cancelPayBtn').disabled = false;
    $('confirmPayStatus').textContent = '';
    $('payBtn').disabled = false;
  }

  function statusMessageFor(status) {
    if (status === 'processing') {
      return 'Payment is processing — this can take a moment for bank payments.';
    }
    return 'Payment received — thank you! It may take a minute to reflect below.';
  }

  function showStatus(kind, text) {
    $('statusNotice').className = 'notice ' + kind;
    $('statusNotice').textContent = text;
    $('statusNotice').hidden = false;
  }

  // After a redirect-required confirmation (e.g. a 3-D Secure
  // challenge), Stripe appends redirect_status to our return_url.
  function maybeShowReturnStatus() {
    const params = new URLSearchParams(location.search);
    const redirectStatus = params.get('redirect_status');
    if (!redirectStatus) return;
    if (redirectStatus === 'succeeded' || redirectStatus === 'processing') {
      showStatus('good', statusMessageFor(redirectStatus));
      refreshTenant();
    } else {
      showStatus('warn', 'That payment did not complete. Please try again.');
    }
    history.replaceState(null, '', location.pathname);
  }

  function refreshTenant() {
    fetch('/legacy/api/tenants/me')
      .then(function (r) { return r.json(); })
      .then(function (data) { render(data); })
      .catch(function () {});
  }

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

    allPayments = data.payments || [];
    renderHistory();
    $('loadingMsg').hidden = true;
    $('app').hidden = false;
  }

  function ordinal(n) {
    if (!n) return '';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderHistory() {
    var q = ($('historySearch').value || '').trim().toLowerCase();
    var statusFilter = $('historyStatusFilter').value;
    var filtered = allPayments.filter(function (p) {
      if (statusFilter && p.status !== statusFilter) return false;
      if (!q) return true;
      return (p.period_label || '').toLowerCase().indexOf(q) !== -1;
    });
    if (!filtered.length) {
      $('historyBody').innerHTML = '<tr><td colspan="5">' +
        (allPayments.length ? 'No payments match your search.' : 'No payments yet.') + '</td></tr>';
      return;
    }
    $('historyBody').innerHTML = filtered.map(function (p) {
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
})();
