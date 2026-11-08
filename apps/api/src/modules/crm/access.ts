import { randomUUID } from 'node:crypto';
import type { RecordEntityType, SessionUser } from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  ForbiddenScopeError,
  NotFoundDomainError,
  ValidationDomainError,
} from '../../platform/errors/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';

/** Shared helpers for reading and changing scoped records (PRD 2.2, 3.1, 4.7, 7). */

export const RECORD_TABLES: Record<
  RecordEntityType,
  { table: string; label: string; read: string; write: string }
> = {
  lead: { table: 'leads', label: 'Lead', read: 'leads.read', write: 'leads.write' },
  contact: { table: 'contacts', label: 'Contact', read: 'contacts.read', write: 'contacts.write' },
  company: {
    table: 'companies',
    label: 'Company',
    read: 'companies.read',
    write: 'companies.write',
  },
  deal: { table: 'deals', label: 'Deal', read: 'deals.read', write: 'deals.write' },
};

/**
 * Loads a record the user may read or write, applying their scope in SQL. Records outside
 * the scope look exactly like missing ones (404), so their existence isn't leaked.
 */
export async function requireRecord<T = Record<string, unknown>>(
  q: Pick<DbTx, 'query'>,
  user: SessionUser,
  entityType: RecordEntityType,
  id: string,
  mode: 'read' | 'write',
  options: { forUpdate?: boolean } = {},
): Promise<T> {
  const meta = RECORD_TABLES[entityType];
  const scope = scopeWhere(user, mode === 'read' ? meta.read : meta.write, {
    startParamIndex: 2,
  });
  const res = await q.query<T>(
    `SELECT * FROM ${meta.table}
     WHERE id = $1 AND deleted_at IS NULL AND ${scope.sql}
     ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [id, ...scope.params],
  );
  const row = res.rows[0];
  if (!row) throw new NotFoundDomainError(meta.label, id);
  return row;
}

export interface AssigneeRow {
  id: string;
  name: string;
  team_id: string | null;
  status: string;
}

/**
 * Checks that `targetUserId` is an active user the actor may hand work to. With team scope
 * the target must be in the actor's team (or the actor); with own scope only the actor.
 */
export async function resolveAssignee(
  q: Pick<DbTx, 'query'>,
  actor: SessionUser,
  targetUserId: string,
  capability: string,
): Promise<AssigneeRow> {
  const scope = requireCapability(actor, capability);
  const res = await q.query<AssigneeRow>(
    `SELECT id, name, team_id, status FROM users WHERE id = $1`,
    [targetUserId],
  );
  const target = res.rows[0];
  if (!target || target.status !== 'active') {
    throw new ValidationDomainError('Choose an active user as the owner.', {
      ownerUserId: ['This user is not active.'],
    });
  }
  if (target.id === actor.id) return target;
  if (scope === 'own') throw new ForbiddenScopeError(capability);
  if (scope === 'team' && (!actor.teamId || target.team_id !== actor.teamId)) {
    throw new DomainError({
      status: 403,
      code: 'ASSIGNEE_OUTSIDE_TEAM',
      title: 'Outside your team',
      detail: 'You can only assign records to people in your own team.',
      fieldErrors: { ownerUserId: ['Pick someone in your team.'] },
    });
  }
  return target;
}

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Writes one record_history row for each listed column whose value changed. */
export async function writeChanges(
  db: DatabaseService,
  tx: DbTx,
  entityType: string,
  entityId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  columns: readonly string[],
  userId: string,
): Promise<string[]> {
  const changed: string[] = [];
  for (const column of columns) {
    if (!same(before[column], after[column])) {
      changed.push(column);
      await db.writeRecordHistory(tx, {
        entityType,
        entityId,
        fieldName: column,
        oldValue:
          before[column] instanceof Date ? (before[column] as Date).toISOString() : before[column],
        newValue:
          after[column] instanceof Date ? (after[column] as Date).toISOString() : after[column],
        changedByUserId: userId,
      });
    }
  }
  return changed;
}

export interface ActivityLinks {
  leadId?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
}

/** Adds an immutable timeline entry linked to every related record (PRD 3.1, 4.7). */
export async function insertActivity(
  tx: DbTx,
  input: {
    entityType: string;
    entityId: string;
    activityType: string;
    title: string;
    detail: string;
    actorUserId: string | null;
    links: ActivityLinks;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
  },
): Promise<string> {
  const id = `act_${randomUUID()}`;
  await tx.query(
    `INSERT INTO activities (
       id, entity_type, entity_id, company_id, contact_id, lead_id, deal_id,
       activity_type, title, detail, actor_user_id, metadata, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, COALESCE($13::timestamptz, NOW()))`,
    [
      id,
      input.entityType,
      input.entityId,
      input.links.companyId ?? null,
      input.links.contactId ?? null,
      input.links.leadId ?? null,
      input.links.dealId ?? null,
      input.activityType,
      input.title.slice(0, 240),
      input.detail,
      input.actorUserId,
      JSON.stringify(input.metadata ?? {}),
      input.occurredAt ?? null,
    ],
  );
  return id;
}

/** Works out every record an activity on `entityType/id` should also appear on. */
export async function linksFor(
  q: Pick<DbTx, 'query'>,
  entityType: RecordEntityType,
  row: Record<string, unknown>,
): Promise<ActivityLinks> {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  switch (entityType) {
    case 'lead':
      return {
        leadId: str(row['id']),
        contactId: str(row['contact_id']),
        companyId: str(row['company_id']),
        dealId: str(row['converted_deal_id']),
      };
    case 'contact': {
      const openLead = await q.query<{ id: string }>(
        `SELECT id FROM leads WHERE contact_id = $1 AND deleted_at IS NULL AND status_category <> 'closed'
         ORDER BY updated_at DESC LIMIT 1`,
        [row['id']],
      );
      return {
        contactId: str(row['id']),
        companyId: str(row['company_id']),
        leadId: openLead.rows[0]?.id ?? null,
      };
    }
    case 'company':
      return { companyId: str(row['id']) };
    case 'deal':
      return {
        dealId: str(row['id']),
        companyId: str(row['company_id']),
        contactId: str(row['primary_contact_id']),
      };
  }
}

/** Reads one reference list from settings (PRD 3.4), for validating picklist values. */
export async function referenceList(q: Pick<DbTx, 'query'>, key: string): Promise<string[]> {
  const res = await q.query<{ value_json: unknown }>(
    `SELECT value_json FROM settings WHERE key = $1`,
    [`reference.${key}`],
  );
  const value = res.rows[0]?.value_json;
  return Array.isArray(value) ? value.map(String) : [];
}
