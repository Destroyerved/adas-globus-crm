import { randomUUID } from 'node:crypto';
import {
  mergeFields,
  type MergeEntity,
  type MergePreviewView,
  type MergeRecordView,
  type MergeSide,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { scopeWhere } from '../../platform/scope/index.js';
import { insertActivity, resolveAssignee } from './access.js';

/**
 * Merging duplicate contacts and companies, and undoing a merge (PRD 4.9; ADR 0009). It lives
 * in the CRM module because it changes CRM records and every table that points at them.
 */

type Row = Record<string, unknown>;
type Q = Pick<DbTx, 'query'>;

export const MERGE_UNDO_DAYS = 30;

/** The columns each merge field takes together from the chosen record. */
const FIELD_COLUMNS: Record<MergeEntity, Record<string, readonly string[]>> = {
  contact: {
    name: ['first_name', 'last_name', 'full_name'],
    email: ['primary_email', 'email_verification_status', 'hard_bounced_at'],
    phone: ['phone_e164'],
    title: ['title'],
    jobFunction: ['job_function'],
    seniority: ['seniority'],
    company: ['company_id'],
    market: ['market'],
    timezone: ['timezone'],
    owner: ['owner_user_id', 'team_id'],
  },
  company: {
    name: ['name'],
    website: ['domain', 'website'],
    firmType: ['firm_type'],
    market: ['market'],
    region: ['state_province'],
    city: ['city'],
    timezone: ['timezone'],
    staffBand: ['staff_band'],
    accountStatus: ['account_status'],
    owner: ['owner_user_id', 'team_id'],
    software: ['accounting_software'],
    services: ['services_needed'],
  },
};

/** Columns the merge works out itself rather than asking (ADR 0009). */
const AUTO_COLUMNS: Record<MergeEntity, readonly string[]> = {
  contact: ['do_not_contact', 'apollo_person_id', 'custom_fields', 'last_contacted_at'],
  company: ['custom_fields', 'last_contacted_at', 'estimated_revenue_minor', 'currency'],
};

const AUTO_LABELS: Record<string, string> = {
  do_not_contact: 'Do not contact',
  apollo_person_id: 'Apollo ID',
  custom_fields: 'Custom fields',
  last_contacted_at: 'Last contacted',
  estimated_revenue_minor: 'Estimated revenue',
  currency: 'Estimated revenue',
};

const JSONB_COLUMNS = new Set(['accounting_software', 'services_needed', 'custom_fields']);

interface Relation {
  key: string;
  /** Shown in the preview and the result; empty for links people don't think about. */
  label: string;
  table: string;
  column: string;
  idColumn?: string;
  where?: string;
  /** Records people edit carry a version, so a form opened before the merge can't undo it. */
  bumpVersion?: boolean;
  /** The preview counts only live rows. */
  live?: string;
}

const LIVE = 'deleted_at IS NULL';

const CONTACT_RELATIONS: readonly Relation[] = [
  {
    key: 'leads',
    label: 'Leads',
    table: 'leads',
    column: 'contact_id',
    bumpVersion: true,
    live: LIVE,
  },
  {
    key: 'deals',
    label: 'Deals',
    table: 'deals',
    column: 'primary_contact_id',
    bumpVersion: true,
    live: LIVE,
  },
  {
    key: 'tasks',
    label: 'Tasks',
    table: 'tasks',
    column: 'contact_id',
    bumpVersion: true,
    live: LIVE,
  },
  { key: 'activities', label: 'Timeline entries', table: 'activities', column: 'contact_id' },
  {
    key: 'activitySubjects',
    label: '',
    table: 'activities',
    column: 'entity_id',
    where: "entity_type = 'contact'",
  },
  {
    key: 'notes',
    label: 'Notes',
    table: 'notes',
    column: 'entity_id',
    where: "entity_type = 'contact'",
    live: LIVE,
  },
  { key: 'emailThreads', label: 'Email threads', table: 'email_threads', column: 'contact_id' },
  { key: 'sends', label: 'Sent emails', table: 'message_sends', column: 'contact_id' },
  {
    key: 'enrollments',
    label: 'Sequence enrollments',
    table: 'sequence_enrollments',
    column: 'contact_id',
  },
  {
    key: 'campaignRecipients',
    label: 'Campaign recipients',
    table: 'campaign_recipients',
    column: 'contact_id',
  },
  { key: 'consent', label: 'Consent records', table: 'consent_records', column: 'contact_id' },
  {
    key: 'unsubscribeTokens',
    label: '',
    table: 'unsubscribe_tokens',
    column: 'contact_id',
    idColumn: 'token',
  },
  { key: 'emails', label: 'Email addresses', table: 'contact_emails', column: 'contact_id' },
  { key: 'phones', label: '', table: 'contact_phones', column: 'contact_id' },
];

const COMPANY_RELATIONS: readonly Relation[] = [
  {
    key: 'contacts',
    label: 'Contacts',
    table: 'contacts',
    column: 'company_id',
    bumpVersion: true,
    live: LIVE,
  },
  {
    key: 'leads',
    label: 'Leads',
    table: 'leads',
    column: 'company_id',
    bumpVersion: true,
    live: LIVE,
  },
  {
    key: 'deals',
    label: 'Deals',
    table: 'deals',
    column: 'company_id',
    bumpVersion: true,
    live: LIVE,
  },
  {
    key: 'tasks',
    label: 'Tasks',
    table: 'tasks',
    column: 'company_id',
    bumpVersion: true,
    live: LIVE,
  },
  { key: 'activities', label: 'Timeline entries', table: 'activities', column: 'company_id' },
  {
    key: 'activitySubjects',
    label: '',
    table: 'activities',
    column: 'entity_id',
    where: "entity_type = 'company'",
  },
  {
    key: 'notes',
    label: 'Notes',
    table: 'notes',
    column: 'entity_id',
    where: "entity_type = 'company'",
    live: LIVE,
  },
  { key: 'emailThreads', label: 'Email threads', table: 'email_threads', column: 'company_id' },
];

const META: Record<
  MergeEntity,
  { table: string; label: string; write: string; noun: string; relations: readonly Relation[] }
> = {
  contact: {
    table: 'contacts',
    label: 'Contact',
    write: 'contacts.write',
    noun: 'contact',
    relations: CONTACT_RELATIONS,
  },
  company: {
    table: 'companies',
    label: 'Company',
    write: 'companies.write',
    noun: 'company',
    relations: COMPANY_RELATIONS,
  },
};

/** Everything needed to undo a merge, kept in merge_logs.snapshot_json. */
export interface MergeSnapshot {
  v: 1;
  /** Field keys, and `auto:<column>` for worked-out columns, that the merge changed. */
  fields: string[];
  keptBefore: Row;
  keptAfter: Row;
  keptVersionAfter: number;
  /** The merged record as it was. */
  merged: Row;
  mergedVersionAfter: number;
  moved: Record<string, string[]>;
  stoppedEnrollments: string[];
  stoppedForDoNotContact: string[];
  listsMoved: string[];
  listsDropped: { listId: string; addedAt: string }[];
  tagsAdded: string[];
  candidatesRepointed: { id: string; side: 'left' | 'right' }[];
  candidatesClosed: string[];
}

export interface MergeResult {
  mergeId: string;
  keptName: string;
  mergedName: string;
  moved: { label: string; count: number }[];
  snapshot: MergeSnapshot;
}

export interface MergeRequest {
  mergedId: string;
  keptVersion: number;
  mergedVersion: number;
  take: Record<string, MergeSide>;
  candidateId?: string | undefined;
}

function plain(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(plain(a) ?? null) === JSON.stringify(plain(b) ?? null);
}

function blankValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function recordName(entity: MergeEntity, row: Row): string {
  if (entity === 'company') return String(row['name'] ?? '');
  const name = String(row['full_name'] ?? '').trim();
  return name || String(row['primary_email'] ?? '');
}

/** "3 deals, 12 timeline entries and 2 tasks" */
export function describeMoved(moved: { label: string; count: number }[]): string {
  const parts = moved
    .filter((m) => m.count > 0)
    .map((m) => `${m.count} ${m.count === 1 ? singular(m.label) : m.label.toLowerCase()}`);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function singular(label: string): string {
  const lower = label.toLowerCase();
  if (lower.endsWith('entries')) return `${lower.slice(0, -7)}entry`;
  if (lower.endsWith('addresses')) return `${lower.slice(0, -2)}`;
  return lower.endsWith('s') ? lower.slice(0, -1) : lower;
}

const MARKET_TEXT: Record<string, string> = { US: 'United States', CA: 'Canada', OTHER: 'Other' };

function statusText(value: unknown): string | null {
  if (blankValue(value)) return null;
  const text = String(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listText(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0 ? value.map(String).join(', ') : null;
}

function text(value: unknown): string | null {
  return blankValue(value) ? null : String(value);
}

/** Never lets an undo or a merge quietly lift a do-not-contact flag (PRD 5; ADR 0009). */
function liftsDoNotContact(column: string, from: unknown, to: unknown): boolean {
  if (column === 'do_not_contact') return from === true && to !== true;
  if (column === 'account_status') return from === 'do_not_contact' && to !== 'do_not_contact';
  return false;
}

/**
 * Queues a probable duplicate pair for review unless the pair has ever been queued, so a
 * pair someone dismissed or merged doesn't come back.
 */
export async function queueDuplicatePair(
  tx: Q,
  entity: MergeEntity,
  existingId: string,
  newId: string,
  reason: string,
  confidence: number,
  importBatchId: string | null,
): Promise<boolean> {
  if (existingId === newId) return false;
  const res = await tx.query(
    `INSERT INTO duplicate_candidates
       (id, entity_type, left_entity_id, right_entity_id, match_reason, confidence, import_batch_id)
     SELECT $1, $2, $3, $4, $5, $6, $7
     WHERE NOT EXISTS (
       SELECT 1 FROM duplicate_candidates d
       WHERE d.entity_type = $2
         AND LEAST(d.left_entity_id, d.right_entity_id) = LEAST($3::text, $4::text)
         AND GREATEST(d.left_entity_id, d.right_entity_id) = GREATEST($3::text, $4::text))
     ON CONFLICT DO NOTHING`,
    [`dup_${randomUUID()}`, entity, existingId, newId, reason, confidence, importBatchId],
  );
  return res.rowCount > 0;
}

export class MergeWriter {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Loads a record the user may merge: writable for them and inside their `duplicates.merge`
   * scope. Anything else looks missing (404), as elsewhere.
   */
  async load(
    q: Q,
    user: SessionUser,
    entity: MergeEntity,
    id: string,
    options: { forUpdate?: boolean; includeDeleted?: boolean } = {},
  ): Promise<Row> {
    const meta = META[entity];
    const write = scopeWhere(user, meta.write, { startParamIndex: 2 });
    const merge = scopeWhere(user, 'duplicates.merge', {
      startParamIndex: 2 + write.params.length,
    });
    const res = await q.query<Row>(
      `SELECT * FROM ${meta.table}
       WHERE id = $1 ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}
         AND ${write.sql} AND ${merge.sql}
       ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id, ...write.params, ...merge.params],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundDomainError(meta.label, id);
    return row;
  }

  /** Which record each field comes from when the person hasn't chosen. */
  defaults(entity: MergeEntity, kept: Row, merged: Row): Record<string, MergeSide> {
    const out: Record<string, MergeSide> = {};
    for (const [key, columns] of Object.entries(FIELD_COLUMNS[entity])) {
      const keptBlank = columns.every((c) => blankValue(kept[c]));
      const mergedBlank = columns.every((c) => blankValue(merged[c]));
      out[key] = keptBlank && !mergedBlank ? 'merged' : 'kept';
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  async preview(
    q: Q,
    user: SessionUser,
    entity: MergeEntity,
    keptId: string,
    mergedId: string,
  ): Promise<MergePreviewView> {
    if (keptId === mergedId) throw this.sameRecord(entity);
    const kept = await this.load(q, user, entity, keptId);
    const merged = await this.load(q, user, entity, mergedId);
    const [keptView, mergedView] = await Promise.all([
      this.recordView(q, entity, kept),
      this.recordView(q, entity, merged),
    ]);
    const keptName = recordName(entity, kept);
    const mergedName = recordName(entity, merged);
    const notes: string[] = [];
    if (entity === 'contact') {
      if (merged['do_not_contact'] === true && kept['do_not_contact'] !== true) {
        notes.push(`${keptName} will be marked do not contact, because ${mergedName} is.`);
      }
      if (kept['do_not_contact'] === true || merged['do_not_contact'] === true) {
        notes.push('Any sequences still running for either contact will stop.');
      }
      const shared = await q.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM sequence_enrollments e
         WHERE e.contact_id = $2 AND e.status IN ('active', 'paused')
           AND EXISTS (SELECT 1 FROM sequence_enrollments k
                       WHERE k.contact_id = $1 AND k.sequence_id = e.sequence_id
                         AND k.status IN ('active', 'paused'))`,
        [keptId, mergedId],
      );
      const n = shared.rows[0]?.n ?? 0;
      if (n > 0) {
        notes.push(
          `${n} of ${mergedName}'s sequence ${n === 1 ? 'enrollment' : 'enrollments'} will stop, because ${keptName} is already in the same ${n === 1 ? 'sequence' : 'sequences'}.`,
        );
      }
      notes.push(`${mergedName}'s email addresses stay on the kept contact as extra addresses.`);
    } else if (
      kept['account_status'] === 'do_not_contact' ||
      merged['account_status'] === 'do_not_contact'
    ) {
      notes.push('The kept company will be marked do not contact.');
    }
    notes.push(
      `${mergedName} will be removed. You can undo the merge for ${MERGE_UNDO_DAYS} days.`,
    );
    return {
      entity,
      fields: [...mergeFields(entity)],
      kept: keptView,
      merged: mergedView,
      defaults: this.defaults(entity, kept, merged),
      notes,
    };
  }

  private async recordView(q: Q, entity: MergeEntity, row: Row): Promise<MergeRecordView> {
    const owner = await q.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [
      row['owner_user_id'],
    ]);
    const ownerName = owner.rows[0]?.name ?? null;
    let fields: Record<string, string | null>;
    if (entity === 'contact') {
      const company = row['company_id']
        ? await q.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [
            row['company_id'],
          ])
        : { rows: [] };
      fields = {
        name: text(row['full_name']),
        email: text(row['primary_email']),
        phone: text(row['phone_e164']),
        title: text(row['title']),
        jobFunction: text(row['job_function']),
        seniority: text(row['seniority']),
        company: company.rows[0]?.name ?? null,
        market: MARKET_TEXT[String(row['market'])] ?? text(row['market']),
        timezone: text(row['timezone']),
        owner: ownerName,
      };
    } else {
      fields = {
        name: text(row['name']),
        website: text(row['website']) ?? text(row['domain']),
        firmType: text(row['firm_type']),
        market: MARKET_TEXT[String(row['market'])] ?? text(row['market']),
        region: text(row['state_province']),
        city: text(row['city']),
        timezone: text(row['timezone']),
        staffBand: text(row['staff_band']),
        accountStatus: statusText(row['account_status']),
        owner: ownerName,
        software: listText(row['accounting_software']),
        services: listText(row['services_needed']),
      };
    }
    const linked: { label: string; count: number }[] = [];
    for (const rel of META[entity].relations) {
      if (!rel.label) continue;
      const conditions = [`${rel.column} = $1`];
      if (rel.where) conditions.push(rel.where);
      if (rel.live) conditions.push(rel.live);
      const res = await q.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${rel.table} WHERE ${conditions.join(' AND ')}`,
        [row['id']],
      );
      linked.push({ label: rel.label, count: res.rows[0]?.n ?? 0 });
    }
    const tags = await q.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM entity_tags WHERE entity_type = $1 AND entity_id = $2`,
      [entity, row['id']],
    );
    linked.push({ label: 'Tags', count: tags.rows[0]?.n ?? 0 });
    if (entity === 'contact') {
      const lists = await q.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM list_members WHERE contact_id = $1`,
        [row['id']],
      );
      linked.push({ label: 'Lists', count: lists.rows[0]?.n ?? 0 });
    }
    return {
      id: String(row['id']),
      version: Number(row['version']),
      name: recordName(entity, row),
      createdAt: new Date(row['created_at'] as string | Date).toISOString(),
      fields,
      linked,
      doNotContact:
        entity === 'contact'
          ? row['do_not_contact'] === true
          : row['account_status'] === 'do_not_contact',
    };
  }

  private sameRecord(entity: MergeEntity): DomainError {
    return new ValidationDomainError(
      `Choose two different ${entity === 'contact' ? 'contacts' : 'companies'}.`,
      {
        mergedId: ['This is the record you are keeping.'],
      },
    );
  }

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  async merge(
    tx: DbTx,
    user: SessionUser,
    entity: MergeEntity,
    keptId: string,
    request: MergeRequest,
  ): Promise<MergeResult> {
    const meta = META[entity];
    if (keptId === request.mergedId) throw this.sameRecord(entity);
    const fieldColumns = FIELD_COLUMNS[entity];
    for (const key of Object.keys(request.take)) {
      if (!(key in fieldColumns)) {
        throw new ValidationDomainError(`"${key}" is not a field you can choose.`, {
          take: [`Unknown field: ${key}`],
        });
      }
    }

    // Lock both rows in id order so two merges of the same pair can't deadlock.
    const [firstId, secondId] = [keptId, request.mergedId].sort();
    const first = await this.load(tx, user, entity, firstId ?? '', { forUpdate: true });
    const second = await this.load(tx, user, entity, secondId ?? '', { forUpdate: true });
    const kept = first['id'] === keptId ? first : second;
    const merged = first['id'] === keptId ? second : first;
    if (Number(kept['version']) !== request.keptVersion) {
      throw new VersionConflictError(meta.label, keptId);
    }
    if (Number(merged['version']) !== request.mergedVersion) {
      throw new VersionConflictError(meta.label, request.mergedId);
    }
    const mergedId = String(merged['id']);
    const keptName = recordName(entity, kept);
    const mergedName = recordName(entity, merged);

    // The values the kept record ends up with.
    const choice = { ...this.defaults(entity, kept, merged), ...request.take };
    const next: Row = { ...kept };
    for (const [key, columns] of Object.entries(fieldColumns)) {
      if (choice[key] !== 'merged') continue;
      for (const column of columns) next[column] = merged[column];
    }
    if (choice['owner'] === 'merged') {
      if (merged['owner_user_id'] === kept['owner_user_id']) {
        next['team_id'] = kept['team_id'];
      } else {
        const owner = await resolveAssignee(tx, user, String(merged['owner_user_id']), meta.write);
        next['owner_user_id'] = owner.id;
        next['team_id'] = owner.team_id;
      }
    }
    if (entity === 'contact' && choice['company'] === 'merged' && next['company_id']) {
      const company = await tx.query(
        `SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL`,
        [next['company_id']],
      );
      if (!company.rows[0]) {
        throw new ValidationDomainError("The other contact's company has been removed.", {
          'take.company': ["Keep this contact's company."],
        });
      }
    }
    const custom = (row: Row) =>
      row['custom_fields'] && typeof row['custom_fields'] === 'object'
        ? (row['custom_fields'] as Row)
        : {};
    next['custom_fields'] = { ...custom(merged), ...custom(kept) };
    const lastContacted = [kept['last_contacted_at'], merged['last_contacted_at']]
      .filter((v): v is string | Date => v !== null && v !== undefined)
      .map((v) => new Date(v));
    next['last_contacted_at'] =
      lastContacted.length > 0
        ? new Date(Math.max(...lastContacted.map((d) => d.getTime())))
        : null;
    if (entity === 'contact') {
      // Do not contact always wins, and an external ID is never lost (PRD 4.9, 5).
      next['do_not_contact'] = kept['do_not_contact'] === true || merged['do_not_contact'] === true;
      next['apollo_person_id'] = kept['apollo_person_id'] ?? merged['apollo_person_id'] ?? null;
    } else {
      if (
        kept['account_status'] === 'do_not_contact' ||
        merged['account_status'] === 'do_not_contact'
      ) {
        next['account_status'] = 'do_not_contact';
      }
      if (String(kept['estimated_revenue_minor'] ?? '0') === '0') {
        next['estimated_revenue_minor'] = merged['estimated_revenue_minor'];
        next['currency'] = merged['currency'];
      }
    }

    const columns = [...new Set([...Object.values(fieldColumns).flat(), ...AUTO_COLUMNS[entity]])];
    const changed = columns.filter((c) => !same(kept[c], next[c]));
    const fields: string[] = [];
    for (const [key, cols] of Object.entries(fieldColumns)) {
      if (cols.some((c) => changed.includes(c))) fields.push(key);
    }
    for (const column of AUTO_COLUMNS[entity]) {
      if (changed.includes(column)) fields.push(`auto:${column}`);
    }

    // Contacts: make sure the merged contact's primary email is on file as one of its emails,
    // so it moves across with the others.
    if (entity === 'contact') {
      await tx.query(
        `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
         VALUES ($1, $2, $3, TRUE, 'unknown')
         ON CONFLICT (email) DO NOTHING`,
        [`ce_${randomUUID()}`, mergedId, merged['primary_email']],
      );
    }

    // Remove the merged record first, which frees its unique email, Apollo ID or domain.
    const removed = await tx.query<{ version: number }>(
      `UPDATE ${meta.table} SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $1 RETURNING version`,
      [mergedId],
    );
    const mergedVersionAfter = Number(removed.rows[0]?.version);

    const keptVersionAfter = await this.writeKept(tx, user, entity, kept, next, changed);

    const moved: Record<string, string[]> = {};
    let stoppedEnrollments: string[] = [];
    if (entity === 'contact') {
      // Both contacts in the same sequence: stop the merged contact's enrollment so the kept
      // contact isn't emailed twice.
      const stopped = await tx.query<{ id: string }>(
        `UPDATE sequence_enrollments e
         SET status = 'stopped_merged', stop_reason = 'Merged into a contact already in this sequence',
             next_send_at = NULL, stopped_at = NOW()
         WHERE e.contact_id = $2 AND e.status IN ('active', 'paused')
           AND EXISTS (SELECT 1 FROM sequence_enrollments k
                       WHERE k.contact_id = $1 AND k.sequence_id = e.sequence_id
                         AND k.status IN ('active', 'paused'))
         RETURNING e.id`,
        [keptId, mergedId],
      );
      stoppedEnrollments = stopped.rows.map((r) => r.id);
    }
    for (const rel of meta.relations) {
      moved[rel.key] = await this.moveRelation(tx, rel, mergedId, keptId);
    }

    let stoppedForDoNotContact: string[] = [];
    let listsMoved: string[] = [];
    const listsDropped: { listId: string; addedAt: string }[] = [];
    if (entity === 'contact') {
      await this.syncPrimaryFlags(tx, [keptId]);
      if (next['do_not_contact'] === true) {
        const stopped = await tx.query<{ id: string }>(
          `UPDATE sequence_enrollments
           SET status = 'stopped_suppressed', stop_reason = 'Marked do not contact',
               next_send_at = NULL, stopped_at = NOW()
           WHERE contact_id = $1 AND status IN ('active', 'paused')
           RETURNING id`,
          [keptId],
        );
        stoppedForDoNotContact = stopped.rows.map((r) => r.id);
      }
      const dropped = await tx.query<{ list_id: string; added_at: Date | string }>(
        `DELETE FROM list_members
         WHERE contact_id = $2 AND list_id IN (SELECT list_id FROM list_members WHERE contact_id = $1)
         RETURNING list_id, added_at`,
        [keptId, mergedId],
      );
      for (const row of dropped.rows) {
        listsDropped.push({ listId: row.list_id, addedAt: String(plain(row.added_at)) });
      }
      if (listsDropped.length > 0) {
        await tx.query(
          `UPDATE lists SET member_count = GREATEST(member_count - 1, 0) WHERE id = ANY($1::text[])`,
          [listsDropped.map((d) => d.listId)],
        );
      }
      const lists = await tx.query<{ list_id: string }>(
        `UPDATE list_members SET contact_id = $1 WHERE contact_id = $2 RETURNING list_id`,
        [keptId, mergedId],
      );
      listsMoved = lists.rows.map((r) => r.list_id);
    }

    const tags = await tx.query<{ tag_id: string }>(
      `INSERT INTO entity_tags (entity_type, entity_id, tag_id)
       SELECT entity_type, $1, tag_id FROM entity_tags WHERE entity_type = $3 AND entity_id = $2
       ON CONFLICT DO NOTHING
       RETURNING tag_id`,
      [keptId, mergedId, entity],
    );
    const tagsAdded = tags.rows.map((r) => r.tag_id);

    const { repointed, closed } = await this.resolveCandidates(tx, user, entity, keptId, mergedId);

    const movedList = movedCounts(entity, { moved, tagsAdded, listsMoved });
    const summary = describeMoved(movedList);
    const mergeId = `mrg_${randomUUID()}`;
    await insertActivity(tx, {
      entityType: entity,
      entityId: keptId,
      activityType: 'merge',
      title: `Merged ${mergedName} into this ${meta.noun}`,
      detail: summary ? `${summary} moved here.` : `Nothing else was linked to ${mergedName}.`,
      actorUserId: user.id,
      links:
        entity === 'contact'
          ? { contactId: keptId, companyId: (next['company_id'] as string | null) ?? null }
          : { companyId: keptId },
      metadata: { mergeId, mergedId },
    });

    const snapshot: MergeSnapshot = {
      v: 1,
      fields,
      keptBefore: Object.fromEntries(changed.map((c) => [c, plain(kept[c]) ?? null])),
      keptAfter: Object.fromEntries(changed.map((c) => [c, plain(next[c]) ?? null])),
      keptVersionAfter,
      merged: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, plain(v)])),
      mergedVersionAfter,
      moved,
      stoppedEnrollments,
      stoppedForDoNotContact,
      listsMoved,
      listsDropped,
      tagsAdded,
      candidatesRepointed: repointed,
      candidatesClosed: closed,
    };
    await tx.query(
      `INSERT INTO merge_logs
         (id, entity_type, survivor_id, merged_id, snapshot_json, actor_user_id, duplicate_candidate_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        mergeId,
        entity,
        keptId,
        mergedId,
        JSON.stringify(snapshot),
        user.id,
        request.candidateId ?? null,
      ],
    );
    return { mergeId, keptName, mergedName, moved: movedList, snapshot };
  }

  /** Writes the kept record's new values with record history, and bumps its version. */
  private async writeKept(
    tx: DbTx,
    user: SessionUser,
    entity: MergeEntity,
    current: Row,
    next: Row,
    changed: readonly string[],
  ): Promise<number> {
    const meta = META[entity];
    const sets = changed.map((c, i) => `${c} = $${i + 3}${JSONB_COLUMNS.has(c) ? '::jsonb' : ''}`);
    const params = changed.map((c) =>
      JSONB_COLUMNS.has(c) ? JSON.stringify(next[c] ?? null) : (next[c] ?? null),
    );
    const res = await tx.query<{ version: number }>(
      `UPDATE ${meta.table}
       SET ${[...sets, 'version = version + 1', 'updated_at = NOW()'].join(', ')}
       WHERE id = $1 AND version = $2 AND deleted_at IS NULL
       RETURNING version`,
      [current['id'], current['version'], ...params],
    );
    const updated = res.rows[0];
    if (!updated) throw new VersionConflictError(meta.label, String(current['id']));
    for (const column of changed) {
      if (column === 'full_name' || column === 'team_id') continue;
      await this.db.writeRecordHistory(tx, {
        entityType: entity,
        entityId: String(current['id']),
        fieldName: column,
        oldValue: plain(current[column]),
        newValue: plain(next[column]),
        changedByUserId: user.id,
        via: 'merge',
      });
    }
    return Number(updated.version);
  }

  private async moveRelation(tx: DbTx, rel: Relation, from: string, to: string): Promise<string[]> {
    const sets = [`${rel.column} = $1`];
    if (rel.bumpVersion) sets.push('version = version + 1', 'updated_at = NOW()');
    const res = await tx.query<{ id: string }>(
      `UPDATE ${rel.table} SET ${sets.join(', ')}
       WHERE ${rel.column} = $2 ${rel.where ? `AND ${rel.where}` : ''}
       RETURNING ${rel.idColumn ?? 'id'} AS id`,
      [to, from],
    );
    return res.rows.map((r) => r.id);
  }

  private async moveRelationBack(
    tx: DbTx,
    rel: Relation,
    ids: readonly string[],
    from: string,
    to: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const sets = [`${rel.column} = $1`];
    if (rel.bumpVersion) sets.push('version = version + 1', 'updated_at = NOW()');
    await tx.query(
      `UPDATE ${rel.table} SET ${sets.join(', ')}
       WHERE ${rel.idColumn ?? 'id'} = ANY($3::text[]) AND ${rel.column} = $2
         ${rel.where ? `AND ${rel.where}` : ''}`,
      [to, from, ids],
    );
  }

  /** The primary email and phone flags follow the contact's own primary email and phone. */
  private async syncPrimaryFlags(tx: DbTx, contactIds: readonly string[]): Promise<void> {
    await tx.query(
      `UPDATE contact_emails ce SET is_primary = (ce.email = c.primary_email)
       FROM contacts c WHERE c.id = ce.contact_id AND c.id = ANY($1::text[])`,
      [contactIds],
    );
    await tx.query(
      `UPDATE contact_phones cp SET is_primary = COALESCE(cp.phone_e164 = c.phone_e164, FALSE)
       FROM contacts c WHERE c.id = cp.contact_id AND c.id = ANY($1::text[])`,
      [contactIds],
    );
  }

  /**
   * Closes the pair being merged, and moves the merged record's other open pairs to the kept
   * record (or closes them when the kept record already has that pair).
   */
  private async resolveCandidates(
    tx: DbTx,
    user: SessionUser,
    entity: MergeEntity,
    keptId: string,
    mergedId: string,
  ): Promise<{ repointed: { id: string; side: 'left' | 'right' }[]; closed: string[] }> {
    const closed: string[] = [];
    const repointed: { id: string; side: 'left' | 'right' }[] = [];
    const open = await tx.query<{ id: string; left_entity_id: string; right_entity_id: string }>(
      `SELECT id, left_entity_id, right_entity_id FROM duplicate_candidates
       WHERE entity_type = $1 AND status = 'open' AND (left_entity_id = $2 OR right_entity_id = $2)
       ORDER BY created_at`,
      [entity, mergedId],
    );
    for (const pair of open.rows) {
      const side: 'left' | 'right' = pair.left_entity_id === mergedId ? 'left' : 'right';
      const other = side === 'left' ? pair.right_entity_id : pair.left_entity_id;
      const already =
        other === keptId ||
        (
          await tx.query(
            `SELECT 1 FROM duplicate_candidates
             WHERE entity_type = $1 AND status = 'open'
               AND LEAST(left_entity_id, right_entity_id) = LEAST($2::text, $3::text)
               AND GREATEST(left_entity_id, right_entity_id) = GREATEST($2::text, $3::text)`,
            [entity, keptId, other],
          )
        ).rows.length > 0;
      if (already) {
        await tx.query(
          `UPDATE duplicate_candidates SET status = 'merged', resolved_at = NOW(), resolved_by = $2
           WHERE id = $1`,
          [pair.id, user.id],
        );
        closed.push(pair.id);
      } else {
        await tx.query(`UPDATE duplicate_candidates SET ${side}_entity_id = $2 WHERE id = $1`, [
          pair.id,
          keptId,
        ]);
        repointed.push({ id: pair.id, side });
      }
    }
    return { repointed, closed };
  }

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  /**
   * Restores the merged record and moves back everything the merge moved. Fields of the kept
   * record are put back only if nobody has changed them since; the rest are listed.
   */
  async undo(
    tx: DbTx,
    user: SessionUser,
    entity: MergeEntity,
    keptId: string,
    mergedId: string,
    snap: MergeSnapshot,
  ): Promise<{ keptFields: string[]; keptName: string; mergedName: string }> {
    const meta = META[entity];
    const state = await tx.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM ${meta.table} WHERE id = $1`,
      [keptId],
    );
    if (!state.rows[0] || state.rows[0].deleted_at) {
      throw new DomainError({
        status: 409,
        code: 'MERGE_UNDO_KEPT_GONE',
        title: "Can't undo this merge",
        detail: `The ${meta.noun} that was kept has since been removed or merged into another, so this merge can't be undone.`,
      });
    }
    const kept = await this.load(tx, user, entity, keptId, { forUpdate: true });
    const merged = await this.load(tx, user, entity, mergedId, {
      forUpdate: true,
      includeDeleted: true,
    });
    if (!merged['deleted_at'] || Number(merged['version']) !== snap.mergedVersionAfter) {
      throw new DomainError({
        status: 409,
        code: 'MERGE_UNDO_CHANGED',
        title: "Can't undo this merge",
        detail: `The merged ${meta.noun} has changed since, so this merge can't be undone.`,
      });
    }

    // Put back the kept record's fields that nobody has changed since.
    const fieldColumns = FIELD_COLUMNS[entity];
    const labels = new Map(mergeFields(entity).map((f) => [f.key, f.label]));
    const revert: Row = {};
    const keptFields: string[] = [];
    for (const field of snap.fields) {
      const auto = field.startsWith('auto:') ? field.slice(5) : null;
      const columns = (auto ? [auto] : (fieldColumns[field] ?? [])).filter(
        (c) => c in snap.keptAfter,
      );
      const label = auto ? (AUTO_LABELS[auto] ?? auto) : (labels.get(field) ?? field);
      const untouched = columns.every((c) => same(kept[c], snap.keptAfter[c]));
      const lifts = columns.some((c) => liftsDoNotContact(c, kept[c], snap.keptBefore[c]));
      if (!untouched || lifts) {
        if (!keptFields.includes(label)) keptFields.push(label);
        continue;
      }
      for (const column of columns) revert[column] = snap.keptBefore[column];
    }
    const changed = Object.keys(revert);
    await this.writeKept(tx, user, entity, kept, { ...kept, ...revert }, changed);

    // The merged record's unique values must still be free.
    if (entity === 'contact') {
      const clash = await tx.query(
        `SELECT 1 FROM contacts
         WHERE deleted_at IS NULL AND id <> $1
           AND (primary_email = $2 OR ($3::text IS NOT NULL AND apollo_person_id = $3))
         LIMIT 1`,
        [mergedId, merged['primary_email'], merged['apollo_person_id'] ?? null],
      );
      if (clash.rows[0]) {
        throw new DomainError({
          status: 409,
          code: 'MERGE_UNDO_IN_USE',
          title: "Can't undo this merge",
          detail:
            "The merged contact's email address now belongs to another contact. Change that contact's email first, then undo the merge.",
        });
      }
    } else if (merged['domain']) {
      const clash = await tx.query(
        `SELECT 1 FROM companies WHERE deleted_at IS NULL AND id <> $1 AND domain = $2 LIMIT 1`,
        [mergedId, merged['domain']],
      );
      if (clash.rows[0]) {
        throw new DomainError({
          status: 409,
          code: 'MERGE_UNDO_IN_USE',
          title: "Can't undo this merge",
          detail:
            "The merged company's website now belongs to another company. Change that company's website first, then undo the merge.",
        });
      }
    }

    await tx.query(
      `UPDATE ${meta.table} SET deleted_at = NULL, version = version + 1, updated_at = NOW()
       WHERE id = $1`,
      [mergedId],
    );
    for (const rel of meta.relations) {
      await this.moveRelationBack(tx, rel, snap.moved[rel.key] ?? [], keptId, mergedId);
    }

    if (entity === 'contact') {
      await this.syncPrimaryFlags(tx, [keptId, mergedId]);
      if (snap.stoppedEnrollments.length > 0) {
        // Back as paused: someone decides whether to carry on sending.
        await tx.query(
          `UPDATE sequence_enrollments SET status = 'paused', stop_reason = NULL, stopped_at = NULL
           WHERE id = ANY($1::text[]) AND status = 'stopped_merged'`,
          [snap.stoppedEnrollments],
        );
      }
      if (snap.listsMoved.length > 0) {
        await tx.query(
          `UPDATE list_members SET contact_id = $1 WHERE contact_id = $2 AND list_id = ANY($3::text[])`,
          [mergedId, keptId, snap.listsMoved],
        );
      }
      for (const dropped of snap.listsDropped) {
        const back = await tx.query(
          `INSERT INTO list_members (list_id, contact_id, added_at)
           SELECT id, $2, $3::timestamptz FROM lists WHERE id = $1
           ON CONFLICT DO NOTHING
           RETURNING list_id`,
          [dropped.listId, mergedId, dropped.addedAt],
        );
        if (back.rows[0]) {
          await tx.query(`UPDATE lists SET member_count = member_count + 1 WHERE id = $1`, [
            dropped.listId,
          ]);
        }
      }
    }

    if (snap.tagsAdded.length > 0) {
      await tx.query(
        `DELETE FROM entity_tags WHERE entity_type = $1 AND entity_id = $2 AND tag_id = ANY($3::text[])`,
        [entity, keptId, snap.tagsAdded],
      );
    }
    for (const { id, side } of snap.candidatesRepointed) {
      await tx.query(
        `UPDATE duplicate_candidates SET ${side === 'left' ? 'left' : 'right'}_entity_id = $2
         WHERE id = $1 AND ${side === 'left' ? 'left' : 'right'}_entity_id = $3 AND status = 'open'`,
        [id, mergedId, keptId],
      );
    }
    for (const id of snap.candidatesClosed) await this.reopenCandidate(tx, id);

    const keptName = recordName(entity, { ...kept, ...revert });
    const mergedName = recordName(entity, merged);
    await insertActivity(tx, {
      entityType: entity,
      entityId: keptId,
      activityType: 'merge',
      title: `Undid the merge of ${mergedName}`,
      detail: `${mergedName} is a separate ${meta.noun} again.`,
      actorUserId: user.id,
      links: entity === 'contact' ? { contactId: keptId } : { companyId: keptId },
      metadata: { mergedId, undone: true },
    });
    await insertActivity(tx, {
      entityType: entity,
      entityId: mergedId,
      activityType: 'merge',
      title: `Restored after the merge into ${keptName} was undone`,
      detail: '',
      actorUserId: user.id,
      links:
        entity === 'contact'
          ? { contactId: mergedId, companyId: (merged['company_id'] as string | null) ?? null }
          : { companyId: mergedId },
      metadata: { keptId, undone: true },
    });
    return { keptFields, keptName, mergedName };
  }

  /** Reopens a closed pair unless the same pair is already open. */
  async reopenCandidate(tx: Q, id: string): Promise<void> {
    await tx.query(
      `UPDATE duplicate_candidates d
       SET status = 'open', resolved_at = NULL, resolved_by = NULL
       WHERE d.id = $1 AND d.status = 'merged'
         AND NOT EXISTS (
           SELECT 1 FROM duplicate_candidates o
           WHERE o.status = 'open' AND o.entity_type = d.entity_type
             AND LEAST(o.left_entity_id, o.right_entity_id) = LEAST(d.left_entity_id, d.right_entity_id)
             AND GREATEST(o.left_entity_id, o.right_entity_id) = GREATEST(d.left_entity_id, d.right_entity_id))`,
      [id],
    );
  }

  // -------------------------------------------------------------------------
  // Finding probable duplicates among existing records
  // -------------------------------------------------------------------------

  /**
   * Checks records changed after the cursor against the probable-duplicate rules (PRD 4.9)
   * and queues new pairs. Returns the cursor to continue from.
   */
  async scanBatch(
    tx: DbTx,
    entity: MergeEntity,
    after: { at: string; id: string } | null,
    limit: number,
  ): Promise<{ checked: number; queued: number; last: { at: string; id: string } | null }> {
    const meta = META[entity];
    const batch = await tx.query<{ id: string; at: string }>(
      `SELECT id, updated_at::text AS at FROM ${meta.table}
       WHERE deleted_at IS NULL
         AND ($1::timestamptz IS NULL OR (updated_at, id) > ($1::timestamptz, $2::text))
       ORDER BY updated_at, id
       LIMIT $3`,
      [after?.at ?? null, after?.id ?? '', limit],
    );
    const ids = batch.rows.map((r) => r.id);
    if (ids.length === 0) return { checked: 0, queued: 0, last: after };
    const pairs =
      entity === 'contact'
        ? await tx.query<{ new_id: string; old_id: string; reason: string; confidence: number }>(
            `SELECT b.id AS new_id, c.id AS old_id, 'Same name and company domain' AS reason,
                    0.85::float8 AS confidence
             FROM contacts b
             JOIN companies co ON co.id = b.company_id AND co.domain IS NOT NULL AND co.deleted_at IS NULL
             JOIN contacts c ON c.company_id = b.company_id AND c.id <> b.id AND c.deleted_at IS NULL
               AND LOWER(c.first_name) = LOWER(b.first_name) AND LOWER(c.last_name) = LOWER(b.last_name)
             WHERE b.id = ANY($1::text[]) AND b.first_name <> '' AND b.last_name <> ''
             UNION ALL
             SELECT b.id, c.id, 'Same phone number', 0.8::float8
             FROM contacts b
             JOIN contacts c ON c.phone_e164 = b.phone_e164 AND c.id <> b.id AND c.deleted_at IS NULL
             WHERE b.id = ANY($1::text[]) AND b.phone_e164 IS NOT NULL`,
            [ids],
          )
        : await tx.query<{ new_id: string; old_id: string; reason: string; confidence: number }>(
            `SELECT b.id AS new_id, c.id AS old_id,
                    'Similar company name in the same country' AS reason,
                    ROUND(similarity(c.name, b.name)::numeric, 2)::float8 AS confidence
             FROM companies b
             JOIN companies c ON c.id <> b.id AND c.deleted_at IS NULL AND c.market = b.market
               AND c.name % b.name
             WHERE b.id = ANY($1::text[]) AND similarity(c.name, b.name) >= 0.8`,
            [ids],
          );
    let queued = 0;
    for (const pair of pairs.rows) {
      if (
        await queueDuplicatePair(
          tx,
          entity,
          pair.old_id,
          pair.new_id,
          pair.reason,
          Number(pair.confidence),
          null,
        )
      ) {
        queued += 1;
      }
    }
    const lastRow = batch.rows[batch.rows.length - 1];
    return {
      checked: ids.length,
      queued,
      last: lastRow ? { at: lastRow.at, id: lastRow.id } : after,
    };
  }
}

/** What a merge moved, by the labels people see, from its snapshot. */
export function movedCounts(
  entity: MergeEntity,
  snap: Pick<MergeSnapshot, 'moved' | 'tagsAdded' | 'listsMoved'>,
): { label: string; count: number }[] {
  return [
    ...META[entity].relations
      .filter((rel) => rel.label)
      .map((rel) => ({ label: rel.label, count: snap.moved[rel.key]?.length ?? 0 })),
    { label: 'Tags', count: snap.tagsAdded.length },
    ...(entity === 'contact' ? [{ label: 'Lists', count: snap.listsMoved.length }] : []),
  ];
}
