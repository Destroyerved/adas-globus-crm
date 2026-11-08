import { type Currency, type Money } from './enums.js';

const WESTERN_NUMBER_FORMAT = new Intl.NumberFormat('en-US');

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Format numbers using Western digit grouping (1,250,000) for all users (DESIGN.md §10).
 */
export function formatNumber(value: number | bigint): string {
  return WESTERN_NUMBER_FORMAT.format(value);
}

/** A share as a percentage ("42%"); "—" when there is nothing to divide by. */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** A duration in minutes as "45 min", "3 h 20 min" or "2.5 days"; "—" when unknown. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  return `${formatNumber(Math.round((m / 1440) * 10) / 10)} days`;
}

/**
 * Format counts with singular/plural and "No <plural>" instead of "0 <plural>" (DESIGN.md §10).
 */
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  if (count === 0) {
    return `No ${plural}`;
  }
  if (count === 1) {
    return `1 ${singular}`;
  }
  return `${formatNumber(count)} ${plural}`;
}

/**
 * Currency prefix per DESIGN.md §10 ("US$12,500", "CA$12,500", "US$4.5k/mo").
 */
export function currencyPrefix(currency: Currency): string {
  return currency === 'CAD' ? 'CA$' : 'US$';
}

export interface FormatMoneyOptions {
  compact?: boolean;
  perMonth?: boolean;
}

/**
 * Format Money in minor units (cents) with explicit currency mark (DESIGN.md §10, AGENTS.md §7, §9).
 */
export function formatMoney(money: Money, options: FormatMoneyOptions = {}): string {
  const prefix = currencyPrefix(money.currency);
  const majorValue = Number(money.amountMinor) / 100;
  const suffix = options.perMonth ? '/mo' : '';

  if (options.compact && Math.abs(majorValue) >= 1000) {
    const kValue = majorValue / 1000;
    const formattedK = Number.isInteger(kValue)
      ? String(kValue)
      : kValue.toFixed(1).replace(/\.0$/, '');
    return `${prefix}${formattedK}k${suffix}`;
  }

  const hasCents = money.amountMinor % 100n !== 0n;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(majorValue);

  return `${prefix}${formatted}${suffix}`;
}

/**
 * Parse an amount typed in a form ("4,500" or "4500.50") into minor units without floats.
 * Returns null when the text is not a plain non-negative amount with at most two decimals.
 */
export function parseMoneyInput(text: string): bigint | null {
  const cleaned = text.trim().replace(/,/g, '');
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = BigInt(match[1] ?? '0');
  const cents = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * 100n + cents;
}

/** Minor units back to the plain text a form field shows ("4500" or "4500.50"). */
export function moneyInputValue(amountMinor: bigint | string): string {
  const minor = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor || '0');
  const whole = minor / 100n;
  const cents = minor % 100n;
  return cents === 0n
    ? whole.toString()
    : `${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Format date as "4 Nov 2026" in the given IANA time zone (DESIGN.md §10).
 */
export function formatDate(dateInput: Date | string, timeZone = 'UTC'): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).formatToParts(date);

  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${day} ${month} ${year}`.trim();
}

/**
 * Format time as "9:30 am" in the given IANA time zone (DESIGN.md §10).
 */
export function formatTime(dateInput: Date | string, timeZone = 'UTC'): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const formatted = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(date);
  return formatted.toLowerCase();
}

/**
 * Format date and time as "4 Nov 2026, 9:30 am" in the given IANA time zone.
 */
export function formatDateTime(dateInput: Date | string, timeZone = 'UTC'): string {
  return `${formatDate(dateInput, timeZone)}, ${formatTime(dateInput, timeZone)}`;
}

/**
 * Format relative time for the last 7 days ("2 h ago", "Yesterday"), falling back to "4 Nov 2026" (DESIGN.md §10).
 */
export function formatRelative(
  dateInput: Date | string,
  nowInput: Date | string = new Date(),
  timeZone = 'UTC',
): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = typeof nowInput === 'string' ? new Date(nowInput) : nowInput;
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) {
    return 'Just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} h ago`;
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays} d ago`;
  }
  return formatDate(date, timeZone);
}

/**
 * Format record name with company middot: "Jane Patel · Acme CPA" (DESIGN.md §10).
 */
export function formatPersonWithCompany(fullName: string, companyName?: string | null): string {
  if (!companyName) {
    return fullName;
  }
  return `${fullName} · ${companyName}`;
}

export { MONTH_SHORT };
