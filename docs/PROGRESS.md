# Progress

The build agent keeps this file current (see `AGENTS.md` section 2). Tick items only when they are verified. Phases and exit criteria come from `PRD.md` section 11.

**Current phase:** 0 (Groundwork)

## Now

- **Item:** Phase 0 — Groundwork complete; awaiting owner sign-off on `docs/screens/*` and answers to Phase 1 open questions (`Q1`, `Q2`, `Q7`, `Q9` in PRD 15)
- **Done when:** Owner signs off the static shell screenshots at 1440px and 375px (`docs/screens/01-login-*` through `06-command-palette-*`) and confirms or updates `Q1`, `Q2`, `Q7`, `Q9`
- **Notes:** `pnpm check`, `pnpm build`, and `pnpm test:e2e` (7/7 Playwright + axe WCAG 2.2 AA tests) all pass.

## Open questions (PRD 15)

| #   | Status  | Answer or default in use                                      |
| --- | ------- | ------------------------------------------------------------- |
| Q1  | Default | 40 named users, 15 concurrent                                 |
| Q2  | Default | All on Microsoft 365; no Gmail                                |
| Q3  | Default | Migrate Bigin contacts as legacy, not mailable                |
| Q4  | Default | Main-domain mailboxes, 50 sends per day                       |
| Q5  | Open    | Choose at P5b                                                 |
| Q6  | Open    | No live sends until counsel signs off                         |
| Q7  | Open    | Needed before P1 go-live                                      |
| Q8  | Default | USD                                                           |
| Q9  | Default | GitHub + GitHub Actions                                       |
| Q10 | Default | PRD 4.18 retention defaults                                   |
| Q11 | Default | Apollo via CSV import until confirmed                         |
| Q12 | Default | Marketing Manager (campaigns), Sales Manager (team sequences) |
| Q13 | Default | Round-robin within the market team                            |
| Q14 | Default | Managers see their teams; everyone sees their own             |

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
- [ ] **Exit:** owner signs off the shell; clean clone to `pnpm dev` in under 10 minutes

## Phase 1: Foundation

- [ ] Entra OIDC sign-in, invite-only user creation
- [ ] Break-glass local admin (Argon2id + TOTP)
- [ ] Sessions, CSRF Origin check, dev login compiled out of production
- [ ] Users, teams, roles, capabilities with own/team/all scope and `scopeWhere`
- [ ] Audit log (append-only grants proven by test)
- [ ] Settings store, file storage interface, in-app notifications
- [ ] Outbox and worker (pg-boss), dead-letter alert
- [ ] Host routing (`crm.` vs `go.`), Access JWT check
- [ ] Production stack: compose, cloudflared, Access, Uptime Kuma, external uptime check
- [ ] Off-site backups (WAL archiving, nightly dump, files) and restore-drill script
- [ ] `scripts/deploy.sh` with smoke checks and rollback
- [ ] **Exit:** SSO through Access in production; scope tests pass; role changes audited; first restore drill passes; external alert fires when the tunnel stops

## Phase 2: Core records and intake

- [ ] Companies (domain normalisation, free-mail list), contacts (emails, phones), leads and status history
- [ ] Reference lists seeded (PRD 3.4)
- [ ] Notes, tags, custom fields (JSONB), record history, basic timeline
- [ ] Filter language, field registry, saved views
- [ ] Global search (trigram + full-text)
- [ ] Imports: upload, mapping, dry run, background run, error CSV, rollback
- [ ] Duplicate rules, review queue, merge with undo
- [ ] Exports (permissioned, audited)
- [ ] Suppressions, suppressed domains, consent records
- [ ] Privacy operations: access export and erasure
- [ ] Website inquiry endpoint, routing, SLA task
- [ ] Basic dashboard
- [ ] **Exit:** A1–A6, A13–A14 pass; the live website trial form creates a lead and SLA task in production

## Phase 3: Sales and cutover

