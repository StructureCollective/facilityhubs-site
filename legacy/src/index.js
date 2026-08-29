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
import { generateReceiptPdf } from './lib/pdf.js';

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  // A plain object can only hold one value per key, but a response
  // sometimes needs two Set-Cookie headers at once (e.g. swapping the
  // session cookie while also stashing one to restore later) -- pass an
  // array for those, everything else stays a single string as before.
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
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
export async function sendEmail(env, { to, subject, html, replyTo }) {
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
// Shared HTML email styling -- a branded shell (logo header + a
// signature footer with the logo again) and a pill-style button, both
// matching the app's own navy/gold look. Every outgoing email's body
// gets wrapped in emailShell(); emailButton() builds the CTA link for
// ones that need it (currently just the sign-in link and, when there's
// a receipt, the payment confirmation).
// ---------------------------------------------------------------------

// Icon-only mark (transparent background, navy building + gold accents)
// for the header -- a wide navy/gold text lockup wouldn't read well at
// header size, and its navy pixels would nearly vanish on a navy bar
// (which is why the header below is white, not navy, with a gold
// accent border instead). The full logo (icon + "LEGACY PROPERTY HUB"
// wordmark) is used for the signature at the bottom instead.
const EMAIL_ICON_URL = 'https://facilityhubs.com/assets/legacy-icon.png';
const EMAIL_LOGO_URL = 'https://facilityhubs.com/assets/legacy-logo.png';
// Used to build the absolute receipt-PDF link in paymentReceivedEmailBody()
// below -- an emailed link needs a full URL, not a relative path.
const SITE_ORIGIN = 'https://facilityhubs.com';

export function emailShell(bodyHtml) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;">
<div style="background:#ffffff;padding:20px 24px;text-align:center;border:1px solid #d7dbe3;border-bottom:3px solid #d4a62a;border-radius:14px 14px 0 0;">
<img src="${EMAIL_ICON_URL}" alt="Legacy Property Hub" style="height:60px;display:block;margin:0 auto;">
</div>
<div style="background:#ffffff;padding:28px 26px;border:1px solid #d7dbe3;border-top:none;border-radius:0 0 14px 14px;color:#12192b;font-size:15px;line-height:1.6;">
${bodyHtml}
<div style="margin-top:28px;padding-top:20px;border-top:1px solid #d7dbe3;text-align:center;">
<img src="${EMAIL_LOGO_URL}" alt="Legacy Property Hub" style="height:38px;display:block;margin:0 auto 10px;">
<div style="color:#5b6478;font-size:12px;font-style:italic;">Property with Purpose. Value for Generations.</div>
</div>
</div>
</div>`;
}

export function emailButton(url, label) {
  return `<div style="text-align:center;margin:22px 0;">
<a href="${url}" style="display:inline-block;background:#0d2b5c;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:999px;font-size:15px;">${label}</a>
</div>`;
}

// The 3 outgoing email bodies below are pulled out as their own named,
// exported functions (rather than inline template literals at each
// sendEmail() call site) so a standalone test script can import and
// render the exact real templates -- see scripts/send-test-email.js.

export function signInEmailBody(link) {
  return emailShell(`<p>Click below to sign in to Legacy Property Hub. This link expires in 15 minutes and can only be used once.</p>
${emailButton(link, 'Sign in to Legacy Property Hub')}
<p style="color:#5b6478;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`);
}

// Sent by an admin from a tenant's Admin detail page (the "Send
// Onboarding Email" button -- see POST /tenants/:id/send-onboarding-email
// below), not automatically on tenant creation, so it can be timed to
// whenever the admin actually wants to introduce the portal.
export function onboardingEmailBody({ tenant }) {
  const firstName = tenant.full_name ? tenant.full_name.split(' ')[0] : 'there';
  const portalUrl = `${SITE_ORIGIN}/legacy/`;
  return emailShell(`<p>Hi ${escapeHtml(firstName)},</p>
<p>Welcome to Legacy Property Hub${tenant.unit_label ? ` for ${escapeHtml(tenant.unit_label)}` : ''} -- your online portal for rent and maintenance.</p>
<p><strong>Signing in</strong><br>
There's no password to remember. Enter your email at the portal and we'll send you a one-time sign-in link -- click it and you're in.</p>
<div style="background:#f6f7fa;border:1px solid #d7dbe3;border-radius:10px;padding:16px 18px;margin:18px 0;">
<p style="margin:0 0 8px;"><strong>What you can do there:</strong></p>
<p style="margin:0 0 6px;">&bull; Pay rent online by card or bank transfer</p>
<p style="margin:0 0 6px;">&bull; View your payment history and download receipts anytime</p>
<p style="margin:0;">&bull; Submit and track maintenance requests</p>
</div>
${emailButton(portalUrl, 'Go to Tenant Portal')}
<p style="color:#5b6478;font-size:13px;">Sign in anytime with ${escapeHtml(tenant.email)} -- the email address your account is registered to.</p>
<p>Welcome aboard,<br>Legacy Property Hub</p>`);
}

