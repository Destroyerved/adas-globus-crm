import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SessionUser } from '@adas/shared';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { CrmListService } from '../modules/crm/index.js';
import { DataQualityService } from '../modules/data-quality/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Global search, the contact list's search and the tag filters (PRD 6.8, 6.10). These three
 * were rewritten as indexed lookups after the large seed showed them reading whole tables
 * (ADR 0011); this checks they still find the same records and still respect scope.
 */

let db: DatabaseService;
let search: DataQualityService;
let lists: CrmListService;
let admin: SessionUser;
let managerUs: SessionUser;

const names = (rows: Record<string, unknown>[], key = 'full_name') => rows.map((r) => r[key]);

beforeAll(async () => {
  db = DatabaseService.forTests();
  await db.ensureInitialized();
  const auth = new AuthAndUsersService(db);
  search = new DataQualityService(db);
  lists = new CrmListService(db);
  admin = await auth.resolveSessionUser('usr_admin_1');
  managerUs = await auth.resolveSessionUser('usr_mgr_1');
  await db.exec(`
    INSERT INTO tags (id, name) VALUES ('tag_s_1', 'vip'), ('tag_s_2', 'audit');
    INSERT INTO entity_tags (entity_type, entity_id, tag_id) VALUES
      ('contact', 'cnt_jane', 'tag_s_1'), ('contact', 'cnt_jane', 'tag_s_2'),
      ('contact', 'cnt_elena', 'tag_s_1'),
      ('company', 'cmp_acme', 'tag_s_1');
  `);
}, 90_000);

afterAll(async () => {
  await db.close();
});

describe('global search (PRD 6.10)', () => {
  it('finds records by part of a name, an email or a domain', async () => {
    const acme = await search.globalSearch(admin, 'acme');
    expect(names(acme.companies, 'name')).toContain('Acme Tax & Advisory LLP');
    // The contact matches through her email address at that firm.
    expect(names(acme.contacts)).toContain('Jane Patel');
    expect(names(acme.leads)).toContain('Jane Patel');

    const byDomain = await search.globalSearch(admin, 'ridgewaycpa');
    expect(names(byDomain.companies, 'name')).toEqual(['Ridgeway CPA Group']);

    const deals = await search.globalSearch(admin, 'tax season');
    expect(names(deals.deals, 'name')).toContain('2027 Tax Season Prep Pod (3 FTE)');
  });

  it('still finds a name typed with a mistake, best match first', async () => {
    const typo = await search.globalSearch(admin, 'Jane Patl');
    expect(names(typo.contacts)[0]).toBe('Jane Patel');
    expect(names(typo.leads)[0]).toBe('Jane Patel');
    const firm = await search.globalSearch(admin, 'Ridgeway CPA Grup');
    expect(names(firm.companies, 'name')[0]).toBe('Ridgeway CPA Group');
  });

  it('returns only what the person may see', async () => {
    expect(names((await search.globalSearch(admin, 'vance')).contacts)).toEqual(['Marcus Vance']);
    // Marcus is on the Canadian team: outside the U.S. manager's team scope.
    const scoped = await search.globalSearch(managerUs, 'vance');
    expect(scoped.contacts).toEqual([]);
    expect(scoped.leads).toEqual([]);
    expect((await search.globalSearch(managerUs, 'northstar')).companies).toEqual([]);
  });

  it('takes % and _ in the text literally, and returns nothing for blank text', async () => {
    for (const text of ['%', '_', '%%%', '   ']) {
      const result = await search.globalSearch(admin, text);
      expect(result, text).toEqual({ companies: [], contacts: [], leads: [], deals: [] });
    }
  });
});

