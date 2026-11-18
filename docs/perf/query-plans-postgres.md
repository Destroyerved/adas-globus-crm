# Query plans, 2026-11-18

- **Database:** PostgreSQL 17.11
- **Rows:** 20,005 companies, 60,005 contacts, 12,004 leads, 2,504 deals, 6,003 tasks, 300,000 activities
- **What the times are:** database time for each screen’s queries (planning plus execution, from `EXPLAIN (ANALYZE)`). Each scenario runs once to warm up and then three times, and the middle run is shown. The budgets are PRD 12.2’s p95 for the whole API call on the production server, so they are a yardstick here, not a pass mark.
- **Flagged:** a query that returns one page but reads 20,000 rows or more of a table from end to end, or database time over half the budget. Row counts, totals and broad searches are judged on time only, because they have to read every row the person can see.

**Result:** 93 scenarios, none flagged.

## Lists

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| leads: first page, newest first (all scope) | 2 | 4.0 ms | 400 ms | none |
| leads: first page, newest first (team scope) | 2 | 6.4 ms | 400 ms | none |
| leads: first page, newest first (own scope) | 2 | 1.5 ms | 400 ms | none |
| leads: sorted by name (all scope) | 2 | 2.2 ms | 400 ms | none |
| leads: a later page by cursor (all scope) | 4 | 6.8 ms | 400 ms | none |
| leads: search for a full name (all scope) | 2 | 2.8 ms | 400 ms | none |
| leads: search for a full name (team scope) | 2 | 2.8 ms | 400 ms | none |
| leads: Canada only (all scope) | 2 | 5.8 ms | 400 ms | none |
| leads: mine only (team scope) | 2 | 2.2 ms | 400 ms | none |
| contacts: first page, newest first (all scope) | 2 | 10.1 ms | 400 ms | none |
| contacts: first page, newest first (team scope) | 2 | 25.4 ms | 400 ms | none |
| contacts: first page, newest first (own scope) | 2 | 9.1 ms | 400 ms | none |
| contacts: sorted by name (all scope) | 2 | 13.7 ms | 400 ms | none |
| contacts: a later page by cursor (all scope) | 4 | 23.1 ms | 400 ms | none |
| contacts: search for a full name (all scope) | 2 | 6.4 ms | 400 ms | none |
| contacts: search for a full name (team scope) | 2 | 6.6 ms | 400 ms | none |
| contacts: Canada only (all scope) | 2 | 19.6 ms | 400 ms | none |
| contacts: mine only (team scope) | 2 | 7.5 ms | 400 ms | none |
| companies: first page, newest first (all scope) | 2 | 4.2 ms | 400 ms | none |
| companies: first page, newest first (team scope) | 2 | 8.6 ms | 400 ms | none |
| companies: first page, newest first (own scope) | 2 | 2.5 ms | 400 ms | none |
| companies: sorted by name (all scope) | 2 | 4.2 ms | 400 ms | none |
| companies: a later page by cursor (all scope) | 4 | 11.7 ms | 400 ms | none |
| companies: search for "acme" (all scope) | 2 | 2.9 ms | 400 ms | none |
| companies: search for "acme" (team scope) | 2 | 1.6 ms | 400 ms | none |
| companies: Canada only (all scope) | 2 | 2.7 ms | 400 ms | none |
| companies: mine only (team scope) | 2 | 3.5 ms | 400 ms | none |
| deals: first page, newest first (all scope) | 2 | 11.9 ms | 400 ms | none |
| deals: first page, newest first (team scope) | 2 | 13.2 ms | 400 ms | none |
| deals: first page, newest first (own scope) | 2 | 5.4 ms | 400 ms | none |
| deals: sorted by name (all scope) | 2 | 11.2 ms | 400 ms | none |
| deals: a later page by cursor (all scope) | 4 | 26.5 ms | 400 ms | none |
| deals: search for a firm name (all scope) | 2 | 3.2 ms | 400 ms | none |
| deals: search for a firm name (team scope) | 2 | 3.9 ms | 400 ms | none |
| deals: Canada only (all scope) | 2 | 8.4 ms | 400 ms | none |
| deals: mine only (team scope) | 2 | 6.3 ms | 400 ms | none |
| contacts: search for a first name, a broad search: about 1 in 40 matches (all scope) | 2 | 40.8 ms | 400 ms | none |
| companies: search "cpa", a broad search: about half the firms match (all scope) | 2 | 13.6 ms | 400 ms | none |
| contacts: search by company name "acme" (all scope) | 2 | 7.4 ms | 400 ms | none |
| contacts: not contacted for 90 days, oldest first (all scope) | 2 | 28.1 ms | 400 ms | none |
| contacts: with a tag (all scope) | 2 | 42.8 ms | 400 ms | none |
| companies: clients using QuickBooks (all scope) | 2 | 16.0 ms | 400 ms | none |
| deals: won, closed in the last 90 days (team scope) | 2 | 7.1 ms | 400 ms | none |
| tasks: today (all scope) | 2 | 12.5 ms | 400 ms | none |
| tasks: today (team scope) | 2 | 14.9 ms | 400 ms | none |
| tasks: overdue (all scope) | 2 | 14.2 ms | 400 ms | none |
| tasks: overdue (team scope) | 2 | 11.9 ms | 400 ms | none |
| tasks: upcoming (all scope) | 2 | 34.4 ms | 400 ms | none |
| tasks: upcoming (team scope) | 2 | 34.2 ms | 400 ms | none |
| tasks: done (all scope) | 2 | 10.4 ms | 400 ms | none |
| tasks: done (team scope) | 2 | 11.7 ms | 400 ms | none |
| tasks: search for a contact’s name, open tasks (all scope) | 2 | 40.8 ms | 400 ms | none |
| export: first 1,000 contacts with the count (all scope) | 2 | 43.3 ms | 400 ms | none |

