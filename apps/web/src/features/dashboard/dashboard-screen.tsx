import { useQuery } from '@tanstack/react-query';
import {
  calendarDateInZone,
  computeDeltaChip,
  dashboardPresetRange,
  DASHBOARD_PRESETS,
  formatDate,
  formatDateTime,
  formatMinutes,
  formatMoney,
  formatNumber,
  formatPercent,
  type Currency,
  type DashboardPreset,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { api, type DashboardLayout, type DashboardPeriod, type WidgetId } from '@/lib/api.js';
import { PageHeader, errorMessage } from '@/features/shared/live-kit.js';
import { Toolbar, can, useMe, useUrlState } from '@/features/shared/list-kit.js';
import { TASK_TYPE_LABEL } from '@/features/tasks/tasks-screen.js';
import { type AppScreenId } from '@/features/command-palette/command-palette.js';
import { BarList, KpiRow, MiniList, WidgetPanel, type Kpi } from './dashboard-kit.js';

/** Opens a list or record screen with URL filters. */
export type Go = (screen: AppScreenId, params?: Record<string, string>) => void;

const PRESET_LABEL: Record<DashboardPreset | 'custom', string> = {
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_30_days: 'Last 30 days',
  this_year: 'This year',
  custom: 'Custom dates',
};

const ROLE_KICKER: Record<string, string> = {
  'BDR / SDR': 'Your day',
  'Account Executive': 'Your day',
  'Sales Manager': 'Your team',
  'Marketing Manager': 'Outreach',
  'Read-Only / Analyst': 'Reporting',
  Admin: 'Company overview',
};

const DEFAULTS = { period: 'this_month', from: '', to: '', market: '' };

/**
 * Role dashboard (PRD 4.2, 14). Each widget loads on its own, so a slow or failed metric never
 * blocks the others, and every number opens the list it counts.
 */
export function DashboardScreen({ role, go }: { role: string; go: Go }) {
  const me = useMe();
  const layout = useQuery({ queryKey: ['dashboard-layout'], queryFn: api.dashboard });
  const [state, setState] = useUrlState(DEFAULTS);

  if (layout.isPending) {
    return (
      <div className="space-y-[16px]" data-testid="dashboard-screen">
        <PageHeader kicker={ROLE_KICKER[role] ?? 'Overview'} title="Dashboard" />
        <div className="bg-surface border border-line rounded-[10px]">
          <LoadingState rows={6} />
        </div>
      </div>
    );
  }
  if (layout.isError) {
    return (
      <div className="space-y-[16px]" data-testid="dashboard-screen">
        <PageHeader kicker={ROLE_KICKER[role] ?? 'Overview'} title="Dashboard" />
        <div className="bg-surface border border-line rounded-[10px]">
          <ErrorState message={errorMessage(layout.error)} onRetry={() => void layout.refetch()} />
        </div>
      </div>
    );
  }

  const today = calendarDateInZone(new Date(), layout.data.timezone);
  const preset = (
    [...DASHBOARD_PRESETS, 'custom'].includes(state.period) ? state.period : 'this_month'
  ) as DashboardPreset | 'custom';
  const range =
    preset === 'custom'
      ? {
          from: state.from || layout.data.defaultRange.from,
          to: state.to || layout.data.defaultRange.to,
        }
      : dashboardPresetRange(preset, today);
  const badRange = range.from > range.to;
  const period: DashboardPeriod = { ...range, market: state.market || undefined };

  return (
    <div className="space-y-[16px]" data-testid="dashboard-screen">
      <PageHeader
        kicker={ROLE_KICKER[role] ?? 'Overview'}
        title="Dashboard"
        actions={
          can(me, 'reports.read') ? (
            <Button variant="link" onClick={() => go('reports', { period: state.period })}>
              Open reports
            </Button>
          ) : undefined
        }
      />
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
            className="sm:w-[170px]"
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
            className="sm:w-[150px]"
          >
            <option value="">All markets</option>
            <option value="US">U.S.</option>
            <option value="CA">Canada</option>
          </Select>
          {preset === 'custom' && (
            <>
              <Input
                type="date"
                aria-label="From date"
                value={range.from}
                max={today}
                onChange={(e) => setState({ from: e.target.value })}
                className="sm:w-[160px]"
              />
              <Input
                type="date"
                aria-label="To date"
                value={range.to}
                max={today}
                onChange={(e) => setState({ to: e.target.value })}
                className="sm:w-[160px]"
              />
            </>
          )}
        </div>
        <p className="m-0 text-[13px] text-ink-3 lg:ml-auto">
          {formatDate(`${range.from}T12:00:00Z`)} to {formatDate(`${range.to}T12:00:00Z`)} ·{' '}
          {layout.data.timezone} · amounts in {layout.data.reportingCurrency}
        </p>
      </Toolbar>

      {!badRange && <PortfolioSummaryStrip period={period} go={go} />}

      {badRange ? (
        <Callout tone="warning">Choose a start date on or before the end date.</Callout>
      ) : layout.data.widgets.length === 0 ? (
        <div className="bg-surface border border-line rounded-[10px] p-[24px] text-[14px] text-ink-2">
          Your role has no dashboard metrics yet. Ask an admin to give it access to reports.
        </div>
      ) : (
        <div className="grid gap-[16px] lg:grid-cols-2">
          {layout.data.widgets.map((id) => (
            <Widget key={id} id={id} period={period} layout={layout.data} go={go} />
          ))}
        </div>
      )}
    </div>
  );
}

function PortfolioSummaryStrip({ period, go }: { period: DashboardPeriod; go: Go }) {
  const summary = useQuery({
    queryKey: ['dashboard-summary', period],
    queryFn: () => api.dashboardSummary(period),
    staleTime: 60_000,
  });

  if (summary.isPending) {
    return (
      <Panel data-testid="dashboard-summary-strip">
        <LoadingState rows={2} />
      </Panel>
    );
  }
  if (summary.isError) {
    return (
      <Panel data-testid="dashboard-summary-strip">
        <ErrorState message={errorMessage(summary.error)} onRetry={() => void summary.refetch()} />
      </Panel>
    );
  }

  const d = summary.data;
  const items: Kpi[] = [];
  const market: Record<string, string> = period.market ? { market: period.market } : {};

  if (d.totalCompanies !== null) {
    items.push({
      label: 'Total companies',
      value: formatNumber(d.totalCompanies),
      delta: computeDeltaChip(d.newCompanies, d.previousNewCompanies, { kind: 'count' }),
      onOpen: () => go('companies', market),
    });
  }
  if (d.totalContacts !== null) {
    items.push({
      label: 'Total contacts',
      value: formatNumber(d.totalContacts),
      delta: computeDeltaChip(d.newContacts, d.previousNewContacts, { kind: 'count' }),
      onOpen: () => go('contacts', market),
    });
  }
  if (d.newLeads !== null) {
    items.push({
      label: 'New leads (period)',
      value: formatNumber(d.newLeads),
      delta: computeDeltaChip(d.newLeads, d.previousNewLeads, { kind: 'count' }),
      onOpen: () =>
        go('leads', {
          status: 'all',
          created: `${d.period.start},${d.period.end}`,
          ...market,
        }),
    });
    items.push({
      label: 'Lead conversion rate',
      value: formatPercent(d.leadConversionRate),
      delta: computeDeltaChip(d.leadConversionRate, d.previousLeadConversionRate, { kind: 'rate' }),
      onOpen: () =>
        go('leads', {
          status: 'all',
          created: `${d.period.start},${d.period.end}`,
          ...market,
        }),
    });
  }

  if (items.length === 0) return null;

  return (
    <Panel title="Portfolio & funnel snapshot" data-testid="dashboard-summary-strip">
      <KpiRow items={items} />
    </Panel>
  );
}

function useWidget<T>(id: WidgetId, period: DashboardPeriod) {
  return useQuery({
    queryKey: ['dashboard', id, period],
    queryFn: () => api.dashboardWidget<T>(id, period),
    staleTime: 60_000,
  });
}

interface WidgetProps {
  id: WidgetId;
  period: DashboardPeriod;
  layout: DashboardLayout;
  go: Go;
}

function Widget(props: WidgetProps) {
  switch (props.id) {
    case 'followups_today':
    case 'overdue_tasks':
      return <MyTasks {...props} />;
    case 'sla_inquiries':
      return <SlaInquiries {...props} />;
    case 'leads_by_status':
      return <LeadsByStatus {...props} />;
    case 'pipeline_by_stage':
      return <PipelineByStage {...props} />;
    case 'won_lost':
      return <WonLost {...props} />;
    case 'trial_to_win':
      return <TrialToWin {...props} />;
    case 'sla_breaches':
      return <SlaBreaches {...props} />;
    case 'overdue_by_person':
      return <OverdueByPerson {...props} />;
    case 'leads_by_source_market':
      return <LeadsBySource {...props} />;
    case 'activity_summary':
      return <ActivitySummary {...props} />;
    case 'outreach_performance':
      return <Outreach {...props} />;
  }
}

const money = (minor: string, currency: Currency) =>
  formatMoney({ amountMinor: BigInt(minor), currency });

/** A line under a money figure for amounts that had no exchange rate. */
function Unconverted({ items }: { items: { currency: Currency; amountMinor: string }[] }) {
  if (items.length === 0) return null;
  return (
    <p className="m-0 mt-[8px] text-[12.5px] text-warning">
      Not included, no exchange rate yet:{' '}
      {items.map((u) => money(u.amountMinor, u.currency)).join(', ')}
    </p>
  );
}

const marketParam = (period: DashboardPeriod): Record<string, string> =>
  period.market ? { market: period.market } : {};

// ---- Sales: my day ---------------------------------------------------------------------

interface TaskItem {
  id: string;
  title: string;
  task_type: string;
  due_at: string;
  related_name: string | null;
}

function MyTasks({ id, period, layout, go }: WidgetProps) {
  const today = id === 'followups_today';
  const query = useWidget<{ count: number; items: TaskItem[] }>(id, period);
  const view = today ? 'today' : 'overdue';
  return (
    <WidgetPanel title={today ? 'Follow-ups due today' : 'Overdue tasks'} query={query}>
      {(d) => (
        <>
          <KpiRow
            items={[
              {
                label: today ? 'Due today' : 'Overdue',
                value: formatNumber(d.count),
                tone: !today && d.count > 0 ? 'danger' : undefined,
                onOpen: () => go('tasks', { view }),
              },
            ]}
          />
          {d.items.length === 0 ? (
            <p className="m-0 mt-[12px] text-[14px] text-ink-2">
              {today ? 'Nothing due today.' : 'Nothing overdue. Nice work.'}
            </p>
          ) : (
            <MiniList>
              {d.items.map((t) => (
                <li key={t.id} className="py-[8px] flex justify-between gap-[12px] text-[13.5px]">
                  <span className="min-w-0">
                    <span className="block text-ink truncate">{t.title}</span>
                    <span className="block text-[12.5px] text-ink-3 truncate">
                      {TASK_TYPE_LABEL[t.task_type] ?? t.task_type}
                      {t.related_name ? ` · ${t.related_name}` : ''}
                    </span>
                  </span>
                  <span
                    className={`whitespace-nowrap text-[12.5px] ${today ? 'text-ink-2' : 'text-danger'}`}
                  >
                    {formatDateTime(t.due_at, layout.timezone)}
                  </span>
                </li>
              ))}
            </MiniList>
          )}
        </>
      )}
    </WidgetPanel>
  );
}

function SlaInquiries({ id, period, layout, go }: WidgetProps) {
  const query = useWidget<{
    waiting: number;
    breached: number;
    due_soon: number;
    items: {
      id: string;
      title: string;
      sla_deadline_at: string | null;
      related_name: string | null;
      assignee_name: string;
      lead_id: string | null;
    }[];
  }>(id, period);
  const open = () => go('tasks', { view: 'open', type: 'sla_first_response', assignee: '' });
  return (
    <WidgetPanel title="Website inquiries waiting for a reply" query={query}>
      {(d) => (
        <>
          <KpiRow
            items={[
              { label: 'Waiting', value: formatNumber(d.waiting), onOpen: open },
              {
                label: 'Due in 4 hours',
                value: formatNumber(d.due_soon),
                tone: d.due_soon > 0 ? 'warning' : undefined,
                onOpen: open,
              },
              {
                label: 'Late',
                value: formatNumber(d.breached),
                tone: d.breached > 0 ? 'danger' : undefined,
                onOpen: () =>
                  go('tasks', { view: 'overdue', type: 'sla_first_response', assignee: '' }),
              },
            ]}
          />
          {d.items.length === 0 ? (
            <p className="m-0 mt-[12px] text-[14px] text-ink-2">Every inquiry has a reply.</p>
          ) : (
            <MiniList>
              {d.items.map((t) => {
                const late =
                  t.sla_deadline_at !== null && Date.parse(t.sla_deadline_at) < Date.now();
                return (
                  <li key={t.id} className="py-[8px] flex justify-between gap-[12px] text-[13.5px]">
                    <span className="min-w-0">
                      {t.lead_id ? (
                        <button
                          type="button"
                          onClick={() => go('lead', { id: t.lead_id ?? '' })}
                          className="block bg-transparent border-0 p-0 text-left text-ink hover:underline cursor-pointer truncate max-w-full"
                        >
                          {t.related_name ?? t.title}
                        </button>
                      ) : (
                        <span className="block text-ink truncate">{t.related_name ?? t.title}</span>
                      )}
                      <span className="block text-[12.5px] text-ink-3 truncate">
                        {t.assignee_name}
                      </span>
                    </span>
                    <span
                      className={`whitespace-nowrap text-[12.5px] ${late ? 'text-danger' : 'text-ink-2'}`}
                    >
                      {t.sla_deadline_at
                        ? `${late ? 'Was due' : 'Due'} ${formatDateTime(t.sla_deadline_at, layout.timezone)}`
                        : '—'}
                    </span>
                  </li>
                );
              })}
            </MiniList>
          )}
        </>
      )}
    </WidgetPanel>
  );
}

function LeadsByStatus({ id, period, go }: WidgetProps) {
  const query = useWidget<{ total: number; rows: { status: string; count: number }[] }>(id, period);
  return (
    <WidgetPanel title="Open leads by status" query={query}>
      {(d) => (
        <BarList
          title="Status"
          empty="No open leads."
          bars={d.rows.map((r) => ({
            key: r.status,
            label: r.status,
            value: r.count,
            onOpen: () => go('leads', { status: r.status, ...marketParam(period) }),
          }))}
        />
      )}
    </WidgetPanel>
  );
}

// ---- Pipeline and revenue ----------------------------------------------------------------

function PipelineByStage({ id, period, layout, go }: WidgetProps) {
  const query = useWidget<{
    currency: Currency;
    count: number;
    valueMinor: string;
    weightedMinor: string;
    unconverted: { currency: Currency; amountMinor: string }[];
    rows: {
      pipelineId: string;
      pipelineName: string;
      stageId: string;
      stageName: string;
      count: number;
      valueMinor: string;
      weightedMinor: string;
    }[];
  }>(id, period);
  const pipelines = new Set(query.data?.data.rows.map((r) => r.pipelineId));
  return (
    <WidgetPanel title="Open pipeline" query={query} wide>
      {(d) => (
        <>
          <KpiRow
            items={[
              {
                label: 'Open deals',
                value: formatNumber(d.count),
                onOpen: () => go('deals', { view: 'list', ...marketParam(period) }),
              },
              { label: 'Contract value', value: money(d.valueMinor, d.currency) },
              { label: 'Weighted by probability', value: money(d.weightedMinor, d.currency) },
            ]}
          />
          <Unconverted items={d.unconverted} />
          <div className="mt-[16px]">
            <BarList
              title="Stage"
              valueLabel={`Contract value (${layout.reportingCurrency})`}
              empty="No open deals."
              bars={d.rows.map((r) => ({
                key: r.stageId,
                label: pipelines.size > 1 ? `${r.pipelineName}: ${r.stageName}` : r.stageName,
                value: Number(BigInt(r.valueMinor) / 100n),
                display: money(r.valueMinor, d.currency),
                detail: `${formatNumber(r.count)} ${r.count === 1 ? 'deal' : 'deals'}`,
                onOpen: () =>
                  go('deals', {
                    view: 'list',
                    pipeline: r.pipelineId,
                    stage: r.stageName,
                    ...marketParam(period),
                  }),
              }))}
            />
          </div>
        </>
      )}
    </WidgetPanel>
  );
}

function WonLost({ id, period, go }: WidgetProps) {
  interface WonLostData {
    currency: Currency;
    won: number;
    lost: number;
    winRate: number | null;
    revenueWonMinor: string;
    monthlyValueWonMinor: string;
    unconverted: { currency: Currency; amountMinor: string }[];
    averageCycleDays: number | null;
    lostReasons: { reason: string; count: number }[];
    previous?: {
      won: number;
      lost: number;
      winRate: number | null;
      revenueWonMinor: string;
      monthlyValueWonMinor: string;
    };
  }
  const query = useWidget<WonLostData>(id, period);
  const closed = (outcome: 'won' | 'lost') => () =>
    go('deals', {
      view: 'list',
      pipeline: 'all',
      outcome,
      closed: `${query.data?.period.start ?? ''},${query.data?.period.end ?? ''}`,
      ...marketParam(period),
    });
  return (
    <WidgetPanel title="Won and lost" query={query}>
      {(d) => (
        <>
          <KpiRow
            items={[
              {
                label: 'Won',
                value: formatNumber(d.won),
                delta: computeDeltaChip(d.won, d.previous?.won, { kind: 'count' }),
                onOpen: closed('won'),
              },
              {
                label: 'Lost',
                value: formatNumber(d.lost),
                delta: computeDeltaChip(d.lost, d.previous?.lost, {
                  kind: 'count',
                  invertGood: true,
                }),
                onOpen: closed('lost'),
              },
              {
                label: 'Win rate',
                value: formatPercent(d.winRate),
                delta: computeDeltaChip(d.winRate, d.previous?.winRate, { kind: 'rate' }),
              },
              {
                label: 'Revenue won',
                value: money(d.revenueWonMinor, d.currency),
                delta: d.previous
                  ? computeDeltaChip(
                      BigInt(d.revenueWonMinor),
                      BigInt(d.previous.revenueWonMinor),
                      { kind: 'money' },
                    )
                  : null,
              },
              {
                label: 'Monthly value won',
                value: money(d.monthlyValueWonMinor, d.currency),
                delta: d.previous
                  ? computeDeltaChip(
                      BigInt(d.monthlyValueWonMinor),
                      BigInt(d.previous.monthlyValueWonMinor),
                      { kind: 'money' },
                    )
                  : null,
              },
              {
                label: 'Average days to win',
                value:
                  d.averageCycleDays === null ? '—' : formatNumber(Math.round(d.averageCycleDays)),
              },
            ]}
          />
          <Unconverted items={d.unconverted} />
          <div className="mt-[16px]">
            <BarList
              title="Lost reasons"
              empty="No deals lost in this period."
              bars={d.lostReasons.map((r) => ({
                key: r.reason,
                label: r.reason,
                value: r.count,
                muted: true,
              }))}
            />
          </div>
        </>
      )}
    </WidgetPanel>
  );
}

function TrialToWin({ id, period }: WidgetProps) {
  const query = useWidget<{
    leftTrial: number;
    won: number;
    lost: number;
    rate: number | null;
    previous?: { leftTrial: number; won: number; rate: number | null };
  }>(id, period);
  return (
    <WidgetPanel title="Free trial to win" query={query}>
      {(d) =>
        d.leftTrial === 0 ? (
          <p className="m-0 text-[14px] text-ink-2">
            No deal finished a free trial in this period.
          </p>
        ) : (
          <KpiRow
            items={[
              {
                label: 'Finished a trial',
                value: formatNumber(d.leftTrial),
                delta: computeDeltaChip(d.leftTrial, d.previous?.leftTrial, { kind: 'count' }),
              },
              {
                label: 'Now won',
                value: formatNumber(d.won),
                delta: computeDeltaChip(d.won, d.previous?.won, { kind: 'count' }),
              },
              { label: 'Now lost', value: formatNumber(d.lost) },
              {
                label: 'Trial to win',
                value: formatPercent(d.rate),
                delta: computeDeltaChip(d.rate, d.previous?.rate, { kind: 'rate' }),
              },
            ]}
          />
        )
      }
    </WidgetPanel>
  );
}

// ---- Responsiveness ------------------------------------------------------------------------

function SlaBreaches({ id, period, go }: WidgetProps) {
  const query = useWidget<{
    received: number;
    met: number;
    breached: number;
    waiting: number;
    metRate: number | null;
    medianFirstResponseMinutes: number | null;
    breachedByPerson: { userId: string; name: string; count: number }[];
    previous?: { received: number; breached: number; metRate: number | null };
  }>(id, period);
  return (
    <WidgetPanel title="First reply to website inquiries" query={query}>
      {(d) => (
        <>
          <KpiRow
            items={[
              {
                label: 'Received',
                value: formatNumber(d.received),
                delta: computeDeltaChip(d.received, d.previous?.received, { kind: 'count' }),
              },
              {
                label: 'Replied on time',
                value: formatPercent(d.metRate),
                delta: computeDeltaChip(d.metRate, d.previous?.metRate, { kind: 'rate' }),
              },
              {
                label: 'Late',
                value: formatNumber(d.breached),
                tone: d.breached > 0 ? 'danger' : undefined,
                delta: computeDeltaChip(d.breached, d.previous?.breached, {
                  kind: 'count',
                  invertGood: true,
                }),
              },
              {
                label: 'Still waiting',
                value: formatNumber(d.waiting),
                onOpen: () =>
                  go('tasks', { view: 'open', type: 'sla_first_response', assignee: '' }),
              },
              {
                label: 'Typical first reply',
                value: formatMinutes(d.medianFirstResponseMinutes),
              },
            ]}
          />
          <div className="mt-[16px]">
            <BarList
              title="Late replies by person"
              empty="No late replies in this period."
              bars={d.breachedByPerson.map((p) => ({
                key: p.userId,
                label: p.name,
                value: p.count,
              }))}
            />
          </div>
        </>
      )}
    </WidgetPanel>
  );
}

function OverdueByPerson({ id, period, layout, go }: WidgetProps) {
  const query = useWidget<{
    total: number;
    rows: { userId: string; name: string; count: number; oldestDueAt: string }[];
  }>(id, period);
  return (
    <WidgetPanel title="Overdue tasks by person" query={query}>
      {(d) => (
        <BarList
          title="Person"
          empty="Nobody has overdue tasks."
          bars={d.rows.map((r) => ({
            key: r.userId,
            label: r.name,
            value: r.count,
            detail: `oldest ${formatDate(r.oldestDueAt, layout.timezone)}`,
            onOpen: () => go('tasks', { view: 'overdue', assignee: r.userId }),
          }))}
        />
      )}
    </WidgetPanel>
  );
}

// ---- Lead flow ------------------------------------------------------------------------------

function LeadsBySource({ id, period, go }: WidgetProps) {
  const query = useWidget<{
    total: number;
    byMarket: Record<string, number>;
    rows: { source: string; total: number; byMarket: Record<string, number> }[];
    previous?: { total: number; byMarket: Record<string, number> };
  }>(id, period);
  const created = `${query.data?.period.start ?? ''},${query.data?.period.end ?? ''}`;
  return (
    <WidgetPanel title="New leads by source" query={query}>
      {(d) => {
        const kpis: Kpi[] = [
          {
            label: 'New leads',
            value: formatNumber(d.total),
            delta: computeDeltaChip(d.total, d.previous?.total, { kind: 'count' }),
            onOpen: () => go('leads', { status: 'all', created, ...marketParam(period) }),
          },
        ];
        if (!period.market) {
          for (const [market, label] of [
            ['US', 'U.S.'],
            ['CA', 'Canada'],
          ] as const) {
            kpis.push({
              label,
              value: formatNumber(d.byMarket[market] ?? 0),
              delta: computeDeltaChip(d.byMarket[market] ?? 0, d.previous?.byMarket?.[market], {
                kind: 'count',
              }),
              onOpen: () => go('leads', { status: 'all', created, market }),
            });
          }
        }
        return (
          <>
            <KpiRow items={kpis} />
            <div className="mt-[16px]">
              <BarList
                title="Source"
                empty="No new leads in this period."
                bars={d.rows.map((r) => ({
                  key: r.source,
                  label: r.source,
                  value: r.total,
                  detail: period.market
                    ? undefined
                    : `U.S. ${formatNumber(r.byMarket['US'] ?? 0)}, Canada ${formatNumber(r.byMarket['CA'] ?? 0)}`,
                  onOpen: () =>
                    go('leads', {
                      status: 'all',
                      created,
                      source: r.source,
                      ...marketParam(period),
                    }),
                }))}
              />
            </div>
          </>
        );
      }}
    </WidgetPanel>
  );
}

// ---- People ---------------------------------------------------------------------------------

interface ActivityRow {
  userId: string;
  name: string;
  calls: number;
  meetings: number;
  emails: number;
  tasksCompleted: number;
  dealsMoved: number;
  total: number;
}

function ActivitySummary({ id, period }: WidgetProps) {
  const query = useWidget<{
    totals: Omit<ActivityRow, 'userId' | 'name' | 'total'>;
    rows: ActivityRow[];
    previous?: { totals: Omit<ActivityRow, 'userId' | 'name' | 'total'> };
  }>(id, period);
  const th = 'text-right font-semibold py-[6px] px-[6px] whitespace-nowrap';
  const td = 'text-right py-[6px] px-[6px] tabular-nums';
  return (
    <WidgetPanel title="Activity by person" query={query} wide>
      {(d) => (
        <>
          <KpiRow
            items={[
              {
                label: 'Calls',
                value: formatNumber(d.totals.calls),
                delta: computeDeltaChip(d.totals.calls, d.previous?.totals.calls, {
                  kind: 'count',
                }),
              },
              {
                label: 'Meetings',
                value: formatNumber(d.totals.meetings),
                delta: computeDeltaChip(d.totals.meetings, d.previous?.totals.meetings, {
                  kind: 'count',
                }),
              },
              {
                label: 'Emails logged',
                value: formatNumber(d.totals.emails),
                delta: computeDeltaChip(d.totals.emails, d.previous?.totals.emails, {
                  kind: 'count',
                }),
              },
              {
                label: 'Tasks done',
                value: formatNumber(d.totals.tasksCompleted),
                delta: computeDeltaChip(
                  d.totals.tasksCompleted,
                  d.previous?.totals.tasksCompleted,
                  { kind: 'count' },
                ),
              },
              {
                label: 'Deal moves',
                value: formatNumber(d.totals.dealsMoved),
                delta: computeDeltaChip(d.totals.dealsMoved, d.previous?.totals.dealsMoved, {
                  kind: 'count',
                }),
              },
            ]}
          />
          {d.rows.length === 0 ? (
            <p className="m-0 mt-[12px] text-[14px] text-ink-2">No activity in this period.</p>
          ) : (
            <div className="mt-[16px] overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px]">
                <caption className="sr-only">Activity by person in the period</caption>
                <thead>
                  <tr className="border-b border-line text-label text-ink-3">
                    <th className="text-left font-semibold py-[6px] pr-[6px]">Person</th>
                    <th className={th}>Calls</th>
                    <th className={th}>Meetings</th>
                    <th className={th}>Emails</th>
                    <th className={th}>Tasks done</th>
                    <th className={th}>Deal moves</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.userId} className="border-b border-line last:border-b-0">
                      <td className="py-[6px] pr-[6px] text-ink whitespace-nowrap">{r.name}</td>
                      <td className={td}>{formatNumber(r.calls)}</td>
                      <td className={td}>{formatNumber(r.meetings)}</td>
                      <td className={td}>{formatNumber(r.emails)}</td>
                      <td className={td}>{formatNumber(r.tasksCompleted)}</td>
                      <td className={td}>{formatNumber(r.dealsMoved)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </WidgetPanel>
  );
}

// ---- Marketing ------------------------------------------------------------------------------

const SUPPRESSION_LABEL: Record<string, string> = {
  unsubscribe: 'Unsubscribed',
  hard_bounce: 'Hard bounce',
  complaint: 'Spam complaint',
  manual_dnc: 'Do not contact',
  privacy_erasure: 'Privacy request',
};

function Outreach({ id, period }: WidgetProps) {
  interface OutreachData {
    channels: {
      channel: string;
      sent: number;
      delivered: number;
      bounced: number;
      complained: number;
      deliveryRate: number | null;
      bounceRate: number | null;
      complaintRate: number | null;
    }[];
    sequenceReplyRate: number | null;
    sequenceEnrolmentsEmailed: number;
    sequenceReplies: number;
    unsubscribes: number;
    unsubscribeRate: number | null;
    suppressionsAdded: { reason: string; count: number }[];
    previous?: {
      channels: { sent: number }[];
      sequenceReplyRate: number | null;
      unsubscribes: number;
      unsubscribeRate: number | null;
    };
  }
  const query = useWidget<OutreachData>(id, period);
  return (
    <WidgetPanel title="Outreach performance" query={query} wide>
      {(d) => {
        const sent = d.channels.reduce((s, c) => s + c.sent, 0);
        const prevSent = d.previous?.channels.reduce((s, c) => s + c.sent, 0);
        return (
          <>
            <KpiRow
              items={[
                {
                  label: 'Emails sent',
                  value: formatNumber(sent),
                  delta: computeDeltaChip(sent, prevSent, { kind: 'count' }),
                },
                {
                  label: 'Sequence reply rate',
                  value: formatPercent(d.sequenceReplyRate, 1),
                  delta: computeDeltaChip(d.sequenceReplyRate, d.previous?.sequenceReplyRate, {
                    kind: 'rate',
                  }),
                },
                {
                  label: 'Unsubscribes',
                  value: formatNumber(d.unsubscribes),
                  delta: computeDeltaChip(d.unsubscribes, d.previous?.unsubscribes, {
                    kind: 'count',
                    invertGood: true,
                  }),
                },
                {
                  label: 'Unsubscribe rate',
                  value: formatPercent(d.unsubscribeRate, 2),
                  delta: computeDeltaChip(d.unsubscribeRate, d.previous?.unsubscribeRate, {
                    kind: 'rate',
                    invertGood: true,
                  }),
                },
              ]}
            />
            <div className="mt-[16px] grid gap-[16px] md:grid-cols-2">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13.5px]">
                  <caption className="text-left text-label text-ink-3 mb-[8px]">Delivery</caption>
                  <thead>
                    <tr className="border-b border-line text-label text-ink-3">
                      <th className="text-left font-semibold py-[6px]">Sent from</th>
                      <th className="text-right font-semibold py-[6px] px-[6px]">Sent</th>
                      <th className="text-right font-semibold py-[6px] px-[6px]">Delivered</th>
                      <th className="text-right font-semibold py-[6px] px-[6px]">Bounced</th>
                      <th className="text-right font-semibold py-[6px] pl-[6px]">Complaints</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.channels.map((c) => (
                      <tr key={c.channel} className="border-b border-line last:border-b-0">
                        <td className="py-[6px] text-ink">
                          {c.channel === 'sequence' ? 'Sequences' : 'Campaigns'}
                        </td>
                        <td className="py-[6px] px-[6px] text-right tabular-nums">
                          {formatNumber(c.sent)}
                        </td>
                        <td className="py-[6px] px-[6px] text-right tabular-nums">
                          {formatPercent(c.deliveryRate, 1)}
                        </td>
                        <td className="py-[6px] px-[6px] text-right tabular-nums">
                          {formatPercent(c.bounceRate, 2)}
                        </td>
                        <td className="py-[6px] pl-[6px] text-right tabular-nums">
                          {formatPercent(c.complaintRate, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <BarList
                title="Added to the do-not-email list"
                empty="Nobody was added in this period."
                bars={d.suppressionsAdded.map((s) => ({
                  key: s.reason,
                  label: SUPPRESSION_LABEL[s.reason] ?? s.reason,
                  value: s.count,
                  muted: true,
                }))}
              />
            </div>
          </>
        );
      }}
    </WidgetPanel>
  );
}
