# ADAS CRM

Internal CRM and outreach platform for **ADAS Globus Pro**, built for offshore accounting and tax staffing sales to CPA firms in the United States and Canada.

## Documentation

| Document                               | Purpose                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| [`AGENTS.md`](AGENTS.md)               | Engineering workflow, boundaries, commands and definition of done      |
| [`docs/PRD.md`](docs/PRD.md)           | Product requirements, domain model, compliance rules and architecture  |
| [`docs/DESIGN.md`](docs/DESIGN.md)     | Visual system, tokens, typography, layout and component specifications |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Current phase checklist, open questions and assumptions log            |
| [`docs/decisions/`](docs/decisions/)   | Architecture Decision Records (ADRs)                                   |
| [`docs/runbooks/`](docs/runbooks/)     | Operational runbooks for deployment, backup restore and incidents      |

## Prerequisites

- **Node.js** 22 LTS (`>=22.0.0`)
- **pnpm** (`corepack enable` or `npm i -g pnpm`)
- **Docker** (Docker Desktop with WSL 2 on Windows, or Docker Engine on Ubuntu)

## Quick Start

1. **Clone and install dependencies:**

   ```bash
   pnpm install
   ```

2. **Configure environment:**

   ```bash
   cp .env.example .env
   ```

3. **Start the local stack (PostgreSQL, Mailpit, API and Web):**
   ```bash
   pnpm dev
   ```

## Local URLs

- **Web App:** `http://localhost:5174` (port 5173 is reserved for the marketing website preview server)
- **API:** `http://localhost:3000/api/v1`
- **API Docs (OpenAPI):** `http://localhost:3000/api/docs`
- **Mailpit UI:** `http://localhost:8025`

## Workspace Commands

| Command                      | Description                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm install`               | Install all workspace dependencies                                                           |
| `pnpm dev`                   | Start PostgreSQL & Mailpit (`infra/compose.dev.yml`), API and web app with hot reload        |
| `pnpm db:migrate`            | Apply Prisma migrations locally (`prisma migrate dev`)                                       |
| `pnpm db:migrate:new <name>` | Create a new migration to hand-edit (`--create-only`)                                        |
| `pnpm db:seed`               | Load synthetic seed data (`--size=large` loads 60k contacts, 20k companies, 300k activities) |
| `pnpm lint`                  | Run ESLint (with module-boundary rules) and Prettier check                                   |
| `pnpm typecheck`             | Run `tsc --noEmit` across all packages and apps                                              |
| `pnpm test`                  | Run unit tests (Vitest)                                                                      |
| `pnpm test:int`              | Run integration tests (Vitest)                                                               |
| `pnpm test:e2e`              | Run Playwright end-to-end and axe accessibility tests                                        |
| `pnpm check`                 | Run `lint` + `typecheck` + `test` + `test:int` (required before every commit)                |
| `pnpm build`                 | Production build of shared, API and web packages                                             |
| `pnpm api:openapi`           | Regenerate the OpenAPI snapshot and web API client                                           |
