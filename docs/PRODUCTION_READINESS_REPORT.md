# ADAS Globus CRM — Production Readiness Report

- **Date:** 18 November 2026
- **Repository:** `Destroyerved/adas-globus-crm`
- **Target Scale:** ~40 named employees (15–20 concurrent), 20,000 companies, 60,000 contacts, 300,000 timeline activities (`PRD §1.5, §10.1, §12.2`)

---

## 1. Executive Summary

All **16 engineering milestones** of the ADAS Globus CRM platform—spanning core CRM modules, saved views & bulk actions, custom fields & explainable lead scoring, deal Kanban & recurring tasks, role dashboards & standard reports, Microsoft 365 Graph Inbox, multi-step outreach sequences & ESP campaigns, compliance & privacy erasure, Apollo/Bookings/outbound webhooks, worker heartbeats & deep `/healthz`, full-text search & 20-VU load benchmarking, hardened Docker Compose & encrypted S3 backups/restore drills, cross-platform one-click server installers, the authenticated `@adas/server-agent`, and the standalone Electron Desktop Server Management Console (`@adas/desktop`)—are **built, integrated, and verified against real PostgreSQL 17 and Chromium Playwright + axe-core**.

In strict accordance with `AGENTS.md §5`, **external live sends remain locked off (`MAIL_LIVE=false`)** and items requiring owner-provisioned external accounts or physical server deployment are transparently listed in **Section 5 (Owner Go-Live Checklist)** rather than marked verified in production.

---

## 2. Monorepo Package Inventory

