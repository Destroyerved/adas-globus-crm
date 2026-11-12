import { z } from 'zod';
import {
  type AccountStatus,
  ConsentBasisSchema,
  type ConsentBasis,
  type Market,
  type StatusTone,
} from './enums.js';
import { SuppressionReasonSchema } from './schemas.js';

/**
 * Suppressions, suppressed domains, consent records, derived marketing basis,
 * and privacy operations schemas (PRD 4.17, 4.18, 5.1–5.6).
 */

export const ManualSuppressionReasonSchema = z.enum([
  'manual_dnc',
  'unsubscribe',
  'hard_bounce',
  'complaint',
]);
export type ManualSuppressionReason = z.infer<typeof ManualSuppressionReasonSchema>;

export const AddSuppressionInputSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  reason: ManualSuppressionReasonSchema.default('manual_dnc'),
  source: z.string().trim().min(1).max(120).default('manual_settings'),
  notes: z.string().trim().max(500).optional(),
});
export type AddSuppressionInput = z.infer<typeof AddSuppressionInputSchema>;

export const LiftSuppressionInputSchema = z.object({
  reason: z.string().trim().min(5, 'Enter a short reason for lifting this suppression.').max(500),
});
export type LiftSuppressionInput = z.infer<typeof LiftSuppressionInputSchema>;

export const SuppressionStateFilterSchema = z.enum(['active', 'lifted', 'all']);
export type SuppressionStateFilter = z.infer<typeof SuppressionStateFilterSchema>;

export const SuppressionListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  reason: SuppressionReasonSchema.optional(),
  state: SuppressionStateFilterSchema.default('active'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SuppressionListQuery = z.infer<typeof SuppressionListQuerySchema>;

export const AddSuppressedDomainInputSchema = z.object({
  domain: z.string().trim().min(3, 'Enter a domain such as example.com.').max(253),
  reason: z.string().trim().min(3, 'Enter a short reason.').max(500),
});
export type AddSuppressedDomainInput = z.infer<typeof AddSuppressedDomainInputSchema>;

export const RemoveSuppressedDomainInputSchema = z.object({
  reason: z.string().trim().min(5, 'Enter a short reason for removing this domain block.').max(500),
});
export type RemoveSuppressedDomainInput = z.infer<typeof RemoveSuppressedDomainInputSchema>;

export const ConsentPurposeSchema = z.enum(['marketing', 'outreach']);
export type ConsentPurpose = z.infer<typeof ConsentPurposeSchema>;

export const RecordConsentInputSchema = z.object({
  basis: ConsentBasisSchema,
  purpose: ConsentPurposeSchema.default('marketing'),
  source: z.string().trim().min(2, 'Enter where consent came from.').max(160),
  proofText: z.string().trim().max(2000).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type RecordConsentInput = z.infer<typeof RecordConsentInputSchema>;

export const WithdrawConsentInputSchema = z.object({
  reason: z.string().trim().min(3, 'Enter a short note for the withdrawal.').max(500),
  suppressAddress: z.boolean().default(false),
});
export type WithdrawConsentInput = z.infer<typeof WithdrawConsentInputSchema>;

export const PrivacyEraseInputSchema = z.object({
  reason: z.string().trim().min(5, 'Enter the privacy request reference or reason.').max(500),
});
export type PrivacyEraseInput = z.infer<typeof PrivacyEraseInputSchema>;

export type MarketingBasisKind = 'express' | 'implied' | 'us_b2b' | 'none';

export interface MarketingBasisSummary {
  kind: MarketingBasisKind;
  /** Short label shown on the contact profile (PRD 5.3). */
  label: 'Express' | 'Implied' | 'US B2B outreach only' | 'None';
  expiresAt: string | null;
  detail: string;
  tone: StatusTone;
}

/**
 * Derives a contact's marketing basis from their market, latest consent record,
 * and suppression / do-not-contact state (PRD 5.2, 5.3).
 */
export function deriveMarketingBasis(input: {
  market: Market;
  suppressed: boolean;
  doNotContact: boolean;
  hardBounced: boolean;
  companyAccountStatus?: AccountStatus | string | null;
  consent?: {
    basis: ConsentBasis | string;
    status: 'active' | 'expired' | 'revoked' | string;
    expiresAt?: string | null;
  } | null;
  nowMs?: number;
}): MarketingBasisSummary {
  const nowMs = input.nowMs ?? Date.now();

  if (
    input.suppressed ||
    input.doNotContact ||
    input.hardBounced ||
    input.companyAccountStatus === 'do_not_contact'
  ) {
    return {
      kind: 'none',
      label: 'None',
      expiresAt: null,
      detail: input.suppressed
        ? 'Blocked by suppression'
        : input.hardBounced
          ? 'Address bounced'
          : 'Marked do not contact',
      tone: 'danger',
    };
  }

  const consent = input.consent ?? null;
  if (consent?.status === 'revoked') {
    return {
      kind: 'none',
      label: 'None',
      expiresAt: null,
      detail: 'Consent withdrawn',
      tone: 'warning',
    };
  }

  const expiredByTime = Boolean(consent?.expiresAt && Date.parse(consent.expiresAt) <= nowMs);
  const activeConsent = consent && consent.status === 'active' && !expiredByTime ? consent : null;

  if (activeConsent) {
    if (activeConsent.basis === 'express') {
      return {
        kind: 'express',
        label: 'Express',
        expiresAt: null,
        detail: 'Explicit opt-in recorded',
        tone: 'success',
      };
    }
    if (
      activeConsent.basis === 'implied_inquiry' ||
      activeConsent.basis === 'implied_ebr' ||
      activeConsent.basis === 'implied_published'
    ) {
      return {
        kind: 'implied',
        label: 'Implied',
        expiresAt: activeConsent.expiresAt ?? null,
        detail:
          activeConsent.basis === 'implied_ebr'
            ? 'Client business relationship'
            : activeConsent.basis === 'implied_inquiry'
              ? 'Recent inquiry'
              : 'Published business contact',
        tone: 'info',
      };
    }
    if (activeConsent.basis === 'legitimate_interest_b2b' && input.market === 'US') {
      return {
        kind: 'us_b2b',
        label: 'US B2B outreach only',
        expiresAt: null,
        detail: 'Business outreach with opt-out and postal footer',
        tone: 'brand',
      };
    }
  }

  if (input.market === 'US') {
    return {
      kind: 'us_b2b',
      label: 'US B2B outreach only',
      expiresAt: null,
      detail: expiredByTime
        ? 'Implied consent expired; US business outreach rules apply'
        : 'Business outreach with opt-out and postal footer',
      tone: 'brand',
    };
  }

  return {
    kind: 'none',
    label: 'None',
    expiresAt: null,
    detail:
      expiredByTime || consent?.status === 'expired'
        ? 'Implied consent expired'
        : input.market === 'CA'
          ? 'Consent required before outreach in Canada'
          : 'Express opt-in required before outreach',
    tone: 'neutral',
  };
}
