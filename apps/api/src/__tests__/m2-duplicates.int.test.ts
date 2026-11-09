import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SessionUser } from '@adas/shared';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { DuplicateService } from '../modules/duplicates/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Duplicate review and merge on the database (PRD 4.9; acceptance A5): the scan, the queue,
 * scope, the merge itself, undo and the refusals. Every person and address is synthetic.
 */

let db: DatabaseService;
let service: DuplicateService;
let admin: SessionUser;
let managerUs: SessionUser;
let managerCa: SessionUser;
let bdr: SessionUser;

beforeAll(async () => {
  db = DatabaseService.forTests();
  await db.ensureInitialized();
  await db.query(
    `INSERT INTO users (id, email, name, role_id, team_id, market_focus, status)
     VALUES ('usr_mgr_ca', 'mgr.ca@adasglobuspro.example.com', 'Casey Moreau', 'role_sales_mgr',
             'team_ca', 'CA', 'active')`,
  );
  const auth = new AuthAndUsersService(db);
  service = new DuplicateService(db);
  admin = await auth.resolveSessionUser('usr_admin_1');
  managerUs = await auth.resolveSessionUser('usr_mgr_1');
  managerCa = await auth.resolveSessionUser('usr_mgr_ca');
  bdr = await auth.resolveSessionUser('usr_bdr_2');
});

afterAll(async () => {
  await db.close();
});

interface ContactSeed {
  id: string;
  first: string;
  last: string;
  email: string;
  companyId?: string | null;
  phone?: string | null;
  title?: string;
  owner?: string;
  team?: string;
  doNotContact?: boolean;
}

async function addContact(c: ContactSeed): Promise<void> {
  await db.query(
    `INSERT INTO contacts (id, company_id, first_name, last_name, full_name, title, job_function,
                           seniority, primary_email, phone_e164, market, timezone, owner_user_id,
                           team_id, do_not_contact)
     VALUES ($1, $2, $3, $4, $5, $6, '', '', $7, $8, 'US', 'America/New_York', $9, $10, $11)`,
    [
      c.id,
      c.companyId ?? null,
      c.first,
      c.last,
      `${c.first} ${c.last}`,
      c.title ?? '',
      c.email,
      c.phone ?? null,
      c.owner ?? 'usr_mgr_1',
      c.team ?? 'team_us',
      c.doNotContact ?? false,
    ],
  );
  await db.query(
    `INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ($1, $2, $3, TRUE)`,
    [`ce_${c.id}`, c.id, c.email],
  );
}

async function addCompany(id: string, name: string, domain: string | null): Promise<void> {
  await db.query(
    `INSERT INTO companies (id, name, domain, website, market, owner_user_id, team_id)
     VALUES ($1, $2, $3, $4, 'US', 'usr_mgr_1', 'team_us')`,
    [id, name, domain, domain ? `https://${domain}` : null],
  );
}

async function version(table: string, id: string): Promise<number> {
  const res = await db.query<{ version: number }>(`SELECT version FROM ${table} WHERE id = $1`, [
    id,
  ]);
  return Number(res.rows[0]?.version);
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query<T>(sql, params);
  return res.rows[0] as T;
}

async function pair(id: string, left: string, right: string, entity = 'contact') {
  await db.query(
    `INSERT INTO duplicate_candidates (id, entity_type, left_entity_id, right_entity_id, match_reason, confidence)
     VALUES ($1, $2, $3, $4, 'Same phone number', 0.8)`,
    [id, entity, left, right],
  );
}

const params = (entries: Record<string, string>) => new URLSearchParams(entries);

