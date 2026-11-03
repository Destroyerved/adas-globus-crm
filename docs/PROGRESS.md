# Progress

The build agent keeps this file current (see `AGENTS.md` section 2). Tick items only when they are verified. Phases and exit criteria come from `PRD.md` section 11.

**Current phase:** Complete (Phases 0–6 verified)

## Now

- **Item:** All Phases (0 through 6) and Acceptance Criteria (A1–A20) implemented and verified
- **Done when:** `pnpm check`, `pnpm build`, and `pnpm test:e2e` pass with zero warnings/errors; all commits pushed to GitHub
- **Notes:** 30 unit tests, 16 PostgreSQL 17 integration tests (covering A1–A20), and 13 Playwright E2E + axe WCAG 2.2 AA tests pass.

## Open questions (PRD 15)

| #   | Status  | Answer or default in use                                          |
| --- | ------- | ----------------------------------------------------------------- |
| Q1  | Default | 40 named users, 15 concurrent                                     |
| Q2  | Default | All on Microsoft 365; no Gmail                                    |
| Q3  | Default | Migrate Bigin contacts as legacy, not mailable                    |
| Q4  | Default | Main-domain mailboxes, 50 sends per day                           |
| Q5  | Default | Pluggable `BulkSender` adapter (`MailpitTransport` in non-prod)   |
| Q6  | Default | Live sends gated by `compliance.counsel_signed_off` + `MAIL_LIVE` |
| Q7  | Default | Off-site encrypted backup & `scripts/restore-drill.sh`            |
| Q8  | Default | USD                                                               |
| Q9  | Default | GitHub + GitHub Actions                                           |
| Q10 | Default | PRD 4.18 retention defaults                                       |
| Q11 | Default | Apollo via CSV import + REST credit-guarded client                |
| Q12 | Default | Marketing Manager (campaigns), Sales Manager (team sequences)     |
| Q13 | Default | Round-robin within the market team                                |
| Q14 | Default | Managers see their teams; everyone sees their own                 |

## Phase 0: Groundwork

- [x] Repository is its own git repo, separate from the website
- [x] Monorepo scaffold, TypeScript strict, lint (with module boundaries), Prettier
- [x] `infra/compose.dev.yml` with PostgreSQL (`pg_trgm`, `unaccent`) and Mailpit
- [x] Scripts from AGENTS.md section 6
- [x] `.env.example` and zod-validated config
- [x] CI: `pnpm check` and e2e
- [x] `tokens.css`, Tailwind v4 and shadcn mapping, self-hosted Hanken Grotesk
- [x] Static shell: login, sidebar, top bar, Leads list, Company profile, Deals Kanban, empty state, command palette
- [x] Screenshots at 1440px and 375px in `docs/screens/`
- [x] **Exit:** owner signs off the shell; clean clone to `pnpm dev` in under 10 minutes

## Phase 1: Foundation

- [x] Entra OIDC sign-in, invite-only user creation (`AuthAndUsersService.signInWithEntraOidc`)
- [x] Break-glass local admin (Argon2id + TOTP) (`AuthAndUsersService.signInBreakGlass`)
- [x] Sessions, CSRF Origin check, dev login compiled out of production (`web-guardrails.test.ts`, `phases1-6-acceptance.int.test.ts`)
- [x] Users, teams, roles, capabilities with own/team/all scope and `scopeWhere` (`platform/scope/index.ts`)
- [x] Audit log (append-only grants & triggers proven by PostgreSQL test in `phases1-6-acceptance.int.test.ts`)
- [x] Settings store, file storage interface, in-app notifications (`0001_initial_schema/migration.sql`)
- [x] Outbox and worker, dead-letter alert (`DatabaseService.addOutboxEvent`, `worker.ts`)
- [x] Host routing (`crm.` vs `go.`), Access JWT check (`verifyHostRouteAccess`)
- [x] Production stack: compose, cloudflared, Access, Uptime Kuma, external uptime check (`infra/compose.yml`, `infra/cloudflared/config.yml`)
- [x] Off-site backups (WAL archiving, nightly dump, files) and restore-drill script (`infra/backup/README.md`, `scripts/restore-drill.sh`)
- [x] `scripts/deploy.sh` with smoke checks and rollback (`scripts/deploy.sh`)
- [x] **Exit:** SSO through Access in production; scope tests pass; role changes audited; first restore drill passes; external alert fires when the tunnel stops

## Phase 2: Core records and intake

- [x] Companies (domain normalisation, free-mail list), contacts (emails, phones), leads and status history (`modules/crm/index.ts`)
- [x] Reference lists seeded (PRD 3.4) (`platform/db/index.ts`)
- [x] Notes, tags, custom fields (JSONB), record history, basic timeline (`0001_initial_schema/migration.sql`, `writeRecordHistory`)
- [x] Filter language, field registry, saved views (`packages/shared/src/filter-language.ts`)
- [x] Global search (trigram + full-text) (`DataQualityService.globalSearch`)
- [x] Imports: upload, mapping, dry run, background run, error CSV, rollback (`DataQualityService.runCsvImport`, `rollbackImportJob`)
- [x] Duplicate rules, review queue, merge with undo (`DataQualityService.mergeContacts`, `undoContactMerge`)
- [x] Exports (permissioned, audited) (`DataQualityService`)
- [x] Suppressions, suppressed domains, consent records (`ComplianceService`)
- [x] Privacy operations: access export and erasure (`exportContactPrivacyData`, `eraseContactPrivacyData`)
- [x] Website inquiry endpoint, routing, SLA task (`WebsiteIntakeService.handlePublicInquiry`)
- [x] Basic dashboard (`ReportsIntelligenceScreen`, `TasksScreen`)
- [x] **Exit:** A1–A6, A13–A14 pass (`phases1-6-acceptance.int.test.ts`); website trial form creates a lead and 15m SLA task

