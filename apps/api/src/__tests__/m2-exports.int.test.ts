import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SessionUser } from '@adas/shared';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { CrmListService } from '../modules/crm/index.js';
import { ExportService } from '../modules/exports/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { MemoryFileStorage } from '../platform/files/index.js';
import { createLogger } from '../platform/logger/index.js';

/**
 * CSV exports on the database (PRD 2.3, 4.9, 9): the list view's rows, scope in SQL, the
 * 1,000-row and 5,000-row rules, the background job, notifications, audit and expiry.
 * Every person and address is synthetic.
 */

let db: DatabaseService;
let files: MemoryFileStorage;
let service: ExportService;
let auth: AuthAndUsersService;
let admin: SessionUser;
let managerUs: SessionUser;
let marketing: SessionUser;
let bdr: SessionUser;
let ae: SessionUser;

beforeAll(async () => {
  db = DatabaseService.forTests();
  await db.ensureInitialized();
  files = new MemoryFileStorage();
  auth = new AuthAndUsersService(db);
  service = new ExportService(
    db,
    files,
    new CrmListService(db),
    (id) => auth.resolveSessionUser(id),
    createLogger('fatal'),
  );
  admin = await auth.resolveSessionUser('usr_admin_1');
  managerUs = await auth.resolveSessionUser('usr_mgr_1');
  marketing = await auth.resolveSessionUser('usr_mkt_1');
  bdr = await auth.resolveSessionUser('usr_bdr_2');
  ae = await auth.resolveSessionUser('usr_ae_1');
}, 90_000);

afterAll(async () => {
  await db.close();
});

/** The CSV as rows of cells (no quoted commas in these fixtures except where tested). */
async function csvOf(user: SessionUser, id: string): Promise<string> {
  const file = await service.download(user, id, null);
  return file.csv.toString('utf8');
}

const withoutBom = (csv: string) => (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv);
const lines = (csv: string) => withoutBom(csv).split('\r\n').filter(Boolean);

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; code?: string };
  }
  throw new Error('expected a refusal');
}

