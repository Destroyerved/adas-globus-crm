# ADR 0024: Accent-Folded Full-Text `tsvector` Search & 20-VU Concurrent HTTP Load Benchmark

- **Status:** Accepted
- **Date:** 2026-11-18
- **References:** PRD 6.10, 10.3, 12.1 (A6), 12.2

## Context

`PRD 6.10` specifies combining `pg_trgm` fuzzy/substring search with generated `tsvector` columns (`simple` configuration) wrapped around an `IMMUTABLE` accent-folding SQL function across companies, contacts, deals, notes, and email subjects, without adding Elasticsearch. `PRD 12.2` requires verifying p95 latency budgets (`list < 400 ms`, `search < 300 ms`, `profile < 500 ms`, `kanban < 1,500 ms`, `dashboard widget < 800 ms`, error rate `< 0.5%`) under 20 concurrent virtual users against the design-ceiling dataset (`20,000` companies, `60,000` contacts, `300,000` activities).

## Decision

1. **Schema-Qualified `public.immutable_unaccent` & Stored `search_tsv` Columns (Migration `0023`):**
   - PostgreSQL's built-in `unaccent(text)` is `STABLE` because it resolves its dictionary through `search_path`. Migration `0023_fulltext_search_indexes` defines `public.immutable_unaccent(text)` calling `public.unaccent('public.unaccent'::pg_catalog.regdictionary, input)` (`IMMUTABLE PARALLEL SAFE STRICT`), with every type and function schema-qualified (`pg_catalog.*` / `public.*`) so `pg_dump` and `pg_restore` succeed cleanly when `search_path = ''`.
   - Adds stored generated `search_tsv` columns and partial GIN indexes on `companies`, `contacts`, `leads`, `deals`, `notes` (`WHERE deleted_at IS NULL`), and `email_threads`, plus `idx_deals_name_trgm`.

2. **Indexed `ANY(ARRAY(... UNION ALL ...))` Global Search (`DataQualityService.globalSearch`):**
   - Each entity query combines `ILIKE`, `pg_trgm` `%`, `search_tsv @@ websearch_to_tsquery(...)`, note body matches, and email thread matches inside `ANY(ARRAY(...))` so PostgreSQL evaluates each GIN index once and never degrades to a sequential scan.
   - `GET /api/v1/search?q=...&extended=1` (used by `CommandPalette`) also returns up to 8 permission-scoped matching `notes` and `emailThreads`.

3. **Dual Load-Test Harness (`infra/k6/crm-load.js` + `pnpm perf:load`):**
   - `infra/k6/crm-load.js` provides the 15-minute 20-VU k6 soak script with `PRD 12.2` thresholds.
   - `apps/api/scripts/load-test.ts` (`pnpm perf:load`) provides a zero-external-binary Node 20-VU concurrent HTTP benchmark runner over real TCP sockets and real PostgreSQL 17, generating `docs/perf/load-test-postgres.md` and failing non-zero on any budget breach.
