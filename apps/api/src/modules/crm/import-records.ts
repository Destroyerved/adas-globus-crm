import { randomUUID } from 'node:crypto';
import { sha256Hex, type DatabaseService, type DbTx } from '../../platform/db/index.js';
import { insertActivity } from './access.js';
import { queueDuplicatePair } from './merge-records.js';

/**
 * Record writes for imports (PRD 4.9). The imports module decides what each row should do;
 * this file owns how contacts and companies are found, created, updated and undone, so other
 * modules never touch the CRM tables directly (PRD 6.4).
 */

type Row = Record<string, unknown>;
type Market = 'US' | 'CA' | 'OTHER';
export type ImportedEntity = 'contact' | 'company';

export interface ImportContext {
  batchId: string;
  filename: string;
  /** The user who ran the import; record history and activities name them. */
  actorUserId: string;
  ownerUserId: string;
  ownerTeamId: string | null;
  source: string;
}

export interface ImportContactInput {
  email: string;
  firstName: string;
  lastName: string;
  title: string | null;
  phone: string | null;
  market: Market;
}

export interface ImportCompanyInput {
  name: string;
  domain: string | null;
  market: Market;
  stateProvince: string | null;
  city: string | null;
  staffBand: string | null;
  firmType: string | null;
}

export interface ProbableMatch {
  id: string;
  reason: string;
  confidence: number;
}

/** Columns an import may change, by entity. */
export const IMPORT_UPDATABLE: Record<ImportedEntity, readonly string[]> = {
  contact: ['first_name', 'last_name', 'full_name', 'title', 'phone_e164', 'company_id', 'market'],
  company: ['name', 'market', 'state_province', 'city', 'staff_band', 'firm_type'],
};

const TABLE: Record<ImportedEntity, string> = { contact: 'contacts', company: 'companies' };

function defaultTimezone(market: Market): string {
  return market === 'CA' ? 'America/Toronto' : 'America/New_York';
}

export class ImportRecordWriter {
  constructor(private readonly db: DatabaseService) {}

  // -------------------------------------------------------------------------
  // Matching (PRD 4.9 duplicate rules)
  // -------------------------------------------------------------------------

  /** Active suppression entry for an email address or its SHA-256 hash (PRD 4.9, 4.18, 5.6). */
  async suppressionForEmail(tx: DbTx, email: string): Promise<{ reason: string } | null> {
    const res = await tx.query<{ reason: string }>(
      `SELECT reason FROM suppressions
       WHERE (email = $1 OR email_sha256 = $2) AND lifted_at IS NULL
       LIMIT 1`,
      [email, sha256Hex(email)],
    );
    return res.rows[0] ?? null;
  }

  /** Definite contact match: the same normalised email on an active contact. */
  async contactByEmail(tx: DbTx, email: string): Promise<Row | null> {
    const res = await tx.query(
      `SELECT c.* FROM (
         SELECT id FROM contacts WHERE deleted_at IS NULL AND primary_email = $1
         UNION
         SELECT contact_id AS id FROM contact_emails WHERE email = $1
       ) m
       JOIN contacts c ON c.id = m.id
       WHERE c.deleted_at IS NULL
       ORDER BY c.created_at
       LIMIT 1`,
      [email],
    );
    return res.rows[0] ?? null;
  }

  /** Probable contact match: same first and last name at the same company domain, or same phone. */
  async probableContact(
    tx: DbTx,
    input: ImportContactInput,
    companyDomain: string | null,
  ): Promise<ProbableMatch | null> {
    if (companyDomain && input.firstName && input.lastName) {
      const res = await tx.query<{ id: string }>(
        `SELECT c.id FROM contacts c JOIN companies co ON co.id = c.company_id
         WHERE c.deleted_at IS NULL AND co.deleted_at IS NULL AND co.domain = $3
           AND LOWER(c.first_name) = LOWER($1) AND LOWER(c.last_name) = LOWER($2)
         ORDER BY c.created_at LIMIT 1`,
        [input.firstName, input.lastName, companyDomain],
      );
      const hit = res.rows[0];
      if (hit) return { id: hit.id, reason: 'Same name and company domain', confidence: 0.85 };
    }
    if (input.phone) {
      const res = await tx.query<{ id: string }>(
        `SELECT id FROM contacts WHERE deleted_at IS NULL AND phone_e164 = $1
         ORDER BY created_at LIMIT 1`,
        [input.phone],
      );
      const hit = res.rows[0];
      if (hit) return { id: hit.id, reason: 'Same phone number', confidence: 0.8 };
    }
    return null;
  }

