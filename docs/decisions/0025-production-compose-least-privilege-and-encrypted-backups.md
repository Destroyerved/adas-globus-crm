# ADR 0025: Production Compose Hardening, Least-Privilege DB Provisioning & Encrypted `ADASBK01` Backups

- **Status:** Accepted
- **Date:** 2026-11-18
- **References:** PRD 7.4, 9, 10.1–10.7, 12.1 (A21)

## Context

`PRD 10.2–10.7` requires pinned Docker Compose images within the 16 GB RAM budget, strict separation between the migration/admin PostgreSQL role (`adas_admin`) and the runtime application role (`adas_app`), a safe `scripts/deploy.sh` with pre-deploy backup, smoke checks, and automatic rollback, client-side encrypted off-site backups (`pg_dump -Fc` to S3-compatible R2/B2), and an automated monthly restore drill (`scripts/restore-drill.sh`) reporting to Uptime Kuma.

## Decision

1. **Least-Privilege PostgreSQL Provisioning & Fail-Closed Boot Guard:**
   - `infra/compose.prod.yml` boots `postgres:17.4-alpine` with `POSTGRES_USER: adas_admin` (`postgres_admin_password.txt`), while `infra/postgres/00-provision-roles.sh` provisions `adas_app` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`) from `postgres_app_password.txt`.
   - `verifyProductionReadiness` (`platform/config/prod-readiness.ts`) runs on both API and worker startup in `NODE_ENV=production`, refusing to start if `current_user` has `rolsuper = true`, if `SESSION_SECRET_FILE` or `TOKEN_ENCRYPTION_KEY_FILE` is missing, or if `MAIL_LIVE=true` without `compliance.counsel_signed_off = true`.

2. **Single-Image Compiled CLI Entrypoints & Pinned Services:**
   - `apps/api/src/cli/{migrate,backup,break-glass}.ts` and `apps/api/src/worker-healthcheck.ts` compile into `dist/` so `api`, `worker` (with DB-backed heartbeat healthcheck), `backup` (`256 MB` daemon), and `scripts/deploy.sh` run on `node --conditions=production-dist` without `tsx` in production. `n8n` is placed under `profiles: ["automation"]` per `PRD 10.2`.

3. **`ADASBK01` Envelope Encryption, Zero-Dependency S3 SigV4 & Restore Drill:**
   - `BackupManager` (`platform/backup`) wraps `pg_dump -Fc` output in an `ADASBK01` envelope (`HKDF-SHA256` key derivation + `AES-256-GCM` 12-byte IV + 16-byte tag) with a SHA-256 manifest, syncs to S3/R2/B2 via `AWS4-HMAC-SHA256` (`s3-sigv4.ts`), and prunes local files older than 14 days.
   - `runRestoreDrill` (`scripts/restore-drill.sh`) verifies checksums and GCM tags, runs `pg_restore` into an isolated throw-away database, validates row counts, generated `search_tsv` columns, zero FK orphans, and `audit_logs` / `suppressions` immutability triggers, drops the throw-away DB, writes `backup_runs`, and notifies Uptime Kuma.
