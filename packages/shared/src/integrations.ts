import { z } from 'zod';
import { MarketSchema } from './enums.js';

export const WEBHOOK_EVENT_TYPES = [
  'lead.created',
  'lead.converted',
  'contact.created',
  'contact.merged',
  'company.created',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'trial.started',
  'activity.logged',
  'sequence.enrolled',
  'campaign.approved',
  'inquiry.received',
] as const;

export const WebhookEventTypeSchema = z.string().min(1).max(80);

export const CreateWebhookEndpointInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(400).nullable().optional(),
  targetUrl: z.string().url().max(1000),
  eventTypes: z.array(WebhookEventTypeSchema).min(1).max(30),
  active: z.boolean().default(true),
  signingSecret: z.string().min(16).max(200).optional(),
});
export type CreateWebhookEndpointInput = z.infer<typeof CreateWebhookEndpointInputSchema>;

export const UpdateWebhookEndpointInputSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(400).nullable().optional(),
  targetUrl: z.string().url().max(1000).optional(),
  eventTypes: z.array(WebhookEventTypeSchema).min(1).max(30).optional(),
  active: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
});
export type UpdateWebhookEndpointInput = z.infer<typeof UpdateWebhookEndpointInputSchema>;

export const ApolloSearchInputSchema = z.object({
  qKeywords: z.string().trim().max(200).optional(),
  personTitles: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  organizationLocations: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  organizationNumEmployeesRanges: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  market: MarketSchema.default('US'),
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(50).default(25),
});
export type ApolloSearchInput = z.infer<typeof ApolloSearchInputSchema>;

export const ApolloImportCandidateSchema = z.object({
  apolloPersonId: z.string().trim().min(1).max(120),
  apolloOrgId: z.string().trim().max(120).nullable().optional(),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().max(120).default(''),
  email: z.string().trim().email().max(255).optional(),
  title: z.string().trim().max(160).default(''),
  firmName: z.string().trim().max(255).default(''),
  domain: z.string().trim().max(255).default(''),
  market: MarketSchema.default('US'),
});
export type ApolloImportCandidate = z.infer<typeof ApolloImportCandidateSchema>;

export const ApolloImportInputSchema = z.object({
  candidates: z.array(ApolloImportCandidateSchema).min(1).max(100),
  confirmedCreditCost: z.number().int().min(0),
});
export type ApolloImportInput = z.infer<typeof ApolloImportInputSchema>;

export const ApolloEnrichContactInputSchema = z.object({
  confirmedCreditCost: z.number().int().min(0).default(1),
});
export type ApolloEnrichContactInput = z.infer<typeof ApolloEnrichContactInputSchema>;

export const UpdateApolloCreditLimitInputSchema = z.object({
  dailyCreditLimit: z.number().int().min(0).max(50_000),
});
export type UpdateApolloCreditLimitInput = z.infer<typeof UpdateApolloCreditLimitInputSchema>;

export const MicrosoftBookingsWebhookPayloadSchema = z.object({
  appointmentId: z.string().trim().min(1).max(200),
  eventType: z.enum(['created', 'updated', 'cancelled']).default('created'),
  customerEmail: z.string().trim().email().max(255),
  customerName: z.string().trim().min(1).max(200),
  serviceName: z.string().trim().min(1).max(240),
  startTimeIso: z.string().datetime(),
  endTimeIso: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});
export type MicrosoftBookingsWebhookPayload = z.infer<typeof MicrosoftBookingsWebhookPayloadSchema>;
