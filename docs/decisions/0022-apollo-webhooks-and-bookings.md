# ADR 0022: Apollo Prospecting Connector, Encrypted Outbound Webhooks Worker and Microsoft Bookings

- **Status:** Accepted
- **Date:** 2026-11-18
- **References:** PRD 4.9, 4.12, 4.14, 4.17, 4.18, 5, 6.5, 6.9, 7.6, 9; DESIGN 10

## Context

Phase 6 requires external prospecting, scheduling, and workflow automation connectors that respect compliance, least privilege, and secret encryption:

1. **Apollo (`PRD 4.14, 5`):** Real HTTP search and enrichment against Apollo REST v1 (`X-Api-Key`), showing credit cost upfront and requiring explicit user confirmation before spending enrichment credits, enforcing the daily credit guard (`apollo.daily_credit_limit`), deduplicating via `external_ids` and `contacts.apollo_person_id`, never importing suppressed or privacy-erased addresses, and granting zero marketing consent.
2. **Outbound Webhooks & Scoped Service API Tokens (`PRD 4.14, 4.17, 6.9, 9`):** Admin-managed outbound webhook endpoints (`n8n` and external automations) whose signing secrets are encrypted at rest with `SecretBox`, signing payloads with `X-ADAS-Signature: t=<unixSeconds>,v1=<hmacSha256Hex>` (5-minute replay window), retrying failed HTTP deliveries with exponential backoff for up to 24 hours, and keeping a queryable delivery log.
3. **Microsoft Bookings (`PRD 4.14, 6.5`):** Public webhook receiver on `go.adasglobuspro.com/api/v1/webhooks/bookings` verifying timestamped HMAC-SHA256 signatures, deduplicating on `(booking_appointment_id, event_type)` without storing raw PII, logging `meeting_booked` activities, creating consultation prep tasks, and automatically stopping active outreach sequences.

## Decisions

1. **Real `ApolloClient` + Upfront Credit Confirmation (`platform/apollo` + `IntelligenceService`):**
   - `ApolloClient` talks strictly to Apollo's REST v1 endpoints (`/v1/mixed_people/search`, `/v1/people/match`, `/v1/organizations/enrich`) and returns `503 APOLLO_NOT_CONFIGURED` when `secrets/apollo_api_key.txt` is absent—never fabricating prospects (`AGENTS.md §5`).
   - `importFromApollo` pre-checks `external_ids`, `contacts`, `suppressions`, and `suppressed_domains` before calling `/v1/people/match`, rejecting unconfirmed requests with `422 APOLLO_CREDIT_CONFIRMATION_REQUIRED` before any credit is spent, skipping suppressed/erased addresses (`AGENTS.md §10`), and writing zero `consent_records` (`PRD 5`).
   - Provider IDs are persisted in `external_ids (provider, entity_type, external_id)` and re-pointed on contact/company merges (`MergeWriter`) and scrubbed on privacy erasure (`ComplianceService.erasePersonalData`).

2. **`SecretBox`-Encrypted Outbound Webhooks + `webhook.deliver` Worker (`platform/webhooks` + `jobs.ts`):**
   - Outbound webhook secrets are sealed with `SecretBox` (`webhook_endpoint:<id>:secret` AAD) and displayed once at creation or rotation; only `secret_hint` is returned by read endpoints.
   - Destination URLs pass `validateWebhookTargetUrl`, blocking cloud metadata IPs (`169.254.169.254`, `100.100.100.200`, `metadata.google.internal`) unconditionally and requiring `https://` on public hosts in production unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` is enabled for internal Docker containers (`http://n8n:5678`).
   - `OutboxDispatcher.on('*', ...)` enqueues `webhook_deliveries` inside the outbox transaction (`UNIQUE (endpoint_id, outbox_event_id)`), and the `webhook.deliver` pg-boss job delivers over HTTP with exponential backoff (`15s * 2^attempt`, capped at `2h`, up to `24h` / `12` attempts).

3. **Signed Idempotent Microsoft Bookings Webhook (`POST /api/v1/webhooks/bookings`):**
   - Verified on raw bytes via `verifyTimestampedHmacSignature` (5-minute replay window), deduplicated in `booking_events` storing `customer_email_sha256` only, and emitting `activity.logged` (`activityType: 'meeting_booked'`) to outbox so `OutreachService.handleOutboxStopCondition` immediately transitions active sequence enrollments to `stopped_meeting`.
