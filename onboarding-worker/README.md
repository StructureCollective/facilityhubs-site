# Site forms worker

Cloudflare Worker backing three things on facilityhubs.com, all via
[Resend](https://resend.com), all sent from **support@facilityhubs.com**:

- **`POST /api/onboarding-inquiry/submit`** -- the "Get Started" form on
  `get-started.html`. Emails the inquiry to **admin@structurecollective.com**,
  *and* sends a branded confirmation email back to whoever submitted it.
- **`POST /api/support-request/submit`** -- the "Support" form on
  `support.html`, for existing clients with an issue on their hub or an
  update request. Emails the request to **admin@structurecollective.com**,
  *and* sends a branded confirmation email back to whoever submitted it.
- **`POST /api/rating/submit`** -- the star-rating form on `rate.html`, a
  *hidden* landing page (not linked from any site nav/footer, `noindex`)
  reached only via a link in `emails/rating-request-email.html`. Emails the
  1-5 star score (and optional comment) to **admin@structurecollective.com**.
  No confirmation email back to the rater -- `rate.html` shows the
  thank-you state itself.

All three routes are handled by the same worker/deploy -- there's no need
to run this setup more than once. The project folder is still called
`onboarding-worker/` and the Worker's `name` in `wrangler.toml` is still
`facilityhubs-site-onboarding` even though it now does more than
onboarding -- renaming either would make `wrangler deploy` create a
*second*, separate Worker instead of updating the one already live, so
both were left as-is on purpose.

This is a separate Cloudflare Worker project from `legacy/`, on purpose --
it doesn't need a database or the Stripe/session-cookie machinery legacy
has, just a handful of stateless endpoints. It does **not** serve any of
the site's static pages; those keep being served exactly as they are
today.

## Setup

1. **Install dependencies:**
   ```
   cd onboarding-worker
   npm install
   ```
   If npm reports blocked install scripts and tells you to run
   `npm approve-scripts <pkg>`, that's npm v12's install-scripts allowlist
   (blocks postinstall scripts, like wrangler's native-binary step, until
   approved). Run `npm approve-scripts --allow-scripts-pending` to see
   what's pending, then `npm approve-scripts --all` to approve it -- this
   writes an `allowScripts` entry into `package.json` that's worth
   committing so you don't hit this again. Requires npm >= 11.16; don't
   pass `-g`.

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
   same value. **If you already did this when setting up `get-started.html`
   or `support.html`, skip this step** -- it's the same worker, `rate.html`
   is just a third route on it.

3. **Deploy:**
   ```
   npm run deploy
   ```
   This registers all three routes (`facilityhubs.com/api/onboarding-inquiry*`,
   `facilityhubs.com/api/support-request*`, and `facilityhubs.com/api/rating*`).
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
`src/index.js`): sending the *admin* notification is each endpoint's
whole job, so a misconfiguration there should be visible, not swallowed.
(Each confirmation email back to the visitor -- onboarding-inquiry's and
support-request's; rating has none -- is the exception: best-effort, and
won't fail the request if it errors, since the admin already got notified
by that point.)

## Testing a submission by hand

```
curl -X POST http://localhost:8787/api/onboarding-inquiry/submit \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","business":"Test Co","email":"you@example.com","message":"Just testing"}'

curl -X POST http://localhost:8787/api/support-request/submit \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"you@example.com","hub":"Legacy Property Hub","requestType":"Report an issue","message":"Just testing"}'

curl -X POST http://localhost:8787/api/rating/submit \
  -H "Content-Type: application/json" \
  -d '{"score":5,"name":"Test User","email":"you@example.com","hub":"GFS Hub","comment":"Just testing"}'
```

`score` is the only required field on the rating endpoint -- `name`,
`email`, `hub`, and `comment` are all optional, since a rating link can be
clicked anonymously and a bare score is still useful feedback.

A honeypot field (`website`) is included in all three forms' payloads but
left blank by real visitors -- a submission with that field filled in is
reported back as `{"ok":true}` (so a bot doesn't retry) but no email is
actually sent.

## One more thing worth knowing: replies to support@facilityhubs.com

Both the onboarding-inquiry and support-request admin emails set
`reply_to` to the person who submitted the form (so does the rating admin
email, when an email address was attached to the rating), so replying
from admin@structurecollective.com reaches them directly -- no extra
setup needed for that.

Both confirmation emails (the ones sent *to* the client) are worded as
"reply to this email" for anything that looks wrong. That reply would
land at **support@facilityhubs.com**. Whether that actually reaches an
inbox you check depends on whether you've set up a Cloudflare Email
Routing rule forwarding `support@facilityhubs.com` to somewhere -- that's
separate from this worker's *outbound* sending via Resend, and isn't
something this worker or Resend configures for you. Worth double-checking
in the Cloudflare dashboard (Email → Email Routing) if you want those
replies to actually reach you.

## The `emails/` folder: campaign templates (not wired to this worker)

`emails/promo-email.html` and `emails/rating-request-email.html` (repo
root, alongside this folder) are standalone HTML email templates for
**manual or campaign sends** -- unlike everything above, nothing in this
worker triggers them automatically, since there's no client list/CRM
behind the site yet. Send them through whatever tool you use for outbound
email (Resend's own send API with a small script and a recipient list,
or paste the HTML into another ESP like Mailchimp).

Both use `{{merge_tag}}`-style placeholders (`{{first_name}}`, `{{hub_name}}`,
`{{email}}`, etc.) documented in an HTML comment near the top of each
file -- fill those in per your ESP's merge-tag syntax, or by hand for a
short list. `promo-email.html` also has `{{unsubscribe_url}}` and
`{{business_mailing_address}}` placeholders -- required for a real
marketing send under CAN-SPAM/CASL (most ESPs, Resend included, can
inject these for you automatically; check your provider's docs). The
rating-request template's star links point at `rate.html?score=N&...` --
that page is the one thing here that *is* wired to this worker.