- [ ] Pipelines and stages with required fields, deals, deal contacts and services
- [ ] Kanban (keyboard accessible) and deal table
- [ ] Lead conversion
- [ ] Tasks (list and calendar), reminders, SLA warnings
- [ ] Email notifications and digest via Graph shared mailbox
- [ ] Role dashboards, standard reports, metric definitions (PRD 14), FX rates
- [ ] Bigin migration: inventory, mapping sign-off, staging dry run, reconciliation
- [ ] Cutover, 2-week parallel period, Bigin read-only
- [ ] **Exit:** A7–A9 pass; Bigin reconciles; team works only in ADAS CRM for 2 weeks

## Phase 4: Inbox

- [ ] Microsoft 365 connection (delegated, encrypted tokens)
- [ ] Initial and incremental sync, subscriptions and renewal, sync rule
- [ ] Threads on timelines, send and reply, attachments on demand, tasks from email
- [ ] **Exit:** A10–A11 pass; 10 users for a week with sync backlog under 5 minutes

## Phase 5a: Sequences

- [ ] Templates, sequences, steps, enrolment
- [ ] Send windows, business-day calendars, mailbox caps, frequency cap
- [ ] `checkSendable` with every reason code; market rules
- [ ] Reply, bounce and unsubscribe handling; unsubscribe pages on `go.`
- [ ] Sequence reports
- [ ] **Gate:** counsel sign-off on PRD section 5
- [ ] **Exit:** A12, A15–A18 pass; 3-sender pilot for 2 weeks with bounce under 3% and zero ineligible sends

## Phase 5b: Campaigns

- [ ] ESP adapter (Q5), sending subdomain with SPF, DKIM, DMARC
- [ ] Segments, lists, template builder
- [ ] Approval flow, scheduling, throttling, warm-up
- [ ] Webhooks, auto-pause, campaign reports
- [ ] **Exit:** A19–A20 pass; first real campaign to an eligible segment

## Phase 6: Integrations and intelligence

- [ ] Apollo search, import and enrichment with credit guard
- [ ] Microsoft Bookings to meetings
- [ ] Outbound webhooks and API tokens; n8n container
- [ ] Lead scoring
- [ ] Advanced reports and employee performance dashboard
- [ ] **Exit:** Apollo import deduplicates with Apollo IDs; n8n reacts to `deal.won`; scoring is configurable and explained

## Assumptions log

Record each default or assumption you relied on, with the date and the PRD reference.

- **2026-11-04 (PRD 15 Q9):** Built `.github/workflows/ci.yml` for GitHub Actions using the documented default (`GitHub + GitHub Actions`).
- **2026-11-04 (PRD 15 Q8 & DESIGN 10):** Defaulted synthetic reporting rollups to `USD` while displaying `US$` and `CA$` explicitly on mixed-market records and using Western `en-US` digit grouping (`12,480`) everywhere.
- **2026-11-04 (PRD 15 Q2 & DESIGN 6.14):** Styled the Login screen around Microsoft 365 (`Sign in with Microsoft`) plus the break-glass local admin disclosure (`Admin sign-in (break-glass)`) and the non-production dev persona switcher (`import.meta.env.DEV` guard verified by unit test).
- **2026-11-04 (PRD 11 & AGENTS 3):** Hid navigation items for Phase 4–6 modules (`Inbox`, `Sequences`, `Campaigns`, `Lists & Segments`, `Templates`, `Bookings`) behind a runtime `showAllModules` flag (`default: false`) so unfinished modules are hidden by default.
- **2026-11-04 (DESIGN 9.1):** Used `--ink-2` (`#445161`, `6.98:1` contrast) instead of `--ink-3` (`#646F7C`, `4.43:1` contrast) for secondary text inside `--tint` (`#E5F1F2`) selected table rows and command-palette items so WCAG 2.2 AA (`4.5:1`) passes in automated axe checks.

## Decisions

See `docs/decisions/` (`docs/decisions/0001-monorepo-and-phase0-stack.md`).
