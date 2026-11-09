import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportBatchView, type SessionUser } from '@adas/shared';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { ImportProcessor, ImportService } from '../modules/imports/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { MemoryFileStorage } from '../platform/files/index.js';
import { createLogger } from '../platform/logger/index.js';

/**
 * Imports end to end on the database (PRD 4.9; acceptance A1-A3): upload, mapping, dry run,
 * real run, duplicates, scope, error file, undo. Every person and address is synthetic.
 */

let db: DatabaseService;
let service: ImportService;
let processor: ImportProcessor;
let files: MemoryFileStorage;
let admin: SessionUser;
let managerCa: SessionUser;
let bdr: SessionUser;
const logger = createLogger('fatal');

beforeAll(async () => {
  db = DatabaseService.forTests();
  await db.ensureInitialized();
  await db.query(
    `INSERT INTO users (id, email, name, role_id, team_id, market_focus, status)
     VALUES ('usr_mgr_ca', 'mgr.ca@adasglobuspro.example.com', 'Casey Moreau', 'role_sales_mgr',
             'team_ca', 'CA', 'active')`,
  );
  files = new MemoryFileStorage();
  const auth = new AuthAndUsersService(db);
  service = new ImportService(db, files);
  processor = new ImportProcessor(db, files, (id) => auth.resolveSessionUser(id), logger, {
    chunkSize: 4,
  });
  admin = await auth.resolveSessionUser('usr_admin_1');
  managerCa = await auth.resolveSessionUser('usr_mgr_ca');
  bdr = await auth.resolveSessionUser('usr_bdr_2');
});

afterAll(async () => {
  await db.close();
});

const csv = (lines: string[]) => Buffer.from(`${lines.join('\n')}\n`);

/** Runs the worker until nothing is waiting. */
async function drain(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await processor.processNext();
    if (r.batches === 0) return;
  }
  throw new Error('import did not finish');
}

async function upload(user: SessionUser, name: string, data: Buffer) {
  return service.upload(user, name, data, '127.0.0.1');
}

async function mapAndCheck(
  user: SessionUser,
  batch: ImportBatchView,
  mapping: Record<string, string>,
  options: Record<string, unknown> = {},
  entity: 'contact' | 'company' = 'contact',
): Promise<ImportBatchView> {
  const mapped = await service.setMapping(user, batch.id, {
    entity,
    mapping,
    version: batch.version,
    options: { source: 'Import', ownerUserId: user.id, ...options },
  });
  const checking = await service.requestDryRun(user, batch.id, { version: mapped.version });
  expect(checking.status).toBe('checking');
  await drain();
  return service.get(user, batch.id);
}

async function runImport(user: SessionUser, checked: ImportBatchView): Promise<ImportBatchView> {
  await service.requestRun(user, checked.id, { version: checked.version }, '127.0.0.1');
  await drain();
  return service.get(user, checked.id);
}

