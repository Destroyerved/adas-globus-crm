# ADAS Globus CRM — Production Technical Audit

**Audit date:** 2026-11-18  
**Audited commit:** `6124a39` (`main` on `https://github.com/Destroyerved/adas-globus-crm`)  
**Target scale:** ~40 employees, 15–20 concurrent users, 20,000 companies, 60,000 contacts, 300,000 timeline activities.

---

## 1. Executive Summary

ADAS Globus CRM already has a strong, strict-TypeScript modular monorepo (`packages/config`, `packages/shared`, `apps/api`, `apps/web`) backed by PostgreSQL 17, 12 forward-only SQL migrations (`0001`–`0012`), `pg-boss` background jobs, server-side HttpOnly sessions, Argon2id + TOTP break-glass admin sign-in, SQL-enforced `own`/`team`/`all` capability scoping, CSV/XLSX imports with rollback, duplicate detection and field-by-field merge with undo, audited CSV exports, compliance suppressions, consent tracking, privacy access export/erasure, website inquiry intake with durable routing rules, 150 passing integration tests, and 31 passing Playwright + axe E2E tests.

**However, the repository is not yet production-ready.** The API intentionally refuses to start with `NODE_ENV=production` (`apps/api/src/main.ts` line 795) until external connectors, production infrastructure scripts, security hardening, and operational tooling are completed and verified.

This audit catalogues every completed module, incomplete feature, broken deployment file, prototype remnant, documentation contradiction, security gap, database/performance gap, and the 16-milestone execution plan.

---

## 2. Existing & Completed Functionality (Verified on PostgreSQL 17)

| Area                                      | Implementation                                                                                                                                                                                                                                     | Verification Status                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **PostgreSQL 17 runtime & migrations**    | `apps/api/prisma/migrations/0001`–`0012`, `DatabaseService`, `pg_trgm` + `unaccent`, `pnpm db:local` (`scripts/local-db.mjs`)                                                                                                                      | Verified on PostgreSQL 17 (`localhost:5433`) and PGlite                      |
| **Sessions, CSRF & Entra OIDC code**      | `SessionService` (SHA-256 hashed cookie tokens, 12h idle / 7d max, immediate revocation on user disable), `Origin` CSRF check, `EntraSignIn` PKCE + ID-token verification (`modules/auth/`)                                                        | Sessions & CSRF verified; live Entra login pending tenant credentials        |
| **Emergency Break-Glass Admin**           | `BreakGlassService` (`local_credentials`, Argon2id, AES-256-GCM encrypted TOTP secret, replay-step guard, 5-attempt lockout, IP rate limit, admin alerts, `pnpm break-glass`)                                                                      | Verified in `m1-break-glass.int.test.ts` and Playwright E2E                  |
| **RBAC & SQL Scope Isolation**            | 6 roles, 31 capabilities, `scopeWhere(user, capability)` enforced in SQL across Leads, Contacts, Companies, Deals, Tasks, Imports, Duplicates, Exports, Consents                                                                                   | Verified across `own`, `team`, and `all` scopes                              |
| **Immutable Audit Log & Suppressions**    | `REVOKE UPDATE, DELETE` + `trg_audit_logs_immutable`; `REVOKE DELETE` + `trg_suppressions_no_delete` + `trg_suppressions_privacy_erasure_immutable`                                                                                                | Verified at PostgreSQL trigger & role-grant level                            |
| **Core Lists, Profiles & Timeline**       | Keyset cursor pagination, filter registry, URL state, edit drawers with `version` optimistic concurrency, notes, calls, meetings, tags, tasks (`modules/crm/`)                                                                                     | Verified on 60k-contact dataset (`docs/perf/query-plans-postgres.md`) & E2E  |
| **Role Dashboards & Admin Settings**      | Per-role dashboards (`DashboardService`), Users/Invites, Teams, Roles, Pipelines/Stages, Reference Lists, Suppressions, Market Routing, Audit Log (`modules/admin/`)                                                                               | Verified in `m1-admin-dashboard.int.test.ts` & E2E                           |
| **Imports, Duplicates/Merge & Exports**   | 50 MB CSV/XLSX import with saved mappings, dry-run, 500-row worker chunks & 7-day rollback (`modules/imports/`); duplicate scan & 30-day undoable merge (`modules/duplicates/`); scoped CSV export (`modules/exports/`)                            | Verified on PostgreSQL 17 & Playwright E2E                                   |
| **Compliance, Consent & Privacy**         | `checkSendable()`, `deriveMarketingBasis()`, suppressions lift (`privacy.manage` + reason), corporate domain blocklist, Won-deal 24m `implied_ebr`, JSON/CSV access export, irreversible privacy erasure (`modules/compliance/`)                   | Verified in `m3-compliance-privacy.int.test.ts` & E2E (`A14`)                |
| **Website Intake, Routing & Unsubscribe** | `inquiries` storage with salted `ip_sha256`, `(email, form, day)` dedup, durable `routing_rules`, owner in-app alert, `5/10m` per-IP rate limit, generic `202 {"status":"received"}`, hashed `unsubscribe_tokens.token_sha256` (`modules/intake/`) | Verified in `m4-intake-routing-unsubscribe.int.test.ts` & E2E (`A12`, `A13`) |

