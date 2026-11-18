import type { Market, RecurrenceRule } from '@adas/shared';

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
 * Resolve a local wall-clock `(year, month, day, hour, minute)` in `timeZone` back to a UTC `Date`
 * so recurring tasks keep their local wall-clock time across DST changes.
 */
export function localToUtc(
  target: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const guessMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let candidate = new Date(guessMs);
  for (let i = 0; i < 3; i += 1) {
    const actual = getLocalParts(candidate, timeZone);
    const desiredWall = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      target.hour,
      target.minute,
    );
    const actualWall = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const diff = desiredWall - actualWall;
    if (diff === 0) break;
    candidate = new Date(candidate.getTime() + diff);
  }
  return candidate;
}

/**
 * Adds N business days in the recipient's time zone and market calendar, preserving local time.
 */
export function addBusinessDays(
  startUtc: Date,
  businessDays: number,
  timeZone: string,
  market: Market = 'US',
): Date {
  const safeTz = (() => {
    try {
      getLocalParts(startUtc, timeZone);
      return timeZone;
    } catch {
      return 'UTC';
    }
  })();
  const initialLocal = getLocalParts(startUtc, safeTz);
  let cursor = new Date(startUtc.getTime());
  let remaining = Math.max(0, Math.trunc(businessDays));

  if (remaining === 0) {
    while (!isBusinessDay(cursor, safeTz, market)) {
      const p = getLocalParts(cursor, safeTz);
      const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
      cursor = localToUtc(
        {
          year: nextDay.getUTCFullYear(),
          month: nextDay.getUTCMonth() + 1,
          day: nextDay.getUTCDate(),
          hour: initialLocal.hour,
          minute: initialLocal.minute,
        },
        safeTz,
      );
    }
    return cursor;
  }

  while (remaining > 0) {
    const p = getLocalParts(cursor, safeTz);
    const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    cursor = localToUtc(
      {
        year: nextDay.getUTCFullYear(),
        month: nextDay.getUTCMonth() + 1,
        day: nextDay.getUTCDate(),
        hour: initialLocal.hour,
        minute: initialLocal.minute,
      },
      safeTz,
    );
    if (isBusinessDay(cursor, safeTz, market)) {
      remaining -= 1;
    }
  }
  return cursor;
}

/**
 * Computes the next due instant for a recurring task (PRD 4.7), anchored to the later of the
 * task's scheduled due date or completion date so long-overdue tasks advance into the future.
 */
export function nextRecurringDueAt(
  dueUtc: Date,
  rule: RecurrenceRule,
  timeZone: string,
  market: Market = 'US',
  nowUtc: Date = new Date(),
): Date {
  const safeTz = (() => {
    try {
      getLocalParts(dueUtc, timeZone);
      return timeZone;
    } catch {
      return 'UTC';
    }
  })();

  // Keep the user's scheduled wall-clock hour:minute from dueUtc, advancing from max(dueUtc, nowUtc).
  const dueLocal = getLocalParts(dueUtc, safeTz);
  const baseDate = dueUtc.getTime() >= nowUtc.getTime() ? dueUtc : nowUtc;
  const baseLocal = getLocalParts(baseDate, safeTz);
  const anchor = localToUtc(
    {
      year: baseLocal.year,
      month: baseLocal.month,
      day: baseLocal.day,
      hour: dueLocal.hour,
      minute: dueLocal.minute,
    },
    safeTz,
  );

  if (rule === 'business_days') {
    return addBusinessDays(anchor, 1, safeTz, market);
  }

  if (rule === 'monthly') {
    const totalMonths = baseLocal.year * 12 + (baseLocal.month - 1) + 1;
    const nextYear = Math.floor(totalMonths / 12);
    const nextMonth = (totalMonths % 12) + 1;
    const daysInTargetMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
    const clampedDay = Math.min(dueLocal.day, daysInTargetMonth);
    return localToUtc(
      {
        year: nextYear,
        month: nextMonth,
        day: clampedDay,
        hour: dueLocal.hour,
        minute: dueLocal.minute,
      },
      safeTz,
    );
  }

  const daysToAdd = rule === 'daily' ? 1 : rule === 'weekly' ? 7 : 14;
  const shifted = new Date(
    Date.UTC(baseLocal.year, baseLocal.month - 1, baseLocal.day + daysToAdd),
  );
  return localToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: dueLocal.hour,
      minute: dueLocal.minute,
    },
    safeTz,
  );
}
