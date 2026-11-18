-- 0021_apollo_webhooks_and_bookings
-- Provider external IDs (`external_ids`), Apollo credit ledger enrichment columns, encrypted
-- outbound webhook endpoints + durable HTTP delivery queue (`webhook_deliveries`), and idempotent
-- Microsoft Bookings webhook events (`booking_events`) (PRD 4.9, 4.14, 4.17, 5, 7.6, 9).

-- 1. Provider external IDs (Apollo person/org IDs, Bigin legacy IDs, Bookings appointment refs)
CREATE TABLE IF NOT EXISTS external_ids (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('apollo', 'bigin', 'bookings', 'other')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('contact', 'company', 'lead', 'deal')),
  entity_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, entity_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_external_ids_entity
  ON external_ids(entity_type, entity_id);

-- 2. Apollo credit ledger indexes & entity context
ALTER TABLE apollo_credit_ledger
  ADD COLUMN IF NOT EXISTS apollo_org_id TEXT,
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_apollo_credit_ledger_created
  ON apollo_credit_ledger(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_apollo_credit_ledger_actor
  ON apollo_credit_ledger(actor_user_id, created_at DESC);

-- 3. Outbound webhook endpoints (encrypted secret support + optimistic concurrency)
ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS secret_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS secret_key_version INTEGER,
  ADD COLUMN IF NOT EXISTS secret_hint TEXT,
  ADD COLUMN IF NOT EXISTS last_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE webhook_endpoints
  ALTER COLUMN secret_hmac SET DEFAULT '';

-- 4. Durable outbound webhook deliveries (24h exponential backoff & delivery log — PRD 4.14)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  outbox_event_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retrying', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  response_excerpt TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (endpoint_id, outbox_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(status, available_at)
  WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint_created
  ON webhook_deliveries(endpoint_id, created_at DESC);

-- 5. Microsoft Bookings idempotent event ledger (no raw PII stored — email SHA-256 only)
CREATE TABLE IF NOT EXISTS booking_events (
  id TEXT PRIMARY KEY,
  booking_appointment_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'created'
    CHECK (event_type IN ('created', 'updated', 'cancelled')),
  service_name TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  customer_email_sha256 TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  activity_id TEXT,
  task_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_appointment_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_booking_events_contact
  ON booking_events(contact_id)
  WHERE contact_id IS NOT NULL;

-- 6. Least-privilege application role grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      external_ids,
      apollo_credit_ledger,
      webhook_endpoints,
      webhook_deliveries,
      booking_events
    TO adas_app;
  END IF;
END
$$;
