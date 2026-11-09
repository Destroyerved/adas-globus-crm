import { z } from 'zod';

/** Duplicate review and merge (PRD 4.9). */

export const MERGE_ENTITIES = ['contact', 'company'] as const;
export const MergeEntitySchema = z.enum(MERGE_ENTITIES);
export type MergeEntity = z.infer<typeof MergeEntitySchema>;

/** The fields a person chooses between when merging. Each is taken whole from one record. */
export const CONTACT_MERGE_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Primary email' },
  { key: 'phone', label: 'Phone' },
  { key: 'title', label: 'Title' },
  { key: 'jobFunction', label: 'Job function' },
  { key: 'seniority', label: 'Seniority' },
  { key: 'company', label: 'Company' },
  { key: 'market', label: 'Country' },
  { key: 'timezone', label: 'Time zone' },
  { key: 'owner', label: 'Owner' },
] as const;

export const COMPANY_MERGE_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'website', label: 'Website' },
  { key: 'firmType', label: 'Firm type' },
  { key: 'market', label: 'Country' },
  { key: 'region', label: 'State or province' },
  { key: 'city', label: 'City' },
  { key: 'timezone', label: 'Time zone' },
  { key: 'staffBand', label: 'Staff size' },
  { key: 'accountStatus', label: 'Account status' },
  { key: 'owner', label: 'Owner' },
  { key: 'software', label: 'Accounting software' },
  { key: 'services', label: 'Services needed' },
] as const;

export type ContactMergeField = (typeof CONTACT_MERGE_FIELDS)[number]['key'];
export type CompanyMergeField = (typeof COMPANY_MERGE_FIELDS)[number]['key'];

export function mergeFields(entity: MergeEntity): readonly { key: string; label: string }[] {
  return entity === 'contact' ? CONTACT_MERGE_FIELDS : COMPANY_MERGE_FIELDS;
}

export const MergeSideSchema = z.enum(['kept', 'merged']);
export type MergeSide = z.infer<typeof MergeSideSchema>;

/**
 * POST /contacts/:id/merge and /companies/:id/merge: `:id` is the record that stays. Fields
 * left out of `take` keep the kept record's value, or the merged record's when the kept one
 * is blank.
 */
export const MergeInputSchema = z.object({
  mergedId: z.string().min(1).max(80),
  keptVersion: z.number().int().positive(),
  mergedVersion: z.number().int().positive(),
  take: z.record(z.string(), MergeSideSchema).default({}),
  candidateId: z.string().min(1).max(80).optional(),
});
export type MergeInput = z.input<typeof MergeInputSchema>;

export const MergeUndoInputSchema = z.object({}).strict();

export const DuplicateListQuerySchema = z.object({
  entity: MergeEntitySchema.default('contact'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** One record in a duplicate pair, as the queue shows it. */
export interface DuplicateRecordView {
  id: string;
  name: string;
  /** Email for a contact, website domain for a company. */
  detail: string | null;
  /** Company name for a contact, city and country for a company. */
  context: string | null;
  ownerName: string | null;
  createdAt: string;
}

export interface DuplicateCandidateView {
  id: string;
  entity: MergeEntity;
  reason: string;
  confidence: number;
  /** "import" when an import found the pair, otherwise "scan". */
  foundBy: 'import' | 'scan';
  createdAt: string;
  a: DuplicateRecordView;
  b: DuplicateRecordView;
}

/** One side of the compare view. */
export interface MergeRecordView {
  id: string;
  version: number;
  name: string;
  createdAt: string;
  /** Display text per merge field; null when blank. */
  fields: Record<string, string | null>;
  /** What is linked to this record and would move to the kept one. */
  linked: { label: string; count: number }[];
  doNotContact: boolean;
}

export interface MergePreviewView {
  entity: MergeEntity;
  fields: { key: string; label: string }[];
  kept: MergeRecordView;
  merged: MergeRecordView;
  /** The suggested source for each field. */
  defaults: Record<string, MergeSide>;
  /** Plain-language notes about what will happen besides the chosen fields. */
  notes: string[];
}

export interface MergeView {
  id: string;
  entity: MergeEntity;
  kept: { id: string; name: string; active: boolean };
  merged: { id: string; name: string };
  mergedBy: { id: string; name: string };
  mergedAt: string;
  /** Undo is possible until this time (30 days). */
  undoUntil: string;
  undoneAt: string | null;
  undoneBy: { id: string; name: string } | null;
  moved: { label: string; count: number }[];
  /** After an undo: fields of the kept record that had been edited since and were left. */
  keptFields: string[];
}
