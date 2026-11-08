# ADR 0005: Editable roles, admin settings and how dashboard metrics are counted

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

M1 needs admin settings (PRD 2.1, 2.2, 3.3, 3.4, 4.17) and a role dashboard (PRD 4.2) with the metric definitions in PRD 14. Several choices here change what numbers people see or who can do what, so they are recorded.

## Decision

1. **Roles are editable bundles of capabilities.** The defaults stay in `ROLE_CAPABILITY_MATRIX` (code). An admin's change to a role is stored in `role_capabilities` as an override row (role, capability, scope). `resolveSessionUser` merges the overrides over the defaults on every request, so a change applies from each person's next click without signing out. An override equal to the default is deleted, so "Changed" in the UI always means a real difference.
2. **Nobody can lock the company out.** The Admin role keeps `users.manage`, `settings.manage` and `audit.read` at `all`. An admin can't change their own role or deactivate themself, and the last active admin can't be demoted or deactivated (422 with a field error).
3. **One role per user.** PRD 2.1 allows several roles per person. The schema and the session hold one `role_id`; several roles can come later by merging their grants with the most generous scope winning. Not needed by any current user.
4. **Records follow their owner to a new team.** When an admin moves a person to another team, the `team_id` on the leads, contacts, companies and deals they own, and the tasks assigned to them, moves too, in the same transaction. Otherwise team-scoped managers would lose sight of their own team's work. The move is audited with the counts.
5. **Deactivation ends sessions at once.** Deactivating a person revokes their sessions in the same transaction (audited with the count). Reactivation returns them to `active` if they have signed in before (Entra object ID or break-glass), otherwise to `invited`.
6. **Stages are identified by id and a trial flag, not by name.** `pipeline_stages.is_trial` marks the free-trial stage (at most one open stage per pipeline), and `deal_stage_history` records `from_stage_id` and `to_stage_id` (backfilled by name for old rows). Renaming a stage therefore can't break trial tasks, required fields or trial-to-win reporting. Renaming updates `deals.stage_name`; a probability change updates the deals that haven't overridden it. Won is always 100% and lost always 0%; lost stages always ask for a lost reason. Stages with deals can't be removed.
7. **Reference lists are settings rows** (`reference.*`) with optimistic `version` and an audit entry holding before and after. Values are unique ignoring case. Two numbers live here too: the first-reply SLA in business days and the default idle-deal days.
8. **Dashboard periods are whole days in the viewer's time zone** (`users.timezone`, editable under Your preferences). The API turns `from` and `to` dates into UTC instants in SQL (`(date::timestamp AT TIME ZONE tz)`), returns them as `period.start` and `period.end`, and the web app puts the same instants into list filters, so a number and the list it opens always agree. Periods are at most two years.
9. **Reporting currency is USD.** Open pipeline converts CAD at the latest `fx_rates` rate; revenue won uses each deal's `fx_rate_scaled_at_close`. When no rate exists the amount is listed separately as "not included", never guessed. Contract value is monthly value × term + one-time value; weighted value multiplies by the stage probability, rounded half up.
10. **The SLA clock stops on the first logged call or email.** Logging either against the lead or contact completes its open first-reply task and sets `sla_breached` if the reply came after the deadline. "Replied on time" is completed and not breached over all inquiries received in the period; the typical first reply is the median of completed ones.
11. **Every widget is its own request** (`GET /dashboard/widgets/:id`), checked against the widget's capability and the viewer's scope in SQL. One slow or failing metric shows its own error with a retry and doesn't block the page. The layout per role comes from `GET /dashboard`.
12. **Charts are CSS bars, not a chart library.** The current widgets are ranked bars and KPI tiles, which need no library. Bars use one colour (`--chart-1`, `--chart-muted` for lost or excluded values), carry a screen-reader summary and a "View as table" toggle (DESIGN 7). Recharts can be added when a time-series chart is needed.

## Deferred

- **Change vs the previous period** on KPI tiles (DESIGN 6.7) needs a second query per widget; deferred until the reporting phase.
- **Recent replies** for sales roles (PRD 4.2) needs the inbox (Phase 4).
- **Capability keys:** the runtime keys in `ROLE_CAPABILITY_MATRIX` differ slightly from `CAPABILITY_KEYS` in `packages/shared` and from the PRD role table. The settings screen labels the runtime keys; aligning the names is a separate clean-up.

## Consequences

- Every admin change writes an audit entry; the audit log viewer reads them with keyset paging, and team-scoped readers see only their team's entries.
- Users, teams, settings and stages now carry `version`; clients must send it and handle 409.
- Dashboard numbers depend on the viewer's time zone. Two people in different zones can see different counts for "this month", which is intended.
