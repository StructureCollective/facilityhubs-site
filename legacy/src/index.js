/*
 * Legacy Property Hub -- Cloudflare Worker backend.
 *
 * ---------------------------------------------------------------------
 * TEMPORARY: Google Sign-In has been pulled out for now, at your
 * request, so there is NO authentication or authorization on any of
 * these endpoints -- anyone with a link can view any tenant's rent
 * amount and payment history, and can trigger a Stripe Checkout for any
 * tenant. That's fine for early testing, but it needs to be locked back
 * down before real tenants/rent money are involved.
 *
 * To restore it: verify a Google ID token (e.g. with the `jose` package
 * against https://www.googleapis.com/oauth2/v3/certs) on each request,
 * look the email up in the `admins` / `tenants` D1 tables (both tables
 * and their fail-closed design are unchanged from before), and scope
 * `/tenants/:id` access to the signed-in tenant's own id (or an admin).
 * A previous version of this file had that fully implemented -- check
 * git history for the original variant if you want to restore it as a
 * starting point.
 * ---------------------------------------------------------------------
 */

import Stripe from 'stripe';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Next occurrence of `dueDay` (1-28) on/after `fromDate`, as YYYY-MM-DD.
function nextDueDate(dueDay, fromDate = new Date()) {
  const d = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), dueDay));
  if (d.getTime() < Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate())) {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function periodLabel(dueDay) {
  return nextDueDate(dueDay).slice(0, 7); // 'YYYY-MM'
}

async function loadTenant(env, id) {
  return env.DB.prepare('SELECT * FROM tenants WHERE id = ? AND active = 1').bind(id).first();
}

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/legacy\/api/, '') || '/';

  if (path === '/tenants' && request.method === 'GET') {
    const tenants = await env.DB.prepare(
      `SELECT t.id, t.full_name, t.unit_label, t.email, t.rent_amount_cents, t.due_day,
              (SELECT MAX(paid_at) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'succeeded') AS last_paid_at
       FROM tenants t WHERE t.active = 1 ORDER BY t.full_name`
    ).all();
    const withDueDates = tenants.results.map((t) => ({ ...t, nextDueDate: nextDueDate(t.due_day) }));
    return json({ tenants: withDueDates });
  }

  if (path === '/tenants' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { email, fullName, unitLabel, rentAmountCents, dueDay } = body;
    if (!email || !fullName || !rentAmountCents || !dueDay) {
      return json({ error: 'email, fullName, rentAmountCents, and dueDay are required' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO tenants (email, full_name, unit_label, rent_amount_cents, due_day)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(String(email).toLowerCase(), fullName, unitLabel || null, rentAmountCents, dueDay).run();
    return json({ ok: true });
  }

  const tenantMatch = path.match(/^\/tenants\/(\d+)$/);
  if (tenantMatch && request.method === 'GET') {
    const tenant = await loadTenant(env, tenantMatch[1]);
    if (!tenant) return json({ error: 'not found' }, 404);
    const payments = await env.DB.prepare(
      `SELECT id, amount_cents, status, period_label, created_at, paid_at
       FROM payments WHERE tenant_id = ? ORDER BY created_at DESC`
    ).bind(tenant.id).all();
    return json({
      tenant: {
        id: tenant.id,
        fullName: tenant.full_name,
        unitLabel: tenant.unit_label,
        rentAmountCents: tenant.rent_amount_cents,
        dueDay: tenant.due_day,
        nextDueDate: nextDueDate(tenant.due_day),
      },
      payments: payments.results,
    });
  }

  const paymentsMatch = path.match(/^\/tenants\/(\d+)\/payments$/);
  if (paymentsMatch && request.method === 'GET') {
    const payments = await env.DB.prepare(
      `SELECT id, amount_cents, status, period_label, created_at, paid_at
       FROM payments WHERE tenant_id = ? ORDER BY created_at DESC`
    ).bind(paymentsMatch[1]).all();
    return json({ payments: payments.results });
  }

  const payMatch = path.match(/^\/tenants\/(\d+)\/pay$/);
  if (payMatch && request.method === 'POST') {
    const tenant = await loadTenant(env, payMatch[1]);
    if (!tenant) return json({ error: 'not found' }, 404);
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: 'Payments are not configured yet. Set STRIPE_SECRET_KEY.' }, 503);
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'us_bank_account'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Rent - ${tenant.unit_label || tenant.full_name}` },
          unit_amount: tenant.rent_amount_cents,
        },
        quantity: 1,
      }],
      success_url: `${url.origin}/legacy/Dashboard/?tenant_id=${tenant.id}&paid=1`,
      cancel_url: `${url.origin}/legacy/Dashboard/?tenant_id=${tenant.id}&canceled=1`,
      customer_email: tenant.email,
      metadata: { tenant_id: String(tenant.id) },
    });

    await env.DB.prepare(
      `INSERT INTO payments (tenant_id, amount_cents, status, stripe_checkout_session_id, period_label)
       VALUES (?, ?, 'pending', ?, ?)`
    ).bind(tenant.id, tenant.rent_amount_cents, session.id, periodLabel(tenant.due_day)).run();

    return json({ url: session.url });
  }

  return json({ error: 'not found' }, 404);
}

// Stripe webhook -- authenticated by verifying the Stripe-Signature header
// against STRIPE_WEBHOOK_SECRET (unrelated to the Google auth removed
// above; this is Stripe calling us, not a signed-in user).
async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'Stripe is not configured yet.' }, 503);
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const sig = request.headers.get('Stripe-Signature');
  const body = await request.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider()
    );
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await env.DB.prepare(
      `UPDATE payments SET status = 'succeeded', paid_at = datetime('now'), stripe_payment_intent_id = ?
       WHERE stripe_checkout_session_id = ?`
    ).bind(session.payment_intent, session.id).run();
  } else if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    await env.DB.prepare(
      `UPDATE payments SET status = 'failed' WHERE stripe_checkout_session_id = ? AND status = 'pending'`
    ).bind(session.id).run();
  }

  return json({ received: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/legacy/api/stripe/webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname.startsWith('/legacy/api/')) {
      return handleApi(request, env, url);
    }

    // Everything else under /legacy/* is a static asset (HTML/CSS/JS).
    return env.ASSETS.fetch(request);
  },
};
