import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { SecretBox } from '../platform/crypto/index.js';
import { DatabaseService } from '../platform/db/index.js';

describe('Milestone 9: Accent-folded full-text search across records, notes & email threads (PRD 6.10, 12.2)', () => {
  let db: DatabaseService;
  let apiServer: Server;
  let apiBaseUrl = '';

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();

    // Seed accented US & CA records, notes, and email threads across team_us and team_ca
    await db.exec(`
      INSERT INTO companies (id, name, domain, market, city, state_province, firm_type, owner_user_id, team_id)
      VALUES
        ('cmp_ms9_qc', 'Cabinet Côté & Associés', 'cotecpa.example.ca', 'CA', 'Montréal', 'QC', 'CPA firm', 'usr_bdr_1', 'team_ca'),
        ('cmp_ms9_us', 'Sørensen Tax Practice', 'sorensentax.example.com', 'US', 'Austin', 'TX', 'Tax practice', 'usr_ae_1', 'team_us');

      INSERT INTO contacts (id, company_id, first_name, last_name, full_name, title, job_function, seniority, primary_email, market, timezone, owner_user_id, team_id)
      VALUES
        ('cnt_ms9_qc', 'cmp_ms9_qc', 'François', 'Bélanger', 'François Bélanger', 'Associé Fiscalité', 'Tax', 'Partner', 'f.belanger@cotecpa.example.ca', 'CA', 'America/Toronto', 'usr_bdr_1', 'team_ca'),
        ('cnt_ms9_us', 'cmp_ms9_us', 'Renée', 'Sørensen', 'Renée Sørensen', 'Managing Partner', 'Audit & Assurance', 'Partner', 'renee@sorensentax.example.com', 'US', 'America/Chicago', 'usr_ae_1', 'team_us');

      INSERT INTO notes (id, entity_type, entity_id, body, author_user_id)
      VALUES
        ('note_ms9_us', 'company', 'cmp_ms9_us', 'Client uses UltraTax CS and CaseWare Working Papers for multi-state K-1 prep.', 'usr_ae_1'),
        ('note_ms9_qc', 'contact', 'cnt_ms9_qc', 'Needs bilingual T2 corporate tax staffing pod before March deadline.', 'usr_bdr_1'),
        ('note_ms9_deleted', 'company', 'cmp_ms9_us', 'Obsolete deleted keyword zzzdeletednote999', 'usr_ae_1');

      UPDATE notes SET deleted_at = NOW() WHERE id = 'note_ms9_deleted';

      INSERT INTO email_threads (id, subject, snippet, contact_id, company_id, owner_user_id, team_id)
      VALUES
        ('eth_ms9_us', 'Proposal: Dedicated Audit Readiness Pod', 'Attached FTE rate card for Q1 audit season', 'cnt_ms9_us', 'cmp_ms9_us', 'usr_ae_1', 'team_us'),
        ('eth_ms9_qc', 'Suivi: Essai gratuit fiscalité canadienne', 'Bonjour François, voici le calendrier de votre essai', 'cnt_ms9_qc', 'cmp_ms9_qc', 'usr_bdr_1', 'team_ca');
    `);

    const env = validateEnv({
      NODE_ENV: 'test',
      PUBLIC_WEB_URL: 'http://localhost:5174',
      LOG_LEVEL: 'error',
    });
    const app = createAppServer(env, db, { secretBox: SecretBox.ephemeral() });
    apiServer = app.server;
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    apiBaseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (apiServer) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await db?.close();
  });

  async function loginCookie(userId: string): Promise<string> {
    const res = await fetch(`${apiBaseUrl}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Host: 'crm.adasglobuspro.com',
      },
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(200);
    return (
      (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    );
  }

  async function searchApi(cookie: string, q: string, extended = true) {
    const res = await fetch(
      `${apiBaseUrl}/api/v1/search?q=${encodeURIComponent(q)}${extended ? '&extended=1' : ''}`,
      {
        headers: {
          Cookie: cookie,
          Host: 'crm.adasglobuspro.com',
        },
      },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      companies: { id: string; name: string }[];
      contacts: { id: string; full_name: string }[];
      leads: { id: string }[];
      deals: { id: string }[];
      notes?: { id: string; entity_id: string; snippet: string }[];
      emailThreads?: { id: string; subject: string }[];
    };
  }

  it('folds accents in generated tsvector columns so unaccented queries match Montréal, François, Côté & Sørensen', async () => {
    const adminCookie = await loginCookie('usr_admin_1');

    const montreal = await searchApi(adminCookie, 'Montreal Cote');
    expect(montreal.companies.map((c) => c.id)).toContain('cmp_ms9_qc');

    const francois = await searchApi(adminCookie, 'Francois Belanger');
    expect(francois.contacts.map((c) => c.id)).toContain('cnt_ms9_qc');

    const renee = await searchApi(adminCookie, 'Renee Sorensen');
    expect(renee.contacts.map((c) => c.id)).toContain('cnt_ms9_us');
  });

  it('matches note bodies and email subjects/snippets while strictly enforcing own/team/all SQL scopes and soft-delete', async () => {
    const adminCookie = await loginCookie('usr_admin_1');
    const usManagerCookie = await loginCookie('usr_mgr_1'); // team_us ('team' scope)
    const usAeCookie = await loginCookie('usr_ae_1'); // owns US records ('own' scope)
    const usBdr2Cookie = await loginCookie('usr_bdr_2'); // team_us BDR who does NOT own usr_ae_1's records ('own' scope)

    // 1. Search note body ("CaseWare Multi-State") -> surfaces parent US company + note for Admin, US Manager, and owning AE, NOT for another BDR with 'own' scope
    const adminNoteHit = await searchApi(adminCookie, 'CaseWare UltraTax');
    expect(adminNoteHit.companies.map((c) => c.id)).toContain('cmp_ms9_us');
    expect(adminNoteHit.notes?.map((n) => n.id)).toContain('note_ms9_us');

    const mgrNoteHit = await searchApi(usManagerCookie, 'CaseWare UltraTax');
    expect(mgrNoteHit.companies.map((c) => c.id)).toContain('cmp_ms9_us');
    expect(mgrNoteHit.notes?.map((n) => n.id)).toContain('note_ms9_us');

    const aeNoteHit = await searchApi(usAeCookie, 'CaseWare UltraTax');
    expect(aeNoteHit.companies.map((c) => c.id)).toContain('cmp_ms9_us');
    expect(aeNoteHit.notes?.map((n) => n.id)).toContain('note_ms9_us');

    const otherBdrHit = await searchApi(usBdr2Cookie, 'CaseWare UltraTax');
    expect(otherBdrHit.companies).toEqual([]);
    expect(otherBdrHit.notes).toEqual([]);

    // 2. Canadian note ("bilingual T2 corporate") -> visible to Admin, hidden from US Sales Manager ('team' scope)
    const adminCaNote = await searchApi(adminCookie, 'bilingual T2 corporate');
    expect(adminCaNote.contacts.map((c) => c.id)).toContain('cnt_ms9_qc');
    expect(adminCaNote.notes?.map((n) => n.id)).toContain('note_ms9_qc');

    const usMgrCaNote = await searchApi(usManagerCookie, 'bilingual T2 corporate');
    expect(usMgrCaNote.contacts).toEqual([]);
    expect(usMgrCaNote.notes).toEqual([]);

    // 3. Soft-deleted note is never returned
    const deletedSearch = await searchApi(adminCookie, 'zzzdeletednote999');
    expect(deletedSearch.companies).toEqual([]);
    expect(deletedSearch.notes).toEqual([]);

    // 4. Email thread subject & snippet search ("Audit Readiness rate card" and accented "fiscalite canadienne")
    const adminEmail = await searchApi(adminCookie, 'Audit Readiness rate card');
    expect(adminEmail.companies.map((c) => c.id)).toContain('cmp_ms9_us');
    expect(adminEmail.contacts.map((c) => c.id)).toContain('cnt_ms9_us');
    expect(adminEmail.emailThreads?.map((t) => t.id)).toContain('eth_ms9_us');

    const caEmailFromUsMgr = await searchApi(usManagerCookie, 'fiscalite canadienne');
    expect(caEmailFromUsMgr.contacts).toEqual([]);
    expect(caEmailFromUsMgr.emailThreads).toEqual([]);

    const caEmailFromAdmin = await searchApi(adminCookie, 'fiscalite canadienne');
    expect(caEmailFromAdmin.emailThreads?.map((t) => t.id)).toContain('eth_ms9_qc');
  });
});
