import { z } from 'zod';
import { MarketSchema, ScopeSchema } from './enums.js';

/**
 * Administration and dashboard request schemas (PRD 2.1, 2.2, 3.3, 3.4, 4.2, 4.17, 14).
 * The API validates with these and the web forms check the same rules before sending.
 */

/** True when the runtime knows this IANA time zone name, for example "America/Toronto". */
export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1, 'Choose a time zone.')
  .refine(isValidTimeZone, 'Choose a time zone from the list.');

const personName = z.string().trim().min(1, 'Enter a name.').max(120);

// ---------------------------------------------------------------------------
// Users and teams (PRD 2.1, 4.17, 6.6)
// ---------------------------------------------------------------------------

export const UserStatusSchema = z.enum(['invited', 'active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const InviteUserInputSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a work email address.').max(254),
  name: personName,
  roleId: z.string().min(1, 'Choose a role.'),
  teamId: z.string().min(1).nullable(),
  marketFocus: MarketSchema,
  timezone: TimeZoneSchema,
});
export type InviteUserInput = z.infer<typeof InviteUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  version: z.number().int().positive(),
  name: personName.optional(),
  roleId: z.string().min(1).optional(),
  teamId: z.string().min(1).nullable().optional(),
  marketFocus: MarketSchema.optional(),
  timezone: TimeZoneSchema.optional(),
  dailySendCap: z.number().int().min(0).max(500).optional(),
  /** Deactivate or reactivate. Invited users become active when they first sign in. */
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

export const CreateTeamInputSchema = z.object({
  name: z.string().trim().min(2, 'Enter a team name.').max(80),
  market: MarketSchema,
});
export type CreateTeamInput = z.infer<typeof CreateTeamInputSchema>;

export const UpdateTeamInputSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(2, 'Enter a team name.').max(80).optional(),
  market: MarketSchema.optional(),
});
export type UpdateTeamInput = z.infer<typeof UpdateTeamInputSchema>;

export const UpdateMyPreferencesInputSchema = z.object({
  timezone: TimeZoneSchema,
});
export type UpdateMyPreferencesInput = z.infer<typeof UpdateMyPreferencesInputSchema>;

// ---------------------------------------------------------------------------
// Roles and capabilities (PRD 2.1, 2.2)
// ---------------------------------------------------------------------------

export const CapabilityScopeValueSchema = z.enum(['own', 'team', 'all', 'none']);
export type CapabilityScopeValue = z.infer<typeof CapabilityScopeValueSchema>;

export const UpdateRoleCapabilitiesInputSchema = z.object({
  grants: z
    .record(z.string().regex(/^[a-z]+\.[a-z_]+$/), CapabilityScopeValueSchema)
    .refine((g) => Object.keys(g).length > 0, 'Change at least one capability.'),
});
export type UpdateRoleCapabilitiesInput = z.infer<typeof UpdateRoleCapabilitiesInputSchema>;

// ---------------------------------------------------------------------------
// Pipelines and stages (PRD 3.3)
// ---------------------------------------------------------------------------

/** Details a deal must have before it can enter a stage. */
export const STAGE_REQUIRED_FIELDS = [
  'primary_contact_id',
  'trial_candidate_role',
  'contract_start_date',
  'lost_reason',
] as const;
export const StageRequiredFieldSchema = z.enum(STAGE_REQUIRED_FIELDS);
export type StageRequiredField = z.infer<typeof StageRequiredFieldSchema>;

const stageName = z.string().trim().min(2, 'Enter a stage name.').max(60);

export const UpdateStageInputSchema = z.object({
  version: z.number().int().positive(),
  name: stageName.optional(),
  probability: z.number().int().min(0).max(100).optional(),
  idleDays: z.number().int().min(1).max(365).optional(),
  requiredFields: z.array(StageRequiredFieldSchema).max(STAGE_REQUIRED_FIELDS.length).optional(),
  isTrial: z.boolean().optional(),
});
export type UpdateStageInput = z.infer<typeof UpdateStageInputSchema>;

export const CreateStageInputSchema = z.object({
  name: stageName,
  probability: z.number().int().min(0).max(100),
  idleDays: z.number().int().min(1).max(365).default(14),
});
export type CreateStageInput = z.infer<typeof CreateStageInputSchema>;

export const MoveStageInputSchema = z.object({
  version: z.number().int().positive(),
  direction: z.enum(['up', 'down']),
});
export type MoveStageInput = z.infer<typeof MoveStageInputSchema>;

// ---------------------------------------------------------------------------
// Reference lists and defaults (PRD 3.4, 4.17)
// ---------------------------------------------------------------------------

