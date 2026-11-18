import { describe, expect, it } from 'vitest';
import { SCORING_FIELD_PATHS, type ScoringRuleView } from '@adas/shared';
import { evaluateRules } from '../scoring.js';

const BASE_SIGNALS = {
  staffBand: '11–20',
  title: 'Managing Partner',
  market: 'US',
  source: 'Website — Free Trial',
  softwareStack: ['UltraTax', 'QuickBooks Online'],
  servicesNeeded: ['Tax preparation and review'],
  hasCallOrMeeting: false,
  missingDomain: false,
};

function makeRule(overrides: Partial<ScoringRuleView> & { id: string }): ScoringRuleView {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    category: overrides.category ?? 'fit',
    fieldPath: overrides.fieldPath ?? 'staffBand',
    operator: overrides.operator ?? 'eq',
    targetValue: overrides.targetValue ?? '11–20',
    points: overrides.points ?? 10,
    active: overrides.active ?? true,
    version: 1,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
  };
}

describe('Lead & contact scoring evaluation (PRD 4.5, 4.16)', () => {
  it('combines fit, engagement and negative rules and explains every matched rule', () => {
    const rules: ScoringRuleView[] = [
      makeRule({
        id: 'r_band',
        name: 'CPA firm size',
        category: 'fit',
        fieldPath: 'staffBand',
        operator: 'in',
        targetValue: ['11–20', '21–50'],
        points: 20,
      }),
      makeRule({
        id: 'r_title',
        name: 'Partner decision-maker',
        category: 'fit',
        fieldPath: 'title',
        operator: 'contains',
        targetValue: 'partner',
        points: 20,
      }),
      makeRule({
        id: 'r_sw',
        name: 'Tax software match',
        category: 'fit',
        fieldPath: 'softwareStack',
        operator: 'in',
        targetValue: ['UltraTax', 'CCH Axcess'],
        points: 15,
      }),
      makeRule({
        id: 'r_call',
        name: 'Call or meeting logged',
        category: 'engagement',
        fieldPath: 'hasCallOrMeeting',
        operator: 'isTrue',
        targetValue: true,
        points: 20,
      }),
      makeRule({
        id: 'r_nodomain',
        name: 'Missing corporate domain',
        category: 'negative',
        fieldPath: 'missingDomain',
        operator: 'isTrue',
        targetValue: true,
        points: -15,
      }),
      makeRule({
        id: 'r_paused',
        name: 'Paused rule',
        category: 'fit',
        fieldPath: 'market',
        operator: 'eq',
        targetValue: 'US',
        points: 50,
        active: false,
      }),
    ];

    const initial = evaluateRules(rules, BASE_SIGNALS);
    expect(initial.score).toBe(55);
    expect(initial.breakdown.map((b) => b.ruleId)).toEqual(['r_band', 'r_title', 'r_sw']);

    const afterCallAndFreemail = evaluateRules(rules, {
      ...BASE_SIGNALS,
      hasCallOrMeeting: true,
      missingDomain: true,
    });
    expect(afterCallAndFreemail.score).toBe(60);
    expect(afterCallAndFreemail.breakdown.map((b) => b.ruleId)).toEqual([
      'r_band',
      'r_title',
      'r_sw',
      'r_call',
      'r_nodomain',
    ]);
  });

  it('clamps scores strictly to [0, 100] and never exposes email open signals', () => {
    expect(SCORING_FIELD_PATHS).not.toContain('emailOpened');
    expect(SCORING_FIELD_PATHS).not.toContain('openCount');

    const high = evaluateRules(
      [
        makeRule({ id: 'r1', fieldPath: 'market', operator: 'eq', targetValue: 'US', points: 75 }),
        makeRule({
          id: 'r2',
          fieldPath: 'title',
          operator: 'contains',
          targetValue: 'Partner',
          points: 65,
        }),
      ],
      BASE_SIGNALS,
    );
    expect(high.score).toBe(100);

    const low = evaluateRules(
      [
        makeRule({
          id: 'r_neg',
          category: 'negative',
          fieldPath: 'missingDomain',
          operator: 'isTrue',
          targetValue: true,
          points: -40,
        }),
      ],
      { ...BASE_SIGNALS, missingDomain: true },
    );
    expect(low.score).toBe(0);
  });
});
