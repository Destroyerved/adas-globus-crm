import { z } from 'zod';

export const MarketSchema = z.enum(['US', 'CA', 'OTHER']);
export type Market = z.infer<typeof MarketSchema>;

export const CurrencySchema = z.enum(['USD', 'CAD']);
export type Currency = z.infer<typeof CurrencySchema>;

export const ScopeSchema = z.enum(['own', 'team', 'all']);
export type Scope = z.infer<typeof ScopeSchema>;

export const LeadStatusCategorySchema = z.enum(['open', 'qualified', 'closed']);
export type LeadStatusCategory = z.infer<typeof LeadStatusCategorySchema>;

export const LeadSystemStatusSchema = z.enum([
  'New',
  'Researching',
  'Contacted',
  'Engaged',
  'Qualified',
  'Disqualified',
  'Converted',
]);
export type LeadSystemStatus = z.infer<typeof LeadSystemStatusSchema>;

export const DealStageCategorySchema = z.enum(['open', 'won', 'lost']);
export type DealStageCategory = z.infer<typeof DealStageCategorySchema>;

export const AccountStatusSchema = z.enum([
  'prospect',
  'client',
  'former_client',
  'partner',
  'do_not_contact',
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const EmailVerificationStatusSchema = z.enum(['unknown', 'valid', 'risky', 'invalid']);
export type EmailVerificationStatus = z.infer<typeof EmailVerificationStatusSchema>;

export const ConsentBasisSchema = z.enum([
  'express',
  'implied_inquiry',
  'implied_ebr',
  'implied_published',
  'legitimate_interest_b2b',
]);
export type ConsentBasis = z.infer<typeof ConsentBasisSchema>;

export const StatusToneSchema = z.enum([
  'neutral',
  'info',
  'brand',
  'success',
  'warning',
  'danger',
]);
export type StatusTone = z.infer<typeof StatusToneSchema>;

export const MoneyWireSchema = z.object({
  amountMinor: z.string().regex(/^\d+$/, 'amountMinor must be a non-negative integer string'),
  currency: CurrencySchema,
});
export type MoneyWire = z.infer<typeof MoneyWireSchema>;

export interface Money {
  amountMinor: bigint;
  currency: Currency;
}
