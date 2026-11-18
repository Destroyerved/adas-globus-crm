import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  DASHBOARD_PRESETS,
  calendarDateInZone,
  dashboardPresetRange,
  formatDate,
  formatNumber,
  formatRelative,
  type DashboardPreset,
  type ReportChartBlock,
  type ReportId,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { KpiRow } from '@/features/dashboard/dashboard-kit.js';
import {
  PageHeader,
  errorMessage,
  tableClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { Toolbar, can, useMe, useUrlState } from '@/features/shared/list-kit.js';

const PRESET_LABEL: Record<DashboardPreset | 'custom', string> = {
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_30_days: 'Last 30 days',
  this_year: 'This year',
  custom: 'Custom dates',
};

const REPORT_TABS: {
  id: ReportId;
  label: string;
  all?: string[];
  anyOf?: string[];
}[] = [
  { id: 'leads_funnel', label: 'Leads & funnel', all: ['leads.read'] },
  { id: 'pipeline_overview', label: 'Pipeline', all: ['deals.read'] },
  { id: 'won_lost_revenue', label: 'Won, lost & revenue', all: ['deals.read'] },
  { id: 'sla_responsiveness', label: 'Inquiry SLA', all: ['tasks.read'] },
  { id: 'employee_activity', label: 'Activity & follow-ups' },
  {
    id: 'outreach_deliverability',
    label: 'Deliverability',
    anyOf: ['sequences.read', 'campaigns.read'],
  },
];

const DEFAULTS = {
  report: 'leads_funnel',
  period: 'this_month',
  from: '',
  to: '',
  market: '',
  team: '',
  owner: '',
  currencies: 'reporting',
};

export function ReportsScreen() {
  const me = useMe();
  const toast = useToast();
  const [state, setState] = useUrlState(DEFAULTS);

  const visibleTabs = useMemo(
    () =>
      REPORT_TABS.filter((tab) => {
        if (tab.all && tab.all.some((cap) => !can(me, cap))) return false;
        if (tab.anyOf && tab.anyOf.every((cap) => !can(me, cap))) return false;
        return true;
      }),
    [me],
  );

  const activeReport: ReportId =
    visibleTabs.find((t) => t.id === state.report)?.id ?? visibleTabs[0]?.id ?? 'employee_activity';

  const optionsQuery = useQuery({
    queryKey: ['reports', 'options'],
    queryFn: api.reportOptions,
    staleTime: 120_000,
  });

  const tz = optionsQuery.data?.timezone ?? 'UTC';
  const today = calendarDateInZone(new Date(), tz);
  const preset = (
    [...DASHBOARD_PRESETS, 'custom'].includes(state.period) ? state.period : 'this_month'
  ) as DashboardPreset | 'custom';
  const defaultRange = optionsQuery.data?.defaultRange ?? { from: today, to: today };
  const range =
    preset === 'custom'
      ? { from: state.from || defaultRange.from, to: state.to || defaultRange.to }
      : dashboardPresetRange(preset, today);
  const badRange = range.from > range.to;

  const filterParams = {
    from: range.from,
    to: range.to,
    market: state.market || undefined,
    teamId: state.team || undefined,
    ownerId: state.owner || undefined,
  };

  const reportQuery = useQuery({
    queryKey: ['reports', 'run', activeReport, filterParams],
    queryFn: () => api.runReport(activeReport, filterParams),
    enabled: optionsQuery.isSuccess && !badRange && visibleTabs.length > 0,
  });

  const exportCsv = useMutation({
    mutationFn: () => api.downloadReportCsv(activeReport, filterParams),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Report exported as CSV.');
    },
    onError: (err) => toast(errorMessage(err), 'danger'),
  });

  if (optionsQuery.isPending) {
    return (
      <div className="space-y-[16px]" data-testid="reports-screen">
        <PageHeader kicker="Analytics" title="Reports" />
        <Panel>
          <LoadingState rows={6} />
        </Panel>
      </div>
    );
  }

  if (optionsQuery.isError) {
    return (
      <div className="space-y-[16px]" data-testid="reports-screen">
        <PageHeader kicker="Analytics" title="Reports" />
        <Panel>
          <ErrorState
            message={errorMessage(optionsQuery.error)}
            onRetry={() => void optionsQuery.refetch()}
          />
        </Panel>
      </div>
    );
  }

  const opts = optionsQuery.data;
  const filtered = state.market !== '' || state.team !== '' || state.owner !== '';
  const hasMoneyBreakdown = Boolean(reportQuery.data?.currencyBreakdown?.length);
  const showOriginal = state.currencies === 'original';

  return (
    <div className="space-y-[16px]" data-testid="reports-screen">
      <PageHeader
        kicker="Analytics"
        title="Reports"
        actions={
          opts.canExport ? (
            <Button
              variant="outline"
              disabled={exportCsv.isPending || badRange || reportQuery.isPending}
              onClick={() => exportCsv.mutate()}
            >
              <Download size={16} strokeWidth={1.6} aria-hidden="true" />
              <span>{exportCsv.isPending ? 'Exporting…' : 'Export CSV'}</span>
            </Button>
          ) : undefined
        }
      />

      <div
        role="tablist"
        aria-label="Standard reports"
        className="flex gap-[20px] border-b border-line overflow-x-auto"
      >
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeReport === tab.id}
            className="view-tab"
            onClick={() => setState({ report: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <Toolbar>
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-[8px]">
          <Select
            aria-label="Period"
            value={preset}
            onChange={(e) =>
              setState(
                e.target.value === 'custom'
                  ? { period: 'custom', from: range.from, to: range.to }
                  : { period: e.target.value, from: '', to: '' },
              )
            }
            className="sm:w-[165px]"
          >
            {[...DASHBOARD_PRESETS, 'custom' as const].map((p) => (
              <option key={p} value={p}>
                {PRESET_LABEL[p]}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Market"
            value={state.market}
            onChange={(e) => setState({ market: e.target.value })}
            className="sm:w-[140px]"
          >
            <option value="">All markets</option>
            <option value="US">U.S.</option>
            <option value="CA">Canada</option>
          </Select>

          {opts.teams.length > 0 && (
            <Select
              aria-label="Team"
              value={state.team}
              onChange={(e) => setState({ team: e.target.value })}
              className="sm:w-[165px]"
            >
              <option value="">All teams</option>
              {opts.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}

          {opts.owners.length > 1 && (
            <Select
              aria-label="Owner"
              value={state.owner}
              onChange={(e) => setState({ owner: e.target.value })}
              className="sm:w-[180px]"
            >
              <option value="">Everyone in scope</option>
              <option value="@me">Me</option>
              {opts.owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}

          {preset === 'custom' && (
            <>
              <Input
                type="date"
                aria-label="From date"
                value={range.from}
                max={today}
                onChange={(e) => setState({ from: e.target.value })}
                className="sm:w-[155px]"
              />
              <Input
                type="date"
                aria-label="To date"
                value={range.to}
                max={today}
                onChange={(e) => setState({ to: e.target.value })}
                className="sm:w-[155px]"
              />
            </>
          )}

          {filtered && (
            <Button variant="ghost" onClick={() => setState({ market: '', team: '', owner: '' })}>
              Clear filters
            </Button>
          )}
        </div>

        {hasMoneyBreakdown && (
          <button
            type="button"
            aria-pressed={showOriginal}
            onClick={() => setState({ currencies: showOriginal ? 'reporting' : 'original' })}
            className={`lg:ml-auto inline-flex items-center h-[32px] px-[12px] rounded-pill border text-[12.5px] font-medium cursor-pointer transition-colors self-start ${
              showOriginal
                ? 'bg-primary border-primary text-primary-foreground'
                : 'bg-surface border-line-strong text-ink-2 hover:border-primary'
            }`}
          >
            {showOriginal
              ? 'Showing original currencies'
              : `Original currencies (in ${opts.reportingCurrency})`}
          </button>
        )}
      </Toolbar>

      {badRange ? (
        <Callout tone="warning">Choose a start date on or before the end date.</Callout>
      ) : reportQuery.isPending ? (
        <Panel>
          <LoadingState rows={6} />
        </Panel>
      ) : reportQuery.isError ? (
        <Panel>
          <ErrorState
            message={errorMessage(reportQuery.error)}
            onRetry={() => void reportQuery.refetch()}
          />
        </Panel>
      ) : reportQuery.data ? (
        <div className="space-y-[16px]">
          <Panel title={reportQuery.data.title}>
            <div className="flex flex-wrap items-baseline justify-between gap-[8px] mb-[14px]">
              <p className="m-0 text-[13.5px] text-ink-2">{reportQuery.data.subtitle}</p>
              <span className="text-[12.5px] text-ink-3 tabular-nums">
                {formatDate(`${reportQuery.data.period.from}T12:00:00Z`)} to{' '}
                {formatDate(`${reportQuery.data.period.to}T12:00:00Z`)} · Updated{' '}
                {formatRelative(reportQuery.data.generatedAt)}
              </span>
            </div>

            <KpiRow
              items={reportQuery.data.kpis.map((k) => ({
                label: k.label,
                value: k.value,
                delta: k.delta,
              }))}
            />

            {showOriginal && reportQuery.data.currencyBreakdown && (
              <div
                data-testid="report-currency-breakdown"
                className="mt-[14px] pt-[12px] border-t border-line flex flex-wrap gap-[12px] text-[13px] text-ink-2 tabular-nums"
              >
                {reportQuery.data.currencyBreakdown.map((item) => (
                  <span
                    key={item.currency}
                    className="px-[10px] py-[4px] rounded-pill bg-bg-alt text-ink"
                  >
                    {item.label}
                  </span>
                ))}
              </div>
            )}
          </Panel>

          <div
            className={`grid grid-cols-1 gap-[16px] ${
              reportQuery.data.charts.length > 1 ? 'lg:grid-cols-2' : ''
            }`}
          >
            {reportQuery.data.charts.map((chart) => (
              <div key={chart.id} className="min-w-0">
                <ReportChartPanel chart={chart} />
              </div>
            ))}
          </div>

          <Panel title="Detailed breakdown" padded={false}>
            {reportQuery.data.rows.length === 0 ? (
              <EmptyState
                title="No rows for these filters"
                description="Broaden the date range or clear the market, team or owner filter."
                actionLabel={filtered ? 'Clear filters' : undefined}
                onAction={
                  filtered ? () => setState({ market: '', team: '', owner: '' }) : undefined
                }
              />
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label={`${reportQuery.data.title} breakdown`}
                className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-primary"
              >
                <table className={tableClass}>
                  <thead>
                    <tr className={theadRowClass}>
                      {reportQuery.data.columns.map((col, idx) => (
                        <th
                          key={col.key}
                          scope="col"
                          className={`${thClass} ${idx === 0 ? 'pl-[16px]' : ''} ${
                            col.align === 'right' ? 'text-right' : 'text-left'
                          }`}
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reportQuery.data.rows.map((row, rowIdx) => (
                      <tr
                        key={rowIdx}
                        className="h-[40px] border-b border-line last:border-b-0 hover:bg-bg-alt"
                      >
                        {reportQuery.data.columns.map((col, colIdx) => {
                          const val = row[col.key];
                          const formatted =
                            typeof val === 'number' ? formatNumber(val) : String(val ?? '—');
                          return (
                            <td
                              key={col.key}
                              className={`px-[12px] py-[8px] text-[13.5px] ${
                                colIdx === 0
                                  ? 'pl-[16px] font-medium text-ink whitespace-nowrap'
                                  : 'text-ink-2 whitespace-nowrap'
                              } ${col.align === 'right' ? 'text-right tabular-nums' : 'text-left'}`}
                            >
                              {formatted}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Accessible horizontal bar / comparison chart with "View as table" toggle and screen-reader
 * summary (DESIGN 7: --chart-1, --chart-2, --chart-muted, 2px radius, tabular numbers).
 */
function ReportChartPanel({ chart }: { chart: ReportChartBlock }) {
  const [asTable, setAsTable] = useState(false);

  const max = Math.max(...chart.bars.flatMap((b) => [b.value, b.secondaryValue ?? 0]), 1);
  const summary = chart.bars
    .map((b) =>
      b.secondaryDisplay
        ? `${b.label}: ${b.display} (${b.secondaryDisplay})`
        : `${b.label}: ${b.display}`,
    )
    .join('; ');

  return (
    <Panel title={chart.title} data-testid={`report-chart-${chart.id}`}>
      {chart.bars.length === 0 ? (
        <p className="m-0 text-[14px] text-ink-2">{chart.empty}</p>
      ) : (
        <figure className="m-0">
          <figcaption className="flex flex-wrap items-center justify-between gap-[8px] mb-[10px]">
            <div className="flex flex-wrap items-center gap-[12px] text-[12.5px] text-ink-2">
              <span className="inline-flex items-center gap-[6px]">
                <span className="inline-block w-[12px] h-[3px] bg-chart-1" aria-hidden="true" />
                <span>{chart.valueLabel}</span>
              </span>
              {chart.secondaryLabel && (
                <span className="inline-flex items-center gap-[6px]">
                  <span className="inline-block w-[12px] h-[3px] bg-chart-2" aria-hidden="true" />
                  <span>{chart.secondaryLabel}</span>
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
              className="bg-transparent border-0 p-0 text-[12.5px] font-semibold text-primary-ink cursor-pointer hover:underline"
            >
              {asTable ? 'View as chart' : 'View as table'}
            </button>
          </figcaption>

          <p className="sr-only">{summary}</p>

          {asTable ? (
            <div
              tabIndex={0}
              role="region"
              aria-label={`${chart.title} table`}
              className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-primary"
            >
              <table className="w-full border-collapse text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-label text-ink-3">
                    <th className="text-left font-semibold py-[6px]">Category</th>
                    <th className="text-right font-semibold py-[6px]">{chart.valueLabel}</th>
                    {chart.secondaryLabel && (
                      <th className="text-right font-semibold py-[6px]">{chart.secondaryLabel}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {chart.bars.map((b) => (
                    <tr key={b.key} className="border-b border-line last:border-b-0">
                      <td className="py-[6px] text-ink">
                        {b.label}
                        {b.detail && <span className="text-ink-3"> · {b.detail}</span>}
                      </td>
                      <td className="py-[6px] text-right tabular-nums">{b.display}</td>
                      {chart.secondaryLabel && (
                        <td className="py-[6px] text-right tabular-nums">
                          {b.secondaryDisplay ?? '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="m-0 p-0 list-none grid grid-cols-1 gap-[10px]" aria-hidden="true">
              {chart.bars.map((b) => (
                <li key={b.key} className="min-w-0 space-y-[4px]">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-[8px] gap-y-[2px] text-[13px]">
                    <span className="text-ink min-w-0 break-words">
                      {b.label}
                      {b.detail && <span className="text-ink-3"> · {b.detail}</span>}
                    </span>
                    <span className="text-ink-2 tabular-nums">
                      {b.display}
                      {b.secondaryDisplay ? ` · ${b.secondaryDisplay}` : ''}
                    </span>
                  </div>
                  <div className="h-[8px] rounded-[2px] bg-bg-alt overflow-hidden">
                    <span
                      className={`block h-full rounded-[2px] ${
                        b.muted ? 'bg-chart-muted' : 'bg-chart-1'
                      }`}
                      style={{ width: `${Math.max(2, (b.value / max) * 100)}%` }}
                    />
                  </div>
                  {b.secondaryValue !== undefined && (
                    <div className="h-[6px] rounded-[2px] bg-bg-alt overflow-hidden">
                      <span
                        className="block h-full rounded-[2px] bg-chart-2"
                        style={{ width: `${Math.max(2, (b.secondaryValue / max) * 100)}%` }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </figure>
      )}
    </Panel>
  );
}
