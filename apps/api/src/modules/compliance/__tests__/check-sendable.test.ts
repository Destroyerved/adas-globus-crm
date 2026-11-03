import { describe, expect, it } from 'vitest';
import { addBusinessDays, isWithinSendWindow } from '../../../platform/calendar/index.js';
import {
  convertCurrencyMinor,
  parseMoneyWire,
  toMoneyWire,
} from '../../../platform/money/index.js';
import { checkSendable, MARKET_COMPLIANCE_RULES } from '../index.js';

describe('Compliance gate checkSendable() & Market Rules (PRD §5.1, §5.2, A12)', () => {
  const baseValidInput = {
    email: 'partner@acmecpa.example.com',
    channel: 'sequence' as const,
    market: 'US' as const,
    contactDoNotContact: false,
    companyAccountStatus: 'prospect' as const,
    emailVerificationStatus: 'valid' as const,
    hardBounced: false,
    suppressedEmail: false,
    suppressedDomain: false,
    consent: null,
    sendsInLast7Days: 0,
    maxSendsPer7Days: 3,
    mailboxSendsToday: 5,
    mailboxDailyCap: 50,
    withinSendWindow: true,
    bypassSendWindow: false,
    nowIso: '2026-11-04T15:00:00.000Z',
  };

  it('defines market compliance rules as data (US CAN-SPAM, CA CASL, OTHER)', () => {
    expect(MARKET_COMPLIANCE_RULES.US.requiresPriorConsentForColdOutreach).toBe(false);
    expect(MARKET_COMPLIANCE_RULES.CA.requiresPriorConsentForColdOutreach).toBe(true);
    expect(MARKET_COMPLIANCE_RULES.CA.impliedInquiryMonths).toBe(6);
    expect(MARKET_COMPLIANCE_RULES.CA.impliedEbrMonths).toBe(24);
    expect(MARKET_COMPLIANCE_RULES.OTHER.allowedBases).toEqual(['express']);
  });

  it('returns OK for eligible US B2B prospect within send window', () => {
    const res = checkSendable(baseValidInput);
    expect(res.sendable).toBe(true);
    expect(res.reasonCode).toBe('OK');
  });

  it('returns INVALID_EMAIL for malformed email or invalid verification status', () => {
    expect(checkSendable({ ...baseValidInput, email: 'not-an-email' }).reasonCode).toBe(
      'INVALID_EMAIL',
    );
    expect(
      checkSendable({ ...baseValidInput, emailVerificationStatus: 'invalid' }).reasonCode,
    ).toBe('INVALID_EMAIL');
  });

  it('returns SUPPRESSED_EMAIL when email is on global suppression list', () => {
    const res = checkSendable({ ...baseValidInput, suppressedEmail: true });
    expect(res.sendable).toBe(false);
    expect(res.reasonCode).toBe('SUPPRESSED_EMAIL');
  });

  it('returns SUPPRESSED_DOMAIN when domain is on suppressed domains list', () => {
    const res = checkSendable({ ...baseValidInput, suppressedDomain: true });
    expect(res.sendable).toBe(false);
    expect(res.reasonCode).toBe('SUPPRESSED_DOMAIN');
  });

  it('returns HARD_BOUNCED when recipient previously hard-bounced', () => {
    const res = checkSendable({ ...baseValidInput, hardBounced: true });
    expect(res.sendable).toBe(false);
    expect(res.reasonCode).toBe('HARD_BOUNCED');
  });

  it('returns DO_NOT_CONTACT when contact or company is flagged DNC', () => {
    expect(checkSendable({ ...baseValidInput, contactDoNotContact: true }).reasonCode).toBe(
      'DO_NOT_CONTACT',
    );
    expect(
      checkSendable({ ...baseValidInput, companyAccountStatus: 'do_not_contact' }).reasonCode,
    ).toBe('DO_NOT_CONTACT');
  });

  it('returns CONSENT_REVOKED when consent status is revoked', () => {
    const res = checkSendable({
      ...baseValidInput,
      consent: { basis: 'express', status: 'revoked' },
    });
    expect(res.sendable).toBe(false);
    expect(res.reasonCode).toBe('CONSENT_REVOKED');
  });

  it('returns CONSENT_EXPIRED when CASL implied consent is expired or past expiresAt', () => {
    expect(
      checkSendable({
        ...baseValidInput,
        market: 'CA',
        consent: { basis: 'implied_inquiry', status: 'expired' },
      }).reasonCode,
    ).toBe('CONSENT_EXPIRED');

    expect(
      checkSendable({
        ...baseValidInput,
        market: 'CA',
        consent: {
          basis: 'implied_inquiry',
          status: 'active',
          expiresAt: '2026-10-01T00:00:00.000Z',
        },
      }).reasonCode,
    ).toBe('CONSENT_EXPIRED');
  });

  it('enforces Canada CASL lawful basis (blocks CA without consent or with legitimate_interest_b2b)', () => {
    expect(
      checkSendable({
        ...baseValidInput,
        market: 'CA',
        consent: null,
      }).reasonCode,
    ).toBe('NO_LAWFUL_BASIS');

    expect(
      checkSendable({
        ...baseValidInput,
        market: 'CA',
        consent: { basis: 'legitimate_interest_b2b', status: 'active' },
      }).reasonCode,
    ).toBe('NO_LAWFUL_BASIS');

    expect(
      checkSendable({
        ...baseValidInput,
        market: 'CA',
        consent: {
          basis: 'implied_inquiry',
          status: 'active',
          expiresAt: '2027-03-01T00:00:00.000Z',
        },
      }).reasonCode,
    ).toBe('OK');
  });

  it('returns MARKET_BLOCKED for OTHER market without express opt-in consent', () => {
    expect(
      checkSendable({
        ...baseValidInput,
        market: 'OTHER',
        consent: null,
      }).reasonCode,
    ).toBe('MARKET_BLOCKED');

    expect(
      checkSendable({
        ...baseValidInput,
        market: 'OTHER',
        consent: { basis: 'express', status: 'active' },
      }).reasonCode,
    ).toBe('OK');
  });

  it('returns FREQUENCY_CAP when recipient reached 7-day outreach cap', () => {
    const res = checkSendable({
      ...baseValidInput,
      sendsInLast7Days: 3,
      maxSendsPer7Days: 3,
    });
    expect(res.sendable).toBe(false);
    expect(res.reasonCode).toBe('FREQUENCY_CAP');
  });

  it('returns MAILBOX_DAILY_CAP when sender mailbox reached daily cap', () => {
    const res = checkSendable({
      ...baseValidInput,
      mailboxSendsToday: 50,
      mailboxDailyCap: 50,
    });
    expect(res.sendable).toBe(false);
    expect(res.reasonCode).toBe('MAILBOX_DAILY_CAP');
  });

  it('returns OUTSIDE_SEND_WINDOW when outside recipient business hours and not bypassed', () => {
    const res = checkSendable({
      ...baseValidInput,
      withinSendWindow: false,
      bypassSendWindow: false,
    });
    expect(res.sendable).toBe(false);
    expect(res.reasonCode).toBe('OUTSIDE_SEND_WINDOW');
  });
});

