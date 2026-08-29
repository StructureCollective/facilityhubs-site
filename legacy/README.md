# Legacy Property Hub -- Worker + D1 backend

Serves `facilityhubs.com/legacy*`.

## Auth: passwordless email magic links

Tenants and admins sign in with just their email -- no Google account
required, no password to manage. On the landing page (`/legacy/`) they
enter their email; if it matches a row in `tenants` or `admins`, a
one-time sign-in link is emailed to them (via Resend) and they're signed
in for 30 days after clicking it. The response is identical whether or
not the email matched, so the sign-in form can't be used to figure out
who has an account.

- Every tenant/admin API route under `/legacy/api/*` is gated on a
  signed session cookie -- an admin can reach any tenant's data, a
  tenant can only reach their own (including via the `/tenants/me`
  shorthand the frontend uses).
- Magic-link tokens live in the `login_tokens` D1 table: random,
  single-use, 15-minute expiry. The session itself is a signed JWT
  (HS256, via the `jose` package) in an `HttpOnly` cookie, good for 30
  days.
- To sign in as an admin, your email needs a row in the `admins` table
  (see step 6 below) -- there's no self-serve admin signup.
- To sign in as a tenant, the email needs to match `tenants.email`
  exactly (case-insensitive).

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

   If you're adding auth to a database that predates it (i.e. you ran
   `db:migrate:remote` before the `login_tokens` table existed in
   `schema.sql`), run this once to add just that table without touching
   existing data -- `CREATE TABLE IF NOT EXISTS` makes it safe to run
   even if it's already there:
   ```
   npx wrangler d1 execute legacy_property_hub_db --remote --command \
     "CREATE TABLE IF NOT EXISTS login_tokens (
        token TEXT PRIMARY KEY NOT NULL,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('tenant', 'admin')),
        subject TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_login_tokens_expires ON login_tokens(expires_at);"
   ```

   Likewise, if your database predates `receipt_url` on `payments`
   (Stripe's hosted receipt link, stored once a payment succeeds -- kept
   for reference only; the app's own PDF receipt doesn't depend on it):
   ```
   npx wrangler d1 execute legacy_property_hub_db --remote --command \
     "ALTER TABLE payments ADD COLUMN receipt_url TEXT;"
   ```

   And if it predates `rent_amount_cents`/`late_fee_cents` on `payments`
   (the rent/late-fee breakdown captured when a charge is created, so the
   PDF receipt can itemize them instead of showing one lump sum -- a
   payment from before this ran will just show a single "Rent" line
   instead):
   ```
   npx wrangler d1 execute legacy_property_hub_db --remote --command \
     "ALTER TABLE payments ADD COLUMN rent_amount_cents INTEGER;
      ALTER TABLE payments ADD COLUMN late_fee_cents INTEGER;"
   ```

   And if it predates `tenant_fees` (one-time fees an admin adds from
   Admin -> a tenant's detail view, separate from the recurring late fee
   -- each has its own label and only gets charged once, on that
   tenant's next payment):
   ```
   npx wrangler d1 execute legacy_property_hub_db --remote --command \
     "CREATE TABLE IF NOT EXISTS tenant_fees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
        label TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        applied_at TEXT,
        applied_payment_id INTEGER REFERENCES payments(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_fees_tenant ON tenant_fees(tenant_id, status);"
   ```

5. **Set up Stripe** (test mode to start). Payments use a custom embedded
   checkout -- Stripe Elements' Payment Element, mounted directly on the
   Payments page -- not a redirect to a Stripe-hosted Checkout page, so
   this needs both of Stripe's standard API keys plus a webhook:
   - Get your test **Secret key** and **Publishable key** from the
     Stripe Dashboard -> Developers -> API keys.
   - Create a webhook endpoint at Developers -> Webhooks pointing to
     `https://facilityhubs.com/legacy/api/stripe/webhook`, subscribed to
     `payment_intent.succeeded`, `payment_intent.payment_failed`, and
     `payment_intent.canceled`. Copy its **Signing secret**.
   - Set all three as Worker secrets (never put these in wrangler.toml or
     commit them -- the publishable key isn't sensitive, but this keeps
     the setup consistent and out of git either way):
     ```
     npx wrangler secret put STRIPE_SECRET_KEY
     npx wrangler secret put STRIPE_PUBLISHABLE_KEY
     npx wrangler secret put STRIPE_WEBHOOK_SECRET
     ```
   - Each successful payment gets a branded, itemized PDF receipt --
     generated by this app itself (src/lib/pdf.js), not Stripe -- shown
     as "View / download" in the payment history table on both the
     tenant Payments page and Admin's tenant detail view, and linked
     from the payment-confirmation email. No setup needed beyond the
     above.
   - A "pending" payment row that's abandoned (tenant opens the payment
     form, never finishes) is swept up automatically a few minutes
     later by a scheduled Cron Trigger (`wrangler.toml`'s `[triggers]`)
     -- this is deployed along with everything else by `npm run deploy`
     in step 7, no separate Dashboard step required. It won't touch a
     payment that's genuinely still in progress (e.g. an ACH transfer
     that's still processing).

6. **Set up email sign-in (Resend + session secret):**
   - Get your **API key** from the Resend dashboard and set it as a
     Worker secret:
     ```
     npx wrangler secret put RESEND_API_KEY
     ```
     Resend also needs to be verified to send from `legacy@facilityhubs.com`
     -- that's Cloudflare Email Routing + a Resend domain verification,
     not something this repo controls. Payment-confirmation and
     maintenance-notification emails use the same key.
   - Generate a random session secret and set it as a Worker secret --
     this signs the session cookie, so it should be long and random, and
     changing it later instantly signs everyone out:
     ```
     npx wrangler secret put SESSION_SECRET
     ```
     A quick way to generate one: `openssl rand -base64 48`.
   - Add yourself (or whoever should have Admin access) to the `admins`
     table -- this is the only way in for Admin, there's no signup form:
     ```
     npx wrangler d1 execute legacy_property_hub_db --remote --command \
       "INSERT INTO admins (email) VALUES ('you@example.com');"
     ```

7. **Deploy:**
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

Magic links won't actually send email locally unless `RESEND_API_KEY` is
set for the dev environment too (`sendEmail()` silently no-ops without
it) -- check the Worker logs for the generated link, or query
`login_tokens` directly in the local D1 DB, and visit
`http://localhost:8787/legacy/api/auth/verify?token=...` by hand.

## Managing tenants

There's no admin UI for adding/editing tenants yet. Add or edit them
directly in D1 (see the INSERT example above), or use
`POST /legacy/api/tenants` (requires an admin session).
