import { z } from 'zod';
import { LeadSystemStatusSchema } from './enums.js';

/**
 * Saved views (PRD 4.8) and bulk actions (PRD 4.5, 4.6, 6.7).
 */

export const SAVED_VIEW_ENTITIES = ['lead', 'contact', 'company', 'deal'] as const;
export const SavedViewEntitySchema = z.enum(SAVED_VIEW_ENTITIES);
export type SavedViewEntity = z.infer<typeof SavedViewEntitySchema>;

export const TABLE_DENSITIES = ['comfortable', 'compact'] as const;
export const TableDensitySchema = z.enum(TABLE_DENSITIES);
export type TableDensity = z.infer<typeof TableDensitySchema>;

const ParamsRecordSchema = z
  .record(z.string().trim().min(1).max(40), z.string().max(400))
  .refine((r) => Object.keys(r).length <= 24, 'Too many view parameters.');

export const CreateSavedViewInputSchema = z
  .object({
    entityType: SavedViewEntitySchema,
    name: z.string().trim().min(1, 'Enter a view name.').max(80),
    isShared: z.boolean().default(false),
    params: ParamsRecordSchema.default({}),
    filter: z.unknown().nullable().optional(),
    sort: z.string().trim().min(1).max(40).default('-updatedAt'),
    columns: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
    density: TableDensitySchema.default('comfortable'),
  })
  .strict();
export type CreateSavedViewInput = z.input<typeof CreateSavedViewInputSchema>;

export const UpdateSavedViewInputSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1, 'Enter a view name.').max(80).optional(),
    isShared: z.boolean().optional(),
    params: ParamsRecordSchema.optional(),
    filter: z.unknown().nullable().optional(),
    sort: z.string().trim().min(1).max(40).optional(),
    columns: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    density: TableDensitySchema.optional(),
  })
  .strict();
export type UpdateSavedViewInput = z.input<typeof UpdateSavedViewInputSchema>;

export interface SavedView {
  id: string;
  entityType: SavedViewEntity;
  name: string;
  ownerUserId: string;
  ownerName: string;
  teamId: string | null;
  isShared: boolean;
  params: Record<string, string>;
  filter: unknown;
  sort: string;
  columns: string[];
  density: TableDensity;
  version: number;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Bulk actions (PRD 4.5, 4.6, 6.7)
// ---------------------------------------------------------------------------

/** Above this count a bulk action runs asynchronously in the worker (PRD 6.7). */
export const BULK_SYNC_MAX_ROWS = 500;
/** Hard upper bound on a single bulk action to guard accidental table-wide wipes. */
export const BULK_MAX_ROWS = 25_000;

export const BULK_ACTION_TYPES = ['assign', 'status', 'add_tag', 'remove_tag', 'delete'] as const;
export const BulkActionTypeSchema = z.enum(BULK_ACTION_TYPES);
export type BulkActionType = z.infer<typeof BulkActionTypeSchema>;

export const BulkActionInputSchema = z
  .object({
    action: BulkActionTypeSchema,
    /** Explicit record IDs to act on (mutually exclusive with `selectAll: true`). */
    ids: z.array(z.string().trim().min(1).max(80)).min(1).max(BULK_MAX_ROWS).optional(),
    /** Act on all records matching the current search and filter within the user's scope. */
    selectAll: z.boolean().default(false),
    q: z.string().trim().max(200).default(''),
    filter: z.unknown().nullable().optional(),
    /** Required when `action === 'assign'`. */
    ownerUserId: z.string().trim().min(1).max(80).optional(),
    /** Required when `action === 'status'` (leads only). */
    status: LeadSystemStatusSchema.optional(),
    disqualificationReason: z.string().trim().max(160).nullable().optional(),
    statusNote: z.string().trim().max(2000).nullable().optional(),
    /** Required when `action === 'add_tag' | 'remove_tag'`. */
    tag: z.string().trim().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasIds = Array.isArray(val.ids) && val.ids.length > 0;
    if (!hasIds && !val.selectAll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ids'],
        message: 'Select at least one record.',
      });
    }
    if (hasIds && val.selectAll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectAll'],
        message: 'Choose either specific records or select all matching.',
      });
    }
    if (val.action === 'assign' && !val.ownerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerUserId'],
        message: 'Choose an owner.',
      });
    }
    if (val.action === 'status') {
      if (!val.status) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'Choose a lead status.',
        });
      } else if (val.status === 'Converted') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'Use Convert to turn a lead into a deal.',
        });
      }
    }
    if ((val.action === 'add_tag' || val.action === 'remove_tag') && !val.tag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tag'],
        message: 'Enter a tag name.',
      });
    }
  });
export type BulkActionInput = z.input<typeof BulkActionInputSchema>;

export const BULK_JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type BulkJobStatus = (typeof BULK_JOB_STATUSES)[number];

export interface BulkJobView {
  id: string;
  entity: SavedViewEntity;
  action: BulkActionType;
  status: BulkJobStatus;
  background: boolean;
  totalRows: number;
  processedRows: number;
  succeededRows: number;
  skippedRows: number;
  failureReason: string | null;
  createdAt: string;
  finishedAt: string | null;
}