describe('contact list search (PRD 6.8)', () => {
  const page = (q: string) => ({ limit: 50, cursor: null, sort: 'name', q, filter: null });

  it('matches the contact’s name or email, or the company’s name', async () => {
    const byName = await lists.list('contacts', admin, page('rostova'));
    expect(names(byName.items)).toEqual(['Elena Rostova']);
    expect(byName.total).toBe(1);

    const byEmail = await lists.list('contacts', admin, page('dchen@'));
    expect(names(byEmail.items)).toEqual(['David Chen']);

    const byCompany = await lists.list('contacts', admin, page('Laurentian'));
    expect(names(byCompany.items)).toEqual(['Sophie Tremblay']);
    expect(byCompany.total).toBe(1);

    // A contact that matches by name and by company is listed once.
    await db.query(
      `INSERT INTO contacts (id, company_id, first_name, last_name, full_name, title, job_function,
                             seniority, primary_email, market, timezone, owner_user_id, team_id)
       VALUES ('cnt_s_ridge', 'cmp_ridgeway', 'Ridgeway', 'Ortiz', 'Ridgeway Ortiz', '', '', '',
               'r.ortiz@search-test.example.com', 'US', 'America/Chicago', 'usr_ae_1', 'team_us')`,
    );
    const both = await lists.list('contacts', admin, page('ridgeway'));
    expect(names(both.items)).toEqual(['Elena Rostova', 'Ridgeway Ortiz']);
    expect(both.total).toBe(2);
  });

  it('keeps the scope: a company name outside the team finds nothing', async () => {
    expect((await lists.list('contacts', managerUs, page('Laurentian'))).total).toBe(0);
    expect((await lists.list('contacts', managerUs, page('rostova'))).total).toBe(1);
  });
});

describe('search just after a large import', () => {
  it('stays quick while the table statistics are still out of date', async () => {
    // 4,000 contacts arrive in one go and nothing has refreshed the statistics yet. An
    // IN (sub-query) here was run again for every row and took minutes (ADR 0011).
    await db.exec(`
      INSERT INTO contacts (id, first_name, last_name, full_name, title, job_function, seniority,
                            primary_email, market, timezone, owner_user_id, team_id)
      SELECT 'cnt_stale_' || n, 'Stale', 'Stats ' || n, 'Stale Stats ' || n, '', '', '',
             'stale.stats.' || n || '@search-stale.example.com', 'US', 'America/New_York',
             'usr_mgr_1', 'team_us'
      FROM generate_series(1, 4000) AS n;
    `);
    const started = Date.now();
    const listed = await lists.list('contacts', admin, {
      limit: 50,
      cursor: null,
      sort: '-updatedAt',
      q: 'Stale Stats',
      filter: null,
    });
    const found = await search.globalSearch(admin, 'Stale Stats 1234');
    const seconds = (Date.now() - started) / 1000;
    expect(listed.total).toBe(4000);
    expect(listed.items).toHaveLength(50);
    expect(names(found.contacts)[0]).toBe('Stale Stats 1234');
    expect(seconds).toBeLessThan(20);
  });
});

describe('tag filters (PRD 6.8)', () => {
  const tagged = async (filter: unknown, entity: 'contacts' | 'companies' = 'contacts') =>
    names(
      (await lists.list(entity, admin, { limit: 50, cursor: null, sort: 'name', q: '', filter }))
        .items,
      entity === 'contacts' ? 'full_name' : 'name',
    );

  it('has any of the tags', async () => {
    expect(await tagged({ field: 'tags', op: 'hasAny', value: ['vip'] })).toEqual([
      'Elena Rostova',
      'Jane Patel',
    ]);
    expect(await tagged({ field: 'tags', op: 'hasAny', value: ['audit', 'missing'] })).toEqual([
      'Jane Patel',
    ]);
    expect(await tagged({ field: 'tags', op: 'hasAny', value: ['missing'] })).toEqual([]);
    // Tags of another record type never match.
    expect(await tagged({ field: 'tags', op: 'hasAny', value: ['vip'] }, 'companies')).toEqual([
      'Acme Tax & Advisory LLP',
    ]);
  });

  it('has all of the tags, whatever their case or repetition', async () => {
    expect(await tagged({ field: 'tags', op: 'hasAll', value: ['vip', 'audit'] })).toEqual([
      'Jane Patel',
    ]);
    expect(await tagged({ field: 'tags', op: 'hasAll', value: ['VIP', 'vip'] })).toEqual([
      'Elena Rostova',
      'Jane Patel',
    ]);
    expect(await tagged({ field: 'tags', op: 'hasAll', value: ['vip', 'missing'] })).toEqual([]);
  });

  it('has no tags, and has some', async () => {
    const none = await tagged({ field: 'tags', op: 'isEmpty' });
    expect(none).not.toContain('Jane Patel');
    expect(none).toContain('David Chen');
    expect(await tagged({ field: 'tags', op: 'isNotEmpty' })).toEqual([
      'Elena Rostova',
      'Jane Patel',
    ]);
  });
});
