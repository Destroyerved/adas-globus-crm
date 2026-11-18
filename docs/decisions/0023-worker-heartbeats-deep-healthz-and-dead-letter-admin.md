# ADR 0023: Worker Heartbeats, Deep `/healthz` Readiness & Dead-Letter Admin Queue

- **Status:** Accepted
- **Date:** 2026-11-18
- **References:** PRD 6.5, 6.9, 9, 10.5, 10.6, 11 (Phase 1)

## Context

`PRD 10.6` requires `/healthz` (exposed on both `crm.` and public `go.`) to report database reachability, worker liveness (`outbox.dispatch` under 1 minute), oldest pending outbox age (< 5 minutes), backup recency (< 26 hours), and Graph subscription expiry health. `PRD 11 (Phase 1)` also requires an Admin alert when an `outbox_events` row exhausts retries and moves to `dead_letter`, plus an operational way to re-queue or dismiss dead-lettered events safely without exposing personal data.

## Decision

1. **Worker Heartbeats & Graceful Drain (`worker_heartbeats`, migration `0022`):**
   - `JobRunner` (`platform/jobs`) upserts a row in `worker_heartbeats` on startup, pulses every 15 seconds and after every job run (recording `last_job_name`, `last_job_at`, and `last_outbox_dispatch_at`), tracks `active_jobs`, and on `SIGTERM`/`SIGINT` (`stop()`) transitions to `draining`, waits for in-flight jobs to finish before closing pg-boss, and sets `status = 'stopped'`.
   - The HTTP server (`main.ts`) likewise traps `SIGINT`/`SIGTERM`, stops accepting new connections via `server.close()`, drains active requests with a 15-second upper bound, and closes the PostgreSQL pool cleanly.

2. **Public-Safe Deep `/healthz` vs Strict Monitoring (`HealthService.checkReadiness`):**
   - Because `/healthz` is served unauthenticated on `go.`, it returns only boolean/numeric health states (`database`, `outbox`, `worker`, `backups`, `mailSync`, `uptimeSeconds`) and never exposes hostnames, PIDs, paths, or error strings.
   - HTTP `503` is returned immediately if PostgreSQL is unreachable (`status: 'down'`), or when `?strict=1` is passed (for Uptime Kuma strict checks) and `status === 'degraded'` (oldest pending outbox >= 5 min, dead-letter count > 0, crashed running worker heartbeat > 60s, or last backup > 26h).

3. **PII-Free Admin Dead-Letter Alerts & Audited Retry/Purge:**
   - `OutboxDispatcher` (`platform/outbox`) exposes an `onDeadLetter` listener hook so `platform/` stays decoupled from `modules/`. `jobs.ts` wires `onDeadLetter` to insert deduplicated `security` notifications (`dedupeKey: outbox_dlq:<eventId>:<retryCount>:<adminId>`) for all active `Admin` users, containing only `event_type`, `aggregate_type`, attempt count, and sanitized error class/code.
   - `GET /api/v1/admin/system-health`, `POST /api/v1/admin/outbox/:id/retry`, `POST /api/v1/admin/outbox/retry-all`, and `DELETE /api/v1/admin/outbox/:id` are gated by `settings.manage`, omit `payload` JSON so PII never leaves the database, increment `outbox_events.retry_count`, and record `audit_logs` entries.
