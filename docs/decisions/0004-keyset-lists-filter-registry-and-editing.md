# ADR 0004: Keyset lists, a field-registry filter language, and how records are edited

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

The lists loaded every row and filtered in the browser. That breaks at the PRD's target size (60k contacts, 20k companies, 300k activities; PRD 12.2) and it can't apply permissions or sorting consistently. Records also couldn't be edited after creation: no status changes, owner changes, notes, tags or timeline.

## Decision

1. **Keyset paging.** Every list endpoint returns `{ items, nextCursor, total }`. The cursor is base64url of `[sortValueAsText, id]`, and the next page uses `(sortExpr, id) < ($value::<type>, $id)` (or `>` for ascending). The sort value is selected as `(expr)::text` and cast back on the next request, so timestamps keep their microseconds and no row is skipped or repeated. `total` is counted in parallel without the cursor condition. Page size defaults to 50 and is capped at 200. The timeline uses the same idea with a `<timestamp>|<id>` cursor, because a logged call and the status change it causes share one timestamp.
2. **Filter language through a field registry** (`apps/api/src/platform/list`). Each entity has a registry that maps a public field name to its SQL expression and type (text, enum, user, number, date, boolean, jsonArray, tags). Only registered fields and the operators allowed for their type reach SQL, always as bind parameters. `@me` and relative dates (`-90d`) are resolved on the server. A filter has at most 40 conditions and depth 4. An unknown field or operator is a 400 `INVALID_FILTER`; an unknown sort is a 422. New filterable fields go into the registry, never into hand-written SQL.
3. **Scope in SQL.** Lists, profiles and the timeline call `scopeWhere()` with the right alias and owner column. Records outside the user's scope return 404, not 403, so their existence isn't revealed.
4. **Editing.** PATCH bodies are the shared zod `Update*InputSchema`s. Only changed fields are sent, with `version`; a stale version is a 409 `VERSION_CONFLICT`. Each changed column writes `record_history`, and business events go to the outbox in the same transaction. Reassignment needs team or all scope (`leads.assign` for leads, the entity's `*.write` otherwise); team scope can only assign inside its own team. The new owner gets an in-app notification.
5. **Idempotent creates.** POSTs with an `Idempotency-Key` header store the response for 24 hours and replay it; the same key on a different path is a 422. The web client sends a new key for each create.
6. **System reference data lives in a migration** (roles, the two pipelines and their stages, `reference.*` lists, SLA and idle defaults), inserted with `ON CONFLICT DO NOTHING` so admins can change it later. Synthetic people and records stay in the seed script.
7. **Router.** CRM routes moved from a long `if` chain in `main.ts` to a small typed router (`platform/http/router.ts`) with `:param` segments. Auth, CSRF and the session check still run once in `main.ts` before any route.

## Deviation to revisit

AGENTS.md section 9 asks for react-hook-form. The edit drawers instead keep form state in React, check the payload with the same shared zod schema before sending, and map server `fieldErrors` back onto the fields (`features/records/record-form.tsx`). This meets the intent (one schema, server errors on fields) without adding a dependency mid-slice. Adopting react-hook-form later only changes that file and the drawers.

## Consequences

- List speed no longer depends on the browser. Every new sort path needs a matching index; migration 0003 adds them for the current sorts and searches. The query plans still need checking with `EXPLAIN ANALYZE` on the large seed against real PostgreSQL.
- Filter state, search and sort live in the URL, so a list can be bookmarked or shared.
- Clients must send `version` with every edit and handle 409 by reloading.
