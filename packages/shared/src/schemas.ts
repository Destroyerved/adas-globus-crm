import { z } from 'zod';
import {
  AccountStatusSchema,
  ConsentBasisSchema,
  CurrencySchema,
  DealStageCategorySchema,
  EmailVerificationStatusSchema,
  LeadSystemStatusSchema,
  MarketSchema,
  ScopeSchema,
} from './enums.js';

// ---------------------------------------------------------------------------
// PRD §5.1–5.4: Compliance & Sendability Schemas
// ---------------------------------------------------------------------------

export const SendableReasonCodeSchema = z.enum([
  'OK',
  'SUPPRESSED_EMAIL',
  'SUPPRESSED_DOMAIN',
  'HARD_BOUNCED',
  'DO_NOT_CONTACT',
  'INVALID_EMAIL',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
  'NO_LAWFUL_BASIS',
  'MARKET_BLOCKED',
  'FREQUENCY_CAP',
  'MAILBOX_DAILY_CAP',
  'OUTSIDE_SEND_WINDOW',
]);
export type SendableReasonCode = z.infer<typeof SendableReasonCodeSchema>;

export const MessageChannelSchema = z.enum(['sequence', 'campaign', 'one_to_one', 'transactional']);
export type MessageChannel = z.infer<typeof MessageChannelSchema>;

export const SuppressionReasonSchema = z.enum([
  'unsubscribe',
  'hard_bounce',
  'complaint',
  'manual_dnc',
  'privacy_erasure',
]);
export type SuppressionReason = z.infer<typeof SuppressionReasonSchema>;

export const CheckSendableInputSchema = z.object({
  email: z.string().min(1),
  channel: MessageChannelSchema,
  market: MarketSchema.default('US'),
  contactDoNotContact: z.boolean().default(false),
  companyAccountStatus: AccountStatusSchema.default('prospect'),
  emailVerificationStatus: EmailVerificationStatusSchema.default('unknown'),
  hardBounced: z.boolean().default(false),
  suppressedEmail: z.boolean().default(false),
  suppressedDomain: z.boolean().default(false),
  consent: z
    .object({
      basis: ConsentBasisSchema,
      status: z.enum(['active', 'expired', 'revoked']),
      expiresAt: z.string().datetime().nullable().optional(),
      capturedAt: z.string().datetime().optional(),
    })
    .nullable()
    .optional(),
  sendsInLast7Days: z.number().int().nonnegative().default(0),
  maxSendsPer7Days: z.number().int().positive().default(3),
  mailboxSendsToday: z.number().int().nonnegative().default(0),
  mailboxDailyCap: z.number().int().positive().default(50),
  withinSendWindow: z.boolean().default(true),
  bypassSendWindow: z.boolean().default(false),
  nowIso: z.string().datetime().optional(),
});
export type CheckSendableInput = z.infer<typeof CheckSendableInputSchema>;

export const CheckSendableResultSchema = z.object({
  sendable: z.boolean(),
  reasonCode: SendableReasonCodeSchema,
  reasonMessage: z.string(),
  market: MarketSchema,
  evaluatedAt: z.string().datetime(),
});
export type CheckSendableResult = z.infer<typeof CheckSendableResultSchema>;

// ---------------------------------------------------------------------------
// PRD §3 & Phase 1: Auth, Users, Teams, Roles, Audit Logs
// ---------------------------------------------------------------------------

export const UserRoleNameSchema = z.enum([
  'Admin',
  'Sales Manager',
  'BDR / SDR',
  'Account Executive',
  'Marketing Manager',
  'Read-Only / Analyst',
]);
export type UserRoleName = z.infer<typeof UserRoleNameSchema>;

export const SessionUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: UserRoleNameSchema,
  teamId: z.string().nullable(),
  teamMemberIds: z.array(z.string()).default([]),
  marketFocus: MarketSchema.default('US'),
  capabilities: z.record(z.string(), ScopeSchema.or(z.literal('none'))),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const BreakGlassLoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  totpCode: z.string().regex(/^\d{6}$/, 'Enter a 6-digit TOTP code'),
});
export type BreakGlassLoginInput = z.infer<typeof BreakGlassLoginInputSchema>;

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ipAddress: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// ---------------------------------------------------------------------------
// PRD §4.1–4.7: Companies, Contacts, Leads, Deals, Tasks
// ---------------------------------------------------------------------------

