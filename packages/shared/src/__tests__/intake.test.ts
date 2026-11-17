import { describe, expect, it } from 'vitest';
import {
  InquiryListQuerySchema,
  PublicInquiryAckSchema,
  UpdateRoutingRuleInputSchema,
  WebsiteInquiryPayloadSchema,
} from '../index.js';

describe('Intake & Routing Schemas (PRD 4.10, 4.17, 15 Q13)', () => {
  it('validates round_robin and named_owner routing rule updates', () => {
    expect(
      UpdateRoutingRuleInputSchema.parse({
        version: 1,
        mode: 'round_robin',
        teamId: 'team_us',
      }),
    ).toMatchObject({ mode: 'round_robin', teamId: 'team_us' });

    expect(
      UpdateRoutingRuleInputSchema.parse({
        version: 2,
        mode: 'named_owner',
        ownerUserId: 'usr_mgr_1',
      }),
    ).toMatchObject({ mode: 'named_owner', ownerUserId: 'usr_mgr_1' });

    expect(
      UpdateRoutingRuleInputSchema.safeParse({
        version: 1,
        mode: 'round_robin',
        teamId: null,
      }).success,
    ).toBe(false);

    expect(
      UpdateRoutingRuleInputSchema.safeParse({
        version: 1,
        mode: 'named_owner',
        ownerUserId: '',
      }).success,
    ).toBe(false);
  });

  it('parses inquiry list query parameters and public ack contract', () => {
    const parsed = InquiryListQuerySchema.parse({ limit: '25', market: 'CA', formType: 'trial' });
    expect(parsed).toEqual({ limit: 25, market: 'CA', formType: 'trial' });
    expect(PublicInquiryAckSchema.parse({ status: 'received' })).toEqual({ status: 'received' });
  });

  it('accepts optional form alias on WebsiteInquiryPayloadSchema', () => {
    const parsed = WebsiteInquiryPayloadSchema.parse({
      name: 'Taylor CPA',
      email: 'taylor@mapleleaf.example.ca',
      form: 'contact',
      location: 'Ontario',
    });
    expect(parsed.form).toBe('contact');
  });
});
