import { z } from 'zod';

/** CSV exports of a list view (PRD 2.3, 4.9, 6.9). */

export const EXPORT_ENTITIES = ['lead', 'contact', 'company', 'deal'] as const;
export const ExportEntitySchema = z.enum(EXPORT_ENTITIES);
export type ExportEntity = z.infer<typeof ExportEntitySchema>;

/** Above this many rows an export needs export permission for everything, and admins hear of it. */
export const EXPORT_LARGE_ROWS = 1_000;
/** Above this many rows the file is built in the background (PRD 4.9). */
export const EXPORT_SYNC_MAX_ROWS = 5_000;
/** The most rows one export may hold; narrower filters are needed beyond this. */
export const EXPORT_MAX_ROWS = 100_000;
/** Export files are deleted after this many days. */
export const EXPORT_KEEP_DAYS = 7;

/**
 * POST /exports: the list view to export, exactly as the list endpoint takes it. The filter is
 * checked against the entity's field registry on the server.
 */
export const ExportCreateInputSchema = z
  .object({
    entity: ExportEntitySchema,
    q: z.string().trim().max(200).default(''),
    sort: z.string().max(40).optional(),
    filter: z.unknown().optional(),
  })
  .strict();
export type ExportCreateInput = z.input<typeof ExportCreateInputSchema>;

export const EXPORT_STATUSES = ['queued', 'building', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export interface ExportView {
  id: string;
  entity: ExportEntity;
  status: ExportStatus;
  /** Rows the view held when the export was asked for; the file's own count once ready. */
  rowCount: number;
  processedRows: number;
  /** Built in the background (more than EXPORT_SYNC_MAX_ROWS rows). */
  background: boolean;
  filename: string;
  createdAt: string;
  finishedAt: string | null;
  /** The file is deleted after this time. */
  expiresAt: string | null;
  failureReason: string | null;
}
