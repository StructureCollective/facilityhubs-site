# Site forms worker

Cloudflare Worker backing two forms on facilityhubs.com, both via
[Resend](https://resend.com), both sent from **support@facilityhubs.com**:

- **`POST /api/onboarding-inquiry/submit`** -- the "Get Started" form on
  `get-started.html`. Emails the inquiry to **admin@structurecollective.com**.
- **`POST /api/support-request/submit`** -- the "Support" form on
  `support.html`, for existing clients with an issue on their hub or an
  update request. Emails the request to **admin@structurecollective.com**,
  *and* sends a branded confirmation email back to whoever submitted it.

Both routes are handled by the same worker/deploy -- there's no need to
run this setup twice. The project folder is still called
`onboarding-worker/` and the Worker's `name` in `wrangler.toml` is still
`facilityhubs-site-onboarding` even though it now does more than
onboarding -- renaming either would make `wrangler deploy` create a
*second*, separate Worker instead of updating the one already live, so
both were left as-is on purpose.

This is a separate Cloudflare Worker project from `legacy/`, on purpose --
it doesn't need a database or the Stripe/session-cookie machinery legacy
has, just two stateless endpoints. It does **not** serve any of the site's
static pages; those keep being served exactly as they are today.

## Setup

1. **Install dependencies:**
   ```
   cd onboarding-worker
   npm install
   ```

2. **Set the Resend API key as a Worker secret:**
   ```
   npx wrangler secret put RESEND_API_KEY
   ```
   This can be the **same key value** already used by `legacy/`'s magic-link
   emails -- Resend's domain verification for `facilityhubs.com` covers
   every address at that domain (`legacy@facilityhubs.com`,
   `support@facilityhubs.com`, etc.), so no new domain verification is
   needed. Cloudflare Workers don't share secrets across separate worker
   *projects* though, so it needs to be set here too even though it's the
   same value. **If you already did this when setting up `get-started.html`,
   skip this step** -- it's the same worker, this is just a second route on it.

3. **Deploy:**
   ```
   npm run deploy
   ```
   This registers both routes (`facilityhubs.com/api/onboarding-inquiry*`
   and `facilityhubs.com/api/support-request*`). Requires the
   `facilityhubs.com` DNS to be proxied through Cloudflare (orange-clouded)
   -- same requirement as `legacy/`, and it's already set up that way.

## Local development

```
npx wrangler dev
```

Without `RESEND_API_KEY` set for the dev environment too, submissions will
fail with a 503 ("email sending is not configured yet") instead of
silently no-op'ing -- that's intentional (see the comment at the top of
`src/index.js`): sending the *admin* notification is each endpoint's
whole job, so a misconfiguration there should be visible, not swallowed.
(The support-request confirmation email to the submitter is the one
exception -- it's best-effort and won't fail the request if it errors,
since the admin already got notified by that point.)

## Testing a submission by hand

```
curl -X POST http://localhost:8787/api/onboarding-inquiry/submit \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","business":"Test Co","email":"you@example.com","message":"Just testing"}'

curl -X POST http://localhost:8787/api/support-request/submit \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"you@example.com","hub":"Legacy Property Hub","requestType":"Report an issue","message":"Just testing"}'
```

A honeypot field (`website`) is included in both forms' payloads but left
blank by real visitors -- a submission with that field filled in is
reported back as `{"ok":true}` (so a bot doesn't retry) but no email is
actually sent.

## One more thing worth knowing: replies to support@facilityhubs.com

Both admin emails set `reply_to` to the person who submitted the form, so
replying from admin@structurecollective.com reaches them directly -- no
extra setup needed for that.

The support-request confirmation email (the one sent *to* the client) is
worded as "reply to this email" for anything that looks wrong. That reply
would land at **support@facilityhubs.com**. Whether that actually reaches
an inbox you check depends on whether you've set up a Cloudflare Email
Routing rule forwarding `support@facilityhubs.com` to somewhere -- that's
separate from this worker's *outbound* sending via Resend, and isn't
something this worker or Resend configures for you. Worth double-checking
in the Cloudflare dashboard (Email → Email Routing) if you want those
replies to actually reach you.
