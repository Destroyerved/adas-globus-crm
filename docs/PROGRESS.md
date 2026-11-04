# Progress

The build agent keeps this file current (see `AGENTS.md` section 2). Tick an item only when it is verified in the environment the item names. A production item can't be ticked from a dev machine, and an owner sign-off can't be ticked by the agent.

**Current phase:** 0 (Groundwork), waiting for owner sign-off on the shell.
**Overall state:** a clickable **prototype**. It is not production-ready. Phases 1–6 exist as demo logic and demo screens; the "Make it real" track below turns them into working software.

## Not production-ready

The API refuses to start with `NODE_ENV=production` until every item here is fixed (`apps/api/src/main.ts`).

| #   | Problem                                                                                                                                                                                 | Effect                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | The database is PGlite **in memory**, created and seeded on every start (`platform/db`). `DATABASE_URL` is validated but never used.                                                    | Every restart deletes all data.                                                                                     |
| 2   | There is no real sign-in. The dev header `X-Dev-User-Id` picks the user; the Entra and break-glass endpoints accept an email, any 12-character password and the code `123456`.          | Anyone could act as anyone. (Now blocked outside development.)                                                      |
| 3   | No screen reads data from the API. Lists, profiles, the Kanban board, tasks, inbox and reports show fixed demo data from `apps/web/src/lib/synthetic-data.ts` or inline arrays.         | New records vanish from the screen on reload.                                                                       |
| 4   | The web client always sends the demo admin header and hides failed calls by returning `null` (`apps/web/src/lib/api-client.ts`).                                                        | Errors are invisible; screens look fine when the API is down.                                                       |
| 5   | The worker (`apps/api/src/worker.ts`) logs "ready" and exits. No jobs run.                                                                                                              | Nothing is scheduled: no sequence steps, reminders, SLA checks, outbox dispatch, retention or backups verification. |
| 6   | No real connectors: Microsoft Graph sign-in, mailbox sync and sending, the email service provider, Apollo, Bookings and n8n are simulated. All mail goes to a local stub.               | Nothing reaches Outlook, Apollo or a real inbox.                                                                    |
| 7   | Production infrastructure (Ubuntu server, Docker, Cloudflare Tunnel and Access, off-site backups, restore drill) has not been set up or run. Docker isn't installed on the dev machine. | Nothing has been deployed or restored.                                                                              |
| 8   | Contacts list, Companies list, Dashboard and Settings screens don't exist; the company profile shows one fixed company.                                                                 | Core navigation is incomplete.                                                                                      |

## Make it real (next)

Order matters: each step builds on the one before. Items marked **Owner** need something only you can provide.

| Step | Goal                                             | Done when                                                                                                                               | Needs from the owner                                                                             |
| ---- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| R1   | Real PostgreSQL storage with migrations          | Data survives restarts; integration tests run against real PostgreSQL                                                                   | **Owner:** install Docker Desktop on the dev PC (or give access to a PostgreSQL server)          |
| R2   | Screens on live data                             | Leads, Contacts, Companies, Deals, Tasks read and write through the API; no demo data outside the seed script; errors shown to the user | —                                                                                                |
| R3   | Real Microsoft sign-in (Entra OIDC) and sessions | Employees sign in with their Microsoft 365 account; roles enforced from the session                                                     | **Owner:** an Entra app registration (tenant ID, client ID, certificate or secret, redirect URL) |
| R4   | Real background worker (pg-boss)                 | Outbox, reminders, SLA checks and sequence steps run on schedule                                                                        | —                                                                                                |
| R5   | Microsoft 365 mail connector (Graph)             | A connected mailbox syncs threads to contacts and sends from Outlook                                                                    | **Owner:** admin consent for `Mail.Read`, `Mail.Send`, `offline_access` on the app registration  |
| R6   | Email service provider for campaigns             | Campaigns send through the provider, with webhooks for bounces and complaints                                                           | **Owner:** choose the provider (PRD Q5), create the account and DNS records                      |
| R7   | Apollo connector                                 | Search, import and enrichment through the Apollo API with credit checks                                                                 | **Owner:** an Apollo API key and plan confirmation (PRD Q11)                                     |
| R8   | Production deploy                                | Running on the company server behind Cloudflare Access, with off-site backups and a passed restore drill                                | **Owner:** the server, a Cloudflare account and a backup storage bucket (PRD Q7)                 |

