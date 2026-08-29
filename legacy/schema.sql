CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  unit_label TEXT,
  rent_amount_cents INTEGER NOT NULL,
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 28),
  late_fee_cents INTEGER NOT NULL DEFAULT 0,
  late_fee_after_day INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  period_label TEXT,
  -- 'stripe' for a payment made through this app's Stripe Checkout;
  -- 'direct' for one collected outside the app (cash, check, handed
  -- directly to the landlord) and recorded here after the fact.
  method TEXT NOT NULL DEFAULT 'stripe',
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_tenant ON maintenance_requests(tenant_id);

-- One-time email magic-link tokens. `subject` is a tenant's numeric id
-- (as text) when subject_type='tenant', or an admin's email when
-- subject_type='admin' (admins have no numeric id). used_at prevents a
-- link from being redeemed twice, even before it expires.
CREATE TABLE IF NOT EXISTS login_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('tenant', 'admin')),
  subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_expires ON login_tokens(expires_at);