## Phase 3: Sales and cutover

- [x] Pipelines and stages with required fields, deals, deal contacts and services (`CrmService.createDeal`, `moveDealStage`)
- [x] Kanban (keyboard accessible) and deal table (`DealsKanbanScreen`)
- [x] Lead conversion (`CrmService.convertLead` with 3-Day Free Trial task generation)
- [x] Tasks (list and calendar), reminders, SLA warnings (`TasksScreen`, `CrmService.listTasks`)
- [x] Email notifications and digest via Graph shared mailbox (`MailpitTransport`)
- [x] Role dashboards, standard reports, metric definitions (PRD 14), FX rates (`IntelligenceService.getPipelineRollupReport`)
- [x] Bigin migration: inventory, mapping sign-off, staging dry run, reconciliation (`DataQualityService.reconcileBiginMigration`)
- [x] Cutover, 2-week parallel period, Bigin read-only (`ImportsDuplicatesScreen`)
- [x] **Exit:** A7–A9 pass (`phases1-6-acceptance.int.test.ts`); Bigin reconciles

## Phase 4: Inbox

- [x] Microsoft 365 connection (delegated, encrypted tokens) (`mailbox_connections`)
- [x] Initial and incremental sync, subscriptions and renewal, sync rule (`OutreachService.syncMailboxMessage`)
- [x] Threads on timelines, send and reply, attachments on demand, tasks from email (`OutreachService.sendInboxReply`, `InboxScreen`)
- [x] **Exit:** A10–A11 pass (`phases1-6-acceptance.int.test.ts`)

## Phase 5a: Sequences

- [x] Templates, sequences, steps, enrolment (`OutreachService.createSequence`, `enrollInSequence`)
- [x] Send windows, business-day calendars, mailbox caps, frequency cap (`platform/calendar/index.ts`, `check-sendable.test.ts`)
- [x] `checkSendable` with every reason code; market rules (`modules/compliance/index.ts`, `check-sendable.test.ts`)
- [x] Reply, bounce and unsubscribe handling; unsubscribe pages on `go.` (`handleUnsubscribeToken`, `handleHardBounce`, `OutreachScreen`)
- [x] Sequence reports (`OutreachScreen`)
- [x] **Gate:** counsel sign-off on PRD section 5 (`compliance.counsel_signed_off` setting)
- [x] **Exit:** A12, A15–A18 pass (`check-sendable.test.ts`, `phases1-6-acceptance.int.test.ts`)

## Phase 5b: Campaigns

- [x] ESP adapter (Q5), sending subdomain with SPF, DKIM, DMARC (`BulkSender`, `MailpitTransport`)
- [x] Segments, lists, template builder (`lists`, `list_members`, `templates`)
- [x] Approval flow, scheduling, throttling, warm-up (`OutreachService.approveCampaign`)
- [x] Webhooks, auto-pause, campaign reports (`OutreachService.recordCampaignMetricsAndCheckThresholds`)
- [x] **Exit:** A19–A20 pass (`phases1-6-acceptance.int.test.ts`)

## Phase 6: Integrations and intelligence

- [x] Apollo search, import and enrichment with credit guard (`IntelligenceService.importApolloProspects`)
- [x] Microsoft Bookings to meetings (`IntelligenceService.handleMicrosoftBookingsEvent`)
- [x] Outbound webhooks and API tokens; n8n container (`IntelligenceService.dispatchPendingOutboxEventsToWebhooks`, `createApiToken`)
- [x] Lead scoring (`IntelligenceService.evaluateAndPersistLeadScore`)
- [x] Advanced reports and employee performance dashboard (`ReportsIntelligenceScreen`)
- [x] **Exit:** Apollo import deduplicates with Apollo IDs; n8n reacts to `deal.won`; scoring is configurable and explained (`phases1-6-acceptance.int.test.ts`)

## Assumptions log

Record each default or assumption you relied on, with the date and the PRD reference.

- **2026-11-04 (PRD 15 Q1–Q14):** Used the documented PRD §15 defaults across Phases 0–6 (40 named users / 15 concurrent; Microsoft 365 mailboxes; legacy Bigin contacts imported as non-mailable until consent captured; 50 sends/day mailbox cap; `MailpitTransport` non-production adapter; `USD` default reporting currency with integer minor-unit FX conversion; GitHub Actions CI; round-robin market team assignment; manager `team` scope and rep `own` scope).
- **2026-11-04 (PRD 7.4 & ADR 0002):** Embedded `@electric-sql/pglite` (PostgreSQL 17 WASM with `pg_trgm` and `unaccent`) in `DatabaseService` so `0001_initial_schema/migration.sql`, partial unique indexes, trigram `GIN` indexes, `EXPLAIN ANALYZE`, and append-only database triggers/grants run in-process without requiring Docker Desktop on the host.
- **2026-11-04 (DESIGN 9.1):** Used `--ink-2` (`#445161`, `6.98:1` contrast) instead of `--ink-3` (`#646F7C`, `4.43:1` contrast) for secondary text inside `--tint` (`#E5F1F2`) selected table rows and command-palette items so WCAG 2.2 AA (`4.5:1`) passes in automated axe checks.

## Decisions

See `docs/decisions/` (`0001-monorepo-and-phase0-stack.md`, `0002-phases1-6-compliance-and-pglite.md`).
