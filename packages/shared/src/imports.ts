import { z } from 'zod';

/**
 * Imports (PRD 4.9): which CRM fields a file's columns can fill, the mapping and options a
 * user chooses, and a first guess at the mapping from the column names.
 */

export const IMPORT_ENTITIES = ['contact', 'company'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 100_000;
/** Imports can be undone for this many days after they finish (PRD 4.9). */
export const IMPORT_UNDO_DAYS = 7;

export interface ImportFieldDef {
  key: string;
  label: string;
  /** Lower-case column names that suggest this field. */
  synonyms: string[];
}

export const IMPORT_FIELDS: Record<ImportEntity, ImportFieldDef[]> = {
  contact: [
    { key: 'email', label: 'Email', synonyms: ['email', 'e-mail', 'email address', 'work email'] },
    { key: 'firstName', label: 'First name', synonyms: ['first name', 'firstname', 'given name'] },
    {
      key: 'lastName',
      label: 'Last name',
      synonyms: ['last name', 'lastname', 'surname', 'family name'],
    },
    {
      key: 'fullName',
      label: 'Full name',
      synonyms: ['name', 'full name', 'contact name', 'contact'],
    },
    { key: 'title', label: 'Job title', synonyms: ['title', 'job title', 'position', 'role'] },
    {
      key: 'phone',
      label: 'Phone',
      synonyms: ['phone', 'phone number', 'mobile', 'work phone', 'direct phone'],
    },
    {
      key: 'companyName',
      label: 'Company name',
      synonyms: ['company', 'company name', 'firm', 'firm name', 'account', 'account name'],
    },
    {
      key: 'companyWebsite',
      label: 'Company website',
      synonyms: ['website', 'company website', 'domain', 'company domain', 'url'],
    },
    { key: 'market', label: 'Country', synonyms: ['country', 'market'] },
  ],
  company: [
    {
      key: 'name',
      label: 'Company name',
      synonyms: ['name', 'company', 'company name', 'firm', 'firm name', 'account name'],
    },
    {
      key: 'website',
      label: 'Website',
      synonyms: ['website', 'domain', 'company domain', 'url', 'web'],
    },
    { key: 'market', label: 'Country', synonyms: ['country', 'market'] },
    {
      key: 'stateProvince',
      label: 'State or province',
      synonyms: ['state', 'province', 'state/province', 'region'],
    },
    { key: 'city', label: 'City', synonyms: ['city', 'town'] },
    {
      key: 'staffBand',
      label: 'Staff size',
      synonyms: ['staff', 'employees', 'staff size', 'company size', 'headcount'],
    },
    { key: 'firmType', label: 'Firm type', synonyms: ['firm type', 'type', 'industry'] },
  ],
};

export const DUPLICATE_POLICIES = ['skip', 'fill_blanks', 'overwrite'] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

const normaliseHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');

/** A first guess: each field goes to the first column whose name is one of its synonyms. */
export function suggestImportMapping(
  entity: ImportEntity,
  columns: string[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const field of IMPORT_FIELDS[entity]) {
    const column = columns.find(
      (c) => !(c in mapping) && field.synonyms.includes(normaliseHeader(c)),
    );
    if (column && !used.has(field.key)) {
      mapping[column] = field.key;
      used.add(field.key);
    }
  }
  return mapping;
}

export const ImportOptionsSchema = z.object({
  duplicatePolicy: z.enum(DUPLICATE_POLICIES).default('fill_blanks'),
  /** A lead source from the reference list; every record keeps it (PRD 4.9). */
  source: z.string().trim().min(1, 'Choose where these records came from').max(80),
  ownerUserId: z.string().min(1, 'Choose an owner'),
  market: z.enum(['US', 'CA', 'OTHER']).default('US'),
  tags: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
});
export type ImportOptions = z.infer<typeof ImportOptionsSchema>;

export const ImportMappingInputSchema = z
  .object({
    entity: z.enum(IMPORT_ENTITIES),
    /** Column name → field key; columns left out or mapped to '' are ignored. */
    mapping: z.record(z.string(), z.string()),
    options: ImportOptionsSchema,
    version: z.number().int().positive(),
  })
  .superRefine((input, ctx) => {
    const keys = new Set(IMPORT_FIELDS[input.entity].map((f) => f.key));
    const chosen = Object.values(input.mapping).filter((v) => v !== '');
    for (const field of chosen) {
      if (!keys.has(field)) {
        ctx.addIssue({ code: 'custom', path: ['mapping'], message: `Unknown field "${field}".` });
      }
    }
    const seen = new Set<string>();
    for (const field of chosen) {
      if (seen.has(field)) {
        const label = IMPORT_FIELDS[input.entity].find((f) => f.key === field)?.label ?? field;
        ctx.addIssue({
          code: 'custom',
          path: ['mapping'],
          message: `${label} is chosen for more than one column.`,
        });
      }
      seen.add(field);
    }
    if (input.entity === 'contact') {
      if (!seen.has('email')) {
        ctx.addIssue({ code: 'custom', path: ['mapping'], message: 'Choose the email column.' });
      }
      if (!seen.has('fullName') && !(seen.has('firstName') && seen.has('lastName'))) {
        ctx.addIssue({
          code: 'custom',
          path: ['mapping'],
          message: 'Choose the first and last name columns, or a full name column.',
        });
      }
    } else if (!seen.has('name')) {
      ctx.addIssue({
        code: 'custom',
        path: ['mapping'],
        message: 'Choose the company name column.',
      });
    }
  });
export type ImportMappingInput = z.infer<typeof ImportMappingInputSchema>;

export const IMPORT_ROW_STATUSES = ['created', 'updated', 'duplicate', 'skipped', 'error'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];
export type ImportCounts = Partial<Record<ImportRowStatus, number>> & { probable?: number };

export const IMPORT_BATCH_STATUSES = [
  'uploaded',
  'mapped',
  'checking',
  'checked',
  'queued',
  'running',
  'completed',
  'failed',
  'rolling_back',
  'rolled_back',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export interface ImportUndoCounts {
  removed: number;
  reverted: number;
  kept: number;
  companiesRemoved: number;
  companiesKept: number;
}

/** One import as the API returns it. */
export interface ImportBatchView {
  id: string;
  entity: ImportEntity;
  filename: string;
  status: ImportBatchStatus;
  columns: string[];
  rowCount: number;
  sample: string[][];
  mapping: Record<string, string>;
  options: Partial<ImportOptions>;
  dryRunCounts: ImportCounts | null;
  counts: ImportCounts;
  undoCounts: ImportUndoCounts | null;
  processedRows: number;
  failureReason: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  rolledBackAt: string | null;
  /** When undo stops being possible; null when it can't be undone. */
  undoUntil: string | null;
  version: number;
}

export interface ImportRowView {
  rowNumber: number;
  status: ImportRowStatus;
  messages: string[];
  entityId: string | null;
  undoStatus: 'removed' | 'reverted' | 'kept' | null;
  /** The row's cells, in the file's column order. */
  cells: string[];
}

export const ImportVersionInputSchema = z.object({ version: z.number().int().positive() });
export type ImportVersionInput = z.infer<typeof ImportVersionInputSchema>;

export const ImportTemplateInputSchema = z.object({
  name: z.string().trim().min(1, 'Name the template').max(80, 'Use 80 characters or fewer'),
  entity: z.enum(IMPORT_ENTITIES),
  mapping: z.record(z.string(), z.string()),
});
export type ImportTemplateInput = z.infer<typeof ImportTemplateInputSchema>;
