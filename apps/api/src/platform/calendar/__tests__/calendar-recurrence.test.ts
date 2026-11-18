import { describe, expect, it } from 'vitest';
import { formatFxRateScaled, parseFxRateScaled } from '@adas/shared';
import { getLocalParts, nextRecurringDueAt } from '../index.js';

describe('nextRecurringDueAt & integer FX rate scaling', () => {
  it('advances daily, weekly and biweekly while preserving local wall-clock across DST', () => {
    // 2026-03-06 14:30 UTC is 09:30 EST; US DST springs forward on 2026-03-08.
    const beforeDst = new Date('2026-03-06T14:30:00.000Z');
    const nextWeek = nextRecurringDueAt(beforeDst, 'weekly', 'America/New_York', 'US', beforeDst);
    const parts = getLocalParts(nextWeek, 'America/New_York');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(3);
    expect(parts.day).toBe(13);
    // Wall clock stays 09:30 local time (now EDT = 13:30 UTC).
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(30);
    expect(nextWeek.toISOString()).toBe('2026-03-13T13:30:00.000Z');

    const biweekly = nextRecurringDueAt(beforeDst, 'biweekly', 'America/New_York', 'US', beforeDst);
    expect(biweekly.toISOString()).toBe('2026-03-20T13:30:00.000Z');

    const satBeforeDst = new Date('2026-03-07T14:30:00.000Z');
    const dailyAcrossSpringForward = nextRecurringDueAt(
      satBeforeDst,
      'daily',
      'America/New_York',
      'US',
      satBeforeDst,
    );
    expect(dailyAcrossSpringForward.toISOString()).toBe('2026-03-08T13:30:00.000Z');
  });

  it('advances business_days skipping weekends, market holidays, and overdue backlogs', () => {
    // Friday 2026-11-06 15:00 UTC -> skips weekend -> Monday 2026-11-09
    const fri = new Date('2026-11-06T15:00:00.000Z');
    const nextMon = nextRecurringDueAt(fri, 'business_days', 'America/New_York', 'US', fri);
    const monParts = getLocalParts(nextMon, 'America/New_York');
    expect(`${monParts.year}-${monParts.month}-${monParts.day}`).toBe('2026-11-9');
    expect(monParts.hour).toBe(10);
    expect(monParts.minute).toBe(0);

    // Tuesday 2026-11-10 -> Wednesday 2026-11-11 is US Veterans Day -> Thursday 2026-11-12
    const tue = new Date('2026-11-10T15:00:00.000Z');
    const nextThu = nextRecurringDueAt(tue, 'business_days', 'America/New_York', 'US', tue);
    const thuParts = getLocalParts(nextThu, 'America/New_York');
    expect(`${thuParts.year}-${thuParts.month}-${thuParts.day}`).toBe('2026-11-12');
    expect(thuParts.hour).toBe(10);

    // Long-overdue task due 2026-03-06 completed on 2026-11-18 advances from completion date
    const overdueNext = nextRecurringDueAt(
      new Date('2026-03-06T15:00:00.000Z'),
      'daily',
      'America/New_York',
      'US',
      new Date('2026-11-18T16:00:00.000Z'),
    );
    const overdueParts = getLocalParts(overdueNext, 'America/New_York');
    expect(`${overdueParts.year}-${overdueParts.month}-${overdueParts.day}`).toBe('2026-11-19');
    expect(overdueParts.hour).toBe(10);
  });

  it('clamps monthly recurrence to the end of shorter months', () => {
    const jan31 = new Date('2026-01-31T16:15:00.000Z');
    const feb = nextRecurringDueAt(jan31, 'monthly', 'America/Toronto', 'CA', jan31);
    const parts = getLocalParts(feb, 'America/Toronto');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(2);
    expect(parts.day).toBe(28);
    expect(parts.hour).toBe(11);
    expect(parts.minute).toBe(15);
  });

  it('parses and formats 10^6 integer FX rates without floating-point drift', () => {
    expect(parseFxRateScaled('0.74')).toBe(740_000n);
    expect(parseFxRateScaled('1.351351')).toBe(1_351_351n);
    expect(parseFxRateScaled('0')).toBeNull();
    expect(parseFxRateScaled('-1.2')).toBeNull();
    expect(parseFxRateScaled('1.1234567')).toBeNull();

    expect(formatFxRateScaled('740000')).toBe('0.7400');
    expect(formatFxRateScaled(1_351_351n)).toBe('1.351351');
    expect(formatFxRateScaled(1_000_000n)).toBe('1.0000');
  });
});
