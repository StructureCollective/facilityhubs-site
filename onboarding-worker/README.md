# Onboarding inquiry worker

Cloudflare Worker backing the "Get Started" form on
`facilityhubs.com/get-started.html`. It has one job: `POST
/api/onboarding-inquiry/submit` with the form's JSON body, and it emails
the inquiry to **admin@structurecollective.com**, sent from
**support@facilityhubs.com** via [Resend](https://resend.com).

This is a separate Cloudflare Worker project from `legacy/`, on purpose --
it doesn't need a database or the Stripe/session-cookie machinery legacy
has, just one stateless endpoint. It does **not** serve any of the site's
static pages; those keep being served exactly as they are today. It only
claims one path: `facilityhubs.com/api/onboarding-inquiry*`.

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
   projects though, so it does need to be set again here even if it's the
   same value.

3. **Deploy:**
   ```
   npm run deploy
   ```
   This registers the route `facilityhubs.com/api/onboarding-inquiry*`.
   Requires the `facilityhubs.com` DNS to be proxied through Cloudflare
   (orange-clouded) -- same requirement as `legacy/`, and it's already set
   up that way.

## Local development

```
npx wrangler dev
```

Without `RESEND_API_KEY` set for the dev environment too, submissions will
fail with a 503 ("email sending is not configured yet") instead of
silently no-op'ing -- that's intentional (see the comment at the top of
`src/index.js`): this worker's only job is sending the email, so a
misconfiguration should be visible, not swallowed.

## Testing a submission by hand

```
curl -X POST http://localhost:8787/api/onboarding-inquiry/submit \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","business":"Test Co","email":"you@example.com","message":"Just testing"}'
```

A honeypot field (`website`) is included in the form's payload but left
blank by real visitors -- a submission with that field filled in is
reported back as `{"ok":true}` (so a bot doesn't retry) but no email is
actually sent.