  /** Definite company match: the same normalised domain on an active company. */
  async companyByDomain(tx: DbTx, domain: string): Promise<Row | null> {
    const res = await tx.query(
      `SELECT * FROM companies WHERE domain = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [domain],
    );
    return res.rows[0] ?? null;
  }

  /** A company with no website, linked by its exact name within one country. */
  async companyByExactName(tx: DbTx, name: string, market: Market): Promise<Row | null> {
    const res = await tx.query(
      `SELECT * FROM companies
       WHERE deleted_at IS NULL AND LOWER(name) = LOWER($1) AND market = $2
       ORDER BY created_at LIMIT 1`,
      [name, market],
    );
    return res.rows[0] ?? null;
  }

  /** Probable company match: name trigram similarity of at least 0.8 in the same country. */
  async probableCompany(tx: DbTx, name: string, market: Market): Promise<ProbableMatch | null> {
    const res = await tx.query<{ id: string; score: number }>(
      `SELECT id, similarity(name, $1)::float8 AS score FROM companies
       WHERE deleted_at IS NULL AND market = $2 AND name % $1 AND similarity(name, $1) >= 0.8
       ORDER BY score DESC, created_at LIMIT 1`,
      [name, market],
    );
    const hit = res.rows[0];
    return hit
      ? {
          id: hit.id,
          reason: 'Similar company name in the same country',
          confidence: Math.round(Number(hit.score) * 100) / 100,
        }
      : null;
  }

  async addDuplicateCandidate(
    tx: DbTx,
    entity: ImportedEntity,
    existingId: string,
    newId: string,
    match: ProbableMatch,
    batchId: string,
  ): Promise<void> {
    // A pair someone dismissed or merged before is never queued again (ADR 0009).
    await queueDuplicatePair(
      tx,
      entity,
      existingId,
      newId,
      match.reason,
      match.confidence,
      batchId,
    );
  }

  // -------------------------------------------------------------------------
  // Creating and updating
  // -------------------------------------------------------------------------

  async createContact(
    tx: DbTx,
    input: ImportContactInput,
    companyId: string | null,
    ctx: ImportContext,
    doNotContact = false,
  ): Promise<{ id: string; version: number }> {
    const id = `cnt_${randomUUID()}`;
    const fullName = `${input.firstName} ${input.lastName}`.trim();
    await tx.query(
      `INSERT INTO contacts (
         id, company_id, first_name, last_name, full_name, title, job_function, seniority,
         primary_email, phone_e164, market, timezone, owner_user_id, team_id, source,
         import_batch_id, do_not_contact
       ) VALUES ($1, $2, $3, $4, $5, $6, '', '', $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        companyId,
        input.firstName,
        input.lastName,
        fullName,
        input.title ?? '',
        input.email,
        input.phone,
        input.market,
        defaultTimezone(input.market),
        ctx.ownerUserId,
        ctx.ownerTeamId,
        ctx.source,
        ctx.batchId,
        doNotContact,
      ],
    );
    await tx.query(
      `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
       VALUES ($1, $2, $3, TRUE, 'unknown')
       ON CONFLICT (email) DO NOTHING`,
      [`ce_${randomUUID()}`, id, input.email],
    );
    if (input.phone) {
      await tx.query(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_label, is_primary)
         VALUES ($1, $2, $3, 'work', TRUE)`,
        [`cp_${randomUUID()}`, id, input.phone],
      );
    }
    await insertActivity(tx, {
      entityType: 'contact',
      entityId: id,
      activityType: 'import',
      title: `Imported from ${ctx.filename}`,
      detail: '',
      actorUserId: ctx.actorUserId,
      links: { contactId: id, companyId },
      metadata: { importBatchId: ctx.batchId },
    });
    return { id, version: 1 };
  }

  async createCompany(
    tx: DbTx,
    input: ImportCompanyInput,
    ctx: ImportContext,
  ): Promise<{ id: string; version: number }> {
    const id = `cmp_${randomUUID()}`;
    await tx.query(
      `INSERT INTO companies (
         id, name, domain, website, firm_type, market, state_province, city, timezone,
         staff_band, owner_user_id, team_id, source, import_batch_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        input.name,
        input.domain,
        input.domain ? `https://${input.domain}` : null,
        input.firmType ?? 'Other',
        input.market,
        input.stateProvince,
        input.city,
        defaultTimezone(input.market),
        input.staffBand ?? '',
        ctx.ownerUserId,
        ctx.ownerTeamId,
        ctx.source,
        ctx.batchId,
      ],
    );
    await insertActivity(tx, {
      entityType: 'company',
      entityId: id,
      activityType: 'import',
      title: `Imported from ${ctx.filename}`,
      detail: '',
      actorUserId: ctx.actorUserId,
      links: { companyId: id },
      metadata: { importBatchId: ctx.batchId },
    });
    return { id, version: 1 };
  }

