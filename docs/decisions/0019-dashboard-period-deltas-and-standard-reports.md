# 0019. Dashboard period-over-period deltas and standalone standard reports module

- **Status:** Accepted
- **Date:** 2026-11-18
- **PRD references:** 4.1, 4.2, 4.15, 9, 14; DESIGN 6.7, 7

## Context

`PRD 4.2`, `PRD 4.15`, `PRD 14`, and `DESIGN 6.7 / 7` require:

1. **Period-over-period delta chips (`DESIGN 6.7`):** KPI tiles on period-bounded dashboard widgets and reports should display a signed change indicator (`▲ +24%`, `▼ -12%`, `— 0%`, or `pp` for rates) with semantic tone (`success`, `danger`, `neutral`), never relying on colour alone, alongside a portfolio & funnel summary strip (`Total companies`, `Total contacts`, `New leads`, `Lead conversion rate`).
2. **Standalone Standard Reports (`PRD 4.15, 14`):** Six standard reports (`leads_funnel`, `pipeline_overview`, `won_lost_revenue`, `sla_responsiveness`, `employee_activity`, `outreach_deliverability`) with date range, market, team, and owner filters, reporting-currency (`USD`) rollups using `fx_rate_scaled_at_close` for Won deals and the latest `fx_rates` row for open pipeline, one-click visibility into original `USD`/`CAD` currencies, accessible `"View as table"` chart toggles (`DESIGN 7`), and permissioned (`reports.read` + `exports.run`) audited CSV export (`report.exported`).

## Decisions

1. **Equal-span calendar-date previous period (`previousPeriodRange` in `@adas/shared`):**
   - Given an inclusive `[from, to]` `YYYY-MM-DD` date range of $N$ days, the comparison window is `[from - N days, from - 1 day]`, converted to UTC instants in the viewer's IANA time zone identically to the primary window.
   - `computeDeltaChip` computes integer percentage deltas for counts/money and percentage-point (`pp`) deltas for ratios (`0..1`), supporting `invertGood: true` for negative metrics (`lost`, `sla_breached`, `hard_bounce`, `unsubscribe`).

2. **Dedicated `modules/reports` service with intersected SQL scopes:**
   - Every report query intersects `scopeWhere(user, entityCapability)` AND `scopeWhere(user, 'reports.read')` in SQL, and CSV export (`GET /api/v1/reports/:id/export.csv`) additionally intersects `scopeWhere(user, 'exports.run')` so a user can never export rows beyond either their read or export scope.
   - CSV export uses `CSV_BOM` and formula-neutralising `csvLine` from `platform/csv` and writes a PII-free `report.exported` entry in `audit_logs`.

3. **Zero-dependency accessible charts (`ReportChartPanel`):**
   - Uses semantic CSS/HTML horizontal single-series (`--chart-1`, `--chart-muted` for Lost/Disqualified/Suppressions) and dual-series (`--chart-1` + `--chart-2`) bars with tabular figures, a `.sr-only` text summary, and a `"View as table"` button (`DESIGN 7`), keeping bundle size compact without external charting libraries.
