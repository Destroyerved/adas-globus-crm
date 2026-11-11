# ADR 0012: A separate PostgreSQL for development

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

AGENTS.md section 5 says the running API must use real PostgreSQL, never an in-memory database. The development machine has PostgreSQL 17 installed as a Windows service, but nobody knows its `postgres` password, so the CRM's roles and databases could not be created in it. Docker is not installed. Resetting the password means editing the server's access file as an administrator and restarting the service.

## Decision

1. **`pnpm db:local init` creates a second, separate server** (`scripts/local-db.mjs`) from the PostgreSQL programs already installed. It runs `initdb` into its own data folder and then runs `infra/postgres/create-local-dev-db.sql`, the same script the README gives for an installed server.
2. **Nothing existing is touched.** The installed service, its data and its settings stay as they are. No administrator rights are needed.
3. **Where it lives.** The data folder is under the user's profile (`%LOCALAPPDATA%\adas-crm\pg-dev`), not in the repository: the repository is in Documents, which a sync tool may copy, and a database must not be synced file by file.
4. **How it is reached.** It listens on `localhost:5433` only, with password logins (`scram-sha-256`). `.env` points `DATABASE_URL` and `DATABASE_ADMIN_URL` at that port; the role passwords are the development values in `.env.example`.
5. **Its superuser password** is generated at `init`, saved in a file beside the data folder and never printed. The script passes it to `psql` through the child process's environment.
6. **Planner settings match production** (`random_page_cost = 1.1`, `effective_cache_size = 8GB`, `work_mem = 16MB`, from `infra/postgres/postgresql.conf`), so query plans seen in development are the plans production will choose (ADR 0011).
7. **Starting it.** It is not a Windows service. `pnpm dev` starts it when it exists, and `pnpm db:local start` starts it by hand. `stop`, `status` and `reset` (empty both CRM databases) complete the set.

## Consequences

- **After a restart of the computer** the server is down until `pnpm dev` or `pnpm db:local start` runs.
- **Development data only.** It has no backups and the role passwords are public. Real customer data must never go into it.
- **Two servers on one machine.** The installed service keeps port 5432 and is unused by the CRM. If its password is recovered later, pointing `.env` back at 5432 and running the README's setup script is all it takes to switch.
- **Other developers** with Docker or a known `postgres` password don't need this; the README keeps those two routes first.