const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${sql}`, params)).rows[0]?.n,
  );

const CONTACT_MAPPING = {
  Email: 'email',
  'First name': 'firstName',
  'Last name': 'lastName',
  Title: 'title',
  Phone: 'phone',
  Company: 'companyName',
  Website: 'companyWebsite',
};
const HEADER = 'Email,First name,Last name,Title,Phone,Company,Website';

describe('upload (PRD 4.9, 6.11)', () => {
  it('stores the file, reads the header and suggests a mapping', async () => {
    const { batch, suggested } = await upload(
      admin,
      'leads.csv',
      csv([HEADER, 'a1@upload.example.com,Ann,One,,,,']),
    );
    expect(batch).toMatchObject({ status: 'uploaded', rowCount: 1, filename: 'leads.csv' });
    expect(batch.columns).toEqual(HEADER.split(','));
    expect(batch.sample).toHaveLength(1);
    expect(suggested.contact).toMatchObject({ Email: 'email', 'First name': 'firstName' });
    const file = await db.query(
      `SELECT purpose, owner_user_id, size_bytes FROM files f
      JOIN import_batches b ON b.file_id = f.id WHERE b.id = $1`,
      [batch.id],
    );
    expect(file.rows[0]).toMatchObject({ purpose: 'import', owner_user_id: 'usr_admin_1' });
  });

  it('refuses files that are not CSV or Excel, and files with no rows', async () => {
    await expect(upload(admin, 'x.csv', Buffer.from([1, 0, 2, 3]))).rejects.toMatchObject({
      status: 415,
      code: 'UNSUPPORTED_FILE_TYPE',
    });
    await expect(upload(admin, 'x.csv', csv([HEADER]))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('is limited to people who may import', async () => {
    await expect(
      upload(bdr, 'x.csv', csv([HEADER, 'a@b.example.com,A,B,,,,'])),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('checks the mapping: email and name columns, a known source and an owner', async () => {
    const { batch } = await upload(admin, 'm.csv', csv([HEADER, 'm@map.example.com,M,N,,,,']));
    const base = { entity: 'contact', version: batch.version };
    await expect(
      service.setMapping(admin, batch.id, {
        ...base,
        mapping: { 'First name': 'firstName' },
        options: { source: 'Import', ownerUserId: admin.id },
      }),
    ).rejects.toThrow();
    await expect(
      service.setMapping(admin, batch.id, {
        ...base,
        mapping: CONTACT_MAPPING,
        options: { source: 'Somewhere else', ownerUserId: admin.id },
      }),
    ).rejects.toMatchObject({ fieldErrors: { 'options.source': expect.any(Array) } });
    await expect(
      service.setMapping(admin, batch.id, {
        ...base,
        mapping: { ...CONTACT_MAPPING, Title: '', Missing: 'title' },
        options: { source: 'Import', ownerUserId: admin.id },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // A real run needs a finished dry run first.
    const mapped = await service.setMapping(admin, batch.id, {
      ...base,
      mapping: CONTACT_MAPPING,
      options: { source: 'import', ownerUserId: admin.id },
    });
    expect(mapped.options.source).toBe('Import');
    await expect(
      service.requestRun(admin, batch.id, { version: mapped.version }, null),
    ).rejects.toMatchObject({ code: 'IMPORT_NOT_CHECKED' });
  });
});

describe('dry run and run with duplicates (A2)', () => {
  let checked: ImportBatchView;
  let done: ImportBatchView;
  const contactsBefore = { n: 0 };

  beforeAll(async () => {
    contactsBefore.n = await count(`contacts WHERE deleted_at IS NULL`);
    const lines = [
      HEADER,
      // New contacts, two at a new company with a website.
      'new.one@brightledger.example.com,Nia,Brook,Partner,,Bright Ledger CPA,brightledger.example.com',
      'new.two@brightledger.example.com,Omar,Stone,,,Bright Ledger CPA,brightledger.example.com',
      // Same email as an existing contact (definite match): fills the blank phone only.
      'JANE.PATEL@acmetax.example.com,Jane,Patel,Tax Partner,,Acme Tax & Advisory LLP,',
      // The same email again later in the file (internal duplicate).
      'new.one@brightledger.example.com,Nia,Brook,,,,',
      // Probable: same name at the same company domain as an existing contact.
      'jpatel.alt@acmetax.example.com,Jane,Patel,,,,',
      // Probable: same phone as an existing contact.
      'phone.match@otherfirm.example.com,Lee,Grant,,(312) 555-0148,,',
      // Errors.
      ',No,Email,,,,',
      'bad-email,Bad,Email,,,,',
      'bad.phone@firm.example.com,Bad,Phone,,12,,',
      // An error row with a formula-like cell, to check the error file.
      ',Formula,Row,=1+1,,,',
    ];
    const { batch } = await upload(admin, 'a2.csv', csv(lines));
    checked = await mapAndCheck(admin, batch, CONTACT_MAPPING, {
      duplicatePolicy: 'fill_blanks',
      tags: ['Spring list'],
    });
  });

  it('previews creates, updates, duplicates and errors without saving anything', async () => {
    expect(checked.status).toBe('checked');
    expect(checked.dryRunCounts).toMatchObject({
      created: 4,
      updated: 0,
      skipped: 1,
      duplicate: 1,
      error: 4,
      probable: 2,
    });
    expect(await count(`contacts WHERE deleted_at IS NULL`)).toBe(contactsBefore.n);
    expect(await count(`companies WHERE domain = 'brightledger.example.com'`)).toBe(0);
    const rows = await service.rows(admin, checked.id, new URLSearchParams('status=error'));
    expect(rows.items.map((r) => r.rowNumber)).toEqual([8, 9, 10, 11]);
    expect(rows.items[0]?.messages).toEqual(['Email is blank.']);
  });

  it('runs with the same results, and creates nothing twice', async () => {
    done = await runImport(admin, checked);
    expect(done.status).toBe('completed');
    expect(done.processedRows).toBe(10);
    expect(done.counts).toMatchObject({
      created: 4,
      skipped: 1,
      duplicate: 1,
      error: 4,
      probable: 2,
      companiesCreated: 1,
    });
    expect(await count(`contacts WHERE deleted_at IS NULL`)).toBe(contactsBefore.n + 4);
    expect(await count(`contacts WHERE primary_email = 'new.one@brightledger.example.com'`)).toBe(
      1,
    );
    const created = await db.query<{ source: string; import_batch_id: string; company_id: string }>(
      `SELECT c.source, c.import_batch_id, c.company_id FROM contacts c
       WHERE c.primary_email LIKE 'new.%@brightledger.example.com'`,
    );
    expect(created.rows).toHaveLength(2);
    expect(created.rows[0]).toMatchObject({ source: 'Import', import_batch_id: done.id });
    expect(created.rows[0]?.company_id).toBe(created.rows[1]?.company_id);
    expect(
      await count(
        `entity_tags et JOIN tags t ON t.id = et.tag_id
        JOIN contacts c ON c.id = et.entity_id AND et.entity_type = 'contact'
        WHERE t.name = 'spring list' AND c.import_batch_id = $1`,
        [done.id],
      ),
    ).toBe(4);
  });

  it('queues probable matches for review instead of merging them', async () => {
    const queued = await db.query<{ left_entity_id: string; match_reason: string }>(
      `SELECT left_entity_id, match_reason FROM duplicate_candidates
       WHERE import_batch_id = $1 AND status = 'open' ORDER BY match_reason`,
      [done.id],
    );
    expect(queued.rows).toEqual([
      { left_entity_id: 'cnt_jane', match_reason: 'Same name and company domain' },
      { left_entity_id: 'cnt_jane', match_reason: 'Same phone number' },
    ]);
  });

  it('leaves an existing contact alone when "fill blanks" has nothing new', async () => {
    const jane = await db.query<{ title: string; version: number }>(
      `SELECT title, version FROM contacts WHERE id = 'cnt_jane'`,
    );
    expect(jane.rows[0]).toMatchObject({ title: 'Managing Partner', version: 1 });
  });

  it('audits the run, emits the event and tells the importer', async () => {
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at, action`,
      [done.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(
      expect.arrayContaining(['import.uploaded', 'import.started', 'import.completed']),
    );
    expect(
      await count(`outbox_events WHERE event_type = 'import.completed' AND aggregate_id = $1`, [
        done.id,
      ]),
    ).toBe(1);
    expect(
      await count(
        `notifications WHERE user_id = 'usr_admin_1' AND kind = 'import_finished'
        AND entity_id = $1`,
        [done.id],
      ),
    ).toBe(1);
  });

  it('gives an error file with the original rows and an Error column (audited)', async () => {
    const file = await service.errorsFile(admin, done.id, null);
    expect(file.filename).toBe('a2-errors.csv');
    const lines = file.csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(`${HEADER},Error`);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toMatch(/^,Formula,Row,'=1\+1,/);
    expect(
      await count(`audit_logs WHERE action = 'import.errors_downloaded' AND entity_id = $1`, [
        done.id,
      ]),
    ).toBe(1);
  });
});