export function maintenanceRequestEmailBody({ tenant, issueType, issueStartedOn, description }) {
  return emailShell(`<p><strong>Tenant:</strong> ${escapeHtml(tenant.full_name)}${tenant.unit_label ? ` (${escapeHtml(tenant.unit_label)})` : ''}</p>
<p><strong>Email:</strong> ${escapeHtml(tenant.email)}</p>
<p><strong>Type:</strong> ${escapeHtml(issueType)}</p>
${issueStartedOn ? `<p><strong>Issue started:</strong> ${escapeHtml(issueStartedOn)}</p>` : ''}
<p><strong>Request:</strong></p>
<p>${escapeHtml(description)}</p>`);
}

export function paymentReceivedEmailBody(paid) {
  const firstName = paid.full_name ? paid.full_name.split(' ')[0] : 'there';
  // Our own generated PDF (see src/lib/pdf.js), not Stripe's hosted
  // receipt page -- that page turned out not to offer a real "download
  // PDF" button for a plain charge, only Stripe's own Invoicing feature
  // does. Always included here (unlike the old receipt_url, which
  // depended on a Stripe API round-trip finishing before this email
  // sent) since it's generated fresh on demand whenever it's clicked,
  // straight from this payment's own row -- nothing to wait on.
  const receiptUrl = `${SITE_ORIGIN}/legacy/api/tenants/${paid.tenant_id}/payments/${paid.id}/receipt.pdf`;
  return emailShell(`<p>Hi ${escapeHtml(firstName)},</p>
<p>We've received your rent payment${paid.unit_label ? ` for ${escapeHtml(paid.unit_label)}` : ''}.</p>
<p><strong>Amount:</strong> $${(paid.amount_cents / 100).toFixed(2)}<br>
<strong>Period:</strong> ${escapeHtml(paid.period_label || '')}</p>
${emailButton(receiptUrl, 'View / download receipt (PDF)')}
<p style="color:#5b6478;font-size:13px;">Opening this link requires being signed in to Legacy Property Hub.</p>
<p>Thank you,<br>Legacy Property Hub</p>`);
}

// Internal-only admin notice, sent to legacy@facilityhubs.com alongside
// paymentReceivedEmailBody() above -- not shown to the tenant.
export function paymentReceivedAdminEmailBody(paid) {
  return emailShell(`<p><strong>Tenant:</strong> ${escapeHtml(paid.full_name || 'Unknown')}${paid.unit_label ? ` (${escapeHtml(paid.unit_label)})` : ''}</p>
<p><strong>Amount:</strong> $${(paid.amount_cents / 100).toFixed(2)}<br>
<strong>Period:</strong> ${escapeHtml(paid.period_label || '')}</p>
${emailButton('https://facilityhubs.com/legacy/Admin/', 'View in Admin Dashboard')}`);
}

// ---------------------------------------------------------------------
// Auth: magic-link tokens + signed session cookies.
// ---------------------------------------------------------------------

