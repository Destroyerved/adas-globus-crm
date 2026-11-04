# ADR 0003: PostgreSQL at runtime, SQL migration runner, PGlite for tests only

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** the runtime part of ADR 0002 (in-memory PGlite inside the API)

## Context

The API ran on an in-memory PGlite database that was rebuilt and seeded on every start, so nothing was ever saved. `DATABASE_URL` was validated but unused, `pnpm db:seed` printed a message and did nothing, and `pnpm db:migrate` called `prisma migrate dev`, which would try to diff a `schema.prisma` that the code doesn't use.

## Decision

1. **Runtime:** `DatabaseService.connect(DATABASE_URL)` uses the `pg` driver against PostgreSQL. It never migrates or seeds.
2. **Migrations:** `pnpm db:migrate` runs `apps/api/scripts/migrate.ts` as `adas_admin` (`DATABASE_ADMIN_URL`). It applies each `prisma/migrations/<name>/migration.sql` once, in folder order, in a transaction, and records it in `schema_migrations` with a SHA-256 checksum. If an applied migration has been edited, it stops. We use this rather than `prisma migrate deploy` because the SQL files are the source of truth today and Prisma Client isn't used. If Prisma Client is adopted later, baseline it against the existing schema first.
3. **Demo data:** `pnpm db:seed` (`apps/api/scripts/seed.ts`) loads `platform/db/seed.ts`. It refuses to run with `NODE_ENV=production`, and a unit test proves every seeded email uses an `example` domain.
4. **Tests:** `DatabaseService.forTests()` builds a fresh, migrated, seeded database: real PostgreSQL when `TEST_DATABASE_URL` is set (the schema is dropped and rebuilt), otherwise in-memory PGlite. Browser tests run the real API code against it via `apps/api/src/e2e-server.ts`.
5. **Local PostgreSQL without Docker:** `infra/postgres/create-local-dev-db.sql` creates the roles and databases that `.env.example` expects on an existing PostgreSQL install.

## Consequences

- Data survives restarts. The app needs a reachable PostgreSQL to start, and it fails fast if there isn't one.
- PGlite and PostgreSQL can differ in small ways (for example `bigint` and `numeric` come back as strings from `pg`). CI should also run `pnpm test:int` with `TEST_DATABASE_URL` against a PostgreSQL service.
- `schema.prisma` is documentation until Prisma Client is adopted. Keep it in step with the SQL migrations.
