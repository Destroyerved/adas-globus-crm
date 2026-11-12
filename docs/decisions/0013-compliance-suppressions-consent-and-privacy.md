# ADR 0013: Suppressions, consent basis and privacy erasure

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

PRD sections 4.17, 4.18, 5.1–5.6 and 9 require:

1. An append-only `suppressions` table where `DELETE` is revoked from the application database role (`AGENTS.md` sections 5 and 8), yet an authorised administrator can lift a non-erasure suppression with a written reason and audit entry (PRD 4.18, 5.5).
2. A permanent, irreversible SHA-256 suppression (`reason = 'privacy_erasure'`, `email = NULL`) when a contact's personal data is erased, so future manual creates and CSV/XLSX imports never recreate or contact that address (PRD 4.18, 12.1 A14), while deal revenue totals and activity counts stay intact for financial reporting.
3. A clear separation between day-to-day compliance operations (viewing and adding suppressions or recording consent) and high-risk privacy actions (lifting a suppression, removing a corporate domain block, exporting a full personal-data archive, or erasing a contact).

## Decision

1. **Lifting without deleting (`0011_compliance_and_privacy`).** `suppressions` gains `lifted_at`, `lifted_by` and `lifted_reason`. Active suppressions have `lifted_at IS NULL`; lifting sets those three columns and writes `compliance.suppression_lifted` to `audit_logs` (storing `emailSha256`, never the raw address). `REVOKE DELETE ON suppressions FROM adas_app` and `trg_suppressions_no_delete` remain untouched. Re-suppressing an address clears the lift columns on the existing row and updates its reason and timestamp.
2. **Database-enforced permanence for privacy erasure.** Check constraint `chk_suppressions_privacy_erasure_permanent` requires `email IS NULL AND lifted_at IS NULL` whenever `reason = 'privacy_erasure'`, and `BEFORE UPDATE` trigger `trg_suppressions_privacy_erasure_immutable` rejects any attempt to modify a `privacy_erasure` row or lift it—even from SQL.
3. **Separate `privacy.manage` capability.** `compliance.manage` (granted to Admin, Sales Manager and Marketing Manager) allows viewing and adding suppressions and blocked corporate domains. `privacy.manage` (granted only to Admin by default, and locked on the Admin role alongside `users.manage`, `settings.manage` and `audit.read`) is required to lift a suppression, remove a domain block, download a contact's JSON/CSV personal-data archive, or execute privacy erasure.
4. **Single derived marketing basis (`deriveMarketingBasis` in `@adas/shared`).** Both the API (`contactProfile`) and the web UI derive a contact's marketing basis (`Express`, `Implied`, `US B2B outreach only`, or `None`) from the same pure function over market, suppression/bounce/do-not-contact state, and the latest `consent_records` row. Moving a deal to `Won` automatically records a 24-month `implied_ebr` consent for unsuppressed contacts at that client who do not already hold active express consent or a revoked consent record (PRD 5.3).
5. **Erasure preserves reporting counts and blocks re-entry.** `eraseContactPrivacy` runs in one transaction: it hashes every email on the contact and any linked leads into `suppressions` (`email = NULL`, `reason = 'privacy_erasure'`), scrubs names, emails, phones and free-text fields on `contacts` (soft-deleted), `leads`, `activities` (keeping the rows so activity counts stay accurate), `tasks`, `email_messages` and `email_threads`, deletes `notes`, `record_history`, `contact_emails`, `contact_phones`, `consent_records`, `unsubscribe_tokens` and open `duplicate_candidates`, detaches `deals.primary_contact_id` while leaving deal amounts untouched, and audits `privacy.erasure` with zero personal data. Manual contact/lead create and update paths plus `ImportProcessor` check `email_sha256` against active `privacy_erasure` suppressions so erased addresses cannot re-enter.

## Consequences

- **Audit logs stay free of personal data.** Compliance and privacy audit entries record contact IDs, suppression IDs, SHA-256 hashes, counts and operator reasons—never email addresses, names or phone numbers.
- **No `pgcrypto` dependency.** SHA-256 hashing is performed in Node (`sha256Hex`) before querying `suppressions.email_sha256`, so queries behave identically on PostgreSQL 17 and PGlite.
- **Corporate domain blocks refuse free-mail domains.** Blocking `gmail.com` or `outlook.com` in `suppressed_domains` is rejected with `422 FREE_MAIL_DOMAIN` using the shared free-mail list (`platform/normalize`).
