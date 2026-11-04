# ADAS CRM

The internal CRM for ADAS Globus Pro: companies, contacts, leads, deals and tasks for selling offshore accounting and tax staff to CPA firms in the U.S. and Canada.

- **What to build:** [`docs/PRD.md`](docs/PRD.md)
- **How it looks:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Where it stands:** [`docs/PROGRESS.md`](docs/PROGRESS.md), which is the source of truth for status
- **Rules for the build agent:** [`AGENTS.md`](AGENTS.md)

> **Not production-ready.** Real sign-in, the background worker and every external connector (Microsoft 365, the email provider, Apollo) are still to be built. The API refuses to start with `NODE_ENV=production` until they exist. Don't deploy it, and don't use `ADAS-CRM-Deployer.exe`.

## What works today

Leads, Contacts, Companies (list and profile), Deals (pipeline board) and Tasks read and write real data through the API and PostgreSQL. Website inquiries from adasglobuspro.com are accepted at `POST /api/v1/public/inquiries`. Permissions are scoped per role (own, team, all) in every query. Every API call needs a signed-in session (an HttpOnly cookie); writes must come from the CRM web app.

## Microsoft sign-in

Employees sign in with their Microsoft 365 account. Until it's configured, the button on the sign-in page says it isn't available. To turn it on, an Entra admin creates an app registration (single tenant, platform "Web") with the redirect URI `http://localhost:5174/api/v1/auth/sso/callback` (plus the production URL later), then:

- set `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` in `.env`
- save a client secret in `secrets/entra_client_secret.txt` (git-ignored)

Only users invited in the CRM can sign in. The first sign-in links their Microsoft account to their CRM user.

## Set up a development machine

You need Node.js 22 or newer, pnpm, and PostgreSQL 17 (a local install or Docker).

1. **Create the databases** (once). With a local PostgreSQL install, run this and enter your `postgres` password:

   ```bash
   "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h localhost -f infra/postgres/create-local-dev-db.sql
   ```

   It creates the `adas_admin` and `adas_app` roles and the `adas_crm` and `adas_crm_test` databases, with the development passwords from `.env.example`. With Docker instead: `docker compose -f infra/compose.dev.yml up -d`.

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

| Command           | What it does                                                                   |
| ----------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`        | API on :3000 (PostgreSQL via `DATABASE_URL`) and web app on :5174              |
| `pnpm db:migrate` | Apply new migrations in `apps/api/prisma/migrations` as `adas_admin`           |
| `pnpm db:seed`    | Load synthetic demo data (refuses to run in production)                        |
| `pnpm check`      | Lint, typecheck, unit and integration tests. Must pass before every commit     |
| `pnpm test:e2e`   | Build the web app and run Playwright browser tests (with accessibility checks) |
| `pnpm build`      | Production build                                                               |

Tests use a throw-away database: in-memory PGlite by default, or real PostgreSQL when `TEST_DATABASE_URL` points at a disposable database (for example `postgresql://adas_admin:adas_admin_password@localhost:5432/adas_crm_test`). The test setup drops and rebuilds that database's schema.

## Layout

| Path              | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`        | API server (`src/main.ts`), modules, migrations and the migrate and seed scripts             |
| `apps/web`        | React web app; live screens in `src/features`, API client in `src/lib/api.ts`                |
| `packages/shared` | Schemas, enums and formatters shared by the API and web app                                  |
| `e2e`             | Playwright browser tests                                                                     |
| `infra`           | PostgreSQL setup, Compose files, Cloudflare and backup material (not yet used in production) |
| `docs`            | Spec, design system, progress and decision records                                           |