describe('Duplicate review and merge (PRD 4.9)', () => {
  it('the scan queues probable pairs once, and a dismissed pair never comes back', async () => {
    await addCompany('cmp_harbor_a', 'Harborview Tax Partners LLP', 'harborview-a.example.com');
    await addCompany('cmp_harbor_b', 'Harborview Tax Partners LLC', 'harborview-b.example.com');
    await addContact({
      id: 'cnt_ph_1',
      first: 'Avery',
      last: 'Stone',
      email: 'avery@scan-one.example.com',
      phone: '+13125550771',
    });
    await addContact({
      id: 'cnt_ph_2',
      first: 'Avery',
      last: 'Stonehill',
      email: 'a.stonehill@scan-two.example.com',
      phone: '+13125550771',
    });
    await addContact({
      id: 'cnt_nm_1',
      first: 'Rowan',
      last: 'Pike',
      email: 'rowan@harborview-a.example.com',
      companyId: 'cmp_harbor_a',
    });
    await addContact({
      id: 'cnt_nm_2',
      first: 'rowan',
      last: 'PIKE',
      email: 'r.pike@harborview-a.example.com',
      companyId: 'cmp_harbor_a',
    });

    const first = await service.scan({ batchSize: 3 });
    expect(first.queued).toBeGreaterThanOrEqual(3);
    const again = await service.scan();
    expect(again.queued).toBe(0);

    const contacts = await service.list(admin, params({ entity: 'contact' }));
    const reasons = contacts.items.map((c) => [c.reason, [c.a.id, c.b.id].sort().join('+')]);
    expect(reasons).toContainEqual(['Same phone number', 'cnt_ph_1+cnt_ph_2']);
    expect(reasons).toContainEqual(['Same name and company domain', 'cnt_nm_1+cnt_nm_2']);
    const companies = await service.list(admin, params({ entity: 'company' }));
    const harbor = companies.items.find(
      (c) => [c.a.id, c.b.id].sort().join('+') === 'cmp_harbor_a+cmp_harbor_b',
    );
    expect(harbor?.reason).toBe('Similar company name in the same country');
    expect(harbor?.foundBy).toBe('scan');

    const phonePair = contacts.items.find((c) => c.reason === 'Same phone number');
    await service.dismiss(admin, String(phonePair?.id), null);
    const after = await service.list(admin, params({ entity: 'contact' }));
    expect(after.items.map((c) => c.id)).not.toContain(phonePair?.id);
    const audit = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'duplicate.dismissed'`,
    );
    expect(audit.n).toBe(1);

    // Scanning everything again never brings back a dismissed pair.
    await db.query(`DELETE FROM settings WHERE key = 'job.duplicates_scan'`);
    expect((await service.scan()).queued).toBe(0);
  });

  it('pages through the queue without gaps', async () => {
    for (const n of [1, 2, 3]) {
      await addContact({
        id: `cnt_pg_${n}`,
        first: 'Page',
        last: `Test ${n}`,
        email: `page${n}@paging.example.com`,
      });
    }
    await pair('dup_pg_1', 'cnt_pg_1', 'cnt_pg_2');
    await pair('dup_pg_2', 'cnt_pg_2', 'cnt_pg_3');
    const firstPage = await service.list(admin, params({ entity: 'contact', limit: '1' }));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const all = await service.list(admin, params({ entity: 'contact' }));
    const second = await service.list(
      admin,
      params({ entity: 'contact', limit: '50', cursor: String(firstPage.nextCursor) }),
    );
    expect([...firstPage.items, ...second.items].map((c) => c.id)).toEqual(
      all.items.map((c) => c.id),
    );
  });

  it('the queue and merges follow scope: own, team and all', async () => {
    await addContact({
      id: 'cnt_sc_1',
      first: 'Quinn',
      last: 'Hale',
      email: 'quinn@scope-one.example.com',
    });
    await addContact({
      id: 'cnt_sc_2',
      first: 'Quinn',
      last: 'Hale',
      email: 'q.hale@scope-two.example.com',
    });
    await pair('dup_scope', 'cnt_sc_1', 'cnt_sc_2');

    const all = await service.list(admin, params({ entity: 'contact' }));
    expect(all.items.map((c) => c.id)).toContain('dup_scope');
    const team = await service.list(managerUs, params({ entity: 'contact' }));
    expect(team.items.map((c) => c.id)).toContain('dup_scope');
    const otherTeam = await service.list(managerCa, params({ entity: 'contact' }));
    expect(otherTeam.items.map((c) => c.id)).not.toContain('dup_scope');
    await expect(service.get(managerCa, 'dup_scope')).rejects.toMatchObject({ status: 404 });
    await expect(service.list(bdr, params({ entity: 'contact' }))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.merge(
        managerCa,
        'contact',
        'cnt_sc_1',
        { mergedId: 'cnt_sc_2', keptVersion: 1, mergedVersion: 1 },
        null,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.preview(managerCa, 'contact', 'cnt_sc_1', 'cnt_sc_2'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('the preview fills blanks from the other record and explains what will happen', async () => {
    await addContact({
      id: 'cnt_k',
      first: 'Morgan',
      last: 'Reyes',
      email: 'morgan@merge-kept.example.com',
      companyId: 'cmp_acme',
      title: 'Partner',
    });
    await addContact({
      id: 'cnt_m',
      first: 'Morgan',
      last: 'Reyes',
      email: 'm.reyes@merge-other.example.com',
      companyId: 'cmp_acme',
      title: 'Tax Director',
      phone: '+13125550199',
    });
    await db.query(
      `INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('ce_m2', 'cnt_m', 'm.reyes.alt@merge-other.example.com', FALSE)`,
    );
    // Both are in the U.S. trial sequence; only the merged contact is in the Canadian one.
    await db.query(
      `INSERT INTO sequence_enrollments (id, sequence_id, contact_id, email, sender_user_id, status, next_send_at)
       VALUES ('enr_k_us', 'seq_us_cpa_trial', 'cnt_k', 'morgan@merge-kept.example.com', 'usr_mgr_1', 'active', NOW() + INTERVAL '1 day'),
              ('enr_m_us', 'seq_us_cpa_trial', 'cnt_m', 'm.reyes@merge-other.example.com', 'usr_mgr_1', 'active', NOW() + INTERVAL '1 day'),
              ('enr_m_ca', 'seq_ca_cpa_inquiry', 'cnt_m', 'm.reyes@merge-other.example.com', 'usr_mgr_1', 'active', NOW() + INTERVAL '1 day')`,
    );
    await db.query(
      `INSERT INTO list_members (list_id, contact_id) VALUES
         ('lst_us_ultratax', 'cnt_k'), ('lst_us_ultratax', 'cnt_m'), ('lst_ca_express', 'cnt_m')`,
    );
    await db.query(
      `INSERT INTO tasks (id, title, task_type, status, due_at, assignee_user_id, team_id, created_by_user_id, contact_id)
       VALUES ('tsk_m', 'Call Morgan back', 'call', 'open', NOW() + INTERVAL '1 day', 'usr_mgr_1', 'team_us', 'usr_mgr_1', 'cnt_m')`,
    );
    await db.query(
      `INSERT INTO activities (id, entity_type, entity_id, contact_id, activity_type, title, detail, actor_user_id)
       VALUES ('act_m', 'contact', 'cnt_m', 'cnt_m', 'call', 'Logged a call', 'Asked about busy-season pods.', 'usr_mgr_1')`,
    );
    await db.query(
      `INSERT INTO notes (id, entity_type, entity_id, body, author_user_id)
       VALUES ('note_m', 'contact', 'cnt_m', 'Prefers email.', 'usr_mgr_1')`,
    );
    await db.query(`INSERT INTO tags (id, name) VALUES ('tag_merge', 'Busy season 2027')`);
    await db.query(
      `INSERT INTO entity_tags (entity_type, entity_id, tag_id) VALUES ('contact', 'cnt_m', 'tag_merge')`,
    );
    await db.query(`UPDATE deals SET primary_contact_id = 'cnt_m' WHERE id = 'deal_acme_tax'`);
    await pair('dup_km', 'cnt_k', 'cnt_m');
    await pair('dup_m_jane', 'cnt_m', 'cnt_jane');
    await pair('dup_m_elena', 'cnt_m', 'cnt_elena');
    await pair('dup_k_elena', 'cnt_k', 'cnt_elena');

    const preview = await service.preview(admin, 'contact', 'cnt_k', 'cnt_m');
    expect(preview.defaults['phone']).toBe('merged');
    expect(preview.defaults['title']).toBe('kept');
    expect(preview.merged.fields['phone']).toBe('+13125550199');
    expect(preview.merged.linked).toContainEqual({ label: 'Tasks', count: 1 });
    expect(preview.merged.linked).toContainEqual({ label: 'Deals', count: 1 });
    expect(preview.notes.join(' ')).toContain('sequence enrollment will stop');
    expect(preview.notes.join(' ')).toContain('undo the merge for 30 days');
  });

  it('a contact merge takes the chosen fields and re-points every link', async () => {
    const before = await one<{ member_count: number }>(
      `SELECT member_count FROM lists WHERE id = 'lst_us_ultratax'`,
    );
    const view = await service.merge(
      admin,
      'contact',
      'cnt_k',
      {
        mergedId: 'cnt_m',
        keptVersion: await version('contacts', 'cnt_k'),
        mergedVersion: await version('contacts', 'cnt_m'),
        take: { email: 'merged', title: 'merged' },
        candidateId: 'dup_km',
      },
      '127.0.0.1',
    );
    expect(view.kept).toMatchObject({ id: 'cnt_k', active: true });
    expect(view.merged).toMatchObject({ id: 'cnt_m', name: 'Morgan Reyes' });
    expect(view.moved).toContainEqual({ label: 'Deals', count: 1 });
    expect(view.undoneAt).toBeNull();

    const kept = await one(`SELECT * FROM contacts WHERE id = 'cnt_k'`);
    expect(kept).toMatchObject({
      primary_email: 'm.reyes@merge-other.example.com',
      title: 'Tax Director',
      phone_e164: '+13125550199',
      deleted_at: null,
    });
    expect(
      (await one(`SELECT deleted_at FROM contacts WHERE id = 'cnt_m'`))['deleted_at'],
    ).not.toBeNull();

    const emails = await db.query<{ email: string; is_primary: boolean }>(
      `SELECT email, is_primary FROM contact_emails WHERE contact_id = 'cnt_k' ORDER BY email`,
    );
    expect(emails.rows).toEqual([
      { email: 'm.reyes.alt@merge-other.example.com', is_primary: false },
      { email: 'm.reyes@merge-other.example.com', is_primary: true },
      { email: 'morgan@merge-kept.example.com', is_primary: false },
    ]);
    expect((await one(`SELECT contact_id FROM tasks WHERE id = 'tsk_m'`))['contact_id']).toBe(
      'cnt_k',
    );
    expect(await one(`SELECT contact_id, entity_id FROM activities WHERE id = 'act_m'`)).toEqual({
      contact_id: 'cnt_k',
      entity_id: 'cnt_k',
    });
    expect((await one(`SELECT entity_id FROM notes WHERE id = 'note_m'`))['entity_id']).toBe(
      'cnt_k',
    );
    expect(
      (await one(`SELECT primary_contact_id FROM deals WHERE id = 'deal_acme_tax'`))[
        'primary_contact_id'
      ],
    ).toBe('cnt_k');
    expect(
      (
        await one<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM entity_tags WHERE entity_id = 'cnt_k' AND tag_id = 'tag_merge'`,
        )
      ).n,
    ).toBe(1);

    // Lists: the shared membership is dropped once, the other one moves.
    const lists = await db.query<{ list_id: string; contact_id: string }>(
      `SELECT list_id, contact_id FROM list_members WHERE contact_id IN ('cnt_k', 'cnt_m') ORDER BY list_id`,
    );
    expect(lists.rows).toEqual([
      { list_id: 'lst_ca_express', contact_id: 'cnt_k' },
      { list_id: 'lst_us_ultratax', contact_id: 'cnt_k' },
    ]);
    expect(
      (
        await one<{ member_count: number }>(
          `SELECT member_count FROM lists WHERE id = 'lst_us_ultratax'`,
        )
      ).member_count,
    ).toBe(before.member_count - 1);

    // Sequences: the kept contact is never emailed twice by the same sequence.
    const enrollments = await db.query<{ id: string; contact_id: string; status: string }>(
      `SELECT id, contact_id, status FROM sequence_enrollments WHERE id LIKE 'enr_%' ORDER BY id`,
    );
    expect(enrollments.rows).toEqual([
      { id: 'enr_k_us', contact_id: 'cnt_k', status: 'active' },
      { id: 'enr_m_ca', contact_id: 'cnt_k', status: 'active' },
      { id: 'enr_m_us', contact_id: 'cnt_k', status: 'stopped_merged' },
    ]);

    // The queue: this pair closes, the merged contact's other pairs follow the kept one.
    const pairs = await db.query<{
      id: string;
      status: string;
      left_entity_id: string;
      right_entity_id: string;
    }>(
      `SELECT id, status, left_entity_id, right_entity_id FROM duplicate_candidates
       WHERE id IN ('dup_km', 'dup_m_jane', 'dup_m_elena', 'dup_k_elena') ORDER BY id`,
    );
    expect(pairs.rows).toEqual([
      { id: 'dup_k_elena', status: 'open', left_entity_id: 'cnt_k', right_entity_id: 'cnt_elena' },
      { id: 'dup_km', status: 'merged', left_entity_id: 'cnt_k', right_entity_id: 'cnt_m' },
      {
        id: 'dup_m_elena',
        status: 'merged',
        left_entity_id: 'cnt_m',
        right_entity_id: 'cnt_elena',
      },
      { id: 'dup_m_jane', status: 'open', left_entity_id: 'cnt_k', right_entity_id: 'cnt_jane' },
    ]);

    const history = await db.query<{ field_name: string; via: string }>(
      `SELECT field_name, via FROM record_history WHERE entity_id = 'cnt_k' ORDER BY field_name`,
    );
    expect(history.rows.map((h) => h.field_name)).toEqual(
      expect.arrayContaining(['phone_e164', 'primary_email', 'title']),
    );
    expect(history.rows.every((h) => h.via === 'merge')).toBe(true);
    const timeline = await one(
      `SELECT title, detail FROM activities WHERE contact_id = 'cnt_k' AND activity_type = 'merge'`,
    );
    expect(timeline['title']).toBe('Merged Morgan Reyes into this contact');
    expect(String(timeline['detail'])).toContain('1 deal');
    const audit = await one(
      `SELECT entity_id, metadata, ip_address FROM audit_logs WHERE action = 'contact.merged'`,
    );
    expect(audit['entity_id']).toBe('cnt_k');
    expect(JSON.stringify(audit['metadata'])).not.toContain('@');
    const event = await one(
      `SELECT aggregate_id, payload FROM outbox_events WHERE event_type = 'contact.merged'`,
    );
    expect(event['aggregate_id']).toBe('cnt_k');

    const merges = await service.listMerges(admin, 'contact');
    expect(merges.items[0]?.id).toBe(view.id);
    const visibleToTeam = await service.listMerges(managerUs, 'contact');
    expect(visibleToTeam.items.map((m) => m.id)).toContain(view.id);
    const hiddenFromOtherTeam = await service.listMerges(managerCa, 'contact');
    expect(hiddenFromOtherTeam.items.map((m) => m.id)).not.toContain(view.id);
  });

  it('undo restores the merged contact, moves every link back and keeps fields edited since', async () => {
    const merge = (await service.listMerges(admin, 'contact')).items[0];
    // Someone edits the kept contact's title after the merge.
    await db.query(
      `UPDATE contacts SET title = 'Edited after merge', version = version + 1 WHERE id = 'cnt_k'`,
    );
    const undone = await service.undo(admin, String(merge?.id), {}, '127.0.0.1');
    expect(undone.undoneAt).not.toBeNull();
    expect(undone.undoneBy?.id).toBe('usr_admin_1');
    expect(undone.keptFields).toEqual(['Title']);

    expect(
      await one(`SELECT primary_email, title, phone_e164 FROM contacts WHERE id = 'cnt_k'`),
    ).toEqual({
      primary_email: 'morgan@merge-kept.example.com',
      title: 'Edited after merge',
      phone_e164: null,
    });
    expect(await one(`SELECT deleted_at, primary_email FROM contacts WHERE id = 'cnt_m'`)).toEqual({
      deleted_at: null,
      primary_email: 'm.reyes@merge-other.example.com',
    });
    const emails = await db.query<{ contact_id: string; email: string; is_primary: boolean }>(
      `SELECT contact_id, email, is_primary FROM contact_emails WHERE contact_id IN ('cnt_k', 'cnt_m') ORDER BY email`,
    );
    expect(emails.rows).toEqual([
      { contact_id: 'cnt_m', email: 'm.reyes.alt@merge-other.example.com', is_primary: false },
      { contact_id: 'cnt_m', email: 'm.reyes@merge-other.example.com', is_primary: true },
      { contact_id: 'cnt_k', email: 'morgan@merge-kept.example.com', is_primary: true },
    ]);
    expect((await one(`SELECT contact_id FROM tasks WHERE id = 'tsk_m'`))['contact_id']).toBe(
      'cnt_m',
    );
    expect(await one(`SELECT contact_id, entity_id FROM activities WHERE id = 'act_m'`)).toEqual({
      contact_id: 'cnt_m',
      entity_id: 'cnt_m',
    });
    expect((await one(`SELECT entity_id FROM notes WHERE id = 'note_m'`))['entity_id']).toBe(
      'cnt_m',
    );
    expect(
      (await one(`SELECT primary_contact_id FROM deals WHERE id = 'deal_acme_tax'`))[
        'primary_contact_id'
      ],
    ).toBe('cnt_m');
    expect(
      (
        await one<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM entity_tags WHERE entity_id = 'cnt_k'`,
        )
      ).n,
    ).toBe(0);
    const lists = await db.query<{ list_id: string; contact_id: string }>(
      `SELECT list_id, contact_id FROM list_members WHERE contact_id IN ('cnt_k', 'cnt_m') ORDER BY list_id, contact_id`,
    );
    expect(lists.rows).toEqual([
      { list_id: 'lst_ca_express', contact_id: 'cnt_m' },
      { list_id: 'lst_us_ultratax', contact_id: 'cnt_k' },
      { list_id: 'lst_us_ultratax', contact_id: 'cnt_m' },
    ]);
    // The stopped enrollment comes back paused, never straight to sending.
    const enrollments = await db.query<{ id: string; contact_id: string; status: string }>(
      `SELECT id, contact_id, status FROM sequence_enrollments WHERE id LIKE 'enr_%' ORDER BY id`,
    );
    expect(enrollments.rows).toEqual([
      { id: 'enr_k_us', contact_id: 'cnt_k', status: 'active' },
      { id: 'enr_m_ca', contact_id: 'cnt_m', status: 'active' },
      { id: 'enr_m_us', contact_id: 'cnt_m', status: 'paused' },
    ]);
    const pairs = await db.query<{ id: string; status: string; left_entity_id: string }>(
      `SELECT id, status, left_entity_id FROM duplicate_candidates
       WHERE id IN ('dup_km', 'dup_m_jane', 'dup_m_elena') ORDER BY id`,
    );
    expect(pairs.rows).toEqual([
      { id: 'dup_km', status: 'open', left_entity_id: 'cnt_k' },
      { id: 'dup_m_elena', status: 'open', left_entity_id: 'cnt_m' },
      { id: 'dup_m_jane', status: 'open', left_entity_id: 'cnt_m' },
    ]);
    const audit = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'contact.merge_undone' AND entity_id = 'cnt_k'`,
    );
    expect(audit.n).toBe(1);
    await expect(service.undo(admin, String(merge?.id), {}, null)).rejects.toMatchObject({
      code: 'MERGE_ALREADY_UNDONE',
    });
  });

  it('do not contact always wins, and undo never lifts it', async () => {
    await addContact({
      id: 'cnt_dnc_k',
      first: 'Harper',
      last: 'Lane',
      email: 'harper@dnc-kept.example.com',
    });
    await addContact({
      id: 'cnt_dnc_m',
      first: 'Harper',
      last: 'Lane',
      email: 'h.lane@dnc-other.example.com',
      doNotContact: true,
    });
    await db.query(
      `INSERT INTO sequence_enrollments (id, sequence_id, contact_id, email, sender_user_id, status, next_send_at)
       VALUES ('enr_dnc_k', 'seq_us_cpa_trial', 'cnt_dnc_k', 'harper@dnc-kept.example.com', 'usr_mgr_1', 'active', NOW() + INTERVAL '1 hour')`,
    );
    const preview = await service.preview(admin, 'contact', 'cnt_dnc_k', 'cnt_dnc_m');
    expect(preview.notes[0]).toContain('will be marked do not contact');
    const view = await service.merge(
      admin,
      'contact',
      'cnt_dnc_k',
      {
        mergedId: 'cnt_dnc_m',
        keptVersion: await version('contacts', 'cnt_dnc_k'),
        mergedVersion: await version('contacts', 'cnt_dnc_m'),
      },
      null,
    );
    expect(
      (await one(`SELECT do_not_contact FROM contacts WHERE id = 'cnt_dnc_k'`))['do_not_contact'],
    ).toBe(true);
    expect(
      await one(`SELECT status, next_send_at FROM sequence_enrollments WHERE id = 'enr_dnc_k'`),
    ).toEqual({
      status: 'stopped_suppressed',
      next_send_at: null,
    });
    const undone = await service.undo(admin, view.id, {}, null);
    expect(undone.keptFields).toContain('Do not contact');
    expect(
      (await one(`SELECT do_not_contact FROM contacts WHERE id = 'cnt_dnc_k'`))['do_not_contact'],
    ).toBe(true);
    expect(
      (await one(`SELECT status FROM sequence_enrollments WHERE id = 'enr_dnc_k'`))['status'],
    ).toBe('stopped_suppressed');
  });

  it('A5: merging companies moves contacts, deals and activities, is audited and can be undone', async () => {
    await addCompany('cmp_merge_a', 'Lakemont Tax Group', null);
    await addCompany('cmp_merge_b', 'Lakemont Tax Group LLP', 'lakemont-tax.example.com');
    await addContact({
      id: 'cnt_lk',
      first: 'Sasha',
      last: 'Ortiz',
      email: 'sasha@lakemont-tax.example.com',
      companyId: 'cmp_merge_b',
    });
    await db.query(`UPDATE deals SET company_id = 'cmp_merge_b' WHERE id = 'deal_ridgeway_audit'`);
    await db.query(
      `INSERT INTO activities (id, entity_type, entity_id, company_id, activity_type, title, detail, actor_user_id)
       VALUES ('act_lk', 'company', 'cmp_merge_b', 'cmp_merge_b', 'meeting', 'Logged a meeting', 'Intro call.', 'usr_mgr_1')`,
    );
    const contactVersion = await version('contacts', 'cnt_lk');

    const view = await service.merge(
      managerUs,
      'company',
      'cmp_merge_a',
      {
        mergedId: 'cmp_merge_b',
        keptVersion: await version('companies', 'cmp_merge_a'),
        mergedVersion: await version('companies', 'cmp_merge_b'),
      },
      null,
    );
    expect(view.moved).toEqual(
      expect.arrayContaining([
        { label: 'Contacts', count: 1 },
        { label: 'Deals', count: 1 },
        { label: 'Timeline entries', count: 1 },
      ]),
    );
    // The kept company had no website, so it takes the other one's.
    expect(await one(`SELECT domain, website FROM companies WHERE id = 'cmp_merge_a'`)).toEqual({
      domain: 'lakemont-tax.example.com',
      website: 'https://lakemont-tax.example.com',
    });
    expect((await one(`SELECT company_id FROM contacts WHERE id = 'cnt_lk'`))['company_id']).toBe(
      'cmp_merge_a',
    );
    expect(await version('contacts', 'cnt_lk')).toBe(contactVersion + 1);
    expect(
      (await one(`SELECT company_id FROM deals WHERE id = 'deal_ridgeway_audit'`))['company_id'],
    ).toBe('cmp_merge_a');
    expect(await one(`SELECT company_id, entity_id FROM activities WHERE id = 'act_lk'`)).toEqual({
      company_id: 'cmp_merge_a',
      entity_id: 'cmp_merge_a',
    });
    const audit = await one(
      `SELECT actor_user_id FROM audit_logs WHERE action = 'company.merged' AND entity_id = 'cmp_merge_a'`,
    );
    expect(audit['actor_user_id']).toBe('usr_mgr_1');

    const undone = await service.undo(managerUs, view.id, {}, null);
    expect(undone.keptFields).toEqual([]);
    expect(await one(`SELECT domain, deleted_at FROM companies WHERE id = 'cmp_merge_a'`)).toEqual({
      domain: null,
      deleted_at: null,
    });
    expect(await one(`SELECT domain, deleted_at FROM companies WHERE id = 'cmp_merge_b'`)).toEqual({
      domain: 'lakemont-tax.example.com',
      deleted_at: null,
    });
    expect((await one(`SELECT company_id FROM contacts WHERE id = 'cnt_lk'`))['company_id']).toBe(
      'cmp_merge_b',
    );
    expect(
      (await one(`SELECT company_id FROM deals WHERE id = 'deal_ridgeway_audit'`))['company_id'],
    ).toBe('cmp_merge_b');
    expect((await one(`SELECT company_id FROM activities WHERE id = 'act_lk'`))['company_id']).toBe(
      'cmp_merge_b',
    );
  });

  it('refuses a stale version, the same record twice, an expired undo and a clashing email', async () => {
    await addContact({
      id: 'cnt_e1',
      first: 'Jordan',
      last: 'Wells',
      email: 'jordan@refuse-one.example.com',
    });
    await addContact({
      id: 'cnt_e2',
      first: 'Jordan',
      last: 'Wells',
      email: 'j.wells@refuse-two.example.com',
    });
    await expect(
      service.merge(
        admin,
        'contact',
        'cnt_e1',
        { mergedId: 'cnt_e2', keptVersion: 99, mergedVersion: 1 },
        null,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      service.merge(
        admin,
        'contact',
        'cnt_e1',
        { mergedId: 'cnt_e1', keptVersion: 1, mergedVersion: 1 },
        null,
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.merge(
        admin,
        'contact',
        'cnt_e1',
        { mergedId: 'cnt_e2', keptVersion: 1, mergedVersion: 1, take: { color: 'kept' } },
        null,
      ),
    ).rejects.toMatchObject({ status: 422 });

    const first = await service.merge(
      admin,
      'contact',
      'cnt_e1',
      { mergedId: 'cnt_e2', keptVersion: 1, mergedVersion: 1 },
      null,
    );
    // The kept contact later takes the merged contact's address as its own.
    await db.query(
      `UPDATE contacts SET primary_email = 'j.wells@refuse-two.example.com', version = version + 1 WHERE id = 'cnt_e1'`,
    );
    await expect(service.undo(admin, first.id, {}, null)).rejects.toMatchObject({
      code: 'MERGE_UNDO_IN_USE',
    });
    await db.query(`UPDATE merge_logs SET created_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [
      first.id,
    ]);
    await expect(service.undo(admin, first.id, {}, null)).rejects.toMatchObject({
      code: 'MERGE_UNDO_EXPIRED',
    });
  });
});