| Package / Path                             | Purpose                                                                                                                                                                                     | Build & Verification Status                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/shared` (`@adas/shared`)         | Shared `zod` schemas, capabilities, market compliance rules, formatters, email HTML sanitizer                                                                                               | Built & unit-tested                                                                   |
| `packages/config` (`@adas/config`)         | Strict TypeScript, Prettier, and ESLint module-boundary presets (`platform/` vs `modules/`)                                                                                                 | Enforced (`0` warnings)                                                               |
| `apps/api` (`@adas/api`)                   | HTTP API, static SPA host, `pg-boss` background worker, 23 forward-only SQL migrations, CLI tools (`migrate`, `backup`, `break-glass`), OpenAPI generator                                   | Built; 27 integration suites verified on PostgreSQL 17                                |
| `apps/web` (`@adas/web`)                   | React + Vite + TanStack Query + Tailwind v4 + `DESIGN.md` tokenized UI across all CRM, Inbox, Outreach, Reports & Settings screens                                                          | Built; 39 Playwright + axe E2E flows passing at `1440px` & `375px`                    |
| `installer` (`@adas/installer`)            | Hardware/Docker/port preflight, idempotent non-destructive provisioner, loopback CSRF wizard, plus `installer/install.sh` & `ADAS-CRM-Deployer.exe`                                         | Built & verified (`installer.test.ts` + `.exe` test)                                  |
| `apps/server-agent` (`@adas/server-agent`) | Authenticated server management daemon (single-use SHA-256 pairing, `HMAC-SHA256` + replay cache, `viewer`/`operator`/`admin` RBAC, hash-chained `agent-audit.jsonl`, zero shell execution) | Built & verified (`server-agent.test.ts`)                                             |
| `apps/desktop` (`@adas/desktop`)           | Standalone Electron Desktop Server Management Console (`contextIsolation: true`, `sandbox: true`, `connect-src 'none'`, `ServerProfileVault`)                                               | Built & verified (`desktop-console.test.ts` + Playwright + axe at `1440px` & `375px`) |
| `infra/` & `scripts/`                      | Hardened `Dockerfile.api`, `compose.prod.yml`, `00-provision-roles.sh`, `deploy.sh`, `restore-drill.sh`, `k6` load script, `n8n` workflows, `systemd` service                               | Verified locally; awaits physical Ubuntu host (`R8`)                                  |

---

## 3. Acceptance Test Matrix (`PRD §12.1 A1–A21`)

| ID    | Requirement                                                                                      | Automated Test Evidence (Verified on PostgreSQL 17)                                                                                                              | Status                  |
| ----- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `A1`  | Import 10,000 contacts from XLSX in background (`< 5 min`) while UI stays responsive             | `ms15-10k-xlsx-and-security-acceptance.int.test.ts`: **31.08s–39.78s** background run (`64.22s–86.17s` including 10k dry-run); concurrent `/healthz` `<= 114 ms` | **PASS**                |
| `A2`  | Import with 500 existing duplicates + 50 internal duplicates; exact policy & zero double-creates | `ms15-10k-xlsx-and-security-acceptance.int.test.ts` & `m2-imports.int.test.ts` (`created: 9450, updated: 500, duplicate: 50, error: 0`)                          | **PASS**                |
| `A3`  | Roll back an import within 7 days; preserve records edited since                                 | `m2-imports.int.test.ts` & `e2e/live-crm.spec.ts`                                                                                                                | **PASS**                |
| `A4`  | Create company + 10 contacts; free-mail contacts never set company domain                        | `phases1-6-acceptance.int.test.ts` & `m4-intake-routing-unsubscribe.int.test.ts`                                                                                 | **PASS**                |
| `A5`  | Merge two companies with contacts, deals & activities; undoable + audited                        | `m2-duplicates.int.test.ts`                                                                                                                                      | **PASS**                |
| `A6`  | Global search `"acme"` across 60k contacts & 20k companies `< 300 ms` p95 with SQL scope         | `pnpm perf:load` on PostgreSQL 17 (`docs/perf/load-test-postgres.md`: search p95 **`226.5 ms`**) & `ms9-fulltext-search.int.test.ts`                             | **PASS**                |
| `A7`  | Move deal through every stage to `Won`; required fields, history, FX snapshot & reports          | `phases1-6-acceptance.int.test.ts`, `ms3c-deals-tasks-fx.int.test.ts`, `ms4-dashboard-and-reports.int.test.ts`, & Playwright E2E                                 | **PASS**                |
| `A8`  | Assign lead to Sales Executive (`own` vs `team` vs `all` SQL enforcement)                        | `m1-lists-editing.int.test.ts`, `phases1-6-acceptance.int.test.ts`, `ms15-10k-xlsx-and-security-acceptance.int.test.ts`                                          | **PASS**                |
| `A9`  | Follow-up scheduled in assignee IANA zone; IST user vs Toronto contact `"Today"`                 | `m1-worker.int.test.ts`, `ms3c-deals-tasks-fx.int.test.ts`, `m1-admin-dashboard.int.test.ts`                                                                     | **PASS**                |
| `A10` | Send 1:1 email from contact profile -> timeline & Sent Items                                     | `ms5-microsoft-graph-inbox.int.test.ts` & `e2e/live-crm.spec.ts` (Mailpit outside prod; live Outlook awaits `R5`)                                                | **PASS (Dev/Protocol)** |
| `A11` | Prospect replies -> thread links to contact & stops active sequence                              | `ms5-microsoft-graph-inbox.int.test.ts` & `phases1-6-acceptance.int.test.ts`                                                                                     | **PASS**                |
| `A12` | One-click unsubscribe (`/u/:token`) adds immediate suppression & blocks sends                    | `m4-intake-routing-unsubscribe.int.test.ts` & `phases1-6-acceptance.int.test.ts`                                                                                 | **PASS**                |
| `A13` | Website trial form creates lead, company, contact, consent & SLA task; deduplicates same-day     | `m4-intake-routing-unsubscribe.int.test.ts` & `e2e/live-crm.spec.ts`                                                                                             | **PASS**                |
| `A14` | Privacy erasure removes PII, keeps hashed tombstone & deal financials, blocks re-import          | `m3-compliance-privacy.int.test.ts` & `e2e/live-crm.spec.ts`                                                                                                     | **PASS**                |
| `A15` | Provider `500` mid-send retries safely without duplicate send (`idempotency_key`)                | `phases1-6-acceptance.int.test.ts` & `ms6-sequences-campaigns-esp.int.test.ts`                                                                                   | **PASS**                |
| `A16` | Canadian contact with no consent skipped with `no_marketing_basis`                               | `check-sendable.test.ts` & `ms6-sequences-campaigns-esp.int.test.ts`                                                                                             | **PASS**                |
| `A17` | Contact in active sequence rejected from second sequence (`in_other_active_sequence`)            | `ms6-sequences-campaigns-esp.int.test.ts`                                                                                                                        | **PASS**                |
| `A18` | Mailbox daily cap (`50/day`) rolls remaining sends to next business window                       | `ms6-sequences-campaigns-esp.int.test.ts`                                                                                                                        | **PASS**                |
| `A19` | Campaign creator cannot approve their own campaign                                               | `ms6-sequences-campaigns-esp.int.test.ts` & `e2e/live-crm.spec.ts`                                                                                               | **PASS**                |
| `A20` | Hard-bounce rate `> 3%` after 200 deliveries auto-pauses campaign & notifies owner               | `ms6-sequences-campaigns-esp.int.test.ts`                                                                                                                        | **PASS**                |
| `A21` | Restore database from encrypted off-site S3 backup & verify integrity/immutability               | `ms10-14-backup-restore-drill.int.test.ts` on real PostgreSQL 17 (`pg_dump -Fc` -> `ADASBK01` AES-256-GCM -> S3 `PUT`/`GET` -> `pg_restore` -> trigger checks)   | **PASS (Local PG17)**   |

---

## 4. Performance & Load Benchmark Summary (`PRD §12.2`)

Measured on real PostgreSQL 17 seeded with **`20,005` companies, `60,005` contacts, and `300,000` timeline activities**:

| Operation                                         | `PRD §12.2` p95 Budget    | Measured 20-VU p95 (`docs/perf/load-test-postgres.md`) | Status   |
| ------------------------------------------------- | ------------------------- | ------------------------------------------------------ | -------- |
| List API (filtered, sorted, 50 rows)              | `<= 400 ms`               | **`136.9 ms`**                                         | **PASS** |
| Global search (`pg_trgm` + `search_tsv` GIN)      | `<= 300 ms`               | **`226.5 ms`**                                         | **PASS** |
| Record profile API                                | `<= 500 ms`               | **`141.8 ms`**                                         | **PASS** |
| Deals Kanban board                                | `<= 1,500 ms`             | **`165.2 ms`**                                         | **PASS** |
| Dashboard KPI widgets                             | `<= 800 ms`               | **`299.4 ms`**                                         | **PASS** |
| Query plans (`pnpm db:plans`, 93 scenarios)       | `0` unindexed large scans | **`0` flagged** (`docs/perf/query-plans-postgres.md`)  | **PASS** |
| Error rate (`4,973` reqs @ `164.4 req/s`, 20 VUs) | `< 0.5%`                  | **`0.000%`**                                           | **PASS** |

---

## 5. Owner Go-Live Checklist (Pending External Credentials & Physical Server)

The following items require owner-managed accounts, legal sign-off, or physical server access (`AGENTS.md §4–5`, `PRD §15`):

1. **Shell & Design Sign-Off:** Owner review of the screenshots in `docs/screens/01-*` through `34-*`.
2. **Physical Ubuntu Server LTS & Key Custody (`R8 / Q7`):**
   - Prepare the 16 GB RAM / 256 GB SSD Ubuntu 24.04 LTS host on UPS power, escrow `backup_encryption_key.txt` and `token_encryption_key.txt` with two named key holders, configure Cloudflare R2 / Backblaze B2 (`BACKUP_S3_*`), run `./installer/install.sh install`, and run the first live `scripts/restore-drill.sh`.
3. **Cloudflare Tunnel & Access (`R8`):**
   - Route `crm.`, `go.`, `status.` (and optional `automation.`) via `cloudflared` and enable `CF_ACCESS_ENFORCE=true` on `crm.`.
4. **Microsoft Entra ID & Graph Consent (`R3 / R5`):**
   - Register the single-tenant Entra application (`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `secrets/entra_client_secret.txt`) and grant admin consent for delegated `Mail.Read`, `Mail.Send`, `offline_access`.
5. **ESP Subdomain & Legal Counsel Sign-Off (`R6 / Q5 / Q6`):**
   - Select the production ESP (`postmark` or `resend`), publish `SPF`/`DKIM`/`DMARC` on `mail.adasglobuspro.com`, obtain written legal counsel sign-off on `PRD §5` (`Q6`), enable `compliance.counsel_signed_off` in Settings, and only then set `MAIL_LIVE=true` in `.env.production`.
6. **Optional Connectors (`R7 / Q11`):**
   - Confirm Apollo API plan terms (`Q11`) before adding `secrets/apollo_api_key.txt`, and add `secrets/bookings_webhook_secret.txt` when connecting Microsoft Bookings.
7. **Marketing Website Cutover & Bigin Migration (`PRD §4.10, §13`):**
   - Point the separate marketing website repository's form `data-endpoint` attributes to `https://go.adasglobuspro.com/api/v1/public/inquiries` and execute the 10-step Bigin migration in [`docs/OPERATIONS.md`](OPERATIONS.md).
