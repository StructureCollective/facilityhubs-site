/*
 * Facility Hubs -- site forms worker.
 *
 * ---------------------------------------------------------------------
 * Handles three endpoints on facilityhubs.com, all via Resend, all sent
 * from support@facilityhubs.com (Resend's domain verification for
 * facilityhubs.com covers any address at that domain, so this and
 * legacy/src/index.js's magic-link email can share the same
 * RESEND_API_KEY *value* -- though each worker still needs its own
 * `wrangler secret put RESEND_API_KEY`, since Cloudflare Workers don't
 * share secrets across separate worker projects):
 *
 *   POST /api/onboarding-inquiry/submit  (get-started.html)
 *     -> one email to admin@structurecollective.com, AND a branded
 *        confirmation email back to whoever submitted the form.
 *
 *   POST /api/support-request/submit  (support.html)
 *     -> one email to admin@structurecollective.com, AND a branded
 *        confirmation email back to whoever submitted the form.
 *
 *   POST /api/rating/submit  (rate.html, a hidden landing page reached
 *     only via a link in the rating-request email template --
 *     emails/rating-request-email.html -- never linked from site nav)
 *     -> one email to admin@structurecollective.com with the 1-5 star
 *        score and any optional comment. No confirmation email back --
 *        rate.html itself shows the thank-you state.
 *
 * Unlike legacy's sendEmail(), which quietly no-ops without a
 * RESEND_API_KEY (fine there -- it's a side-effect on top of a payment
 * or maintenance request that already succeeded), a missing key or a
 * failed *admin* send here is the ENTIRE point of the request, so both
 * are surfaced as real error responses instead of being swallowed.
 * Losing an inquiry, support request, or rating silently would be worse
 * than showing the visitor an error. Each handler's confirmation email
 * back to the visitor (where one exists) is the exception -- best
 * effort, logged but non-fatal, since the admin's already been
 * notified by the time it's attempted. See each handle*() function.
 * ---------------------------------------------------------------------
 */

const ADMIN_TO = 'admin@structurecollective.com';
const FROM = 'Facility Hubs <support@facilityhubs.com>';

// Absolute URL -- email clients don't resolve relative paths, and have
// no notion of "this site's own origin" the way a browser does.
const EMAIL_LOGO_URL = 'https://facilityhubs.com/assets/facility-hubs-logo.png';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function escapeHtml(v) {
  return String(v).replace(/[&<>'"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]
  ));
}

// Strips newlines/control characters so a crafted field value can't
// inject extra headers into the outgoing email (e.g. via "subject" or
// "reply_to", both built from user input below).
function singleLine(v, maxLen) {
  return String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

// ---------------------------------------------------------------------
// Shared branded email shell -- Facility Hubs' own navy/teal/blue/
// orange palette (matching index.html/about.html/get-started.html),
// with the full wordmark logo in the header. Every outgoing email from
// this worker is wrapped in emailShell(); emailButton() builds a CTA
// pill for ones that need it.
// ---------------------------------------------------------------------

function emailShell(bodyHtml) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;">
<div style="background:#ffffff;padding:22px 24px;text-align:center;border:1px solid #e2e7f0;border-bottom:3px solid #1fa9ae;border-radius:14px 14px 0 0;">
<img src="${EMAIL_LOGO_URL}" alt="Facility Hubs" style="height:40px;display:block;margin:0 auto;">
</div>
<div style="background:#ffffff;padding:28px 28px;border:1px solid #e2e7f0;border-top:none;border-radius:0 0 14px 14px;color:#0d1b3b;font-size:15px;line-height:1.6;">
${bodyHtml}
<div style="margin-top:26px;padding-top:18px;border-top:1px solid #e2e7f0;text-align:center;color:#8b95ab;font-size:12px;">
Facility Hubs &middot; <a href="mailto:support@facilityhubs.com" style="color:#8b95ab;">support@facilityhubs.com</a>
</div>
</div>
</div>`;
}

function emailButton(url, label) {
  return `<div style="text-align:center;margin:22px 0;">
<a href="${url}" style="display:inline-block;background:#0a2b70;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:999px;font-size:15px;">${label}</a>
</div>`;
}

function fieldRowsHtml(rows) {
  return rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 14px 8px 0;color:#5b6b8c;font-weight:700;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#0d1b3b;font-size:14.5px;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>
  `).join('');
}

