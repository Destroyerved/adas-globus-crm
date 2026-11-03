import { describe, expect, it } from 'vitest';
import {
  CapabilityKeySchema,
  FilterClauseSchema,
  formatCount,
  formatDate,
  formatMoney,
  formatNumber,
  formatPersonWithCompany,
  formatRelative,
  formatTime,
  MarketSchema,
  MoneyWireSchema,
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
});
