# ADR 0011: Large seed, query plans, and what they changed

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

PRD 12.2 sets time budgets measured with 60,000 contacts, 20,000 companies and 300,000 activities. AGENTS.md section 6 asks for `pnpm db:seed --size=large` to load that data, and section 8 asks for list queries to be checked with `EXPLAIN ANALYZE` on it. Until now nothing could load that much data, so no plan had been checked (ADR 0004 said so).

## Decision

1. **The large seed is generated inside PostgreSQL.** `seedLarge` (`platform/db/seed-large.ts`) builds every row with `generate_series`, in chunks of 10,000, on top of the small seed.
   - **Size:** 20,000 companies, 60,000 contacts, 300,000 timeline entries, 12,000 leads, 2,500 deals (500 open, for the board budget), 6,000 tasks and 8 tags.
   - **Repeatable:** every value is a function of the row number. The same command always builds the same data, and running it again adds nothing.
   - **Synthetic only:** names are combined from fixed lists, domains end in `example.com` or `example.ca`, and phone numbers use the reserved 555-01xx range. A test checks all three.
   - **Scopes:** three records in four are U.S. and one in four Canadian, owned by the seeded people of the matching team, so own, team and all scope each see a realistic share.
2. **Plans are taken from the app's real queries.** `collectQueryPlans` (`src/perf/query-plans.ts`) calls the same service methods the API routes call, as an admin (all scope), a sales manager (team) and an account executive (own). A recording wrapper explains every SELECT with `EXPLAIN (ANALYZE, FORMAT JSON)` before running it. There are 88 scenarios: lists, global search, profiles and timelines, the deals board, the duplicate queue, an export page and every dashboard widget.
3. **What counts as a finding.**
   - **Full scans:** a query that returns one page (it has a `LIMIT`) and reads 20,000 rows or more of a table from end to end.
   - **Time:** database time over half of the screen's PRD 12.2 budget.
   - **Exempt from the scan rule:** row counts, totals and searches for text that thousands of records contain. They have to read every row the person can see, so they are judged on time only.
4. **Two ways to run it.**
   - **On a server:** `pnpm db:plans` runs against `DATABASE_URL`, writes `docs/perf/query-plans-postgres.md` and exits with 1 if anything is flagged. It refuses to run in production.
   - **On the test database:** `pnpm db:plans:test` loads the full seed into PGlite, applies the production planner settings from `infra/postgres/postgresql.conf` (`random_page_cost = 1.1`, `effective_cache_size = 8GB`, `work_mem = 16MB`) and writes `docs/perf/query-plans-pglite.md`. PGlite uses PostgreSQL's own planner, so the plans are real. Its times are several times slower than a server's and are not judged.
5. **What the first run found, and the fixes** (54 of 85 scenarios flagged, then none):
   - **Sorting by anything except "updated":** no index existed, so every such page sorted the whole table. Migration `0010_list_indexes` adds one index per sort, holding the sort expression exactly as the query writes it and then the id: name, last contacted, created, lead status and score, deal value and close date, task due and completed dates.
   - **Tag filters:** "has any" and "has all" ran a sub-query for every record in the list (0.8 s on 60,000 contacts). They are now a semi-join from the tag side. "Has all" also ignores repeated tags and letter case in the request.
   - **Contact list search:** `name OR email OR company name` spans two tables, so no trigram index could be used and every contact was read (1.2 s). It is now two indexed lookups joined by `UNION ALL`.
   - **Global search:** `similarity(name, text) > 0.2` is a function call that no index can serve, so every row of each table was read. It now uses pg_trgm's `%` operator, in the same two-lookup form. The text's own `%` and `_` are now taken literally; before, searching for `%` returned everything.
   - **Computed once:** both searches are written as `id = ANY(ARRAY(lookups))`. The first version used `id IN (lookups)`. With out-of-date statistics, just after 5,000 rows were inserted, the planner ran those lookups again for every row and one search took over two minutes. An array sub-query is always computed once, whatever the statistics say. A test searches straight after a bulk insert.
   - **Tasks due today:** the per-person time-zone check read every open task. A two-day window around now, which the due-date index can serve, now runs first.
   - **Row counts** were the other flags. They are expected, and are now judged on time only.
6. **Planner settings matter.** With PostgreSQL's default `random_page_cost = 4`, the planner prefers reading a 20,000-row table to using a trigram index, although the index is six times faster. The production configuration already sets 1.1 (PRD 10.3). A development database on default settings will show slower searches than production.

## Consequences

- **Search behaviour changed slightly.** The fuzzy match now uses pg_trgm's default threshold of 0.3 instead of 0.2, because the `%` operator is the only form an index can serve. Substring matches are unchanged. A name with one or two wrong letters is still found; a few weaker matches no longer appear.
- **More indexes on writes.** Sixteen new indexes cost a little on every insert and update. Tasks get only the two sorts the screens use; sorting tasks by priority, created or updated has no index and sorts the few thousand rows a view holds.
- **Not indexable:** sorting contacts by company name crosses two tables. It sorts the rows the person can see.
- **Still to do on real PostgreSQL:** run `pnpm db:seed --size=large` and `pnpm db:plans` on a server and compare the times with PRD 12.2. Nothing here measures the API, the browser or 15 people at once; that is the k6 test in PRD 12.2.
