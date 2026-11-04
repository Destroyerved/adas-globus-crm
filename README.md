# ADAS CRM — Internal CRM, Sales Pipeline & Compliant Outreach Platform

**ADAS CRM** is the self-hosted internal CRM, 3-day free-trial pipeline, and compliant email automation platform for **ADAS Globus Pro**, built for offshore accounting, tax, and audit staffing sales to CPA firms in the **United States (`USD` / `CAN-SPAM`)** and **Canada (`CAD` / `CASL`)**.

---

## 1. Key Capabilities (Phases 0–6 Complete)

| Module                                                                              | What It Delivers                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Website Intake & 15m SLA (`PRD §4.10`)**                                          | Public `POST /api/v1/public/inquiries` endpoint on `go.<domain>` with honeypot spam drop, 24-hour idempotency, free-mail domain blocklist, round-robin market routing, automatic **6-month CASL Implied Inquiry consent**, and a 15-minute SLA task timer.                                                               |
| **Company 360 & Contacts (`PRD §4.3–4.4`)**                                         | Registrable domain deduplication, multi-email/E.164 phone normalization, inline firmographic editing with optimistic concurrency (`version`) and field-level `record_history`, plus unified 6-tab Company 360 timeline (`Activity`, `Overview`, `Contacts`, `Deals`, `Notes`, `History`).                                |
| **Leads, 3-Day Free Trial & Multi-Currency Kanban (`PRD §4.5–4.7`)**                | Saved views, bulk actions (`Assign`, `Change status`, `Add tag`, `Export`), one-click **Lead → Company + Contact + Deal + 3-Day Free Trial check-in tasks (Day 1, Day 2, Day 3)** conversion, and a keyboard-accessible Deals Kanban board with live `USD`/`CAD` FX rollup.                                              |
| **CSV Import Dry-Run, Rollback & Duplicate Merge (`PRD §4.9`)**                     | Dry-run preview with duplicate detection (`pg_trgm` fuzzy company matching + exact email), 7-day batch rollback by `import_job_id`, contact merge with `merge_audit` snapshot, and 30-day merge undo.                                                                                                                    |
| **Connected Microsoft 365 Inbox (`PRD §4.11, §8.2`)**                               | Privacy-filtered inbox sync (only stores threads matching known CRM contacts/domains), automatic **sequence auto-stop on inbound reply** with follow-up task creation, and 1-to-1 reply composer.                                                                                                                        |
| **Anti-Spam Deliverability, Warm-Up & `checkSendable()` Gate (`PRD §5, §8.3–8.6`)** | Single mandatory `checkSendable()` gate inside `send.message`, 14 deterministic reason codes, **4-week mailbox & subdomain warm-up ramp (`15 → 25 → 35 → 50/day`)**, `2–20 min` random send jitter, zero open-tracking pixels, RFC 8058 one-click `List-Unsubscribe`, and `>3.0%` bounce / `>0.1%` complaint auto-pause. |
| **CPA Firmographic Email Tailoring & n8n Pipeline (`PRD §4.12–4.14`)**              | Tailors plain-text outreach by CPA software stack (`UltraTax CS`, `CaseWare`, `TaxCycle`, `CCH Axcess`), US IRS vs Canada CRA tax workflows, and market-matched postal footers (**Sheridan, WY** vs **Edmonton, AB**), orchestrated via signed `HMAC-SHA256` webhooks (`X-ADAS-Signature`) and **n8n**.                  |

---

## 2. One-Click Deployment on a 16 GB RAM Server (`ADAS-CRM-Deployer.exe`)

The repository includes a compiled standalone Windows GUI + CLI executable — **[`ADAS-CRM-Deployer.exe`](ADAS-CRM-Deployer.exe)** (source in [`infra/deployer/AdasCrmDeployer.cs`](infra/deployer/AdasCrmDeployer.cs)) — with built-in **Cloudflare Tunnel**, **Anti-Spam DNS zone generation**, and **16 GB RAM server tuning**.

### Option A: One-Click Windows GUI Mode

