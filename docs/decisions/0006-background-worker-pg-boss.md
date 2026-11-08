# ADR 0006: Background worker on pg-boss

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

PRD 6.9 lists jobs that must run without anyone clicking: outbox dispatch, task reminders and overdue alerts (PRD 4.7, 4.16), inquiry first-reply SLA warnings and breaches (PRD 4.10, 4.16), and idle-deal flags (PRD 4.6). PRD 6.2 fixes pg-boss on the existing PostgreSQL database as the queue: no Redis, no second database. Until now `apps/api/src/worker.ts` logged "ready" and exited.

## Decision

1. **pg-boss talks through the app's own connection.** `platform/jobs` gives pg-boss a `db.executeSql` adapter over `DatabaseService`. Production uses the same pool as the rest of the app; integration tests use PGlite, so the test suite runs the real pg-boss code, not a stand-in. pg-boss's multi-statement schema scripts have no parameters and go through `db.exec`, because PGlite runs only one statement per parameterised query.
2. **The schema is installed by `pnpm db:migrate`, not by the worker.** After the SQL migrations, `migrate.ts` runs pg-boss's own installer as the admin role (`DATABASE_ADMIN_URL`), creates every queue in `JOB_QUEUES`, and grants `adas_app` DML on schema `pgboss` (plus default privileges for tables pg-boss adds later). The worker starts pg-boss with `migrate: false`, so the app role never needs CREATE or ALTER rights, the same rule as for our own tables (ADR 0003).
3. **Every job is a periodic sweep on a "stately" queue.** A stately queue holds at most one queued and one running job, so a slow run never piles up copies behind it. Schedules are cron in UTC: reminders and overdue alerts every minute, SLA every 5 minutes, idle deals hourly at :07, housekeeping hourly at :23. The outbox is polled every 2 seconds by a timer that queues a run; pg-boss cron has minute resolution.
4. **Idempotency lives in the rows, not in the queue.** Each sweep claims at most 500 rows with `FOR UPDATE … SKIP LOCKED` in one transaction, stamps the row (`reminder_sent_at`, `overdue_notified_at`, `sla_warned_at`, `sla_breached`, `idle_flagged_at`) and writes notifications with a unique `dedupe_key`. Two workers, a retried job or a crash before commit can therefore never notify twice. Any number of workers may run.
5. **What each sweep does:**
   - **Reminders:** an open task whose `reminder_at` has passed notifies its assignee once. Editing the reminder clears `reminder_sent_at`, and the dedupe key includes the reminder time, so a new reminder fires again.
   - **Overdue:** an open task past `due_at` notifies its assignee once and emits `task.overdue`. First-reply inquiry tasks are left to the SLA check, so nobody gets two alerts for one late reply.
   - **First-reply SLA:** four hours before the deadline the assignee gets one warning. After the deadline the task is marked `sla_breached`, and the assignee plus every active Sales Manager and Admin in the task's team is notified once each; `task.overdue` is emitted with `slaBreached: true`. Four hours is a fixed default (PRD 4.16 says "before the deadline" without a number); it can move to settings when someone asks.
   - **Idle deals:** an open deal with no activity for longer than its stage's `idle_days` notifies its owner once per quiet spell. A spell ends when `last_activity_at` moves past `idle_flagged_at`; the job compares the two instead of relying on every activity writer to clear the flag.
   - **Housekeeping:** deletes idempotency keys older than their 24 hours (ADR 0004) and sessions that expired or were revoked more than 30 days ago. Audit logs and suppressions are never touched.
6. **The outbox is dispatched one event per transaction.** The dispatcher locks a pending event with `SKIP LOCKED`, runs the handlers registered for its type (and `*`) inside the same transaction, and marks it processed in that transaction, so an event is processed exactly when its handlers' writes commit. A failure rolls the handlers' writes back, increments `attempts` and sets `available_at` with exponential backoff (2^attempts seconds, at most an hour). After 10 attempts the event moves to `dead_letter` and an error is logged. `last_error` stores only the error class and code, because error messages can carry personal data.
7. **Composition lives outside `platform/`.** `apps/api/src/jobs.ts` wires the business sweeps (`modules/crm/jobs.ts`) to the generic runner, so platform code still never imports a module.

## Deferred

- **No outbox handlers are registered yet.** Outbound webhooks (n8n) and sequence steps attach their handlers when those phases land. Until then dispatch only marks events processed. The existing `POST /n8n/webhooks/dispatch` route computes signatures but sends nothing, marks events processed itself and has no capability check; it should be replaced by an outbox handler when the n8n connector is built (logged in `PROGRESS.md`).
- **Dead-letter alerting to admins** (a notification, not only a log line) comes with the admin health page.
- **Sequence steps, retention and backup checks** (the rest of PRD 6.9) arrive with the phases that own them.

## Consequences

- `pnpm dev` now starts the worker next to the API and web app.
- `pnpm db:migrate` needs `DATABASE_ADMIN_URL` to reach the database as before, and now also installs the `pgboss` schema.
- Like the API, the worker refuses to start with `NODE_ENV=production` until the production checklist in `PROGRESS.md` is done.