async function sendResendEmail(env, { to, replyTo, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend responded ${res.status}: ${detail}`);
  }
}

// =======================================================================
// Onboarding inquiry (get-started.html)
// =======================================================================

const INQUIRY_MAX = {
  name: 200, business: 200, email: 320, phone: 60, teamSize: 20, message: 5000,
};

function validateInquiry(body) {
  const errors = [];
  const name = singleLine(body.name, INQUIRY_MAX.name);
  const business = singleLine(body.business, INQUIRY_MAX.business);
  const email = singleLine(body.email, INQUIRY_MAX.email);
  const phone = singleLine(body.phone, INQUIRY_MAX.phone);
  const teamSize = singleLine(body.teamSize, INQUIRY_MAX.teamSize);
  const message = String(body.message || '').trim().slice(0, INQUIRY_MAX.message);
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.map((c) => singleLine(c, 120)).filter(Boolean).slice(0, 16)
    : [];

  if (!name) errors.push('name is required');
  if (!business) errors.push('business is required');
  if (!email || !EMAIL_RE.test(email)) errors.push('a valid email is required');
  if (!message) errors.push('message is required');

  return { errors, data: { name, business, email, phone, teamSize, message, capabilities } };
}

function inquiryAdminEmailBody(d) {
  const rowsHtml = fieldRowsHtml([
    ['Name', d.name],
    ['Business', d.business],
    ['Email', d.email],
    ['Phone', d.phone || '—'],
    ['Team size', d.teamSize || '—'],
  ]);

  const capabilitiesHtml = d.capabilities.length
    ? `<tr>
         <td style="padding:8px 14px 8px 0;color:#5b6b8c;font-weight:700;font-size:13px;white-space:nowrap;vertical-align:top;">Wants</td>
         <td style="padding:8px 0;color:#0d1b3b;font-size:14.5px;vertical-align:top;">${d.capabilities.map(escapeHtml).join('<br>')}</td>
       </tr>`
    : '';

  return emailShell(`
<p style="margin:0 0 18px;font-weight:800;color:#0a2b70;font-size:17px;">New onboarding inquiry</p>
<table role="presentation" style="border-collapse:collapse;width:100%;">${rowsHtml}${capabilitiesHtml}</table>
<div style="margin-top:18px;padding-top:18px;border-top:1px solid #e2e7f0;">
<div style="color:#5b6b8c;font-weight:700;font-size:13px;margin-bottom:6px;">Message</div>
<div style="font-size:14.5px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(d.message)}</div>
</div>
<p style="color:#8b95ab;font-size:12px;margin-top:16px;">Submitted from the Get Started form on facilityhubs.com. Reply to this email to respond directly to ${escapeHtml(d.name)}.</p>
`);
}

function inquiryConfirmationEmailBody(d) {
  const firstName = d.name.split(' ')[0] || d.name;
  return emailShell(`
<p>Hi ${escapeHtml(firstName)},</p>
<p>Thanks for your interest in Facility Hubs! We've received your inquiry and will follow up at this email address to talk through what your Facility Hub could look like.</p>
<div style="background:#f5f8ff;border:1px solid #e2e7f0;border-radius:10px;padding:16px 18px;margin:18px 0;">
<p style="margin:0 0 6px;"><strong>Business:</strong> ${escapeHtml(d.business)}</p>
${d.phone ? `<p style="margin:0 0 6px;"><strong>Phone:</strong> ${escapeHtml(d.phone)}</p>` : ''}
${d.teamSize ? `<p style="margin:0 0 6px;"><strong>Team size:</strong> ${escapeHtml(d.teamSize)}</p>` : ''}
<p style="margin:0;white-space:pre-wrap;">${escapeHtml(d.message)}</p>
</div>
<p style="color:#5b6b8c;font-size:13px;">If anything above isn't right, just reply to this email and let us know.</p>
<p style="margin-top:22px;">&mdash; Facility Hubs</p>
`);
}

async function handleOnboardingInquiry(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  // Honeypot: a hidden field real visitors never see or fill. A
  // non-empty value means a bot filled every field it could find --
  // report success so it moves on, but never actually send the email.
  if (body && typeof body.website === 'string' && body.website.trim()) {
    return json({ ok: true });
  }

  const { errors, data } = validateInquiry(body || {});
  if (errors.length) {
    return json({ ok: false, error: errors.join('; ') }, 400);
  }

  if (!env.RESEND_API_KEY) {
    console.error('Onboarding inquiry received but RESEND_API_KEY is not set.');
    return json({ ok: false, error: 'email sending is not configured yet' }, 503);
  }

  // The admin notification is the critical path -- fail loudly if it
  // doesn't go out.
  try {
    await sendResendEmail(env, {
      to: ADMIN_TO,
      replyTo: data.email,
      subject: `New onboarding inquiry — ${data.business}`,
      html: inquiryAdminEmailBody(data),
    });
  } catch (err) {
    console.error('Onboarding inquiry email failed:', err);
    return json({ ok: false, error: 'failed to send email' }, 502);
  }

  // The submitter's confirmation is best-effort, same reasoning as the
  // support request's confirmation email below: the important part
  // (admin notified) already succeeded, so a hiccup here shouldn't turn
  // into an error page for someone who did successfully reach us.
  try {
    await sendResendEmail(env, {
      to: data.email,
      subject: "We've received your inquiry — Facility Hubs",
      html: inquiryConfirmationEmailBody(data),
    });
  } catch (err) {
    console.error('Onboarding inquiry confirmation email failed:', err);
  }

  return json({ ok: true });
}

// =======================================================================
// Support request (support.html) -- for existing clients with an issue
// or an update request on their hub.
// =======================================================================

const SUPPORT_MAX = { name: 200, email: 320, hub: 100, requestType: 100, message: 5000 };

function validateSupportRequest(body) {
  const errors = [];
  const name = singleLine(body.name, SUPPORT_MAX.name);
  const email = singleLine(body.email, SUPPORT_MAX.email);
  const hub = singleLine(body.hub, SUPPORT_MAX.hub);
  const requestType = singleLine(body.requestType, SUPPORT_MAX.requestType);
  const message = String(body.message || '').trim().slice(0, SUPPORT_MAX.message);

  if (!name) errors.push('name is required');
  if (!email || !EMAIL_RE.test(email)) errors.push('a valid email is required');
  if (!hub) errors.push('hub is required');
  if (!requestType) errors.push('request type is required');
  if (!message) errors.push('message is required');

  return { errors, data: { name, email, hub, requestType, message } };
}

function supportAdminEmailBody(d) {
  const rowsHtml = fieldRowsHtml([
    ['Name', d.name],
    ['Email', d.email],
    ['Hub', d.hub],
    ['Request type', d.requestType],
  ]);

  return emailShell(`
<p style="margin:0 0 18px;font-weight:800;color:#0a2b70;font-size:17px;">New support request</p>
<table role="presentation" style="border-collapse:collapse;width:100%;">${rowsHtml}</table>
<div style="margin-top:18px;padding-top:18px;border-top:1px solid #e2e7f0;">
<div style="color:#5b6b8c;font-weight:700;font-size:13px;margin-bottom:6px;">Message</div>
<div style="font-size:14.5px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(d.message)}</div>
</div>
<p style="color:#8b95ab;font-size:12px;margin-top:16px;">Submitted from the Support form on facilityhubs.com. Reply to this email to respond directly to ${escapeHtml(d.name)}.</p>
`);
}

function supportConfirmationEmailBody(d) {
  const firstName = d.name.split(' ')[0] || d.name;
  return emailShell(`
<p>Hi ${escapeHtml(firstName)},</p>
<p>Thanks for reaching out &mdash; we've received your request and will get back to you as soon as we can.</p>
<div style="background:#f5f8ff;border:1px solid #e2e7f0;border-radius:10px;padding:16px 18px;margin:18px 0;">
<p style="margin:0 0 6px;"><strong>Hub:</strong> ${escapeHtml(d.hub)}</p>
<p style="margin:0 0 10px;"><strong>Request type:</strong> ${escapeHtml(d.requestType)}</p>
<p style="margin:0;white-space:pre-wrap;">${escapeHtml(d.message)}</p>
</div>
<p style="color:#5b6b8c;font-size:13px;">If anything above isn't right, just reply to this email and let us know.</p>
<p style="margin-top:22px;">&mdash; Facility Hubs Support</p>
`);
}

async function handleSupportRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  if (body && typeof body.website === 'string' && body.website.trim()) {
    return json({ ok: true });
  }

  const { errors, data } = validateSupportRequest(body || {});
  if (errors.length) {
    return json({ ok: false, error: errors.join('; ') }, 400);
  }

  if (!env.RESEND_API_KEY) {
    console.error('Support request received but RESEND_API_KEY is not set.');
    return json({ ok: false, error: 'email sending is not configured yet' }, 503);
  }

  // The admin notification is the critical path -- fail loudly if it
  // doesn't go out, same reasoning as the onboarding inquiry above.
  try {
    await sendResendEmail(env, {
      to: ADMIN_TO,
      replyTo: data.email,
      subject: `Support request — ${data.hub} — ${data.name}`,
      html: supportAdminEmailBody(data),
    });
  } catch (err) {
    console.error('Support request admin email failed:', err);
    return json({ ok: false, error: 'failed to send email' }, 502);
  }

  // The submitter's confirmation is best-effort: the part that matters:
  // (admin got notified) already succeeded above, so a hiccup sending
  // the confirmation copy shouldn't turn into an error page for someone
  // who *did* successfully reach support.
  try {
    await sendResendEmail(env, {
      to: data.email,
      subject: "We've received your request — Facility Hubs Support",
      html: supportConfirmationEmailBody(data),
    });
  } catch (err) {
    console.error('Support request confirmation email failed:', err);
  }

  return json({ ok: true });
}

// =======================================================================
// Rating (rate.html) -- a hidden landing page, reached only via a link
// in the rating-request email template (emails/rating-request-email.html,
// sent manually/via campaign, not triggered by this worker). Not linked
// from any site nav or footer, and rate.html itself sets a noindex meta
// tag -- it's meant to be reached only through that one emailed link.
// =======================================================================

const RATING_MAX = { name: 200, email: 320, hub: 200, comment: 2000 };

function validateRating(body) {
  const errors = [];
  const scoreNum = Number(body.score);
  const score = Number.isInteger(scoreNum) && scoreNum >= 1 && scoreNum <= 5 ? scoreNum : null;
  const name = singleLine(body.name, RATING_MAX.name);
  const email = singleLine(body.email, RATING_MAX.email);
  const hub = singleLine(body.hub, RATING_MAX.hub);
  const comment = String(body.comment || '').trim().slice(0, RATING_MAX.comment);

  if (!score) errors.push('a rating from 1 to 5 is required');
  // Unlike the other two forms, email/name/hub are optional here -- a
  // rating link can be clicked without ever confirming identity, and a
  // score is still useful feedback on its own.
  if (email && !EMAIL_RE.test(email)) errors.push('email looks invalid');

  return { errors, data: { score, name, email, hub, comment } };
}

function ratingAdminEmailBody(d) {
  const stars = '★'.repeat(d.score) + '☆'.repeat(5 - d.score);
  const identityRows = [];
  if (d.name) identityRows.push(['Name', d.name]);
  if (d.email) identityRows.push(['Email', d.email]);
  if (d.hub) identityRows.push(['Hub', d.hub]);
  const rowsHtml = identityRows.length ? fieldRowsHtml(identityRows) : '';

  return emailShell(`
<p style="margin:0 0 14px;font-weight:800;color:#0a2b70;font-size:17px;">New hub rating</p>
<p style="margin:0 0 18px;font-size:28px;letter-spacing:3px;color:#f2994a;">${stars} <span style="font-size:15px;color:#5b6b8c;font-weight:700;letter-spacing:0;">(${d.score} of 5)</span></p>
${rowsHtml ? `<table role="presentation" style="border-collapse:collapse;width:100%;">${rowsHtml}</table>` : '<p style="color:#8b95ab;font-size:13px;">No name, email, or hub was attached to this rating.</p>'}
${d.comment ? `<div style="margin-top:18px;padding-top:18px;border-top:1px solid #e2e7f0;">
<div style="color:#5b6b8c;font-weight:700;font-size:13px;margin-bottom:6px;">Comment</div>
<div style="font-size:14.5px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(d.comment)}</div>
</div>` : ''}
<p style="color:#8b95ab;font-size:12px;margin-top:16px;">Submitted from the rating page on facilityhubs.com.${d.email ? ` Reply to this email to respond directly to ${escapeHtml(d.name || d.email)}.` : ''}</p>
`);
}

async function handleRatingSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  if (body && typeof body.website === 'string' && body.website.trim()) {
    return json({ ok: true });
  }

  const { errors, data } = validateRating(body || {});
  if (errors.length) {
    return json({ ok: false, error: errors.join('; ') }, 400);
  }

  if (!env.RESEND_API_KEY) {
    console.error('Rating received but RESEND_API_KEY is not set.');
    return json({ ok: false, error: 'email sending is not configured yet' }, 503);
  }

  try {
    await sendResendEmail(env, {
      to: ADMIN_TO,
      ...(data.email ? { replyTo: data.email } : {}),
      subject: `New hub rating — ${data.score}/5${data.hub ? ` — ${data.hub}` : ''}`,
      html: ratingAdminEmailBody(data),
    });
  } catch (err) {
    console.error('Rating email failed:', err);
    return json({ ok: false, error: 'failed to send email' }, 502);
  }

  return json({ ok: true });
}

// =======================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'not found' }, 404);
    }

    if (url.pathname.endsWith('/onboarding-inquiry/submit')) {
      return handleOnboardingInquiry(request, env);
    }

    if (url.pathname.endsWith('/support-request/submit')) {
      return handleSupportRequest(request, env);
    }

    if (url.pathname.endsWith('/rating/submit')) {
      return handleRatingSubmit(request, env);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
