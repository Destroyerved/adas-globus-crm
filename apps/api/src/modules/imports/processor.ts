import { randomUUID } from 'node:crypto';
import {
  type DuplicatePolicy,
  type ImportCounts,
  type ImportEntity,
  type ImportOptions,
  type ImportUndoCounts,
  type SessionUser,
} from '@adas/shared';
import { type Logger } from 'pino';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import { type FileStorage } from '../../platform/files/index.js';
import { scopeWhere } from '../../platform/scope/index.js';
import {
  ImportRecordWriter,
  referenceList,
  type ImportContext,
  type ImportedEntity,
} from '../crm/index.js';
import { addNotification } from '../notifications/index.js';
import { detectFormat, parseTable, type ParsedTable } from './parse.js';
import {
  fileKey,
  mappedFields,
  readCompanyRow,
  readContactRow,
  type CompanyValues,
  type ContactValues,
  type Market,
  type ReferenceValues,
} from './rows.js';

/**
 * The `import.process` job (PRD 4.9, 6.9): claims one waiting batch and works through it in
 * chunks of 500 rows, each chunk in one transaction together with the progress counter, so a
 * stopped worker resumes where it left off. A dry run does the same work inside a savepoint
 * that is rolled back, so its preview matches what the real run will do.
 */

type Row = Record<string, unknown>;

export interface RowOutcome {
  status: 'created' | 'updated' | 'duplicate' | 'skipped' | 'error';
  messages: string[];
  entityId?: string | null;
  entityVersion?: number | null;
  before?: Record<string, unknown> | null;
  createdCompanyId?: string | null;
  probableOf?: string | null;
}

interface RunState {
  batch: Row;
  entity: ImportEntity;
  options: ImportOptions;
  mapping: Record<string, string>;
  table: ParsedTable;
  ctx: ImportContext;
  actor: SessionUser;
  refs: ReferenceValues;
  /** File key → first row number with it, for duplicates inside the file. */
  seen: Map<string, number>;
}

export interface ImportProcessorOptions {
  chunkSize?: number;
  /** Stop after this long and let the next run continue, so no single job runs for ages. */
  budgetMs?: number;
}

const STALE_SECONDS = 120;
const FAILED_REASON =
  'The import stopped because of an unexpected error. Rows imported so far can be undone.';

function blank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value === '');
}

