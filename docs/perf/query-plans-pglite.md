# Query plans, 2026-11-11

- **Database:** PGlite, in memory (PostgreSQL 18.6 (PGlite 0.5.14)). Plans are PostgreSQL's own; times are slower than a server's and only show which queries stand out.
- **Rows:** 20,005 companies, 60,005 contacts, 12,004 leads, 2,504 deals, 6,003 tasks, 300,000 activities
- **What the times are:** database time for one run of each screen’s queries (planning plus execution, from `EXPLAIN (ANALYZE)`). The budgets are PRD 12.2’s p95 for the whole API call on the production server, so they are a yardstick here, not a pass mark.
- **Flagged:** a query that returns one page but reads 20,000 rows or more of a table from end to end. Row counts, totals and broad searches are judged on time only, because they have to read every row the person can see.
- **Times are not judged here:** this database is several times slower than a server. They show which queries stand out; the budgets are checked on real PostgreSQL with `pnpm db:plans`.
- **Planner settings:** `random_page_cost = 1.1`, `effective_cache_size = 8GB`, `work_mem = 16MB`, as in `infra/postgres/postgresql.conf`

**Result:** 88 scenarios, none flagged.

## Lists

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| leads: first page, newest first (all scope) | 2 | 23.9 ms | 400 ms | none |
| leads: first page, newest first (team scope) | 2 | 14.6 ms | 400 ms | none |
| leads: first page, newest first (own scope) | 2 | 4.6 ms | 400 ms | none |
| leads: sorted by name (all scope) | 2 | 26.4 ms | 400 ms | none |
| leads: a later page by cursor (all scope) | 4 | 57.3 ms | 400 ms | none |
| leads: search "avery okafor" (all scope) | 2 | 201.4 ms | 400 ms | none |
| leads: search "avery okafor" (team scope) | 2 | 133.3 ms | 400 ms | none |
| leads: Canada only (all scope) | 2 | 14.6 ms | 400 ms | none |
| leads: mine only (team scope) | 2 | 10.2 ms | 400 ms | none |
| contacts: first page, newest first (all scope) | 2 | 99.0 ms | 400 ms | none |
| contacts: first page, newest first (team scope) | 2 | 116.9 ms | 400 ms | none |
| contacts: first page, newest first (own scope) | 2 | 34.6 ms | 400 ms | none |
| contacts: sorted by name (all scope) | 2 | 120.1 ms | 400 ms | none |
| contacts: a later page by cursor (all scope) | 4 | 211.8 ms | 400 ms | none |
| contacts: search "avery hartwell" (all scope) | 2 | 180.4 ms | 400 ms | none |
| contacts: search "avery hartwell" (team scope) | 2 | 164.1 ms | 400 ms | none |
| contacts: Canada only (all scope) | 2 | 59.1 ms | 400 ms | none |
| contacts: mine only (team scope) | 2 | 34.9 ms | 400 ms | none |
| companies: first page, newest first (all scope) | 2 | 37.1 ms | 400 ms | none |
| companies: first page, newest first (team scope) | 2 | 30.6 ms | 400 ms | none |
| companies: first page, newest first (own scope) | 2 | 18.2 ms | 400 ms | none |
| companies: sorted by name (all scope) | 2 | 45.9 ms | 400 ms | none |
| companies: a later page by cursor (all scope) | 4 | 100.6 ms | 400 ms | none |
| companies: search "acme" (all scope) | 2 | 21.1 ms | 400 ms | none |
| companies: search "acme" (team scope) | 2 | 16.8 ms | 400 ms | none |
| companies: Canada only (all scope) | 2 | 17.8 ms | 400 ms | none |
| companies: mine only (team scope) | 2 | 16.8 ms | 400 ms | none |
| deals: first page, newest first (all scope) | 2 | 50.6 ms | 400 ms | none |
| deals: first page, newest first (team scope) | 2 | 53.6 ms | 400 ms | none |
| deals: first page, newest first (own scope) | 2 | 15.1 ms | 400 ms | none |
| deals: sorted by name (all scope) | 2 | 48.2 ms | 400 ms | none |
| deals: a later page by cursor (all scope) | 4 | 92.6 ms | 400 ms | none |
| deals: search "barlow" (all scope) | 2 | 70.3 ms | 400 ms | none |
| deals: search "barlow" (team scope) | 2 | 59.1 ms | 400 ms | none |
| deals: Canada only (all scope) | 2 | 36.7 ms | 400 ms | none |
| deals: mine only (team scope) | 2 | 13.3 ms | 400 ms | none |
| contacts: search "hartwell", a broad search: about 1 in 20 matches (all scope) | 2 | 832.1 ms | 400 ms | none |
| contacts: search by company name "acme" (all scope) | 2 | 62.7 ms | 400 ms | none |
| contacts: not contacted for 90 days, oldest first (all scope) | 2 | 120.1 ms | 400 ms | none |
| contacts: with a tag (all scope) | 2 | 64.8 ms | 400 ms | none |
| companies: clients using QuickBooks (all scope) | 2 | 57.2 ms | 400 ms | none |
| deals: won, closed in the last 90 days (team scope) | 2 | 12.8 ms | 400 ms | none |
| tasks: today (all scope) | 2 | 21.8 ms | 400 ms | none |
| tasks: today (team scope) | 2 | 13.1 ms | 400 ms | none |
| tasks: overdue (all scope) | 2 | 11.9 ms | 400 ms | none |
| tasks: overdue (team scope) | 2 | 20.3 ms | 400 ms | none |
| tasks: upcoming (all scope) | 2 | 63.5 ms | 400 ms | none |
| tasks: upcoming (team scope) | 2 | 54.7 ms | 400 ms | none |
| tasks: done (all scope) | 2 | 22.8 ms | 400 ms | none |
| tasks: done (team scope) | 2 | 24.7 ms | 400 ms | none |
| export: first 1,000 contacts with the count (all scope) | 2 | 173.1 ms | 400 ms | none |

