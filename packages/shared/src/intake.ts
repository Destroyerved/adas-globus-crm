import { z } from 'zod';
import { MarketSchema } from './enums.js';

/**
 * Market routing rules & website inquiry admin schemas (PRD 4.5, 4.10, 4.17, 15 Q13).
 */

export const RoutingModeSchema = z.enum(['round_robin', 'named_owner']);
export type RoutingMode = z.infer<typeof RoutingModeSchema>;

export const InquiryFormTypeSchema = z.enum(['trial', 'contact', 'consultation']);
export type InquiryFormType = z.infer<typeof InquiryFormTypeSchema>;

export const UpdateRoutingRuleInputSchema = z
  .object({
    version: z.number().int().positive(),
    mode: RoutingModeSchema,
    teamId: z.string().trim().min(1).max(80).nullable().optional(),
    ownerUserId: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'round_robin' && (!val.teamId || val.teamId.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['teamId'],
        message: 'Choose a team for round-robin assignment.',
      });
    }
    if (val.mode === 'named_owner' && (!val.ownerUserId || val.ownerUserId.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'Choose an active person to receive inquiries for this market.',
      });
    }
  });
export type UpdateRoutingRuleInput = z.infer<typeof UpdateRoutingRuleInputSchema>;

export const RoutingRuleViewSchema = z.object({
  market: MarketSchema,
  mode: RoutingModeSchema,
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  eligibleMemberCount: z.number().int().nonnegative(),
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  lastAssignedUserId: z.string().nullable(),
  lastAssignedName: z.string().nullable(),
  version: z.number().int().positive(),
  updatedByName: z.string().nullable(),
  updatedAt: z.string(),
});
export type RoutingRuleView = z.infer<typeof RoutingRuleViewSchema>;

export const InquiryListQuerySchema = z.object({
  cursor: z.string().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  market: MarketSchema.optional(),
  formType: InquiryFormTypeSchema.optional(),
});
export type InquiryListQuery = z.infer<typeof InquiryListQuerySchema>;

export const InquirySummaryViewSchema = z.object({
  id: z.string(),
  formType: InquiryFormTypeSchema,
  market: MarketSchema,
  deduplicated: z.boolean(),
  pageUrl: z.string().nullable(),
  leadId: z.string().nullable(),
  leadName: z.string().nullable(),
  firmName: z.string().nullable(),
  contactId: z.string().nullable(),
  companyId: z.string().nullable(),
  slaTaskId: z.string().nullable(),
  slaTaskStatus: z.string().nullable(),
  assignedUserId: z.string().nullable(),
  assignedUserName: z.string().nullable(),
  createdAt: z.string(),
});
export type InquirySummaryView = z.infer<typeof InquirySummaryViewSchema>;

export const PublicInquiryAckSchema = z.object({
  status: z.literal('received'),
});
export type PublicInquiryAck = z.infer<typeof PublicInquiryAckSchema>;
