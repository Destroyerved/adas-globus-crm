# 0014: Website inquiry intake, durable market routing rules & public host guardrails

**Date:** 2026-11-18
**Status:** Accepted
**PRD references:** 4.3, 4.5, 4.10, 4.17, 4.18, 5.3, 5.5, 6.5, 8.6, 9, 12.1 (A4, A12, A13), 15 (Q10, Q13)

## Context

The initial `WebsiteIntakeService` kept its round-robin counter in process memory, hardcoded team IDs, did not store raw submissions in an `inquiries` table, omitted owner in-app notifications, lacked per-IP rate limiting on `/api/v1/public/inquiries`, echoed internal record IDs and honeypot outcomes in the public HTTP body, and stored raw unsubscribe tokens in `unsubscribe_tokens.token`.

## Decisions

1. **Raw `inquiries` storage, consent linkage & privacy lifecycle (`PRD 4.10, 4.18, 5.3`):**
   - Every valid submission writes an `inquiries` row with a `dedup_key` (`sha256(email + ':' + formType + ':' + utcDay)`), sanitised `raw_payload`, salted `ip_sha256` (never raw IP), and links `consent_records.inquiry_id`.
   - Subject-access exports (`JSON` and `CSV`) include `inquiries`; privacy erasure scrubs `raw_payload`, `user_agent`, and `page_url` while keeping row counts for SLA reporting; `housekeeping.purge` deletes `inquiries` older than 24 months (`Q10` default).
   - Free-mail inquiries that include a `firm` name match or create a company with `domain = NULL` and `website = NULL` (`PRD 4.3, 4.10, A4`); free-mail inquiries without a firm name leave `company_id = NULL`.
   - Active `privacy_erasure` tombstones drop re-creation of personal records without changing the public response; other active suppressions mark `contacts.do_not_contact = TRUE` and skip recording active consent (`PRD 5.6`: suppression always wins).

2. **Durable `routing_rules` (`PRD 4.5, 4.10, 4.17, Q13`):**
   - One row per market (`US`, `CA`, `OTHER`) in `routing_rules`, locked with `FOR UPDATE` inside the intake transaction.
   - `round_robin` rotates across active team members whose effective `leads.write` capability is not `'none'` (excluding read-only analysts) and persists `last_assigned_user_id` in PostgreSQL so restarts and multiple processes advance fairly.
   - `named_owner` assigns to a chosen active writer, falling back cleanly if that user is later deactivated.
   - Managed in `Settings → Routing` (`settings.manage`), protected by `version` optimistic concurrency, and audited (`routing_rule.updated`).

3. **Public host anti-abuse & zero-leak response (`PRD 4.10, 6.5, 9`):**
   - `POST /api/v1/public/inquiries` always responds `202 {"status":"received"}` for accepted, deduplicated, honeypot-dropped, and erasure-blocked submissions alike.
   - `public_rate_events` enforces a database-backed per-IP limit (`INQUIRY_RATE_LIMIT_PER_10M`, default `5` per 10 minutes) using salted `ip_sha256`, returning `429 RATE_LIMITED` with `Retry-After: 600`; `housekeeping.purge` deletes rate events older than 1 hour.

4. **Hashed unsubscribe tokens (`PRD 8.6, A12`):**
   - `createUnsubscribeToken` generates 192-bit `unsub_<hex>` tokens and stores only `token_sha256` in `unsubscribe_tokens` (`token` holds a non-secret `utk_<uuid>` primary key). Lookups match `token_sha256 = $1 OR (token_sha256 IS NULL AND token = $2)` for expand-then-contract compatibility.
