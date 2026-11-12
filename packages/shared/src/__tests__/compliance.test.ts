import { describe, expect, it } from 'vitest';
import {
  AddSuppressedDomainInputSchema,
  AddSuppressionInputSchema,
  LiftSuppressionInputSchema,
  PrivacyEraseInputSchema,
  RecordConsentInputSchema,
  deriveMarketingBasis,
} from '../index.js';

describe('compliance schemas and derived marketing basis (PRD 4.18, 5.1–5.5)', () => {
  it('derives US B2B outreach basis for an unsuppressed US contact without explicit consent', () => {
    const res = deriveMarketingBasis({
      market: 'US',
      suppressed: false,
      doNotContact: false,
      hardBounced: false,
    });
    expect(res.kind).toBe('us_b2b');
    expect(res.label).toBe('US B2B outreach only');
    expect(res.tone).toBe('brand');
  });

  it('requires active consent for Canadian and OTHER contacts', () => {
    const caNone = deriveMarketingBasis({
      market: 'CA',
      suppressed: false,
      doNotContact: false,
      hardBounced: false,
    });
    expect(caNone.kind).toBe('none');
    expect(caNone.label).toBe('None');

    const caImplied = deriveMarketingBasis({
      market: 'CA',
      suppressed: false,
      doNotContact: false,
      hardBounced: false,
      consent: {
        basis: 'implied_ebr',
        status: 'active',
        expiresAt: '2028-11-12T00:00:00.000Z',
      },
      nowMs: Date.parse('2026-11-12T00:00:00.000Z'),
    });
    expect(caImplied.kind).toBe('implied');
    expect(caImplied.label).toBe('Implied');
    expect(caImplied.expiresAt).toBe('2028-11-12T00:00:00.000Z');
  });

  it('drops expired implied consent back to None in Canada and US B2B in the US', () => {
    const nowMs = Date.parse('2026-11-12T00:00:00.000Z');
    const expiredCa = deriveMarketingBasis({
      market: 'CA',
      suppressed: false,
      doNotContact: false,
      hardBounced: false,
      consent: {
        basis: 'implied_inquiry',
        status: 'active',
        expiresAt: '2026-10-01T00:00:00.000Z',
      },
      nowMs,
    });
    expect(expiredCa.kind).toBe('none');
    expect(expiredCa.detail).toContain('expired');

    const expiredUs = deriveMarketingBasis({
      market: 'US',
      suppressed: false,
      doNotContact: false,
      hardBounced: false,
      consent: {
        basis: 'implied_inquiry',
        status: 'active',
        expiresAt: '2026-10-01T00:00:00.000Z',
      },
      nowMs,
    });
    expect(expiredUs.kind).toBe('us_b2b');
  });

  it('treats suppression, bounce, do-not-contact and revoked consent as None', () => {
    expect(
      deriveMarketingBasis({
        market: 'US',
        suppressed: true,
        doNotContact: false,
        hardBounced: false,
        consent: { basis: 'express', status: 'active' },
      }).kind,
    ).toBe('none');

    expect(
      deriveMarketingBasis({
        market: 'US',
        suppressed: false,
        doNotContact: false,
        hardBounced: false,
        consent: { basis: 'express', status: 'revoked' },
      }).kind,
    ).toBe('none');
  });

  it('validates suppression, domain, consent and erasure inputs cleanly', () => {
    expect(
      AddSuppressionInputSchema.parse({
        email: '  Partner@Firm-Example.com ',
        reason: 'manual_dnc',
      }).email,
    ).toBe('partner@firm-example.com');

    expect(LiftSuppressionInputSchema.safeParse({ reason: 'ok' }).success).toBe(false);
    expect(LiftSuppressionInputSchema.safeParse({ reason: 'Written confirmation' }).success).toBe(
      true,
    );
    expect(
      AddSuppressedDomainInputSchema.safeParse({ domain: 'example.com', reason: 'Opt-out' })
        .success,
    ).toBe(true);
    expect(
      RecordConsentInputSchema.safeParse({
        basis: 'express',
        source: 'Website opt-in checkbox',
      }).success,
    ).toBe(true);
    expect(PrivacyEraseInputSchema.safeParse({ reason: 'ab' }).success).toBe(false);
  });
});