async function addContact(
  id: string,
  name: [string, string],
  email: string,
  opts: { owner?: string; team?: string; title?: string; companyId?: string | null } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO contacts (id, company_id, first_name, last_name, full_name, title, job_function,
                           seniority, primary_email, market, timezone, owner_user_id, team_id)
     VALUES ($1, $2, $3, $4, $5, $6, '', '', $7, 'US', 'America/New_York', $8, $9)`,
    [
      id,
      opts.companyId ?? null,
      name[0],
      name[1],
      `${name[0]} ${name[1]}`,
      opts.title ?? '',
      email,
      opts.owner ?? 'usr_mgr_1',
      opts.team ?? 'team_us',
    ],
  );
}

describe('CSV exports (PRD 4.9)', () => {
  it('a small export is the list view as CSV, ready at once, and audited without personal data', async () => {
    const result = await service.create(admin, { entity: 'contact', q: 'Patel' }, '203.0.113.9');
    expect(result).toMatchObject({ entity: 'contact', status: 'ready', rowCount: 1 });
    expect(result.background).toBe(false);
    expect(result.filename).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(result.expiresAt).not.toBeNull();

    const csv = await csvOf(admin, result.id);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, row] = lines(csv);
    expect(header).toContain('Name,First name,Last name,Email,Phone,Title');
    expect(header).toContain(`Created (${admin.timezone ?? 'UTC'})`);
    expect(row).toContain('Jane Patel,Jane,Patel,jane.patel@acmetax.example.com');
    expect(row).toContain('United States');
    expect(row).toContain('Arjun Mehta');

    const audit = await db.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`,
      [result.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['export.created', 'export.downloaded']);
    expect(audit.rows[0]?.metadata).toMatchObject({ entity: 'contact', rows: 1, searched: true });
    expect(JSON.stringify(audit.rows)).not.toMatch(/Patel|acmetax/);
  });

  it('applies the read scope and the export scope in SQL: own, team and all', async () => {
    await addContact('cnt_exp_own', ['Wren', 'Holloway'], 'wren.holloway@exp-own.example.com', {
      owner: 'usr_bdr_2',
    });
    const names = async (user: SessionUser) => {
      const result = await service.create(user, { entity: 'contact', sort: 'name' }, null);
      return lines(await csvOf(user, result.id))
        .slice(1)
        .map((line) => line.split(',')[0]);
    };

    // All: every live contact, both markets.
    const all = await names(admin);
    expect(all).toEqual(expect.arrayContaining(['Jane Patel', 'Marcus Vance', 'Wren Holloway']));

    // Team: the U.S. team's contacts only.
    const team = await names(managerUs);
    expect(team).toContain('Jane Patel');
    expect(team).toContain('Wren Holloway');
    expect(team).not.toContain('Marcus Vance');
    expect(team).not.toContain('Sophie Tremblay');

    // Own: an export scope narrower than the read scope wins.
    const ownExporter: SessionUser = {
      ...managerUs,
      capabilities: { ...managerUs.capabilities, 'exports.run': 'own' },
    };
    const own = await names(ownExporter);
    expect(own).toContain('Jane Patel');
    expect(own).not.toContain('Wren Holloway');

    // A read scope narrower than the export scope wins too.
    const ownReader: SessionUser = {
      ...bdr,
      capabilities: { ...bdr.capabilities, 'exports.run': 'all' },
    };
    expect(await names(ownReader)).toEqual(['Wren Holloway']);

    // No export permission at all.
    expect(await errorOf(service.create(ae, { entity: 'contact' }, null))).toMatchObject({
      status: 403,
      code: 'FORBIDDEN_CAPABILITY',
    });
  });

  it('follows the filter and sort, and refuses a bad filter or an empty view before writing anything', async () => {
    const result = await service.create(
      admin,
      {
        entity: 'contact',
        sort: 'name',
        filter: { field: 'market', op: 'eq', value: 'CA' },
      },
      null,
    );
    const rows = lines(await csvOf(admin, result.id)).slice(1);
    expect(rows.map((r) => r.split(',')[0])).toEqual(['Marcus Vance', 'Sophie Tremblay']);

    const before = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM exports`);
    expect(
      await errorOf(
        service.create(
          admin,
          { entity: 'contact', filter: { field: 'secret', op: 'eq', value: 1 } },
          null,
        ),
      ),
    ).toMatchObject({ status: 400, code: 'INVALID_FILTER' });
    expect(
      await errorOf(service.create(admin, { entity: 'contact', q: 'nobody-has-this-name' }, null)),
    ).toMatchObject({ status: 422, code: 'EXPORT_EMPTY' });
    const after = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM exports`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('keeps cells that look like formulas as plain text, and quotes commas and quotes', async () => {
    await addContact('cnt_exp_formula', ['Ivo', 'Quill'], 'ivo.quill@exp-formula.example.com', {
      title: '=HYPERLINK("http://example.com","Open")',
    });
    const result = await service.create(admin, { entity: 'contact', q: 'Quill' }, null);
    const csv = await csvOf(admin, result.id);
    expect(csv).toContain(`"'=HYPERLINK(""http://example.com"",""Open"")"`);
  });

  it('writes deal amounts as plain numbers beside their currency', async () => {
    const result = await service.create(admin, { entity: 'deal' }, null);
    const [header, ...rows] = lines(await csvOf(admin, result.id));
    const cols = (header ?? '').split(',');
    const monthly = cols.indexOf('Monthly value');
    const currency = cols.indexOf('Currency');
    expect(monthly).toBeGreaterThan(-1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = row.split(',');
      // Names in the seed have no commas, so splitting is safe here.
      expect(cells[monthly]).toMatch(/^\d+(\.\d{2})?$/);
      expect(['USD', 'CAD']).toContain(cells[currency]);
    }
  });

  it('only the person who asked can see or download an export', async () => {
    const result = await service.create(admin, { entity: 'company' }, null);
    expect(await errorOf(service.get(managerUs, result.id))).toMatchObject({ status: 404 });
    expect(await errorOf(service.download(managerUs, result.id, null))).toMatchObject({
      status: 404,
    });
  });

  it('deletes files after 7 days', async () => {
    const result = await service.create(admin, { entity: 'company' }, null);
    await db.query(`UPDATE exports SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      result.id,
    ]);
    const key = await db.query<{ storage_key: string }>(
      `SELECT f.storage_key FROM exports e JOIN files f ON f.id = e.file_id WHERE e.id = $1`,
      [result.id],
    );
    expect(await service.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect((await service.get(admin, result.id)).status).toBe('expired');
    await expect(files.get(String(key.rows[0]?.storage_key))).rejects.toThrow();
    expect(await errorOf(service.download(admin, result.id, null))).toMatchObject({
      status: 410,
      code: 'EXPORT_EXPIRED',
    });
  });

  describe('large exports', () => {
    beforeAll(async () => {
      // 5,010 synthetic contacts on the U.S. team.
      await db.query(
        `INSERT INTO contacts (id, first_name, last_name, full_name, title, job_function, seniority,
                               primary_email, market, timezone, owner_user_id, team_id)
         SELECT 'cnt_bulk_' || n, 'Bulk', 'Person ' || n, 'Bulk Person ' || n, '', '', '',
                'bulk.person.' || n || '@exp-bulk.example.com', 'US', 'America/New_York',
                'usr_mgr_1', 'team_us'
         FROM generate_series(1, 5010) AS n`,
      );
    }, 90_000);

    it('more than 1,000 rows needs export permission for everything', async () => {
      expect(
        await errorOf(service.create(managerUs, { entity: 'contact', q: 'Bulk Person' }, null)),
      ).toMatchObject({ status: 403, code: 'EXPORT_NEEDS_ALL_SCOPE' });
    });

    it('more than 5,000 rows are built in the background, then the requester and admins are told', async () => {
      const result = await service.create(marketing, { entity: 'contact', q: 'Bulk Person' }, null);
      expect(result).toMatchObject({ status: 'queued', background: true, rowCount: 5010 });
      expect(await errorOf(service.download(marketing, result.id, null))).toMatchObject({
        status: 409,
        code: 'EXPORT_NOT_READY',
      });

      expect(await service.processNext()).toEqual({ exports: 1 });
      const done = await service.get(marketing, result.id);
      expect(done).toMatchObject({ status: 'ready', rowCount: 5010, processedRows: 5010 });
      expect(lines(await csvOf(marketing, result.id))).toHaveLength(5011);

      const notes = await db.query<{ user_id: string; kind: string; body: string }>(
        `SELECT user_id, kind, body FROM notifications
         WHERE dedupe_key IN ($1, $2) ORDER BY kind`,
        [`export_ready:${result.id}`, `export_large:${result.id}:usr_admin_1`],
      );
      expect(notes.rows).toEqual([
        {
          user_id: 'usr_mkt_1',
          kind: 'export_ready',
          body: expect.stringContaining('5,010 contacts'),
        },
        { user_id: 'usr_admin_1', kind: 'security', body: 'Ananya Iyer exported 5,010 contacts.' },
      ]);
      // A retried job finds nothing more to do.
      expect(await service.processNext()).toEqual({ exports: 0 });
    });

    it('the job applies the requester’s current access, so access removed since stops it', async () => {
      const result = await service.create(marketing, { entity: 'contact', q: 'Bulk Person' }, null);
      await db.query(`UPDATE users SET role_id = 'role_ae' WHERE id = 'usr_mkt_1'`);
      try {
        await service.processNext();
      } finally {
        await db.query(`UPDATE users SET role_id = 'role_mkt_mgr' WHERE id = 'usr_mkt_1'`);
      }
      const failed = await service.get(marketing, result.id);
      expect(failed.status).toBe('failed');
      expect(failed.failureReason).toBe(
        'The export was stopped because you no longer have permission to export.',
      );
      const stored = await db.query<{ file_id: string | null }>(
        `SELECT file_id FROM exports WHERE id = $1`,
        [result.id],
      );
      expect(stored.rows[0]?.file_id).toBeNull();
    });
  });
});