---

## 3. Contradictions Between Documentation and Source Code

1. **`docs/PROGRESS.md` lines 108–158 ("Phases 1–6: prototype status"):**
   - States _"Demo logic for these phases exists in `apps/api/src/modules/*` and runs against the in-memory database"_ — **contradicts** `apps/api/src/platform/db/index.ts`, ADR 0003, and ADR 0012 (the running API connects strictly to PostgreSQL via `DATABASE_URL`; PGlite is test-only).
   - Line 116 states _"Sessions, CSRF Origin check... (prototype: sessions written but never read)"_ — **contradicts** `apps/api/src/main.ts` line 505 (`sessions.resolve(...)` enforces sessions on every authenticated route).
   - Lines 131, 141, 146 state _"admin editing not built"_ for reference lists and pipeline stages, and _"Basic dashboard (not built)"_ — **contradicts** `ListsTab`, `PipelinesTab`, and `DashboardScreen`, all of which are built and covered by Playwright tests.
   - Lines 115, 120, 130, 135–137 still say _"not run on real PostgreSQL"_ — **contradicts** the 11–18 Nov 2026 PostgreSQL 17 verification runs logged in the same file.
2. **`README.md` ("What works today"):**
   - Omits Suppressions, Blocked Corporate Domains, Consent & Marketing Basis, Privacy Export/Erasure (M3), and Market Routing Rules / Inquiry Monitoring (M4), and still references a root `ADAS-CRM-Deployer.exe`.
3. **`.github/workflows/release.yml` line 57:**
   - Labels release notes _"Production Release (Phases 0–6 Complete)"_ while `apps/api/src/main.ts` refuses `NODE_ENV=production` and `scripts/deploy.sh` / `scripts/restore-drill.sh` are 5-line stubs.
4. **Tracked binary in Git root (`ADAS-CRM-Deployer.exe`):**
   - Tracked in Git despite `AGENTS.md` §11 (_"Commit Prisma migrations and the OpenAPI snapshot; don't commit other generated output"_), and `scripts/build-deployer-exe.mjs` exited with code `1` on Linux if that root `.exe` was absent.

---

## 4. Broken & Prototype Remnants Found in Code

1. **`infra/deployer/AdasCrmDeployer.cs`:**
   - **Hardcoded DB credentials:** Lines 197–198 write `postgresql://adas_app:adas_prod_password@postgres:5432/adas_crm` and `adas_admin:adas_admin_password` into `.env.production`, ignoring the generated `secrets/postgres_password.txt`.
   - **Broken container networking in Cloudflare Tunnel config:** Lines 148–154 write `service: http://localhost:3000`, `localhost:3001`, and `localhost:5678` into `infra/cloudflare/config.yml`. Inside the `adas-crm-cloudflared` container (`infra/compose.prod.yml`), `localhost` resolves to the `cloudflared` container itself rather than `http://api:3000`, `http://uptime-kuma:3001`, and `http://n8n:5678`.
   - **Destructive overwrite:** Line 215 calls `File.WriteAllText(envProdPath, ...)` unconditionally, overwriting any existing `.env.production` customizations.
   - **Windows-only WinForms binary:** No hardware/CPU/RAM/disk preflight, no Docker health verification, no database migration runner, no initial break-glass admin wizard, no rollback, no uninstaller, and no Linux server installer.