## Search

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| global search "acme" (all scope) | 4 | 78.8 ms | 300 ms | none |
| global search for a full name (all scope) | 4 | 39.9 ms | 300 ms | none |
| global search with notes and email threads (all scope) | 6 | 41.9 ms | 300 ms | none |
| global search "acme" (team scope) | 4 | 38.7 ms | 300 ms | none |
| global search for a full name (team scope) | 4 | 47.7 ms | 300 ms | none |
| global search with notes and email threads (team scope) | 6 | 44.4 ms | 300 ms | none |
| global search "acme" (own scope) | 4 | 43.8 ms | 300 ms | none |
| global search for a full name (own scope) | 4 | 75.3 ms | 300 ms | none |
| global search with notes and email threads (own scope) | 6 | 59.0 ms | 300 ms | none |
| global search for a first name, a broad search: about 1 contact in 40 matches (all scope) | 4 | 87.9 ms | 300 ms | none |

## Profiles

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| contact profile | 11 | 58.2 ms | 500 ms | none |
| company profile | 7 | 25.9 ms | 500 ms | none |
| lead profile | 4 | 0.8 ms | 500 ms | none |
| deal profile | 7 | 6.7 ms | 500 ms | none |
| contact timeline, first page | 2 | 0.8 ms | 500 ms | none |
| company timeline, first page | 2 | 1.0 ms | 500 ms | none |
| lead timeline, first page | 2 | 0.9 ms | 500 ms | none |

## Deals board

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| board, default pipeline (all scope) | 3 | 28.2 ms | 1,500 ms | none |
| board, default pipeline (team scope) | 3 | 12.8 ms | 1,500 ms | none |
| board, default pipeline (own scope) | 3 | 6.1 ms | 1,500 ms | none |
| board with a search (all scope) | 3 | 14.0 ms | 1,500 ms | none |

## Duplicates

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| contact queue, first page (all scope) | 1 | 1.6 ms | 400 ms | none |
| company queue, first page (team scope) | 1 | 0.6 ms | 400 ms | none |

## Dashboard

| Scenario | Queries | Database time | Budget | Flag |
|---|---|---|---|---|
| won_lost (all scope) | 9 | 3.4 ms | 800 ms | none |
| pipeline_by_stage (all scope) | 14 | 4.2 ms | 800 ms | none |
| trial_to_win (all scope) | 5 | 0.9 ms | 800 ms | none |
| sla_breaches (all scope) | 7 | 1.3 ms | 800 ms | none |
| overdue_by_person (all scope) | 4 | 1.5 ms | 800 ms | none |
| leads_by_source_market (all scope) | 5 | 0.8 ms | 800 ms | none |
| activity_summary (all scope) | 5 | 16.0 ms | 800 ms | none |
| pipeline_by_stage (team scope) | 4 | 2.6 ms | 800 ms | none |
| won_lost (team scope) | 9 | 2.2 ms | 800 ms | none |
| sla_breaches (team scope) | 7 | 1.4 ms | 800 ms | none |
| overdue_by_person (team scope) | 4 | 1.6 ms | 800 ms | none |
| leads_by_source_market (team scope) | 5 | 1.0 ms | 800 ms | none |
| followups_today (own scope) | 5 | 4.6 ms | 800 ms | none |
| overdue_tasks (own scope) | 5 | 2.9 ms | 800 ms | none |
| sla_inquiries (own scope) | 5 | 0.9 ms | 800 ms | none |
| leads_by_status (own scope) | 4 | 2.0 ms | 800 ms | none |
| pipeline_by_stage (own scope) | 4 | 1.5 ms | 800 ms | none |