describe('Platform Calendar & Money helpers (PRD §4.12, §4.15)', () => {
  it('checks recipient local send window (08:30–17:00 Mon–Fri excluding holidays)', () => {
    // Wednesday 2026-11-04 15:00 UTC is 10:00 AM EST in New York -> inside window
    expect(isWithinSendWindow(new Date('2026-11-04T15:00:00Z'), 'America/New_York', 'US')).toBe(
      true,
    );

    // Wednesday 2026-11-04 04:00 UTC is 11:00 PM Tue EST in New York -> outside window
    expect(isWithinSendWindow(new Date('2026-11-04T04:00:00Z'), 'America/New_York', 'US')).toBe(
      false,
    );

    // Sunday 2026-11-08 15:00 UTC -> weekend -> outside window
    expect(isWithinSendWindow(new Date('2026-11-08T15:00:00Z'), 'America/New_York', 'US')).toBe(
      false,
    );

    // Canada Day 2026-07-01 15:00 UTC -> Canadian holiday -> outside window for CA
    expect(isWithinSendWindow(new Date('2026-07-01T15:00:00Z'), 'America/Toronto', 'CA')).toBe(
      false,
    );
  });

  it('adds business days skipping weekends', () => {
    // Friday 2026-11-06 + 1 business day -> Monday 2026-11-09
    const next = addBusinessDays(new Date('2026-11-06T15:00:00Z'), 1, 'America/New_York', 'US');
    expect(next.toISOString().slice(0, 10)).toBe('2026-11-09');
  });

  it('converts minor currency units using integer scaled FX rates without floats', () => {
    const cadMoney = parseMoneyWire({ amountMinor: '620000', currency: 'CAD' });
    const usdMinor = convertCurrencyMinor(cadMoney.amountMinor, 'CAD', 'USD', 740_000n);
    expect(usdMinor).toBe(458_800n);
    expect(toMoneyWire({ amountMinor: usdMinor, currency: 'USD' })).toEqual({
      amountMinor: '458800',
      currency: 'USD',
    });
  });
});
