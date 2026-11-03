import type { Market } from '@adas/shared';

/**
 * PRD §4.12 — Send window & business-day calendar math.
 * Default send window: Monday–Friday, 08:30–17:00 in recipient's local time zone,
 * excluding U.S. federal and Canadian statutory holidays.
 */
export const US_HOLIDAYS_MMDD = new Set([
  '01-01', // New Year's Day
  '07-04', // Independence Day
  '11-11', // Veterans Day
  '12-25', // Christmas Day
]);

export const CA_HOLIDAYS_MMDD = new Set([
  '01-01', // New Year's Day
  '07-01', // Canada Day
  '11-11', // Remembrance Day
  '12-25', // Christmas Day
  '12-26', // Boxing Day
]);

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: string; // 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
  hour: number;
  minute: number;
}

export function getLocalParts(utcDate: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(utcDate);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  const rawHour = Number(map['hour'] ?? '0');
  return {
    year: Number(map['year'] ?? '2026'),
    month: Number(map['month'] ?? '1'),
    day: Number(map['day'] ?? '1'),
    weekday: map['weekday'] ?? 'Mon',
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map['minute'] ?? '0'),
  };
}

export function isPublicHoliday(utcDate: Date, timeZone: string, market: Market): boolean {
  const parts = getLocalParts(utcDate, timeZone);
  const mmdd = `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  if (market === 'CA') {
    return CA_HOLIDAYS_MMDD.has(mmdd);
  }
  return US_HOLIDAYS_MMDD.has(mmdd);
}

export function isBusinessDay(utcDate: Date, timeZone: string, market: Market): boolean {
  const parts = getLocalParts(utcDate, timeZone);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
    return false;
  }
  return !isPublicHoliday(utcDate, timeZone, market);
}

/**
 * Checks whether `utcDate` falls inside the recipient's local send window (default 08:30–17:00 Mon–Fri).
 */
export function isWithinSendWindow(
  utcDate: Date,
  timeZone: string,
  market: Market = 'US',
  windowStartMinutes = 8 * 60 + 30,
  windowEndMinutes = 17 * 60,
): boolean {
  if (!isBusinessDay(utcDate, timeZone, market)) {
    return false;
  }
  const parts = getLocalParts(utcDate, timeZone);
  const minutesOfDay = parts.hour * 60 + parts.minute;
  return minutesOfDay >= windowStartMinutes && minutesOfDay < windowEndMinutes;
}

/**
 * Adds N business days in the recipient's time zone and market calendar.
 */
export function addBusinessDays(
  startUtc: Date,
  businessDays: number,
  timeZone: string,
  market: Market = 'US',
): Date {
  let cursor = new Date(startUtc.getTime());
  let remaining = Math.max(0, Math.trunc(businessDays));

  if (remaining === 0) {
    while (!isBusinessDay(cursor, timeZone, market)) {
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return cursor;
  }

  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (isBusinessDay(cursor, timeZone, market)) {
      remaining -= 1;
    }
  }
  return cursor;
}
