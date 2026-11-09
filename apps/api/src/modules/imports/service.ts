import { randomUUID } from 'node:crypto';
import {
  IMPORT_ROW_STATUSES,
  IMPORT_UNDO_DAYS,
  ImportMappingInputSchema,
  ImportTemplateInputSchema,
  ImportVersionInputSchema,
  suggestImportMapping,
  type ImportBatchView,
  type ImportEntity,
  type ImportRowView,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { type FileStorage } from '../../platform/files/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';
import { referenceList, resolveAssignee } from '../crm/index.js';
import { detectFormat, parseTable } from './parse.js';
import { errorsCsv } from './rows.js';

/**
 * Imports (PRD 4.9): upload → mapping → dry run → run → results, error file and undo. The
 * API only changes a batch's status; the worker does the row work (see processor.ts).
 */

type Row = Record<string, unknown>;

const SAMPLE_ROWS = 5;
const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

function conflict(code: string, detail: string) {
  return new DomainError({ status: 409, code, title: 'Conflict', detail });
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

export function toBatchView(row: Row): ImportBatchView {
  const finished = row['finished_at'] instanceof Date ? (row['finished_at'] as Date) : null;
  const undoable =
    finished &&
    (row['status'] === 'completed' || row['status'] === 'failed') &&
    row['started_at'] !== null;
  return {
    id: String(row['id']),
    entity: row['entity'] as ImportEntity,
    filename: String(row['filename']),
    status: row['status'] as ImportBatchView['status'],
    columns: (row['columns'] as string[]) ?? [],
    rowCount: Number(row['row_count']),
    sample: (row['sample'] as string[][]) ?? [],
    mapping: (row['mapping'] as Record<string, string>) ?? {},
    options: (row['options'] as ImportBatchView['options']) ?? {},
    dryRunCounts: (row['dry_run_counts'] as ImportBatchView['dryRunCounts']) ?? null,
    counts: (row['counts'] as ImportBatchView['counts']) ?? {},
    undoCounts: (row['undo_counts'] as ImportBatchView['undoCounts']) ?? null,
    processedRows: Number(row['processed_rows']),
    failureReason: (row['failure_reason'] as string | null) ?? null,
    createdBy: { id: String(row['created_by']), name: String(row['created_by_name'] ?? '') },
    createdAt: iso(row['created_at']) ?? '',
    startedAt: iso(row['started_at']),
    finishedAt: iso(row['finished_at']),
    rolledBackAt: iso(row['rolled_back_at']),
    undoUntil: undoable
      ? new Date(finished.getTime() + IMPORT_UNDO_DAYS * 86_400_000).toISOString()
      : null,
    version: Number(row['version']),
  };
}

const BATCH_SELECT = `SELECT b.*, u.name AS created_by_name
  FROM import_batches b JOIN users u ON u.id = b.created_by`;

export class ImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly files: FileStorage,
  ) {}

  /** Loads a batch the user may see, applying their scope in SQL (404 outside it). */
  private async batch(
    q: Pick<DbTx, 'query'>,
    user: SessionUser,
    id: string,
    forUpdate = false,
  ): Promise<Row> {
    const scope = scopeWhere(user, 'imports.run', {
      alias: 'b',
      ownerColumn: 'created_by',
      startParamIndex: 2,
    });
    const res = await q.query(
      `${BATCH_SELECT} WHERE b.id = $1 AND ${scope.sql} ${forUpdate ? 'FOR UPDATE OF b' : ''}`,
      [id, ...scope.params],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundDomainError('Import', id);
    return row;
  }

  async upload(
    user: SessionUser,
    filename: string,
    data: Buffer,
    ip: string | null,
  ): Promise<{ batch: ImportBatchView; suggested: Record<ImportEntity, Record<string, string>> }> {
    requireCapability(user, 'imports.run');
    const name = filename.replace(/[\\/]/g, '_').trim().slice(0, 200) || 'import';
    const format = detectFormat(data);
    if (!format) {
      throw new DomainError({
        status: 415,
        code: 'UNSUPPORTED_FILE_TYPE',
        title: 'Unsupported file type',
        detail: 'Upload a .csv file or an Excel workbook (.xlsx).',
        fieldErrors: { file: ['Upload a .csv file or an Excel workbook (.xlsx).'] },
      });
    }
    const table = await parseTable(data, format);
    if (table.rows.length === 0) {
      throw new ValidationDomainError('The file has no rows below the header.', {
        file: ['Add at least one row below the header row.'],
      });
    }
    const stored = await this.files.put('imports', format, data);
    try {
      const row = await this.db.transaction(async (tx) => {
        const fileId = `fil_${randomUUID()}`;
        await tx.query(
          `INSERT INTO files (id, storage_key, original_name, content_type, size_bytes, sha256,
                              purpose, owner_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'import', $7)`,
          [fileId, stored.key, name, CONTENT_TYPES[format], stored.size, stored.sha256, user.id],
        );
        const id = `imp_${randomUUID()}`;
        await tx.query(
          `INSERT INTO import_batches (id, filename, file_id, columns, row_count, sample,
                                       created_by, team_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)`,
          [
            id,
            name,
            fileId,
            JSON.stringify(table.columns),
            table.rows.length,
            JSON.stringify(table.rows.slice(0, SAMPLE_ROWS)),
            user.id,
            user.teamId,
          ],
        );
        await this.db.writeAuditLog(tx, {
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'import.uploaded',
          entityType: 'import_batch',
          entityId: id,
          metadata: { rows: table.rows.length, format, sizeBytes: stored.size },
          ipAddress: ip,
        });
        return this.batch(tx, user, id);
      });
      return {
        batch: toBatchView(row),
        suggested: {
          contact: suggestImportMapping('contact', table.columns),
          company: suggestImportMapping('company', table.columns),
        },
      };
    } catch (err) {
      await this.files.delete(stored.key).catch(() => undefined);
      throw err;
    }
  }

  async list(user: SessionUser): Promise<{ items: ImportBatchView[] }> {
    const scope = scopeWhere(user, 'imports.run', { alias: 'b', ownerColumn: 'created_by' });
    const res = await this.db.query(
      `${BATCH_SELECT} WHERE ${scope.sql} ORDER BY b.created_at DESC, b.id DESC LIMIT 50`,
      scope.params,
    );
    return { items: res.rows.map(toBatchView) };
  }

  async get(user: SessionUser, id: string): Promise<ImportBatchView> {
    return toBatchView(await this.batch(this.db, user, id));
  }

  /** Saves the column mapping and options; any earlier dry run no longer applies. */
  async setMapping(user: SessionUser, id: string, raw: unknown): Promise<ImportBatchView> {
    const input = ImportMappingInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await this.batch(tx, user, id, true);
      if (cur['version'] !== input.version) throw new VersionConflictError('Import', id);
      const status = String(cur['status']);
      if (!['uploaded', 'mapped', 'checked', 'failed'].includes(status) || cur['started_at']) {
        throw conflict(
          'IMPORT_ALREADY_RUN',
          'This import has already run, so its mapping is fixed.',
        );
      }
      const columns = cur['columns'] as string[];
      const mapping = Object.fromEntries(
        Object.entries(input.mapping).filter(([, field]) => field !== ''),
      );
      const unknown = Object.keys(mapping).filter((c) => !columns.includes(c));
      if (unknown.length > 0) {
        throw new ValidationDomainError('The mapping names columns that are not in the file.', {
          mapping: ['Some mapped columns are not in the file. Upload the file again.'],
        });
      }
      const sources = await referenceList(tx, 'lead_sources');
      const source = sources.find((s) => s.toLowerCase() === input.options.source.toLowerCase());
      if (!source) {
        throw new ValidationDomainError('Choose a lead source from the list.', {
          'options.source': ['Choose a lead source from the list.'],
        });
      }
      await resolveAssignee(
        tx,
        user,
        input.options.ownerUserId,
        input.entity === 'contact' ? 'contacts.write' : 'companies.write',
      );
      const options = { ...input.options, source };
      await tx.query(`DELETE FROM import_rows WHERE batch_id = $1 AND dry_run`, [id]);
      await tx.query(
        `UPDATE import_batches
         SET entity = $2, mapping = $3::jsonb, options = $4::jsonb, status = 'mapped',
             dry_run_counts = NULL, processed_rows = 0, failure_reason = NULL,
             version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [id, input.entity, JSON.stringify(mapping), JSON.stringify(options)],
      );
      return toBatchView(await this.batch(tx, user, id));
    });
  }

  /** Asks the worker for a dry run: every row is checked and nothing is saved. */
  async requestDryRun(user: SessionUser, id: string, raw: unknown): Promise<ImportBatchView> {
    const input = ImportVersionInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await this.batch(tx, user, id, true);
      if (cur['version'] !== input.version) throw new VersionConflictError('Import', id);
      if (!['mapped', 'checked', 'failed'].includes(String(cur['status'])) || cur['started_at']) {
        throw conflict('IMPORT_NOT_MAPPED', 'Map the columns before checking the file.');
      }
      if (Object.keys(cur['mapping'] as object).length === 0) {
        throw conflict('IMPORT_NOT_MAPPED', 'Map the columns before checking the file.');
      }
      await tx.query(`DELETE FROM import_rows WHERE batch_id = $1 AND dry_run`, [id]);
      await tx.query(
        `UPDATE import_batches
         SET status = 'checking', processed_rows = 0, dry_run_counts = NULL, heartbeat_at = NULL,
             failure_reason = NULL, version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [id],
      );
      return toBatchView(await this.batch(tx, user, id));
    });
  }

  /** Starts the real import. A finished dry run comes first (PRD 4.9 steps). */
  async requestRun(
    user: SessionUser,
    id: string,
    raw: unknown,
    ip: string | null,
  ): Promise<ImportBatchView> {
    const input = ImportVersionInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await this.batch(tx, user, id, true);
      if (cur['version'] !== input.version) throw new VersionConflictError('Import', id);
      if (cur['status'] !== 'checked') {
        throw conflict('IMPORT_NOT_CHECKED', 'Check the file with a dry run before importing.');
      }
      await tx.query(
        `UPDATE import_batches
         SET status = 'queued', processed_rows = 0, heartbeat_at = NULL, failure_reason = NULL,
             counts = '{}'::jsonb, version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [id],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'import.started',
        entityType: 'import_batch',
        entityId: id,
        metadata: {
          entity: cur['entity'],
          rows: cur['row_count'],
          dryRunCounts: cur['dry_run_counts'],
          duplicatePolicy: (cur['options'] as Row)['duplicatePolicy'],
        },
        ipAddress: ip,
      });
      return toBatchView(await this.batch(tx, user, id));
    });
  }

  /** Asks the worker to undo a finished import, within 7 days (PRD 4.9). */
  async requestUndo(
    user: SessionUser,
    id: string,
    raw: unknown,
    ip: string | null,
  ): Promise<ImportBatchView> {
    const input = ImportVersionInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await this.batch(tx, user, id, true);
      if (cur['version'] !== input.version) throw new VersionConflictError('Import', id);
      const view = toBatchView(cur);
      if (!view.undoUntil) {
        throw conflict('IMPORT_NOT_UNDOABLE', 'Only a finished import can be undone.');
      }
      if (new Date(view.undoUntil).getTime() < Date.now()) {
        throw conflict(
          'IMPORT_UNDO_EXPIRED',
          `Imports can be undone for ${IMPORT_UNDO_DAYS} days after they finish.`,
        );
      }
      await tx.query(
        `UPDATE import_batches
         SET status = 'rolling_back', rolled_back_by = $2, heartbeat_at = NULL,
             version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [id, user.id],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'import.undo_requested',
        entityType: 'import_batch',
        entityId: id,
        metadata: { counts: cur['counts'] },
        ipAddress: ip,
      });
      return toBatchView(await this.batch(tx, user, id));
    });
  }

  /** Row results of the latest pass (the real run once it has started, else the dry run). */
  async rows(
    user: SessionUser,
    id: string,
    query: URLSearchParams,
  ): Promise<{ items: ImportRowView[]; nextCursor: string | null }> {
    const cur = await this.batch(this.db, user, id);
    const dryRun = !cur['started_at'];
    const status = query.get('status');
    if (status && !(IMPORT_ROW_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationDomainError('Unknown row status.', { status: ['Unknown row status.'] });
    }
    const kept = query.get('undo') === 'kept';
    const after = Number.parseInt(query.get('cursor') ?? '0', 10) || 0;
    const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '50', 10) || 50, 1), 200);
    const res = await this.db.query<{
      row_number: number;
      status: ImportRowView['status'];
      errors: string[];
      entity_id: string | null;
      undo_status: ImportRowView['undoStatus'];
      raw: string[];
    }>(
      `SELECT row_number, status, errors, entity_id, undo_status, raw FROM import_rows
       WHERE batch_id = $1 AND dry_run = $2 AND row_number > $3
         AND ($4::text IS NULL OR status = $4) AND (NOT $5 OR undo_status = 'kept')
       ORDER BY row_number LIMIT $6`,
      [id, dryRun, after, status, kept, limit + 1],
    );
    const items = res.rows.slice(0, limit).map((r) => ({
      rowNumber: r.row_number,
      status: r.status,
      messages: r.errors,
      entityId: r.entity_id,
      undoStatus: r.undo_status,
      cells: r.raw,
    }));
    const last = items[items.length - 1];
    return { items, nextCursor: res.rows.length > limit && last ? String(last.rowNumber) : null };
  }

  /** The original rows that failed, with an Error column (PRD 4.9). Audited: it holds contact data. */
  async errorsFile(
    user: SessionUser,
    id: string,
    ip: string | null,
  ): Promise<{ filename: string; csv: string }> {
    return this.db.transaction(async (tx) => {
      const cur = await this.batch(tx, user, id);
      const dryRun = !cur['started_at'];
      const res = await tx.query<{ raw: string[]; errors: string[] }>(
        `SELECT raw, errors FROM import_rows
         WHERE batch_id = $1 AND dry_run = $2 AND status = 'error' ORDER BY row_number`,
        [id, dryRun],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'import.errors_downloaded',
        entityType: 'import_batch',
        entityId: id,
        metadata: { rows: res.rows.length, dryRun },
        ipAddress: ip,
      });
      const base = String(cur['filename']).replace(/\.[^.]+$/, '');
      return {
        filename: `${base}-errors.csv`,
        csv: errorsCsv(cur['columns'] as string[], res.rows),
      };
    });
  }

  async listTemplates(
    user: SessionUser,
    entity: string | null,
  ): Promise<{ items: { id: string; name: string; entity: ImportEntity; mapping: Row }[] }> {
    requireCapability(user, 'imports.run');
    const res = await this.db.query<{
      id: string;
      name: string;
      entity: ImportEntity;
      mapping: Row;
    }>(
      `SELECT id, name, entity, mapping FROM import_mapping_templates
       WHERE created_by = $1 AND ($2::text IS NULL OR entity = $2)
       ORDER BY LOWER(name)`,
      [user.id, entity],
    );
    return { items: res.rows };
  }

  /** Saves a mapping under a name; saving the same name again replaces it. */
  async saveTemplate(
    user: SessionUser,
    raw: unknown,
  ): Promise<{ id: string; name: string; entity: ImportEntity; mapping: Row }> {
    requireCapability(user, 'imports.run');
    const input = ImportTemplateInputSchema.parse(raw);
    const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([, f]) => f !== ''));
    const res = await this.db.query<{
      id: string;
      name: string;
      entity: ImportEntity;
      mapping: Row;
    }>(
      `INSERT INTO import_mapping_templates (id, name, entity, mapping, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (created_by, entity, LOWER(name))
       DO UPDATE SET mapping = EXCLUDED.mapping, name = EXCLUDED.name
       RETURNING id, name, entity, mapping`,
      [`imt_${randomUUID()}`, input.name, input.entity, JSON.stringify(mapping), user.id],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Template was not saved.');
    return row;
  }
}
