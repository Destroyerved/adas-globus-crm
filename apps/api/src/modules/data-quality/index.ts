import { randomUUID } from 'node:crypto';
import {
  CsvImportRequestSchema,
  MergeContactsInputSchema,
  type CsvImportRequest,
  type MergeContactsInput,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService, sha256Hex } from '../../platform/db/index.js';
import { NotFoundDomainError } from '../../platform/errors/index.js';
import {
  extractDomainFromEmail,
  isFreeMailDomain,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from '../../platform/normalize/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';

export interface ImportJobSummary {
  id: string;
  fileName: string;
  dryRun: boolean;
  status: string;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  skippedDuplicateCount: number;
  skippedSuppressedCount: number;
  errorCount: number;
  createdEntityIds: string[];
  errorRows: Array<{ rowNumber: number; email: string; error: string }>;
}

export class DataQualityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * PRD §4.9 & §5.3 (A5 & A13) — CSV Import dry-run preview & execution.
   * Suppression always wins: suppressed emails/domains are never cleared or made sendable by import.
   */
  async runCsvImport(user: SessionUser, rawRequest: CsvImportRequest): Promise<ImportJobSummary> {
    requireCapability(user, 'imports.run');
    const request = CsvImportRequestSchema.parse(rawRequest);

    const jobId = `imp_${randomUUID()}`;
    let createdCount = 0;
    let updatedCount = 0;
    let skippedDuplicateCount = 0;
    let skippedSuppressedCount = 0;
    let errorCount = 0;
    const createdEntityIds: string[] = [];
    const errorRows: Array<{ rowNumber: number; email: string; error: string }> = [];
    const seenEmailsInFile = new Set<string>();

    await this.db.transaction(async (tx) => {
      for (let i = 0; i < request.rows.length; i++) {
        const row = request.rows[i];
        if (!row) continue;
        const rowNumber = i + 1;
        const cleanEmail = normalizeEmail(row.email);

        if (!cleanEmail) {
          errorCount += 1;
          errorRows.push({
            rowNumber,
            email: row.email,
            error: 'Invalid email address syntax',
          });
          continue;
        }

        if (seenEmailsInFile.has(cleanEmail)) {
          skippedDuplicateCount += 1;
          continue;
        }
        seenEmailsInFile.add(cleanEmail);

        const emailHash = sha256Hex(cleanEmail);
        const emailDomain = extractDomainFromEmail(cleanEmail);

        // Check suppression list & suppressed domains (PRD §5.3 A13: Suppression always wins)
        const supRes = await tx.query<{ id: string }>(
          `SELECT id FROM suppressions WHERE email = $1 OR email_sha256 = $2 LIMIT 1`,
          [cleanEmail, emailHash],
        );
        const domSupRes = emailDomain
          ? await tx.query<{ id: string }>(
              `SELECT id FROM suppressed_domains WHERE domain = $1 LIMIT 1`,
              [emailDomain],
            )
          : { rows: [] };

        if (supRes.rows.length > 0 || domSupRes.rows.length > 0) {
          skippedSuppressedCount += 1;
          continue;
        }

        // Check existing contact by primary or secondary email
        const existingRes = await tx.query<{
          id: string;
          title: string;
          phone_e164: string | null;
        }>(
          `SELECT c.id, c.title, c.phone_e164
           FROM contacts c
           LEFT JOIN contact_emails ce ON ce.contact_id = c.id
           WHERE (c.primary_email = $1 OR ce.email = $1) AND c.deleted_at IS NULL
           LIMIT 1`,
          [cleanEmail],
        );

        const existing = existingRes.rows[0];
        if (existing) {
          if (request.duplicatePolicy === 'skip') {
            skippedDuplicateCount += 1;
            continue;
          }
          updatedCount += 1;
          if (!request.dryRun) {
            const phoneE164 = row.phone
              ? normalizePhone(row.phone, row.market === 'CA' ? 'CA' : 'US')
              : null;
            await tx.query(
              `UPDATE contacts
               SET title = CASE
                     WHEN $2 = 'overwrite' AND $3::text IS NOT NULL THEN $3
                     WHEN (title IS NULL OR title = '') AND $3::text IS NOT NULL THEN $3
                     ELSE title
                   END,
                   phone_e164 = COALESCE(phone_e164, $4),
                   version = version + 1,
                   updated_at = NOW()
               WHERE id = $1`,
              [existing.id, request.duplicatePolicy, row.title ?? null, phoneE164],
            );
          }
          continue;
        }

        // New contact
        createdCount += 1;
        if (!request.dryRun) {
          const rawWebDomain = row.website ? normalizeDomain(row.website) : emailDomain;
          const corporateDomain =
            rawWebDomain && !isFreeMailDomain(rawWebDomain) ? rawWebDomain : null;

          let companyId: string | null = null;
          if (corporateDomain) {
            const cmpRes = await tx.query<{ id: string }>(
              `SELECT id FROM companies WHERE domain = $1 AND deleted_at IS NULL LIMIT 1`,
              [corporateDomain],
            );
            if (cmpRes.rows[0]) {
              companyId = cmpRes.rows[0].id;
            } else {
              companyId = `cmp_${randomUUID()}`;
              await tx.query(
                `INSERT INTO companies (
                   id, name, domain, website, market, state_province,
                   owner_user_id, team_id
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  companyId,
                  row.firmName?.trim() || corporateDomain,
                  corporateDomain,
                  `https://${corporateDomain}`,
                  row.market,
                  row.stateProvince ?? null,
                  user.id,
                  user.teamId ?? 'team_us',
                ],
              );
            }
          }

          const contactId = `cnt_${randomUUID()}`;
          createdEntityIds.push(contactId);
          const firstName = row.firstName.trim() || 'Imported';
          const lastName = row.lastName.trim() || 'Contact';
          const phoneE164 = row.phone
            ? normalizePhone(row.phone, row.market === 'CA' ? 'CA' : 'US')
            : null;

          await tx.query(
            `INSERT INTO contacts (
               id, company_id, first_name, last_name, full_name, title,
               primary_email, phone_e164, market, owner_user_id, team_id,
               do_not_contact, email_verification_status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'unknown')`,
            [
              contactId,
              companyId,
              firstName,
              lastName,
              `${firstName} ${lastName}`.trim(),
              row.title?.trim() || 'Partner',
              cleanEmail,
              phoneE164,
              row.market,
              user.id,
              user.teamId ?? 'team_us',
              row.legacyNoConsent, // PRD §15 Q3: Legacy Bigin contacts without consent are non-mailable
            ],
          );

          await tx.query(
            `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
             VALUES ($1, $2, $3, TRUE, 'unknown')
             ON CONFLICT (email) DO NOTHING`,
            [`ce_${randomUUID()}`, contactId, cleanEmail],
          );

          if (row.consentBasis && !row.legacyNoConsent) {
            await tx.query(
              `INSERT INTO consent_records (id, email, contact_id, market, basis, status, source)
               VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
              [
                `cns_${randomUUID()}`,
                cleanEmail,
                contactId,
                row.market,
                row.consentBasis,
                row.source,
              ],
            );
          }
        }
      }

      await tx.query(
        `INSERT INTO import_jobs (
           id, file_name, entity_type, status, dry_run, duplicate_policy,
           total_rows, created_count, updated_count, skipped_duplicate_count,
           skipped_suppressed_count, error_count, created_entity_ids, error_rows_json,
           actor_user_id, completed_at
         ) VALUES (
           $1, $2, 'contact', $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12::jsonb, $13::jsonb,
           $14, NOW()
         )`,
        [
          jobId,
          request.fileName,
          request.dryRun ? 'dry_run' : 'completed',
          request.dryRun,
          request.duplicatePolicy,
          request.rows.length,
          createdCount,
          updatedCount,
          skippedDuplicateCount,
          skippedSuppressedCount,
          errorCount,
          JSON.stringify(createdEntityIds),
          JSON.stringify(errorRows),
          user.id,
        ],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: request.dryRun ? 'import.dry_run' : 'import.executed',
        entityType: 'import_job',
        entityId: jobId,
        metadata: {
          fileName: request.fileName,
          totalRows: request.rows.length,
          createdCount,
          updatedCount,
          skippedDuplicateCount,
          skippedSuppressedCount,
          errorCount,
        },
      });
    });

    return {
      id: jobId,
      fileName: request.fileName,
      dryRun: request.dryRun,
      status: request.dryRun ? 'dry_run' : 'completed',
      totalRows: request.rows.length,
      createdCount,
      updatedCount,
      skippedDuplicateCount,
      skippedSuppressedCount,
      errorCount,
      createdEntityIds,
      errorRows,
    };
  }

  /**
   * PRD §4.9 (A5) — Rollback an executed import job (soft-deletes created contacts).
   */
  async rollbackImportJob(
    user: SessionUser,
    importJobId: string,
  ): Promise<{ rolledBack: boolean; affectedCount: number }> {
    requireCapability(user, 'imports.run');

    return this.db.transaction(async (tx) => {
      const jobRes = await tx.query<{
        id: string;
        created_entity_ids: string[];
        status: string;
      }>(`SELECT id, created_entity_ids, status FROM import_jobs WHERE id = $1 LIMIT 1`, [
        importJobId,
      ]);

      const job = jobRes.rows[0];
      if (!job) {
        throw new NotFoundDomainError('ImportJob', importJobId);
      }

      const ids = Array.isArray(job.created_entity_ids) ? job.created_entity_ids : [];
      let affectedCount = 0;

      for (const contactId of ids) {
        const res = await tx.query(
          `UPDATE contacts SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
          [contactId],
        );
        affectedCount += res.rowCount;
      }

      await tx.query(
        `UPDATE import_jobs SET status = 'rolled_back', rolled_back_at = NOW() WHERE id = $1`,
        [importJobId],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'import.rolled_back',
        entityType: 'import_job',
        entityId: importJobId,
        metadata: { affectedCount },
      });

      return { rolledBack: true, affectedCount };
    });
  }

  /**
   * PRD §4.8 (A6) — Merge two duplicate contacts into `survivorContactId` with full undo snapshot.
   */
  async mergeContacts(
    user: SessionUser,
    rawInput: MergeContactsInput,
  ): Promise<{
    mergeLogId: string;
    survivorContactId: string;
    mergedContactId: string;
    secondaryEmailsCount: number;
  }> {
    requireCapability(user, 'duplicates.merge');
    const input = MergeContactsInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const [survivorRes, duplicateRes, dupEmailsRes, dupDealsRes, dupTasksRes, dupSeqRes] =
        await Promise.all([
          tx.query<{ id: string; primary_email: string; phone_e164: string | null }>(
            `SELECT * FROM contacts WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
            [input.survivorContactId],
          ),
          tx.query<{ id: string; primary_email: string; phone_e164: string | null }>(
            `SELECT * FROM contacts WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
            [input.duplicateContactId],
          ),
          tx.query<{ id: string; email: string }>(
            `SELECT id, email FROM contact_emails WHERE contact_id = $1`,
            [input.duplicateContactId],
          ),
          tx.query<{ id: string }>(`SELECT id FROM deals WHERE primary_contact_id = $1`, [
            input.duplicateContactId,
          ]),
          tx.query<{ id: string }>(`SELECT id FROM tasks WHERE contact_id = $1`, [
            input.duplicateContactId,
          ]),
          tx.query<{ id: string }>(`SELECT id FROM sequence_enrollments WHERE contact_id = $1`, [
            input.duplicateContactId,
          ]),
        ]);

      const survivor = survivorRes.rows[0];
      const duplicate = duplicateRes.rows[0];
      if (!survivor) {
        throw new NotFoundDomainError('Contact', input.survivorContactId);
      }
      if (!duplicate) {
        throw new NotFoundDomainError('Contact', input.duplicateContactId);
      }

      const snapshot = {
        duplicateContact: duplicate,
        movedEmailIds: dupEmailsRes.rows.map((r) => r.id),
        movedDealIds: dupDealsRes.rows.map((r) => r.id),
        movedTaskIds: dupTasksRes.rows.map((r) => r.id),
        movedEnrollmentIds: dupSeqRes.rows.map((r) => r.id),
      };

      // Move secondary emails from duplicate to survivor
      await tx.query(
        `UPDATE contact_emails
         SET contact_id = $1, is_primary = FALSE
         WHERE contact_id = $2`,
        [survivor.id, duplicate.id],
      );

      // Ensure duplicate's primary email is also registered as a secondary email on survivor
      await tx.query(
        `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
         VALUES ($1, $2, $3, FALSE, 'valid')
         ON CONFLICT (email) DO UPDATE SET contact_id = EXCLUDED.contact_id, is_primary = FALSE`,
        [`ce_${randomUUID()}`, survivor.id, duplicate.primary_email],
      );

      // Move deals, tasks, activities, consent records, sequence enrollments
      await tx.query(`UPDATE deals SET primary_contact_id = $1 WHERE primary_contact_id = $2`, [
        survivor.id,
        duplicate.id,
      ]);
      await tx.query(`UPDATE tasks SET contact_id = $1 WHERE contact_id = $2`, [
        survivor.id,
        duplicate.id,
      ]);
      await tx.query(`UPDATE activities SET contact_id = $1 WHERE contact_id = $2`, [
        survivor.id,
        duplicate.id,
      ]);
      await tx.query(`UPDATE consent_records SET contact_id = $1 WHERE contact_id = $2`, [
        survivor.id,
        duplicate.id,
      ]);
      await tx.query(`UPDATE sequence_enrollments SET contact_id = $1 WHERE contact_id = $2`, [
        survivor.id,
        duplicate.id,
      ]);

      // Soft-delete duplicate contact
      await tx.query(`UPDATE contacts SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [
        duplicate.id,
      ]);

      const mergeLogId = `mrg_${randomUUID()}`;
      await tx.query(
        `INSERT INTO merge_logs (id, entity_type, survivor_id, merged_id, snapshot_json, actor_user_id)
         VALUES ($1, 'contact', $2, $3, $4::jsonb, $5)`,
        [mergeLogId, survivor.id, duplicate.id, JSON.stringify(snapshot), user.id],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'contact.merged',
        entityType: 'contact',
        entityId: survivor.id,
        metadata: { mergeLogId, mergedContactId: duplicate.id },
      });

      const emailCountRes = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM contact_emails WHERE contact_id = $1`,
        [survivor.id],
      );

      return {
        mergeLogId,
        survivorContactId: survivor.id,
        mergedContactId: duplicate.id,
        secondaryEmailsCount: emailCountRes.rows[0]?.cnt ?? 1,
      };
    });
  }

  /**
   * PRD §4.8 (A6) — Undo a contact merge using `merge_logs.snapshot_json`.
   */
  async undoContactMerge(
    user: SessionUser,
    mergeLogId: string,
  ): Promise<{ undone: boolean; restoredContactId: string }> {
    requireCapability(user, 'duplicates.merge');

    return this.db.transaction(async (tx) => {
      const logRes = await tx.query<{
        id: string;
        survivor_id: string;
        merged_id: string;
        snapshot_json: {
          duplicateContact: { id: string; primary_email: string };
          movedDealIds: string[];
          movedTaskIds: string[];
          movedEnrollmentIds: string[];
        };
      }>(`SELECT * FROM merge_logs WHERE id = $1 AND undone_at IS NULL LIMIT 1`, [mergeLogId]);

      const log = logRes.rows[0];
      if (!log) {
        throw new NotFoundDomainError('MergeLog', mergeLogId);
      }

      await tx.query(`UPDATE contacts SET deleted_at = NULL, updated_at = NOW() WHERE id = $1`, [
        log.merged_id,
      ]);

      await tx.query(
        `UPDATE contact_emails
         SET contact_id = $1, is_primary = TRUE
         WHERE email = $2`,
        [log.merged_id, log.snapshot_json.duplicateContact.primary_email],
      );

      for (const dealId of log.snapshot_json.movedDealIds) {
        await tx.query(`UPDATE deals SET primary_contact_id = $1 WHERE id = $2`, [
          log.merged_id,
          dealId,
        ]);
      }

      for (const taskId of log.snapshot_json.movedTaskIds) {
        await tx.query(`UPDATE tasks SET contact_id = $1 WHERE id = $2`, [log.merged_id, taskId]);
      }

      for (const enrollmentId of log.snapshot_json.movedEnrollmentIds) {
        await tx.query(`UPDATE sequence_enrollments SET contact_id = $1 WHERE id = $2`, [
          log.merged_id,
          enrollmentId,
        ]);
      }

      await tx.query(`UPDATE merge_logs SET undone_at = NOW() WHERE id = $1`, [mergeLogId]);

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'contact.merge_undone',
        entityType: 'contact',
        entityId: log.merged_id,
        metadata: { mergeLogId, survivorId: log.survivor_id },
      });

      return { undone: true, restoredContactId: log.merged_id };
    });
  }

  /**
   * PRD §6.8 — Global trigram + full-text search across Companies, Contacts, Leads, and Deals.
   */
  async globalSearch(
    user: SessionUser,
    queryText: string,
  ): Promise<{
    companies: Record<string, unknown>[];
    contacts: Record<string, unknown>[];
    leads: Record<string, unknown>[];
    deals: Record<string, unknown>[];
  }> {
    const q = queryText.trim();
    if (!q) {
      return { companies: [], contacts: [], leads: [], deals: [] };
    }
    const likePattern = `%${q}%`;

    const cmpScope = scopeWhere(user, 'companies.read', { alias: 'c', startParamIndex: 3 });
    const cntScope = scopeWhere(user, 'contacts.read', { alias: 'c', startParamIndex: 3 });
    const leadScope = scopeWhere(user, 'leads.read', { alias: 'l', startParamIndex: 3 });
    const dealScope = scopeWhere(user, 'deals.read', { alias: 'd', startParamIndex: 2 });

    const [companies, contacts, leads, deals] = await Promise.all([
      this.db.query(
        `SELECT c.id, c.name, c.domain, c.market, c.account_status,
                similarity(c.name, $1) AS score
         FROM companies c
         WHERE c.deleted_at IS NULL
           AND (c.name ILIKE $2 OR c.domain ILIKE $2 OR similarity(c.name, $1) > 0.2)
           AND ${cmpScope.sql}
         ORDER BY score DESC, c.name ASC
         LIMIT 10`,
        [q, likePattern, ...cmpScope.params],
      ),
      this.db.query(
        `SELECT c.id, c.full_name, c.primary_email, c.title, c.market,
                similarity(c.full_name, $1) AS score
         FROM contacts c
         WHERE c.deleted_at IS NULL
           AND (c.full_name ILIKE $2 OR c.primary_email ILIKE $2 OR similarity(c.full_name, $1) > 0.2)
           AND ${cntScope.sql}
         ORDER BY score DESC, c.full_name ASC
         LIMIT 10`,
        [q, likePattern, ...cntScope.params],
      ),
      this.db.query(
        `SELECT l.id, l.full_name, l.email, l.firm_name, l.status, l.market,
                similarity(l.full_name, $1) AS score
         FROM leads l
         WHERE l.deleted_at IS NULL
           AND (l.full_name ILIKE $2 OR l.firm_name ILIKE $2 OR l.email ILIKE $2 OR similarity(l.full_name, $1) > 0.2)
           AND ${leadScope.sql}
         ORDER BY score DESC, l.full_name ASC
         LIMIT 10`,
        [q, likePattern, ...leadScope.params],
      ),
      this.db.query(
        `SELECT d.id, d.name, d.stage_name, d.monthly_value_minor, d.currency
         FROM deals d
         WHERE d.deleted_at IS NULL
           AND d.name ILIKE $1
           AND ${dealScope.sql}
         ORDER BY d.updated_at DESC
         LIMIT 10`,
        [likePattern, ...dealScope.params],
      ),
    ]);

    return {
      companies: companies.rows,
      contacts: contacts.rows,
      leads: leads.rows,
      deals: deals.rows,
    };
  }

  /**
   * PRD §10 — Bigin Migration reconciliation check.
   */
  async reconcileBiginMigration(
    user: SessionUser,
    sourceInventory: {
      companiesCount: number;
      contactsCount: number;
      openDealsCount: number;
      totalMonthlyPipelineMinor: string;
    },
  ): Promise<{
    reconciled: boolean;
    crmCompaniesCount: number;
    crmContactsCount: number;
    crmOpenDealsCount: number;
    crmTotalMonthlyPipelineMinor: string;
    discrepancies: string[];
  }> {
    requireCapability(user, 'imports.run');

    const [cmpRes, cntRes, dealRes] = await Promise.all([
      this.db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM companies WHERE deleted_at IS NULL`,
      ),
      this.db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM contacts WHERE deleted_at IS NULL`,
      ),
      this.db.query<{ cnt: number; sum_minor: string }>(
        `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(monthly_value_minor), 0)::text AS sum_minor
         FROM deals WHERE deleted_at IS NULL AND stage_category = 'open'`,
      ),
    ]);

    const crmCompaniesCount = cmpRes.rows[0]?.cnt ?? 0;
    const crmContactsCount = cntRes.rows[0]?.cnt ?? 0;
    const crmOpenDealsCount = dealRes.rows[0]?.cnt ?? 0;
    const crmTotalMonthlyPipelineMinor = dealRes.rows[0]?.sum_minor ?? '0';

    const discrepancies: string[] = [];
    if (crmCompaniesCount !== sourceInventory.companiesCount) {
      discrepancies.push(
        `Companies mismatch: expected ${sourceInventory.companiesCount}, found ${crmCompaniesCount}`,
      );
    }
    if (crmContactsCount !== sourceInventory.contactsCount) {
      discrepancies.push(
        `Contacts mismatch: expected ${sourceInventory.contactsCount}, found ${crmContactsCount}`,
      );
    }
    if (crmOpenDealsCount !== sourceInventory.openDealsCount) {
      discrepancies.push(
        `Open deals mismatch: expected ${sourceInventory.openDealsCount}, found ${crmOpenDealsCount}`,
      );
    }
    if (crmTotalMonthlyPipelineMinor !== sourceInventory.totalMonthlyPipelineMinor) {
      discrepancies.push(
        `Pipeline total mismatch: expected ${sourceInventory.totalMonthlyPipelineMinor}, found ${crmTotalMonthlyPipelineMinor}`,
      );
    }

    return {
      reconciled: discrepancies.length === 0,
      crmCompaniesCount,
      crmContactsCount,
      crmOpenDealsCount,
      crmTotalMonthlyPipelineMinor,
      discrepancies,
    };
  }
}
