import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CreateLeadInputSchema, sanitizeEmailHtml } from '@adas/shared';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { ImportProcessor } from '../modules/imports/index.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { parseListRequest } from '../platform/list/index.js';
import { createLogger } from '../platform/logger/index.js';

/**
 * Milestone 15: Full-Scale 10,000-Row XLSX Import (`A1` + `A2` < 5 Minutes) & Adversarial
 * Security Penetration Suite (`PRD 9`, `PRD 12.1 A1–A21`).
 */

describe('Milestone 15: 10,000-Row XLSX Import Benchmark (A1/A2) & Security Penetration Suite', () => {
  const isRealPostgres = Boolean(process.env['TEST_DATABASE_URL']);
  const secretTmpDir = mkdtempSync(path.join(os.tmpdir(), 'adas-ms15-secrets-'));
  const espSecretPath = path.join(secretTmpDir, 'esp_webhook_secret.txt');
  const bookingsSecretPath = path.join(secretTmpDir, 'bookings_webhook_secret.txt');
  writeFileSync(espSecretPath, 'esp_whsec_ms15_test_secret_value_12345\n', 'utf8');
  writeFileSync(bookingsSecretPath, 'bookings_whsec_ms15_test_secret_12345\n', 'utf8');

  const env = validateEnv({
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL:
      process.env['TEST_DATABASE_URL'] ??
      'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
    SESSION_SECRET: 'ms15-penetration-session-secret-at-least-32-chars',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ESP_WEBHOOK_SECRET_FILE: espSecretPath,
    BOOKINGS_WEBHOOK_SECRET_FILE: bookingsSecretPath,
    APP_INTERNAL_HOST: 'crm.adasglobuspro.com',
    APP_PUBLIC_HOST: 'go.adasglobuspro.com',
    MAIL_LIVE: 'false',
  });

  const db = DatabaseService.forTests();
  const app = createAppServer(env, db);
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await db.ensureInitialized();
    server = app.server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    rmSync(secretTmpDir, { recursive: true, force: true });
  });

  it('penetration suite: neutralizes SQLi/filter injection, XSS in emails, cross-scope IDOR, go. host bypass, open redirects, forged/replayed webhooks, and revoked PATs', async () => {
    const admin = await app.services.auth.resolveSessionUser('usr_admin_1');
    const caBdr = await app.services.auth.resolveSessionUser('usr_bdr_1'); // own scope in CA
    const usAe = await app.services.auth.resolveSessionUser('usr_ae_1'); // own scope in US

    // 1. SQL injection in global search & list filter AST
    const sqliSearch = await app.services.dataQuality.globalSearch(
      admin,
      `' OR 1=1; DROP TABLE audit_logs; --`,
    );
    expect(Array.isArray(sqliSearch.contacts)).toBe(true);

    const auditStillExists = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM audit_logs`,
    );
    expect(Number(auditStillExists.rows[0]?.c ?? 0)).toBeGreaterThanOrEqual(0);

    await expect(
      app.services.lists.list(
        'leads',
        admin,
        parseListRequest(
          new URLSearchParams({
            filter: JSON.stringify({
              field: `custom.evil'); DROP TABLE contacts;--`,
              op: 'eq',
              value: 'x',
            }),
          }),
          '-updatedAt',
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // 2. Stored XSS neutralization in inbound email HTML sanitization
    const maliciousHtml = `<div>Hello CPA<script>window.__pwned=1</script><img src="https://tracker.example/p.gif" onerror="alert(1)" onclick="steal()"></div>`;
    const sanitized = sanitizeEmailHtml(maliciousHtml);
    expect(sanitized.html.toLowerCase()).not.toContain('<script');
    expect(sanitized.html.toLowerCase()).not.toContain('onerror');
    expect(sanitized.html.toLowerCase()).not.toContain('onclick');
    expect(sanitized.hasRemoteImages).toBe(true);

    // 3. Cross-scope Horizontal IDOR: CA BDR (`usr_bdr_1`, own scope) cannot read or edit US AE's lead
    const usLead = await app.services.crm.createLead(
      usAe,
      CreateLeadInputSchema.parse({
        firstName: 'Private',
        lastName: 'Prospect',
        email: 'private.prospect@usfirm-idor.example.com',
        firmName: 'US Firm IDOR LLP',
        market: 'US',
        source: 'Outbound',
      }),
    );
    const createdLeadId = String(usLead['id']);

    await expect(app.services.timeline.leadProfile(caBdr, createdLeadId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      app.services.records.updateLead(caBdr, createdLeadId, {
        version: 1,
        status: 'Contacted',
      }),
    ).rejects.toMatchObject({ status: 404 });

    // 4. Public host `go.adasglobuspro.com` route isolation over real HTTP socket
    // (Node's undici `fetch` strips forbidden `Host` headers, so send over raw `http.request`)
    const port = (server.address() as AddressInfo).port;
    const rawHostRequest = (opts: {
      method?: string;
      path: string;
      hostHeader: string;
      headers?: Record<string, string>;
      body?: string;
    }) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            method: opts.method ?? 'GET',
            path: opts.path,
            headers: {
              Host: opts.hostHeader,
              ...(opts.headers ?? {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
      });

    const goBlockedLeads = await rawHostRequest({
      path: '/api/v1/leads',
      hostHeader: 'go.adasglobuspro.com',
    });
    expect(goBlockedLeads.status).toBe(404);

    const goBlockedDocs = await rawHostRequest({
      path: '/api/docs.json',
      hostHeader: 'go.adasglobuspro.com',
    });
    expect(goBlockedDocs.status).toBe(404);

    const goAllowedHealth = await rawHostRequest({
      path: '/healthz',
      hostHeader: 'go.adasglobuspro.com',
    });
    expect(goAllowedHealth.status).toBe(200);

    // 5. Click redirect `/c/:token` blocks unknown tokens and database CHECK blocks javascript: URLs
    const unknownClick = await rawHostRequest({
      path: '/c/nonexistent_click_token_12345',
      hostHeader: 'go.adasglobuspro.com',
    });
    expect(unknownClick.status).toBe(404);

    await expect(
      db.query(
        `INSERT INTO click_tokens (id, token_sha256, target_url)
         VALUES ('ct_evil_js', '0000000000000000000000000000000000000000000000000000000000000099', 'javascript:alert(1)')`,
      ),
    ).rejects.toThrow();

    // 6. Webhook signature forgery & 5-minute replay rejection on /api/v1/webhooks/esp & /bookings
    const forgedEsp = await rawHostRequest({
      method: 'POST',
      path: '/api/v1/webhooks/esp',
      hostHeader: 'go.adasglobuspro.com',
      headers: {
        'Content-Type': 'application/json',
        'X-ADAS-Signature': 't=1700000000,v1=deadbeef',
      },
      body: JSON.stringify({ eventId: 'evt_forged', type: 'Bounce', email: 'x@example.com' }),
    });
    expect([401, 403]).toContain(forgedEsp.status);

    const staleTs = Math.floor(Date.now() / 1000) - 900; // 15 minutes old (> 5 min window)
    const bookingsPayload = JSON.stringify({
      eventId: 'bk_replay_1',
      customerEmail: 'prospect@example.com',
      startAt: new Date().toISOString(),
    });
    const staleSig = createHmac('sha256', 'bookings_whsec_ms15_test_secret_12345')
      .update(`${staleTs}.${bookingsPayload}`, 'utf8')
      .digest('hex');

    const replayedBookings = await rawHostRequest({
      method: 'POST',
      path: '/api/v1/webhooks/bookings',
      hostHeader: 'go.adasglobuspro.com',
      headers: {
        'Content-Type': 'application/json',
        'X-ADAS-Signature': `t=${staleTs},v1=${staleSig}`,
      },
      body: bookingsPayload,
    });
    expect([401, 403]).toContain(replayedBookings.status);

    // 7. Non-admin cannot mint PATs, and deactivating a PAT's creator immediately revokes Bearer access
    await expect(
      app.services.apiTokens.createToken(
        caBdr,
        { name: 'Unauthorized PAT', capabilities: ['leads.read'], scopeLevel: 'own' },
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({ status: 403 });

    await db.query(
      `INSERT INTO users (id, email, name, role_id, team_id, market_focus, status)
       VALUES ('usr_temp_pat_admin', 'temp.pat.admin@adasglobuspro.example.com', 'Temp Integration Admin', 'role_admin', 'team_us', 'US', 'active')
       ON CONFLICT (id) DO NOTHING`,
    );
    const tempAdmin = await app.services.auth.resolveSessionUser('usr_temp_pat_admin');
    const mintedPat = await app.services.apiTokens.createToken(
      tempAdmin,
      {
        name: 'Scoped Integration Token',
        capabilities: ['leads.read'],
        scopeLevel: 'own',
      },
      '127.0.0.1',
    );

    const activePatAuth = await app.services.apiTokens.authenticateBearer(
      `Bearer ${mintedPat.secretToken}`,
      '127.0.0.1',
    );
    expect(activePatAuth?.user.capabilities['leads.read']).toBe('own');
    expect(activePatAuth?.user.capabilities['deals.write']).toBe('none');

    // Disable creator -> Bearer PAT must immediately throw 401!
    await app.services.admin.updateUser(
      admin,
      'usr_temp_pat_admin',
      { version: 1, status: 'disabled' },
      '127.0.0.1',
    );
    await expect(
      app.services.apiTokens.authenticateBearer(`Bearer ${mintedPat.secretToken}`, '127.0.0.1'),
    ).rejects.toMatchObject({ status: 401 });
  }, 60_000);

  it.skipIf(!isRealPostgres)(
    'A1 & A2 benchmark on PostgreSQL 17: imports a 10,000-row XLSX workbook (500 existing duplicates + 50 internal duplicates + 9,450 new contacts) in under 5 minutes while concurrent reads stay fast',
    async () => {
      const admin = await app.services.auth.resolveSessionUser('usr_admin_1');
      const logger = createLogger('fatal');

      // 1. Seed 500 existing contacts cleanly with blank titles so fill_blanks updates all 500
      await db.query(
        `INSERT INTO contacts (
           id, first_name, last_name, full_name, title, job_function, seniority,
           primary_email, market, timezone, owner_user_id, team_id, source
         )
         SELECT
           'cnt_a1_exist_' || g,
           'Existing' || g,
           'Partner' || g,
           'Existing' || g || ' Partner' || g,
           '',
           '',
           '',
           'existing' || g || '@cpa-a1-bench.example.com',
           'US',
           'America/New_York',
           'usr_ae_1',
           'team_us',
           'Seed'
         FROM generate_series(1, 500) AS g`,
      );
      await db.query(
        `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
         SELECT
           'ce_a1_exist_' || g,
           'cnt_a1_exist_' || g,
           'existing' || g || '@cpa-a1-bench.example.com',
           TRUE,
           'valid'
         FROM generate_series(1, 500) AS g
         ON CONFLICT (email) DO NOTHING`,
      );

      // 2. Build a real 10,000-data-row XLSX workbook (500 existing + 9,450 new + 50 in-file duplicates)
      const tStart = performance.now();
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Contacts10k');
      sheet.addRow(['Email', 'First Name', 'Last Name', 'Title', 'Country']);

      for (let i = 1; i <= 500; i += 1) {
        sheet.addRow([
          `existing${i}@cpa-a1-bench.example.com`,
          `Existing${i}`,
          `Partner${i}`,
          'Tax Director',
          'US',
        ]);
      }

      for (let i = 1; i <= 9_450; i += 1) {
        sheet.addRow([
          `prospect.${i}@firm-${(i % 400) + 1}.example.com`,
          `First${i}`,
          `Last${i}`,
          'Managing Partner',
          i % 4 === 0 ? 'CA' : 'US',
        ]);
      }

      for (let i = 1; i <= 50; i += 1) {
        sheet.addRow([
          `prospect.${i}@firm-${(i % 400) + 1}.example.com`,
          `Duplicate${i}`,
          `Row${i}`,
          'Associate',
          'US',
        ]);
      }

      const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

      // 3. Upload & map through ImportService
      const { batch } = await app.services.imports.upload(
        admin,
        'a1-10000-contacts.xlsx',
        xlsxBuffer,
        '127.0.0.1',
      );
      expect(batch.rowCount).toBe(10_000);

      const mapped = await app.services.imports.setMapping(admin, batch.id, {
        entity: 'contact',
        version: batch.version,
        mapping: {
          Email: 'email',
          'First Name': 'firstName',
          'Last Name': 'lastName',
          Title: 'title',
          Country: 'market',
        },
        options: {
          source: 'Import',
          ownerUserId: 'usr_ae_1',
          duplicatePolicy: 'fill_blanks',
        },
      });

      const processor = new ImportProcessor(
        db,
        app.files,
        (id) => app.services.auth.resolveSessionUser(id),
        logger,
        { chunkSize: 500, budgetMs: 30_000 },
      );

      // Step A: Run required dry-run preview over all 10,000 rows
      await app.services.imports.requestDryRun(admin, mapped.id, { version: mapped.version });
      for (let step = 0; step < 50; step += 1) {
        const r = await processor.processNext();
        if (r.batches === 0) break;
      }
      const checked = await app.services.imports.get(admin, batch.id);
      expect(checked.status).toBe('checked');
      expect(checked.dryRunCounts).toMatchObject({
        created: 9_450,
        updated: 500,
        skipped: 0,
        duplicate: 50,
        error: 0,
        probable: 0,
      });

      // Step B: Run live background import over all 10,000 rows while measuring concurrent HTTP reads
      const runStart = performance.now();
      await app.services.imports.requestRun(
        admin,
        checked.id,
        { version: checked.version },
        '127.0.0.1',
      );

      const concurrentReadLatenciesMs: number[] = [];
      for (let step = 0; step < 50; step += 1) {
        const readStart = performance.now();
        const [, res] = await Promise.all([
          processor.processNext(),
          fetch(`${baseUrl}/healthz`).then(async (r) => {
            concurrentReadLatenciesMs.push(performance.now() - readStart);
            return r.status;
          }),
        ]);
        expect(res).toBe(200);

        const current = await app.services.imports.get(admin, batch.id);
        if (current.status === 'completed' || current.status === 'failed') {
          break;
        }
      }

      const runElapsedMs = performance.now() - runStart;
      const totalElapsedMs = performance.now() - tStart;
      const finished = await app.services.imports.get(admin, batch.id);

      expect(finished.status).toBe('completed');
      expect(finished.processedRows).toBe(10_000);
      expect(finished.counts).toMatchObject({
        created: 9_450,
        updated: 500,
        skipped: 0,
        duplicate: 50,
        error: 0,
        probable: 0,
        companiesCreated: 0,
      });

      // PRD 12.1 A1 budget: must finish in strictly under 5 minutes (300,000 ms)
      expect(runElapsedMs).toBeLessThan(300_000);
      expect(totalElapsedMs).toBeLessThan(300_000);

      const maxReadLatency = Math.max(...concurrentReadLatenciesMs);
      expect(maxReadLatency).toBeLessThan(1_000);

      console.info(
        `[MS15 A1/A2 Benchmark] Imported 10,000 XLSX rows on PostgreSQL 17: run=${(
          runElapsedMs / 1000
        ).toFixed(2)}s, dryRun+run=${(totalElapsedMs / 1000).toFixed(
          2,
        )}s (max concurrent /healthz latency: ${maxReadLatency.toFixed(1)} ms)`,
      );
    },
    300_000,
  );
});
