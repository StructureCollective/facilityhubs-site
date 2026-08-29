#!/usr/bin/env node
// Legacy Property Hub -- send any of the 3 real outgoing emails through
// Resend without going through an actual sign-in, maintenance request, or
// Stripe payment. Imports the exact same emailShell()/emailButton()/body
// functions and sendEmail() that src/index.js uses in production, so this
// always reflects the real templates.
//
// This sends a REAL email via the REAL Resend API -- it isn't a dry run.
//
// Usage:
//   RESEND_API_KEY=re_xxx node scripts/send-test-email.js list
//   RESEND_API_KEY=re_xxx node scripts/send-test-email.js <template> you@example.com
//
// RESEND_API_KEY is the same secret set via `wrangler secret put RESEND_API_KEY`
// -- grab it from the Resend dashboard (API Keys) if you don't have it handy.

import {
  sendEmail,
  signInEmailBody,
  maintenanceRequestEmailBody,
  paymentReceivedEmailBody,
  paymentReceivedAdminEmailBody,
} from '../src/index.js';

// Edit these to try different names/amounts/etc.
const mock = {
  signInLink: 'https://facilityhubs.com/legacy/api/auth/verify?token=TEST_TOKEN_1234',
  tenant: { full_name: 'Jordan Rivera', unit_label: 'Unit 4B', email: 'jordan.rivera@example.com' },
  issueType: 'Plumbing',
  issueStartedOn: '2026-08-20',
  description: 'Kitchen faucet has been leaking steadily for the past few days.',
  paid: {
    full_name: 'Jordan Rivera',
    unit_label: 'Unit 4B',
    amount_cents: 150000,
    period_label: 'September 2026',
    receipt_url: 'https://dashboard.stripe.com/receipts/example',
  },
};

const TEMPLATES = {
  'sign-in': {
    subject: 'Sign in to Legacy Property Hub',
    html: () => signInEmailBody(mock.signInLink),
  },
  'maintenance-request': {
    subject: `Maintenance request - ${mock.tenant.unit_label || mock.tenant.full_name}`,
    html: () =>
      maintenanceRequestEmailBody({
        tenant: mock.tenant,
        issueType: mock.issueType,
        issueStartedOn: mock.issueStartedOn,
        description: mock.description,
      }),
  },
  'payment-received': {
    subject: 'Payment received - Legacy Property Hub',
    // paymentReceivedEmailBody() reads paid.email only indirectly (via the
    // caller's "to:" -- see below), so the recipient email itself isn't
    // baked into the body.
    html: () => paymentReceivedEmailBody(mock.paid),
  },
  'payment-received-admin': {
    subject: `Payment received - ${mock.paid.unit_label || mock.paid.full_name}`,
    html: () => paymentReceivedAdminEmailBody(mock.paid),
  },
};

function printUsage() {
  console.log('Available templates:\n');
  for (const name of Object.keys(TEMPLATES)) console.log(`  ${name}`);
  console.log('\nUsage:');
  console.log('  RESEND_API_KEY=re_xxx node scripts/send-test-email.js <template> you@example.com');
}

const [, , templateName, to] = process.argv;

if (!templateName || templateName === 'list' || !TEMPLATES[templateName]) {
  if (templateName && templateName !== 'list') {
    console.error(`Unknown template "${templateName}".\n`);
  }
  printUsage();
  process.exit(templateName && templateName !== 'list' ? 1 : 0);
}

if (!to) {
  console.error('Missing recipient email address.\n');
  printUsage();
  process.exit(1);
}

if (!process.env.RESEND_API_KEY) {
  console.error(
    'Missing RESEND_API_KEY. Run with:\n' +
      '  RESEND_API_KEY=re_xxx node scripts/send-test-email.js ' +
      `${templateName} ${to}`
  );
  process.exit(1);
}

const env = { RESEND_API_KEY: process.env.RESEND_API_KEY };
const { subject, html } = TEMPLATES[templateName];

// sendEmail() in src/index.js swallows its own errors (logs via
// console.error, never throws) so the Worker's payment/maintenance flow
// can't be broken by a Resend hiccup -- that means this script can't
// detect success/failure from a return value either. Watch the output
// above this line for a "Resend send failed" error; no error means it
// went through.
await sendEmail(env, { to, subject, html: html() });
console.log(`Send attempted: "${templateName}" (${subject}) to ${to}.`);
console.log('Check the output above for a "Resend send failed" error, and check that inbox.');
