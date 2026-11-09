import {
  DuplicateListQuerySchema,
  MergeEntitySchema,
  MergeInputSchema,
  MergeUndoInputSchema,
  type DuplicateCandidateView,
  type DuplicateRecordView,
  type MergeEntity,
  type MergePreviewView,
  type MergeView,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from '../../platform/errors/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';
import { MERGE_UNDO_DAYS, MergeWriter, movedCounts, type MergeSnapshot } from '../crm/index.js';

/** The duplicate review queue, merges and undo (PRD 4.9; ADR 0009). */

type Row = Record<string, unknown>;
type Q = Pick<DbTx, 'query'>;

const TABLE: Record<MergeEntity, string> = { contact: 'contacts', company: 'companies' };
const WRITE: Record<MergeEntity, string> = {
  contact: 'contacts.write',
  company: 'companies.write',
};
const SCAN_STATE_KEY = 'job.duplicates_scan';
const DAY_MS = 86_400_000;

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through
  }
  throw new ValidationDomainError('This page link is not valid any more.', {
    cursor: ['Start again from the first page.'],
  });
}

/** Both scopes a merge needs: write access and the merge capability (PRD 2.2, 4.9). */
function mergeScope(
  user: SessionUser,
  entity: MergeEntity,
  alias: string,
  startParamIndex: number,
): { sql: string; params: unknown[] } {
  const write = scopeWhere(user, WRITE[entity], { alias, startParamIndex });
  const merge = scopeWhere(user, 'duplicates.merge', {
    alias,
    startParamIndex: startParamIndex + write.params.length,
  });
  return { sql: `(${write.sql} AND ${merge.sql})`, params: [...write.params, ...merge.params] };
}

export class DuplicateService {
  private readonly writer: MergeWriter;

