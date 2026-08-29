# Legacy Property Hub -- Worker + D1 backend

Serves `facilityhubs.com/legacy*`.

## Current status: Google Sign-In is OFF

At your request, Google Sign-In has been pulled out for now, so **every
page and every API endpoint under `/legacy/*` is open to anyone with the
link** -- there is no per-tenant or admin access control right now. That's
fine for previewing/testing the UI and Stripe flow, but it needs to be
back in place before real tenants or real rent money touch this.

- The Dashboard reads which tenant to show from `?tenant_id=N` in the URL
  (with a simple picker if that's missing) instead of a signed-in session.
- The Admin view and all `/legacy/api/*` endpoints have no access check.
- `src/index.js` has a comment block at the top explaining exactly
  what to restore (Google ID token verification against the `admins` /
  `tenants` D1 tables) and where a prior working version lived, when
  you're ready.
- The D1 schema (`admins`, `tenants`, `payments`) is unchanged -- nothing
  about the data model needs to change to bring auth back.

## One-time setup

1. **Install dependencies** (from this `legacy/` folder):
   ```
   npm install
   ```

2. **Authenticate wrangler** with a scoped Cloudflare API token (don't use
   your Global API Key). In the Cloudflare dashboard: My Profile -> API
   Tokens -> Create Token -> start from a blank template, and grant:
   - Account -> D1 -> Edit
   - Account -> Workers Scripts -> Edit
   - Zone -> Workers Routes -> Edit (scoped to the facilityhubs.com zone)
   Then either run `wrangler login`, or export it as an env var for
   non-interactive use: `export CLOUDFLARE_API_TOKEN=...`.

3. **Create the D1 database:**
   ```
   npx wrangler d1 create legacy_property_hub_db
   ```
   Copy the `database_id` it prints into `wrangler.toml` (replacing
   `REPLACE_AFTER_D1_CREATE`).

4. **Apply the schema:**
   ```
   npm run db:migrate:remote
   ```
   Then add a tenant or two so there's something to look at:
   ```
   npx wrangler d1 execute legacy_property_hub_db --remote --command \
     "INSERT INTO tenants (email, full_name, unit_label, rent_amount_cents, due_day) \
      VALUES ('tenant@example.com', 'Jane Tenant', 'Unit 4B', 150000, 1);"
   ```
   (`rent_amount_cents` is in cents, e.g. `150000` = $1,500.00. `due_day`
   is 1-28.)

5. **Set up Stripe** (test mode to start):
   - Get your test **Secret key** from the Stripe Dashboard -> Developers -> API keys.
   - Create a webhook endpoint at Developers -> Webhooks pointing to
     `https://facilityhubs.com/legacy/api/stripe/webhook`, subscribed to
     `checkout.session.completed` and `checkout.session.expired`. Copy its
     **Signing secret**.
   - Set both as Worker secrets (never put these in wrangler.toml or
     commit them):
     ```
     npx wrangler secret put STRIPE_SECRET_KEY
     npx wrangler secret put STRIPE_WEBHOOK_SECRET
     ```

6. **Deploy:**
   ```
   npm run deploy
   ```
   This also registers the route `facilityhubs.com/legacy*`, so Cloudflare
   sends only that path to this Worker -- everything else on the domain
   keeps being served exactly as it is today (GitHub Pages). Requires the
   facilityhubs.com DNS to be proxied through Cloudflare (orange-clouded);
   it already uses Cloudflare nameservers.

## Local development

```
wrangler d1 execute legacy_property_hub_db --local --file=./schema.sql
wrangler dev
```

## Managing tenants

There's no admin UI for adding/editing tenants yet. Add or edit them
directly in D1 (see the INSERT example above), or use
`POST /legacy/api/tenants`.