## Search

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| global search "acme" (all scope) | 4 | 294.2 ms | 300 ms | none |
| global search "avery hartwell" (all scope) | 4 | 371.0 ms | 300 ms | none |
| global search "acme" (team scope) | 4 | 184.3 ms | 300 ms | none |
| global search "avery hartwell" (team scope) | 4 | 202.0 ms | 300 ms | none |
| global search "acme" (own scope) | 4 | 235.9 ms | 300 ms | none |
| global search "avery hartwell" (own scope) | 4 | 375.0 ms | 300 ms | none |
| global search "hartwell", a broad search: about 1 contact in 20 matches (all scope) | 4 | 662.3 ms | 300 ms | none |

## Profiles

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| contact profile | 11 | 6.2 ms | 500 ms | none |
| company profile | 6 | 2.8 ms | 500 ms | none |
| lead profile | 4 | 1.7 ms | 500 ms | none |
| deal profile | 6 | 2.8 ms | 500 ms | none |
| contact timeline, first page | 2 | 2.1 ms | 500 ms | none |
| company timeline, first page | 2 | 3.8 ms | 500 ms | none |
| lead timeline, first page | 2 | 2.8 ms | 500 ms | none |

## Deals board

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| board, default pipeline (all scope) | 3 | 44.9 ms | 1,500 ms | none |
| board, default pipeline (team scope) | 3 | 15.4 ms | 1,500 ms | none |
| board, default pipeline (own scope) | 3 | 11.7 ms | 1,500 ms | none |
| board with a search (all scope) | 3 | 30.3 ms | 1,500 ms | none |

## Duplicates

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| contact queue, first page (all scope) | 1 | 6.9 ms | 400 ms | none |
| company queue, first page (team scope) | 1 | 2.3 ms | 400 ms | none |

## Dashboard

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| won_lost (all scope) | 5 | 4.0 ms | 800 ms | none |
| pipeline_by_stage (all scope) | 13 | 16.0 ms | 800 ms | none |
| trial_to_win (all scope) | 3 | 2.8 ms | 800 ms | none |
| sla_breaches (all scope) | 4 | 2.7 ms | 800 ms | none |
| overdue_by_person (all scope) | 3 | 13.1 ms | 800 ms | none |
| leads_by_source_market (all scope) | 3 | 1.5 ms | 800 ms | none |
| activity_summary (all scope) | 3 | 36.3 ms | 800 ms | none |
| pipeline_by_stage (team scope) | 3 | 12.8 ms | 800 ms | none |
| won_lost (team scope) | 5 | 2.6 ms | 800 ms | none |
| sla_breaches (team scope) | 4 | 2.1 ms | 800 ms | none |
| overdue_by_person (team scope) | 3 | 9.7 ms | 800 ms | none |
| leads_by_source_market (team scope) | 3 | 1.4 ms | 800 ms | none |
| followups_today (own scope) | 4 | 16.2 ms | 800 ms | none |
| overdue_tasks (own scope) | 4 | 8.5 ms | 800 ms | none |
| sla_inquiries (own scope) | 4 | 1.2 ms | 800 ms | none |
| leads_by_status (own scope) | 3 | 7.1 ms | 800 ms | none |
| pipeline_by_stage (own scope) | 3 | 4.2 ms | 800 ms | none |
