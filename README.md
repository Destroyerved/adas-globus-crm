# ADAS CRM

The internal CRM for ADAS Globus Pro: companies, contacts, leads, deals and tasks for selling offshore accounting and tax staff to CPA firms in the U.S. and Canada.

- **What to build:** [`docs/PRD.md`](docs/PRD.md)
- **How it looks:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Where it stands:** [`docs/PROGRESS.md`](docs/PROGRESS.md) and [`docs/PRODUCTION_AUDIT.md`](docs/PRODUCTION_AUDIT.md)
- **Rules for the build agent:** [`AGENTS.md`](AGENTS.md)

> **Not production-ready.** External live connectors (Microsoft 365 Graph mail, the email service provider, Apollo) and production server infrastructure/restore drills are still in progress. The API refuses to start with `NODE_ENV=production` until production readiness gates are completed.

## What works today

Leads, Contacts, Companies and Deals have server-paged lists with search, filters and sorting kept in the URL, record pages with a timeline (notes, calls, meetings, emails, status and stage changes), tags, tasks, and edit drawers. The deals board and list read from the server; Tasks has Today, Overdue, Upcoming and Done views. The dashboard shows each role its own metrics (follow-ups, overdue work, website inquiries waiting for a reply, open pipeline in USD, won and lost, trial to win, lead sources, activity and outreach), and every number opens the filtered list behind it. Settings lets admins invite people, change roles and teams, edit what each role can do, manage pipeline stages, configure per-market website inquiry routing (`US`, `CA`, `OTHER`), edit reference lists, manage email/domain suppressions, and read the audit log; everyone can set their own time zone. Contact profiles compute derived marketing consent basis (`Express`, `Implied`, `US B2B outreach only`, `None`), record/withdraw consent, and let admins export personal data (`JSON`/`CSV`) or execute irreversible privacy erasure with permanent SHA-256 suppression tombstones. All of it reads and writes real data through the API and PostgreSQL 17. Website inquiries from `adasglobuspro.com` are accepted at `POST /api/v1/public/inquiries` with salted IP rate limiting, `(email, form, day)` deduplication, 1-business-day SLA tasks and owner notifications; public unsubscribe links on `/u/:token` store hashed tokens only. Permissions are scoped per role (own, team, all) in every query. Every API call needs a signed-in session (an HttpOnly cookie); writes must come from the CRM web app. A background worker (started by `pnpm dev`) runs task reminders, overdue alerts, inquiry SLA warnings/breaches, idle-deal alerts, imports, duplicate scans, large CSV exports, outbox dispatch and retention housekeeping on `pg-boss`.

## Microsoft sign-in

Employees sign in with their Microsoft 365 account. Until it's configured, the button on the sign-in page says it isn't available. To turn it on, an Entra admin creates an app registration (single tenant, platform "Web") with the redirect URI `http://localhost:5174/api/v1/auth/sso/callback` (plus the production URL later), then:

- set `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` in `.env`
- save a client secret in `secrets/entra_client_secret.txt` (git-ignored)

Only users invited in the CRM can sign in. The first sign-in links their Microsoft account to their CRM user.

## Emergency admin sign-in

If Microsoft sign-in is down, up to two Admins can sign in with a password and a code from an authenticator app ("Admin sign-in" on the sign-in page). Set it up for an existing Admin on the server:

```bash
pnpm break-glass set emergency.admin@adasglobuspro.com
```

It prints a generated password and an authenticator secret once; keep them in the company password manager. `pnpm break-glass remove <email>` takes it away again. Every use alerts all admins. It needs `TOKEN_ENCRYPTION_KEY_FILE` (in development, `secrets/token_encryption_key.txt` with at least 32 random characters).

## Set up a development machine

You need Node.js 22 or newer, pnpm, and PostgreSQL 17 (a local install or Docker).

1. **Create the databases** (once). With a local PostgreSQL install, run this and enter your `postgres` password:

   ```bash
   "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h localhost -f infra/postgres/create-local-dev-db.sql
   ```

   It creates the `adas_admin` and `adas_app` roles and the `adas_crm` and `adas_crm_test` databases, with the development passwords from `.env.example`. With Docker instead: `docker compose -f infra/compose.dev.yml up -d`.

   **No `postgres` password and no Docker?** Run `pnpm db:local init` instead. It uses the PostgreSQL programs already installed to create a separate development server on port 5433, with its own data folder under your user profile, and needs no administrator rights. Then copy `.env.example` to `.env` and change the port in `DATABASE_URL` and `DATABASE_ADMIN_URL` from 5432 to 5433. It is not a Windows service: `pnpm dev` starts it, and `pnpm db:local start` starts it by hand after a restart.

2. **Install, migrate and load demo data:**

   ```bash
   pnpm install
   ```

   ```bash
   pnpm db:migrate
   ```

   ```bash
   pnpm db:seed
   ```

3. **Run it:**

   ```bash
   pnpm dev
   ```

   Open http://localhost:5174. In development the sign-in page lets you pick a seeded user and role.

The demo data is synthetic (example.com addresses only). Never load real customer data into a development database.

## Commands

| Command                     | What it does                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                  | API on :3000 (PostgreSQL via `DATABASE_URL`) and web app on :5174                                                                                                       |
| `pnpm db:migrate`           | Apply new migrations in `apps/api/prisma/migrations` as `adas_admin`                                                                                                    |
| `pnpm db:local init`        | Create and start a separate development PostgreSQL on port 5433 (also `start`, `stop`, `status`, and `reset` to empty both databases)                                   |
| `pnpm db:seed`              | Load synthetic demo data (refuses to run in production)                                                                                                                 |
| `pnpm db:seed --size=large` | Also load 20,000 companies, 60,000 contacts and 300,000 timeline entries for performance work; safe to run again                                                        |
| `pnpm db:plans`             | Explain the screens' real queries on that data and write `docs/perf/query-plans-postgres.md`; exits with 1 if a query reads a large table whole                         |
| `pnpm db:plans:test`        | The same check without a server: loads the large seed into the throw-away test database and writes `docs/perf/query-plans-pglite.md` (plans only, times are not judged) |
| `pnpm check`                | Lint, typecheck, unit and integration tests. Must pass before every commit                                                                                              |
| `pnpm test:e2e`             | Build the web app and run Playwright browser tests (with accessibility checks)                                                                                          |
| `pnpm build`                | Production build                                                                                                                                                        |

Tests use a throw-away database: in-memory PGlite by default, or real PostgreSQL when `TEST_DATABASE_URL` points at a disposable database (for example `postgresql://adas_admin:adas_admin_password@localhost:5432/adas_crm_test`). The test setup drops and rebuilds that database's schema. Test files then run one at a time, because they share that database. To check query plans at full size without a server, run `pnpm db:plans:test`: it loads the large seed into the test database and writes `docs/perf/query-plans-pglite.md` (plans only; times are judged on real PostgreSQL with `pnpm db:plans`).

## Layout

| Path              | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`        | API server (`src/main.ts`), modules, migrations and the migrate and seed scripts             |
| `apps/web`        | React web app; live screens in `src/features`, API client in `src/lib/api.ts`                |
| `packages/shared` | Schemas, enums and formatters shared by the API and web app                                  |
| `e2e`             | Playwright browser tests                                                                     |
| `infra`           | PostgreSQL setup, Compose files, Cloudflare and backup material (not yet used in production) |
| `docs`            | Spec, design system, progress and decision records                                           |
