/*
 * Legacy Property Hub -- Cloudflare Worker backend.
 *
 * ---------------------------------------------------------------------
 * AUTH: passwordless email magic links. A tenant or admin enters their
 * email on the sign-in page (POST /legacy/api/auth/request); if it
 * matches a row in `tenants` or `admins`, we email a one-time link
 * (GET /legacy/api/auth/verify?token=...) via Resend. The response is
 * identical whether or not the email matched, to avoid leaking which
 * emails are registered.
 *
 * Each link is a random, single-use token stored in the `login_tokens`
 * D1 table with a 15-minute expiry (see schema.sql). Visiting the link
 * redeems the token (marks it used, so it can't be replayed), then
 * issues a signed session cookie (HS256 JWT, `SESSION_SECRET`) good for
 * 30 days. Every tenant/admin API route below is gated on that cookie
 * via getSession()/resolveTenantAccess() -- an admin session can reach
 * any tenant; a tenant session can only reach its own record (including
 * via the `/tenants/me` shorthand the frontend uses).
 *
 * Requires the SESSION_SECRET secret (`wrangler secret put SESSION_SECRET`)
 * and at least one row in `admins` for anyone to be able to sign in as
 * an admin -- see README for the exact setup commands.
 * ---------------------------------------------------------------------
 */

import Stripe from 'stripe';
import { SignJWT, jwtVerify } from 'jose';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function escapeHtml(v) {
  return String(v).replace(/[&<>'"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]
  ));
}

// Sends an email via Resend, from legacy@facilityhubs.com. Requires the
// RESEND_API_KEY secret (`wrangler secret put RESEND_API_KEY`) -- until
// that's set, this quietly no-ops rather than breaking the payment or
// maintenance-request flow that triggered it.
async function sendEmail(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Legacy Property Hub <legacy@facilityhubs.com>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      console.error('Resend send failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Resend send threw:', err);
  }
}

// ---------------------------------------------------------------------
// Auth: magic-link tokens + signed session cookies.
// ---------------------------------------------------------------------

const SESSION_COOKIE = 'legacy_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sessionSecretKey(env) {
  if (!env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is not configured (wrangler secret put SESSION_SECRET)');
  }
  return new TextEncoder().encode(env.SESSION_SECRET);
}

// `type` is 'tenant' or 'admin'; `subject` is the tenant id (string) or
// the admin's email.
async function createSessionToken(env, { type, subject }) {
  const key = sessionSecretKey(env);
  return new SignJWT({ type, subject })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(key);
}

function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// Returns { type: 'tenant'|'admin', subject } from a valid session
// cookie, or null if there isn't one / it's invalid / expired.
async function getSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    const key = sessionSecretKey(env);
    const { payload } = await jwtVerify(token, key);
    if (!payload || !payload.type || payload.subject == null) return null;
    return { type: payload.type, subject: payload.subject };
  } catch (err) {
    return null;
  }
}

function canAccessTenant(session, tenantId) {
  if (!session) return false;
  if (session.type === 'admin') return true;
  return session.type === 'tenant' && String(session.subject) === String(tenantId);
}

// Resolves the `:id` path segment (a numeric tenant id, or the literal
// "me") against the caller's session. Returns { session, tenantId } on
// success, or { error: <Response> } if the caller isn't allowed in.
async function resolveTenantAccess(request, env, idParam) {
  const session = await getSession(request, env);
  if (!session) return { error: json({ error: 'Not signed in' }, 401) };

  if (idParam === 'me') {
    if (session.type !== 'tenant') {
      return { error: json({ error: 'Sign in as a tenant to use /me' }, 403) };
    }
    return { session, tenantId: String(session.subject) };
  }

  if (!canAccessTenant(session, idParam)) {
    return { error: json({ error: 'Forbidden' }, 403) };
  }
  return { session, tenantId: idParam };
}

function requireAdmin(session) {
  return !!session && session.type === 'admin';
}

