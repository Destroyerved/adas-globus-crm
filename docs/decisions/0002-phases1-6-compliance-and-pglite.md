# ADR 0002: Phases 1–6 Compliance Gate, Append-Only Database Guards, and In-Process PostgreSQL 17

- **Status:** Accepted
- **Date:** 2026-11-04
- **References:** `PRD.md` §3, §4, §5, §7, §8, §9, §12.1; `AGENTS.md` §5, §7, §8, §10

## Context

ADAS CRM requires strict enforcement of:

1. **Single-gate outbound email compliance (`PRD §5.1–5.4`):** Every commercial and sequence/campaign send must pass `checkSendable()` inside the `send.message` job (the sole writer to `message_sends`), enforcing U.S. CAN-SPAM and Canadian CASL (`express`, `implied_inquiry` 6-month expiry, `implied_ebr` 24-month expiry, `implied_published`) as data-driven market rules (`MARKET_COMPLIANCE_RULES`), with immediate RFC 8058 one-click unsubscribe and suppression precedence (`Suppression always wins`).
2. **Row-level capability scopes in SQL (`PRD §3.3`):** Every query for a scoped entity (`leads`, `companies`, `contacts`, `deals`, `tasks`, `email_threads`) must apply `scopeWhere(user, capability)` (`own`, `team`, `all`) directly in SQL.
3. **Database-enforced immutability (`PRD §5.3, §7.4, §9`):** `audit_logs` must reject `UPDATE` and `DELETE`, and `suppressions` must reject `DELETE`, enforced at the PostgreSQL layer.
4. **Zero-Docker local and CI portability (`PRD §7.4`):** Integration tests (`pnpm test:int`) must execute against a real PostgreSQL 17 engine with `pg_trgm` and `unaccent` extensions even on developer machines where Docker Desktop is not running.

## Decision

1. **`DatabaseService` with PostgreSQL 17 (`@electric-sql/pglite` + `0001_initial_schema/migration.sql`):**
   - Loads `pg_trgm` and `unaccent` extensions and applies the full PostgreSQL DDL (`0001_initial_schema/migration.sql`) including partial unique indexes (`idx_companies_domain_active`, `idx_contacts_primary_email_active`), trigram `GIN` indexes, `adas_app` role grants (`REVOKE UPDATE, DELETE ON audit_logs`, `REVOKE DELETE ON suppressions`), and `plpgsql` `BEFORE UPDATE OR DELETE` / `BEFORE DELETE` triggers (`trg_audit_logs_immutable`, `trg_suppressions_no_delete`).
2. **`checkSendable()` and `OutreachService.executeSendMessageJob()`:**
   - Implemented `MARKET_COMPLIANCE_RULES` as a static data table in `apps/api/src/modules/compliance/index.ts`.
   - `OutreachService.executeSendMessageJob()` is the only method that inserts into `message_sends` and always invokes `evaluateRecipientSendability()` (`checkSendable()`) and `MailpitTransport` (`MAIL_LIVE=false` outside production).
3. **Privacy Erasure with SHA-256 Suppression Retention (`PRD §5.5`):**
   - When erasing a contact (`eraseContactPrivacyData`), cleartext PII is redacted on `contacts`, `leads`, and `email_messages`, aggregate deal financials are preserved, and `suppressions.email` is set to `NULL` while `suppressions.email_sha256` is retained permanently so the erased address can never be re-imported or mailed.