  /**
   * Applies field changes to a matched record with optimistic locking and record history.
   * Returns null when someone changed the record between the read and this write.
   */
  async update(
    tx: DbTx,
    entity: ImportedEntity,
    current: Row,
    changes: Record<string, unknown>,
    ctx: ImportContext,
  ): Promise<{ version: number; before: Record<string, unknown> } | null> {
    const columns = Object.keys(changes).filter((c) => IMPORT_UPDATABLE[entity].includes(c));
    if (columns.length === 0) return null;
    const sets = columns.map((c, i) => `${c} = $${i + 3}`).join(', ');
    const res = await tx.query<{ version: number }>(
      `UPDATE ${TABLE[entity]} SET ${sets}, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2 AND deleted_at IS NULL
       RETURNING version`,
      [current['id'], current['version'], ...columns.map((c) => changes[c])],
    );
    const updated = res.rows[0];
    if (!updated) return null;
    const before: Record<string, unknown> = {};
    for (const column of columns) {
      before[column] = current[column] ?? null;
      await this.db.writeRecordHistory(tx, {
        entityType: entity,
        entityId: String(current['id']),
        fieldName: column,
        oldValue: current[column] ?? null,
        newValue: changes[column],
        changedByUserId: ctx.actorUserId,
        via: 'import',
      });
    }
    if (entity === 'contact' && 'phone_e164' in changes && changes['phone_e164']) {
      await tx.query(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_label, is_primary)
         SELECT $1, $2, $3, 'work', NOT EXISTS (SELECT 1 FROM contact_phones WHERE contact_id = $2)
         WHERE NOT EXISTS (SELECT 1 FROM contact_phones WHERE contact_id = $2 AND phone_e164 = $3)`,
        [`cp_${randomUUID()}`, current['id'], changes['phone_e164']],
      );
    }
    await insertActivity(tx, {
      entityType: entity,
      entityId: String(current['id']),
      activityType: 'import',
      title: `Updated by import from ${ctx.filename}`,
      detail: '',
      actorUserId: ctx.actorUserId,
      links:
        entity === 'contact'
          ? {
              contactId: String(current['id']),
              companyId: (changes['company_id'] ?? current['company_id'] ?? null) as string | null,
            }
          : { companyId: String(current['id']) },
      metadata: { importBatchId: ctx.batchId, fields: columns },
    });
    return { version: updated.version, before };
  }

  /** Adds tags to a record; returns the names that weren't already on it. */
  async addTags(
    tx: DbTx,
    entity: ImportedEntity,
    entityId: string,
    tags: string[],
  ): Promise<string[]> {
    const names = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (names.length === 0) return [];
    for (const name of names) {
      await tx.query(`INSERT INTO tags (id, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [
        `tag_${randomUUID()}`,
        name,
      ]);
    }
    const added = await tx.query<{ name: string }>(
      `WITH ins AS (
         INSERT INTO entity_tags (entity_type, entity_id, tag_id)
         SELECT $1, $2, id FROM tags WHERE name = ANY($3::text[])
         ON CONFLICT DO NOTHING
         RETURNING tag_id
       )
       SELECT t.name FROM ins JOIN tags t ON t.id = ins.tag_id`,
      [entity, entityId, names],
    );
    return added.rows.map((r) => r.name);
  }

  // -------------------------------------------------------------------------
  // Undo (PRD 4.9: within 7 days, never over someone else's later edits)
  // -------------------------------------------------------------------------