const SESSION_COOKIE = 'legacy_session';
// Holds the admin's own session token while they're viewing a tenant's
// portal (see /tenants/:id/view-as and /auth/return-to-admin below), so
// "Back to Admin" can restore it exactly rather than requiring another
// sign-in.
const ADMIN_RETURN_COOKIE = 'legacy_admin_return';
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
// the admin's email. `impersonatedBy` (an admin's email) is set only
// when this is a tenant session an admin created via "View Tenant
// Portal" -- it's how the tenant-facing pages know to show a "Back to
// Admin" banner instead of treating this as a real tenant sign-in.
async function createSessionToken(env, { type, subject, impersonatedBy }) {
  const key = sessionSecretKey(env);
  return new SignJWT({ type, subject, ...(impersonatedBy ? { impersonatedBy } : {}) })
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

function adminReturnCookieHeader(token) {
  return `${ADMIN_RETURN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearAdminReturnCookieHeader() {
  return `${ADMIN_RETURN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
    return { type: payload.type, subject: payload.subject, impersonatedBy: payload.impersonatedBy || null };
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

// One-time fees an admin has added for this tenant that haven't been
// charged yet -- a custom label + amount, kept entirely separate from
// the recurring late fee (which fires automatically past a
// day-of-month cutoff rather than being added by hand).
async function pendingFeesFor(env, tenantId) {
  const rows = await env.DB.prepare(
    `SELECT id, label, amount_cents FROM tenant_fees WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at`
  ).bind(tenantId).all();
  return rows.results;
}

function tenantSummary(tenant, late, extraFees = []) {
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
    // Drives the Admin Status pill (Current/Late) -- this was previously
    // computed internally above but never actually included in the
    // response, so the pill always fell back to "Late" regardless of
    // whether the tenant had paid.
    paidCurrentPeriod: late.paidCurrentPeriod,
    lateFeeCents: late.lateFeeCents,
    lateFeeAfterDay: late.lateFeeAfterDay,
    lateFeeApplies: late.lateFeeApplies,
    // Admin-added one-time fees, still unpaid -- separate from the late
    // fee above. Included in the amount charged on the next payment.
    extraFees: extraFees.map((f) => ({ id: f.id, label: f.label, amountCents: f.amount_cents })),
    extraFeesCents: extraFees.reduce((sum, f) => sum + f.amount_cents, 0),
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
          html: signInEmailBody(link),
        });
      }
    }

    return json({ ok: true, message: "If that email is on file, we've sent a sign-in link." });
  }

  if (path === '/auth/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, {
      'Set-Cookie': [clearSessionCookieHeader(), clearAdminReturnCookieHeader()],
    });
  }

  // Ends an admin's "View Tenant Portal" preview -- swaps the session
  // cookie back to the admin session stashed by /tenants/:id/view-as,
  // after re-verifying it's still a valid, unexpired admin session
  // rather than trusting the stashed cookie blindly.
  if (path === '/auth/return-to-admin' && request.method === 'POST') {
    const stashed = readCookie(request, ADMIN_RETURN_COOKIE);
    if (!stashed) return json({ error: 'No admin session to return to' }, 400);

    try {
      const key = sessionSecretKey(env);
      const { payload } = await jwtVerify(stashed, key);
      if (!payload || payload.type !== 'admin') throw new Error('not an admin session');
    } catch (err) {
      return json({ error: 'Your admin session has expired. Please sign in again.' }, 401, {
        'Set-Cookie': [clearSessionCookieHeader(), clearAdminReturnCookieHeader()],
      });
    }

    return json({ ok: true }, 200, {
      'Set-Cookie': [sessionCookieHeader(stashed), clearAdminReturnCookieHeader()],
    });
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
    const extraFees = await pendingFeesFor(env, tenant.id);
    return json({ type: 'tenant', tenant: tenantSummary(tenant, late, extraFees) });
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
      `SELECT m.id, m.issue_type, m.issue_started_on, m.description, m.status, m.created_at, m.updated_at,
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

  // Update a tenant's rent amount / late fee. Takes effect immediately on
  // their *upcoming* payment (the amount is read fresh from `tenants` each
  // time a PaymentIntent is created) -- it never rewrites already-recorded
  // `payments` rows, so past history stays exactly as it was. The frontend
  // gates this behind two confirmation prompts before it ever calls this;
  // the endpoint itself still validates independently.
  const rentMatch = path.match(/^\/tenants\/(\d+)\/rent$/);
  if (rentMatch && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const tenantId = rentMatch[1];
    const tenant = await loadTenant(env, tenantId);
    if (!tenant) return json({ error: 'Tenant not found' }, 404);

    const body = await request.json().catch(() => ({}));
    const { rentAmountCents, lateFeeCents, lateFeeAfterDay } = body;

    if (!Number.isInteger(rentAmountCents) || rentAmountCents <= 0) {
      return json({ error: 'rentAmountCents must be a positive whole number of cents' }, 400);
    }
    if (lateFeeCents != null && (!Number.isInteger(lateFeeCents) || lateFeeCents < 0)) {
      return json({ error: 'lateFeeCents must be a non-negative whole number of cents' }, 400);
    }
    if (lateFeeAfterDay != null && (!Number.isInteger(lateFeeAfterDay) || lateFeeAfterDay < 1 || lateFeeAfterDay > 28)) {
      return json({ error: 'lateFeeAfterDay must be a day of month between 1 and 28' }, 400);
    }

    await env.DB.prepare(
      `UPDATE tenants SET rent_amount_cents = ?, late_fee_cents = ?, late_fee_after_day = ? WHERE id = ?`
    ).bind(rentAmountCents, lateFeeCents || 0, lateFeeAfterDay || null, tenantId).run();

    return json({ ok: true });
  }

  // Add a one-time fee for a tenant -- a custom label + amount, entirely
  // separate from the recurring late fee above. It's included in the
  // total the next time this tenant pays (see the /pay handler below),
  // then marked 'applied' once that payment succeeds -- never charged
  // twice, never touching already-recorded payments. The frontend gates
  // this behind two confirmation prompts before it ever calls here.
  const addFeeMatch = path.match(/^\/tenants\/(\d+)\/fees$/);
  if (addFeeMatch && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const tenantId = addFeeMatch[1];
    const tenant = await loadTenant(env, tenantId);
    if (!tenant) return json({ error: 'Tenant not found' }, 404);

    const body = await request.json().catch(() => ({}));
    const label = body.label ? String(body.label).trim() : '';
    const amountCents = body.amountCents;

    if (!label || label.length > 80) {
      return json({ error: 'label is required (80 characters or fewer)' }, 400);
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return json({ error: 'amountCents must be a positive whole number of cents' }, 400);
    }

    await env.DB.prepare(
      `INSERT INTO tenant_fees (tenant_id, label, amount_cents) VALUES (?, ?, ?)`
    ).bind(tenantId, label, amountCents).run();

    return json({ ok: true });
  }

  // Remove a fee before it's been charged -- e.g. it was added by
  // mistake. Only ever touches a still-'pending' row; once a fee has
  // been applied to a real payment it's part of that payment's history
  // and this can no longer remove it.
  const removeFeeMatch = path.match(/^\/tenants\/(\d+)\/fees\/(\d+)$/);
  if (removeFeeMatch && request.method === 'DELETE') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const [, tenantId, feeId] = removeFeeMatch;
    const result = await env.DB.prepare(
      `DELETE FROM tenant_fees WHERE id = ? AND tenant_id = ? AND status = 'pending'`
    ).bind(feeId, tenantId).run();
    if (!result.meta.changes) {
      return json({ error: 'Fee not found, or it has already been charged' }, 404);
    }
    return json({ ok: true });
  }

  // Sends the branded "how the portal works" onboarding email -- the
  // "Send Onboarding Email" button on a tenant's Admin detail page.
  // Defaults to the tenant's email on file, but an admin can send it to
  // a different address instead (e.g. before the tenant's account email
  // is finalized).
  const onboardingMatch = path.match(/^\/tenants\/(\d+)\/send-onboarding-email$/);
  if (onboardingMatch && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const tenantId = onboardingMatch[1];
    const tenant = await loadTenant(env, tenantId);
    if (!tenant) return json({ error: 'Tenant not found' }, 404);

    const body = await request.json().catch(() => ({}));
    const to = String(body.email || tenant.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return json({ error: 'Enter a valid email address.' }, 400);
    }

    await sendEmail(env, {
      to,
      subject: 'Legacy Property Hub | Onboarding',
      html: onboardingEmailBody({ tenant }),
    });

    return json({ ok: true, sentTo: to });
  }

  // Lets an admin see a tenant's own portal (Dashboard/Payments/
  // Maintenance/Documents) exactly as that tenant sees it -- there's no
  // password to borrow, so this issues a real tenant session for them,
  // while stashing the admin's own session in a second cookie so
  // /auth/return-to-admin ("Back to Admin" in the tenant-facing pages)
  // can restore it precisely, without another sign-in.
  const viewAsMatch = path.match(/^\/tenants\/(\d+)\/view-as$/);
  if (viewAsMatch && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!requireAdmin(session)) return json({ error: 'Forbidden' }, 403);

    const tenantId = viewAsMatch[1];
    const tenant = await loadTenant(env, tenantId);
    if (!tenant) return json({ error: 'Tenant not found' }, 404);

    const adminToken = readCookie(request, SESSION_COOKIE);
    const tenantToken = await createSessionToken(env, {
      type: 'tenant', subject: tenantId, impersonatedBy: session.subject,
    });

    return json({ ok: true }, 200, {
      'Set-Cookie': [sessionCookieHeader(tenantToken), adminReturnCookieHeader(adminToken)],
    });
  }

  // ---- Tenant-scoped (own tenant, or admin) ----

  const tenantMatch = path.match(/^\/tenants\/(\d+|me)$/);
  if (tenantMatch && request.method === 'GET') {
    const access = await resolveTenantAccess(request, env, tenantMatch[1]);
    if (access.error) return access.error;
    const tenant = await loadTenant(env, access.tenantId);
    if (!tenant) return json({ error: 'not found' }, 404);
    const late = await lateFeeInfo(env, tenant);
    const extraFees = await pendingFeesFor(env, tenant.id);
    // Most recent first -- paid_at (when a payment actually completed)
    // takes priority over created_at (when the row was first inserted,
    // e.g. by the pending PaymentIntent), since those can differ, and
    // COALESCE falls back to created_at for a payment that hasn't
    // completed yet (paid_at is still NULL).
    const payments = await env.DB.prepare(
      `SELECT id, amount_cents, status, period_label, method, receipt_url, created_at, paid_at
       FROM payments WHERE tenant_id = ? ORDER BY COALESCE(paid_at, created_at) DESC`
    ).bind(tenant.id).all();
    return json({
      tenant: tenantSummary(tenant, late, extraFees),
      payments: payments.results,
      impersonating: !!access.session.impersonatedBy,
    });
  }

  const paymentsMatch = path.match(/^\/tenants\/(\d+|me)\/payments$/);
  if (paymentsMatch && request.method === 'GET') {
    const access = await resolveTenantAccess(request, env, paymentsMatch[1]);
    if (access.error) return access.error;
    const payments = await env.DB.prepare(
      `SELECT id, amount_cents, status, period_label, method, receipt_url, created_at, paid_at
       FROM payments WHERE tenant_id = ? ORDER BY COALESCE(paid_at, created_at) DESC`
    ).bind(access.tenantId).all();
    return json({ payments: payments.results });
  }

  // GET .../payments/:paymentId/receipt.pdf -- a real, self-generated PDF
  // receipt (see src/lib/pdf.js), gated the same way as every other tenant
  // route: a tenant can only reach their own payments, an admin any. Works
  // for both a Stripe-collected payment and a manually-recorded ('direct')
  // one -- unlike the old Stripe receipt_url, which only ever existed for
  // Stripe payments and turned out not to offer a real PDF download anyway.
  const receiptMatch = path.match(/^\/tenants\/(\d+|me)\/payments\/(\d+)\/receipt\.pdf$/);
  if (receiptMatch && request.method === 'GET') {
    const access = await resolveTenantAccess(request, env, receiptMatch[1]);
    if (access.error) return access.error;
    const payment = await env.DB.prepare(
      `SELECT p.id, p.amount_cents, p.status, p.period_label, p.method, p.paid_at,
              p.rent_amount_cents, p.late_fee_cents, t.full_name, t.unit_label
       FROM payments p JOIN tenants t ON t.id = p.tenant_id
       WHERE p.id = ? AND p.tenant_id = ?`
    ).bind(receiptMatch[2], access.tenantId).first();
    if (!payment) return json({ error: 'Not found' }, 404);
    if (payment.status !== 'succeeded') {
      return json({ error: 'A receipt is only available for a succeeded payment.' }, 400);
    }
    // One-time fees included in this specific payment -- linked via
    // applied_payment_id when the webhook marked them applied (see
    // handleStripeWebhook above). Works for old payments too, since this
    // link has existed since tenant_fees was added.
    const feeItems = await env.DB.prepare(
      `SELECT label, amount_cents FROM tenant_fees WHERE applied_payment_id = ? ORDER BY created_at`
    ).bind(payment.id).all();
    const pdfBytes = await generateReceiptPdf(payment, feeItems.results, { env, request });
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="legacy-property-hub-receipt-${payment.id}.pdf"`,
      },
    });
  }

  const maintenanceMatch = path.match(/^\/tenants\/(\d+|me)\/maintenance$/);
  if (maintenanceMatch && request.method === 'GET') {
    const access = await resolveTenantAccess(request, env, maintenanceMatch[1]);
    if (access.error) return access.error;
    const requests = await env.DB.prepare(
      `SELECT id, issue_type, issue_started_on, description, status, created_at, updated_at
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
    const issueType = body.issueType ? String(body.issueType).trim() : '';
    // Optional -- a tenant may not know exactly when an issue started.
    // Expected as YYYY-MM-DD (an HTML date input's native value); stored
    // as-is rather than parsed, since it's just a label, not used in any
    // date math.
    const issueStartedOn = body.issueStartedOn ? String(body.issueStartedOn).trim() : null;
    if (!description || !issueType) {
      return json({ error: 'issueType and description are required' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO maintenance_requests (tenant_id, issue_type, issue_started_on, description) VALUES (?, ?, ?, ?)`
    ).bind(tenant.id, issueType, issueStartedOn, description).run();

    await sendEmail(env, {
      to: 'legacy@facilityhubs.com',
      subject: `Maintenance request - ${tenant.unit_label || tenant.full_name}`,
      replyTo: tenant.email,
      html: maintenanceRequestEmailBody({ tenant, issueType, issueStartedOn, description }),
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
    const extraFees = await pendingFeesFor(env, tenant.id);
    const extraFeesCents = extraFees.reduce((sum, f) => sum + f.amount_cents, 0);
    const amountCents = tenant.rent_amount_cents + (late.lateFeeApplies ? late.lateFeeCents : 0) + extraFeesCents;
    const periodLabel = currentPeriodLabel(tenant.due_day);

    const descriptionParts = [`Rent - ${tenant.unit_label || tenant.full_name}`];
    if (late.lateFeeApplies) descriptionParts.push('includes late fee');
    if (extraFees.length) descriptionParts.push(extraFees.map((f) => f.label).join(', '));

    // Embedded custom checkout (Stripe Elements' Payment Element) rather
    // than a redirect to a Stripe-hosted Checkout page -- the client
    // mounts the Payment Element using this PaymentIntent's client
    // secret and submits it in place on the Payments page.
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      // No receipt_email here on purpose -- setting it makes Stripe send
      // its own separate automatic receipt in live mode, regardless of
      // any Dashboard email setting. We only want the one branded email
      // this app sends (which links to this app's own generated PDF
      // receipt -- see generateReceiptPdf() in src/lib/pdf.js).
      description: descriptionParts.join(' + '),
      // fee_ids lets the webhook mark exactly the fees included in THIS
      // charge as applied once it succeeds -- not any fee added after.
      // rent_amount_cents/late_fee_cents ride along too because no
      // payments row exists yet to hold them -- the webhook creates the
      // row (see handleStripeWebhook) only once the payment actually
      // succeeds, so there's nothing left behind to clean up if the
      // tenant abandons the attempt.
      metadata: {
        tenant_id: String(tenant.id),
        period_label: periodLabel,
        fee_ids: extraFees.map((f) => f.id).join(','),
        rent_amount_cents: String(tenant.rent_amount_cents),
        late_fee_cents: String(late.lateFeeApplies ? late.lateFeeCents : 0),
      },
    });

    return json({ clientSecret: paymentIntent.client_secret });
  }

  // Publishable keys are meant to be public -- safe to hand to any
  // caller, signed in or not. The Payments page fetches this to
  // initialize Stripe.js before mounting the Payment Element.
  if (path === '/stripe/config' && request.method === 'GET') {
    return json({ publishableKey: env.STRIPE_PUBLISHABLE_KEY || null });
  }

  return json({ error: 'not found' }, 404);
}

