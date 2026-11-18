import {
  DashboardQuerySchema,
  DashboardWidgetIdSchema,
  LeadSystemStatusSchema,
  previousPeriodRange,
  type Currency,
  type DashboardQuery,
  type DashboardSummaryView,
  type DashboardWidgetId,
  type SessionUser,
  type UserRoleName,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import { NotFoundDomainError } from '../../platform/errors/index.js';
import { convertCurrencyMinor } from '../../platform/money/index.js';
import { getCapabilityScope, requireCapability, scopeWhere } from '../../platform/scope/index.js';

/** Reporting currency (PRD 4.15, PRD 15 Q8 default). */
const REPORTING_CURRENCY: Currency = 'USD';

/** Widgets per role (PRD 4.2). Inbox replies join the sales view when the inbox exists. */
const ROLE_WIDGETS: Record<UserRoleName, DashboardWidgetId[]> = {
  'BDR / SDR': [
    'followups_today',
    'overdue_tasks',
    'sla_inquiries',
    'leads_by_status',
    'pipeline_by_stage',
  ],
  'Account Executive': [
    'followups_today',
    'overdue_tasks',
    'sla_inquiries',
    'leads_by_status',
    'pipeline_by_stage',
  ],
  'Sales Manager': [
    'pipeline_by_stage',
    'won_lost',
    'sla_breaches',
    'overdue_by_person',
    'leads_by_source_market',
  ],
  'Marketing Manager': ['outreach_performance', 'leads_by_source_market'],
  'Read-Only / Analyst': [
    'won_lost',
    'pipeline_by_stage',
    'trial_to_win',
    'leads_by_source_market',
    'activity_summary',
  ],
  Admin: [
    'won_lost',
    'pipeline_by_stage',
    'trial_to_win',
    'sla_breaches',
    'overdue_by_person',
    'leads_by_source_market',
    'activity_summary',
  ],
};

/** Capabilities each widget needs; any listed in `anyOf` is enough. */
const WIDGET_NEEDS: Record<DashboardWidgetId, { all: string[]; anyOf?: string[] }> = {
  followups_today: { all: ['tasks.read'] },
  overdue_tasks: { all: ['tasks.read'] },
  sla_inquiries: { all: ['tasks.read'] },
  leads_by_status: { all: ['leads.read'] },
  pipeline_by_stage: { all: ['deals.read'] },
  won_lost: { all: ['deals.read', 'reports.read'] },
  sla_breaches: { all: ['tasks.read', 'reports.read'] },
  overdue_by_person: { all: ['tasks.read', 'reports.read'] },
  leads_by_source_market: { all: ['leads.read', 'reports.read'] },
  trial_to_win: { all: ['deals.read', 'reports.read'] },
  activity_summary: { all: ['reports.read'] },
  outreach_performance: { all: ['reports.read'], anyOf: ['sequences.read', 'campaigns.read'] },
};

function allowed(user: SessionUser, widget: DashboardWidgetId): boolean {
  const needs = WIDGET_NEEDS[widget];
  if (needs.all.some((c) => getCapabilityScope(user, c) === 'none')) return false;
  if (needs.anyOf && needs.anyOf.every((c) => getCapabilityScope(user, c) === 'none')) return false;
  return true;
}

/** Builds positional parameters as SQL is written. */
class Sql {
  readonly params: unknown[] = [];
  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  scope(user: SessionUser, capability: string, alias: string, ownerColumn = 'owner_user_id') {
    const fragment = scopeWhere(user, capability, {
      alias,
      ownerColumn,
      startParamIndex: this.params.length + 1,
    });
    this.params.push(...fragment.params);
    return fragment.sql;
  }
}

interface Period extends DashboardQuery {
  start: string;
  end: string;
}

const big = (v: unknown): bigint => BigInt(String(v ?? '0').split('.')[0] || '0');
const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/**
 * Role dashboard (PRD 4.2) with the metric definitions in PRD 14. Every widget is a separate
 * request, so one slow query never blocks the page, and every query applies the viewer's
 * scope in SQL. Periods are whole days in the viewer's time zone.
 */
export class DashboardService {
  constructor(private readonly db: DatabaseService) {}

  async layout(user: SessionUser) {
    const tz = user.timezone ?? 'UTC';
    const range = await this.db.query<{ from: string; to: string }>(
      `SELECT date_trunc('month', NOW() AT TIME ZONE $1)::date::text AS "from",
              (NOW() AT TIME ZONE $1)::date::text AS "to"`,
      [tz],
    );
    return {
      widgets: ROLE_WIDGETS[user.role].filter((w) => allowed(user, w)),
      timezone: tz,
      reportingCurrency: REPORTING_CURRENCY,
      defaultRange: range.rows[0] ?? { from: '', to: '' },
    };
  }

  /**
   * Portfolio & funnel KPI strip with previous-period deltas (PRD 4.2, 14; DESIGN 6.7).
   * Respects `companies.read`, `contacts.read`, and `leads.read` scopes in SQL.
   */
  async summary(user: SessionUser, query: URLSearchParams): Promise<DashboardSummaryView> {
    const cur = await this.period(user, {
      from: query.get('from') ?? '',
      to: query.get('to') ?? '',
      market: query.get('market') || undefined,
    });
    const prevRange = previousPeriodRange(cur.from, cur.to);
    const prev = await this.period(user, {
      from: prevRange.from,
      to: prevRange.to,
      market: cur.market,
    });

    let totalCompanies: number | null = null;
    let newCompanies: number | null = null;
    let previousNewCompanies: number | null = null;
    if (getCapabilityScope(user, 'companies.read') !== 'none') {
      const q = new Sql();
      const scope = q.scope(user, 'companies.read', 'c');
      const market = cur.market ? `AND c.market = ${q.p(cur.market)}` : '';
      const cStart = q.p(cur.start);
      const cEnd = q.p(cur.end);
      const pStart = q.p(prev.start);
      const pEnd = q.p(prev.end);
      const res = await this.db.query<{ total: number; cur_new: number; prev_new: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE c.created_at >= ${cStart}::timestamptz AND c.created_at < ${cEnd}::timestamptz)::int AS cur_new,
                COUNT(*) FILTER (WHERE c.created_at >= ${pStart}::timestamptz AND c.created_at < ${pEnd}::timestamptz)::int AS prev_new
         FROM companies c
         WHERE c.deleted_at IS NULL AND ${scope} ${market}`,
        q.params,
      );
      totalCompanies = res.rows[0]?.total ?? 0;
      newCompanies = res.rows[0]?.cur_new ?? 0;
      previousNewCompanies = res.rows[0]?.prev_new ?? 0;
    }

    let totalContacts: number | null = null;
    let newContacts: number | null = null;
    let previousNewContacts: number | null = null;
    if (getCapabilityScope(user, 'contacts.read') !== 'none') {
      const q = new Sql();
      const scope = q.scope(user, 'contacts.read', 'ct');
      const market = cur.market ? `AND ct.market = ${q.p(cur.market)}` : '';
      const cStart = q.p(cur.start);
      const cEnd = q.p(cur.end);
      const pStart = q.p(prev.start);
      const pEnd = q.p(prev.end);
      const res = await this.db.query<{ total: number; cur_new: number; prev_new: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ct.created_at >= ${cStart}::timestamptz AND ct.created_at < ${cEnd}::timestamptz)::int AS cur_new,
                COUNT(*) FILTER (WHERE ct.created_at >= ${pStart}::timestamptz AND ct.created_at < ${pEnd}::timestamptz)::int AS prev_new
         FROM contacts ct
         WHERE ct.deleted_at IS NULL AND ${scope} ${market}`,
        q.params,
      );
      totalContacts = res.rows[0]?.total ?? 0;
      newContacts = res.rows[0]?.cur_new ?? 0;
      previousNewContacts = res.rows[0]?.prev_new ?? 0;
    }

    let newLeads: number | null = null;
    let previousNewLeads: number | null = null;
    let leadConversionRate: number | null = null;
    let previousLeadConversionRate: number | null = null;
    if (getCapabilityScope(user, 'leads.read') !== 'none') {
      const q = new Sql();
      const scope = q.scope(user, 'leads.read', 'l');
      const market = cur.market ? `AND l.market = ${q.p(cur.market)}` : '';
      const cStart = q.p(cur.start);
      const cEnd = q.p(cur.end);
      const pStart = q.p(prev.start);
      const pEnd = q.p(prev.end);
      const qualCond = `(l.status_category = 'qualified' OR l.status = 'Converted' OR l.converted_deal_id IS NOT NULL)`;
      const res = await this.db.query<{
        cur_new: number;
        cur_qual: number;
        prev_new: number;
        prev_qual: number;
      }>(
        `SELECT COUNT(*) FILTER (WHERE l.created_at >= ${cStart}::timestamptz AND l.created_at < ${cEnd}::timestamptz)::int AS cur_new,
                COUNT(*) FILTER (WHERE l.created_at >= ${cStart}::timestamptz AND l.created_at < ${cEnd}::timestamptz AND ${qualCond})::int AS cur_qual,
                COUNT(*) FILTER (WHERE l.created_at >= ${pStart}::timestamptz AND l.created_at < ${pEnd}::timestamptz)::int AS prev_new,
                COUNT(*) FILTER (WHERE l.created_at >= ${pStart}::timestamptz AND l.created_at < ${pEnd}::timestamptz AND ${qualCond})::int AS prev_qual
         FROM leads l
         WHERE l.deleted_at IS NULL AND ${scope} ${market}`,
        q.params,
      );
      const row = res.rows[0];
      newLeads = row?.cur_new ?? 0;
      previousNewLeads = row?.prev_new ?? 0;
      leadConversionRate = ratio(row?.cur_qual ?? 0, newLeads);
      previousLeadConversionRate = ratio(row?.prev_qual ?? 0, previousNewLeads);
    }

    return {
      period: {
        from: cur.from,
        to: cur.to,
        previousFrom: prev.from,
        previousTo: prev.to,
        market: cur.market ?? null,
        start: cur.start,
        end: cur.end,
      },
      generatedAt: new Date().toISOString(),
      totalCompanies,
      newCompanies,
      previousNewCompanies,
      totalContacts,
      newContacts,
      previousNewContacts,
      newLeads,
      previousNewLeads,
      leadConversionRate,
      previousLeadConversionRate,
    };
  }

  async widget(user: SessionUser, rawId: string, query: URLSearchParams) {
    const parsedId = DashboardWidgetIdSchema.safeParse(rawId);
    if (!parsedId.success) throw new NotFoundDomainError('Widget', rawId);
    const id = parsedId.data;
    const needs = WIDGET_NEEDS[id];
    for (const capability of needs.all) requireCapability(user, capability);
    if (needs.anyOf && !allowed(user, id)) requireCapability(user, needs.anyOf[0] ?? '');

    const period = await this.period(user, {
      from: query.get('from') ?? '',
      to: query.get('to') ?? '',
      market: query.get('market') || undefined,
    });
    const prevRange = previousPeriodRange(period.from, period.to);
    const prevPeriod = await this.period(user, {
      from: prevRange.from,
      to: prevRange.to,
      market: period.market,
    });
    const data = await this.computeWithPrevious(user, id, period, prevPeriod);
    return {
      id,
      // start and end are the UTC instants of the period, so links open the same records.
      period: {
        from: period.from,
        to: period.to,
        previousFrom: prevPeriod.from,
        previousTo: prevPeriod.to,
        market: period.market ?? null,
        start: period.start,
        end: period.end,
      },
      generatedAt: new Date().toISOString(),
      data,
    };
  }

  private async computeWithPrevious(
    user: SessionUser,
    id: DashboardWidgetId,
    period: Period,
    prevPeriod: Period,
  ): Promise<unknown> {
    const current = (await this.compute(user, id, period)) as Record<string, unknown>;
    if (
      id === 'won_lost' ||
      id === 'trial_to_win' ||
      id === 'sla_breaches' ||
      id === 'leads_by_source_market' ||
      id === 'activity_summary' ||
      id === 'outreach_performance'
    ) {
      const previous = await this.compute(user, id, prevPeriod);
      return { ...current, previous };
    }
    return current;
  }

  private async period(user: SessionUser, raw: Record<string, unknown>): Promise<Period> {
    const tz = user.timezone ?? 'UTC';
    if (!raw['from'] || !raw['to']) {
      const layout = await this.layout(user);
      raw['from'] ||= layout.defaultRange.from;
      raw['to'] ||= layout.defaultRange.to;
    }
    const q = DashboardQuerySchema.parse(raw);
    const bounds = await this.db.query<{ start: string; end: string }>(
      `SELECT to_char((($1::date)::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start,
              to_char(((($2::date) + 1)::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "end"`,
      [q.from, q.to, tz],
    );
    const b = bounds.rows[0];
    return { ...q, start: b?.start ?? q.from, end: b?.end ?? q.to };
  }

  private compute(user: SessionUser, id: DashboardWidgetId, period: Period): Promise<unknown> {
    switch (id) {
      case 'followups_today':
        return this.myTasks(user, 'today');
      case 'overdue_tasks':
        return this.myTasks(user, 'overdue');
      case 'sla_inquiries':
        return this.slaInquiries(user);
      case 'leads_by_status':
        return this.leadsByStatus(user, period);
      case 'pipeline_by_stage':
        return this.pipelineByStage(user, period);
      case 'won_lost':
        return this.wonLost(user, period);
      case 'sla_breaches':
        return this.slaBreaches(user, period);
      case 'overdue_by_person':
        return this.overdueByPerson(user);
      case 'leads_by_source_market':
        return this.leadsBySourceMarket(user, period);
      case 'trial_to_win':
        return this.trialToWin(user, period);
      case 'activity_summary':
        return this.activitySummary(user, period);
      case 'outreach_performance':
        return this.outreachPerformance(user, period);
    }
  }

  // ---- Sales: my day ------------------------------------------------------

  /** Follow-ups due today in the assignee's time zone, or overdue (PRD 14). */
  private async myTasks(user: SessionUser, view: 'today' | 'overdue') {
    const condition =
      view === 'today'
        ? `(t.due_at AT TIME ZONE au.timezone)::date = (NOW() AT TIME ZONE au.timezone)::date`
        : `t.due_at < NOW()`;
    const sql = `FROM tasks t JOIN users au ON au.id = t.assignee_user_id
      LEFT JOIN leads ld ON ld.id = t.lead_id
      LEFT JOIN contacts ct ON ct.id = t.contact_id
      LEFT JOIN companies cmp ON cmp.id = t.company_id
      LEFT JOIN deals dl ON dl.id = t.deal_id
      WHERE t.deleted_at IS NULL AND t.status = 'open' AND t.assignee_user_id = $1 AND ${condition}`;
    const [count, items] = await Promise.all([
      this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${sql}`, [user.id]),
      this.db.query(
        `SELECT t.id, t.title, t.task_type, t.priority, t.due_at, t.lead_id, t.contact_id,
                t.company_id, t.deal_id,
                COALESCE(ld.full_name, ct.full_name, dl.name, cmp.name) AS related_name
         ${sql} ORDER BY t.due_at ASC, t.id LIMIT 5`,
        [user.id],
      ),
    ]);
    return { count: count.rows[0]?.n ?? 0, items: items.rows };
  }

  /** Inquiries still waiting for a first reply, by SLA clock (PRD 4.10). */
  private async slaInquiries(user: SessionUser) {
    const q = new Sql();
    const scope = q.scope(user, 'tasks.read', 't', 'assignee_user_id');
    const where = `t.deleted_at IS NULL AND t.status = 'open'
      AND t.task_type = 'sla_first_response' AND ${scope}`;
    const [summary, items] = await Promise.all([
      this.db.query<{ waiting: number; breached: number; due_soon: number }>(
        `SELECT COUNT(*)::int AS waiting,
                COUNT(*) FILTER (WHERE t.sla_deadline_at < NOW())::int AS breached,
                COUNT(*) FILTER (WHERE t.sla_deadline_at >= NOW()
                  AND t.sla_deadline_at < NOW() + INTERVAL '4 hours')::int AS due_soon
         FROM tasks t WHERE ${where}`,
        q.params,
      ),
      this.db.query(
        `SELECT t.id, t.title, t.sla_deadline_at, t.lead_id, t.contact_id,
                COALESCE(ld.full_name, ct.full_name) AS related_name, au.name AS assignee_name
         FROM tasks t JOIN users au ON au.id = t.assignee_user_id
         LEFT JOIN leads ld ON ld.id = t.lead_id LEFT JOIN contacts ct ON ct.id = t.contact_id
         WHERE ${where} ORDER BY t.sla_deadline_at ASC NULLS LAST, t.id LIMIT 5`,
        q.params,
      ),
    ]);
    return { ...(summary.rows[0] ?? { waiting: 0, breached: 0, due_soon: 0 }), items: items.rows };
  }

  /** Open leads by status (not disqualified or converted). */
  private async leadsByStatus(user: SessionUser, period: Period) {
    const q = new Sql();
    const scope = q.scope(user, 'leads.read', 'l');
    const market = period.market ? `AND l.market = ${q.p(period.market)}` : '';
    const res = await this.db.query<{ status: string; n: number }>(
      `SELECT l.status, COUNT(*)::int AS n FROM leads l
       WHERE l.deleted_at IS NULL AND l.status_category <> 'closed' AND ${scope} ${market}
       GROUP BY l.status`,
      q.params,
    );
    const counts = new Map(res.rows.map((r) => [r.status, r.n]));
    const rows = LeadSystemStatusSchema.options
      .filter((s) => counts.has(s))
      .map((status) => ({ status, count: counts.get(status) ?? 0 }));
    return { total: rows.reduce((sum, r) => sum + r.count, 0), rows };
  }

  // ---- Pipeline and revenue ----------------------------------------------

  private async latestRate(from: Currency): Promise<bigint | null> {
    if (from === REPORTING_CURRENCY) return 1_000_000n;
    const res = await this.db.query<{ rate_scaled: string }>(
      `SELECT rate_scaled::text FROM fx_rates WHERE from_currency = $1 AND to_currency = $2
       ORDER BY effective_date DESC LIMIT 1`,
      [from, REPORTING_CURRENCY],
    );
    const rate = res.rows[0]?.rate_scaled;
    return rate ? BigInt(rate) : null;
  }

  /** Converts per-currency sums; amounts without a rate are reported, never guessed. */
  private async toReporting(byCurrency: { currency: Currency; minor: bigint }[]) {
    let total = 0n;
    const unconverted: { currency: Currency; amountMinor: string }[] = [];
    for (const { currency, minor } of byCurrency) {
      if (minor === 0n) continue;
      const rate = await this.latestRate(currency);
      if (rate === null) unconverted.push({ currency, amountMinor: minor.toString() });
      else total += convertCurrencyMinor(minor, currency, REPORTING_CURRENCY, rate);
    }
    return { total, unconverted };
  }

  /**
   * Open deals by stage. Pipeline value is contract value (monthly x term + one-time) at the
   * latest FX rate; weighted pipeline multiplies each deal by its probability (PRD 14).
   */
  private async pipelineByStage(user: SessionUser, period: Period) {
    const q = new Sql();
    const scope = q.scope(user, 'deals.read', 'd');
    const market = period.market ? `AND cmp.market = ${q.p(period.market)}` : '';
    const res = await this.db.query<{
      pipeline_id: string;
      pipeline_name: string;
      stage_id: string;
      stage_name: string;
      stage_order: number;
      currency: Currency;
      n: number;
      value: string;
      weighted: string;
    }>(
      `SELECT p.id AS pipeline_id, p.name AS pipeline_name, s.id AS stage_id, s.name AS stage_name,
              s.stage_order, d.currency, COUNT(*)::int AS n,
              SUM(d.monthly_value_minor * d.term_months + d.one_time_value_minor)::text AS value,
              SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * d.probability + 50) / 100)::text AS weighted
       FROM deals d
       JOIN companies cmp ON cmp.id = d.company_id
       JOIN pipeline_stages s ON s.id = d.stage_id
       JOIN pipelines p ON p.id = d.pipeline_id
       WHERE d.deleted_at IS NULL AND d.stage_category = 'open' AND ${scope} ${market}
       GROUP BY p.id, p.name, s.id, s.name, s.stage_order, d.currency
       ORDER BY p.name, s.stage_order`,
      q.params,
    );
    const stages = new Map<
      string,
      {
        pipelineId: string;
        pipelineName: string;
        stageId: string;
        stageName: string;
        count: number;
        value: { currency: Currency; minor: bigint }[];
        weighted: { currency: Currency; minor: bigint }[];
      }
    >();
    for (const r of res.rows) {
      const entry = stages.get(r.stage_id) ?? {
        pipelineId: r.pipeline_id,
        pipelineName: r.pipeline_name,
        stageId: r.stage_id,
        stageName: r.stage_name,
        count: 0,
        value: [],
        weighted: [],
      };
      entry.count += r.n;
      entry.value.push({ currency: r.currency, minor: big(r.value) });
      entry.weighted.push({ currency: r.currency, minor: big(r.weighted) });
      stages.set(r.stage_id, entry);
    }
    const rows = [];
    let count = 0;
    let value = 0n;
    let weighted = 0n;
    const unconverted = new Map<Currency, bigint>();
    for (const s of stages.values()) {
      const v = await this.toReporting(s.value);
      const w = await this.toReporting(s.weighted);
      for (const u of v.unconverted) {
        unconverted.set(u.currency, (unconverted.get(u.currency) ?? 0n) + BigInt(u.amountMinor));
      }
      count += s.count;
      value += v.total;
      weighted += w.total;
      rows.push({
        pipelineId: s.pipelineId,
        pipelineName: s.pipelineName,
        stageId: s.stageId,
        stageName: s.stageName,
        count: s.count,
        valueMinor: v.total.toString(),
        weightedMinor: w.total.toString(),
      });
    }
    return {
      currency: REPORTING_CURRENCY,
      count,
      valueMinor: value.toString(),
      weightedMinor: weighted.toString(),
      unconverted: [...unconverted].map(([currency, minor]) => ({
        currency,
        amountMinor: minor.toString(),
      })),
      rows,
    };
  }

  /**
   * Won and lost deals closed in the period, win rate, revenue won at each deal's FX rate at
   * close, monthly value won, average sales cycle and lost reasons (PRD 14).
   */
  private async wonLost(user: SessionUser, period: Period) {
    const q = new Sql();
    const scope = q.scope(user, 'deals.read', 'd');
    const start = q.p(period.start);
    const end = q.p(period.end);
    const market = period.market ? `AND cmp.market = ${q.p(period.market)}` : '';
    const baseParams = [...q.params];
    const latestCad = await this.latestRate('CAD');
    const rate = q.p(latestCad === null ? null : latestCad.toString());
    const base = `FROM deals d JOIN companies cmp ON cmp.id = d.company_id
      WHERE d.deleted_at IS NULL AND d.closed_at >= ${start}::timestamptz
        AND d.closed_at < ${end}::timestamptz AND ${scope} ${market}`;
    // Conversion at the deal's own rate at close, falling back to the latest rate.
    const fx = `CASE WHEN d.currency = '${REPORTING_CURRENCY}' THEN 1000000
                     ELSE COALESCE(d.fx_rate_scaled_at_close, ${rate}::bigint) END`;
    const [summary, reasons] = await Promise.all([
      this.db.query<{
        won: number;
        lost: number;
        revenue: string | null;
        monthly: string | null;
        unconverted: string | null;
        cycle_days: string | null;
      }>(
        `SELECT COUNT(*) FILTER (WHERE d.stage_category = 'won')::int AS won,
                COUNT(*) FILTER (WHERE d.stage_category = 'lost')::int AS lost,
                SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * (${fx}) + 500000) / 1000000)
                  FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NOT NULL)::text AS revenue,
                SUM((d.monthly_value_minor * (${fx}) + 500000) / 1000000)
                  FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NOT NULL)::text AS monthly,
                SUM(d.monthly_value_minor * d.term_months + d.one_time_value_minor)
                  FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NULL)::text AS unconverted,
                ROUND(AVG(EXTRACT(EPOCH FROM (d.closed_at - d.created_at)) / 86400)
                  FILTER (WHERE d.stage_category = 'won')::numeric, 1)::text AS cycle_days
         ${base}`,
        q.params,
      ),
      this.db.query<{ reason: string; n: number }>(
        `SELECT COALESCE(NULLIF(d.lost_reason, ''), 'Not recorded') AS reason, COUNT(*)::int AS n
         ${base} AND d.stage_category = 'lost'
         GROUP BY 1 ORDER BY n DESC, reason LIMIT 6`,
        baseParams,
      ),
    ]);
    const s = summary.rows[0];
    const won = s?.won ?? 0;
    const lost = s?.lost ?? 0;
    return {
      currency: REPORTING_CURRENCY,
      won,
      lost,
      winRate: ratio(won, won + lost),
      revenueWonMinor: big(s?.revenue).toString(),
      monthlyValueWonMinor: big(s?.monthly).toString(),
      unconverted: s?.unconverted
        ? [{ currency: 'CAD', amountMinor: big(s.unconverted).toString() }]
        : [],
      averageCycleDays:
        s?.cycle_days === null || s?.cycle_days === undefined ? null : Number(s.cycle_days),
      lostReasons: reasons.rows.map((r) => ({ reason: r.reason, count: r.n })),
    };
  }

  /** Of deals that left a free trial stage in the period, the share that is now won. */
  private async trialToWin(user: SessionUser, period: Period) {
    const q = new Sql();
    const scope = q.scope(user, 'deals.read', 'd');
    const start = q.p(period.start);
    const end = q.p(period.end);
    const market = period.market ? `AND cmp.market = ${q.p(period.market)}` : '';
    const res = await this.db.query<{ left_trial: number; won: number; lost: number }>(
      `SELECT COUNT(*)::int AS left_trial,
              COUNT(*) FILTER (WHERE d.stage_category = 'won')::int AS won,
              COUNT(*) FILTER (WHERE d.stage_category = 'lost')::int AS lost
       FROM deals d JOIN companies cmp ON cmp.id = d.company_id
       WHERE d.deleted_at IS NULL AND ${scope} ${market}
         AND EXISTS (
           SELECT 1 FROM deal_stage_history h JOIN pipeline_stages s ON s.id = h.from_stage_id
           WHERE h.deal_id = d.id AND s.is_trial
             AND h.created_at >= ${start}::timestamptz AND h.created_at < ${end}::timestamptz)`,
      q.params,
    );
    const r = res.rows[0] ?? { left_trial: 0, won: 0, lost: 0 };
    return { leftTrial: r.left_trial, won: r.won, lost: r.lost, rate: ratio(r.won, r.left_trial) };
  }

  // ---- Responsiveness -----------------------------------------------------

  /**
   * Inquiries received in the period: answered within the SLA, breached, still waiting, the
   * SLA met rate and the median first-response time (PRD 14). The clock stops when the first
   * call or email is logged, which completes the inquiry's first-response task.
   */
  private async slaBreaches(user: SessionUser, period: Period) {
    const q = new Sql();
    const scope = q.scope(user, 'tasks.read', 't', 'assignee_user_id');
    const start = q.p(period.start);
    const end = q.p(period.end);
    const base = `FROM tasks t JOIN users au ON au.id = t.assignee_user_id
      WHERE t.deleted_at IS NULL AND t.task_type = 'sla_first_response'
        AND t.created_at >= ${start}::timestamptz AND t.created_at < ${end}::timestamptz
        AND t.status <> 'cancelled' AND ${scope}`;
    const breachedSql = `COALESCE(t.sla_breached
      OR (t.status = 'completed' AND t.completed_at > t.sla_deadline_at)
      OR (t.status = 'open' AND t.sla_deadline_at < NOW()), FALSE)`;
    const [summary, byPerson] = await Promise.all([
      this.db.query<{
        received: number;
        met: number;
        breached: number;
        waiting: number;
        median_minutes: string | null;
      }>(
        `SELECT COUNT(*)::int AS received,
                COUNT(*) FILTER (WHERE t.status = 'completed' AND NOT ${breachedSql})::int AS met,
                COUNT(*) FILTER (WHERE ${breachedSql})::int AS breached,
                COUNT(*) FILTER (WHERE t.status = 'open' AND NOT ${breachedSql})::int AS waiting,
                ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 60
                ) FILTER (WHERE t.status = 'completed'))::numeric, 0)::text AS median_minutes
         ${base}`,
        q.params,
      ),
      this.db.query<{ user_id: string; name: string; n: number }>(
        `SELECT au.id AS user_id, au.name, COUNT(*)::int AS n ${base} AND ${breachedSql}
         GROUP BY au.id, au.name ORDER BY n DESC, au.name LIMIT 5`,
        q.params,
      ),
    ]);
    const s = summary.rows[0] ?? {
      received: 0,
      met: 0,
      breached: 0,
      waiting: 0,
      median_minutes: null,
    };
    return {
      received: s.received,
      met: s.met,
      breached: s.breached,
      waiting: s.waiting,
      metRate: ratio(s.met, s.received),
      medianFirstResponseMinutes: s.median_minutes === null ? null : Number(s.median_minutes),
      breachedByPerson: byPerson.rows.map((r) => ({ userId: r.user_id, name: r.name, count: r.n })),
    };
  }

  /** Overdue open tasks per assignee, within the viewer's task scope. */
  private async overdueByPerson(user: SessionUser) {
    const q = new Sql();
    const scope = q.scope(user, 'tasks.read', 't', 'assignee_user_id');
    const res = await this.db.query<{ user_id: string; name: string; n: number; oldest: string }>(
      `SELECT au.id AS user_id, au.name, COUNT(*)::int AS n, MIN(t.due_at) AS oldest
       FROM tasks t JOIN users au ON au.id = t.assignee_user_id
       WHERE t.deleted_at IS NULL AND t.status = 'open' AND t.due_at < NOW() AND ${scope}
       GROUP BY au.id, au.name ORDER BY n DESC, au.name LIMIT 20`,
      q.params,
    );
    const rows = res.rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      count: r.n,
      oldestDueAt: r.oldest,
    }));
    return { total: rows.reduce((sum, r) => sum + r.count, 0), rows };
  }

  // ---- Lead flow ----------------------------------------------------------

  /** New leads in the period by source and market. */
  private async leadsBySourceMarket(user: SessionUser, period: Period) {
    const q = new Sql();
    const scope = q.scope(user, 'leads.read', 'l');
    const start = q.p(period.start);
    const end = q.p(period.end);
    const market = period.market ? `AND l.market = ${q.p(period.market)}` : '';
    const res = await this.db.query<{ source: string; market: string; n: number }>(
      `SELECT l.source, l.market, COUNT(*)::int AS n FROM leads l
       WHERE l.deleted_at IS NULL AND l.created_at >= ${start}::timestamptz
         AND l.created_at < ${end}::timestamptz AND ${scope} ${market}
       GROUP BY l.source, l.market`,
      q.params,
    );
    const bySource = new Map<
      string,
      { source: string; total: number; byMarket: Record<string, number> }
    >();
    const byMarket: Record<string, number> = {};
    for (const r of res.rows) {
      const entry = bySource.get(r.source) ?? { source: r.source, total: 0, byMarket: {} };
      entry.total += r.n;
      entry.byMarket[r.market] = (entry.byMarket[r.market] ?? 0) + r.n;
      bySource.set(r.source, entry);
      byMarket[r.market] = (byMarket[r.market] ?? 0) + r.n;
    }
    const rows = [...bySource.values()].sort(
      (a, b) => b.total - a.total || a.source.localeCompare(b.source),
    );
    return { total: rows.reduce((sum, r) => sum + r.total, 0), byMarket, rows };
  }

  // ---- People -------------------------------------------------------------

  /**
   * Calls, meetings and emails logged, tasks completed and deals moved, per person in the
   * period (PRD 14). Own scope sees themself, team scope their team, all scope everyone.
   */
  private async activitySummary(user: SessionUser, period: Period) {
    const scope = requireCapability(user, 'reports.read');
    const q = new Sql();
    const start = q.p(period.start);
    const end = q.p(period.end);
    const people =
      scope === 'all'
        ? `u.status <> 'disabled'`
        : `u.id = ANY(${q.p(scope === 'team' ? [user.id, ...user.teamMemberIds] : [user.id])}::text[])`;
    const res = await this.db.query<{
      user_id: string;
      name: string;
      calls: number;
      meetings: number;
      emails: number;
      tasks_done: number;
      deals_moved: number;
    }>(
      `SELECT u.id AS user_id, u.name,
         (SELECT COUNT(*)::int FROM activities a WHERE a.actor_user_id = u.id AND a.activity_type = 'call'
            AND a.occurred_at >= ${start}::timestamptz AND a.occurred_at < ${end}::timestamptz) AS calls,
         (SELECT COUNT(*)::int FROM activities a WHERE a.actor_user_id = u.id AND a.activity_type = 'meeting'
            AND a.occurred_at >= ${start}::timestamptz AND a.occurred_at < ${end}::timestamptz) AS meetings,
         (SELECT COUNT(*)::int FROM activities a WHERE a.actor_user_id = u.id AND a.activity_type IN ('email_logged', 'email_sent')
            AND a.occurred_at >= ${start}::timestamptz AND a.occurred_at < ${end}::timestamptz) AS emails,
         (SELECT COUNT(*)::int FROM tasks t WHERE t.completed_by_user_id = u.id AND t.status = 'completed'
            AND t.completed_at >= ${start}::timestamptz AND t.completed_at < ${end}::timestamptz) AS tasks_done,
         (SELECT COUNT(*)::int FROM deal_stage_history h WHERE h.changed_by_user_id = u.id
            AND h.created_at >= ${start}::timestamptz AND h.created_at < ${end}::timestamptz) AS deals_moved
       FROM users u WHERE ${people} ORDER BY u.name`,
      q.params,
    );
    const rows = res.rows
      .map((r) => ({
        userId: r.user_id,
        name: r.name,
        calls: r.calls,
        meetings: r.meetings,
        emails: r.emails,
        tasksCompleted: r.tasks_done,
        dealsMoved: r.deals_moved,
        total: r.calls + r.meetings + r.emails + r.tasks_done + r.deals_moved,
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const totals = rows.reduce(
      (t, r) => ({
        calls: t.calls + r.calls,
        meetings: t.meetings + r.meetings,
        emails: t.emails + r.emails,
        tasksCompleted: t.tasksCompleted + r.tasksCompleted,
        dealsMoved: t.dealsMoved + r.dealsMoved,
      }),
      { calls: 0, meetings: 0, emails: 0, tasksCompleted: 0, dealsMoved: 0 },
    );
    return { totals, rows };
  }

  // ---- Marketing ----------------------------------------------------------

  /**
   * Sequence and campaign sends in the period with delivery, hard-bounce and complaint rates,
   * sequence reply rate, and suppression growth by reason (PRD 14).
   */
  private async outreachPerformance(user: SessionUser, period: Period) {
    const scope = requireCapability(user, 'reports.read');
    const q = new Sql();
    const start = q.p(period.start);
    const end = q.p(period.end);
    const senders =
      scope === 'all'
        ? 'TRUE'
        : `m.sender_user_id = ANY(${q.p(scope === 'team' ? [user.id, ...user.teamMemberIds] : [user.id])}::text[])`;
    const enrolSenders = senders.replace('m.sender_user_id', 'e.sender_user_id');
    const [sends, replies, suppressions] = await Promise.all([
      this.db.query<{
        channel: string;
        sent: number;
        delivered: number;
        bounced: number;
        complained: number;
      }>(
        `SELECT m.channel, COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE m.status IN ('delivered', 'complained'))::int AS delivered,
                COUNT(*) FILTER (WHERE m.status = 'bounced')::int AS bounced,
                COUNT(*) FILTER (WHERE m.status = 'complained')::int AS complained
         FROM message_sends m
         WHERE m.channel IN ('sequence', 'campaign') AND m.sent_at >= ${start}::timestamptz
           AND m.sent_at < ${end}::timestamptz AND ${senders}
         GROUP BY m.channel`,
        q.params,
      ),
      this.db.query<{ emailed: number; replied: number }>(
        `SELECT COUNT(*)::int AS emailed,
                COUNT(*) FILTER (WHERE e.status = 'replied')::int AS replied
         FROM sequence_enrollments e
         WHERE e.enrolled_at >= ${start}::timestamptz AND e.enrolled_at < ${end}::timestamptz
           AND ${enrolSenders}
           AND EXISTS (SELECT 1 FROM message_sends m WHERE m.sequence_enrollment_id = e.id)`,
        q.params,
      ),
      this.db.query<{ reason: string; n: number }>(
        `SELECT reason, COUNT(*)::int AS n FROM suppressions
         WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
         GROUP BY reason ORDER BY n DESC`,
        [period.start, period.end],
      ),
    ]);
    const channels = ['sequence', 'campaign'].map((channel) => {
      const r = sends.rows.find((x) => x.channel === channel) ?? {
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
      };
      return {
        channel,
        sent: r.sent,
        delivered: r.delivered,
        bounced: r.bounced,
        complained: r.complained,
        deliveryRate: ratio(r.delivered, r.sent),
        bounceRate: ratio(r.bounced, r.sent),
        complaintRate: ratio(r.complained, r.delivered),
      };
    });
    const unsubscribes = suppressions.rows.find((s) => s.reason === 'unsubscribe')?.n ?? 0;
    const delivered = channels.reduce((sum, c) => sum + c.delivered, 0);
    const reply = replies.rows[0] ?? { emailed: 0, replied: 0 };
    return {
      channels,
      sequenceReplyRate: ratio(reply.replied, reply.emailed),
      sequenceEnrolmentsEmailed: reply.emailed,
      sequenceReplies: reply.replied,
      unsubscribes,
      unsubscribeRate: ratio(unsubscribes, delivered),
      suppressionsAdded: suppressions.rows.map((s) => ({ reason: s.reason, count: s.n })),
    };
  }
}