describe('overwrite and undo (A3)', () => {
  it('reverts updates, removes created records and lists the ones edited since', async () => {
    const lines = [
      HEADER,
      'undo.a@undofirm.example.com,Una,Able,,,Undo Firm LLP,undofirm.example.com',
      'undo.b@undofirm.example.com,Ula,Baker,,,Undo Firm LLP,undofirm.example.com',
      'undo.c@undofirm.example.com,Uri,Cole,,,Undo Firm LLP,undofirm.example.com',
      // Overwrite policy changes an existing contact's title.
      'elena@ridgewaycpa.example.com,Elena,Rostova,Head of Audit,,,',
    ];
    const { batch } = await upload(admin, 'undo.csv', csv(lines));
    const checked = await mapAndCheck(admin, batch, CONTACT_MAPPING, {
      duplicatePolicy: 'overwrite',
    });
    const done = await runImport(admin, checked);
    expect(done.counts).toMatchObject({ created: 3, updated: 1 });
    expect(done.undoUntil).not.toBeNull();

    const history = await db.query<{ field_name: string; via: string }>(
      `SELECT field_name, via FROM record_history WHERE entity_id = 'cnt_elena' AND via = 'import'`,
    );
    expect(history.rows).toEqual([{ field_name: 'title', via: 'import' }]);

    // Someone edits one created contact after the import.
    await db.query(
      `UPDATE contacts SET title = 'Office Manager', version = version + 1
       WHERE primary_email = 'undo.c@undofirm.example.com'`,
    );

    const undoing = await service.requestUndo(admin, done.id, { version: done.version }, null);
    expect(undoing.status).toBe('rolling_back');
    await drain();
    const undone = await service.get(admin, done.id);
    expect(undone.status).toBe('rolled_back');
    expect(undone.undoCounts).toEqual({
      removed: 2,
      reverted: 1,
      kept: 1,
      companiesRemoved: 0,
      companiesKept: 1,
    });

    expect(await count(`contacts WHERE primary_email LIKE 'undo.%' AND deleted_at IS NULL`)).toBe(
      1,
    );
    // Emails of removed contacts are free again for a corrected file.
    expect(
      await count(`contact_emails WHERE email IN ('undo.a@undofirm.example.com',
      'undo.b@undofirm.example.com')`),
    ).toBe(0);
    const elena = await db.query<{ title: string }>(
      `SELECT title FROM contacts WHERE id = 'cnt_elena'`,
    );
    expect(elena.rows[0]?.title).toBe('Audit Director');
    // The company stays: the edited contact still works there.
    expect(
      await count(`companies WHERE domain = 'undofirm.example.com' AND deleted_at IS NULL`),
    ).toBe(1);

    const kept = await service.rows(admin, done.id, new URLSearchParams('undo=kept'));
    expect(kept.items).toHaveLength(1);
    expect(kept.items[0]?.cells[0]).toBe('undo.c@undofirm.example.com');
    expect(
      await count(`audit_logs WHERE action = 'import.rolled_back' AND entity_id = $1`, [done.id]),
    ).toBe(1);

    await expect(
      service.requestUndo(admin, done.id, { version: undone.version }, null),
    ).rejects.toMatchObject({ code: 'IMPORT_NOT_UNDOABLE' });
  });

  it('cannot undo after 7 days', async () => {
    const { batch } = await upload(
      admin,
      'old.csv',
      csv([HEADER, 'old@oldfirm.example.com,O,Ld,,,,']),
    );
    const done = await runImport(admin, await mapAndCheck(admin, batch, CONTACT_MAPPING));
    await db.query(
      `UPDATE import_batches SET finished_at = NOW() - INTERVAL '8 days' WHERE id = $1`,
      [done.id],
    );
    await expect(
      service.requestUndo(admin, done.id, { version: done.version }, null),
    ).rejects.toMatchObject({ code: 'IMPORT_UNDO_EXPIRED' });
  });
});