2. **`infra/compose.prod.yml`:**
   - `worker` overrides `command: ["node", "apps/api/dist/worker.js"]` **without** `--conditions=production-dist`, whereas `@adas/shared` resolves `./src/index.ts` unless `production-dist` is active (causing `ERR_MODULE_NOT_FOUND` in the production container!).
   - Uses mutable image tags (`cloudflare/cloudflared:latest`, `louislam/uptime-kuma:1`).
   - Initializes PostgreSQL with `POSTGRES_USER: adas_app` without creating the separate `adas_admin` migration owner vs least-privilege `adas_app` runtime role, and has no migration init service or backup container.
3. **`scripts/deploy.sh` & `scripts/restore-drill.sh`:**
   - Both files are placeholder `echo` stubs (12 lines and 5 lines respectively) with zero deployment, smoke-check, rollback, backup, or restore logic.
4. **Prototype remnants in `apps/api/src/modules/outreach/index.ts` & `intelligence/index.ts`:**
   - `OutreachService.runN8nMarketingPipeline` (lines 878–1000) is an unused prototype method containing a hardcoded secret `'whsec_adas_n8n_dev_secret_2026'` and fallback ID `'cnt_jane'`.
   - `OutreachService.listSequences()` and `listCampaigns()` do not apply `scopeWhere(user, ...)` in SQL.
   - `IntelligenceService.dispatchPendingOutboxEventsToWebhooks()` computes HMAC signatures in memory and marks `outbox_events` as `'processed'` without actually performing HTTP `POST` requests, recording delivery status codes, or retrying failed webhook deliveries!
   - `MailpitTransport` is currently the only mail transport implementation; real `MicrosoftGraphMailboxProvider` and `EspBulkSender` adapters are not built yet.

---

## 5. Incomplete CRM, Integration, Infrastructure & Desktop Features

### 5.1 Security & Authentication Gaps (Milestone 2)

