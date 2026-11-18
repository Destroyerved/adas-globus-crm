import { z } from 'zod';
import { CurrencySchema } from './enums.js';
import { RecordEntityTypeSchema } from './schemas.js';

/**
 * Custom field definitions & values (PRD 4.3-4.6, 4.17, 6.8), configurable lead/contact
 * scoring rules (PRD 4.5, 4.16), and contact secondary emails/phones (PRD 4.4).
 */

// ---------------------------------------------------------------------------
// Custom fields (PRD 4.17, 6.8)
// ---------------------------------------------------------------------------

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'select',
  'multi_select',
  'boolean',
  'date',
  'money',
  'url',
] as const;
export const CustomFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof CustomFieldTypeSchema>;

export const CustomFieldKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9_]{1,39}$/,
    'Use 2–40 lowercase letters, numbers or underscores, starting with a letter.',
  );

export const CreateCustomFieldInputSchema = z
  .object({
    entityType: RecordEntityTypeSchema,
    fieldKey: CustomFieldKeySchema,
    label: z.string().trim().min(1, 'Enter a field label.').max(80),
    fieldType: CustomFieldTypeSchema,
    options: z.array(z.string().trim().min(1).max(80)).max(60).default([]),
    isRequired: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      (val.fieldType === 'select' || val.fieldType === 'multi_select') &&
      val.options.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Add at least one option for a select field.',
      });
    }
  });
export type CreateCustomFieldInput = z.input<typeof CreateCustomFieldInputSchema>;