  constructor(private readonly db: DatabaseService) {
    this.writer = new MergeWriter(db);
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  async list(
    user: SessionUser,
    rawQuery: URLSearchParams,
  ): Promise<{ items: DuplicateCandidateView[]; nextCursor: string | null }> {
    requireCapability(user, 'duplicates.merge');
    const query = DuplicateListQuerySchema.parse(Object.fromEntries(rawQuery.entries()));
    requireCapability(user, WRITE[query.entity]);
    const params: unknown[] = [];
    let cursorSql = '';
    if (query.cursor) {
      const [at, id] = decodeCursor(query.cursor);
      cursorSql = `AND (d.created_at, d.id) < ($CURSOR_AT::timestamptz, $CURSOR_ID::text)`;
      params.push(at, id);
    }
    const rows = await this.queueRows(this.db, user, query.entity, {
      extraSql: cursorSql,
      extraParams: params,
      limit: query.limit + 1,
    });
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.candidateView(query.entity, r)),
      nextCursor: more && last ? encodeCursor(String(last['at_cursor']), String(last['id'])) : null,
    };
  }

  async get(user: SessionUser, id: string): Promise<DuplicateCandidateView> {
    requireCapability(user, 'duplicates.merge');
    const entity = await this.candidateEntity(this.db, id);
    const rows = await this.queueRows(this.db, user, entity, {
      extraSql: 'AND d.id = $CURSOR_AT',
      extraParams: [id],
      limit: 1,
    });
    const row = rows[0];
    if (!row) throw new NotFoundDomainError('Duplicate', id);
    return this.candidateView(entity, row);
  }

  async dismiss(
    user: SessionUser,
    id: string,
    ip: string | null,
  ): Promise<{ id: string; status: 'dismissed' }> {
    requireCapability(user, 'duplicates.merge');
    return this.db.transaction(async (tx) => {
      const entity = await this.candidateEntity(tx, id);
      const rows = await this.queueRows(tx, user, entity, {
        extraSql: 'AND d.id = $CURSOR_AT',
        extraParams: [id],
        limit: 1,
        forUpdate: true,
      });
      const row = rows[0];
      if (!row) throw new NotFoundDomainError('Duplicate', id);
      await tx.query(
        `UPDATE duplicate_candidates SET status = 'dismissed', resolved_at = NOW(), resolved_by = $2
         WHERE id = $1`,
        [id, user.id],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'duplicate.dismissed',
        entityType: entity,
        entityId: String(row['a_id']),
        metadata: { candidateId: id, otherId: String(row['b_id']) },
        ipAddress: ip,
      });
      return { id, status: 'dismissed' as const };
    });
  }

  private async candidateEntity(q: Q, id: string): Promise<MergeEntity> {
    const res = await q.query<{ entity_type: string }>(
      `SELECT entity_type FROM duplicate_candidates WHERE id = $1`,
      [id],
    );
    const parsed = MergeEntitySchema.safeParse(res.rows[0]?.entity_type);
    if (!parsed.success) throw new NotFoundDomainError('Duplicate', id);
    return parsed.data;
  }

  /**
   * Open pairs where both records are live and inside the user's merge scope, newest first.
   * `$CURSOR_AT` and `$CURSOR_ID` in `extraSql` stand for the first two `extraParams`.
   */
  private async queueRows(
    q: Q,
    user: SessionUser,
    entity: MergeEntity,
    options: { extraSql: string; extraParams: unknown[]; limit: number; forUpdate?: boolean },
  ): Promise<Row[]> {
    const a = mergeScope(user, entity, 'a', 2);
    const b = mergeScope(user, entity, 'b', 2 + a.params.length);
    let next = 2 + a.params.length + b.params.length;
    const extraSql = options.extraSql
      .replace('$CURSOR_AT', () => `$${next}`)
      .replace('$CURSOR_ID', () => `$${next + 1}`);
    next += options.extraParams.length;
    const sides =
      entity === 'contact'
        ? `a.full_name AS a_name, a.primary_email AS a_detail, ca.name AS a_context,
           b.full_name AS b_name, b.primary_email AS b_detail, cb.name AS b_context`
        : `a.name AS a_name, a.domain AS a_detail,
           CONCAT_WS(', ', NULLIF(a.city, ''), a.market) AS a_context,
           b.name AS b_name, b.domain AS b_detail,
           CONCAT_WS(', ', NULLIF(b.city, ''), b.market) AS b_context`;
    const companyJoins =
      entity === 'contact'
        ? `LEFT JOIN companies ca ON ca.id = a.company_id
           LEFT JOIN companies cb ON cb.id = b.company_id`
        : '';
    const res = await q.query<Row>(
      `SELECT d.id, d.match_reason, d.confidence::float8 AS confidence, d.import_batch_id,
              d.created_at, d.created_at::text AS at_cursor,
              a.id AS a_id, a.created_at AS a_created, ua.name AS a_owner,
              b.id AS b_id, b.created_at AS b_created, ub.name AS b_owner,
              ${sides}
       FROM duplicate_candidates d
       JOIN ${TABLE[entity]} a ON a.id = d.left_entity_id AND a.deleted_at IS NULL
       JOIN ${TABLE[entity]} b ON b.id = d.right_entity_id AND b.deleted_at IS NULL
       ${companyJoins}
       LEFT JOIN users ua ON ua.id = a.owner_user_id
       LEFT JOIN users ub ON ub.id = b.owner_user_id
       WHERE d.entity_type = $1 AND d.status = 'open' AND ${a.sql} AND ${b.sql} ${extraSql}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT $${next}
       ${options.forUpdate ? 'FOR UPDATE OF d' : ''}`,
      [entity, ...a.params, ...b.params, ...options.extraParams, options.limit],
    );
    return res.rows;
  }

  private candidateView(entity: MergeEntity, r: Row): DuplicateCandidateView {
    const side = (p: 'a' | 'b'): DuplicateRecordView => ({
      id: String(r[`${p}_id`]),
      name: String(r[`${p}_name`] ?? ''),
      detail: (r[`${p}_detail`] as string | null) ?? null,
      context: (r[`${p}_context`] as string | null) || null,
      ownerName: (r[`${p}_owner`] as string | null) ?? null,
      createdAt: iso(r[`${p}_created`]),
    });
    return {
      id: String(r['id']),
      entity,
      reason: String(r['match_reason']),
      confidence: Number(r['confidence']),
      foundBy: r['import_batch_id'] ? 'import' : 'scan',
      createdAt: iso(r['created_at']),
      a: side('a'),
      b: side('b'),
    };
  }

  // -------------------------------------------------------------------------
  // Preview, merge and undo
  // -------------------------------------------------------------------------

  async preview(
    user: SessionUser,
    rawEntity: string,
    keptId: string,
    mergedId: string,
  ): Promise<MergePreviewView> {
    const entity = MergeEntitySchema.parse(rawEntity);
    requireCapability(user, 'duplicates.merge');
    if (!mergedId) {
      throw new ValidationDomainError('Choose the record to merge.', {
        with: ['Choose the record to merge.'],
      });
    }
    return this.writer.preview(this.db, user, entity, keptId, mergedId);
  }

  async merge(
    user: SessionUser,
    rawEntity: string,
    keptId: string,
    raw: unknown,
    ip: string | null,
  ): Promise<MergeView> {
    const entity = MergeEntitySchema.parse(rawEntity);
    requireCapability(user, 'duplicates.merge');
    const input = MergeInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      if (input.candidateId) {
        const pair = await tx.query(
          `SELECT 1 FROM duplicate_candidates
           WHERE id = $1 AND entity_type = $2
             AND ((left_entity_id = $3 AND right_entity_id = $4)
               OR (left_entity_id = $4 AND right_entity_id = $3))`,
          [input.candidateId, entity, keptId, input.mergedId],
        );
        if (!pair.rows[0]) {
          throw new ValidationDomainError('These two records are not this pair in the queue.', {
            candidateId: ['Open the pair from the duplicate queue again.'],
          });
        }
      }
      const result = await this.writer.merge(tx, user, entity, keptId, {
        mergedId: input.mergedId,
        keptVersion: input.keptVersion,
        mergedVersion: input.mergedVersion,
        take: input.take,
        candidateId: input.candidateId,
      });
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: `${entity}.merged`,
        entityType: entity,
        entityId: keptId,
        metadata: {
          mergeId: result.mergeId,
          mergedId: input.mergedId,
          fields: result.snapshot.fields,
          moved: Object.fromEntries(result.moved.map((m) => [m.label, m.count])),
        },
        ipAddress: ip,
      });
      await this.db.addOutboxEvent(tx, {
        eventType: `${entity}.merged`,
        aggregateType: entity,
        aggregateId: keptId,
        payload: { mergeId: result.mergeId, keptId, mergedId: input.mergedId },
      });
      return this.mergeView(tx, user, result.mergeId);
    });
  }

  async undo(user: SessionUser, mergeId: string, raw: unknown, ip: string | null) {
    requireCapability(user, 'duplicates.merge');
    MergeUndoInputSchema.parse(raw ?? {});
    return this.db.transaction(async (tx) => {
      const log = await this.visibleMerge(tx, user, mergeId, true);
      const entity = log.entity;
      if (log.row['undone_at']) {
        throw new DomainError({
          status: 409,
          code: 'MERGE_ALREADY_UNDONE',
          title: 'Already undone',
          detail: 'This merge has already been undone.',
        });
      }
      if (
        Date.now() - new Date(log.row['created_at'] as string).getTime() >
        MERGE_UNDO_DAYS * DAY_MS
      ) {
        throw new DomainError({
          status: 409,
          code: 'MERGE_UNDO_EXPIRED',
          title: 'Too late to undo',
          detail: `A merge can be undone for ${MERGE_UNDO_DAYS} days. This one is older.`,
        });
      }
      const snap = log.row['snapshot_json'] as Partial<MergeSnapshot>;
      if (snap.v !== 1) {
        throw new DomainError({
          status: 409,
          code: 'MERGE_UNDO_UNSUPPORTED',
          title: "Can't undo this merge",
          detail: 'This merge was made by an earlier version of the CRM and cannot be undone here.',
        });
      }
      const result = await this.writer.undo(
        tx,
        user,
        entity,
        String(log.row['survivor_id']),
        String(log.row['merged_id']),
        snap as MergeSnapshot,
      );
      await tx.query(
        `UPDATE merge_logs SET undone_at = NOW(), undone_by = $2, undo_result = $3::jsonb WHERE id = $1`,
        [mergeId, user.id, JSON.stringify({ keptFields: result.keptFields })],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: `${entity}.merge_undone`,
        entityType: entity,
        entityId: String(log.row['survivor_id']),
        metadata: { mergeId, mergedId: log.row['merged_id'], keptFields: result.keptFields },
        ipAddress: ip,
      });
      await this.db.addOutboxEvent(tx, {
        eventType: `${entity}.merge_undone`,
        aggregateType: entity,
        aggregateId: String(log.row['survivor_id']),
        payload: { mergeId, keptId: log.row['survivor_id'], mergedId: log.row['merged_id'] },
      });
      return this.mergeView(tx, user, mergeId);
    });
  }

  async listMerges(user: SessionUser, rawEntity: string | null): Promise<{ items: MergeView[] }> {
    requireCapability(user, 'duplicates.merge');
    const entity = MergeEntitySchema.parse(rawEntity ?? 'contact');
    requireCapability(user, WRITE[entity]);
    const scope = mergeScope(user, entity, 's', 2);
    const res = await this.db.query<{ id: string }>(
      `SELECT m.id FROM merge_logs m JOIN ${TABLE[entity]} s ON s.id = m.survivor_id
       WHERE m.entity_type = $1 AND ${scope.sql}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 50`,
      [entity, ...scope.params],
    );
    const items: MergeView[] = [];
    for (const row of res.rows) items.push(await this.mergeView(this.db, user, row.id));
    return { items };
  }

  async getMerge(user: SessionUser, mergeId: string): Promise<MergeView> {
    requireCapability(user, 'duplicates.merge');
    return this.mergeView(this.db, user, mergeId);
  }

  /** A merge the user may see: the kept record (live or not) is inside their merge scope. */
  private async visibleMerge(
    q: Q,
    user: SessionUser,
    mergeId: string,
    forUpdate = false,
  ): Promise<{ entity: MergeEntity; row: Row }> {
    const found = await q.query<{ entity_type: string }>(
      `SELECT entity_type FROM merge_logs WHERE id = $1`,
      [mergeId],
    );
    const parsed = MergeEntitySchema.safeParse(found.rows[0]?.entity_type);
    if (!parsed.success) throw new NotFoundDomainError('Merge', mergeId);
    const entity = parsed.data;
    const scope = mergeScope(user, entity, 's', 2);
    const res = await q.query<Row>(
      `SELECT m.*, s.deleted_at AS kept_deleted_at,
              ${entity === 'contact' ? 's.full_name' : 's.name'} AS kept_name,
              ua.name AS actor_name, uu.name AS undone_by_name
       FROM merge_logs m JOIN ${TABLE[entity]} s ON s.id = m.survivor_id
       LEFT JOIN users ua ON ua.id = m.actor_user_id
       LEFT JOIN users uu ON uu.id = m.undone_by
       WHERE m.id = $1 AND ${scope.sql}
       ${forUpdate ? 'FOR UPDATE OF m' : ''}`,
      [mergeId, ...scope.params],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundDomainError('Merge', mergeId);
    return { entity, row };
  }

  private async mergeView(q: Q, user: SessionUser, mergeId: string): Promise<MergeView> {
    const { entity, row } = await this.visibleMerge(q, user, mergeId);
    const snap = row['snapshot_json'] as Partial<MergeSnapshot>;
    const merged = (snap.merged ?? {}) as Row;
    const mergedAt = iso(row['created_at']);
    const undoResult = row['undo_result'] as { keptFields?: string[] } | null;
    return {
      id: mergeId,
      entity,
      kept: {
        id: String(row['survivor_id']),
        name: String(row['kept_name'] ?? ''),
        active: !row['kept_deleted_at'],
      },
      merged: {
        id: String(row['merged_id']),
        name: String((entity === 'contact' ? merged['full_name'] : merged['name']) ?? ''),
      },
      mergedBy: { id: String(row['actor_user_id']), name: String(row['actor_name'] ?? '') },
      mergedAt,
      undoUntil: new Date(Date.parse(mergedAt) + MERGE_UNDO_DAYS * DAY_MS).toISOString(),
      undoneAt: row['undone_at'] ? iso(row['undone_at']) : null,
      undoneBy: row['undone_by']
        ? { id: String(row['undone_by']), name: String(row['undone_by_name'] ?? '') }
        : null,
      moved:
        snap.v === 1 ? movedCounts(entity, snap as MergeSnapshot).filter((m) => m.count > 0) : [],
      keptFields: undoResult?.keptFields ?? [],
    };
  }

  // -------------------------------------------------------------------------
  // Background scan for probable duplicates among existing records
  // -------------------------------------------------------------------------

  /**
   * Checks contacts and companies changed since the last run against the probable-duplicate
   * rules and queues new pairs. Runs for at most `budgetMs`, then the next run carries on.
   */
  async scan(
    options: { budgetMs?: number; batchSize?: number } = {},
  ): Promise<{ checked: number; queued: number }> {
    const budgetMs = options.budgetMs ?? 20_000;
    const batchSize = options.batchSize ?? 500;
    const started = Date.now();
    let checked = 0;
    let queued = 0;
    for (const entity of ['contact', 'company'] as const) {
      let more = true;
      while (more && Date.now() - started <= budgetMs) {
        const batch = await this.db.transaction(async (tx) => {
          const state = await tx.query<{ value_json: Row }>(
            `SELECT value_json FROM settings WHERE key = $1 FOR UPDATE`,
            [SCAN_STATE_KEY],
          );
          const value = state.rows[0]?.value_json ?? {};
          const cursor = (value[entity] as { at: string; id: string } | null | undefined) ?? null;
          const result = await this.writer.scanBatch(tx, entity, cursor, batchSize);
          await tx.query(
            `INSERT INTO settings (key, value_json, updated_at) VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
            [SCAN_STATE_KEY, JSON.stringify({ ...value, [entity]: result.last })],
          );
          return result;
        });
        checked += batch.checked;
        queued += batch.queued;
        more = batch.checked === batchSize;
      }
    }
    return { checked, queued };
  }
}
