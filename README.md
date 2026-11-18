# ADAS CRM

The internal CRM and outreach platform for **ADAS Globus Pro**: companies, contacts, leads, deals, tasks, unified Microsoft 365 Inbox, multi-step outreach sequences, marketing campaigns, compliance & privacy operations, analytics reports, one-click server installers, and an Electron server management console for selling offshore accounting and tax staff to CPA firms in the U.S. and Canada.

## Documentation Index

- **Specification & Design:** [`docs/PRD.md`](docs/PRD.md) · [`docs/DESIGN.md`](docs/DESIGN.md) · [`AGENTS.md`](AGENTS.md)
- **Readiness & Progress:** [`docs/PRODUCTION_READINESS_REPORT.md`](docs/PRODUCTION_READINESS_REPORT.md) · [`docs/PROGRESS.md`](docs/PROGRESS.md) · [`docs/PRODUCTION_AUDIT.md`](docs/PRODUCTION_AUDIT.md)
- **Installation & Deployment:** [`docs/INSTALLATION.md`](docs/INSTALLATION.md) · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) · [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md)
- **Server Console, Security & Day-2 Operations:** [`docs/ELECTRON_MANAGEMENT.md`](docs/ELECTRON_MANAGEMENT.md) · [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) · [`docs/OPERATIONS.md`](docs/OPERATIONS.md)

> **Owner Go-Live Gate:** All software modules, migrations, background workers, security guardrails, encrypted S3 backups/restore drills, one-click installers, server agent, and Electron console are built and verified against PostgreSQL 17 and Playwright (`40/40` E2E tests). Live external sends remain locked off (`MAIL_LIVE=false`) until the owner provisions external credentials (`Entra`, `ESP`, `Apollo`), legal counsel signs off `PRD §5`, and the stack is deployed onto the dedicated Ubuntu Server LTS host (see [`docs/PRODUCTION_READINESS_REPORT.md`](docs/PRODUCTION_READINESS_REPORT.md)).

---

## Local Development Quickstart

You need **Node.js 22+**, **pnpm**, and **PostgreSQL 17** (either Docker via `docker compose -f infra/compose.dev.yml up -d` or local binaries via `pnpm db:local init` on port `5433`).

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- **Web App:** `http://localhost:5174` (uses synthetic dev sign-in outside production)
- **HTTP API & OpenAPI Docs:** `http://localhost:3000/api/v1` · `http://localhost:3000/api/docs`
- **Mailpit (Dev Mail Sink):** `http://localhost:8025`

---

## Key Workspace Commands

| Command                                    | Description                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                 | Start PostgreSQL (`db:local` if configured), HTTP API, `pg-boss` worker, and Vite web app                   |
| `pnpm db:migrate`                          | Apply forward-only SQL migrations (`apps/api/prisma/migrations`) as `adas_admin`                            |
| `pnpm db:seed`                             | Seed synthetic CPA data (`--size=large` loads `20k` companies, `60k` contacts, `300k` activities)           |
| `pnpm db:plans`                            | Run `EXPLAIN ANALYZE` across 93 real screen queries (`docs/perf/query-plans-postgres.md`)                   |
| `pnpm perf:load`                           | Run 20-VU concurrent HTTP load test against `PRD §12.2` latency budgets (`docs/perf/load-test-postgres.md`) |
| `pnpm backup:run` / `pnpm backup:drill`    | Create an `ADASBK01` AES-256-GCM encrypted backup or run a full disposable-DB restore drill                 |
| `pnpm break-glass set <email>`             | Provision Argon2id + TOTP emergency Admin sign-in (max 2 Admins)                                            |
| `pnpm installer` / `pnpm installer:wizard` | Run the cross-platform server installer CLI or loopback (`127.0.0.1:3088`) setup wizard                     |
| `pnpm agent:start` / `pnpm agent:pair`     | Run `@adas/server-agent` (`127.0.0.1:3090`) or issue a single-use 5-minute pairing code                     |
| `pnpm desktop:start`                       | Build and launch the standalone Electron Desktop Server Management Console (`@adas/desktop`)                |
| `pnpm check`                               | Run ESLint (including module-boundary rules), Prettier, `tsc --noEmit`, unit & integration suites           |
| `pnpm test:e2e`                            | Build `@adas/web` + `@adas/desktop` and run all 40 Playwright + `axe-core` E2E tests                        |
| `pnpm build`                               | Build all production workspace packages and compile `dist/deployer/ADAS-CRM-Deployer.exe`                   |

---

## Monorepo Layout

| Path                | Description                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/api`          | HTTP server, modules, `pg-boss` worker, `SecretBox`, `BackupManager`, SQL migrations & CLI tools          |
| `apps/web`          | React + Vite + TanStack Query + Tailwind v4 SPA (`DESIGN.md` tokens)                                      |
| `apps/server-agent` | Narrowly scoped authenticated server management daemon (`HMAC-SHA256`, RBAC, hash-chained audit log)      |
| `apps/desktop`      | Hardened Electron Desktop Server Management Console (`contextIsolation`, `sandbox`, `ServerProfileVault`) |
| `installer`         | Cross-platform server preflight, idempotent provisioner, loopback wizard & `installer/install.sh`         |
| `packages/shared`   | Shared `zod` schemas, capabilities, compliance rules, email HTML sanitizer & formatters                   |
| `packages/config`   | Shared TypeScript, ESLint boundary & Prettier presets                                                     |
| `infra` & `scripts` | Production Dockerfile, `compose.prod.yml`, `deploy.sh`, `restore-drill.sh`, `k6`, `n8n` & `systemd`       |
| `e2e`               | Playwright + `@axe-core/playwright` browser & desktop console tests (`1440px` and `375px`)                |
| `docs`              | PRD, Design System, ADRs (`0001–0027`), benchmark reports, screenshots (`01–34`) & operational guides     |
