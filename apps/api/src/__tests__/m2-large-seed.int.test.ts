import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SessionUser } from '@adas/shared';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { CrmListService } from '../modules/crm/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { seedLarge, type LargeSeedSize } from '../platform/db/seed-large.js';

/**
 * The large seed's generator at a small size (PRD 12.2; AGENTS.md section 6): the counts, the
 * rules the tables enforce, synthetic-only data, the spread across teams, and that running it
 * again adds nothing. The full size is loaded by `pnpm db:seed --size=large`.
 */

const SIZE: LargeSeedSize = {
  companies: 400,
  contacts: 1_200,
  activities: 6_000,
  leads: 240,
  deals: 100,
  tasks: 120,
};

let db: DatabaseService;
let counts: Record<string, number>;
let baseline: Record<string, number>;

const target = () => ({
  exec: (sql: string) => db.exec(sql),
  query: <T>(sql: string) => db.query<T>(sql),
});

async function count(sql: string): Promise<number> {
  const res = await db.query<{ n: number }>(sql);
  return res.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  db = DatabaseService.forTests();
  await db.ensureInitialized();
  baseline = {};
  for (const table of ['companies', 'contacts', 'leads', 'deals', 'tasks', 'activities']) {
    baseline[table] = await count(`SELECT COUNT(*)::int AS n FROM ${table}`);
  }
  counts = await seedLarge(target(), SIZE);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('large seed (PRD 12.2)', () => {
  it('loads exactly the asked number of rows on top of the baseline', () => {
    for (const table of [
      'companies',
      'contacts',
      'leads',
      'deals',
      'tasks',
      'activities',
    ] as const) {
      expect(counts[table], table).toBe((baseline[table] ?? 0) + SIZE[table]);
    }
  });

  it('every contact has its company, a primary email record and a unique address', async () => {
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM contacts c
         WHERE starts_with(c.id, 'cnt_l_')
           AND (NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)
             OR NOT EXISTS (SELECT 1 FROM contact_emails e
                            WHERE e.contact_id = c.id AND e.is_primary AND e.email = c.primary_email))`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT primary_email FROM contacts GROUP BY primary_email HAVING COUNT(*) > 1) d`,
      ),
    ).toBe(0);
    // About three contacts at each firm, and a contact follows its firm's market and team.
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM contacts c JOIN companies co ON co.id = c.company_id
         WHERE starts_with(c.id, 'cnt_l_') AND (c.market <> co.market OR c.team_id <> co.team_id
                                        OR c.owner_user_id <> co.owner_user_id)`,
      ),
    ).toBe(0);
  });

  it('holds only invented data: reserved domains and fictional phone numbers', async () => {
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM contacts
         WHERE starts_with(id, 'cnt_l_') AND primary_email !~ '@[a-z0-9]+\\.example\\.(com|ca)$'`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM companies
         WHERE starts_with(id, 'cmp_l_') AND domain !~ '^[a-z0-9]+\\.example\\.(com|ca)$'`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM contacts
         WHERE starts_with(id, 'cnt_l_') AND phone_e164 IS NOT NULL
           AND phone_e164 !~ '^\\+1[2-9][0-9]{2}55501[0-9]{2}$'`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT phone_e164 FROM contacts WHERE phone_e164 IS NOT NULL
           GROUP BY phone_e164 HAVING COUNT(*) > 1) d`,
      ),
    ).toBe(0);
  });

  it('spreads records over both markets and every owner, so each scope sees a real share', async () => {
    const auth = new AuthAndUsersService(db);
    const lists = new CrmListService(db);
    const total = async (user: SessionUser) =>
      (
        await lists.list('contacts', user, {
          limit: 1,
          cursor: null,
          sort: '-updatedAt',
          q: '',
          filter: { field: 'email', op: 'contains', value: '.example.' },
        })
      ).total;
    const all = await total(await auth.resolveSessionUser('usr_admin_1'));
    const team = await total(await auth.resolveSessionUser('usr_mgr_1'));
    const own = await total(await auth.resolveSessionUser('usr_ae_1'));
    expect(all).toBe(counts['contacts']);
    // Three in four are U.S.; the U.S. team's three owners share them.
    expect(team).toBeGreaterThan(all * 0.7);
    expect(team).toBeLessThan(all * 0.8);
    expect(own).toBeGreaterThan(all * 0.2);
    expect(own).toBeLessThan(all * 0.3);
  });

  it('gives the deals board open deals in every open stage, and closed deals their dates', async () => {
    const stages = await db.query<{ stage_id: string; n: number }>(
      `SELECT stage_id, COUNT(*)::int AS n FROM deals
       WHERE starts_with(id, 'deal_l_') AND stage_category = 'open' GROUP BY stage_id ORDER BY stage_id`,
    );
    expect(stages.rows.map((r) => r.stage_id)).toEqual([
      'stg_disc',
      'stg_neg',
      'stg_new',
      'stg_prop',
      'stg_trial',
    ]);
    expect(stages.rows.reduce((sum, r) => sum + r.n, 0)).toBe(20);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM deals
         WHERE starts_with(id, 'deal_l_')
           AND ((stage_category = 'won' AND (won_at IS NULL OR closed_at IS NULL OR contract_start_date IS NULL))
             OR (stage_category = 'lost' AND (lost_at IS NULL OR closed_at IS NULL OR lost_reason IS NULL))
             OR (stage_category = 'open' AND closed_at IS NOT NULL))`,
      ),
    ).toBe(0);
  });

  it('links every timeline entry to a record that exists', async () => {
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM activities a
         WHERE starts_with(a.id, 'act_l_') AND (
           (a.entity_type = 'contact' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = a.entity_id))
           OR (a.entity_type = 'company' AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = a.entity_id))
           OR (a.entity_type = 'lead' AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = a.entity_id)))`,
      ),
    ).toBe(0);
    const kinds = await db.query<{ entity_type: string; n: number }>(
      `SELECT entity_type, COUNT(*)::int AS n FROM activities WHERE starts_with(id, 'act_l_')
       GROUP BY entity_type ORDER BY entity_type`,
    );
    expect(kinds.rows).toEqual([
      { entity_type: 'company', n: 1_200 },
      { entity_type: 'contact', n: 4_200 },
      { entity_type: 'lead', n: 600 },
    ]);
  });

  it('adds nothing when it runs again', async () => {
    const again = await seedLarge(target(), SIZE);
    expect(again).toEqual(counts);
    expect(
      await count(`SELECT COUNT(*)::int AS n FROM contact_emails WHERE starts_with(id, 'ce_l_')`),
    ).toBe(SIZE.contacts);
  });

  it('refuses to run before the small seed', async () => {
    await expect(
      seedLarge({
        exec: async () => undefined,
        query: async <T>() => ({ rows: [{ n: 0 }] as T[] }),
      }),
    ).rejects.toThrow(/small seed first/);
  });
});