- Strict HTTP security headers (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`) are missing on API JSON responses and CSP is missing on SPA responses.
- Cloudflare Access JWT verification (`Cf-Access-Jwt-Assertion` against `CF_ACCESS_TEAM_DOMAIN` JWKS and `CF_ACCESS_AUD` when `CF_ACCESS_ENFORCE=true`) is configured in `.env.example` but unimplemented.
- Per-user rate limiting on authenticated `/api/v1/*` endpoints (`PRD 6.7`) and scoped `/api/v1/users` directory access need enforcement.
- Internal OpenAPI documentation route `GET /api/docs` (`PRD 6.7`, `AGENTS.md §6`, `crm.` host only) is not wired in `main.ts`.
- Scoped API token authentication (`Authorization: Bearer adas_pat_...`, `PRD 4.14, 9`) is stored in `api_tokens` but never authenticated in `main.ts`.

### 5.2 Core CRM Module Gaps (Milestone 3)

- **Saved Views (`PRD 4.5, 4.6, 4.8`):** `saved_views` table exists in SQL, but CRUD routes and UI selector/save controls on Leads, Contacts, Companies, and Deals lists are missing.
- **Bulk Actions (`PRD 4.5, 6.7`, `DESIGN 6.5`):** Multi-row selection, floating navy bulk-action bar, `POST /api/v1/{leads,contacts,companies,deals}/bulk` (`assign`, `status`, `addTag`, `removeTag`, `delete`), and background worker job above 500 records are missing.
- **Lead Management (`PRD 4.5`):** Interactive Lead Conversion Drawer (choosing pipeline, stage, deal name, monthly value, currency, engagement model, FTEs, or linking an existing deal) and configurable Lead Scoring (`Settings → Scoring` + automatic score & breakdown calculation on Lead and Contact profiles) are missing.
- **Contact & Company Management (`PRD 4.3, 4.4, 4.17`):** Secondary email/phone management on Contact profile, Contact local time display in header, Custom Fields definitions (`Settings → Custom fields`) and values on Company/Contact/Lead/Deal records, and "Merge with…" action from Contact/Company profiles (`ADR 0009`) are missing.
- **Deal Management (`PRD 4.6`):** Deal stakeholder contacts with roles (`deal_contacts`), keyboard-accessible Kanban drag-and-drop (`DESIGN 6.8`), and FX rate management (`Settings → Currencies / FX`) are missing.
- **Task Management (`PRD 4.7`):** Recurring tasks (`daily`, `weekly`, `biweekly`, `monthly`, `business_days` spawning next occurrence on completion), Team tasks view for managers, and Week/Month Calendar view are missing.

### 5.3 Dashboard & Standard Reports Gaps (Milestone 4)

- Dashboard KPI period-over-period comparison chips (`▲/▼` vs previous period, `ADR 0005`), total companies & contacts counts, and lead conversion rate.
- Dedicated **Reports** module (`PRD 4.15, 14`): Lead funnel & sources, Pipeline by stage & owner, Won/Lost & reasons, Revenue won by owner & service, Inquiry first-response SLA, Employee activity & performance, and Campaign/Sequence deliverability — with date/market/team/owner filters, chart/table toggle, and audited CSV export.

### 5.4 Microsoft 365 & Graph Integration Gaps (Milestone 5)

- Real `MicrosoftGraphMailboxProvider`: OAuth2 delegated connect/disconnect flow, AES-256-GCM versioned token encryption & refresh, `sendMail` / `createReply`, 90-day initial + delta sync (`Inbox` & `SentItems`) obeying the CRM participant/domain sync rule (`PRD 4.11`), Graph webhook notifications (`/api/v1/webhooks/microsoft` with `clientState`) & subscription renewal job, attachment metadata + on-demand download, `429 Retry-After` backoff, and the **Inbox** UI screen + unified email threads on Contact, Company, Lead, and Deal timelines.

### 5.5 Email Automation, Sequences & Campaigns Gaps (Milestone 6)

- Real `EspBulkSender` provider abstraction (Amazon SES / Postmark / HTTP ESP + `MailpitTransport` in non-production, gated on `NODE_ENV=production && MAIL_LIVE=true && compliance.counsel_signed_off=true`).
- Signed ESP webhook receiver (`/api/v1/webhooks/esp`) with idempotent `inbound_events` deduplication, hard/soft bounce & complaint handling, and `/c/:token` stored-URL click redirect (`PRD 8.6`).
- `sequence.tick`, `campaign.tick`, and `send.message` pg-boss worker schedules with row-level `FOR UPDATE SKIP LOCKED` locking, send-window jitter, mailbox daily caps, 3-business-day frequency cap, templates, dynamic segments/static lists, and full **Sequences** & **Campaigns** UI screens.

### 5.6 Apollo, Webhooks & API Tokens Gaps (Milestone 7)

- Real `ApolloClient` adapter (company search, people search, enrichment with upfront credit-cost confirmation, `apollo_credit_ledger` cap, `external_ids` / `apollo_person_id` dedup, zero-consent / suppression-safe import), real HTTP webhook delivery worker with HMAC-SHA256 + 5-min timestamp + exponential backoff + delivery logs, and `Settings → Integrations` UI.

### 5.7 Worker Reliability, Database Load Testing, Infra, Installer & Electron Desktop App (Milestones 8–16)

- **Milestone 8:** Worker heartbeat table, `/healthz` deep readiness (DB, pg-boss, worker heartbeat, outbox lag, backup age), dead-letter admin alerts + retry/purge UI, graceful shutdown drain.
- **Milestone 9:** `custom_fields` GIN indexes, missing foreign-key/composite indexes, connection pool tuning, and real concurrent HTTP load testing (`k6` / concurrent load harness against 20k companies, 60k contacts, 300k activities on PostgreSQL 17).
- **Milestone 10 & 14:** Fixed `infra/compose.prod.yml`, pinned container versions, `adas_admin`/`adas_app` provisioning, AES-256-GCM encrypted backup & off-site sync scripts, automated restore verification drill (`scripts/restore-drill.sh` + cross-platform runner verified against real PostgreSQL 17), and `scripts/deploy.sh` with automatic rollback.
- **Milestone 11:** Cross-platform **One-Click Server Installer** (`installer/`: OS/CPU/RAM/disk/Docker preflight, interactive wizard & CLI, Windows `.exe` + Linux `install.sh`, non-destructive `.env.production` & secret generation, DB init & migrations, initial admin setup, health verification, safe upgrade, rollback, and uninstaller with preserve/remove data prompt).
- **Milestones 12 & 13:** Narrowly scoped authenticated **Server Management Agent** (`apps/server-agent`, local + remote TLS/Bearer pairing, RBAC, audit log, zero arbitrary shell execution) and standalone **Electron Desktop Server Management Application** (`apps/desktop`, `contextIsolation: true`, `nodeIntegration: false`, strict preload IPC bridge, multi-server profiles, live telemetry, service controls, deploy/rollback, live log viewer & diagnostics export, encrypted backup/restore UI, connector/tunnel health, and validated config editor).
- **Milestones 15 & 16:** Full security test suite (auth bypass, privilege escalation, IDOR, CSRF, SQLi, XSS, rate-limit, export caps, secret redaction, management API abuse), complete documentation suite (`DEPLOYMENT.md`, `DISASTER_RECOVERY.md`, `SECURITY.md`, `INTEGRATIONS.md`, `OPERATIONS.md`, `INSTALLATION.md`, `ELECTRON_MANAGEMENT.md`, `PRODUCTION_READINESS_REPORT.md`), and removal of the `NODE_ENV=production` startup block once all internal readiness gates are satisfied (while preserving live-mail safety gates until counsel/owner credentials are configured).

---

## 6. Implementation Priority Order

1. **Milestone 1:** Repository audit (`docs/PRODUCTION_AUDIT.md`), `PROGRESS.md`/`README.md` reconciliation, and removal of tracked binary build output from Git root.
2. **Milestone 2:** Security & authentication hardening (CSP/HSTS headers, Cloudflare Access JWT verifier, per-user rate limiting, scoped API tokens, `/api/docs`, security penetration integration suite).
3. **Milestone 3:** Complete CRM modules (Saved Views, Bulk Actions, Custom Fields, Lead Conversion Drawer, Lead Scoring, Contact multi-email/phone + local time + Merge button, Deal stakeholder roles + Kanban keyboard drag/drop + FX settings, Recurring Tasks + Calendar + Team tasks).
4. **Milestone 4:** Dashboard period-over-period comparisons & full Standard Reports screen with CSV export.
5. **Milestone 5:** Microsoft 365 & Microsoft Graph integration + Inbox UI + unified record email timelines.
6. **Milestone 6:** Email automation, Sequences & Campaigns engine + ESP adapter + Segments/Templates UI.
7. **Milestone 7:** Apollo integration + Outbound Webhooks delivery worker + API Tokens UI.
8. **Milestone 8:** Background worker heartbeats, dead-letter recovery, deep `/healthz`, graceful drain.
9. **Milestone 9:** Database optimization & concurrent load testing against the 60k-contact dataset on PostgreSQL 17.
10. **Milestone 10 & 14:** Production Docker stack fixes, `deploy.sh`, encrypted backups, and verified restore drill on PostgreSQL 17.
11. **Milestone 11:** Cross-platform One-Click Server Installer (Windows + Linux wizard, upgrade, rollback, uninstall).
12. **Milestones 12 & 13:** Authenticated Server Management Agent (`apps/server-agent`) + Electron Desktop Server Management Application (`apps/desktop`) with local & remote server profiles.
13. **Milestones 15 & 16:** End-to-end security/acceptance verification, complete operations documentation, and `docs/PRODUCTION_READINESS_REPORT.md`.
