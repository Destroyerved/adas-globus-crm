import { describe, expect, it } from 'vitest';
import { computeDeltaChip, previousPeriodRange } from '../reports.js';

describe('previousPeriodRange & computeDeltaChip (PRD 4.2, 4.15, 14; DESIGN 6.7)', () => {
  it('computes the immediately preceding equal-length date range without timezone drift', () => {
    // 18-day month-to-date window -> preceding 18 days in October
    expect(previousPeriodRange('2026-11-01', '2026-11-18')).toEqual({
      from: '2026-10-14',
      to: '2026-10-31',
    });
    // Single-day window -> yesterday
    expect(previousPeriodRange('2026-03-01', '2026-03-01')).toEqual({
      from: '2026-02-28',
      to: '2026-02-28',
    });
    // Full 30-day window
    expect(previousPeriodRange('2026-04-01', '2026-04-30')).toEqual({
      from: '2026-03-02',
      to: '2026-03-31',
    });
  });

  it('computes count, money and percentage-point rate delta chips with invertGood support', () => {
    expect(computeDeltaChip(15, 10, { kind: 'count' })).toEqual({
      direction: 'up',
      text: '+50%',
      tone: 'success',
    });
    expect(computeDeltaChip(8, 10, { kind: 'count' })).toEqual({
      direction: 'down',
      text: '-20%',
      tone: 'danger',
    });
    expect(computeDeltaChip(10, 10, { kind: 'count' })).toEqual({
      direction: 'flat',
      text: '0%',
      tone: 'neutral',
    });

    // Zero baseline
    expect(computeDeltaChip(4, 0, { kind: 'count' })).toEqual({
      direction: 'up',
      text: '+4',
      tone: 'success',
    });
    expect(computeDeltaChip(500_000n, 0n, { kind: 'money' })).toEqual({
      direction: 'up',
      text: 'New',
      tone: 'success',
    });
    expect(computeDeltaChip(0, 0, { kind: 'count' })).toEqual({
      direction: 'flat',
      text: '0%',
      tone: 'neutral',
    });

    // Inverted metrics (e.g. SLA breaches, lost deals, bounce rate)
    expect(computeDeltaChip(5, 2, { kind: 'count', invertGood: true })).toEqual({
      direction: 'up',
      text: '+150%',
      tone: 'danger',
    });
    expect(computeDeltaChip(1, 4, { kind: 'count', invertGood: true })).toEqual({
      direction: 'down',
      text: '-75%',
      tone: 'success',
    });

    // Rate metrics use percentage points (pp)
    expect(computeDeltaChip(0.42, 0.3, { kind: 'rate' })).toEqual({
      direction: 'up',
      text: '+12 pp',
      tone: 'success',
    });
    expect(computeDeltaChip(0.01, 0.04, { kind: 'rate', invertGood: true })).toEqual({
      direction: 'down',
      text: '-3 pp',
      tone: 'success',
    });
    expect(computeDeltaChip(null, 0.25, { kind: 'rate' })).toBeNull();
  });
});