  /**
   * Soft-deletes a record the import created, unless it has been edited or used since
   * (a newer version, or deals, leads, tasks or activities linked to it).
   */
  async undoCreate(
    tx: DbTx,
    entity: ImportedEntity,
    id: string,
    importedVersion: number,
    actorUserId: string,
  ): Promise<'removed' | 'kept'> {
    const used =
      entity === 'contact'
        ? `EXISTS (SELECT 1 FROM leads WHERE contact_id = r.id AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM deals WHERE primary_contact_id = r.id AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM tasks WHERE contact_id = r.id AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM activities WHERE contact_id = r.id AND activity_type <> 'import')`
        : `EXISTS (SELECT 1 FROM contacts WHERE company_id = r.id AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM leads WHERE company_id = r.id AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM deals WHERE company_id = r.id AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM tasks WHERE company_id = r.id AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM activities WHERE company_id = r.id AND activity_type <> 'import')`;
    const res = await tx.query<{ id: string }>(
      `UPDATE ${TABLE[entity]} r SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE r.id = $1 AND r.version = $2 AND r.deleted_at IS NULL AND NOT (${used})
       RETURNING r.id`,
      [id, importedVersion],
    );
    if (res.rows.length === 0) return 'kept';
    if (entity === 'contact') {
      // Emails are unique across all contacts; free them so a corrected file can be imported.
      await tx.query(`DELETE FROM contact_emails WHERE contact_id = $1`, [id]);
    }
    await tx.query(
      `UPDATE duplicate_candidates SET status = 'dismissed', resolved_at = NOW(), resolved_by = $3
       WHERE entity_type = $1 AND status = 'open' AND (left_entity_id = $2 OR right_entity_id = $2)`,
      [entity, id, actorUserId],
    );
    await this.db.writeRecordHistory(tx, {
      entityType: entity,
      entityId: id,
      fieldName: 'deleted_at',
      oldValue: null,
      newValue: 'import undone',
      changedByUserId: actorUserId,
      via: 'import',
    });
    return 'removed';
  }

  /** Puts back the values an import replaced, unless the record has been edited since. */
  async revertUpdate(
    tx: DbTx,
    entity: ImportedEntity,
    id: string,
    importedVersion: number,
    before: Record<string, unknown>,
    tagsAdded: string[],
    actorUserId: string,
  ): Promise<'reverted' | 'kept'> {
    const columns = Object.keys(before).filter((c) => IMPORT_UPDATABLE[entity].includes(c));
    const current = await tx.query(
      `SELECT * FROM ${TABLE[entity]} WHERE id = $1 AND version = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [id, importedVersion],
    );
    const row = current.rows[0];
    if (!row) return 'kept';
    if (columns.length > 0) {
      const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await tx.query(
        `UPDATE ${TABLE[entity]} SET ${sets}, version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [id, ...columns.map((c) => before[c])],
      );
      for (const column of columns) {
        await this.db.writeRecordHistory(tx, {
          entityType: entity,
          entityId: id,
          fieldName: column,
          oldValue: row[column] ?? null,
          newValue: before[column],
          changedByUserId: actorUserId,
          via: 'import',
        });
      }
    }
    if (tagsAdded.length > 0) {
      await tx.query(
        `DELETE FROM entity_tags WHERE entity_type = $1 AND entity_id = $2
           AND tag_id IN (SELECT id FROM tags WHERE name = ANY($3::text[]))`,
        [entity, id, tagsAdded],
      );
    }
    return 'reverted';
  }

  /**
   * After a contact import is undone, removes the companies it created for those contacts
   * if nothing else uses them now.
   */
  async undoImportedCompanies(
    tx: DbTx,
    batchId: string,
    actorUserId: string,
  ): Promise<{ removed: number; kept: number }> {
    const res = await tx.query<{ id: string; version: number }>(
      `SELECT id, version FROM companies WHERE import_batch_id = $1 AND deleted_at IS NULL`,
      [batchId],
    );
    let removed = 0;
    let kept = 0;
    for (const company of res.rows) {
      // Created companies start at version 1; any later edit means a user has worked on it.
      const result = await this.undoCreate(tx, 'company', company.id, 1, actorUserId);
      if (result === 'removed') removed++;
      else kept++;
    }
    return { removed, kept };
  }
}
