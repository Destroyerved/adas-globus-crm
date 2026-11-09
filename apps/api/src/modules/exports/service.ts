import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import {
  EXPORT_KEEP_DAYS,
  EXPORT_LARGE_ROWS,
  EXPORT_MAX_ROWS,
  EXPORT_SYNC_MAX_ROWS,
  ExportCreateInputSchema,
  formatNumber,
  formatSpreadsheetDateTime,
  type ExportEntity,
  type ExportStatus,
  type ExportView,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import { DomainError, NotFoundDomainError } from '../../platform/errors/index.js';
import { type FileStorage } from '../../platform/files/index.js';
import { getCapabilityScope, requireCapability } from '../../platform/scope/index.js';
import { type CrmListService } from '../crm/index.js';
import { addNotification } from '../notifications/index.js';
import { CSV_BOM, csvLine } from './csv.js';

/**
 * CSV exports of a list view (PRD 2.3, 4.9, 6.9, 9; ADR 0010).
 *
 * - The rows are the list's own query: the same search, filter, sort and read scope, with the
 *   `exports.run` scope applied on top, all in SQL.
 * - More than 1,000 rows needs `exports.run` with scope `all`, and alerts every admin.
 * - Up to 5,000 rows are written while the person waits; larger exports are built by the
 *   `export.build` job, which notifies them when the file is ready.
 * - Files are kept for 7 days and served only to the person who asked, after a permission
 *   check. Every export and download is audited, with counts and field names only.
 */

type Row = Record<string, unknown>;

const PAGE_SIZE = 1_000;
const STALE_SECONDS = 120;
const FAILED =
  'The export stopped because of an unexpected error. Try again, or narrow the filters.';

interface StoredRequest {
  q: string;
  sort?: string;
  filter?: unknown;
}

/** The field names a filter uses, for the audit log (never the values, which may be personal). */
function filterFields(filter: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    const obj = node as Row;
    if (typeof obj['field'] === 'string' && obj['field'].length <= 40) found.add(obj['field']);
    for (const key of ['and', 'or']) {
      if (Array.isArray(obj[key])) (obj[key] as unknown[]).forEach((n) => walk(n, depth + 1));
    }
  };
  walk(filter, 0);
  return [...found].sort();
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export class ExportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly files: FileStorage,
    private readonly lists: CrmListService,
    /** Loads a person with their current role, for the worker (deactivated people throw). */
    private readonly loadUser: (userId: string) => Promise<SessionUser>,
    private readonly logger: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  async create(user: SessionUser, raw: unknown, ip: string | null): Promise<ExportView> {
    requireCapability(user, 'exports.run');
    const input = ExportCreateInputSchema.parse(raw);
    const view: StoredRequest = { q: input.q, sort: input.sort, filter: input.filter ?? null };
    const timeZone = user.timezone ?? 'UTC';

    // Counting runs the real query, so a bad filter or sort is refused here.
    const { total } = await this.lists.exportPage(
      input.entity,
      user,
      view,
      { cursor: null, limit: 1, withTotal: true },
      timeZone,
    );
    this.checkSize(user, input.entity, total);

    const background = total > EXPORT_SYNC_MAX_ROWS;
    const id = `exp_${randomUUID()}`;
    const row = await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO exports (id, entity, status, request, row_count, background, requested_by,
                              team_id, heartbeat_at, started_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8,
                 CASE WHEN $6 THEN NULL ELSE NOW() END, CASE WHEN $6 THEN NULL ELSE NOW() END)
         RETURNING *`,
        [
          id,
          input.entity,
          background ? 'queued' : 'building',
          JSON.stringify(view),
          total,
          background,
          user.id,
          user.teamId,
        ],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'export.created',
        entityType: 'export',
        entityId: id,
        metadata: {
          entity: input.entity,
          rows: total,
          background,
          searched: input.q !== '',
          filterFields: filterFields(input.filter),
          sort: input.sort ?? null,
        },
        ipAddress: ip,
      });
      return inserted.rows[0] as Row;
    });

    if (background) return this.view(row, timeZone);
    try {
      return this.view(await this.build(row, user, { notifyRequester: false }), timeZone);
    } catch (err) {
      await this.fail(id, err);
      throw err;
    }
  }

  async get(user: SessionUser, id: string): Promise<ExportView> {
    return this.view(await this.own(user, id), user.timezone ?? 'UTC');
  }

  /** The file, for the person who asked for it only, while it is kept. */
  async download(
    user: SessionUser,
    id: string,
    ip: string | null,
  ): Promise<{ filename: string; csv: Buffer }> {
    requireCapability(user, 'exports.run');
    const row = await this.own(user, id);
    const status = String(row['status']) as ExportStatus;
    if (status === 'expired') {
      throw new DomainError({
        status: 410,
        code: 'EXPORT_EXPIRED',
        title: 'Export deleted',
        detail: `Export files are deleted after ${EXPORT_KEEP_DAYS} days. Export the list again.`,
      });
    }
    if (status !== 'ready') {
      throw new DomainError({
        status: 409,
        code: 'EXPORT_NOT_READY',
        title: 'Export not ready',
        detail:
          status === 'failed'
            ? 'This export failed. Export the list again.'
            : 'This export is still being prepared.',
      });
    }
    const file = await this.db.query<{ storage_key: string }>(
      `SELECT storage_key FROM files WHERE id = $1 AND deleted_at IS NULL`,
      [row['file_id']],
    );
    const key = file.rows[0]?.storage_key;
    if (!key) throw new NotFoundDomainError('Export', id);
    const csv = await this.files.get(key);
    await this.db.transaction((tx) =>
      this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'export.downloaded',
        entityType: 'export',
        entityId: id,
        metadata: { entity: row['entity'], rows: Number(row['row_count']) },
        ipAddress: ip,
      }),
    );
    return { filename: this.filename(row, user.timezone ?? 'UTC'), csv };
  }

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  /**
   * The `export.build` job: builds the oldest waiting export, or one whose builder stopped.
   * The requester's current role applies, so access removed since the request is respected.
   */
  async processNext(): Promise<{ exports: number }> {
    const claimed = await this.db.query(
      `UPDATE exports e
       SET status = 'building', heartbeat_at = NOW(), updated_at = NOW(),
           started_at = COALESCE(e.started_at, NOW())
       WHERE e.id = (
         SELECT id FROM exports
         WHERE status IN ('queued', 'building')
           AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - make_interval(secs => $1))
         ORDER BY created_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
       RETURNING e.*`,
      [STALE_SECONDS],
    );
    const row = claimed.rows[0];
    if (!row) return { exports: 0 };
    const id = String(row['id']);
    try {
      const user = await this.loadUser(String(row['requested_by']));
      if (getCapabilityScope(user, 'exports.run') === 'none') {
        throw new DomainError({
          status: 403,
          code: 'EXPORT_ACCESS_REMOVED',
          title: 'Export stopped',
          detail: 'The export was stopped because you no longer have permission to export.',
        });
      }
      this.checkSize(user, row['entity'] as ExportEntity, Number(row['row_count']));
      await this.build(row, user, { notifyRequester: true });
    } catch (err) {
      await this.fail(id, err);
    }
    return { exports: 1 };
  }

  /** Deletes files past their 7 days (run hourly by `housekeeping.purge`). */
  async purgeExpired(limit = 200): Promise<number> {
    const due = await this.db.query<{ id: string; file_id: string; storage_key: string }>(
      `SELECT e.id, f.id AS file_id, f.storage_key
       FROM exports e JOIN files f ON f.id = e.file_id
       WHERE e.status = 'ready' AND e.expires_at < NOW()
       ORDER BY e.expires_at
       LIMIT $1`,
      [limit],
    );
    for (const item of due.rows) {
      await this.files.delete(item.storage_key);
      await this.db.transaction(async (tx) => {
        await tx.query(`UPDATE files SET deleted_at = NOW() WHERE id = $1`, [item.file_id]);
        await tx.query(`UPDATE exports SET status = 'expired', updated_at = NOW() WHERE id = $1`, [
          item.id,
        ]);
      });
    }
    return due.rows.length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private checkSize(user: SessionUser, entity: ExportEntity, total: number): void {
    const plural = this.lists.exportPlural(entity);
    if (total === 0) {
      throw new DomainError({
        status: 422,
        code: 'EXPORT_EMPTY',
        title: 'Nothing to export',
        detail: `There are no ${plural} in this view.`,
      });
    }
    if (total > EXPORT_MAX_ROWS) {
      throw new DomainError({
        status: 422,
        code: 'EXPORT_TOO_LARGE',
        title: 'Export too large',
        detail: `This view has ${formatNumber(total)} ${plural}. An export can hold up to ${formatNumber(EXPORT_MAX_ROWS)}: narrow the filters.`,
      });
    }
    // PRD 2.3: exports above 1,000 rows need export permission for everything.
    if (total > EXPORT_LARGE_ROWS && getCapabilityScope(user, 'exports.run') !== 'all') {
      throw new DomainError({
        status: 403,
        code: 'EXPORT_NEEDS_ALL_SCOPE',
        title: 'Export too large for your role',
        detail: `Exports of more than ${formatNumber(EXPORT_LARGE_ROWS)} rows need permission to export all records. Narrow the filters to ${formatNumber(EXPORT_LARGE_ROWS)} or fewer, or ask an admin.`,
      });
    }
  }

  private async own(user: SessionUser, id: string): Promise<Row> {
    const res = await this.db.query(`SELECT * FROM exports WHERE id = $1 AND requested_by = $2`, [
      id,
      user.id,
    ]);
    const row = res.rows[0];
    if (!row) throw new NotFoundDomainError('Export', id);
    return row;
  }

  /** Writes the CSV, stores it, marks the export ready and sends the notifications. */
  private async build(
    row: Row,
    user: SessionUser,
    options: { notifyRequester: boolean },
  ): Promise<Row> {
    const id = String(row['id']);
    const entity = row['entity'] as ExportEntity;
    const request = row['request'] as StoredRequest;
    const timeZone = user.timezone ?? 'UTC';

    const parts: string[] = [CSV_BOM, csvLine(this.lists.exportHeader(entity, timeZone))];
    let written = 0;
    let cursor: string | null = null;
    do {
      const page = await this.lists.exportPage(
        entity,
        user,
        { q: request.q ?? '', sort: request.sort, filter: request.filter ?? null },
        { cursor, limit: PAGE_SIZE, withTotal: false },
        timeZone,
      );
      for (const cells of page.rows) parts.push(csvLine(cells));
      written += page.rows.length;
      cursor = page.nextCursor;
      await this.db.query(
        `UPDATE exports SET processed_rows = $2, heartbeat_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [id, written],
      );
    } while (cursor && written < EXPORT_MAX_ROWS);

    const stored = await this.files.put('exports', 'csv', Buffer.from(parts.join(''), 'utf8'));
    const filename = this.filename(row, timeZone);
    const plural = this.lists.exportPlural(entity);
    try {
      return await this.db.transaction(async (tx) => {
        const fileId = `fil_${randomUUID()}`;
        await tx.query(
          `INSERT INTO files (id, storage_key, original_name, content_type, size_bytes, sha256,
                              purpose, owner_user_id)
           VALUES ($1, $2, $3, 'text/csv', $4, $5, 'export', $6)`,
          [fileId, stored.key, filename, stored.size, stored.sha256, user.id],
        );
        const updated = await tx.query(
          `UPDATE exports
           SET status = 'ready', file_id = $2, row_count = $3, processed_rows = $3,
               heartbeat_at = NULL, finished_at = NOW(), updated_at = NOW(),
               expires_at = NOW() + make_interval(days => $4)
           WHERE id = $1
           RETURNING *`,
          [id, fileId, written, EXPORT_KEEP_DAYS],
        );
        if (options.notifyRequester) {
          await addNotification(tx, {
            userId: user.id,
            kind: 'export_ready',
            title: 'Your export is ready',
            body: `${formatNumber(written)} ${plural}. Download it within ${EXPORT_KEEP_DAYS} days.`,
            entityType: 'export',
            entityId: id,
            dedupeKey: `export_ready:${id}`,
          });
        }
        if (written > EXPORT_LARGE_ROWS) await this.alertAdmins(tx, user, id, written, plural);
        return updated.rows[0] as Row;
      });
    } catch (err) {
      await this.files.delete(stored.key);
      throw err;
    }
  }

  /** PRD 2.3, 9: admins hear of every export above 1,000 rows. */
  private async alertAdmins(
    tx: DbTx,
    user: SessionUser,
    id: string,
    rows: number,
    plural: string,
  ): Promise<void> {
    const admins = await tx.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'Admin' AND u.status = 'active' AND u.id <> $1`,
      [user.id],
    );
    for (const admin of admins.rows) {
      await addNotification(tx, {
        userId: admin.id,
        kind: 'security',
        title: 'Large export',
        body: `${user.name} exported ${formatNumber(rows)} ${plural}.`,
        entityType: 'user',
        entityId: user.id,
        dedupeKey: `export_large:${id}:${admin.id}`,
      });
    }
  }

  private async fail(id: string, err: unknown): Promise<void> {
    const e = err as { name?: string; code?: string };
    // A refusal (the person lost access since asking) is shown as it is; anything else is
    // logged by class and code only, never with row data.
    const reason = err instanceof DomainError ? err.message : FAILED;
    if (!(err instanceof DomainError)) {
      this.logger.error({ exportId: id, err: { name: e.name, code: e.code } }, 'export failed');
    }
    await this.db.query(
      `UPDATE exports SET status = 'failed', failure_reason = $2, heartbeat_at = NULL,
              finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status <> 'ready'`,
      [id, reason],
    );
  }

  private filename(row: Row, timeZone: string): string {
    const day = formatSpreadsheetDateTime(iso(row['created_at']) ?? new Date(), timeZone).slice(
      0,
      10,
    );
    return `${this.lists.exportPlural(row['entity'] as ExportEntity)}-${day}.csv`;
  }

  private view(row: Row, timeZone: string): ExportView {
    const status = String(row['status']) as ExportStatus;
    return {
      id: String(row['id']),
      entity: row['entity'] as ExportEntity,
      status,
      rowCount: Number(row['row_count']),
      processedRows: Number(row['processed_rows']),
      background: Boolean(row['background']),
      filename: this.filename(row, timeZone),
      createdAt: iso(row['created_at']) ?? '',
      finishedAt: iso(row['finished_at']),
      expiresAt: status === 'ready' ? iso(row['expires_at']) : null,
      failureReason:
        status === 'failed' ? ((row['failure_reason'] as string | null) ?? null) : null,
    };
  }
}
