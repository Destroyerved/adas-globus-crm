import { randomUUID } from 'node:crypto';
import { type Logger } from 'pino';
import {
  BULK_MAX_ROWS,
  BULK_SYNC_MAX_ROWS,
  BulkActionInputSchema,
  SavedViewEntitySchema,
  formatNumber,
  type BulkActionType,
  type BulkJobStatus,
  type BulkJobView,
  type LeadSystemStatus,
  type SavedViewEntity,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from '../../platform/errors/index.js';
import { SqlParams, compileFilter, type ListSpec } from '../../platform/list/index.js';
import { getCapabilityScope, requireCapability, scopeWhere } from '../../platform/scope/index.js';
import { addNotification } from '../notifications/index.js';
import {
  RECORD_TABLES,
  insertActivity,
  referenceList,
  resolveAssignee,
  type AssigneeRow,
} from './access.js';
import { COMPANY_LIST, CONTACT_LIST, DEAL_LIST, LEAD_LIST } from './lists.js';
import { leadStatusCategory } from './records.js';

/**
 * Bulk actions on leads, contacts, companies and deals (PRD 4.5, 4.6, 6.7, 9).
 *
 * - Every query applies the caller's SQL scope (`scopeWhere`) for the governing capability.
 * - Up to 500 records execute synchronously; larger selections queue in `bulk_jobs` and run in
 *   chunks on the `bulk.execute` worker queue, re-checking the requester's live permissions.
 */

type Row = Record<string, unknown>;

const CHUNK_SIZE = 250;
const STALE_SECONDS = 120;

const ENTITY_CONFIG: Record<
  SavedViewEntity,
  {
    table: string;
    alias: string;
    plural: string;
    read: string;
    write: string;
    assign: string;
    spec: ListSpec;
  }
> = {
  lead: {
    table: 'leads',
    alias: 'l',
    plural: 'leads',
    read: 'leads.read',
    write: 'leads.write',
    assign: 'leads.assign',
    spec: LEAD_LIST,
  },
  contact: {
    table: 'contacts',
    alias: 'c',
    plural: 'contacts',
    read: 'contacts.read',
    write: 'contacts.write',
    assign: 'contacts.write',
    spec: CONTACT_LIST,
  },
  company: {
    table: 'companies',
    alias: 'c',
    plural: 'companies',
    read: 'companies.read',
    write: 'companies.write',
    assign: 'companies.write',
    spec: COMPANY_LIST,
  },
  deal: {
    table: 'deals',
    alias: 'd',
    plural: 'deals',
    read: 'deals.read',
    write: 'deals.write',
    assign: 'deals.write',
    spec: DEAL_LIST,
  },
};

interface StoredSelection {
  ids?: string[];
  selectAll?: boolean;
  q?: string;
  filter?: unknown;
}

interface StoredPayload {
  ownerUserId?: string;
  status?: LeadSystemStatus;
  disqualificationReason?: string | null;
  statusNote?: string | null;
  tag?: string;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function capabilityForAction(entity: SavedViewEntity, action: BulkActionType): string {
  const cfg = ENTITY_CONFIG[entity];
  if (action === 'delete') return 'records.delete';
  if (action === 'assign') return cfg.assign;
  return cfg.write;
}

export class BulkActionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly loadUser: (userId: string) => Promise<SessionUser>,
    private readonly logger: Logger,
  ) {}

  async submit(
    user: SessionUser,
    rawEntity: string,
    rawBody: unknown,
    ipAddress: string | null,
  ): Promise<BulkJobView> {
    const entity = SavedViewEntitySchema.parse(rawEntity);
    const input = BulkActionInputSchema.parse(rawBody);
    const cfg = ENTITY_CONFIG[entity];

    if (input.action === 'status' && entity !== 'lead') {
      throw new ValidationDomainError('Status changes are only supported on leads.', {
        action: ['Status changes apply to leads only.'],
      });
    }

    const actionCap = capabilityForAction(entity, input.action);
    requireCapability(user, cfg.read);
    requireCapability(user, actionCap);

    let normalizedTag: string | undefined;
    if (input.action === 'add_tag' || input.action === 'remove_tag') {
      normalizedTag = (input.tag ?? '').trim().toLowerCase();
      if (!normalizedTag) {
        throw new ValidationDomainError('Enter a tag name.', { tag: ['Enter a tag name.'] });
      }
    }

    let dqReason: string | null = null;
    if (input.action === 'status') {
      if (input.status === 'Disqualified') {
        const reasons = await referenceList(this.db, 'disqualify_reasons');
        const candidate = input.disqualificationReason?.trim() ?? '';
        if (!candidate || (reasons.length > 0 && !reasons.includes(candidate))) {
          throw new ValidationDomainError('Choose why these leads are disqualified.', {
            disqualificationReason: ['Choose a reason from the list.'],
          });
        }
        dqReason = candidate;
      }
    }

    if (input.action === 'assign' && input.ownerUserId) {
      await resolveAssignee(this.db, user, input.ownerUserId, actionCap);
    }

    const selection: StoredSelection = input.selectAll
      ? { selectAll: true, q: input.q, filter: input.filter ?? null }
      : { ids: [...new Set(input.ids ?? [])] };

    const matchingIds = await this.resolveTargetIds(user, entity, actionCap, selection);
    const requestedCount = selection.ids ? selection.ids.length : matchingIds.length;
    if (matchingIds.length === 0) {
      throw new ValidationDomainError('No matching records in your scope.', {
        ids: ['Select at least one record you have permission to update.'],
      });
    }
    if (matchingIds.length > BULK_MAX_ROWS) {
      throw new DomainError({
        status: 422,
        code: 'BULK_TOO_LARGE',
        title: 'Too many records selected',
        detail: `Narrow the filters to ${formatNumber(BULK_MAX_ROWS)} ${cfg.plural} or fewer.`,
      });
    }

    const initialSkipped = Math.max(0, requestedCount - matchingIds.length);
    const background = matchingIds.length > BULK_SYNC_MAX_ROWS;
    const payload: StoredPayload = {
      ownerUserId: input.ownerUserId,
      status: input.status,
      disqualificationReason: dqReason,
      statusNote: input.statusNote ?? null,
      tag: normalizedTag,
    };

    const jobId = `blk_${randomUUID()}`;
    const storedSelection: StoredSelection = { ids: matchingIds };
    const createdRow = await this.db.transaction(async (tx) => {
      const inserted = await tx.query<Row>(
        `INSERT INTO bulk_jobs (
           id, entity, action, status, background, selection_json, payload_json,
           total_rows, skipped_rows, requested_by, team_id, started_at, heartbeat_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
           $8, $9, $10, $11,
           CASE WHEN $5 THEN NULL ELSE NOW() END,
           CASE WHEN $5 THEN NULL ELSE NOW() END
         ) RETURNING *`,
        [
          jobId,
          entity,
          input.action,
          background ? 'queued' : 'running',
          background,
          JSON.stringify(storedSelection),
          JSON.stringify(payload),
          matchingIds.length,
          initialSkipped,
          user.id,
          user.teamId,
        ],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'bulk.submitted',
        entityType: 'bulk_job',
        entityId: jobId,
        metadata: {
          entity,
          bulkAction: input.action,
          totalRows: matchingIds.length,
          skippedOutOfScope: initialSkipped,
          background,
        },
        ipAddress,
      });
      return inserted.rows[0] as Row;
    });

    if (background) {
      return this.toView(createdRow);
    }

    try {
      const finished = await this.executeJob(createdRow, user, ipAddress, false);
      return this.toView(finished);
    } catch (err) {
      await this.failJob(jobId, err);
      throw err;
    }
  }

  async getJob(user: SessionUser, jobId: string): Promise<BulkJobView> {
    const res = await this.db.query<Row>(`SELECT * FROM bulk_jobs WHERE id = $1`, [jobId]);
    const row = res.rows[0];
    if (!row) throw new NotFoundDomainError('Bulk job', jobId);
    const isAdmin = getCapabilityScope(user, 'settings.manage') === 'all';
    if (row['requested_by'] !== user.id && !isAdmin) {
      throw new NotFoundDomainError('Bulk job', jobId);
    }
    return this.toView(row);
  }

  /** Worker entry point (`bulk.execute` queue): claims one queued or stalled background job. */
  async processNext(): Promise<{ jobId: string | null; status: string }> {
    const claimed = await this.db.transaction(async (tx) => {
      const res = await tx.query<Row>(
        `SELECT * FROM bulk_jobs
         WHERE status = 'queued'
            OR (status = 'running' AND background = TRUE
                AND heartbeat_at < NOW() - ($1 || ' seconds')::interval)
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [String(STALE_SECONDS)],
      );
      const row = res.rows[0];
      if (!row) return null;
      const updated = await tx.query<Row>(
        `UPDATE bulk_jobs
         SET status = 'running',
             started_at = COALESCE(started_at, NOW()),
             heartbeat_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [row['id']],
      );
      return updated.rows[0] ?? row;
    });

    if (!claimed) return { jobId: null, status: 'idle' };
    const jobId = String(claimed['id']);
    try {
      const actor = await this.loadUser(String(claimed['requested_by']));
      const finished = await this.executeJob(claimed, actor, null, true);
      return { jobId, status: String(finished['status']) };
    } catch (err) {
      await this.failJob(jobId, err);
      return { jobId, status: 'failed' };
    }
  }

  private async executeJob(
    job: Row,
    actor: SessionUser,
    ipAddress: string | null,
    notifyRequester: boolean,
  ): Promise<Row> {
    const jobId = String(job['id']);
    const entity = SavedViewEntitySchema.parse(job['entity']);
    const action = job['action'] as BulkActionType;
    const cfg = ENTITY_CONFIG[entity];
    const actionCap = capabilityForAction(entity, action);
    const selection = (job['selection_json'] ?? {}) as StoredSelection;
    const payload = (job['payload_json'] ?? {}) as StoredPayload;
    const allIds = Array.isArray(selection.ids) ? selection.ids : [];
    const startOffset = Number(job['processed_rows'] ?? 0);

    let processed = startOffset;
    let succeeded = Number(job['succeeded_rows'] ?? 0);
    let skipped = Number(job['skipped_rows'] ?? 0);
    let assignedTarget: AssigneeRow | null = null;

    if (action === 'assign' && payload.ownerUserId) {
      assignedTarget = await resolveAssignee(this.db, actor, payload.ownerUserId, actionCap);
    }

    for (let offset = startOffset; offset < allIds.length; offset += CHUNK_SIZE) {
      // Re-verify live permissions before each chunk when running in background
      if (notifyRequester) {
        actor = await this.loadUser(actor.id);
      }
      requireCapability(actor, cfg.read);
      requireCapability(actor, actionCap);

      const chunkIds = allIds.slice(offset, offset + CHUNK_SIZE);
      const chunkResult = await this.db.transaction(async (tx) => {
        const res = await this.applyChunk(
          tx,
          actor,
          entity,
          action,
          actionCap,
          chunkIds,
          payload,
          assignedTarget,
          ipAddress,
        );
        processed += chunkIds.length;
        succeeded += res.succeeded;
        skipped += res.skipped;
        await tx.query(
          `UPDATE bulk_jobs
           SET processed_rows = $2,
               succeeded_rows = $3,
               skipped_rows = $4,
               heartbeat_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [jobId, processed, succeeded, skipped],
        );
        return res;
      });
      void chunkResult;
    }

    return this.db.transaction(async (tx) => {
      const done = await tx.query<Row>(
        `UPDATE bulk_jobs
         SET status = 'completed',
             finished_at = NOW(),
             heartbeat_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId],
      );
      if (assignedTarget && assignedTarget.id !== actor.id && succeeded > 0) {
        await addNotification(tx, {
          userId: assignedTarget.id,
          kind: 'assignment',
          title: `${formatNumber(succeeded)} ${succeeded === 1 ? RECORD_TABLES[entity].label.toLowerCase() : cfg.plural} assigned to you`,
          body: `${actor.name} assigned ${formatNumber(succeeded)} ${succeeded === 1 ? RECORD_TABLES[entity].label.toLowerCase() : cfg.plural} to you.`,
          entityType: entity,
          entityId: allIds[0] ?? null,
        });
      }
      if (notifyRequester) {
        await addNotification(tx, {
          userId: actor.id,
          kind: 'general',
          title: `Bulk update finished`,
          body: `Updated ${formatNumber(succeeded)} of ${formatNumber(allIds.length)} ${cfg.plural}.`,
          entityType: entity,
          entityId: null,
        });
      }
      await this.db.writeAuditLog(tx, {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: 'bulk.completed',
        entityType: 'bulk_job',
        entityId: jobId,
        metadata: { entity, bulkAction: action, succeededRows: succeeded, skippedRows: skipped },
        ipAddress,
      });
      return done.rows[0] as Row;
    });
  }

  private async applyChunk(
    tx: DbTx,
    actor: SessionUser,
    entity: SavedViewEntity,
    action: BulkActionType,
    actionCap: string,
    chunkIds: string[],
    payload: StoredPayload,
    assignedTarget: AssigneeRow | null,
    ipAddress: string | null,
  ): Promise<{ succeeded: number; skipped: number }> {
    const cfg = ENTITY_CONFIG[entity];
    const readScope = scopeWhere(actor, cfg.read, { startParamIndex: 2 });
    const actScope = scopeWhere(actor, actionCap, {
      startParamIndex: 2 + readScope.params.length,
    });
    const scopedRes = await tx.query<Row>(
      `SELECT * FROM ${cfg.table}
       WHERE id = ANY($1::text[])
         AND deleted_at IS NULL
         AND ${readScope.sql}
         AND ${actScope.sql}
       FOR UPDATE`,
      [chunkIds, ...readScope.params, ...actScope.params],
    );

    const rows = scopedRes.rows;
    let succeeded = 0;

    if (action === 'assign' && assignedTarget) {
      for (const cur of rows) {
        const id = String(cur['id']);
        if (cur['owner_user_id'] === assignedTarget.id) {
          succeeded += 1;
          continue;
        }
        await tx.query(
          `UPDATE ${cfg.table}
           SET owner_user_id = $2, team_id = $3, version = version + 1, updated_at = NOW()
           WHERE id = $1`,
          [id, assignedTarget.id, assignedTarget.team_id],
        );
        await this.db.writeRecordHistory(tx, {
          entityType: entity,
          entityId: id,
          fieldName: 'owner_user_id',
          oldValue: cur['owner_user_id'],
          newValue: assignedTarget.id,
          changedByUserId: actor.id,
        });
        await insertActivity(tx, {
          entityType: entity,
          entityId: id,
          activityType: 'assignment',
          title: `Assigned to ${assignedTarget.name}`,
          detail: `${actor.name} assigned this ${entity} to ${assignedTarget.name}.`,
          actorUserId: actor.id,
          links: {
            leadId: entity === 'lead' ? id : null,
            contactId: entity === 'contact' ? id : null,
            companyId: entity === 'company' ? id : ((cur['company_id'] as string | null) ?? null),
            dealId: entity === 'deal' ? id : null,
          },
        });
        await this.db.addOutboxEvent(tx, {
          eventType: `${entity}.assigned`,
          aggregateType: entity,
          aggregateId: id,
          payload: { id, ownerUserId: assignedTarget.id, assignedBy: actor.id },
        });
        succeeded += 1;
      }
      return { succeeded, skipped: chunkIds.length - succeeded };
    }

    if (action === 'status' && entity === 'lead' && payload.status) {
      const nextStatus = payload.status;
      const nextCategory = leadStatusCategory(nextStatus);
      const dqReason =
        nextStatus === 'Disqualified' ? (payload.disqualificationReason ?? null) : null;

      for (const cur of rows) {
        const id = String(cur['id']);
        if (cur['status'] === 'Converted') {
          continue;
        }
        if (cur['status'] === nextStatus && cur['disqualification_reason'] === dqReason) {
          succeeded += 1;
          continue;
        }
        await tx.query(
          `UPDATE leads
           SET status = $2, status_category = $3, disqualification_reason = $4,
               version = version + 1, updated_at = NOW()
           WHERE id = $1`,
          [id, nextStatus, nextCategory, dqReason],
        );
        await this.db.writeRecordHistory(tx, {
          entityType: 'lead',
          entityId: id,
          fieldName: 'status',
          oldValue: cur['status'],
          newValue: nextStatus,
          changedByUserId: actor.id,
        });
        await tx.query(
          `INSERT INTO lead_status_history (id, lead_id, from_status, to_status, changed_by_user_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            `lsh_${randomUUID()}`,
            id,
            cur['status'],
            nextStatus,
            actor.id,
            [dqReason, payload.statusNote].filter(Boolean).join(' · ') || null,
          ],
        );
        await this.db.addOutboxEvent(tx, {
          eventType: 'lead.status_changed',
          aggregateType: 'lead',
          aggregateId: id,
          payload: { leadId: id, from: cur['status'], to: nextStatus },
        });
        if (nextCategory === 'qualified') {
          await this.db.addOutboxEvent(tx, {
            eventType: 'lead.qualified',
            aggregateType: 'lead',
            aggregateId: id,
            payload: { leadId: id },
          });
        }
        succeeded += 1;
      }
      return { succeeded, skipped: chunkIds.length - succeeded };
    }

    if ((action === 'add_tag' || action === 'remove_tag') && payload.tag) {
      const tagName = payload.tag;
      let tagId: string | null = null;
      if (action === 'add_tag') {
        const upserted = await tx.query<{ id: string }>(
          `INSERT INTO tags (id, name) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [`tag_${randomUUID()}`, tagName],
        );
        tagId = upserted.rows[0]?.id ?? null;
      } else {
        const found = await tx.query<{ id: string }>(`SELECT id FROM tags WHERE name = $1`, [
          tagName,
        ]);
        tagId = found.rows[0]?.id ?? null;
      }

      for (const cur of rows) {
        const id = String(cur['id']);
        if (tagId) {
          if (action === 'add_tag') {
            await tx.query(
              `INSERT INTO entity_tags (entity_type, entity_id, tag_id)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [entity, id, tagId],
            );
          } else {
            await tx.query(
              `DELETE FROM entity_tags WHERE entity_type = $1 AND entity_id = $2 AND tag_id = $3`,
              [entity, id, tagId],
            );
          }
          await tx.query(`UPDATE ${cfg.table} SET updated_at = NOW() WHERE id = $1`, [id]);
        }
        succeeded += 1;
      }
      return { succeeded, skipped: chunkIds.length - succeeded };
    }

    if (action === 'delete') {
      for (const cur of rows) {
        const id = String(cur['id']);
        await tx.query(
          `UPDATE ${cfg.table}
           SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
           WHERE id = $1`,
          [id],
        );
        if (entity === 'deal' || entity === 'contact' || entity === 'lead') {
          await tx.query(
            `UPDATE tasks SET status = 'cancelled', updated_at = NOW()
             WHERE ${entity}_id = $1 AND status = 'open'`,
            [id],
          );
        }
        await this.db.writeAuditLog(tx, {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: 'record.deleted',
          entityType: entity,
          entityId: id,
          ipAddress,
        });
        succeeded += 1;
      }
      return { succeeded, skipped: chunkIds.length - succeeded };
    }

    return { succeeded: 0, skipped: chunkIds.length };
  }

  private async resolveTargetIds(
    user: SessionUser,
    entity: SavedViewEntity,
    actionCap: string,
    selection: StoredSelection,
  ): Promise<string[]> {
    const cfg = ENTITY_CONFIG[entity];
    const params = new SqlParams();
    const readScope = scopeWhere(user, cfg.read, {
      alias: cfg.alias,
      startParamIndex: params.next,
    });
    readScope.params.forEach((p) => params.add(p));
    const actScope = scopeWhere(user, actionCap, {
      alias: cfg.alias,
      startParamIndex: params.next,
    });
    actScope.params.forEach((p) => params.add(p));

    const wheres = [...cfg.spec.where, readScope.sql, actScope.sql];

    if (selection.ids && selection.ids.length > 0) {
      const idsParam = params.add(selection.ids);
      wheres.push(`${cfg.spec.idSql} = ANY(${idsParam}::text[])`);
    } else {
      const q = (selection.q ?? '').trim();
      if (q && cfg.spec.search) {
        wheres.push(cfg.spec.search(q, params));
      }
      if (
        selection.filter !== null &&
        selection.filter !== undefined &&
        !(
          typeof selection.filter === 'object' &&
          Object.keys(selection.filter as object).length === 0
        )
      ) {
        wheres.push(
          compileFilter(selection.filter, cfg.spec.registry, params, { userId: user.id }),
        );
      }
    }

    const limitParam = params.add(BULK_MAX_ROWS + 1);
    const res = await this.db.query<{ id: string }>(
      `SELECT ${cfg.spec.idSql} AS id
       FROM ${cfg.spec.from}
       WHERE ${wheres.join(' AND ')}
       ORDER BY ${cfg.spec.idSql} ASC
       LIMIT ${limitParam}`,
      params.values,
    );
    return res.rows.map((r) => r.id);
  }

  private async failJob(jobId: string, err: unknown): Promise<void> {
    this.logger.error({ err, bulkJobId: jobId }, 'bulk action job failed');
    const safeReason =
      err instanceof DomainError
        ? err.message
        : 'The bulk action stopped because of an unexpected error.';
    await this.db.query(
      `UPDATE bulk_jobs
       SET status = 'failed', failure_reason = $2, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [jobId, safeReason],
    );
  }

  private toView(row: Row): BulkJobView {
    return {
      id: String(row['id']),
      entity: row['entity'] as SavedViewEntity,
      action: row['action'] as BulkActionType,
      status: row['status'] as BulkJobStatus,
      background: Boolean(row['background']),
      totalRows: Number(row['total_rows'] ?? 0),
      processedRows: Number(row['processed_rows'] ?? 0),
      succeededRows: Number(row['succeeded_rows'] ?? 0),
      skippedRows: Number(row['skipped_rows'] ?? 0),
      failureReason: (row['failure_reason'] as string | null) ?? null,
      createdAt: iso(row['created_at']) ?? new Date().toISOString(),
      finishedAt: iso(row['finished_at']),
    };
  }
}
