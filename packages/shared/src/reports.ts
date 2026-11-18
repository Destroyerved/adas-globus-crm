import { z } from 'zod';
import { type Currency } from './enums.js';
import { formatNumber } from './format.js';

// ---------------------------------------------------------------------------
// Period-over-period comparison & delta chips (PRD 4.2, 4.15, 14; DESIGN 6.7)
// ---------------------------------------------------------------------------

export interface DeltaChip {
  direction: 'up' | 'down' | 'flat';
  text: string;
  tone: 'success' | 'danger' | 'neutral';
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatYmdUtc = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/**
 * Given an inclusive `[from, to]` YYYY-MM-DD range of N days, returns the immediately
 * preceding N-day inclusive `[from, to]` YYYY-MM-DD range.
 */
export function previousPeriodRange(from: string, to: string): { from: string; to: string } {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const startUtc = Date.UTC(fy, fm - 1, fd);
  const endUtc = Date.UTC(ty, tm - 1, td);
  const spanDays = Math.max(1, Math.round((endUtc - startUtc) / 86_400_000) + 1);
  return {
    from: formatYmdUtc(new Date(startUtc - spanDays * 86_400_000)),
    to: formatYmdUtc(new Date(startUtc - 86_400_000)),
  };
}

/**
 * Computes an accessible period-over-period delta chip (DESIGN 6.7: arrow + signed text + tone,
 * never colour alone). Returns null when either rate is null/undefined.
 */
export function computeDeltaChip(
  current: number | bigint | null | undefined,
  previous: number | bigint | null | undefined,
  options: { kind?: 'count' | 'rate' | 'money'; invertGood?: boolean } = {},
): DeltaChip | null {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  const kind = options.kind ?? 'count';
  const invert = options.invertGood ?? false;

  if (kind === 'rate') {
    const curNum = Number(current);
    const prevNum = Number(previous);
    if (!Number.isFinite(curNum) || !Number.isFinite(prevNum)) return null;
    const pp = Math.round((curNum - prevNum) * 100);
    if (pp === 0) return { direction: 'flat', text: '0 pp', tone: 'neutral' };
    if (pp > 0) {
      return { direction: 'up', text: `+${pp} pp`, tone: invert ? 'danger' : 'success' };
    }
    return { direction: 'down', text: `${pp} pp`, tone: invert ? 'success' : 'danger' };
  }

  const curBig = typeof current === 'bigint' ? current : BigInt(Math.round(Number(current)));
  const prevBig = typeof previous === 'bigint' ? previous : BigInt(Math.round(Number(previous)));

  if (prevBig === 0n) {
    if (curBig === 0n) return { direction: 'flat', text: '0%', tone: 'neutral' };
    if (curBig > 0n) {
      return {
        direction: 'up',
        text: kind === 'count' ? `+${formatNumber(curBig)}` : 'New',
        tone: invert ? 'danger' : 'success',
      };
    }
    return {
      direction: 'down',
      text: `${formatNumber(curBig)}`,
      tone: invert ? 'success' : 'danger',
    };
  }

  // Integer percentage rounded to nearest whole percent: ((cur - prev) * 100) / prev
  const diff = curBig - prevBig;
  if (diff === 0n) return { direction: 'flat', text: '0%', tone: 'neutral' };
  const pct = Number((diff * 1000n) / prevBig) / 10;
  const rounded = Math.round(pct);
  if (rounded === 0) {
    return diff > 0n
      ? { direction: 'up', text: '+1%', tone: invert ? 'danger' : 'success' }
      : { direction: 'down', text: '-1%', tone: invert ? 'success' : 'danger' };
  }
  if (rounded > 0) {
    return {
      direction: 'up',
      text: `+${formatNumber(rounded)}%`,
      tone: invert ? 'danger' : 'success',
    };
  }
  return {
    direction: 'down',
    text: `${formatNumber(rounded)}%`,
    tone: invert ? 'success' : 'danger',
  };
}

export interface DashboardSummaryView {
  period: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    market: string | null;
    start: string;
    end: string;
  };
  generatedAt: string;
  totalCompanies: number | null;
  newCompanies: number | null;
  previousNewCompanies: number | null;
  totalContacts: number | null;
  newContacts: number | null;
  previousNewContacts: number | null;
  newLeads: number | null;
  previousNewLeads: number | null;
  leadConversionRate: number | null;
  previousLeadConversionRate: number | null;
}

// ---------------------------------------------------------------------------
// Standalone Standard Reports (PRD 4.15, 14; DESIGN 7)
// ---------------------------------------------------------------------------

export const REPORT_IDS = [
  'leads_funnel',
  'pipeline_overview',
  'won_lost_revenue',
  'sla_responsiveness',
  'employee_activity',
  'outreach_deliverability',
] as const;
export const ReportIdSchema = z.enum(REPORT_IDS);
export type ReportId = z.infer<typeof ReportIdSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08.');

export const ReportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    market: z.enum(['US', 'CA']).optional(),
    teamId: z.string().trim().min(1).max(80).optional(),
    ownerId: z.string().trim().min(1).max(80).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'The start date must be on or before the end date.' })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 731 * 86_400_000, {
    message: 'Choose a period of two years or less.',
  });
export type ReportQuery = z.infer<typeof ReportQuerySchema>;

export interface ReportFilterOptions {
  timezone: string;
  reportingCurrency: Currency;
  defaultRange: { from: string; to: string };
  teams: { id: string; name: string; market: string }[];
  owners: { id: string; name: string; teamId: string | null }[];
  canExport: boolean;
}

export interface ReportKpiItem {
  key: string;
  label: string;
  value: string;
  delta?: DeltaChip | null;
}

export interface ReportBarSeriesItem {
  key: string;
  label: string;
  value: number;
  display: string;
  secondaryValue?: number;
  secondaryDisplay?: string;
  detail?: string;
  muted?: boolean;
}

export interface ReportChartBlock {
  id: string;
  title: string;
  valueLabel: string;
  secondaryLabel?: string;
  empty: string;
  bars: ReportBarSeriesItem[];
}

export interface ReportTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
}

export interface ReportResultView {
  id: ReportId;
  title: string;
  subtitle: string;
  period: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    market: string | null;
    teamId: string | null;
    ownerId: string | null;
    start: string;
    end: string;
  };
  reportingCurrency: Currency;
  currencyBreakdown?: {
    currency: Currency;
    amountMinor: string;
    convertedMinor: string | null;
    label: string;
  }[];
  generatedAt: string;
  kpis: ReportKpiItem[];
  charts: ReportChartBlock[];
  columns: ReportTableColumn[];
  rows: Record<string, string | number>[];
}