describe('scope and suppression', () => {
  it('shows imports only within the user’s scope', async () => {
    const { batch } = await upload(
      admin,
      'scope.csv',
      csv([HEADER, 's@scope.example.com,S,C,,,,']),
    );
    await expect(service.get(managerCa, batch.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.list(managerCa)).items.map((b) => b.id)).not.toContain(batch.id);
    expect((await service.list(admin)).items.map((b) => b.id)).toContain(batch.id);
    const own = {
      ...admin,
      capabilities: { ...admin.capabilities, 'imports.run': 'own' as const },
    };
    const mine = await upload(managerCa, 'mine.csv', csv([HEADER, 'm@mine.example.com,M,I,,,,']));
    await expect(service.get(own, mine.batch.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.get(own, batch.id)).id).toBe(batch.id);
  });

  it('never edits an existing contact outside the importer’s access', async () => {
    const { batch } = await upload(
      managerCa,
      'team.csv',
      csv([HEADER, 'jane.patel@acmetax.example.com,Jane,Patel,Changed,,,']),
    );
    const done = await runImport(
      managerCa,
      await mapAndCheck(managerCa, batch, CONTACT_MAPPING, { duplicatePolicy: 'overwrite' }),
    );
    expect(done.counts).toMatchObject({ skipped: 1, updated: 0 });
    const rows = await service.rows(managerCa, done.id, new URLSearchParams());
    expect(rows.items[0]?.messages[0]).toMatch(/outside your access/);
    const jane = await db.query<{ title: string }>(
      `SELECT title FROM contacts WHERE id = 'cnt_jane'`,
    );
    expect(jane.rows[0]?.title).toBe('Managing Partner');
  });

  it('imports a suppressed address but never removes the suppression', async () => {
    await db.query(
      `INSERT INTO suppressions (id, email, email_sha256, reason, source)
       VALUES ('sup_imp_1', 'blocked@suppressed.example.com', 'sha-imp-1', 'unsubscribe', 'test')`,
    );
    const { batch } = await upload(
      admin,
      'sup.csv',
      csv([HEADER, 'blocked@suppressed.example.com,Bea,Blocked,,,,']),
    );
    const done = await runImport(admin, await mapAndCheck(admin, batch, CONTACT_MAPPING));
    expect(done.counts).toMatchObject({ created: 1 });
    expect(await count(`suppressions WHERE id = 'sup_imp_1'`)).toBe(1);
  });
});

