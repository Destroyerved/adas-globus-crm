import {
  LeadSystemStatusSchema,
  ReportIdSchema,
  ReportQuerySchema,
  computeDeltaChip,
  formatMinutes,
  formatMoney,
  formatNumber,
  formatPercent,
  previousPeriodRange,
  type Currency,
  type ReportFilterOptions,
  type ReportId,
  type ReportQuery,
  type ReportResultView,
  type SessionUser,
} from '@adas/shared';
import { CSV_BOM, csvLine } from '../../platform/csv/index.js';
import { type DatabaseService } from '../../platform/db/index.js';
import { NotFoundDomainError } from '../../platform/errors/index.js';
import { convertCurrencyMinor } from '../../platform/money/index.js';
import { getCapabilityScope, requireCapability, scopeWhere } from '../../platform/scope/index.js';

const REPORTING_CURRENCY: Currency = 'USD';

const REPORT_CAPS: Record<ReportId, { all: string[]; anyOf?: string[] }> = {
  leads_funnel: { all: ['reports.read', 'leads.read'] },
  pipeline_overview: { all: ['reports.read', 'deals.read'] },
  won_lost_revenue: { all: ['reports.read', 'deals.read'] },
  sla_responsiveness: { all: ['reports.read', 'tasks.read'] },
  employee_activity: { all: ['reports.read'] },
  outreach_deliverability: { all: ['reports.read'], anyOf: ['sequences.read', 'campaigns.read'] },
};

class Sql {
  readonly params: unknown[] = [];
  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  scope(
    user: SessionUser,
    capability: string,
    alias: string,
    ownerColumn = 'owner_user_id',
    forExport = false,
  ): string {
    const primary = scopeWhere(user, capability, {
      alias,
      ownerColumn,
      startParamIndex: this.params.length + 1,
    });
    this.params.push(...primary.params);
    const reportScope = scopeWhere(user, 'reports.read', {
      alias,
      ownerColumn,
      startParamIndex: this.params.length + 1,
    });
    this.params.push(...reportScope.params);
    if (!forExport) {
      return `(${primary.sql} AND ${reportScope.sql})`;
    }
    const exportScope = scopeWhere(user, 'exports.run', {
      alias,
      ownerColumn,
      startParamIndex: this.params.length + 1,
    });
    this.params.push(...exportScope.params);
    return `(${primary.sql} AND ${reportScope.sql} AND ${exportScope.sql})`;
  }
}

interface ResolvedPeriod extends ReportQuery {
  start: string;
  end: string;
  resolvedOwnerId: string | undefined;
}

const big = (v: unknown): bigint => BigInt(String(v ?? '0').split('.')[0] || '0');
const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const moneyStr = (minor: bigint, currency: Currency = REPORTING_CURRENCY) =>
  formatMoney({ amountMinor: minor, currency });

