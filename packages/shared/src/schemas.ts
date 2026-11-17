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
  /** IANA time zone used for "today" and dashboard periods (PRD 4.7, 14). */
  timezone: z.string().optional(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/** Emergency admin sign-in (PRD 6.6): `POST /auth/local/login`. */
export const BreakGlassLoginInputSchema = z.object({
  email: z.string().trim().email('Enter the account’s email address'),
  password: z.string().min(1, 'Enter the password').max(256),
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
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

export const TaskTypeSchema = z.enum([
  'call',
  'email',
  'follow_up',
  'meeting',
  'research',
  'trial_checkin',
  'proposal',
  'internal',
  'sla_first_response',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1).max(240),
  taskType: TaskTypeSchema.default('follow_up'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueAt: z.string().datetime(),
  assigneeUserId: z.string().optional(),
  leadId: z.string().optional().nullable(),
  companyId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  dealId: z.string().optional().nullable(),
  reminderAt: z.string().datetime().optional().nullable(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

// ---------------------------------------------------------------------------
// Editing records, notes, tags and activities (PRD 3.1, 3.2, 4.3-4.7)
// ---------------------------------------------------------------------------

export const RecordEntityTypeSchema = z.enum(['lead', 'contact', 'company', 'deal']);
export type RecordEntityType = z.infer<typeof RecordEntityTypeSchema>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const UpdateLeadInputSchema = z.object({
  version: z.number().int().positive(),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  email: z.string().email().optional(),
  phone: optionalText(40),
  firmName: optionalText(200),
  website: optionalText(300),
  title: z.string().trim().max(160).optional(),
  market: MarketSchema.optional(),
  stateProvince: optionalText(80),
  staffBand: z.string().max(40).optional(),
  source: z.string().trim().min(1).max(160).optional(),
  status: LeadSystemStatusSchema.optional(),
  disqualificationReason: optionalText(160),
  statusNote: optionalText(2000),
  ownerUserId: z.string().optional(),
  servicesNeeded: z.array(z.string().max(120)).max(30).optional(),
  softwareStack: z.array(z.string().max(120)).max(40).optional(),
});
export type UpdateLeadInput = z.infer<typeof UpdateLeadInputSchema>;

export const UpdateContactInputSchema = z.object({
  version: z.number().int().positive(),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().max(160).optional(),
  jobFunction: z.string().trim().max(120).optional(),
  seniority: z.string().trim().max(80).optional(),
  primaryEmail: z.string().email().optional(),
  phone: optionalText(40),
  market: MarketSchema.optional(),
  timezone: z.string().max(64).optional(),
  companyId: z.string().nullable().optional(),
  ownerUserId: z.string().optional(),
  doNotContact: z.boolean().optional(),
});
export type UpdateContactInput = z.infer<typeof UpdateContactInputSchema>;

export const UpdateDealInputSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  primaryContactId: z.string().nullable().optional(),
  monthlyValueMinor: z.string().regex(/^\d+$/).optional(),
  oneTimeValueMinor: z.string().regex(/^\d+$/).optional(),
  termMonths: z.number().int().positive().max(120).optional(),
  currency: CurrencySchema.optional(),
  fteCount: z.number().positive().max(999).optional(),
  engagementModel: z.string().max(80).optional(),
  services: z.array(z.string().max(120)).max(30).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  ownerUserId: z.string().optional(),
  trialCandidateRole: optionalText(160),
});
export type UpdateDealInput = z.infer<typeof UpdateDealInputSchema>;

export const UpdateTaskInputSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(240).optional(),
  taskType: TaskTypeSchema.optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueAt: z.string().datetime().optional(),
  reminderAt: z.string().datetime().nullable().optional(),
  assigneeUserId: z.string().optional(),
  status: z.enum(['open', 'cancelled']).optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const CompleteTaskInputSchema = z.object({
  outcome: z.string().trim().max(4000).optional().nullable(),
});
export type CompleteTaskInput = z.infer<typeof CompleteTaskInputSchema>;

export const CreateNoteInputSchema = z.object({
  entityType: RecordEntityTypeSchema,
  entityId: z.string().min(1),
  body: z.string().trim().min(1).max(20000),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInputSchema>;

export const UpdateNoteInputSchema = z.object({
  version: z.number().int().positive(),
  body: z.string().trim().min(1).max(20000),
});
export type UpdateNoteInput = z.infer<typeof UpdateNoteInputSchema>;

export const ActivityTypeSchema = z.enum(['call', 'meeting', 'email_logged']);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const LogActivityInputSchema = z.object({
  activityType: ActivityTypeSchema,
  entityType: RecordEntityTypeSchema,
  entityId: z.string().min(1),
  title: z.string().trim().max(240).optional(),
  detail: z.string().trim().max(20000).default(''),
  outcome: z.string().trim().max(120).optional().nullable(),
  occurredAt: z.string().datetime().optional(),
});
export type LogActivityInput = z.infer<typeof LogActivityInputSchema>;

export const SetTagsInputSchema = z.object({
  tags: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(
          /^[\p{L}\p{N} ._-]+$/u,
          'Tags use letters, numbers, spaces, dots, dashes and underscores',
        ),
    )
    .max(20),
});
export type SetTagsInput = z.infer<typeof SetTagsInputSchema>;

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
  // Fields the live website forms send (website repo: src/pages/home.html, src/pages/contact.mjs)
  need: z.string().optional().nullable(), // trial form "What do you need?"
  location: z.string().optional().nullable(), // contact form state / province
  interests: z.union([z.array(z.string()), z.string()]).optional(), // contact form chips, comma-separated
  form: z.enum(['trial', 'contact', 'consultation']).optional(),
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

// Imports (PRD 4.9) live in imports.ts; duplicate review and merge in merges.ts.

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
