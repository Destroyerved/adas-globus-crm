# Day-2 Operations & Administration Runbook

This runbook covers ongoing monitoring, dead-letter triage, user offboarding, encryption key rotation, privacy requests, and the Bigin CRM cutover procedure (`PRD §4.18, §10.6, §13`).

---

## 1. Monitoring & Health Thresholds (`PRD §10.6`, `ADR 0023`)

### Internal & External Uptime Checks

1. **Uptime Kuma (`status.adasglobuspro.com`):**
   - Monitor `http://api:3000/healthz?strict=1` every `60` seconds.
   - `/healthz?strict=1` returns HTTP `200` when `status === "ok"` and HTTP `503` if any subsystem degrades:
     - PostgreSQL 17 unreachable (`status === "down"`),
     - No active `worker_heartbeats` row within `180s`,
     - Oldest pending `outbox_events` row older than `300s` (5 minutes),
     - Non-zero dead-letter `outbox_events` (`status = 'dead_letter'`),
     - Latest successful `backup_runs` older than `26h` (in production), or
     - Active `mailbox_connections` Graph subscriptions expiring within `12h`.
2. **External Out-of-Box Check:**
   - Configure an external monitor (Cloudflare Health Checks / Better Stack / UptimeRobot) on `https://go.adasglobuspro.com/healthz` so a complete office power/ISP/tunnel outage triggers email + Microsoft Teams alerts immediately.

---

## 2. Dead-Letter Queue Triage (`Settings → System health`)

When an outbox handler fails `10` consecutive attempts with exponential backoff:

1. It moves to `status = 'dead_letter'` (scrubbing any PII from `last_error`) and dispatches a `security` notification to all active `Admin` users.
2. Open **Settings → System health** -> **Dead-letter outbox events**.
3. Inspect the event type, aggregate ID, and redacted error code:
   - Click **Retry** once the downstream issue is resolved (`outbox.dead_letter_retried` is written to `audit_logs`), or
   - Click **Dismiss** with a documented reason if the event is obsolete (`outbox.dead_letter_dismissed` is written to `audit_logs`).

---

## 3. Immediate Employee Offboarding

1. Open **Settings → People**, select the employee, and change status to **Disabled** (optionally reassigning open records or moving team ownership).
2. Disabling a user atomically:
   - Revokes **all** active browser sessions in `sessions`,
   - Invalidates **all** `Bearer adas_pat_...` service tokens created by that user,
   - Pauses any active personal outreach sequences sending from their mailbox, and
   - Records `user.updated` in `audit_logs`.
3. Also disable the account in **Microsoft Entra ID** so Cloudflare Access rejects edge requests immediately.

---

## 4. Rotating `TOKEN_ENCRYPTION_KEY_FILE` (`SecretBox` Key Versioning)

`SecretBox` (`apps/api/src/platform/crypto/secret-box.ts`) prefixes every ciphertext with `v<version>:` (`mailbox_connections`, `local_credentials`, `webhook_endpoints`):

1. Keep the previous key in `TOKEN_ENCRYPTION_PREVIOUS_KEYS="1:<old_secret>"` while writing the new 256-bit secret to `secrets/token_encryption_key.txt` and incrementing `TOKEN_ENCRYPTION_KEY_VERSION=2` in `.env.production`.
2. Restart `api` and `worker` (`SecretBox` transparently decrypts `v1:` ciphertexts and seals all new/refreshed writes under `v2:`).
3. Once all active rows carry `key_version = 2`, remove `TOKEN_ENCRYPTION_PREVIOUS_KEYS`.

---

## 5. Emergency Break-Glass Admin Management (`PRD §6.6`)

Maximum `2` active Admin accounts may hold Break-Glass credentials at any time:

```bash
# Grant or rotate Break-Glass password + TOTP secret
docker compose -f /opt/adas-crm/infra/compose.prod.yml run --rm --no-deps api \
  node --conditions=production-dist apps/api/dist/cli/break-glass.js set ops-admin@adasglobuspro.com

# Revoke Break-Glass access
docker compose -f /opt/adas-crm/infra/compose.prod.yml run --rm --no-deps api \
  node --conditions=production-dist apps/api/dist/cli/break-glass.js remove ops-admin@adasglobuspro.com
```

---

## 6. Privacy Access Export & Erasure (`PRD §4.18`)

- **Subject Access Export:** Open the Contact profile -> **Privacy & personal data** -> **Download JSON** or **Download CSV** (UTF-8 BOM + spreadsheet formula neutralization; audited in `audit_logs` without PII).
- **Right to Erasure:** Click **Erase personal data** and confirm. Scrubs personal fields, notes, message bodies, raw inquiry payloads, and record history while preserving aggregated deal financials, activity counts, and an unliftable SHA-256 `privacy_erasure` tombstone in `suppressions` that blocks future API or CSV/XLSX re-import.

---

## 7. Bigin CRM 10-Step Cutover Checklist (`PRD §13`)

1. Export all Bigin modules and store encrypted outside this repository (`AGENTS.md §5`).
2. Record exact Bigin counts and per-stage deal totals.
3. Audit contact/company/deal relationships and orphans.
4. Sign off field-mapping template with the Sales Manager.
5. Import legacy contacts (`~60,000`) with source `Bigin (legacy)`, tag `legacy-2026`, and **zero** `consent_records` (searchable & deduplicated, not mailable until basis is earned).
6. Run full dry-run import on staging (`companies` -> `contacts` -> `deals` -> `activities`).
7. Reconcile record counts and deal stage totals (`0` variance on deals/values) + spot-check 50 records.
8. Freeze Bigin writes -> run final delta import -> reconcile production counts.
9. Operate exclusively in ADAS CRM for 2 weeks with Bigin set to read-only.
10. Export final Bigin archive and retire Bigin after written owner sign-off.
