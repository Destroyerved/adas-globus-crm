import { describe, expect, it } from 'vitest';
import {
  BreakGlassLoginInputSchema,
  calendarDateInZone,
  dashboardPresetRange,
  CapabilityKeySchema,
  ConvertLeadInputSchema,
  FilterClauseSchema,
  formatCount,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatMinutes,
  formatPersonWithCompany,
  formatRelative,
  formatTime,
  MarketSchema,
  moneyInputValue,
  MoneyWireSchema,
  parseMoneyInput,
  SendableReasonCodeSchema,
  WebsiteInquiryPayloadSchema,
} from '../index.js';

describe('@adas/shared schemas and formatting', () => {
  it('validates market and capability keys', () => {
    expect(MarketSchema.parse('US')).toBe('US');
    expect(MarketSchema.parse('CA')).toBe('CA');
    expect(CapabilityKeySchema.parse('leads.read')).toBe('leads.read');
    expect(() => MarketSchema.parse('UK')).toThrow();
  });

  it('validates filter-language nested clauses (PRD §6.8)', () => {
    const query = {
      and: [
        { field: 'company.market', op: 'eq', value: 'US' },
        {
          or: [
            { field: 'tags', op: 'hasAny', value: ['tax-season-2027'] },
            { field: 'lastContactedAt', op: 'before', value: { relative: '-90d' } },
          ],
        },
      ],
    };
    expect(FilterClauseSchema.parse(query)).toEqual(query);
  });

  it('validates money wire format as integer string minor units', () => {
    expect(MoneyWireSchema.parse({ amountMinor: '1250000', currency: 'USD' })).toEqual({
      amountMinor: '1250000',
      currency: 'USD',
    });
    expect(() => MoneyWireSchema.parse({ amountMinor: '125.50', currency: 'USD' })).toThrow();
  });

  it('formats numbers with Western grouping and counts with No <plural> (DESIGN §10)', () => {
    expect(formatNumber(1_250_000)).toBe('1,250,000');
    expect(formatCount(0, 'lead')).toBe('No leads');
    expect(formatCount(1, 'lead')).toBe('1 lead');
    expect(formatCount(12_480, 'lead')).toBe('12,480 leads');
  });

  it('formats money with explicit currency prefix (DESIGN §10)', () => {
    expect(formatMoney({ amountMinor: 1_250_000n, currency: 'USD' })).toBe('US$12,500');
    expect(formatMoney({ amountMinor: 1_250_000n, currency: 'CAD' })).toBe('CA$12,500');
    expect(
      formatMoney({ amountMinor: 450_000n, currency: 'USD' }, { compact: true, perMonth: true }),
    ).toBe('US$4.5k/mo');
  });

  it('formats dates, times, relative timestamps and person names (DESIGN §10)', () => {
    const iso = '2026-11-04T14:30:00Z';
    expect(formatDate(iso, 'UTC')).toBe('4 Nov 2026');
    expect(formatTime(iso, 'America/Toronto')).toBe('9:30 am');
    expect(formatRelative('2026-11-04T12:30:00Z', iso, 'UTC')).toBe('2 h ago');
    expect(formatPersonWithCompany('Jane Patel', 'Acme CPA')).toBe('Jane Patel · Acme CPA');
  });

  it('validates website inquiry payloads and compliance reason codes (PRD §4.10, §5.1)', () => {
    const parsed = WebsiteInquiryPayloadSchema.parse({
      name: 'Jane Patel',
      email: 'jane@acmetax.example.com',
      firm: 'Acme Tax & Advisory LLP',
      website: 'https://acmetax.example.com',
      country: 'US',
      formType: 'trial',
    });
    expect(parsed.formType).toBe('trial');
    expect(SendableReasonCodeSchema.parse('SUPPRESSED_EMAIL')).toBe('SUPPRESSED_EMAIL');
    expect(
      BreakGlassLoginInputSchema.parse({
        email: 'admin@adasglobuspro.example.com',
        password: 'correct-horse-battery-staple',
        totpCode: '123456',
      }).totpCode,
    ).toBe('123456');
    expect(
      ConvertLeadInputSchema.parse({
        leadId: 'lead_1',
        startFreeTrial: true,
      }).startFreeTrial,
    ).toBe(true);
  });
});

describe('money typed in forms', () => {
  it('parses amounts to minor units without floating point', () => {
    expect(parseMoneyInput('4500')).toBe(450000n);
    expect(parseMoneyInput('4,500.5')).toBe(450050n);
    expect(parseMoneyInput(' 0.07 ')).toBe(7n);
    expect(parseMoneyInput('19999999999.99')).toBe(1999999999999n);
  });

  it('refuses negative, malformed or over-precise amounts', () => {
    for (const bad of ['', '-5', '4.555', 'abc', '1e5', '12.']) {
      expect(parseMoneyInput(bad)).toBeNull();
    }
  });

  it('turns minor units back into form text', () => {
    expect(moneyInputValue('450000')).toBe('4500');
    expect(moneyInputValue(450050n)).toBe('4500.50');
    expect(moneyInputValue('7')).toBe('0.07');
  });
});

describe('dashboard number formats', () => {
  it('shows shares as percentages and nothing-to-divide as a dash', () => {
    expect(formatPercent(0.4235)).toBe('42%');
    expect(formatPercent(0.4235, 1)).toBe('42.4%');
    expect(formatPercent(null)).toBe('—');
  });

  it('shows durations in plain units', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(200)).toBe('3 h 20 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(3 * 1440 + 720)).toBe('3.5 days');
    expect(formatMinutes(null)).toBe('—');
  });
});

describe('dashboard periods', () => {
  it('reads today in the viewer time zone', () => {
    const at = new Date('2026-03-01T03:30:00Z');
    expect(calendarDateInZone(at, 'UTC')).toBe('2026-03-01');
    expect(calendarDateInZone(at, 'America/Toronto')).toBe('2026-02-28');
    expect(calendarDateInZone(at, 'Asia/Kolkata')).toBe('2026-03-01');
  });

  it('builds preset ranges from calendar dates', () => {
    expect(dashboardPresetRange('this_month', '2026-03-14')).toEqual({
      from: '2026-03-01',
      to: '2026-03-14',
    });
    expect(dashboardPresetRange('last_month', '2026-03-14')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(dashboardPresetRange('last_month', '2026-01-10')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(dashboardPresetRange('this_quarter', '2026-05-20')).toEqual({
      from: '2026-04-01',
      to: '2026-05-20',
    });
    expect(dashboardPresetRange('last_30_days', '2026-03-01')).toEqual({
      from: '2026-01-31',
      to: '2026-03-01',
    });
    expect(dashboardPresetRange('this_year', '2026-03-14')).toEqual({
      from: '2026-01-01',
      to: '2026-03-14',
    });
  });
});