export const UpdateCustomFieldInputSchema = z
  .object({
    version: z.number().int().positive(),
    label: z.string().trim().min(1, 'Enter a field label.').max(80).optional(),
    options: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
    isRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type UpdateCustomFieldInput = z.input<typeof UpdateCustomFieldInputSchema>;

export interface CustomFieldDefinitionView {
  id: string;
  entityType: z.infer<typeof RecordEntityTypeSchema>;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  isRequired: boolean;
  sortOrder: number;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const CustomFieldMoneyValueSchema = z
  .object({
    amountMinor: z.string().regex(/^\d+$/, 'Enter a non-negative integer minor amount.'),
    currency: CurrencySchema,
  })
  .strict();

export const SetCustomFieldsInputSchema = z
  .object({
    version: z.number().int().positive(),
    values: z.record(z.string().min(1).max(40), z.unknown()),
  })
  .strict();
export type SetCustomFieldsInput = z.input<typeof SetCustomFieldsInputSchema>;

// ---------------------------------------------------------------------------
// Lead & Contact Scoring Rules (PRD 4.5, 4.16 — never scores opens)
// ---------------------------------------------------------------------------

export const SCORING_CATEGORIES = ['fit', 'engagement', 'negative'] as const;
export const ScoringCategorySchema = z.enum(SCORING_CATEGORIES);
export type ScoringCategory = z.infer<typeof ScoringCategorySchema>;

export const SCORING_OPERATORS = ['eq', 'in', 'gt', 'contains', 'isTrue'] as const;
export const ScoringOperatorSchema = z.enum(SCORING_OPERATORS);
export type ScoringOperator = z.infer<typeof ScoringOperatorSchema>;

export const SCORING_FIELD_PATHS = [
  'staffBand',
  'title',
  'market',
  'source',
  'softwareStack',
  'servicesNeeded',
  'hasCallOrMeeting',
  'missingDomain',
] as const;
export const ScoringFieldPathSchema = z.enum(SCORING_FIELD_PATHS);
export type ScoringFieldPath = z.infer<typeof ScoringFieldPathSchema>;

export const CreateScoringRuleInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter a rule name.').max(120),
    category: ScoringCategorySchema,
    fieldPath: ScoringFieldPathSchema,
    operator: ScoringOperatorSchema,
    targetValue: z.unknown(),
    points: z.number().int().min(-100).max(100),
    active: z.boolean().default(true),
  })
  .strict();
export type CreateScoringRuleInput = z.input<typeof CreateScoringRuleInputSchema>;

export const UpdateScoringRuleInputSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(2, 'Enter a rule name.').max(120).optional(),
    category: ScoringCategorySchema.optional(),
    fieldPath: ScoringFieldPathSchema.optional(),
    operator: ScoringOperatorSchema.optional(),
    targetValue: z.unknown().optional(),
    points: z.number().int().min(-100).max(100).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpdateScoringRuleInput = z.input<typeof UpdateScoringRuleInputSchema>;

export interface ScoringRuleView {
  id: string;
  name: string;
  category: ScoringCategory;
  fieldPath: ScoringFieldPath;
  operator: ScoringOperator;
  targetValue: unknown;
  points: number;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreBreakdownItem {
  ruleId: string;
  ruleName: string;
  category: ScoringCategory;
  points: number;
}

// ---------------------------------------------------------------------------
// Contact secondary emails & phones (PRD 4.4)
// ---------------------------------------------------------------------------

export const AddContactEmailInputSchema = z
  .object({
    email: z.string().trim().email('Enter a valid email address.').max(254),
    makePrimary: z.boolean().default(false),
  })
  .strict();
export type AddContactEmailInput = z.input<typeof AddContactEmailInputSchema>;

export const SetPrimaryContactEmailInputSchema = z
  .object({
    email: z.string().trim().email('Enter a valid email address.').max(254),
  })
  .strict();
export type SetPrimaryContactEmailInput = z.input<typeof SetPrimaryContactEmailInputSchema>;

export const PHONE_LABELS = ['work', 'mobile', 'direct', 'other'] as const;
export const PhoneLabelSchema = z.enum(PHONE_LABELS);
export type PhoneLabel = z.infer<typeof PhoneLabelSchema>;

export const AddContactPhoneInputSchema = z
  .object({
    phone: z.string().trim().min(5, 'Enter a phone number.').max(40),
    label: PhoneLabelSchema.default('work'),
    makePrimary: z.boolean().default(false),
  })
  .strict();
export type AddContactPhoneInput = z.input<typeof AddContactPhoneInputSchema>;

export const SetPrimaryContactPhoneInputSchema = z
  .object({
    phoneE164: z.string().trim().min(5).max(40),
  })
  .strict();
export type SetPrimaryContactPhoneInput = z.input<typeof SetPrimaryContactPhoneInputSchema>;

// ---------------------------------------------------------------------------
// Deal stakeholder contacts (PRD 4.6, 7.3)
// ---------------------------------------------------------------------------

export interface DealContactView {
  id: string;
  dealId: string;
  contactId: string;
  fullName: string;
  title: string | null;
  primaryEmail: string;
  role: string;
  createdAt: string;
}

export const AddDealContactInputSchema = z
  .object({
    contactId: z.string().trim().min(1, 'Choose a contact.').max(80),
    role: z.string().trim().min(1, 'Choose a role.').max(80).default('Decision maker'),
  })
  .strict();
export type AddDealContactInput = z.input<typeof AddDealContactInputSchema>;

export const UpdateDealContactInputSchema = z
  .object({
    role: z.string().trim().min(1, 'Choose a role.').max(80),
  })
  .strict();
export type UpdateDealContactInput = z.input<typeof UpdateDealContactInputSchema>;

// ---------------------------------------------------------------------------
// FX rates administration (PRD 4.6, 4.15, 4.17, 14 — integer rate_scaled, never floats)
// ---------------------------------------------------------------------------

/**
 * Parse a decimal exchange rate text ("0.735" or "1.360544") into an integer scaled by 1,000,000
 * without floating-point arithmetic. Returns null if invalid or <= 0.
 */
export function parseFxRateScaled(text: string): bigint | null {
  const cleaned = text.trim();
  const match = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = BigInt(match[1] ?? '0');
  const frac = BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  const scaled = whole * 1_000_000n + frac;
  return scaled > 0n ? scaled : null;
}

/**
 * Format an integer rate scaled by 1,000,000 ("735000" -> "0.7350", "1360544" -> "1.360544").
 */
export function formatFxRateScaled(scaledInput: bigint | string): string {
  const scaled = typeof scaledInput === 'bigint' ? scaledInput : BigInt(scaledInput || '0');
  const whole = scaled / 1_000_000n;
  const fracRaw = (scaled % 1_000_000n).toString().padStart(6, '0');
  const trimmedFrac = fracRaw.replace(/0+$/, '');
  const minFour = trimmedFrac.padEnd(4, '0');
  return `${whole.toString()}.${minFour}`;
}

export interface FxRateView {
  id: string;
  fromCurrency: z.infer<typeof CurrencySchema>;
  toCurrency: z.infer<typeof CurrencySchema>;
  rateScaled: string;
  effectiveDate: string;
  createdAt: string;
}

export const UpsertFxRateInputSchema = z
  .object({
    fromCurrency: CurrencySchema,
    toCurrency: CurrencySchema,
    rateText: z
      .string()
      .trim()
      .refine((v) => parseFxRateScaled(v) !== null, {
        message: 'Enter a positive rate with up to 6 decimal places (for example 0.7350).',
      }),
    effectiveDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD date format.'),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.fromCurrency === val.toCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toCurrency'],
        message: 'Choose two different currencies.',
      });
    }
  });
export type UpsertFxRateInput = z.input<typeof UpsertFxRateInputSchema>;