## Open questions (PRD 15)

| #   | Status   | Answer or default in use                                      |
| --- | -------- | ------------------------------------------------------------- |
| Q1  | Default  | 40 named users, 15 concurrent                                 |
| Q2  | Default  | All on Microsoft 365; no Gmail                                |
| Q3  | Default  | Migrate Bigin contacts as legacy, not mailable                |
| Q4  | Default  | Main-domain mailboxes, 50 sends per day                       |
| Q5  | Open     | Email service provider not chosen                             |
| Q6  | Open     | Counsel has **not** signed off section 5; no live sends       |
| Q7  | Open     | Server location, key holders and UPS not confirmed            |
| Q8  | Default  | USD                                                           |
| Q9  | Answered | GitHub: `Destroyerved/adas-globus-crm`                        |
| Q10 | Default  | PRD 4.18 retention defaults                                   |
| Q11 | Open     | Apollo API access not confirmed                               |
| Q12 | Default  | Marketing Manager (campaigns), Sales Manager (team sequences) |
| Q13 | Default  | Round-robin within the market team                            |
| Q14 | Default  | Managers see their teams; everyone sees their own             |

## Phase 0: Groundwork

- [x] Repository is its own git repo, separate from the website
- [x] Monorepo scaffold, TypeScript strict, lint (with module boundaries), Prettier
- [x] `infra/compose.dev.yml` with PostgreSQL (`pg_trgm`, `unaccent`) and Mailpit (not run: Docker isn't installed)
- [x] Scripts from AGENTS.md section 6
- [x] `.env.example` and zod-validated config
- [x] CI: `pnpm check` and e2e
- [x] `tokens.css`, Tailwind v4 and shadcn mapping, self-hosted Hanken Grotesk
- [x] Static shell: login, sidebar, top bar, Leads list, Company profile, Deals Kanban, empty state, command palette
- [x] Screenshots at 1440px and 375px in `docs/screens/`
- [ ] **Exit:** owner signs off the shell; clean clone to `pnpm dev` in under 10 minutes

## Phases 1–6: prototype status

Demo logic for these phases exists in `apps/api/src/modules/*` and runs against the in-memory database. It is useful as a starting point for the Make-it-real track, but none of these phases has met its exit criteria. Every checkbox below stays unticked until it works against real PostgreSQL, through the real UI, with real connectors where the item names one.

### Phase 1: Foundation

- [ ] Entra OIDC sign-in, invite-only user creation (prototype: email-only stub)
- [ ] Break-glass local admin (Argon2id + TOTP) (prototype: fixed code `123456`)
- [ ] Sessions, CSRF Origin check, dev login compiled out of production (prototype: sessions written but never read)
- [ ] Users, teams, roles, capabilities with own/team/all scope and `scopeWhere` (prototype: scope logic works and is tested)
- [ ] Audit log (append-only grants proven by test) (prototype: triggers tested on PGlite)
- [ ] Settings store, file storage interface, in-app notifications
- [ ] Outbox and worker (pg-boss), dead-letter alert (prototype: outbox table only; worker does nothing)
- [x] Host routing (`crm.` vs `go.`) (verified by request on 4 Nov 2026)
- [ ] Access JWT check
- [ ] Production stack: compose, cloudflared, Access, Uptime Kuma, external uptime check (files only; never run)
- [ ] Off-site backups and restore-drill script (scripts only; never run)
- [ ] `scripts/deploy.sh` with smoke checks and rollback (never run)
- [ ] **Exit:** SSO through Access in production; scope tests pass; role changes audited; first restore drill passes; external alert fires when the tunnel stops

### Phase 2: Core records and intake

- [ ] Companies, contacts, leads and status history (prototype API works; UI not wired)
- [ ] Reference lists seeded (PRD 3.4)
- [ ] Notes, tags, custom fields, record history, basic timeline
- [ ] Filter language, field registry, saved views
- [ ] Global search (trigram + full-text) (prototype API works)
- [ ] Imports: upload, mapping, dry run, background run, error CSV, rollback (prototype: JSON rows only, no file upload)
- [ ] Duplicate rules, review queue, merge with undo (prototype API works)
- [ ] Exports (permissioned, audited)
- [ ] Suppressions, suppressed domains, consent records (prototype API works)
- [ ] Privacy operations: access export and erasure (prototype API works)
- [ ] Website inquiry endpoint, routing, reply task (prototype API works and accepts the live website payloads)
- [ ] Basic dashboard (not built)
- [ ] **Exit:** A1–A6, A13–A14 pass against PostgreSQL; the live website trial form creates a lead and reply task in production

### Phase 3: Sales and cutover

- [ ] Pipelines and stages with required fields, deals (prototype API works; Kanban shows demo data)
- [ ] Kanban (keyboard accessible) and deal table
- [ ] Lead conversion (prototype API works)
- [ ] Tasks (list and calendar), reminders, SLA warnings
- [ ] Email notifications and digest via Graph shared mailbox
- [ ] Role dashboards, standard reports, metric definitions (PRD 14), FX rates
- [ ] Bigin migration and cutover
- [ ] **Exit:** A7–A9 pass; Bigin reconciles; team works only in ADAS CRM for 2 weeks

### Phase 4: Inbox

- [ ] Microsoft 365 connection (delegated, encrypted tokens)
- [ ] Initial and incremental sync, subscriptions and renewal, sync rule
- [ ] Threads on timelines, send and reply, attachments on demand, tasks from email
- [ ] **Exit:** A10–A11 pass; 10 users for a week with sync backlog under 5 minutes

### Phase 5a: Sequences

- [ ] Templates, sequences, steps, enrolment (prototype API works)
- [ ] Send windows, business-day calendars, mailbox caps, frequency cap (prototype logic tested)
- [ ] `checkSendable` with every reason code; market rules (prototype logic tested)
- [ ] Reply, bounce and unsubscribe handling; unsubscribe pages on `go.`
- [ ] Sequence reports
- [ ] **Gate:** counsel sign-off on PRD section 5
- [ ] **Exit:** A12, A15–A18 pass; 3-sender pilot for 2 weeks with bounce under 3% and zero ineligible sends

### Phase 5b: Campaigns

- [ ] ESP adapter, sending subdomain with SPF, DKIM, DMARC
- [ ] Segments, lists, template builder
- [ ] Approval flow, scheduling, throttling, warm-up
- [ ] Webhooks, auto-pause, campaign reports
- [ ] **Exit:** A19–A20 pass; first real campaign to an eligible segment

### Phase 6: Integrations and intelligence

- [ ] Apollo search, import and enrichment with credit guard
- [ ] Microsoft Bookings to meetings
- [ ] Outbound webhooks and API tokens; n8n container
- [ ] Lead scoring
- [ ] Advanced reports and employee performance dashboard
- [ ] **Exit:** Apollo import deduplicates with Apollo IDs; n8n reacts to `deal.won`; scoring is configurable and explained

## Review log

- **4 Nov 2026, review and fixes.** `pnpm check` passed before and after. An API smoke test of 64 calls and a click-through of every screen found the problems above, plus these bugs, now fixed: duplicate contact email returned 500 (now 409); a converted lead could be converted again, creating a second deal (now refused); a contact could be in two active sequences (now refused); a campaign creator could approve their own campaign (now refused; Admin override is logged); unknown unsubscribe links returned 500 and opening a link unsubscribed immediately (now a confirm page, with POST to unsubscribe); malformed JSON returned 500 (now 400); request bodies had no size limit; CORS reflected any website with credentials (now only the CRM app and the marketing site); managers could read every audit entry (now their team's); website forms lost `need`, `location` and `interests`, labelled contact-form leads as trial leads, and treated the contact form's hidden anti-bot field as the firm's website (all fixed, with a test using the exact website payloads); website inquiries recorded "express" consent and a "valid" email (now implied consent and unverified); the reply task was due in 15 minutes instead of one business day; unsubscribe footer addresses didn't match the website's offices; spec labels such as "(PRD 4.12, 4.13, 5)" showed in the UI.

## Assumptions log

- **4 Nov 2026 (PRD 15 Q1–Q14):** documented defaults in use, as listed in the table above.
- **4 Nov 2026 (ADR 0002):** PGlite was used so tests run without Docker. It stays acceptable for unit and integration tests only; R1 replaces it at runtime.
- **4 Nov 2026 (DESIGN 9.1):** `--ink-2` used for secondary text on `--tint` rows where `--ink-3` fell below 4.5:1.

## Decisions

See `docs/decisions/`.