export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  async options(user: SessionUser): Promise<ReportFilterOptions> {
    const reportScope = requireCapability(user, 'reports.read');
    const tz = user.timezone ?? 'UTC';
    const rangeRes = await this.db.query<{ from: string; to: string }>(
      `SELECT date_trunc('month', NOW() AT TIME ZONE $1)::date::text AS "from",
              (NOW() AT TIME ZONE $1)::date::text AS "to"`,
      [tz],
    );

    let teamsSql = `SELECT id, name, market FROM teams ORDER BY name`;
    let teamsParams: unknown[] = [];
    if (reportScope === 'team') {
      teamsSql = `SELECT id, name, market FROM teams WHERE id = $1 ORDER BY name`;
      teamsParams = [user.teamId ?? ''];
    } else if (reportScope === 'own') {
      teamsSql = `SELECT id, name, market FROM teams WHERE 1 = 0`;
    }

    let ownersSql = `SELECT id, name, team_id FROM users WHERE status <> 'disabled' ORDER BY name`;
    let ownersParams: unknown[] = [];
    if (reportScope === 'team') {
      ownersSql = `SELECT id, name, team_id FROM users WHERE status <> 'disabled' AND id = ANY($1::text[]) ORDER BY name`;
      ownersParams = [[user.id, ...user.teamMemberIds]];
    } else if (reportScope === 'own') {
      ownersSql = `SELECT id, name, team_id FROM users WHERE id = $1`;
      ownersParams = [user.id];
    }

    const [teamsRes, ownersRes] = await Promise.all([
      this.db.query<{ id: string; name: string; market: string }>(teamsSql, teamsParams),
      this.db.query<{ id: string; name: string; team_id: string | null }>(ownersSql, ownersParams),
    ]);

    return {
      timezone: tz,
      reportingCurrency: REPORTING_CURRENCY,
      defaultRange: rangeRes.rows[0] ?? { from: '', to: '' },
      teams: teamsRes.rows,
      owners: ownersRes.rows.map((u) => ({ id: u.id, name: u.name, teamId: u.team_id })),
      canExport: getCapabilityScope(user, 'exports.run') !== 'none',
    };
  }

  async run(
    user: SessionUser,
    rawId: string,
    query: URLSearchParams,
    forExport = false,
  ): Promise<ReportResultView> {
    const parsedId = ReportIdSchema.safeParse(rawId);
    if (!parsedId.success) throw new NotFoundDomainError('Report', rawId);
    const id = parsedId.data;

    const caps = REPORT_CAPS[id];
    for (const c of caps.all) requireCapability(user, c);
    if (caps.anyOf && caps.anyOf.every((c) => getCapabilityScope(user, c) === 'none')) {
      requireCapability(user, caps.anyOf[0] ?? 'sequences.read');
    }
    if (forExport) {
      requireCapability(user, 'exports.run');
    }

    const cur = await this.resolvePeriod(user, {
      from: query.get('from') ?? '',
      to: query.get('to') ?? '',
      market: query.get('market') || undefined,
      teamId: query.get('teamId') || undefined,
      ownerId: query.get('ownerId') || undefined,
    });
    const prevDates = previousPeriodRange(cur.from, cur.to);
    const prev = await this.resolvePeriod(user, {
      from: prevDates.from,
      to: prevDates.to,
      market: cur.market,
      teamId: cur.teamId,
      ownerId: cur.ownerId,
    });

    switch (id) {
      case 'leads_funnel':
        return this.leadsFunnelReport(user, cur, prev, forExport);
      case 'pipeline_overview':
        return this.pipelineOverviewReport(user, cur, prev, forExport);
      case 'won_lost_revenue':
        return this.wonLostRevenueReport(user, cur, prev, forExport);
      case 'sla_responsiveness':
        return this.slaResponsivenessReport(user, cur, prev, forExport);
      case 'employee_activity':
        return this.employeeActivityReport(user, cur, prev, forExport);
      case 'outreach_deliverability':
        return this.outreachDeliverabilityReport(user, cur, prev, forExport);
    }
  }

  async exportCsv(
    user: SessionUser,
    rawId: string,
    query: URLSearchParams,
    ipAddress: string | null,
  ): Promise<{ filename: string; csv: string }> {
    const report = await this.run(user, rawId, query, true);
    const header = csvLine(report.columns.map((c) => c.label));
    const bodyLines = report.rows.map((row) =>
      csvLine(report.columns.map((c) => String(row[c.key] ?? ''))),
    );
    const csv = `${CSV_BOM}${[header, ...bodyLines].join('')}`;

    await this.db.writeAuditLog(this.db, {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'report.exported',
      entityType: 'report',
      entityId: report.id,
      ipAddress,
      metadata: {
        reportId: report.id,
        from: report.period.from,
        to: report.period.to,
        market: report.period.market,
        teamId: report.period.teamId,
        ownerId: report.period.ownerId,
        rowCount: report.rows.length,
      },
    });

    const filename = `adas-report-${report.id}-${report.period.from}-to-${report.period.to}.csv`;
    return { filename, csv };
  }

  private async resolvePeriod(
    user: SessionUser,
    raw: Record<string, unknown>,
  ): Promise<ResolvedPeriod> {
    const tz = user.timezone ?? 'UTC';
    if (!raw['from'] || !raw['to']) {
      const rangeRes = await this.db.query<{ from: string; to: string }>(
        `SELECT date_trunc('month', NOW() AT TIME ZONE $1)::date::text AS "from",
                (NOW() AT TIME ZONE $1)::date::text AS "to"`,
        [tz],
      );
      raw['from'] ||= rangeRes.rows[0]?.from ?? '2026-01-01';
      raw['to'] ||= rangeRes.rows[0]?.to ?? '2026-01-31';
    }
    const parsed = ReportQuerySchema.parse(raw);
    const bounds = await this.db.query<{ start: string; end: string }>(
      `SELECT to_char((($1::date)::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start,
              to_char(((($2::date) + 1)::timestamp AT TIME ZONE $3) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "end"`,
      [parsed.from, parsed.to, tz],
    );
    const b = bounds.rows[0];
    return {
      ...parsed,
      start: b?.start ?? parsed.from,
      end: b?.end ?? parsed.to,
      resolvedOwnerId: parsed.ownerId === '@me' ? user.id : parsed.ownerId,
    };
  }

  private periodMeta(cur: ResolvedPeriod, prev: ResolvedPeriod) {
    return {
      from: cur.from,
      to: cur.to,
      previousFrom: prev.from,
      previousTo: prev.to,
      market: cur.market ?? null,
      teamId: cur.teamId ?? null,
      ownerId: cur.ownerId ?? null,
      start: cur.start,
      end: cur.end,
    };
  }

  private async latestRate(from: Currency): Promise<bigint | null> {
    if (from === REPORTING_CURRENCY) return 1_000_000n;
    const res = await this.db.query<{ rate_scaled: string }>(
      `SELECT rate_scaled::text FROM fx_rates WHERE from_currency = $1 AND to_currency = $2
       ORDER BY effective_date DESC LIMIT 1`,
      [from, REPORTING_CURRENCY],
    );
    const r = res.rows[0]?.rate_scaled;
    return r ? BigInt(r) : null;
  }

  // -------------------------------------------------------------------------
  // 1. Leads & conversion funnel (PRD 4.15, 14)
  // -------------------------------------------------------------------------
  private async leadsFunnelReport(
    user: SessionUser,
    cur: ResolvedPeriod,
    prev: ResolvedPeriod,
    forExport: boolean,
  ): Promise<ReportResultView> {
    const buildFilters = (q: Sql, alias: string, p: ResolvedPeriod, withDates = true) => {
      const clauses = [
        `${alias}.deleted_at IS NULL`,
        q.scope(user, 'leads.read', alias, 'owner_user_id', forExport),
      ];
      if (withDates) {
        clauses.push(`${alias}.created_at >= ${q.p(p.start)}::timestamptz`);
        clauses.push(`${alias}.created_at < ${q.p(p.end)}::timestamptz`);
      }
      if (p.market) clauses.push(`${alias}.market = ${q.p(p.market)}`);
      if (p.teamId) clauses.push(`${alias}.team_id = ${q.p(p.teamId)}`);
      if (p.resolvedOwnerId) clauses.push(`${alias}.owner_user_id = ${q.p(p.resolvedOwnerId)}`);
      return clauses.join(' AND ');
    };

    const qualSql = `(l.status_category = 'qualified' OR l.status = 'Converted' OR l.converted_deal_id IS NOT NULL)`;

    const qCur = new Sql();
    const curWhere = buildFilters(qCur, 'l', cur, true);
    const qPrev = new Sql();
    const prevWhere = buildFilters(qPrev, 'l', prev, true);
    const qAll = new Sql();
    const allWhere = buildFilters(qAll, 'l', cur, false);

    const [curStats, prevStats, allCountRes, funnelRes, breakdownRes] = await Promise.all([
      this.db.query<{ total: number; qual: number; conv: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${qualSql})::int AS qual,
                COUNT(*) FILTER (WHERE l.status = 'Converted' OR l.converted_deal_id IS NOT NULL)::int AS conv
         FROM leads l WHERE ${curWhere}`,
        qCur.params,
      ),
      this.db.query<{ total: number; qual: number; conv: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${qualSql})::int AS qual,
                COUNT(*) FILTER (WHERE l.status = 'Converted' OR l.converted_deal_id IS NOT NULL)::int AS conv
         FROM leads l WHERE ${prevWhere}`,
        qPrev.params,
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM leads l WHERE ${allWhere}`,
        qAll.params,
      ),
      this.db.query<{ status: string; n: number }>(
        `SELECT l.status, COUNT(*)::int AS n FROM leads l WHERE ${curWhere} GROUP BY l.status`,
        qCur.params,
      ),
      this.db.query<{
        source: string;
        market: string;
        owner_name: string;
        total: number;
        qualified: number;
        converted: number;
      }>(
        `SELECT l.source, l.market, u.name AS owner_name,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${qualSql})::int AS qualified,
                COUNT(*) FILTER (WHERE l.status = 'Converted' OR l.converted_deal_id IS NOT NULL)::int AS converted
         FROM leads l JOIN users u ON u.id = l.owner_user_id
         WHERE ${curWhere}
         GROUP BY l.source, l.market, u.name
         ORDER BY total DESC, l.source, u.name`,
        qCur.params,
      ),
    ]);

    const c = curStats.rows[0] ?? { total: 0, qual: 0, conv: 0 };
    const p = prevStats.rows[0] ?? { total: 0, qual: 0, conv: 0 };
    const curRate = ratio(c.qual, c.total);
    const prevRate = ratio(p.qual, p.total);

    const statusCounts = new Map(funnelRes.rows.map((r) => [r.status, r.n]));
    const funnelBars = LeadSystemStatusSchema.options
      .filter((s) => (statusCounts.get(s) ?? 0) > 0)
      .map((s) => ({
        key: s,
        label: s,
        value: statusCounts.get(s) ?? 0,
        display: formatNumber(statusCounts.get(s) ?? 0),
        muted: s === 'Disqualified',
      }));

    const bySource = new Map<string, number>();
    for (const r of breakdownRes.rows) {
      bySource.set(r.source, (bySource.get(r.source) ?? 0) + r.total);
    }
    const sourceBars = [...bySource.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([src, cnt]) => ({
        key: src,
        label: src,
        value: cnt,
        display: formatNumber(cnt),
      }));

    return {
      id: 'leads_funnel',
      title: 'Leads & conversion funnel',
      subtitle:
        'Cohort funnel, lead-to-qualified conversion rate, and intake by source, market and owner.',
      period: this.periodMeta(cur, prev),
      reportingCurrency: REPORTING_CURRENCY,
      generatedAt: new Date().toISOString(),
      kpis: [
        {
          key: 'total_leads',
          label: 'Total active leads',
          value: formatNumber(allCountRes.rows[0]?.total ?? 0),
        },
        {
          key: 'new_leads',
          label: 'New leads (period)',
          value: formatNumber(c.total),
          delta: computeDeltaChip(c.total, p.total, { kind: 'count' }),
        },
        {
          key: 'qualified_leads',
          label: 'Qualified cohort',
          value: formatNumber(c.qual),
          delta: computeDeltaChip(c.qual, p.qual, { kind: 'count' }),
        },
        {
          key: 'conversion_rate',
          label: 'Lead-to-qualified rate',
          value: formatPercent(curRate),
          delta: computeDeltaChip(curRate, prevRate, { kind: 'rate' }),
        },
      ],
      charts: [
        {
          id: 'funnel',
          title: 'Cohort status funnel',
          valueLabel: 'Leads',
          empty: 'No leads created in this period.',
          bars: funnelBars,
        },
        {
          id: 'sources',
          title: 'New leads by source',
          valueLabel: 'Leads',
          empty: 'No lead sources in this period.',
          bars: sourceBars,
        },
      ],
      columns: [
        { key: 'source', label: 'Source' },
        { key: 'market', label: 'Market' },
        { key: 'owner', label: 'Owner' },
        { key: 'newLeads', label: 'New leads', align: 'right' },
        { key: 'qualified', label: 'Qualified', align: 'right' },
        { key: 'converted', label: 'Converted', align: 'right' },
        { key: 'qualifiedRate', label: 'Qualified rate', align: 'right' },
      ],
      rows: breakdownRes.rows.map((r) => ({
        source: r.source,
        market: r.market,
        owner: r.owner_name,
        newLeads: r.total,
        qualified: r.qualified,
        converted: r.converted,
        qualifiedRate: formatPercent(ratio(r.qualified, r.total)),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 2. Pipeline by stage & owner (PRD 4.15, 14)
  // -------------------------------------------------------------------------
  private async pipelineOverviewReport(
    user: SessionUser,
    cur: ResolvedPeriod,
    prev: ResolvedPeriod,
    forExport: boolean,
  ): Promise<ReportResultView> {
    const q = new Sql();
    const clauses = [
      `d.deleted_at IS NULL`,
      `d.stage_category = 'open'`,
      q.scope(user, 'deals.read', 'd', 'owner_user_id', forExport),
    ];
    if (cur.market) clauses.push(`cmp.market = ${q.p(cur.market)}`);
    if (cur.teamId) clauses.push(`d.team_id = ${q.p(cur.teamId)}`);
    if (cur.resolvedOwnerId) clauses.push(`d.owner_user_id = ${q.p(cur.resolvedOwnerId)}`);
    const whereSql = clauses.join(' AND ');

    const cadRate = await this.latestRate('CAD');

    const [stageRes, ownerRes] = await Promise.all([
      this.db.query<{
        pipeline_name: string;
        stage_id: string;
        stage_name: string;
        stage_order: number;
        currency: Currency;
        n: number;
        val: string;
        weighted: string;
      }>(
        `SELECT p.name AS pipeline_name, s.id AS stage_id, s.name AS stage_name, s.stage_order,
                d.currency, COUNT(*)::int AS n,
                SUM(d.monthly_value_minor * d.term_months + d.one_time_value_minor)::text AS val,
                SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * d.probability + 50) / 100)::text AS weighted
         FROM deals d
         JOIN companies cmp ON cmp.id = d.company_id
         JOIN pipeline_stages s ON s.id = d.stage_id
         JOIN pipelines p ON p.id = d.pipeline_id
         WHERE ${whereSql}
         GROUP BY p.name, s.id, s.name, s.stage_order, d.currency
         ORDER BY p.name, s.stage_order`,
        q.params,
      ),
      this.db.query<{
        owner_id: string;
        owner_name: string;
        stage_name: string;
        currency: Currency;
        n: number;
        val: string;
        weighted: string;
      }>(
        `SELECT u.id AS owner_id, u.name AS owner_name, s.name AS stage_name, d.currency,
                COUNT(*)::int AS n,
                SUM(d.monthly_value_minor * d.term_months + d.one_time_value_minor)::text AS val,
                SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * d.probability + 50) / 100)::text AS weighted
         FROM deals d
         JOIN companies cmp ON cmp.id = d.company_id
         JOIN pipeline_stages s ON s.id = d.stage_id
         JOIN users u ON u.id = d.owner_user_id
         WHERE ${whereSql}
         GROUP BY u.id, u.name, s.name, s.stage_order, d.currency
         ORDER BY u.name, s.stage_order`,
        q.params,
      ),
    ]);

    const toRep = (minor: bigint, currency: Currency): bigint => {
      if (currency === REPORTING_CURRENCY) return minor;
      if (cadRate === null) return 0n;
      return convertCurrencyMinor(minor, currency, REPORTING_CURRENCY, cadRate);
    };

    const byCurrencyRaw = new Map<Currency, bigint>([
      ['USD', 0n],
      ['CAD', 0n],
    ]);
    const stageAgg = new Map<
      string,
      { label: string; count: number; valRep: bigint; weightedRep: bigint }
    >();
    let totalCount = 0;
    let totalValRep = 0n;
    let totalWeightedRep = 0n;

    for (const r of stageRes.rows) {
      const rawVal = big(r.val);
      const rawWeighted = big(r.weighted);
      byCurrencyRaw.set(r.currency, (byCurrencyRaw.get(r.currency) ?? 0n) + rawVal);
      const vRep = toRep(rawVal, r.currency);
      const wRep = toRep(rawWeighted, r.currency);
      totalCount += r.n;
      totalValRep += vRep;
      totalWeightedRep += wRep;

      const curEntry = stageAgg.get(r.stage_id) ?? {
        label: r.stage_name,
        count: 0,
        valRep: 0n,
        weightedRep: 0n,
      };
      curEntry.count += r.n;
      curEntry.valRep += vRep;
      curEntry.weightedRep += wRep;
      stageAgg.set(r.stage_id, curEntry);
    }

    const ownerAgg = new Map<string, { name: string; count: number; valRep: bigint }>();
    for (const r of ownerRes.rows) {
      const vRep = toRep(big(r.val), r.currency);
      const curOwner = ownerAgg.get(r.owner_id) ?? { name: r.owner_name, count: 0, valRep: 0n };
      curOwner.count += r.n;
      curOwner.valRep += vRep;
      ownerAgg.set(r.owner_id, curOwner);
    }

    const usdRaw = byCurrencyRaw.get('USD') ?? 0n;
    const cadRaw = byCurrencyRaw.get('CAD') ?? 0n;

    return {
      id: 'pipeline_overview',
      title: 'Pipeline by stage & owner',
      subtitle:
        'Open contract value and probability-weighted pipeline in reporting currency (latest FX rate).',
      period: this.periodMeta(cur, prev),
      reportingCurrency: REPORTING_CURRENCY,
      currencyBreakdown: [
        {
          currency: 'USD',
          amountMinor: usdRaw.toString(),
          convertedMinor: usdRaw.toString(),
          label: `Original USD: ${moneyStr(usdRaw, 'USD')}`,
        },
        {
          currency: 'CAD',
          amountMinor: cadRaw.toString(),
          convertedMinor: cadRate !== null ? toRep(cadRaw, 'CAD').toString() : null,
          label:
            cadRate !== null
              ? `Original CAD: ${moneyStr(cadRaw, 'CAD')} (${moneyStr(toRep(cadRaw, 'CAD'), 'USD')})`
              : `Original CAD: ${moneyStr(cadRaw, 'CAD')}`,
        },
      ],
      generatedAt: new Date().toISOString(),
      kpis: [
        { key: 'active_deals', label: 'Active opportunities', value: formatNumber(totalCount) },
        { key: 'pipeline_value', label: 'Pipeline value', value: moneyStr(totalValRep) },
        { key: 'weighted_pipeline', label: 'Weighted pipeline', value: moneyStr(totalWeightedRep) },
      ],
      charts: [
        {
          id: 'by_stage',
          title: 'Pipeline by stage',
          valueLabel: `Pipeline (${REPORTING_CURRENCY})`,
          secondaryLabel: `Weighted (${REPORTING_CURRENCY})`,
          empty: 'No open opportunities match these filters.',
          bars: [...stageAgg.entries()].map(([idKey, s]) => ({
            key: idKey,
            label: s.label,
            value: Number(s.valRep / 100n),
            display: moneyStr(s.valRep),
            secondaryValue: Number(s.weightedRep / 100n),
            secondaryDisplay: `Weighted ${moneyStr(s.weightedRep)}`,
            detail: `${formatNumber(s.count)} deals`,
          })),
        },
        {
          id: 'by_owner',
          title: 'Pipeline by owner',
          valueLabel: `Pipeline (${REPORTING_CURRENCY})`,
          empty: 'No open opportunities match these filters.',
          bars: [...ownerAgg.entries()]
            .sort((a, b) => Number(b[1].valRep - a[1].valRep))
            .map(([uid, o]) => ({
              key: uid,
              label: o.name,
              value: Number(o.valRep / 100n),
              display: moneyStr(o.valRep),
              detail: `${formatNumber(o.count)} deals`,
            })),
        },
      ],
      columns: [
        { key: 'owner', label: 'Owner' },
        { key: 'stage', label: 'Stage' },
        { key: 'currency', label: 'Original currency' },
        { key: 'deals', label: 'Open deals', align: 'right' },
        { key: 'originalValue', label: 'Original value', align: 'right' },
        { key: 'reportingValue', label: `Value (${REPORTING_CURRENCY})`, align: 'right' },
        { key: 'weightedValue', label: `Weighted (${REPORTING_CURRENCY})`, align: 'right' },
      ],
      rows: ownerRes.rows.map((r) => {
        const rawV = big(r.val);
        const rawW = big(r.weighted);
        return {
          owner: r.owner_name,
          stage: r.stage_name,
          currency: r.currency,
          deals: r.n,
          originalValue: moneyStr(rawV, r.currency),
          reportingValue: moneyStr(toRep(rawV, r.currency)),
          weightedValue: moneyStr(toRep(rawW, r.currency)),
        };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // 3. Won, lost & revenue by owner and service (PRD 4.15, 14)
  // -------------------------------------------------------------------------
  private async wonLostRevenueReport(
    user: SessionUser,
    cur: ResolvedPeriod,
    prev: ResolvedPeriod,
    forExport: boolean,
  ): Promise<ReportResultView> {
    const cadRate = await this.latestRate('CAD');
    const fallbackCad = cadRate === null ? null : cadRate.toString();

    const runWindow = async (p: ResolvedPeriod) => {
      const q = new Sql();
      const scope = q.scope(user, 'deals.read', 'd', 'owner_user_id', forExport);
      const start = q.p(p.start);
      const end = q.p(p.end);
      const clauses = [
        `d.deleted_at IS NULL`,
        `d.closed_at >= ${start}::timestamptz`,
        `d.closed_at < ${end}::timestamptz`,
        scope,
      ];
      if (p.market) clauses.push(`cmp.market = ${q.p(p.market)}`);
      if (p.teamId) clauses.push(`d.team_id = ${q.p(p.teamId)}`);
      if (p.resolvedOwnerId) clauses.push(`d.owner_user_id = ${q.p(p.resolvedOwnerId)}`);
      const baseParams = [...q.params];
      const rateParam = q.p(fallbackCad);
      const fx = `CASE WHEN d.currency = '${REPORTING_CURRENCY}' THEN 1000000
                       ELSE COALESCE(d.fx_rate_scaled_at_close, ${rateParam}::bigint) END`;
      const whereSql = clauses.join(' AND ');

      const qTrial = new Sql();
      const trialScope = qTrial.scope(user, 'deals.read', 'd', 'owner_user_id', forExport);
      const tStart = qTrial.p(p.start);
      const tEnd = qTrial.p(p.end);
      const trialClauses = [
        `d.deleted_at IS NULL`,
        trialScope,
        `EXISTS (
          SELECT 1 FROM deal_stage_history h JOIN pipeline_stages s ON s.id = h.from_stage_id
          WHERE h.deal_id = d.id AND s.is_trial
            AND h.created_at >= ${tStart}::timestamptz AND h.created_at < ${tEnd}::timestamptz)`,
      ];
      if (p.market) trialClauses.push(`cmp.market = ${qTrial.p(p.market)}`);
      if (p.teamId) trialClauses.push(`d.team_id = ${qTrial.p(p.teamId)}`);
      if (p.resolvedOwnerId) trialClauses.push(`d.owner_user_id = ${qTrial.p(p.resolvedOwnerId)}`);

      const [summaryRes, byOwnerRes, byServiceRes, reasonsRes, byCurrRes, trialRes] =
        await Promise.all([
          this.db.query<{
            won: number;
            lost: number;
            rev: string | null;
            monthly: string | null;
            cycle_days: string | null;
          }>(
            `SELECT COUNT(*) FILTER (WHERE d.stage_category = 'won')::int AS won,
                    COUNT(*) FILTER (WHERE d.stage_category = 'lost')::int AS lost,
                    SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * (${fx}) + 500000) / 1000000)
                      FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NOT NULL)::text AS rev,
                    SUM((d.monthly_value_minor * (${fx}) + 500000) / 1000000)
                      FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NOT NULL)::text AS monthly,
                    ROUND(AVG(EXTRACT(EPOCH FROM (d.closed_at - d.created_at)) / 86400)
                      FILTER (WHERE d.stage_category = 'won')::numeric, 1)::text AS cycle_days
             FROM deals d JOIN companies cmp ON cmp.id = d.company_id
             WHERE ${whereSql}`,
            q.params,
          ),
          this.db.query<{
            owner_name: string;
            won: number;
            lost: number;
            rev: string | null;
            monthly: string | null;
          }>(
            `SELECT u.name AS owner_name,
                    COUNT(*) FILTER (WHERE d.stage_category = 'won')::int AS won,
                    COUNT(*) FILTER (WHERE d.stage_category = 'lost')::int AS lost,
                    SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * (${fx}) + 500000) / 1000000)
                      FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NOT NULL)::text AS rev,
                    SUM((d.monthly_value_minor * (${fx}) + 500000) / 1000000)
                      FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NOT NULL)::text AS monthly
             FROM deals d
             JOIN companies cmp ON cmp.id = d.company_id
             JOIN users u ON u.id = d.owner_user_id
             WHERE ${whereSql}
             GROUP BY u.name
             ORDER BY COALESCE(SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * (${fx}) + 500000) / 1000000)
                      FILTER (WHERE d.stage_category = 'won' AND (${fx}) IS NOT NULL), 0) DESC, u.name`,
            q.params,
          ),
          this.db.query<{ service: string; deals_won: number; rev: string | null }>(
            `SELECT svc AS service,
                    COUNT(*)::int AS deals_won,
                    SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * (${fx}) + 500000) / 1000000)::text AS rev
             FROM deals d
             JOIN companies cmp ON cmp.id = d.company_id
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(d.services) = 'array' AND jsonb_array_length(d.services) > 0
                    THEN d.services
                    ELSE '["Unspecified service"]'::jsonb END
             ) AS svc
             WHERE ${whereSql} AND d.stage_category = 'won' AND (${fx}) IS NOT NULL
             GROUP BY svc
             ORDER BY SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * (${fx}) + 500000) / 1000000) DESC, svc`,
            q.params,
          ),
          this.db.query<{ reason: string; n: number }>(
            `SELECT COALESCE(NULLIF(d.lost_reason, ''), 'Not recorded') AS reason, COUNT(*)::int AS n
             FROM deals d JOIN companies cmp ON cmp.id = d.company_id
             WHERE ${whereSql} AND d.stage_category = 'lost'
             GROUP BY 1 ORDER BY n DESC, reason`,
            baseParams,
          ),
          this.db.query<{ currency: Currency; raw_rev: string | null; conv_rev: string | null }>(
            `SELECT d.currency,
                    SUM(d.monthly_value_minor * d.term_months + d.one_time_value_minor)::text AS raw_rev,
                    SUM(((d.monthly_value_minor * d.term_months + d.one_time_value_minor) * (${fx}) + 500000) / 1000000)
                      FILTER (WHERE (${fx}) IS NOT NULL)::text AS conv_rev
             FROM deals d JOIN companies cmp ON cmp.id = d.company_id
             WHERE ${whereSql} AND d.stage_category = 'won'
             GROUP BY d.currency`,
            q.params,
          ),
          this.db.query<{ left_trial: number; won: number }>(
            `SELECT COUNT(*)::int AS left_trial,
                    COUNT(*) FILTER (WHERE d.stage_category = 'won')::int AS won
             FROM deals d JOIN companies cmp ON cmp.id = d.company_id
             WHERE ${trialClauses.join(' AND ')}`,
            qTrial.params,
          ),
        ]);

      const s = summaryRes.rows[0];
      const won = s?.won ?? 0;
      const lost = s?.lost ?? 0;
      const rev = big(s?.rev);
      const monthly = big(s?.monthly);
      const t = trialRes.rows[0] ?? { left_trial: 0, won: 0 };
      return {
        won,
        lost,
        winRate: ratio(won, won + lost),
        trialToWinRate: ratio(t.won, t.left_trial),
        rev,
        monthly,
        cycleDays: s?.cycle_days ? Number(s.cycle_days) : null,
        byOwner: byOwnerRes.rows,
        byService: byServiceRes.rows,
        reasons: reasonsRes.rows,
        byCurr: byCurrRes.rows,
      };
    };

    const [c, p] = await Promise.all([runWindow(cur), runWindow(prev)]);

    const usdRow = c.byCurr.find((x) => x.currency === 'USD');
    const cadRow = c.byCurr.find((x) => x.currency === 'CAD');
    const usdRaw = big(usdRow?.raw_rev);
    const cadRaw = big(cadRow?.raw_rev);
    const cadConv = big(cadRow?.conv_rev);

    return {
      id: 'won_lost_revenue',
      title: 'Won, lost & revenue',
      subtitle:
        'Closed outcomes, win rate, trial-to-win rate, sales cycle, and revenue won at FX rate at close.',
      period: this.periodMeta(cur, prev),
      reportingCurrency: REPORTING_CURRENCY,
      currencyBreakdown: [
        {
          currency: 'USD',
          amountMinor: usdRaw.toString(),
          convertedMinor: usdRaw.toString(),
          label: `Won in USD: ${moneyStr(usdRaw, 'USD')}`,
        },
        {
          currency: 'CAD',
          amountMinor: cadRaw.toString(),
          convertedMinor: cadConv.toString(),
          label: `Won in CAD: ${moneyStr(cadRaw, 'CAD')} (${moneyStr(cadConv, 'USD')} at close FX)`,
        },
      ],
      generatedAt: new Date().toISOString(),
      kpis: [
        {
          key: 'revenue_won',
          label: 'Revenue won',
          value: moneyStr(c.rev),
          delta: computeDeltaChip(c.rev, p.rev, { kind: 'money' }),
        },
        {
          key: 'monthly_won',
          label: 'Monthly value won',
          value: `${moneyStr(c.monthly)}/mo`,
          delta: computeDeltaChip(c.monthly, p.monthly, { kind: 'money' }),
        },
        {
          key: 'win_rate',
          label: 'Win rate',
          value: formatPercent(c.winRate),
          delta: computeDeltaChip(c.winRate, p.winRate, { kind: 'rate' }),
        },
        {
          key: 'trial_to_win',
          label: 'Trial-to-win rate',
          value: formatPercent(c.trialToWinRate),
          delta: computeDeltaChip(c.trialToWinRate, p.trialToWinRate, { kind: 'rate' }),
        },
        {
          key: 'avg_cycle',
          label: 'Avg sales cycle',
          value: c.cycleDays === null ? '—' : `${c.cycleDays} days`,
        },
      ],
      charts: [
        {
          id: 'outcomes',
          title: 'Closed deals (Won vs Lost)',
          valueLabel: 'Deals',
          empty: 'No deals closed in this period.',
          bars:
            c.won + c.lost === 0
              ? []
              : [
                  { key: 'won', label: 'Won', value: c.won, display: formatNumber(c.won) },
                  {
                    key: 'lost',
                    label: 'Lost',
                    value: c.lost,
                    display: formatNumber(c.lost),
                    muted: true,
                  },
                ],
        },
        {
          id: 'revenue_by_service',
          title: 'Revenue won by service',
          valueLabel: `Revenue (${REPORTING_CURRENCY})`,
          empty: 'No won deals in this period.',
          bars: c.byService.map((s) => {
            const rv = big(s.rev);
            return {
              key: s.service,
              label: s.service,
              value: Number(rv / 100n),
              display: moneyStr(rv),
              detail: `${formatNumber(s.deals_won)} deals`,
            };
          }),
        },
        {
          id: 'lost_reasons',
          title: 'Lost reasons',
          valueLabel: 'Deals lost',
          empty: 'No lost deals in this period.',
          bars: c.reasons.map((r) => ({
            key: r.reason,
            label: r.reason,
            value: r.n,
            display: formatNumber(r.n),
            muted: true,
          })),
        },
      ],
      columns: [
        { key: 'owner', label: 'Owner' },
        { key: 'won', label: 'Deals won', align: 'right' },
        { key: 'lost', label: 'Deals lost', align: 'right' },
        { key: 'winRate', label: 'Win rate', align: 'right' },
        { key: 'monthlyWon', label: `Monthly won (${REPORTING_CURRENCY})`, align: 'right' },
        { key: 'revenueWon', label: `Revenue won (${REPORTING_CURRENCY})`, align: 'right' },
      ],
      rows: c.byOwner.map((o) => ({
        owner: o.owner_name,
        won: o.won,
        lost: o.lost,
        winRate: formatPercent(ratio(o.won, o.won + o.lost)),
        monthlyWon: moneyStr(big(o.monthly)),
        revenueWon: moneyStr(big(o.rev)),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 4. Inquiry first-response SLA (PRD 4.15, 14)
  // -------------------------------------------------------------------------
  private async slaResponsivenessReport(
    user: SessionUser,
    cur: ResolvedPeriod,
    prev: ResolvedPeriod,
    forExport: boolean,
  ): Promise<ReportResultView> {
    const breachedExpr = `COALESCE(t.sla_breached
      OR (t.status = 'completed' AND t.completed_at > t.sla_deadline_at)
      OR (t.status = 'open' AND t.sla_deadline_at < NOW()), FALSE)`;

    const runWindow = async (p: ResolvedPeriod) => {
      const q = new Sql();
      const scope = q.scope(user, 'tasks.read', 't', 'assignee_user_id', forExport);
      const clauses = [
        `t.deleted_at IS NULL`,
        `t.task_type = 'sla_first_response'`,
        `t.status <> 'cancelled'`,
        `t.created_at >= ${q.p(p.start)}::timestamptz`,
        `t.created_at < ${q.p(p.end)}::timestamptz`,
        scope,
      ];
      if (p.market)
        clauses.push(`COALESCE(ld.market, ct.market, au.market_focus) = ${q.p(p.market)}`);
      if (p.teamId) clauses.push(`t.team_id = ${q.p(p.teamId)}`);
      if (p.resolvedOwnerId) clauses.push(`t.assignee_user_id = ${q.p(p.resolvedOwnerId)}`);
      const whereSql = clauses.join(' AND ');
      const fromSql = `FROM tasks t
        JOIN users au ON au.id = t.assignee_user_id
        LEFT JOIN leads ld ON ld.id = t.lead_id
        LEFT JOIN contacts ct ON ct.id = t.contact_id`;

      const [sumRes, byAssigneeRes] = await Promise.all([
        this.db.query<{
          received: number;
          met: number;
          breached: number;
          waiting: number;
          median_min: string | null;
        }>(
          `SELECT COUNT(*)::int AS received,
                  COUNT(*) FILTER (WHERE t.status = 'completed' AND NOT ${breachedExpr})::int AS met,
                  COUNT(*) FILTER (WHERE ${breachedExpr})::int AS breached,
                  COUNT(*) FILTER (WHERE t.status = 'open' AND NOT ${breachedExpr})::int AS waiting,
                  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 60
                  ) FILTER (WHERE t.status = 'completed'))::numeric, 0)::text AS median_min
           ${fromSql} WHERE ${whereSql}`,
          q.params,
        ),
        this.db.query<{
          assignee_name: string;
          received: number;
          met: number;
          breached: number;
          waiting: number;
          median_min: string | null;
        }>(
          `SELECT au.name AS assignee_name,
                  COUNT(*)::int AS received,
                  COUNT(*) FILTER (WHERE t.status = 'completed' AND NOT ${breachedExpr})::int AS met,
                  COUNT(*) FILTER (WHERE ${breachedExpr})::int AS breached,
                  COUNT(*) FILTER (WHERE t.status = 'open' AND NOT ${breachedExpr})::int AS waiting,
                  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 60
                  ) FILTER (WHERE t.status = 'completed'))::numeric, 0)::text AS median_min
           ${fromSql} WHERE ${whereSql}
           GROUP BY au.name
           ORDER BY breached DESC, received DESC, au.name`,
          q.params,
        ),
      ]);
      const s = sumRes.rows[0] ?? {
        received: 0,
        met: 0,
        breached: 0,
        waiting: 0,
        median_min: null,
      };
      return {
        ...s,
        metRate: ratio(s.met, s.received),
        medianMinutes: s.median_min === null ? null : Number(s.median_min),
        rows: byAssigneeRes.rows,
      };
    };

    const [c, p] = await Promise.all([runWindow(cur), runWindow(prev)]);

    return {
      id: 'sla_responsiveness',
      title: 'Inquiry response time (SLA)',
      subtitle:
        'Website inquiries answered within one business day, late breaches, and median first-response speed.',
      period: this.periodMeta(cur, prev),
      reportingCurrency: REPORTING_CURRENCY,
      generatedAt: new Date().toISOString(),
      kpis: [
        {
          key: 'received',
          label: 'Inquiries received',
          value: formatNumber(c.received),
          delta: computeDeltaChip(c.received, p.received, { kind: 'count' }),
        },
        {
          key: 'met_rate',
          label: 'SLA met rate',
          value: formatPercent(c.metRate),
          delta: computeDeltaChip(c.metRate, p.metRate, { kind: 'rate' }),
        },
        {
          key: 'breached',
          label: 'SLA breached',
          value: formatNumber(c.breached),
          delta: computeDeltaChip(c.breached, p.breached, { kind: 'count', invertGood: true }),
        },
        {
          key: 'median_time',
          label: 'Median first response',
          value: formatMinutes(c.medianMinutes),
        },
      ],
      charts: [
        {
          id: 'by_assignee',
          title: 'Inquiries handled vs breached by assignee',
          valueLabel: 'Met SLA',
          secondaryLabel: 'Breached',
          empty: 'No website inquiries received in this period.',
          bars: c.rows.map((r) => ({
            key: r.assignee_name,
            label: r.assignee_name,
            value: r.met,
            display: `${formatNumber(r.met)} met`,
            secondaryValue: r.breached,
            secondaryDisplay: `${formatNumber(r.breached)} breached`,
            detail: `${formatNumber(r.received)} total`,
          })),
        },
      ],
      columns: [
        { key: 'assignee', label: 'Assignee' },
        { key: 'received', label: 'Received', align: 'right' },
        { key: 'met', label: 'Met SLA', align: 'right' },
        { key: 'breached', label: 'Breached', align: 'right' },
        { key: 'waiting', label: 'Waiting', align: 'right' },
        { key: 'metRate', label: 'SLA met rate', align: 'right' },
        { key: 'medianResponse', label: 'Median first response', align: 'right' },
      ],
      rows: c.rows.map((r) => ({
        assignee: r.assignee_name,
        received: r.received,
        met: r.met,
        breached: r.breached,
        waiting: r.waiting,
        metRate: formatPercent(ratio(r.met, r.received)),
        medianResponse: formatMinutes(r.median_min === null ? null : Number(r.median_min)),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 5. Employee activity & follow-up completion (PRD 4.15, 14)
  // -------------------------------------------------------------------------
  private async employeeActivityReport(
    user: SessionUser,
    cur: ResolvedPeriod,
    prev: ResolvedPeriod,
    forExport: boolean,
  ): Promise<ReportResultView> {
    const reportScope = requireCapability(user, 'reports.read');
    const exportScope = forExport ? requireCapability(user, 'exports.run') : reportScope;
    const effectiveScope =
      reportScope === 'own' || exportScope === 'own'
        ? 'own'
        : reportScope === 'team' || exportScope === 'team'
          ? 'team'
          : 'all';

    const runWindow = async (p: ResolvedPeriod) => {
      const q = new Sql();
      const start = q.p(p.start);
      const end = q.p(p.end);
      const userClauses = [`u.status <> 'disabled'`];
      if (effectiveScope === 'own') {
        userClauses.push(`u.id = ${q.p(user.id)}`);
      } else if (effectiveScope === 'team') {
        userClauses.push(`u.id = ANY(${q.p([user.id, ...user.teamMemberIds])}::text[])`);
      }
      if (p.market) userClauses.push(`u.market_focus = ${q.p(p.market)}`);
      if (p.teamId) userClauses.push(`u.team_id = ${q.p(p.teamId)}`);
      if (p.resolvedOwnerId) userClauses.push(`u.id = ${q.p(p.resolvedOwnerId)}`);

      const res = await this.db.query<{
        user_id: string;
        name: string;
        calls: number;
        meetings: number;
        emails: number;
        tasks_done: number;
        tasks_due: number;
        tasks_on_time: number;
        deals_moved: number;
      }>(
        `SELECT u.id AS user_id, u.name,
           (SELECT COUNT(*)::int FROM activities a WHERE a.actor_user_id = u.id AND a.activity_type = 'call'
              AND a.occurred_at >= ${start}::timestamptz AND a.occurred_at < ${end}::timestamptz) AS calls,
           (SELECT COUNT(*)::int FROM activities a WHERE a.actor_user_id = u.id AND a.activity_type = 'meeting'
              AND a.occurred_at >= ${start}::timestamptz AND a.occurred_at < ${end}::timestamptz) AS meetings,
           (SELECT COUNT(*)::int FROM activities a WHERE a.actor_user_id = u.id AND a.activity_type = 'email_logged'
              AND a.occurred_at >= ${start}::timestamptz AND a.occurred_at < ${end}::timestamptz) AS emails,
           (SELECT COUNT(*)::int FROM tasks t WHERE t.completed_by_user_id = u.id AND t.status = 'completed'
              AND t.completed_at >= ${start}::timestamptz AND t.completed_at < ${end}::timestamptz) AS tasks_done,
           (SELECT COUNT(*)::int FROM tasks t WHERE t.assignee_user_id = u.id AND t.deleted_at IS NULL AND t.status <> 'cancelled'
              AND t.due_at >= ${start}::timestamptz AND t.due_at < ${end}::timestamptz) AS tasks_due,
           (SELECT COUNT(*)::int FROM tasks t WHERE t.assignee_user_id = u.id AND t.deleted_at IS NULL AND t.status = 'completed'
              AND t.due_at >= ${start}::timestamptz AND t.due_at < ${end}::timestamptz
              AND t.completed_at <= t.due_at) AS tasks_on_time,
           (SELECT COUNT(*)::int FROM deal_stage_history h WHERE h.changed_by_user_id = u.id
              AND h.created_at >= ${start}::timestamptz AND h.created_at < ${end}::timestamptz) AS deals_moved
         FROM users u
         WHERE ${userClauses.join(' AND ')}
         ORDER BY u.name`,
        q.params,
      );

      const rows = res.rows
        .map((r) => ({
          ...r,
          total: r.calls + r.meetings + r.emails + r.tasks_done + r.deals_moved,
          onTimeRate: ratio(r.tasks_on_time, r.tasks_due),
        }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

      const totals = rows.reduce(
        (acc, r) => ({
          calls: acc.calls + r.calls,
          meetings: acc.meetings + r.meetings,
          emails: acc.emails + r.emails,
          tasksDone: acc.tasksDone + r.tasks_done,
          tasksDue: acc.tasksDue + r.tasks_due,
          tasksOnTime: acc.tasksOnTime + r.tasks_on_time,
          dealsMoved: acc.dealsMoved + r.deals_moved,
          total: acc.total + r.total,
        }),
        {
          calls: 0,
          meetings: 0,
          emails: 0,
          tasksDone: 0,
          tasksDue: 0,
          tasksOnTime: 0,
          dealsMoved: 0,
          total: 0,
        },
      );
      return {
        rows,
        totals,
        onTimeRate: ratio(totals.tasksOnTime, totals.tasksDue),
      };
    };

    const [c, p] = await Promise.all([runWindow(cur), runWindow(prev)]);

    return {
      id: 'employee_activity',
      title: 'Activity & follow-up completion',
      subtitle:
        'Calls, meetings booked, emails logged, tasks completed, on-time follow-up rate, and stage moves per person.',
      period: this.periodMeta(cur, prev),
      reportingCurrency: REPORTING_CURRENCY,
      generatedAt: new Date().toISOString(),
      kpis: [
        {
          key: 'calls',
          label: 'Calls logged',
          value: formatNumber(c.totals.calls),
          delta: computeDeltaChip(c.totals.calls, p.totals.calls, { kind: 'count' }),
        },
        {
          key: 'meetings',
          label: 'Meetings booked',
          value: formatNumber(c.totals.meetings),
          delta: computeDeltaChip(c.totals.meetings, p.totals.meetings, { kind: 'count' }),
        },
        {
          key: 'tasks_done',
          label: 'Tasks completed',
          value: formatNumber(c.totals.tasksDone),
          delta: computeDeltaChip(c.totals.tasksDone, p.totals.tasksDone, { kind: 'count' }),
        },
        {
          key: 'on_time_rate',
          label: 'Follow-up completion rate',
          value: formatPercent(c.onTimeRate),
          delta: computeDeltaChip(c.onTimeRate, p.onTimeRate, { kind: 'rate' }),
        },
      ],
      charts: [
        {
          id: 'by_user',
          title: 'Total touchpoints & actions by person',
          valueLabel: 'Actions',
          empty: 'No employee activity recorded in this period.',
          bars: c.rows.map((r) => ({
            key: r.user_id,
            label: r.name,
            value: r.total,
            display: formatNumber(r.total),
            detail: `${formatNumber(r.calls)} calls · ${formatNumber(r.meetings)} mtgs · ${formatNumber(r.tasks_done)} tasks`,
          })),
        },
      ],
      columns: [
        { key: 'person', label: 'Person' },
        { key: 'calls', label: 'Calls', align: 'right' },
        { key: 'meetings', label: 'Meetings', align: 'right' },
        { key: 'emails', label: 'Emails logged', align: 'right' },
        { key: 'tasksCompleted', label: 'Tasks completed', align: 'right' },
        { key: 'followUpRate', label: 'On-time follow-up rate', align: 'right' },
        { key: 'dealsMoved', label: 'Deals moved', align: 'right' },
        { key: 'total', label: 'Total actions', align: 'right' },
      ],
      rows: c.rows.map((r) => ({
        person: r.name,
        calls: r.calls,
        meetings: r.meetings,
        emails: r.emails,
        tasksCompleted: r.tasks_done,
        followUpRate: formatPercent(r.onTimeRate),
        dealsMoved: r.deals_moved,
        total: r.total,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 6. Sequence & campaign deliverability (PRD 4.15, 14)
  // -------------------------------------------------------------------------
  private async outreachDeliverabilityReport(
    user: SessionUser,
    cur: ResolvedPeriod,
    prev: ResolvedPeriod,
    forExport: boolean,
  ): Promise<ReportResultView> {
    const reportScope = requireCapability(user, 'reports.read');
    const exportScope = forExport ? requireCapability(user, 'exports.run') : reportScope;
    const effectiveScope =
      reportScope === 'own' || exportScope === 'own'
        ? 'own'
        : reportScope === 'team' || exportScope === 'team'
          ? 'team'
          : 'all';

    const runWindow = async (p: ResolvedPeriod) => {
      const q = new Sql();
      const start = q.p(p.start);
      const end = q.p(p.end);
      const senderClauses = [`m.channel IN ('sequence', 'campaign')`];
      if (effectiveScope === 'own') {
        senderClauses.push(`m.sender_user_id = ${q.p(user.id)}`);
      } else if (effectiveScope === 'team') {
        senderClauses.push(
          `m.sender_user_id = ANY(${q.p([user.id, ...user.teamMemberIds])}::text[])`,
        );
      }
      if (p.resolvedOwnerId) senderClauses.push(`m.sender_user_id = ${q.p(p.resolvedOwnerId)}`);
      if (p.teamId) {
        senderClauses.push(
          `EXISTS (SELECT 1 FROM users su WHERE su.id = m.sender_user_id AND su.team_id = ${q.p(p.teamId)})`,
        );
      }
      if (p.market) {
        senderClauses.push(
          `EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = m.contact_id AND ct.market = ${q.p(p.market)})`,
        );
      }
      const sendWhere = `${senderClauses.join(' AND ')} AND m.sent_at >= ${start}::timestamptz AND m.sent_at < ${end}::timestamptz`;

      const qEnr = new Sql();
      const eStart = qEnr.p(p.start);
      const eEnd = qEnr.p(p.end);
      const enrClauses = [
        `e.enrolled_at >= ${eStart}::timestamptz`,
        `e.enrolled_at < ${eEnd}::timestamptz`,
        `EXISTS (SELECT 1 FROM message_sends ms WHERE ms.sequence_enrollment_id = e.id)`,
      ];
      if (effectiveScope === 'own') {
        enrClauses.push(`e.sender_user_id = ${qEnr.p(user.id)}`);
      } else if (effectiveScope === 'team') {
        enrClauses.push(
          `e.sender_user_id = ANY(${qEnr.p([user.id, ...user.teamMemberIds])}::text[])`,
        );
      }
      if (p.resolvedOwnerId) enrClauses.push(`e.sender_user_id = ${qEnr.p(p.resolvedOwnerId)}`);

      const [sendsRes, replyRes, supRes] = await Promise.all([
        this.db.query<{
          channel: string;
          sent: number;
          delivered: number;
          bounced: number;
          complained: number;
          clicked: number;
        }>(
          `SELECT m.channel,
                  COUNT(*)::int AS sent,
                  COUNT(*) FILTER (WHERE m.status IN ('delivered', 'complained'))::int AS delivered,
                  COUNT(*) FILTER (WHERE m.status = 'bounced')::int AS bounced,
                  COUNT(*) FILTER (WHERE m.status = 'complained')::int AS complained,
                  COUNT(DISTINCT m.contact_id) FILTER (
                    WHERE m.channel = 'campaign'
                      AND m.contact_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM activities a
                        WHERE a.contact_id = m.contact_id
                          AND a.activity_type = 'campaign_clicked'
                          AND a.occurred_at >= m.sent_at
                      )
                  )::int AS clicked
           FROM message_sends m
           WHERE ${sendWhere}
           GROUP BY m.channel`,
          q.params,
        ),
        this.db.query<{ emailed: number; replied: number }>(
          `SELECT COUNT(*)::int AS emailed,
                  COUNT(*) FILTER (WHERE e.status = 'replied')::int AS replied
           FROM sequence_enrollments e
           WHERE ${enrClauses.join(' AND ')}`,
          qEnr.params,
        ),
        this.db.query<{ reason: string; n: number }>(
          `SELECT reason, COUNT(*)::int AS n
           FROM suppressions
           WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
           GROUP BY reason ORDER BY n DESC`,
          [p.start, p.end],
        ),
      ]);

      const channels = ['sequence', 'campaign'].map((ch) => {
        const r = sendsRes.rows.find((x) => x.channel === ch) ?? {
          sent: 0,
          delivered: 0,
          bounced: 0,
          complained: 0,
          clicked: 0,
        };
        return { channel: ch, ...r };
      });
      const totalSent = channels.reduce((s, x) => s + x.sent, 0);
      const totalDelivered = channels.reduce((s, x) => s + x.delivered, 0);
      const totalBounced = channels.reduce((s, x) => s + x.bounced, 0);
      const totalComplained = channels.reduce((s, x) => s + x.complained, 0);
      const rep = replyRes.rows[0] ?? { emailed: 0, replied: 0 };
      const unsubs = supRes.rows.find((s) => s.reason === 'unsubscribe')?.n ?? 0;

      return {
        channels,
        totalSent,
        totalDelivered,
        totalBounced,
        totalComplained,
        deliveryRate: ratio(totalDelivered, totalSent),
        bounceRate: ratio(totalBounced, totalSent),
        complaintRate: ratio(totalComplained, totalDelivered),
        replyRate: ratio(rep.replied, rep.emailed),
        unsubscribes: unsubs,
        unsubscribeRate: ratio(unsubs, totalDelivered),
        suppressions: supRes.rows,
      };
    };

    const [c, p] = await Promise.all([runWindow(cur), runWindow(prev)]);

    return {
      id: 'outreach_deliverability',
      title: 'Outreach & deliverability',
      subtitle:
        'Sequence and campaign delivery, reply rate, hard-bounce and complaint health, and suppression growth.',
      period: this.periodMeta(cur, prev),
      reportingCurrency: REPORTING_CURRENCY,
      generatedAt: new Date().toISOString(),
      kpis: [
        {
          key: 'sent',
          label: 'Messages sent',
          value: formatNumber(c.totalSent),
          delta: computeDeltaChip(c.totalSent, p.totalSent, { kind: 'count' }),
        },
        {
          key: 'delivery_rate',
          label: 'Delivery rate',
          value: formatPercent(c.deliveryRate, 1),
          delta: computeDeltaChip(c.deliveryRate, p.deliveryRate, { kind: 'rate' }),
        },
        {
          key: 'reply_rate',
          label: 'Sequence reply rate',
          value: formatPercent(c.replyRate, 1),
          delta: computeDeltaChip(c.replyRate, p.replyRate, { kind: 'rate' }),
        },
        {
          key: 'bounce_rate',
          label: 'Hard-bounce rate',
          value: formatPercent(c.bounceRate, 1),
          delta: computeDeltaChip(c.bounceRate, p.bounceRate, { kind: 'rate', invertGood: true }),
        },
      ],
      charts: [
        {
          id: 'channels',
          title: 'Delivered messages by channel',
          valueLabel: 'Delivered',
          empty: 'No sequence or campaign messages sent in this period.',
          bars: c.channels
            .filter((ch) => ch.sent > 0)
            .map((ch) => ({
              key: ch.channel,
              label: ch.channel === 'sequence' ? 'Sequences' : 'Campaigns',
              value: ch.delivered,
              display: `${formatNumber(ch.delivered)} / ${formatNumber(ch.sent)}`,
              detail: `Bounce ${formatPercent(ratio(ch.bounced, ch.sent), 1)}`,
            })),
        },
        {
          id: 'suppressions',
          title: 'Suppressions added by reason',
          valueLabel: 'Addresses',
          empty: 'No new suppressions in this period.',
          bars: c.suppressions.map((s) => ({
            key: s.reason,
            label: s.reason.replace(/_/g, ' '),
            value: s.n,
            display: formatNumber(s.n),
            muted: true,
          })),
        },
      ],
      columns: [
        { key: 'channel', label: 'Channel' },
        { key: 'sent', label: 'Sent', align: 'right' },
        { key: 'delivered', label: 'Delivered', align: 'right' },
        { key: 'deliveryRate', label: 'Delivery rate', align: 'right' },
        { key: 'bounced', label: 'Hard bounces', align: 'right' },
        { key: 'bounceRate', label: 'Bounce rate', align: 'right' },
        { key: 'complained', label: 'Complaints', align: 'right' },
        { key: 'complaintRate', label: 'Complaint rate', align: 'right' },
        { key: 'clickRate', label: 'Click rate', align: 'right' },
      ],
      rows: c.channels.map((ch) => ({
        channel: ch.channel === 'sequence' ? 'Sequences' : 'Campaigns',
        sent: ch.sent,
        delivered: ch.delivered,
        deliveryRate: formatPercent(ratio(ch.delivered, ch.sent), 1),
        bounced: ch.bounced,
        bounceRate: formatPercent(ratio(ch.bounced, ch.sent), 1),
        complained: ch.complained,
        complaintRate: formatPercent(ratio(ch.complained, ch.delivered), 2),
        clickRate:
          ch.channel === 'campaign' ? formatPercent(ratio(ch.clicked, ch.delivered), 1) : '—',
      })),
    };
  }
}
