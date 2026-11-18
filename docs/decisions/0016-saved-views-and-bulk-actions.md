# 16. Saved Views and Scoped Bulk Actions

**Date:** 18 Nov 2026
**Status:** Accepted
**References:** PRD 4.5, 4.6, 4.8, 6.7, 6.8, 6.9, 9; DESIGN 6.3, 6.5, 6.11

## Context

List screens (`Leads`, `Contacts`, `Companies`, and `Deals` table view) keep search, filter, and sort state in URL parameters (`useUrlState`), compiled on the client into the canonical filter-language AST (`FilterClause`) and validated on the server against each entity's field registry (`LEAD_LIST`, `CONTACT_LIST`, `COMPANY_LIST`, `DEAL_LIST`).

Two capabilities were needed to complete daily high-volume list operations:

1. **Saved views** — private per-user views and team-shared views preserving filter controls, `@me` owner tokens, sort order, and comfortable/compact row density.
2. **Bulk actions** — multi-row selection with a floating navy bar supporting `assign`, `status` (with disqualify reason validation), `add_tag`, `remove_tag`, and soft `delete`, executing synchronously up to 500 records and asynchronously via `pg-boss` above 500 records.

## Decisions

1. **Dual storage of `params_json` and `filter_json` on `saved_views` (migration `0014`):**
   - `params_json` stores the normalized UI query parameters (including `@me` for personal owner views) so applying a view restores every toolbar control and URL query parameter cleanly.
   - `filter_json` stores the compiled `FilterClause` validated against `compileFilter` and `spec.sorts` at write time so invalid fields or operators can never be persisted, and future dynamic segment / API consumers can evaluate saved views directly.
   - Sharing (`is_shared = TRUE`) requires `team` or `all` write scope (or `settings.manage`), scoping visibility to `sv.team_id = viewer.teamId` (or org-wide when `team_id IS NULL` or viewer has `all` scope).

2. **SQL-scoped target resolution and chunked worker execution (`bulk_jobs` + `bulk.execute`):**
   - `BulkActionService.submit` resolves target IDs in SQL with `scopeWhere(user, readCap)` AND `scopeWhere(user, actionCap)`. Out-of-scope IDs passed in `ids[]` are never leaked or mutated; they are counted in `skipped_rows`.
   - Up to `BULK_SYNC_MAX_ROWS` (`500`) rows execute synchronously in 250-row transactions and return `200`.
   - Selections over `500` rows return `202` with `background: true` and are worked in 250-row chunks by the `bulk.execute` periodic worker job (`FOR UPDATE SKIP LOCKED` with a 120-second stale heartbeat recovery), re-resolving the requester's live `SessionUser` capabilities before each chunk and sending an in-app completion notification.
   - Bulk assignment sends a single summary notification (`"N leads assigned to you"`) to avoid flooding the assignee's notification bell while still writing per-record `record_history`, timeline `assignment` activities, and `${entity}.assigned` outbox events.