1. Copy or clone this repository onto your 16 GB RAM server.
2. Double-click **`ADAS-CRM-Deployer.exe`**.
3. Enter your **Purchased Domain** (e.g., `adasglobuspro.com`) and optional **Cloudflare Tunnel Token**.
4. Click:
   - **`1. Provision Cloudflare + Anti-Spam DNS + Secrets`** — generates 256-bit cryptographic secrets in `secrets/`, writes `infra/cloudflare/config.yml`, writes `infra/cloudflare/dns-records.bind`, and creates `.env.production`.
   - **`2. One-Click Start CRM Service (:3000)`** — launches the unified production server (serving both the React SPA and `/api/v1/*` on `http://localhost:3000`) or starts the 16 GB Docker Compose stack (`infra/compose.prod.yml`).
   - **`3. Setup Cloudflared Tunnel`** — verifies `cloudflared` and prints/executes the Cloudflare Tunnel DNS routing and Windows Service registration commands.

### Option B: Headless CLI Mode (PowerShell / Terminal)

```powershell
# Rebuild ADAS-CRM-Deployer.exe from source (optional — binary is pre-built)
pnpm build:exe

# Provision secrets, Cloudflare Tunnel config.yml, Anti-Spam DNS records & .env.production
.\ADAS-CRM-Deployer.exe --provision --domain yourdomain.com --tunnel-name adas-crm-prod-16gb

# Provision AND start the unified CRM service on port 3000
.\ADAS-CRM-Deployer.exe --start-service --domain yourdomain.com
```

### Cloudflare Tunnel Ingress Architecture (`infra/cloudflare/config.yml`)

No inbound ports (`80`, `443`, or `22`) need to be opened on your office router. Outbound `cloudflared` routes four hostnames (`PRD §10.4`):

| Hostname                              | Target Service                                                     | Access Policy                                                                 |
| ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `https://crm.<yourdomain.com>`        | `http://localhost:3000` (Unified Web SPA + `/api/v1`)              | Protected by Cloudflare Access (Microsoft Entra ID SSO)                       |
| `https://go.<yourdomain.com>`         | `http://localhost:3000` (`/api/v1/public/inquiries` & `/u/:token`) | Public (Rate-limited; serves website forms & RFC 8058 one-click unsubscribes) |
| `https://status.<yourdomain.com>`     | `http://localhost:3001` (Uptime Kuma)                              | Protected by Cloudflare Access                                                |
| `https://automation.<yourdomain.com>` | `http://localhost:5678` (n8n Workflows)                            | Protected by Cloudflare Access                                                |

### 16 GB RAM Server Memory Budget (`infra/compose.prod.yml` & `PRD §10.2–10.3`)

```bash
# Launch the full 16 GB production container stack
docker compose -f infra/compose.prod.yml up -d
```

| Service / Component                    | Memory Limit             | Notes                                                                                                                                                           |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (`postgres:17-alpine`)      | `4,096 MB` (4.0 GB)      | Tuned via [`infra/postgres/postgresql.16gb.conf`](infra/postgres/postgresql.16gb.conf) (`shared_buffers=2GB`, `effective_cache_size=8GB`, `wal_compression=on`) |
| `api` (HTTP API + Static React SPA)    | `1,024 MB` (1.0 GB)      | Single container serving both the SPA and `/api/v1` on `:3000`                                                                                                  |
| `worker` (`pg-boss` / background jobs) | `768 MB`                 | Runs `send.message`, `sequence.tick`, `campaign.tick`, `outbox.dispatch`, imports                                                                               |
| `n8n` (`n8nio/n8n:1.76.1`)             | `1,536 MB` (1.5 GB)      | Pre-mounted with workflows in `infra/n8n/workflows/` on `:5678`                                                                                                 |
| `uptime-kuma`                          | `256 MB`                 | Monitors `/healthz`, worker heartbeat, and backup age on `:3001`                                                                                                |
| `cloudflared`                          | `128 MB`                 | Outbound Cloudflare Argo Tunnel daemon                                                                                                                          |
| **OS & PostgreSQL Page Cache**         | **~8,448 MB (~8.25 GB)** | Dedicated OS + filesystem page cache headroom for fast PostgreSQL index scans                                                                                   |

---

## 3. Anti-Spam Deliverability, Warm-Up Ramp & n8n Email Automation

### Why Emails Land in the Primary Inbox (Not Spam)