// All due-day / late-fee day-of-month math is done in the property's
// local time (US Eastern), not UTC -- a tenant whose rent is due "on
// the 7th" should roll over to the next period at midnight Eastern,
// not midnight UTC (which is 7-8pm Eastern the evening before).
const PROPERTY_TIME_ZONE = 'America/New_York';

// { year, month (1-12), day } for `date`, as observed in PROPERTY_TIME_ZONE.
function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PROPERTY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Next occurrence of `dueDay` (1-28) on/after `fromDate`, as YYYY-MM-DD,
// reckoned in Eastern time.
function nextDueDate(dueDay, fromDate = new Date()) {
  const { year, month, day } = easternParts(fromDate);
  let y = year;
  let m = month - 1; // 0-indexed for Date.UTC
  if (day > dueDay) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return new Date(Date.UTC(y, m, dueDay)).toISOString().slice(0, 10);
}

// { year, month (1-12) } of the billing cycle currently in effect --
// the most recent occurrence of `dueDay` on/before `fromDate` (Eastern
// time). Unlike nextDueDate() (always strictly in the future), this is
// "the rent that's actually due or overdue right now."
function currentCycle(dueDay, fromDate = new Date()) {
  const { year, month, day } = easternParts(fromDate);
  let y = year;
  let m = month; // 1-indexed
  if (day < dueDay) {
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  return { year: y, month: m };
}

function currentDueDate(dueDay, fromDate = new Date()) {
  const { year, month } = currentCycle(dueDay, fromDate);
  return new Date(Date.UTC(year, month - 1, dueDay)).toISOString().slice(0, 10);
}

// The period a payment counts against: the billing cycle currently in
// effect, not always "next month" -- paying rent pays off what's due
// *now* (which may already be overdue), not next month's rent.
function currentPeriodLabel(dueDay, fromDate = new Date()) {
  const { year, month } = currentCycle(dueDay, fromDate);
  return `${year}-${String(month).padStart(2, '0')}`; // 'YYYY-MM'
}

async function loadTenant(env, id) {
  return env.DB.prepare('SELECT * FROM tenants WHERE id = ? AND active = 1').bind(id).first();
}

// Has this tenant already paid for the billing cycle currently in effect?
async function hasPaidCurrentPeriod(env, tenantId, dueDay) {
  const period = currentPeriodLabel(dueDay);
  const row = await env.DB.prepare(
    `SELECT id FROM payments WHERE tenant_id = ? AND period_label = ? AND status = 'succeeded' LIMIT 1`
  ).bind(tenantId, period).first();
  return !!row;
}

async function lateFeeInfo(env, tenant) {
  const paid = await hasPaidCurrentPeriod(env, tenant.id, tenant.due_day);
  if (!tenant.late_fee_after_day) {
    return { lateFeeCents: tenant.late_fee_cents || 0, lateFeeAfterDay: null, lateFeeApplies: false, paidCurrentPeriod: paid };
  }
  // Compare real calendar dates (not bare day-of-month numbers) so the
  // late-fee cutoff is always read from the SAME cycle being billed --
  // this is what stops a late fee for an already-overdue cycle from
  // getting pinned to next month's not-yet-due date.
  const { year, month } = currentCycle(tenant.due_day);
  const cutoff = Date.UTC(year, month - 1, tenant.late_fee_after_day);
  const today = easternParts();
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const applies = !paid && todayUtc > cutoff;
  return {
    lateFeeCents: tenant.late_fee_cents || 0,
    lateFeeAfterDay: tenant.late_fee_after_day,
    lateFeeApplies: applies,
    paidCurrentPeriod: paid,
  };
}

function tenantSummary(tenant, late) {
  return {
    id: tenant.id,
    fullName: tenant.full_name,
    email: tenant.email,
    unitLabel: tenant.unit_label,
    rentAmountCents: tenant.rent_amount_cents,
    dueDay: tenant.due_day,
    // Once caught up, show the upcoming due date; while unpaid, show
    // what's actually due/overdue right now instead of skipping ahead.
    nextDueDate: late.paidCurrentPeriod ? nextDueDate(tenant.due_day) : currentDueDate(tenant.due_day),
    lateFeeCents: late.lateFeeCents,
    lateFeeAfterDay: late.lateFeeAfterDay,
    lateFeeApplies: late.lateFeeApplies,
  };
}

// GET /legacy/api/auth/verify?token=... -- NOT routed through handleApi,
// since it needs to issue a raw redirect + Set-Cookie rather than JSON.
async function handleAuthVerify(request, env, url) {
  const token = url.searchParams.get('token');
  if (!token) {
    return Response.redirect(`${url.origin}/legacy/?error=invalid_link`, 302);
  }

  const row = await env.DB.prepare('SELECT * FROM login_tokens WHERE token = ?').bind(token).first();
  if (!row || row.used_at || new Date(`${row.expires_at}Z`).getTime() < Date.now()) {
    return Response.redirect(`${url.origin}/legacy/?error=expired_link`, 302);
  }

  await env.DB.prepare(`UPDATE login_tokens SET used_at = datetime('now') WHERE token = ?`).bind(token).run();

  const sessionToken = await createSessionToken(env, { type: row.subject_type, subject: row.subject });
  const dest = row.subject_type === 'admin' ? '/legacy/Admin/' : '/legacy/Dashboard/';

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}${dest}`,
      'Set-Cookie': sessionCookieHeader(sessionToken),
    },
  });
}

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/legacy\/api/, '') || '/';

  // ---- Auth ----

  if (path === '/auth/request' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = body.email ? String(body.email).trim().toLowerCase() : '';

    // Always the same response whether or not the email matched, so
    // this endpoint can't be used to enumerate tenant/admin emails.
    if (email) {
      const tenant = await env.DB.prepare(
        'SELECT id FROM tenants WHERE lower(email) = ? AND active = 1'
      ).bind(email).first();
      let subjectType = null;
      let subject = null;
      let sendTo = null;
      if (tenant) {
        subjectType = 'tenant';
        subject = String(tenant.id);
        sendTo = email;
      } else {
        const admin = await env.DB.prepare('SELECT email FROM admins WHERE lower(email) = ?').bind(email).first();
        if (admin) {
          subjectType = 'admin';
          subject = admin.email;
          sendTo = email;
        }
      }

      if (subjectType) {
        const token = randomToken();
        const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString().slice(0, 19);
        await env.DB.prepare(
          `INSERT INTO login_tokens (token, subject_type, subject, expires_at) VALUES (?, ?, ?, ?)`
        ).bind(token, subjectType, subject, expiresAt).run();

        const link = `${url.origin}/legacy/api/auth/verify?token=${token}`;
        await sendEmail(env, {
          to: sendTo,
          subject: 'Sign in to Legacy Property Hub',
          html: `<p>Click below to sign in to Legacy Property Hub. This link expires in 15 minutes and can only be used once.</p>
<p><a href="${link}">Sign in to Legacy Property Hub</a></p>
<p>If you didn't request this, you can safely ignore this email.</p>`,
        });
      }
    }

    return json({ ok: true, message: "If that email is on file, we've sent a sign-in link." });
  }

  if (path === '/auth/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
  }

  if (path === '/me' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return json({ error: 'Not signed in' }, 401);
    if (session.type === 'admin') {
      return json({ type: 'admin', email: session.subject });
    }
    const tenant = await loadTenant(env, session.subject);
    if (!tenant) return json({ error: 'Tenant not found' }, 404);
    const late = await lateFeeInfo(env, tenant);
    return json({ type: 'tenant', tenant: tenantSummary(tenant, late) });
  }

  // ---- Admin-only ----

  if (path === '/tenants' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const tenants = await env.DB.prepare(
      `SELECT t.*,
              (SELECT MAX(paid_at) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'succeeded') AS last_paid_at
       FROM tenants t WHERE t.active = 1 ORDER BY t.full_name`
    ).all();
    const withDetails = [];
    for (const t of tenants.results) {
      const late = await lateFeeInfo(env, t);
      withDetails.push({ ...tenantSummary(t, late), last_paid_at: t.last_paid_at });
    }
    return json({ tenants: withDetails });
  }

  // All maintenance requests across every tenant, for the Admin view.
  if (path === '/maintenance' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const requests = await env.DB.prepare(
      `SELECT m.id, m.description, m.status, m.created_at, m.updated_at,
              t.id AS tenant_id, t.full_name, t.unit_label
       FROM maintenance_requests m
       JOIN tenants t ON t.id = m.tenant_id
       ORDER BY m.created_at DESC`
    ).all();
    return json({ requests: requests.results });
  }

  if (path === '/tenants' && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const body = await request.json().catch(() => ({}));
    const { email, fullName, unitLabel, rentAmountCents, dueDay, lateFeeCents, lateFeeAfterDay } = body;
    if (!email || !fullName || !rentAmountCents || !dueDay) {
      return json({ error: 'email, fullName, rentAmountCents, and dueDay are required' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO tenants (email, full_name, unit_label, rent_amount_cents, due_day, late_fee_cents, late_fee_after_day)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      String(email).toLowerCase(), fullName, unitLabel || null, rentAmountCents, dueDay,
      lateFeeCents || 0, lateFeeAfterDay || null
    ).run();
    return json({ ok: true });
  }

  // ---- Tenant-scoped (own tenant, or admin) ----

  const tenantMatch = path.match(/^\/tenants\/(\d+|me)$/);
  if (tenantMatch && request.method === 'GET') {
    const access = await resolveTenantAccess(request, env, tenantMatch[1]);
    if (access.error) return access.error;
    const tenant = await loadTenant(env, access.tenantId);
    if (!tenant) return json({ error: 'not found' }, 404);
    const late = await lateFeeInfo(env, tenant);
    const payments = await env.DB.prepare(
      `SELECT id, amount_cents, status, period_label, method, created_at, paid_at
       FROM payments WHERE tenant_id = ? ORDER BY created_at DESC`
    ).bind(tenant.id).all();
    return json({ tenant: tenantSummary(tenant, late), payments: payments.results });
  }

  const paymentsMatch = path.match(/^\/tenants\/(\d+|me)\/payments$/);
  if (paymentsMatch && request.method === 'GET') {
    const access = await resolveTenantAccess(request, env, paymentsMatch[1]);
    if (access.error) return access.error;
    const payments = await env.DB.prepare(
      `SELECT id, amount_cents, status, period_label, method, created_at, paid_at
       FROM payments WHERE tenant_id = ? ORDER BY created_at DESC`
    ).bind(access.tenantId).all();
    return json({ payments: payments.results });
  }

  const maintenanceMatch = path.match(/^\/tenants\/(\d+|me)\/maintenance$/);
  if (maintenanceMatch && request.method === 'GET') {
    const access = await resolveTenantAccess(request, env, maintenanceMatch[1]);
    if (access.error) return access.error;
    const requests = await env.DB.prepare(
      `SELECT id, description, status, created_at, updated_at
       FROM maintenance_requests WHERE tenant_id = ? ORDER BY created_at DESC`
    ).bind(access.tenantId).all();
    return json({ requests: requests.results });
  }

  if (maintenanceMatch && request.method === 'POST') {
    const access = await resolveTenantAccess(request, env, maintenanceMatch[1]);
    if (access.error) return access.error;
    const tenant = await loadTenant(env, access.tenantId);
    if (!tenant) return json({ error: 'not found' }, 404);
    const body = await request.json().catch(() => ({}));
    const description = body.description ? String(body.description).trim() : '';
    if (!description) {
      return json({ error: 'description is required' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO maintenance_requests (tenant_id, description) VALUES (?, ?)`
    ).bind(tenant.id, description).run();

    await sendEmail(env, {
      to: 'legacy@facilityhubs.com',
      subject: `Maintenance request - ${tenant.unit_label || tenant.full_name}`,
      replyTo: tenant.email,
      html: `<p><strong>Tenant:</strong> ${escapeHtml(tenant.full_name)}${tenant.unit_label ? ` (${escapeHtml(tenant.unit_label)})` : ''}</p>
<p><strong>Email:</strong> ${escapeHtml(tenant.email)}</p>
<p><strong>Request:</strong></p>
<p>${escapeHtml(description)}</p>`,
    });

    return json({ ok: true });
  }

  const payMatch = path.match(/^\/tenants\/(\d+|me)\/pay$/);
  if (payMatch && request.method === 'POST') {
    const access = await resolveTenantAccess(request, env, payMatch[1]);
    if (access.error) return access.error;
    const tenant = await loadTenant(env, access.tenantId);
    if (!tenant) return json({ error: 'not found' }, 404);
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: 'Payments are not configured yet. Set STRIPE_SECRET_KEY.' }, 503);
    }

    const late = await lateFeeInfo(env, tenant);
    const amountCents = tenant.rent_amount_cents + (late.lateFeeApplies ? late.lateFeeCents : 0);

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'us_bank_account'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Rent - ${tenant.unit_label || tenant.full_name}` + (late.lateFeeApplies ? ' (includes late fee)' : ''),
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      success_url: `${url.origin}/legacy/Payments/?paid=1`,
      cancel_url: `${url.origin}/legacy/Payments/?canceled=1`,
      customer_email: tenant.email,
      metadata: { tenant_id: String(tenant.id) },
    });

    await env.DB.prepare(
      `INSERT INTO payments (tenant_id, amount_cents, status, stripe_checkout_session_id, period_label)
       VALUES (?, ?, 'pending', ?, ?)`
    ).bind(tenant.id, amountCents, session.id, currentPeriodLabel(tenant.due_day)).run();

    return json({ url: session.url });
  }

  return json({ error: 'not found' }, 404);
}

// Stripe webhook -- authenticated by verifying the Stripe-Signature header
// against STRIPE_WEBHOOK_SECRET (unrelated to session auth above; this is
// Stripe calling us, not a signed-in user).
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

    const paid = await env.DB.prepare(
      `SELECT p.amount_cents, p.period_label, t.email, t.full_name, t.unit_label
       FROM payments p JOIN tenants t ON t.id = p.tenant_id
       WHERE p.stripe_checkout_session_id = ?`
    ).bind(session.id).first();
    if (paid && paid.email) {
      const firstName = paid.full_name ? paid.full_name.split(' ')[0] : 'there';
      await sendEmail(env, {
        to: paid.email,
        subject: 'Payment received - Legacy Property Hub',
        html: `<p>Hi ${escapeHtml(firstName)},</p>
<p>We've received your rent payment${paid.unit_label ? ` for ${escapeHtml(paid.unit_label)}` : ''}.</p>
<p><strong>Amount:</strong> $${(paid.amount_cents / 100).toFixed(2)}<br>
<strong>Period:</strong> ${escapeHtml(paid.period_label || '')}</p>
<p>Thank you,<br>Legacy Property Hub</p>`,
      });
    }
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
    if (url.pathname === '/legacy/api/auth/verify' && request.method === 'GET') {
      return handleAuthVerify(request, env, url);
    }
    if (url.pathname.startsWith('/legacy/api/')) {
      return handleApi(request, env, url);
    }

    // Everything else under /legacy/* is a static asset (HTML/CSS/JS).
    return env.ASSETS.fetch(request);
  },
};