describe('companies and Excel files (A1 shape)', () => {
  it('imports companies from XLSX with domain matches, similar names and checks', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Firms');
    sheet.addRow(['Firm', 'Website', 'Country', 'Staff']);
    sheet.addRow(['Acme Tax & Advisory LLP', 'acmetax.example.com', 'USA', '']);
    sheet.addRow(['Ridgeway CPA Group LLC', '', 'USA', '']);
    sheet.addRow(['Fresh Books Partners', 'freshbooks-partners.example.com', 'Canada', '6–20']);
    sheet.addRow(['Sized Wrong', '', 'USA', 'enormous']);
    // Distinct names, so none of them looks like another (trigram similarity stays low).
    const names = ['Alderbrook', 'Birchfield', 'Cedarline', 'Dovetail', 'Elmstead', 'Fernhill'];
    names.push('Glenmoor', 'Hollowell', 'Ironbridge', 'Juniper', 'Kestrel', 'Larkspur');
    for (const n of names) sheet.addRow([n, `${n.toLowerCase()}.example.com`, 'USA', '']);
    const data = Buffer.from(await book.xlsx.writeBuffer());
    const { batch, suggested } = await upload(admin, 'firms.xlsx', data);
    expect(batch.rowCount).toBe(16);
    expect(suggested.company).toMatchObject({
      Firm: 'name',
      Website: 'website',
      Country: 'market',
    });
    const checked = await mapAndCheck(
      admin,
      batch,
      { Firm: 'name', Website: 'website', Country: 'market', Staff: 'staffBand' },
      { duplicatePolicy: 'fill_blanks' },
      'company',
    );
    const done = await runImport(admin, checked);
    expect(done.counts).toMatchObject({ created: 14, skipped: 1, error: 1, probable: 1 });
    const fresh = await db.query<{ market: string; staff_band: string; source: string }>(
      `SELECT market, staff_band, source FROM companies WHERE domain = 'freshbooks-partners.example.com'`,
    );
    expect(fresh.rows[0]).toEqual({ market: 'CA', staff_band: '6–20', source: 'Import' });
    expect(
      await count(
        `duplicate_candidates WHERE import_batch_id = $1 AND left_entity_id = 'cmp_ridgeway'`,
        [done.id],
      ),
    ).toBe(1);
  });

  it('resumes a stopped run where it left off, without repeating rows', async () => {
    const lines = [HEADER];
    for (let i = 0; i < 10; i++) lines.push(`resume${i}@resume.example.com,R${i},Row,,,,`);
    const { batch } = await upload(admin, 'resume.csv', csv(lines));
    const checked = await mapAndCheck(admin, batch, CONTACT_MAPPING);
    await service.requestRun(admin, checked.id, { version: checked.version }, null);
    // One chunk per run (no time budget), as if the worker stopped after the first chunk.
    const slow = new ImportProcessor(db, files, async () => admin, logger, {
      chunkSize: 4,
      budgetMs: 0,
    });
    await slow.processNext();
    expect((await service.get(admin, batch.id)).processedRows).toBe(4);
    // A crashed worker leaves a heartbeat behind; after it goes stale another worker resumes.
    await db.query(
      `UPDATE import_batches SET heartbeat_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
      [batch.id],
    );
    await drain();
    const done = await service.get(admin, batch.id);
    expect(done).toMatchObject({ status: 'completed', processedRows: 10 });
    expect(done.counts).toMatchObject({ created: 10 });
    expect(await count(`import_rows WHERE batch_id = $1 AND NOT dry_run`, [batch.id])).toBe(10);
  });
});