1. **Channel & Domain Reputation Isolation (`PRD §5.4, §8.1`):**
   - **1-to-1 Prospecting Sequences** send through each employee's connected **Microsoft 365 mailbox** (`adasglobuspro.com`) at human volume (`≤ 50/day`).
   - **1-to-Many Marketing Campaigns** send through a dedicated subdomain (`mail.<yourdomain.com>`) so the root corporate domain is never exposed to bulk-mail reputation risk.
   - **Custom Link Domain:** Unsubscribe links (`https://go.<yourdomain.com>/u/:token`) use your own domain rather than shared ESP tracking domains.
2. **Zero Open-Tracking Pixels & Plain-Text First (`PRD §4.12`):**
   - Invisible 1×1 tracking pixels are strictly disabled (`openTrackingPixels: false`), and sequence emails render as clean plain text with `2–20 minute` randomized send jitter inside the recipient's local business hours (`08:00–17:00` US/CA time).
3. **4-Week Gradual Warm-Up Ramp Schedule (`GET /api/v1/outreach/warmup-status`):**
   - **Week 1 (Days 1–6):** `15/day` per mailbox · `50/day` campaign subdomain (`10/hr` throttle)
   - **Week 2 (Days 7–13):** `25/day` per mailbox · `150/day` campaign subdomain (`25/hr` throttle)
   - **Week 3 (Days 14–20):** `35/day` per mailbox · `400/day` campaign subdomain (`50/hr` throttle)
   - **Week 4+ (Day 21+):** `50/day` per mailbox · `1,000/day` campaign subdomain (`100/hr` throttle)
4. **CPA Firmographic Email Tailoring (`POST /api/v1/outreach/tailor-preview`):**
   - Tailors every message to the CPA firm's exact software stack (`UltraTax CS`, `CaseWare`, `TaxCycle`, `CCH Axcess`, `QuickBooks`, `Suralink`), tax regime (**IRS 1040/1065/1120** for US vs **CRA T1/T2** for Canada), firm size band (`11–20`, `21–50`, `51–100`), and market-matched physical postal footer (**Sheridan, WY** for US; **Edmonton, AB** for Canada per `PRD §5.5`).
5. **Pre-Built n8n Workflows ([`infra/n8n/workflows/`](infra/n8n/README.md)):**
   - [`01-inbound-lead-enrichment-and-sequence-enrollment.json`](infra/n8n/workflows/01-inbound-lead-enrichment-and-sequence-enrollment.json): Verifies `X-ADAS-Signature` (`HMAC-SHA256`) → checks warm-up allowance → tailors email by CPA software stack → verifies `checkSendable()` → enrolls in `seq_us_tax` or `seq_ca_casl`.
   - [`02-marketing-campaign-preflight-and-dispatch.json`](infra/n8n/workflows/02-marketing-campaign-preflight-and-dispatch.json): Runs every 15 minutes during North American send windows to dispatch `Marketing Manager`-approved campaign batches with `>3.0%` bounce and `>0.1%` complaint auto-pause protection.

---

## 4. Local Development Quickstart

### Prerequisites

- **Node.js** 22 LTS (`>=22.0.0`)
- **pnpm** (`corepack enable`)
- **Docker** (optional for external PostgreSQL/Mailpit/n8n containers; tests also run standalone with embedded PostgreSQL 17 `@electric-sql/pglite` + `pg_trgm` + `unaccent`)

### Setup & Run

```bash
# 1. Install dependencies
pnpm install

# 2. Copy local environment variables
cp .env.example .env

# 3. Start local development stack (API on :3000 + Web on :5174)
pnpm dev

# 4. (Optional) Start local n8n container on http://localhost:5678
pnpm dev:n8n
```

### Local URLs

| Service                             | URL                                                     |
| ----------------------------------- | ------------------------------------------------------- |
| **Web App (Dev / Preview)**         | `http://localhost:5174`                                 |
| **Unified API (+ Prod Static SPA)** | `http://localhost:3000` (`/api/v1/health`, `/api/v1/*`) |
| **n8n Workflow Editor**             | `http://localhost:5678`                                 |
| **Mailpit Sandbox UI**              | `http://localhost:8025`                                 |

---

