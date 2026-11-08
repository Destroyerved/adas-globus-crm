import { randomUUID } from 'node:crypto';
import {
  CreateNoteInputSchema,
  LogActivityInputSchema,
  RecordEntityTypeSchema,
  SetTagsInputSchema,
  UpdateNoteInputSchema,
  type RecordEntityType,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { getCapabilityScope, scopeWhere } from '../../platform/scope/index.js';
import { insertActivity, linksFor, requireRecord } from './access.js';
import { leadStatusCategory } from './records.js';

/**
 * Notes, tags, logged calls and meetings, the activity timeline and record profiles
 * (PRD 3.1, 3.2, 4.3, 4.4, 4.7).
 */

type Row = Record<string, unknown>;

const TIMELINE_LINK_COLUMN: Record<RecordEntityType, string> = {
  lead: 'lead_id',
  contact: 'contact_id',
  company: 'company_id',
  deal: 'deal_id',
};

const ACTIVITY_TITLES: Record<string, string> = {
  call: 'Logged a call',
  meeting: 'Logged a meeting',
  email_logged: 'Logged an email',
};

export class CrmTimelineService {
  constructor(private readonly db: DatabaseService) {}

  // -------------------------------------------------------------------------
  // Timeline (PRD 4.7): activities, notes and status/stage history, newest first.
  // -------------------------------------------------------------------------

  async timeline(
    user: SessionUser,
    rawEntityType: string,
    entityId: string,
    options: { before?: string | null; limit?: number } = {},
  ): Promise<{ items: Row[]; nextBefore: string | null }> {
    const entityType = RecordEntityTypeSchema.parse(rawEntityType);
    await requireRecord(this.db, user, entityType, entityId, 'read');
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    // The cursor is "<timestamp>|<id>": several rows written in one transaction share a
    // timestamp, so the id breaks ties and no row is skipped between pages.
    const [beforeAt, beforeId] = parseTimelineCursor(options.before);
    const linkCol = TIMELINE_LINK_COLUMN[entityType];

    const parts = [
      `SELECT a.id, 'activity' AS source, a.activity_type AS kind, a.title, a.detail,
              a.actor_user_id, u.name AS actor_name, a.occurred_at AS at, a.metadata
       FROM activities a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.${linkCol} = $1`,
      `SELECT n.id, 'note', 'note', 'Note', n.body, n.author_user_id, u.name, n.created_at,
              jsonb_build_object('version', n.version, 'updatedAt', n.updated_at)
       FROM notes n LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.entity_type = $2 AND n.entity_id = $1 AND n.deleted_at IS NULL`,
    ];
    if (entityType === 'lead') {
      parts.push(
        `SELECT h.id, 'history', 'status_change',
                CONCAT('Status changed to ', h.to_status), COALESCE(h.reason, ''),
                h.changed_by_user_id, u.name, h.created_at,
                jsonb_build_object('from', h.from_status, 'to', h.to_status)
         FROM lead_status_history h LEFT JOIN users u ON u.id = h.changed_by_user_id
         WHERE h.lead_id = $1`,
      );
    }
    if (entityType === 'deal' || entityType === 'company') {
      parts.push(
        `SELECT h.id, 'history', 'stage_change',
                CONCAT(d.name, ' moved to ', h.to_stage), '',
                h.changed_by_user_id, u.name, h.created_at,
                jsonb_build_object('from', h.from_stage, 'to', h.to_stage, 'dealId', d.id)
         FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id
         LEFT JOIN users u ON u.id = h.changed_by_user_id
         WHERE ${entityType === 'deal' ? 'h.deal_id' : 'd.company_id'} = $1`,
      );
    }

    const res = await this.db.query<Row & { at: Date | string; at_cursor: string; id: string }>(
      `SELECT timeline.*, timeline.at::text AS at_cursor
       FROM (${parts.join(' UNION ALL ')}) timeline
       WHERE ($3::timestamptz IS NULL OR (timeline.at, timeline.id) < ($3::timestamptz, $4::text))
       ORDER BY timeline.at DESC, timeline.id DESC
       LIMIT ${limit + 1}`,
      [entityId, entityType, beforeAt, beforeId],
    );
    const hasMore = res.rows.length > limit;
    const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
    const last = rows[rows.length - 1];
    const items = rows.map(({ at_cursor: _cursor, ...item }) => item);
    return { items, nextBefore: hasMore && last ? `${last.at_cursor}|${last.id}` : null };
  }

  // -------------------------------------------------------------------------
  // Logging calls, meetings and emails (PRD 3.2, 4.7)
  // -------------------------------------------------------------------------

  async logActivity(user: SessionUser, raw: unknown): Promise<Row> {
    const input = LogActivityInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const record = await requireRecord<Row>(tx, user, input.entityType, input.entityId, 'write');
      const links = await linksFor(tx, input.entityType, record);
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      if (Date.parse(occurredAt) > Date.now() + 5 * 60_000) {
        throw new ValidationDomainError("You can't log something that hasn't happened yet.", {
          occurredAt: ['Pick a time in the past.'],
        });
      }
      const id = await insertActivity(tx, {
        entityType: input.entityType,
        entityId: input.entityId,
        activityType: input.activityType,
        title: input.title || ACTIVITY_TITLES[input.activityType] || 'Logged activity',
        detail: input.detail,
        actorUserId: user.id,
        links,
        metadata: input.outcome ? { outcome: input.outcome } : {},
        occurredAt,
      });

      // Last-contacted dates on every linked record (PRD 2.3, 4.5).
      if (links.leadId) {
        await tx.query(
          `UPDATE leads SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::timestamptz), $2::timestamptz) WHERE id = $1`,
          [links.leadId, occurredAt],
        );
      }
      if (links.contactId) {
        await tx.query(
          `UPDATE contacts SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::timestamptz), $2::timestamptz) WHERE id = $1`,
          [links.contactId, occurredAt],
        );
      }
      if (links.companyId) {
        await tx.query(
          `UPDATE companies SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::timestamptz), $2::timestamptz) WHERE id = $1`,
          [links.companyId, occurredAt],
        );
      }
      if (links.dealId) {
        await tx.query(`UPDATE deals SET last_activity_at = NOW() WHERE id = $1`, [links.dealId]);
      }

      // PRD 4.10, 14: the first logged call or email to the inquirer stops the first-response
      // SLA clock. A response after the deadline still closes the task but counts as a breach.
      if (input.activityType !== 'meeting' && (links.leadId || links.contactId)) {
        await tx.query(
          `UPDATE tasks
           SET status = 'completed', completed_at = $3::timestamptz, completed_by_user_id = $4,
               outcome = COALESCE(outcome, 'First response logged'),
               sla_breached = sla_breached OR (sla_deadline_at IS NOT NULL AND $3::timestamptz > sla_deadline_at),
               version = version + 1, updated_at = NOW()
           WHERE task_type = 'sla_first_response' AND status = 'open' AND deleted_at IS NULL
             AND (lead_id = $1 OR contact_id = $2)`,
          [links.leadId ?? null, links.contactId ?? null, occurredAt, user.id],
        );
      }

      // PRD 3.2: the first outbound touch moves a lead to Contacted; a meeting to Engaged.
      if (links.leadId) {
        const lead = await tx.query<{ status: string }>(
          `SELECT status FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [links.leadId],
        );
        const from = lead.rows[0]?.status;
        let to: 'Contacted' | 'Engaged' | null = null;
        if (
          input.activityType === 'meeting' &&
          ['New', 'Researching', 'Contacted'].includes(from ?? '')
        ) {
          to = 'Engaged';
        } else if (
          (input.activityType === 'call' || input.activityType === 'email_logged') &&
          ['New', 'Researching'].includes(from ?? '')
        ) {
          to = 'Contacted';
        }
        if (from && to) {
          await tx.query(
            `UPDATE leads SET status = $2, status_category = $3, version = version + 1, updated_at = NOW() WHERE id = $1`,
            [links.leadId, to, leadStatusCategory(to)],
          );
          await tx.query(
            `INSERT INTO lead_status_history (id, lead_id, from_status, to_status, changed_by_user_id, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              `lsh_${randomUUID()}`,
              links.leadId,
              from,
              to,
              user.id,
              `Automatic: ${input.activityType === 'meeting' ? 'meeting' : 'outbound touch'} logged`,
            ],
          );
          await this.db.addOutboxEvent(tx, {
            eventType: 'lead.status_changed',
            aggregateType: 'lead',
            aggregateId: links.leadId,
            payload: { leadId: links.leadId, from, to, automatic: true },
          });
        }
      }

      await this.db.addOutboxEvent(tx, {
        eventType: 'activity.logged',
        aggregateType: input.entityType,
        aggregateId: input.entityId,
        payload: { activityId: id, activityType: input.activityType },
      });
      const created = await tx.query<Row>(`SELECT * FROM activities WHERE id = $1`, [id]);
      return created.rows[0] ?? { id };
    });
  }

  // -------------------------------------------------------------------------
  // Notes (PRD 3.1: edit history kept)
  // -------------------------------------------------------------------------

  async createNote(user: SessionUser, raw: unknown): Promise<Row> {
    const input = CreateNoteInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireRecord(tx, user, input.entityType, input.entityId, 'write');
      const id = `note_${randomUUID()}`;
      const res = await tx.query<Row>(
        `INSERT INTO notes (id, entity_type, entity_id, body, author_user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, input.entityType, input.entityId, input.body, user.id],
      );
      await this.db.addOutboxEvent(tx, {
        eventType: 'note.created',
        aggregateType: input.entityType,
        aggregateId: input.entityId,
        payload: { noteId: id },
      });
      return res.rows[0] ?? { id };
    });
  }

  async updateNote(user: SessionUser, noteId: string, raw: unknown): Promise<Row> {
    const input = UpdateNoteInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const res = await tx.query<Row>(
        `SELECT * FROM notes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [noteId],
      );
      const note = res.rows[0];
      if (!note) throw new NotFoundDomainError('Note', noteId);
      const entityType = RecordEntityTypeSchema.parse(note['entity_type']);
      await requireRecord(tx, user, entityType, String(note['entity_id']), 'write');
      const writeScope = getCapabilityScope(
        user,
        `${entityType === 'company' ? 'companies' : `${entityType}s`}.write`,
      );
      if (note['author_user_id'] !== user.id && writeScope !== 'all') {
        throw new DomainError({
          status: 403,
          code: 'NOT_NOTE_AUTHOR',
          title: 'Not your note',
          detail: 'Only the person who wrote a note can edit it.',
        });
      }
      if (note['version'] !== input.version) throw new VersionConflictError('Note', noteId);
      const updated = await tx.query<Row>(
        `UPDATE notes SET body = $3, version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 RETURNING *`,
        [noteId, input.version, input.body],
      );
      if (!updated.rows[0]) throw new VersionConflictError('Note', noteId);
      await this.db.writeRecordHistory(tx, {
        entityType: 'note',
        entityId: noteId,
        fieldName: 'body',
        oldValue: note['body'],
        newValue: input.body,
        changedByUserId: user.id,
      });
      return updated.rows[0];
    });
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async listTags(): Promise<Row[]> {
    const res = await this.db.query(
      `SELECT t.id, t.name, COUNT(et.entity_id)::int AS usage_count
       FROM tags t LEFT JOIN entity_tags et ON et.tag_id = t.id
       GROUP BY t.id, t.name ORDER BY t.name LIMIT 500`,
    );
    return res.rows;
  }

  async setTags(
    user: SessionUser,
    rawEntityType: string,
    entityId: string,
    raw: unknown,
  ): Promise<{ tags: string[] }> {
    const entityType = RecordEntityTypeSchema.parse(rawEntityType);
    const input = SetTagsInputSchema.parse(raw);
    const names = [...new Set(input.tags.map((t) => t.trim().toLowerCase()))].sort();
    return this.db.transaction(async (tx) => {
      await requireRecord(tx, user, entityType, entityId, 'write');
      const before = await tx.query<{ name: string }>(
        `SELECT t.name FROM entity_tags et JOIN tags t ON t.id = et.tag_id
         WHERE et.entity_type = $1 AND et.entity_id = $2 ORDER BY t.name`,
        [entityType, entityId],
      );
      for (const name of names) {
        await tx.query(
          `INSERT INTO tags (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
          [`tag_${randomUUID()}`, name],
        );
      }
      await tx.query(`DELETE FROM entity_tags WHERE entity_type = $1 AND entity_id = $2`, [
        entityType,
        entityId,
      ]);
      if (names.length > 0) {
        await tx.query(
          `INSERT INTO entity_tags (entity_type, entity_id, tag_id)
           SELECT $1, $2, id FROM tags WHERE name = ANY($3::text[])`,
          [entityType, entityId, names],
        );
      }
      const old = before.rows.map((r) => r.name);
      if (JSON.stringify(old) !== JSON.stringify(names)) {
        await this.db.writeRecordHistory(tx, {
          entityType,
          entityId,
          fieldName: 'tags',
          oldValue: old,
          newValue: names,
          changedByUserId: user.id,
        });
      }
      return { tags: names };
    });
  }

  // -------------------------------------------------------------------------
  // Profiles (PRD 4.4, 4.5, 4.6)
  // -------------------------------------------------------------------------

  private async tagsFor(entityType: RecordEntityType, id: string): Promise<string[]> {
    const res = await this.db.query<{ name: string }>(
      `SELECT t.name FROM entity_tags et JOIN tags t ON t.id = et.tag_id
       WHERE et.entity_type = $1 AND et.entity_id = $2 ORDER BY t.name`,
      [entityType, id],
    );
    return res.rows.map((r) => r.name);
  }

  private async openTasksFor(user: SessionUser, column: string, id: string): Promise<Row[]> {
    const scope = scopeWhere(user, 'tasks.read', {
      alias: 't',
      ownerColumn: 'assignee_user_id',
      startParamIndex: 2,
    });
    const res = await this.db.query(
      `SELECT t.id, t.title, t.task_type, t.priority, t.status, t.due_at, t.assignee_user_id,
              t.version, u.name AS assignee_name
       FROM tasks t JOIN users u ON u.id = t.assignee_user_id
       WHERE t.${column} = $1 AND t.status = 'open' AND t.deleted_at IS NULL AND ${scope.sql}
       ORDER BY t.due_at ASC LIMIT 20`,
      [id, ...scope.params],
    );
    return res.rows;
  }

  async leadProfile(user: SessionUser, leadId: string): Promise<Row> {
    const lead = await requireRecord<Row>(this.db, user, 'lead', leadId, 'read');
    const [tags, tasks, owner] = await Promise.all([
      this.tagsFor('lead', leadId),
      this.openTasksFor(user, 'lead_id', leadId),
      this.db.query(`SELECT id, name FROM users WHERE id = $1`, [lead['owner_user_id']]),
    ]);
    return { lead: { ...lead, tags }, tasks, owner: owner.rows[0] ?? null };
  }

  async contactProfile(user: SessionUser, contactId: string): Promise<Row> {
    const contact = await requireRecord<Row>(this.db, user, 'contact', contactId, 'read');
    const dealScope = scopeWhere(user, 'deals.read', { alias: 'd', startParamIndex: 2 });
    const leadScope = scopeWhere(user, 'leads.read', { alias: 'l', startParamIndex: 2 });
    const email = String(contact['primary_email']);
    const [tags, tasks, company, emails, phones, deals, leads, suppression, consent, enrollments] =
      await Promise.all([
        this.tagsFor('contact', contactId),
        this.openTasksFor(user, 'contact_id', contactId),
        contact['company_id']
          ? this.db.query(
              `SELECT id, name, domain, market, account_status FROM companies WHERE id = $1`,
              [contact['company_id']],
            )
          : Promise.resolve({ rows: [] as Row[] }),
        this.db.query(
          `SELECT email, is_primary, verification_status, hard_bounced_at FROM contact_emails
           WHERE contact_id = $1 ORDER BY is_primary DESC, email`,
          [contactId],
        ),
        this.db.query(
          `SELECT phone_e164, phone_label, is_primary FROM contact_phones WHERE contact_id = $1
           ORDER BY is_primary DESC`,
          [contactId],
        ),
        this.db.query(
          `SELECT d.id, d.name, d.stage_name, d.stage_category, d.monthly_value_minor, d.currency, d.updated_at
           FROM deals d WHERE d.primary_contact_id = $1 AND d.deleted_at IS NULL AND ${dealScope.sql}
           ORDER BY d.updated_at DESC`,
          [contactId, ...dealScope.params],
        ),
        this.db.query(
          `SELECT l.id, l.status, l.status_category, l.source, l.created_at
           FROM leads l WHERE (l.contact_id = $1) AND l.deleted_at IS NULL AND ${leadScope.sql}
           ORDER BY l.created_at DESC`,
          [contactId, ...leadScope.params],
        ),
        this.db.query(
          `SELECT reason, source, created_at FROM suppressions WHERE email = $1
           UNION ALL
           SELECT reason, 'domain', created_at FROM suppressed_domains WHERE domain = split_part($1, '@', 2)
           LIMIT 1`,
          [email],
        ),
        this.db.query(
          `SELECT basis, status, source, captured_at, expires_at FROM consent_records
           WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
          [email],
        ),
        this.db.query(
          `SELECT e.id, s.name AS sequence_name, e.status, e.enrolled_at, e.stop_reason
           FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
           WHERE e.contact_id = $1 ORDER BY e.enrolled_at DESC LIMIT 10`,
          [contactId],
        ),
      ]);
    return {
      contact: { ...contact, tags },
      company: company.rows[0] ?? null,
      emails: emails.rows,
      phones: phones.rows,
      deals: deals.rows,
      leads: leads.rows,
      tasks,
      suppression: suppression.rows[0] ?? null,
      consent: consent.rows[0] ?? null,
      enrollments: enrollments.rows,
    };
  }

  async dealProfile(user: SessionUser, dealId: string): Promise<Row> {
    const deal = await requireRecord<Row>(this.db, user, 'deal', dealId, 'read');
    const [tags, tasks, company, contact, stages] = await Promise.all([
      this.tagsFor('deal', dealId),
      this.openTasksFor(user, 'deal_id', dealId),
      this.db.query(`SELECT id, name, market, domain FROM companies WHERE id = $1`, [
        deal['company_id'],
      ]),
      deal['primary_contact_id']
        ? this.db.query(`SELECT id, full_name, title, primary_email FROM contacts WHERE id = $1`, [
            deal['primary_contact_id'],
          ])
        : Promise.resolve({ rows: [] as Row[] }),
      this.db.query(
        `SELECT id, name, category, probability, stage_order, required_fields
         FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY stage_order`,
        [deal['pipeline_id']],
      ),
    ]);
    return {
      deal: { ...deal, tags },
      company: company.rows[0] ?? null,
      primaryContact: contact.rows[0] ?? null,
      tasks,
      stages: stages.rows,
    };
  }

  // -------------------------------------------------------------------------
  // Reference lists and pipelines (PRD 3.3, 3.4)
  // -------------------------------------------------------------------------

  async referenceLists(): Promise<Record<string, string[]>> {
    const res = await this.db.query<{ key: string; value_json: unknown }>(
      `SELECT key, value_json FROM settings WHERE key LIKE 'reference.%' ORDER BY key`,
    );
    const out: Record<string, string[]> = {};
    for (const row of res.rows) {
      out[row.key.slice('reference.'.length)] = Array.isArray(row.value_json)
        ? row.value_json.map(String)
        : [];
    }
    return out;
  }

  async pipelines(): Promise<Row[]> {
    const [pipelines, stages] = await Promise.all([
      this.db.query(`SELECT id, name, is_default FROM pipelines ORDER BY is_default DESC, name`),
      this.db.query(
        `SELECT id, pipeline_id, name, category, probability, stage_order, required_fields, idle_days,
                is_trial
         FROM pipeline_stages ORDER BY pipeline_id, stage_order`,
      ),
    ]);
    return pipelines.rows.map((p) => ({
      ...p,
      stages: stages.rows.filter((s) => s['pipeline_id'] === p['id']),
    }));
  }
}

function parseTimelineCursor(raw: string | null | undefined): [string | null, string] {
  if (!raw) return [null, ''];
  const split = raw.lastIndexOf('|');
  const at = split > 0 ? raw.slice(0, split) : raw;
  const id = split > 0 ? raw.slice(split + 1) : '';
  // Postgres text timestamps ("2026-11-08 10:00:00.123456+00") and ISO strings are accepted.
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(at)) {
    return [null, ''];
  }
  return [at, id];
}
