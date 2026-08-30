/*
 * Facility Hubs -- onboarding inquiry worker.
 *
 * ---------------------------------------------------------------------
 * Handles the "Get Started" form on facilityhubs.com/get-started.html.
 * POST /api/onboarding-inquiry/submit with a JSON body emails the
 * inquiry to admin@structurecollective.com, sent from
 * support@facilityhubs.com via Resend (same account/domain as the
 * legacy hub's magic-link email -- see ../legacy/src/index.js -- so
 * this can reuse the same RESEND_API_KEY value, just set again as a
 * secret on THIS worker; Cloudflare Workers don't share secrets across
 * separate worker projects even when they're the same underlying key).
 *
 * Unlike legacy's sendEmail(), which quietly no-ops without a
 * RESEND_API_KEY (fine there -- it's a side-effect on top of a payment
 * or maintenance request that already succeeded), a missing key or a
 * failed send here is the ENTIRE point of the request, so both are
 * surfaced as real error responses instead of being swallowed. Losing
 * a client inquiry silently would be worse than showing them an error.
 * ---------------------------------------------------------------------
 */

const ADMIN_TO = 'admin@structurecollective.com';
const FROM = 'Facility Hubs <support@facilityhubs.com>';

const MAX_LENGTHS = {
  name: 200,
  business: 200,
  email: 320,
  phone: 60,
  teamSize: 20,
  message: 5000,
};

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(body) {
  const errors = [];
  const name = singleLine(body.name, MAX_LENGTHS.name);
  const business = singleLine(body.business, MAX_LENGTHS.business);
  const email = singleLine(body.email, MAX_LENGTHS.email);
  const phone = singleLine(body.phone, MAX_LENGTHS.phone);
  const teamSize = singleLine(body.teamSize, MAX_LENGTHS.teamSize);
  const message = String(body.message || '').trim().slice(0, MAX_LENGTHS.message);
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.map((c) => singleLine(c, 120)).filter(Boolean).slice(0, 16)
    : [];

  if (!name) errors.push('name is required');
  if (!business) errors.push('business is required');
  if (!email || !EMAIL_RE.test(email)) errors.push('a valid email is required');
  if (!message) errors.push('message is required');

  return {
    errors,
    data: { name, business, email, phone, teamSize, message, capabilities },
  };
}

function inquiryEmailHtml(d) {
  const rows = [
    ['Name', d.name],
    ['Business', d.business],
    ['Email', d.email],
    ['Phone', d.phone || '—'],
    ['Team size', d.teamSize || '—'],
  ];

  const rowsHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 14px 8px 0;color:#5b6b8c;font-weight:700;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#0d1b3b;font-size:14.5px;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>
  `).join('');

  const capabilitiesHtml = d.capabilities.length
    ? `<tr>
         <td style="padding:8px 14px 8px 0;color:#5b6b8c;font-weight:700;font-size:13px;white-space:nowrap;vertical-align:top;">Wants</td>
         <td style="padding:8px 0;color:#0d1b3b;font-size:14.5px;vertical-align:top;">${d.capabilities.map(escapeHtml).join('<br>')}</td>
       </tr>`
    : '';

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;">
    <div style="background:#0a2b70;padding:22px 28px;border-radius:12px 12px 0 0;">
      <span style="color:#ffffff;font-weight:800;font-size:17px;letter-spacing:-0.01em;">New onboarding inquiry</span>
    </div>
    <div style="background:#ffffff;border:1px solid #e2e7f0;border-top:0;border-radius:0 0 12px 12px;padding:26px 28px;">
      <table role="presentation" style="border-collapse:collapse;width:100%;">
        ${rowsHtml}
        ${capabilitiesHtml}
      </table>
      <div style="margin-top:18px;padding-top:18px;border-top:1px solid #e2e7f0;">
        <div style="color:#5b6b8c;font-weight:700;font-size:13px;margin-bottom:6px;">Message</div>
        <div style="color:#0d1b3b;font-size:14.5px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(d.message)}</div>
      </div>
    </div>
    <p style="color:#8b95ab;font-size:12px;margin:16px 4px 0;">
      Submitted from the Get Started form on facilityhubs.com. Reply to this
      email to respond directly to ${escapeHtml(d.name)}.
    </p>
  </div>`;
}

async function sendInquiryEmail(env, data) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [ADMIN_TO],
      reply_to: data.email,
      subject: `New onboarding inquiry — ${data.business}`,
      html: inquiryEmailHtml(data),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend responded ${res.status}: ${detail}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'POST' || !url.pathname.endsWith('/submit')) {
      return json({ ok: false, error: 'not found' }, 404);
    }

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

    const { errors, data } = validate(body || {});
    if (errors.length) {
      return json({ ok: false, error: errors.join('; ') }, 400);
    }

    if (!env.RESEND_API_KEY) {
      console.error('Onboarding inquiry received but RESEND_API_KEY is not set.');
      return json({ ok: false, error: 'email sending is not configured yet' }, 503);
    }

    try {
      await sendInquiryEmail(env, data);
    } catch (err) {
      console.error('Onboarding inquiry email failed:', err);
      return json({ ok: false, error: 'failed to send email' }, 502);
    }

    return json({ ok: true });
  },
};