## 5. Workspace Scripts & Verification Suite

| Command            | Description                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`     | Install all monorepo dependencies                                                                                       |
| `pnpm dev`         | Start PostgreSQL & Mailpit (`infra/compose.dev.yml`), API (`:3000`), and Web (`:5174`)                                  |
| `pnpm dev:n8n`     | Start PostgreSQL, Mailpit, and the Phase 6 `n8n` container (`infra/compose.n8n.yml`)                                    |
| `pnpm db:migrate`  | Apply Prisma migrations locally                                                                                         |
| `pnpm db:seed`     | Load synthetic US & Canadian CPA firm data (`--size=large` for 60k contacts / 20k companies)                            |
| `pnpm lint`        | Run ESLint (`--max-warnings 0`, including module-boundary rules) and Prettier check                                     |
| `pnpm typecheck`   | Run strict `tsc --noEmit` across `@adas/config`, `@adas/shared`, `@adas/api`, and `@adas/web`                           |
| `pnpm test`        | Run unit test suite (`52` unit tests covering `checkSendable()`, normalization, formatters, guardrails)                 |
| `pnpm test:int`    | Run PostgreSQL 17 integration test suite (`21` tests covering `PRD §12.2` `A1`–`A20` + `/healthz`)                      |
| `pnpm test:e2e`    | Run Playwright full-stack E2E & WCAG 2.2 AA (`axe-core`) suite (`14` specs across `1440px`, `1280px`, `768px`, `375px`) |
| `pnpm check`       | Run `lint` + `typecheck` + `test` + `test:int` (**must pass with 0 errors before every commit**)                        |
| `pnpm build`       | Build `@adas/shared`, `@adas/api`, `@adas/web`, and compile `ADAS-CRM-Deployer.exe`                                     |
| `pnpm build:exe`   | Compile standalone `ADAS-CRM-Deployer.exe` (`infra/deployer/AdasCrmDeployer.cs`)                                        |
| `pnpm api:openapi` | Regenerate `apps/api/openapi.json` from shared Zod schemas                                                              |

---

## 6. Repository Layout & Documentation Index

```text
adas-crm/
├── ADAS-CRM-Deployer.exe     Standalone Windows GUI + CLI 16GB Server & Cloudflare Deployer
├── AGENTS.md                 Engineering rules, safety guardrails, and phase discipline
├── docs/
│   ├── PRD.md                Product requirements, domain model, CAN-SPAM/CASL compliance & architecture
│   ├── DESIGN.md             Visual system, tokens, typography (self-hosted Hanken Grotesk), and layouts
│   ├── PROGRESS.md           Phase 0–6 completion checklist and verification evidence
│   ├── decisions/            Architecture Decision Records (ADRs 0001 & 0002)
│   ├── runbooks/             Operational runbooks (deploy, restore drill, key rotation, incident response)
│   └── screens/              22 verified Playwright screenshots (1440px desktop & 375px mobile)
├── infra/
│   ├── compose.dev.yml       Local PostgreSQL 17 + Mailpit stack
│   ├── compose.n8n.yml       Phase 6 n8n container definition (1.5 GB RAM cap)
│   ├── compose.prod.yml      16 GB RAM production stack (Postgres, API+SPA, Worker, n8n, Uptime Kuma, Cloudflared)
│   ├── cloudflare/           Cloudflare Tunnel config template & generated DNS zone records
│   ├── deployer/             C# source for ADAS-CRM-Deployer.exe
│   ├── n8n/workflows/        Ready-to-import n8n marketing & sequence automation workflows (01 & 02)
│   └── postgres/             PostgreSQL 17 extensions & 16 GB RAM configuration (postgresql.16gb.conf)
├── packages/
│   ├── config/               Shared TypeScript, ESLint, and Prettier presets
│   └── shared/               Shared Zod schemas, RBAC capability matrix, filter AST, and formatters
├── apps/
│   ├── api/                  Backend HTTP server, worker, Prisma schema/migrations, and domain modules
│   └── web/                  React 19 + Vite 6 + Tailwind v4 SPA (11 screens across Phases 0–6)
└── e2e/                      Playwright E2E, responsive overflow, and axe-core WCAG 2.2 AA test suites
```