export const REFERENCE_LIST_KEYS = [
  'reference.services',
  'reference.engagement_models',
  'reference.firm_types',
  'reference.staff_bands',
  'reference.software',
  'reference.lead_sources',
  'reference.lost_reasons',
  'reference.disqualify_reasons',
  'reference.deal_contact_roles',
] as const;
export type ReferenceListKey = (typeof REFERENCE_LIST_KEYS)[number];

export const NUMBER_SETTING_KEYS = [
  'sla.first_response_business_days',
  'deals.idle_days_default',
] as const;
export type NumberSettingKey = (typeof NUMBER_SETTING_KEYS)[number];

export type EditableSettingKey = ReferenceListKey | NumberSettingKey;

export const ReferenceListValueSchema = z
  .array(z.string().trim().min(1, 'Values cannot be blank.').max(120))
  .min(1, 'Keep at least one value.')
  .max(200)
  .refine(
    (values) => new Set(values.map((v) => v.toLocaleLowerCase('en-US'))).size === values.length,
    'Each value can appear only once.',
  );

const NUMBER_SETTING_RULES: Record<NumberSettingKey, { min: number; max: number }> = {
  'sla.first_response_business_days': { min: 1, max: 10 },
  'deals.idle_days_default': { min: 1, max: 365 },
};

/** The validator for one editable setting, or null when the key isn't editable. */
export function settingValueSchema(key: string): z.ZodType<unknown> | null {
  if ((REFERENCE_LIST_KEYS as readonly string[]).includes(key)) return ReferenceListValueSchema;
  const rule = NUMBER_SETTING_RULES[key as NumberSettingKey];
  if (rule) {
    return z
      .number()
      .int('Enter a whole number.')
      .min(rule.min, `Enter ${rule.min} or more.`)
      .max(rule.max, `Enter ${rule.max} or less.`);
  }
  return null;
}

export const UpdateSettingInputSchema = z.object({
  version: z.number().int().positive(),
  value: z.unknown(),
});
export type UpdateSettingInput = z.infer<typeof UpdateSettingInputSchema>;

// ---------------------------------------------------------------------------
// Dashboard (PRD 4.2, 14)
// ---------------------------------------------------------------------------

export const DASHBOARD_WIDGETS = [
  'followups_today',
  'overdue_tasks',
  'sla_inquiries',
  'leads_by_status',
  'pipeline_by_stage',
  'won_lost',
  'sla_breaches',
  'overdue_by_person',
  'leads_by_source_market',
  'trial_to_win',
  'activity_summary',
  'outreach_performance',
] as const;
export const DashboardWidgetIdSchema = z.enum(DASHBOARD_WIDGETS);
export type DashboardWidgetId = z.infer<typeof DashboardWidgetIdSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08.');

/** A period in the viewer's time zone, both ends inclusive, at most two years long. */
export const DashboardQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    market: z.enum(['US', 'CA']).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'The start date must be on or before the end date.' })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 731 * 86_400_000, {
    message: 'Choose a period of two years or less.',
  });
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

/** Today's calendar date (YYYY-MM-DD) in a time zone. */
export function calendarDateInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const DASHBOARD_PRESETS = [
  'this_month',
  'last_month',
  'this_quarter',
  'last_30_days',
  'this_year',
] as const;
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/**
 * The inclusive date range for a dashboard preset, from today's date in the viewer's zone.
 * Works on calendar dates only, so no clock or zone arithmetic is involved.
 */
export function dashboardPresetRange(
  preset: DashboardPreset,
  today: string,
): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const date = (year: number, month: number, day: number) =>
    ymd(new Date(Date.UTC(year, month - 1, day)));
  switch (preset) {
    case 'this_month':
      return { from: date(y, m, 1), to: today };
    case 'last_month':
      return { from: date(y, m - 1, 1), to: date(y, m, 0) };
    case 'this_quarter':
      return { from: date(y, Math.floor((m - 1) / 3) * 3 + 1, 1), to: today };
    case 'last_30_days':
      return { from: date(y, m, d - 29), to: today };
    case 'this_year':
      return { from: date(y, 1, 1), to: today };
  }
}

// ---------------------------------------------------------------------------
// Scoped Service API Tokens (PRD 4.14, 6.7, 9)
// ---------------------------------------------------------------------------

export const CreateApiTokenInputSchema = z.object({
  name: z.string().trim().min(2, 'Enter a descriptive token name.').max(120),
  capabilities: z
    .array(z.string().regex(/^[a-z]+\.[a-z_]+$/, 'Invalid capability key.'))
    .min(1, 'Select at least one capability.')
    .max(35),
  scopeLevel: ScopeSchema.default('team'),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenInputSchema>;

export const ApiTokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  capabilities: z.array(z.string()),
  scopeLevel: ScopeSchema,
  createdByUserId: z.string(),
  createdByName: z.string().nullable(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiTokenView = z.infer<typeof ApiTokenViewSchema>;