// Looks up Stripe's own hosted receipt page for a charge -- stored on the
// payment row for reference only; the app's actual "View / download" link
// and the confirmation email use generateReceiptPdf() (src/lib/pdf.js)
// instead, since this page doesn't offer a real PDF download for a plain
// charge (that's an Invoicing-only Stripe feature). `chargeId` is a
// PaymentIntent's `latest_charge` -- a plain string ID on Stripe API
// versions from late 2022 on (this app pins stripe@^17, which defaults to
// a current API version), not an expanded object.
async function fetchReceiptUrl(env, chargeId) {
  if (!chargeId || !env.STRIPE_SECRET_KEY) return null;
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const charge = await stripe.charges.retrieve(chargeId);
    return charge.receipt_url || null;
  } catch (err) {
    console.error('fetchReceiptUrl: could not retrieve charge', chargeId, err);
    return null;
  }
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

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const meta = pi.metadata || {};
    const tenantId = meta.tenant_id ? Number(meta.tenant_id) : null;

    if (!tenantId) {
      console.error('payment_intent.succeeded missing tenant_id metadata', pi.id);
      return json({ received: true });
    }

    // Stripe's hosted, downloadable PDF receipt for this charge -- not
    // present on the PaymentIntent itself, only on its Charge.
    const receiptUrl = await fetchReceiptUrl(env, pi.latest_charge);

    // The payments row is created HERE, on success -- not back when the
    // PaymentIntent was first created (see the /pay route above). That's
    // deliberate: there's no more "pending" row for an abandoned or
    // never-finished attempt to leave behind, so nothing needs sweeping
    // up later. Stripe can redeliver this webhook, so INSERT OR IGNORE
    // plus the unique index on stripe_payment_intent_id (schema.sql)
    // makes a redelivery a no-op instead of a duplicate payment.
    const insert = await env.DB.prepare(
      `INSERT OR IGNORE INTO payments
         (tenant_id, amount_cents, status, period_label, rent_amount_cents, late_fee_cents, stripe_payment_intent_id, receipt_url, paid_at)
       VALUES (?, ?, 'succeeded', ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      tenantId,
      pi.amount,
      meta.period_label || null,
      meta.rent_amount_cents != null ? Number(meta.rent_amount_cents) : null,
      meta.late_fee_cents != null ? Number(meta.late_fee_cents) : null,
      pi.id,
      receiptUrl
    ).run();
    const isNewPayment = !!(insert.meta && insert.meta.changes > 0);

    const paid = await env.DB.prepare(
      `SELECT p.id, p.tenant_id, p.amount_cents, p.period_label, p.receipt_url, t.email, t.full_name, t.unit_label
       FROM payments p JOIN tenants t ON t.id = p.tenant_id
       WHERE p.stripe_payment_intent_id = ?`
    ).bind(pi.id).first();

    // Only act on a genuinely new payment -- a redelivered webhook for
    // one already recorded would otherwise re-apply fees (harmless,
    // since that update is itself guarded on status = 'pending') and
    // re-send both emails (not harmless).
    if (paid && isNewPayment) {
      // Mark exactly the one-time fees that were included in this
      // charge (recorded on the PaymentIntent's metadata when it was
      // created) as applied, now that it's actually succeeded -- never
      // before then, so an abandoned attempt leaves the fee pending for
      // next time.
      const feeIds = meta.fee_ids
        ? meta.fee_ids.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      for (const feeId of feeIds) {
        await env.DB.prepare(
          `UPDATE tenant_fees SET status = 'applied', applied_at = datetime('now'), applied_payment_id = ?
           WHERE id = ? AND status = 'pending'`
        ).bind(paid.id, feeId).run();
      }

      if (paid.email) {
        await sendEmail(env, {
          to: paid.email,
          subject: 'Payment received - Legacy Property Hub',
          html: paymentReceivedEmailBody(paid),
        });
      }

      // Admin heads-up -- separate from the tenant confirmation above,
      // and not gated on paid.email since it doesn't need the tenant's
      // address.
      await sendEmail(env, {
        to: 'legacy@facilityhubs.com',
        subject: `Payment received - ${paid.unit_label || paid.full_name || 'Tenant'}`,
        html: paymentReceivedAdminEmailBody(paid),
      });
    }
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