export const CreateCompanyInputSchema = z.object({
  name: z.string().min(1).max(200),
  websiteOrDomain: z.string().optional().nullable(),
  firmType: z.string().default('CPA firm'),
  market: MarketSchema.default('US'),
  stateProvince: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  timezone: z.string().default('America/New_York'),
  staffBand: z.string().default('11–20'),
  accountStatus: AccountStatusSchema.default('prospect'),
  ownerUserId: z.string().optional(),
  accountingSoftware: z.array(z.string()).default([]),
  servicesNeeded: z.array(z.string()).default([]),
  estimatedRevenueMinor: z.string().regex(/^\d+$/).default('0'),
  currency: CurrencySchema.default('USD'),
});
export type CreateCompanyInput = z.infer<typeof CreateCompanyInputSchema>;

export const UpdateCompanyInputSchema = CreateCompanyInputSchema.partial().extend({
  version: z.number().int().positive(),
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompanyInputSchema>;

export const CreateContactInputSchema = z.object({
  companyId: z.string().nullable().optional(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  title: z.string().default('Partner'),
  jobFunction: z.string().default('Partner / Principal'),
  seniority: z.string().default('Partner'),
  primaryEmail: z.string().email(),
  secondaryEmails: z.array(z.string().email()).default([]),
  phone: z.string().optional().nullable(),
  market: MarketSchema.default('US'),
  timezone: z.string().default('America/New_York'),
  ownerUserId: z.string().optional(),
  doNotContact: z.boolean().default(false),
});
export type CreateContactInput = z.infer<typeof CreateContactInputSchema>;

export const CreateLeadInputSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).default(''),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  firmName: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  title: z.string().default('Partner'),
  market: MarketSchema.default('US'),
  stateProvince: z.string().optional().nullable(),
  staffBand: z.string().default('11–20'),
  source: z.string().default('Manual entry'),
  status: LeadSystemStatusSchema.default('New'),
  servicesNeeded: z.array(z.string()).default([]),
  softwareStack: z.array(z.string()).default([]),
  ownerUserId: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateLeadInput = z.infer<typeof CreateLeadInputSchema>;

export const ConvertLeadInputSchema = z.object({
  leadId: z.string(),
  createDeal: z.boolean().default(true),
  dealName: z.string().optional(),
  monthlyValueMinor: z.string().regex(/^\d+$/).default('480000'),
  currency: CurrencySchema.default('USD'),
  fteCount: z.number().positive().default(1),
  engagementModel: z
    .enum(['Full-time', 'Part-time', 'Seasonal', 'Trial-first'])
    .default('Full-time'),
  startFreeTrial: z.boolean().default(false),
  services: z.array(z.string()).default(['Tax Preparation']),
});
export type ConvertLeadInput = z.infer<typeof ConvertLeadInputSchema>;

export const CreateDealInputSchema = z.object({
  companyId: z.string(),
  primaryContactId: z.string().nullable().optional(),
  pipelineId: z.string().default('pipeline_new_business'),
  stageName: z.string().default('New Opportunity'),
  name: z.string().min(1).max(200),
  monthlyValueMinor: z.string().regex(/^\d+$/),
  annualValueMinor: z.string().regex(/^\d+$/).optional(),
  currency: CurrencySchema.default('USD'),
  fteCount: z.number().positive().default(1),
  engagementModel: z
    .enum(['Full-time', 'Part-time', 'Seasonal', 'Trial-first'])
    .default('Full-time'),
  services: z.array(z.string()).default(['Tax Preparation']),
  expectedCloseDate: z.string().optional(),
  ownerUserId: z.string().optional(),
});
export type CreateDealInput = z.infer<typeof CreateDealInputSchema>;

export const MoveDealStageInputSchema = z.object({
  stageName: z.string().min(1),
  version: z.number().int().positive(),
  lostReason: z.string().optional().nullable(),
  lostNotes: z.string().optional().nullable(),
  trialCandidateRole: z.string().optional().nullable(),
  contractStartDate: z.string().optional().nullable(),
});
export type MoveDealStageInput = z.infer<typeof MoveDealStageInputSchema>;

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1).max(240),
  taskType: z
    .enum(['call', 'email', 'follow_up', 'trial_checkin', 'sla_first_response'])
    .default('follow_up'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueAt: z.string().datetime(),
  assigneeUserId: z.string().optional(),
  leadId: z.string().optional().nullable(),
  companyId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  dealId: z.string().optional().nullable(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

// ---------------------------------------------------------------------------
// PRD §4.10: Website Inquiry Intake Payload
// ---------------------------------------------------------------------------

export const WebsiteInquiryPayloadSchema = z.object({
  name: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  firm: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  staffSize: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  stateProvince: z.string().optional().nullable(),
  services: z.union([z.array(z.string()), z.string()]).optional(),
  software: z.union([z.array(z.string()), z.string()]).optional(),
  message: z.string().optional().nullable(),
  formType: z.enum(['trial', 'contact', 'consultation']).default('trial'),
  utmSource: z.string().optional().nullable(),
  utmMedium: z.string().optional().nullable(),
  utmCampaign: z.string().optional().nullable(),
  pageUrl: z.string().optional().nullable(),
  // Honeypot fields — if non-empty, silently accept and drop
  company_website_hp: z.string().optional(),
  _gotcha: z.string().optional(),
});
export type WebsiteInquiryPayload = z.infer<typeof WebsiteInquiryPayloadSchema>;

// ---------------------------------------------------------------------------
// PRD §4.8 & §4.9: CSV Imports & Duplicate Merge
// ---------------------------------------------------------------------------

export const CsvImportRowInputSchema = z.object({
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  email: z.string(),
  phone: z.string().optional().nullable(),
  firmName: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  market: MarketSchema.default('US'),
  stateProvince: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  source: z.string().default('CSV Import'),
  consentBasis: ConsentBasisSchema.optional().nullable(),
  legacyNoConsent: z.boolean().default(false),
});
export type CsvImportRowInput = z.infer<typeof CsvImportRowInputSchema>;

export const CsvImportRequestSchema = z.object({
  fileName: z.string().default('contacts.csv'),
  dryRun: z.boolean().default(true),
  duplicatePolicy: z.enum(['skip', 'update_blank', 'overwrite']).default('update_blank'),
  rows: z.array(CsvImportRowInputSchema).min(1).max(10000),
});
export type CsvImportRequest = z.infer<typeof CsvImportRequestSchema>;

export const MergeContactsInputSchema = z.object({
  survivorContactId: z.string(),
  duplicateContactId: z.string(),
  fieldOverrides: z.record(z.string(), z.unknown()).optional(),
});
export type MergeContactsInput = z.infer<typeof MergeContactsInputSchema>;

// ---------------------------------------------------------------------------
// PRD §4.11–4.16 & §8: Inbox, Sequences, Campaigns, Integrations
// ---------------------------------------------------------------------------

export const CreateSequenceInputSchema = z.object({
  name: z.string().min(1).max(160),
  market: MarketSchema.default('US'),
  dailyCapPerMailbox: z.number().int().positive().max(200).default(50),
  steps: z
    .array(
      z.object({
        stepOrder: z.number().int().positive(),
        delayBusinessDays: z.number().int().nonnegative(),
        subjectTemplate: z.string().min(1),
        bodyTemplate: z.string().min(1),
      }),
    )
    .min(1),
});
export type CreateSequenceInput = z.infer<typeof CreateSequenceInputSchema>;

export const EnrollSequenceInputSchema = z.object({
  sequenceId: z.string(),
  contactId: z.string(),
  senderUserId: z.string().optional(),
});
export type EnrollSequenceInput = z.infer<typeof EnrollSequenceInputSchema>;

export const CreateCampaignInputSchema = z.object({
  name: z.string().min(1).max(160),
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1),
  market: MarketSchema.default('US'),
  listId: z.string().optional().nullable(),
  recipientContactIds: z.array(z.string()).default([]),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>;

export const DealStageDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: DealStageCategorySchema,
  probability: z.number().int().min(0).max(100),
  stageOrder: z.number().int().nonnegative(),
  requiredFields: z.array(z.string()),
});
export type DealStageDefinition = z.infer<typeof DealStageDefinitionSchema>;