export class ImportProcessor {
  private readonly writer: ImportRecordWriter;
  private cache: { fileId: string; table: ParsedTable } | null = null;
  private readonly chunkSize: number;
  private readonly budgetMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FileStorage,
    private readonly loadUser: (userId: string) => Promise<SessionUser>,
    private readonly logger: Logger,
    options: ImportProcessorOptions = {},
  ) {
    this.writer = new ImportRecordWriter(db);
    this.chunkSize = options.chunkSize ?? 500;
    this.budgetMs = options.budgetMs ?? 45_000;
  }

  /** Works on the oldest waiting batch for up to the time budget. */
  async processNext(): Promise<{ batches: number; rows: number }> {
    const claimed = await this.db.query(
      `UPDATE import_batches b
       SET heartbeat_at = NOW(),
           started_at = CASE WHEN b.status = 'queued' THEN NOW() ELSE b.started_at END,
           status = CASE WHEN b.status = 'queued' THEN 'running' ELSE b.status END
       WHERE b.id = (
         SELECT id FROM import_batches
         WHERE status IN ('checking', 'queued', 'running', 'rolling_back')
           AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - make_interval(secs => $1))
         ORDER BY updated_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
       RETURNING b.*`,
      [STALE_SECONDS],
    );
    const batch = claimed.rows[0];
    if (!batch) return { batches: 0, rows: 0 };
    const id = String(batch['id']);
    const status = String(batch['status']);
    try {
      const rows =
        status === 'rolling_back'
          ? await this.undo(batch)
          : await this.run(batch, status === 'checking');
      return { batches: 1, rows };
    } catch (err) {
      const e = err as { name?: string; code?: string };
      // Never log row data: only the error's class and code.
      this.logger.error(
        { importBatchId: id, err: { name: e.name, code: e.code } },
        'import failed',
      );
      await this.fail(batch, status);
      return { batches: 1, rows: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Dry run and real run
  // -------------------------------------------------------------------------

  private async table(batch: Row): Promise<ParsedTable> {
    const fileId = String(batch['file_id']);
    if (this.cache?.fileId === fileId) return this.cache.table;
    const file = await this.db.query<{ storage_key: string }>(
      `SELECT storage_key FROM files WHERE id = $1`,
      [fileId],
    );
    const key = file.rows[0]?.storage_key;
    if (!key) throw new Error('Import file record missing');
    const data = await this.files.get(key);
    const format = detectFormat(data);
    if (!format) throw new Error('Import file unreadable');
    const table = await parseTable(data, format);
    this.cache = { fileId, table };
    return table;
  }

  private async state(batch: Row): Promise<RunState> {
    const entity = batch['entity'] as ImportEntity;
    const options = batch['options'] as ImportOptions;
    const table = await this.table(batch);
    const actor = await this.loadUser(String(batch['created_by']));
    const owner = await this.db.query<{ team_id: string | null }>(
      `SELECT team_id FROM users WHERE id = $1`,
      [options.ownerUserId],
    );
    const [staffBands, firmTypes] = await Promise.all([
      referenceList(this.db, 'staff_bands'),
      referenceList(this.db, 'firm_types'),
    ]);
    const mapping = batch['mapping'] as Record<string, string>;
    const state: RunState = {
      batch,
      entity,
      options,
      mapping,
      table,
      actor,
      refs: { staffBands, firmTypes },
      ctx: {
        batchId: String(batch['id']),
        filename: String(batch['filename']),
        actorUserId: actor.id,
        ownerUserId: options.ownerUserId,
        ownerTeamId: owner.rows[0]?.team_id ?? null,
        source: options.source,
      },
      seen: new Map(),
    };
    // Rebuild the in-file duplicate keys for rows already done (when resuming).
    const done = Number(batch['processed_rows']);
    for (let i = 0; i < done; i++) this.read(state, i, true);
    return state;
  }

  /** Reads row i; with `remember`, records its file key the way processing would. */
  private read(
    state: RunState,
    i: number,
    remember = false,
  ):
    | { ok: true; values: ContactValues | CompanyValues; key: string }
    | { ok: false; errors: string[] } {
    const fields = mappedFields(state.table.columns, state.table.rows[i] ?? [], state.mapping);
    const market = state.options.market as Market;
    const read =
      state.entity === 'contact'
        ? readContactRow(fields, market)
        : readCompanyRow(fields, market, state.refs);
    if (!read.ok) return read;
    const key = fileKey(state.entity, read.values);
    if (remember && !state.seen.has(key)) {
      state.seen.set(key, state.table.rowNumbers[i] ?? i + 2);
    }
    return { ok: true, values: read.values, key };
  }

  private async run(batch: Row, dryRun: boolean): Promise<number> {
    const state = await this.state(batch);
    const id = state.ctx.batchId;
    const total = state.table.rows.length;
    let processed = Number(batch['processed_rows']);
    const started = Date.now();

    // At least one chunk per run, then more while the time budget lasts.
    while (processed < total) {
      const from = processed;
      const to = Math.min(total, from + this.chunkSize);
      await this.db.transaction(async (tx) => {
        if (dryRun) await tx.query('SAVEPOINT import_dry_run');
        const outcomes: { index: number; outcome: RowOutcome }[] = [];
        for (let i = from; i < to; i++) {
          outcomes.push({ index: i, outcome: await this.safeRow(tx, state, i) });
        }
        if (dryRun) await tx.query('ROLLBACK TO SAVEPOINT import_dry_run');
        await this.saveRows(tx, state, dryRun, outcomes);
        await tx.query(
          `UPDATE import_batches SET processed_rows = $2, heartbeat_at = NOW() WHERE id = $1`,
          [id, to],
        );
      });
      processed = to;
      if (Date.now() - started >= this.budgetMs) break;
    }

    if (processed < total) {
      // Out of time: let the next run (any worker) pick it up straight away.
      await this.db.query(`UPDATE import_batches SET heartbeat_at = NULL WHERE id = $1`, [id]);
      return processed - Number(batch['processed_rows']);
    }
    await this.finish(state, dryRun);
    return processed - Number(batch['processed_rows']);
  }

  /** One row in its own savepoint, so a failing row never spoils the rest of the chunk. */
  private async safeRow(tx: DbTx, state: RunState, i: number): Promise<RowOutcome> {
    await tx.query('SAVEPOINT import_row');
    try {
      const outcome = await this.processRow(tx, state, i);
      await tx.query('RELEASE SAVEPOINT import_row');
      return outcome;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT import_row');
      const e = err as { name?: string; code?: string };
      this.logger.warn(
        {
          importBatchId: state.ctx.batchId,
          row: state.table.rowNumbers[i],
          err: { name: e.name, code: e.code },
        },
        'import row failed',
      );
      return {
        status: 'error',
        messages: ['This row could not be saved. Try importing it again.'],
      };
    }
  }

  private async processRow(tx: DbTx, state: RunState, i: number): Promise<RowOutcome> {
    const read = this.read(state, i);
    if (!read.ok) return { status: 'error', messages: read.errors };
    const first = state.seen.get(read.key);
    if (first !== undefined) {
      const what = state.entity === 'contact' ? 'email' : 'company';
      return {
        status: 'duplicate',
        messages: [`Same ${what} as row ${first}; this row was not imported.`],
      };
    }
    state.seen.set(read.key, state.table.rowNumbers[i] ?? i + 2);
    return state.entity === 'contact'
      ? this.contactRow(tx, state, read.values as ContactValues)
      : this.companyRow(tx, state, read.values as CompanyValues);
  }

  private mapped(state: RunState, field: string): boolean {
    return Object.values(state.mapping).includes(field);
  }

  /** True when the importing user may edit this existing record (their scope, in SQL). */
  private async canEdit(tx: DbTx, state: RunState, entity: ImportedEntity, id: unknown) {
    const scope = scopeWhere(
      state.actor,
      entity === 'contact' ? 'contacts.write' : 'companies.write',
      { startParamIndex: 2 },
    );
    const res = await tx.query(
      `SELECT 1 FROM ${entity === 'contact' ? 'contacts' : 'companies'}
       WHERE id = $1 AND ${scope.sql}`,
      [id, ...scope.params],
    );
    return res.rows.length > 0;
  }

  /** Works out which columns to change on a matched record under the duplicate policy. */
  private changes(
    current: Row,
    proposed: Record<string, unknown>,
    policy: DuplicatePolicy,
  ): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(proposed)) {
      if (blank(value)) continue;
      if (policy === 'fill_blanks' && !blank(current[column])) continue;
      if (current[column] === value) continue;
      changes[column] = value;
    }
    return changes;
  }

  /** Finds or creates the company a contact row names. */
  private async companyFor(
    tx: DbTx,
    state: RunState,
    values: ContactValues,
  ): Promise<{ id: string | null; created: boolean }> {
    if (values.companyDomain) {
      const byDomain = await this.writer.companyByDomain(tx, values.companyDomain);
      if (byDomain) return { id: String(byDomain['id']), created: false };
    } else if (values.companyName) {
      const byName = await this.writer.companyByExactName(tx, values.companyName, values.market);
      if (byName) return { id: String(byName['id']), created: false };
    }
    if (!values.companyName) return { id: null, created: false };
    const probable = await this.writer.probableCompany(tx, values.companyName, values.market);
    const company = await this.writer.createCompany(
      tx,
      {
        name: values.companyName,
        domain: values.companyDomain,
        market: values.market,
        stateProvince: null,
        city: null,
        staffBand: null,
        firmType: null,
      },
      state.ctx,
    );
    if (probable) {
      await this.writer.addDuplicateCandidate(
        tx,
        'company',
        probable.id,
        company.id,
        probable,
        state.ctx.batchId,
      );
    }
    return { id: company.id, created: true };
  }

  private async contactRow(tx: DbTx, state: RunState, v: ContactValues): Promise<RowOutcome> {
    const suppression = await this.writer.suppressionForEmail(tx, v.email);
    if (suppression?.reason === 'privacy_erasure') {
      return {
        status: 'skipped',
        entityId: null,
        messages: ['This email address was erased after a privacy request and cannot be imported.'],
      };
    }
    const policy = state.options.duplicatePolicy;
    const existing = await this.writer.contactByEmail(tx, v.email);
    const usesCompany = this.mapped(state, 'companyName') || this.mapped(state, 'companyWebsite');

    if (existing) {
      if (!(await this.canEdit(tx, state, 'contact', existing['id']))) {
        return {
          status: 'skipped',
          entityId: null,
          messages: ['Already in the CRM, owned by someone outside your access; left unchanged.'],
        };
      }
      if (policy === 'skip') {
        return {
          status: 'skipped',
          entityId: String(existing['id']),
          messages: ['Already in the CRM; left unchanged.'],
        };
      }
      const proposed: Record<string, unknown> = {};
      if (this.mapped(state, 'firstName') || this.mapped(state, 'fullName')) {
        proposed['first_name'] = v.firstName;
      }
      if (this.mapped(state, 'lastName') || this.mapped(state, 'fullName')) {
        proposed['last_name'] = v.lastName;
      }
      if (this.mapped(state, 'title')) proposed['title'] = v.title;
      if (this.mapped(state, 'phone')) proposed['phone_e164'] = v.phone;
      if (this.mapped(state, 'market')) proposed['market'] = v.market;
      const changes = this.changes(existing, proposed, policy);
      let createdCompanyId: string | null = null;
      if (usesCompany && (policy === 'overwrite' || blank(existing['company_id']))) {
        const company = await this.companyFor(tx, state, v);
        if (company.id && company.id !== existing['company_id']) {
          changes['company_id'] = company.id;
          if (company.created) createdCompanyId = company.id;
        }
      }
      if ('first_name' in changes || 'last_name' in changes) {
        const first = (changes['first_name'] ?? existing['first_name']) as string;
        const last = (changes['last_name'] ?? existing['last_name']) as string;
        changes['full_name'] = `${first} ${last}`.trim();
      }
      const tagsAdded = await this.writer.addTags(
        tx,
        'contact',
        String(existing['id']),
        state.options.tags,
      );
      if (Object.keys(changes).length === 0) {
        return {
          status: 'skipped',
          entityId: String(existing['id']),
          entityVersion: Number(existing['version']),
          before: tagsAdded.length > 0 ? { _tags: tagsAdded } : null,
          messages: ['Already in the CRM; nothing new to add.'],
        };
      }
      const updated = await this.writer.update(tx, 'contact', existing, changes, state.ctx);
      if (!updated) {
        throw Object.assign(new Error('Record changed during import'), {
          code: 'VERSION_CONFLICT',
        });
      }
      return {
        status: 'updated',
        entityId: String(existing['id']),
        entityVersion: updated.version,
        before: { ...updated.before, _tags: tagsAdded },
        createdCompanyId,
        messages: [],
      };
    }

    const company = usesCompany || v.companyDomain ? await this.companyFor(tx, state, v) : null;
    const probable = await this.writer.probableContact(tx, v, v.companyDomain);
    const created = await this.writer.createContact(
      tx,
      v,
      company?.id ?? null,
      state.ctx,
      Boolean(suppression),
    );
    if (probable) {
      await this.writer.addDuplicateCandidate(
        tx,
        'contact',
        probable.id,
        created.id,
        probable,
        state.ctx.batchId,
      );
    }
    await this.writer.addTags(tx, 'contact', created.id, state.options.tags);
    return {
      status: 'created',
      entityId: created.id,
      entityVersion: created.version,
      createdCompanyId: company?.created ? company.id : null,
      probableOf: probable?.id ?? null,
      messages: probable
        ? [
            `Possible duplicate of an existing contact (${probable.reason.toLowerCase()}); queued for review.`,
          ]
        : [],
    };
  }

  private async companyRow(tx: DbTx, state: RunState, v: CompanyValues): Promise<RowOutcome> {
    const policy = state.options.duplicatePolicy;
    const existing = v.domain ? await this.writer.companyByDomain(tx, v.domain) : null;

    if (existing) {
      if (!(await this.canEdit(tx, state, 'company', existing['id']))) {
        return {
          status: 'skipped',
          entityId: null,
          messages: ['Already in the CRM, owned by someone outside your access; left unchanged.'],
        };
      }
      if (policy === 'skip') {
        return {
          status: 'skipped',
          entityId: String(existing['id']),
          messages: ['Already in the CRM; left unchanged.'],
        };
      }
      const proposed: Record<string, unknown> = { name: v.name };
      if (this.mapped(state, 'market')) proposed['market'] = v.market;
      if (this.mapped(state, 'stateProvince')) proposed['state_province'] = v.stateProvince;
      if (this.mapped(state, 'city')) proposed['city'] = v.city;
      if (this.mapped(state, 'staffBand')) proposed['staff_band'] = v.staffBand;
      if (this.mapped(state, 'firmType')) proposed['firm_type'] = v.firmType;
      const changes = this.changes(existing, proposed, policy);
      const tagsAdded = await this.writer.addTags(
        tx,
        'company',
        String(existing['id']),
        state.options.tags,
      );
      if (Object.keys(changes).length === 0) {
        return {
          status: 'skipped',
          entityId: String(existing['id']),
          entityVersion: Number(existing['version']),
          before: tagsAdded.length > 0 ? { _tags: tagsAdded } : null,
          messages: ['Already in the CRM; nothing new to add.'],
        };
      }
      const updated = await this.writer.update(tx, 'company', existing, changes, state.ctx);
      if (!updated) {
        throw Object.assign(new Error('Record changed during import'), {
          code: 'VERSION_CONFLICT',
        });
      }
      return {
        status: 'updated',
        entityId: String(existing['id']),
        entityVersion: updated.version,
        before: { ...updated.before, _tags: tagsAdded },
        messages: [],
      };
    }

    const probable = await this.writer.probableCompany(tx, v.name, v.market);
    const created = await this.writer.createCompany(tx, v, state.ctx);
    if (probable) {
      await this.writer.addDuplicateCandidate(
        tx,
        'company',
        probable.id,
        created.id,
        probable,
        state.ctx.batchId,
      );
    }
    await this.writer.addTags(tx, 'company', created.id, state.options.tags);
    return {
      status: 'created',
      entityId: created.id,
      entityVersion: created.version,
      probableOf: probable?.id ?? null,
      messages: probable
        ? [
            `Possible duplicate of an existing company (${probable.reason.toLowerCase()}); queued for review.`,
          ]
        : [],
    };
  }

  private async saveRows(
    tx: DbTx,
    state: RunState,
    dryRun: boolean,
    outcomes: { index: number; outcome: RowOutcome }[],
  ): Promise<void> {
    const rows = outcomes.map(({ index, outcome }) => ({
      id: `imr_${randomUUID()}`,
      row_number: state.table.rowNumbers[index] ?? index + 2,
      raw: state.table.rows[index] ?? [],
      status: outcome.status,
      errors: outcome.messages,
      // A dry run's records were rolled back, so their ids mean nothing.
      entity_id: dryRun ? null : (outcome.entityId ?? null),
      entity_version: dryRun ? null : (outcome.entityVersion ?? null),
      before: dryRun ? null : (outcome.before ?? null),
      created_company_id: dryRun ? null : (outcome.createdCompanyId ?? null),
      probable_of: outcome.probableOf ?? null,
    }));
    await tx.query(
      `INSERT INTO import_rows (id, batch_id, dry_run, row_number, raw, status, errors, entity_id,
                               entity_version, before, created_company_id, probable_of)
       SELECT x.id, $1, $2, x.row_number, x.raw, x.status, x.errors, x.entity_id,
              x.entity_version, x.before, x.created_company_id, x.probable_of
       FROM jsonb_to_recordset($3::jsonb) AS x(
         id text, row_number int, raw jsonb, status text, errors jsonb, entity_id text,
         entity_version int, before jsonb, created_company_id text, probable_of text)
       ON CONFLICT (batch_id, dry_run, row_number) DO NOTHING`,
      [state.ctx.batchId, dryRun, JSON.stringify(rows)],
    );
  }

  private async counts(tx: DbTx, batchId: string, dryRun: boolean): Promise<ImportCounts> {
    const res = await tx.query<{ status: string; n: number; probable: number; companies: number }>(
      `SELECT status, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE probable_of IS NOT NULL)::int AS probable,
              COUNT(*) FILTER (WHERE created_company_id IS NOT NULL)::int AS companies
       FROM import_rows WHERE batch_id = $1 AND dry_run = $2 GROUP BY status`,
      [batchId, dryRun],
    );
    const counts: ImportCounts & { companiesCreated?: number } = {
      created: 0,
      updated: 0,
      duplicate: 0,
      skipped: 0,
      error: 0,
      probable: 0,
    };
    for (const r of res.rows) {
      counts[r.status as 'created'] = r.n;
      counts.probable = (counts.probable ?? 0) + r.probable;
      if (!dryRun) counts.companiesCreated = (counts.companiesCreated ?? 0) + r.companies;
    }
    return counts;
  }

  private async finish(state: RunState, dryRun: boolean): Promise<void> {
    const id = state.ctx.batchId;
    await this.db.transaction(async (tx) => {
      const counts = await this.counts(tx, id, dryRun);
      if (dryRun) {
        await tx.query(
          `UPDATE import_batches
           SET status = 'checked', dry_run_counts = $2::jsonb, heartbeat_at = NULL,
               version = version + 1, updated_at = NOW()
           WHERE id = $1`,
          [id, JSON.stringify(counts)],
        );
        return;
      }
      await tx.query(
        `UPDATE import_batches
         SET status = 'completed', counts = $2::jsonb, heartbeat_at = NULL, finished_at = NOW(),
             version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [id, JSON.stringify(counts)],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: state.actor.id,
        actorEmail: state.actor.email,
        action: 'import.completed',
        entityType: 'import_batch',
        entityId: id,
        metadata: { entity: state.entity, counts },
      });
      await this.db.addOutboxEvent(tx, {
        eventType: 'import.completed',
        aggregateType: 'import_batch',
        aggregateId: id,
        payload: { id, entity: state.entity, counts },
      });
      const what = state.entity === 'contact' ? 'contacts' : 'companies';
      await addNotification(tx, {
        userId: state.actor.id,
        kind: 'import_finished',
        title: `Import finished: ${state.ctx.filename}`,
        body: `${counts.created ?? 0} ${what} added, ${counts.updated ?? 0} updated, ${counts.error ?? 0} rows with errors.`,
        entityType: 'import_batch',
        entityId: id,
        dedupeKey: `import:${id}:completed`,
      });
    });
  }

  private async fail(batch: Row, status: string): Promise<void> {
    const id = String(batch['id']);
    // An undo that fails goes back to "completed" so it can be tried again.
    const next = status === 'rolling_back' ? 'completed' : 'failed';
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE import_batches
         SET status = $2, failure_reason = $3, heartbeat_at = NULL,
             finished_at = CASE WHEN started_at IS NOT NULL THEN COALESCE(finished_at, NOW()) ELSE finished_at END,
             version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [
          id,
          next,
          status === 'rolling_back'
            ? 'Undo stopped because of an unexpected error. Try again.'
            : status === 'checking'
              ? 'The check stopped because of an unexpected error. Try again.'
              : FAILED_REASON,
        ],
      );
      if (status !== 'checking') {
        await addNotification(tx, {
          userId: String(batch['rolled_back_by'] ?? batch['created_by']),
          kind: 'import_finished',
          title: status === 'rolling_back' ? 'Undo of an import stopped' : 'Import stopped',
          body: `${String(batch['filename'])}: something went wrong. Open the import to see what happened.`,
          entityType: 'import_batch',
          entityId: id,
          dedupeKey: `import:${id}:failed:${String(batch['version'])}`,
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  private async undo(batch: Row): Promise<number> {
    const id = String(batch['id']);
    const entity = batch['entity'] as ImportedEntity;
    const actorId = String(batch['rolled_back_by'] ?? batch['created_by']);
    const started = Date.now();
    let done = 0;

    for (;;) {
      if (done > 0 && Date.now() - started >= this.budgetMs) {
        await this.db.query(`UPDATE import_batches SET heartbeat_at = NULL WHERE id = $1`, [id]);
        return done;
      }
      const n = await this.db.transaction(async (tx) => {
        const rows = await tx.query<{
          id: string;
          status: string;
          entity_id: string;
          entity_version: number;
          before: Record<string, unknown> | null;
        }>(
          `SELECT id, status, entity_id, entity_version, before FROM import_rows
           WHERE batch_id = $1 AND NOT dry_run AND undo_status IS NULL AND entity_id IS NOT NULL
             AND (status IN ('created', 'updated') OR (status = 'skipped' AND before IS NOT NULL))
           ORDER BY row_number DESC LIMIT $2`,
          [id, this.chunkSize],
        );
        for (const row of rows.rows) {
          const before = row.before ?? {};
          const tagsAdded = Array.isArray(before['_tags']) ? (before['_tags'] as string[]) : [];
          const fields = Object.fromEntries(Object.entries(before).filter(([k]) => k !== '_tags'));
          let result: 'removed' | 'reverted' | 'kept';
          if (row.status === 'created') {
            result = await this.writer.undoCreate(
              tx,
              entity,
              row.entity_id,
              row.entity_version,
              actorId,
            );
          } else {
            result = await this.writer.revertUpdate(
              tx,
              entity,
              row.entity_id,
              row.entity_version,
              fields,
              tagsAdded,
              actorId,
            );
          }
          await tx.query(`UPDATE import_rows SET undo_status = $2 WHERE id = $1`, [row.id, result]);
        }
        await tx.query(`UPDATE import_batches SET heartbeat_at = NOW() WHERE id = $1`, [id]);
        return rows.rows.length;
      });
      done += n;
      if (n === 0) break;
    }

    await this.db.transaction(async (tx) => {
      const companies =
        entity === 'contact'
          ? await this.writer.undoImportedCompanies(tx, id, actorId)
          : { removed: 0, kept: 0 };
      const res = await tx.query<{ undo_status: string; n: number }>(
        `SELECT undo_status, COUNT(*)::int AS n FROM import_rows
         WHERE batch_id = $1 AND NOT dry_run AND undo_status IS NOT NULL
           AND status IN ('created', 'updated')
         GROUP BY undo_status`,
        [id],
      );
      const by = Object.fromEntries(res.rows.map((r) => [r.undo_status, r.n]));
      const undoCounts: ImportUndoCounts = {
        removed: by['removed'] ?? 0,
        reverted: by['reverted'] ?? 0,
        kept: by['kept'] ?? 0,
        companiesRemoved: companies.removed,
        companiesKept: companies.kept,
      };
      await tx.query(
        `UPDATE import_batches
         SET status = 'rolled_back', undo_counts = $2::jsonb, rolled_back_at = NOW(),
             heartbeat_at = NULL, failure_reason = NULL, version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [id, JSON.stringify(undoCounts)],
      );
      const actor = await tx.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
        actorId,
      ]);
      await this.db.writeAuditLog(tx, {
        actorUserId: actorId,
        actorEmail: actor.rows[0]?.email ?? null,
        action: 'import.rolled_back',
        entityType: 'import_batch',
        entityId: id,
        metadata: { ...undoCounts },
      });
      await this.db.addOutboxEvent(tx, {
        eventType: 'import.rolled_back',
        aggregateType: 'import_batch',
        aggregateId: id,
        payload: { id, entity, undoCounts },
      });
      await addNotification(tx, {
        userId: actorId,
        kind: 'import_finished',
        title: `Import undone: ${String(batch['filename'])}`,
        body:
          undoCounts.kept > 0
            ? `${undoCounts.removed} removed, ${undoCounts.reverted} changes reverted. ${undoCounts.kept} records were edited since and were left alone.`
            : `${undoCounts.removed} removed and ${undoCounts.reverted} changes reverted.`,
        entityType: 'import_batch',
        entityId: id,
        dedupeKey: `import:${id}:rolled_back`,
      });
    });
    return done;
  }
}
