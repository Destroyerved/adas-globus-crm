import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { buildWorker } from '../jobs.js';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { ComplianceService } from '../modules/compliance/index.js';
import { CrmTimelineService } from '../modules/crm/index.js';
import { OutreachService } from '../modules/outreach/index.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { MemoryFileStorage } from '../platform/files/index.js';
import { createLogger } from '../platform/logger/index.js';
import { MailpitTransport } from '../platform/mail-transport/index.js';

describe('Milestone 6: sequences, campaigns, segments, ESP webhooks & stored click redirects (PRD 4.12, 4.13, 5, 8.3–8.7, A15–A20)', () => {
  let db: DatabaseService;
  let auth: AuthAndUsersService;
  let compliance: ComplianceService;
  let timeline: CrmTimelineService;
  let transport: MailpitTransport;
  let outreach: OutreachService;
  let baseUrl = '';
  let closeServer: (() => Promise<void>) | null = null;
  const espSecret = 'whsec_ms6_integration_hmac_secret';

  beforeAll(async () => {
    db = await DatabaseService.forTests();
    auth = new AuthAndUsersService(db, 'test');
    compliance = new ComplianceService(db);
    timeline = new CrmTimelineService(db);
    transport = new MailpitTransport(false, 'test');
    outreach = new OutreachService(db, compliance, transport, {
      nodeEnv: 'test',
      mailLive: false,
      publicHost: 'go.adasglobuspro.com',
      sendingSubdomain: 'mail.adasglobuspro.example.com',
      espWebhookSecret: espSecret,
    });

    const env = validateEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://adas_app:adas_dev_password@localhost:5432/adas_crm?schema=public',
    });
    const app = createAppServer(env, db, {
      files: new MemoryFileStorage(),
      espWebhookSecret: espSecret,
    });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () =>
      new Promise<void>((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve())),
      );
  }, 30_000);

  afterAll(async () => {
    if (closeServer) await closeServer();
    await db.close();
  });

  it('enforces SQL scope on sequences, rejects CA without consent (A16) & duplicate active enrollments (A17), rolls over daily mailbox caps (A18), executes task steps, and stops on meetings', async () => {
    const admin = await auth.resolveSessionUser('usr_admin_1');
    const managerUs = await auth.resolveSessionUser('usr_mgr_1');
    const bdrCa = await auth.resolveSessionUser('usr_bdr_1');

    // SQL scope check (`team` vs `all` on listSequences): US manager sees US team sequences, not CA team sequences
    const mgrSeqs = await outreach.listSequences(managerUs);
    const caSeqs = await outreach.listSequences(bdrCa);
    const allSeqs = await outreach.listSequences(admin);
    expect(mgrSeqs.some((s) => s['id'] === 'seq_us_cpa_trial')).toBe(true);
    expect(mgrSeqs.some((s) => s['id'] === 'seq_ca_cpa_inquiry')).toBe(false);
    expect(caSeqs.some((s) => s['id'] === 'seq_ca_cpa_inquiry')).toBe(true);
    expect(allSeqs.length).toBeGreaterThanOrEqual(mgrSeqs.length + caSeqs.length);

    // Non-admin cannot raise mailbox cap above 50 (PRD 4.12)
    await expect(
      outreach.createSequence(managerUs, {
        name: 'Over-Cap Sequence',
        market: 'US',
        dailyCapPerMailbox: 80,
        steps: [
          {
            stepOrder: 1,
            stepKind: 'email',
            delayBusinessDays: 0,
            subjectTemplate: 'Hello',
            bodyTemplate: 'Body',
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 403, code: 'MAILBOX_CAP_ADMIN_ONLY' });

    // Create a 2-step sequence (Step 1: Email, Step 2: Task) with dailyCapPerMailbox = 1 to test A18 rollover
    const seqRow = await outreach.createSequence(managerUs, {
      name: 'MS6 Cap & Task Sequence',
      market: 'US',
      dailyCapPerMailbox: 1,
      steps: [
        {
          stepOrder: 1,
          stepKind: 'email',
          delayBusinessDays: 0,
          subjectTemplate: 'Quick tax pod question for {{company.name}}',
          bodyTemplate: 'Hi {{contact.first_name}}, open to a 3-day trial?',
        },
        {
          stepOrder: 2,
          stepKind: 'task',
          delayBusinessDays: 1,
          taskType: 'call',
          taskTitle: 'Call {{contact.first_name}} at {{company.name}}',
        },
      ],
    });
    const seqId = String(seqRow['id']);

    // Insert a Canadian contact with NO consent basis to verify A16 in batch enrollment
    await db.query(
      `INSERT INTO contacts (
         id, company_id, first_name, last_name, full_name, title, job_function, seniority,
         primary_email, market, timezone, owner_user_id, team_id, email_verification_status
       ) VALUES (
         'cnt_ca_noconsent', 'cmp_northstar', 'Liam', 'Bouchard', 'Liam Bouchard', 'Partner',
         'Partner / Principal', 'Partner', 'liam.bouchard@northstarcpa.example.ca', 'CA',
         'America/Toronto', 'usr_mgr_1', 'team_us', 'valid'
       )`,
    );
    await db.query(
      `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
       VALUES ('ce_ca_noconsent', 'cnt_ca_noconsent', 'liam.bouchard@northstarcpa.example.ca', TRUE, 'valid')`,
    );

    // Batch enroll: cnt_jane & cnt_david (US -> eligible), cnt_ca_noconsent (CA without basis -> skipped NO_LAWFUL_BASIS, A16)
    const batch = await outreach.batchEnrollInSequence(admin, seqId, {
      contactIds: ['cnt_jane', 'cnt_david', 'cnt_ca_noconsent'],
      senderUserId: 'usr_ae_1',
    });
    expect(batch.enrolled.map((e) => e.contactId)).toEqual(['cnt_jane', 'cnt_david']);
    expect(batch.skipped).toEqual([
      expect.objectContaining({
        contactId: 'cnt_ca_noconsent',
        reasonCode: 'NO_LAWFUL_BASIS',
      }),
    ]);

    // A17: Enrolling cnt_jane into another sequence while active fails with 409 IN_OTHER_ACTIVE_SEQUENCE
    await expect(
      outreach.enrollInSequence(admin, {
        sequenceId: 'seq_us_cpa_trial',
        contactId: 'cnt_jane',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'IN_OTHER_ACTIVE_SEQUENCE' });

    // Force both enrollments due inside Wednesday 10:30 AM US Eastern/Central business window
    const wedMorningUtc = new Date('2026-11-18T16:00:00.000Z');
    await db.query(
      `UPDATE sequence_enrollments SET next_send_at = $2::timestamptz WHERE sequence_id = $1`,
      [seqId, new Date('2026-11-18T15:30:00.000Z').toISOString()],
    );

    // Run `sequence.tick`: dailyCapPerMailbox = 1 -> sends 1st contact, rolls 2nd contact to next business-day window (A18)!
    const tick1 = await outreach.runSequenceTick({ now: wedMorningUtc, jitterMinutes: 0 });
    expect(tick1.checked).toBe(2);
    expect(tick1.sent).toBe(1);
    expect(tick1.rolledToNextWindow).toBe(1);

    const rolledRes = await db.query<{
      id: string;
      contact_id: string;
      last_skip_reason: string | null;
      next_send_at: Date;
    }>(
      `SELECT id, contact_id, last_skip_reason, next_send_at
       FROM sequence_enrollments
       WHERE sequence_id = $1 AND last_skip_reason = 'MAILBOX_DAILY_CAP'`,
      [seqId],
    );
    expect(rolledRes.rows).toHaveLength(1);
    const rolledRow = rolledRes.rows[0];
    if (!rolledRow) throw new Error('Expected rolled enrollment row');
    expect(new Date(rolledRow.next_send_at).toISOString().slice(0, 10)).toBe('2026-11-19');

    // Next business day (Thursday 16:00 UTC): rolled Step 1 sends AND first contact's Step 2 (task step) creates a call task!
    const thuMorningUtc = new Date('2026-11-19T16:30:00.000Z');
    const tick2 = await outreach.runSequenceTick({ now: thuMorningUtc, jitterMinutes: 0 });
    expect(tick2.sent).toBe(1);
    expect(tick2.tasksCreated).toBe(1);

    const seqTasks = await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE id LIKE 'tsk_seq_%'`,
    );
    expect(seqTasks.rows.length).toBeGreaterThanOrEqual(1);

    // Outbox stop condition: logging a meeting on the still-active contact stops their sequence enrollment (`stopped_meeting`)
    const logger = createLogger('silent');
    const worker = buildWorker(db, logger, { files: new MemoryFileStorage(), outreach });
    await timeline.logActivity(admin, {
      activityType: 'meeting',
      entityType: 'contact',
      entityId: rolledRow.contact_id,
      title: 'Discovery scoping meeting booked',
      detail: 'Partner booked Thursday meeting.',
    });
    await worker.outbox.dispatch();

    const stoppedCheck = await db.query<{ status: string }>(
      `SELECT status FROM sequence_enrollments WHERE id = $1`,
      [rolledRow.id],
    );
    expect(stoppedCheck.rows[0]?.status).toBe('stopped_meeting');
  });

  it('runs full campaign workflow: block templates, dynamic segments, preflight, A19 approval, edit-resets-to-draft, hourly throttle, stored /c/:token click redirect, and signed ESP webhook 200-delivery auto-pause (A20)', async () => {
    const bdr = await auth.resolveSessionUser('usr_bdr_1');
    const mkt = await auth.resolveSessionUser('usr_mkt_1');
    const admin = await auth.resolveSessionUser('usr_admin_1');

    // Role scope check: BDR has campaigns.read = none -> 403
    await expect(outreach.listCampaigns(bdr)).rejects.toMatchObject({ status: 403 });

    // Root employee domain is rejected when creating a sender identity (PRD 5.4)
    await expect(
      outreach.createSenderIdentity(admin, {
        fromName: 'Root Domain Attempt',
        fromEmail: 'ananya@adasglobuspro.com',
      }),
    ).rejects.toMatchObject({ status: 422 });

    // Create a dynamic segment filtering US CPA contacts with valid email
    const seg = await outreach.createMarketingList(mkt, {
      name: 'MS6 Verified US CPA Partners',
      listType: 'dynamic',
      market: 'US',
      filterJson: {
        and: [
          { field: 'company.market', op: 'eq', value: 'US' },
          { field: 'email.verificationStatus', op: 'eq', value: 'valid' },
        ],
      },
    });
    const segId = String(seg['id']);
    const segDetail = await outreach.getMarketingListDetail(mkt, segId);
    expect(Number(segDetail['totalCount'])).toBeGreaterThanOrEqual(2);

    // Create a Draft campaign using the structured block editor (heading + text + button)
    const created = await outreach.createCampaign(mkt, {
      name: 'MS6 Tax Season Capacity Briefing',
      subject: 'Dedicated Tax Pods for {{company.name|your firm}}',
      market: 'US',
      listId: segId,
      senderIdentityId: 'snd_mail_subdomain',
      throttlePerHour: 1,
      respectRecipientTimezone: false,
      clickTrackingEnabled: true,
      initialStatus: 'draft',
      blocks: [
        {
          id: 'b1',
          type: 'heading',
          level: 'h1',
          text: 'Tax Pod Capacity for {{company.name|your firm}}',
        },
        {
          id: 'b2',
          type: 'text',
          text: 'Hi {{contact.first_name|there}}, review our 3-day free trial scope.',
        },
        {
          id: 'b3',
          type: 'button',
          label: 'View 3-day trial guide',
          url: 'https://adasglobuspro.example.com/trial-guide',
        },
      ],
    });
    const campaignId = String(created['id']);
    expect(created['status']).toBe('draft');

    // Pre-flight checklist reports verified subdomain sender, postal address, and eligible count
    const preflight = await outreach.getCampaignPreflight(mkt, campaignId);
    expect(preflight.senderVerified).toBe(true);
    expect(preflight.sendingSubdomainOk).toBe(true);
    expect(preflight.eligibleCount).toBeGreaterThanOrEqual(2);
    expect(preflight.readyToApprove).toBe(true);

    // Test send refuses external addresses and succeeds for internal active CRM users
    await expect(
      outreach.testSendCampaign(mkt, campaignId, {
        recipientEmail: 'external.person@outside.example.org',
      }),
    ).rejects.toMatchObject({ status: 422 });

    const testSend = await outreach.testSendCampaign(mkt, campaignId, {
      recipientEmail: mkt.email,
    });
    expect(testSend.sent).toBe(true);

    // Submit -> A19 creator self-approval rejected -> Admin approves -> Editing resets back to Draft -> Re-approve
    const submitted = await outreach.submitCampaignForApproval(mkt, campaignId);
    expect(submitted['status']).toBe('pending_approval');

    await expect(outreach.approveCampaign(mkt, campaignId)).rejects.toMatchObject({
      status: 403,
      code: 'SELF_APPROVAL_NOT_ALLOWED',
    });

    const approved1 = await outreach.approveCampaign(admin, campaignId);
    expect(approved1['status']).toBe('approved');

    // Editing an approved campaign returns it to `draft` (PRD 4.13)
    const edited = await outreach.updateCampaign(mkt, campaignId, {
      version: Number(approved1['version']),
      subject: 'Updated: Dedicated Tax Pods for {{company.name|your firm}}',
    });
    expect(edited['status']).toBe('draft');
    expect(edited['approved_at']).toBeNull();

    await outreach.submitCampaignForApproval(mkt, campaignId);
    await outreach.approveCampaign(admin, campaignId);

    // Start campaign with throttlePerHour = 1: first `campaign.tick` sends 1 message and keeps remaining queued!
    transport.clearSentMessages();
    await outreach.scheduleCampaign(mkt, campaignId, { sendNow: true, throttlePerHour: 1 });

    const t0 = new Date('2026-11-18T17:00:00.000Z');
    const cTick1 = await outreach.runCampaignTick({ now: t0 });
    expect(cTick1.sentMessages).toBe(1);

    const sentBatch = transport.getSentMessages();
    expect(sentBatch).toHaveLength(1);
    const sentMail = sentBatch[0];
    if (!sentMail) throw new Error('Expected sent campaign email in Mailpit');
    expect(sentMail.bodyText).toContain('Sheridan, WY');
    expect(sentMail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Extract the `/c/<token>` click link from the sent email and verify `GET /c/:token` on `go.`!
    const clickMatch = /https:\/\/go\.adasglobuspro\.com\/c\/([A-Za-z0-9_-]+)/.exec(
      sentMail.bodyText,
    );
    expect(clickMatch?.[1]).toBeTruthy();
    const rawClickToken = clickMatch?.[1] ?? '';

    const clickResp = await fetch(`${baseUrl}/c/${rawClickToken}`, {
      headers: { Host: 'go.adasglobuspro.com' },
      redirect: 'manual',
    });
    expect(clickResp.status).toBe(302);
    expect(clickResp.headers.get('location')).toBe('https://adasglobuspro.example.com/trial-guide');

    // Unknown token on `/c/` returns safe 404 HTML, never redirecting to query params!
    const bogusClick = await fetch(
      `${baseUrl}/c/clk_nonexistent_token?url=https://evil.example.org`,
      {
        headers: { Host: 'go.adasglobuspro.com' },
        redirect: 'manual',
      },
    );
    expect(bogusClick.status).toBe(404);
    expect(bogusClick.headers.get('location')).toBeNull();

    // Verify Contact Outreach History endpoint includes the campaign delivery
    const sentRecip = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM campaign_recipients WHERE campaign_id = $1 AND status = 'sent' LIMIT 1`,
      [campaignId],
    );
    const sentContactId = sentRecip.rows[0]?.contact_id;
    if (!sentContactId) throw new Error('Expected sent campaign recipient');
    const history = await outreach.getContactOutreachHistory(admin, sentContactId);
    expect(history.campaigns.some((r) => r['campaign_id'] === campaignId)).toBe(true);
    expect(history.sends.length).toBeGreaterThanOrEqual(1);

    // Public signed ESP webhook on `go.` (`/api/v1/webhooks/esp`) + 200-delivery >3% bounce auto-pause (A20)
    await db.query(
      `UPDATE campaigns SET sent_count = 200, delivered_count = 194, bounced_count = 6 WHERE id = $1`,
      [campaignId],
    );

    const webhookBody = JSON.stringify({
      RecordType: 'Bounce',
      ID: 77401,
      Type: 'HardBounce',
      MessageID: sentMail.providerMessageId,
      Email: sentMail.toEmail,
      Description: '550 5.1.1 Mailbox does not exist',
      BouncedAt: new Date().toISOString(),
    });

    // Missing signature -> 401
    const unauthWebhook = await fetch(`${baseUrl}/api/v1/webhooks/esp`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        'Content-Type': 'application/json',
      },
      body: webhookBody,
    });
    expect(unauthWebhook.status).toBe(401);

    // Valid HMAC-SHA256 signature -> 202 accepted, deduplicated on replay, and campaign auto-paused (7/201 = 3.48% > 3.00%)!
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', espSecret)
      .update(`${ts}.${webhookBody}`, 'utf8')
      .digest('hex');

    const validWebhook = await fetch(`${baseUrl}/api/v1/webhooks/esp`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        'Content-Type': 'application/json',
        'X-ESP-Timestamp': ts,
        'X-ESP-Signature': `sha256=${sig}`,
      },
      body: webhookBody,
    });
    expect(validWebhook.status).toBe(202);
    const whJson = (await validWebhook.json()) as {
      processedEvents: number;
      autoPausedCampaigns: string[];
    };
    expect(whJson.processedEvents).toBe(1);
    expect(whJson.autoPausedCampaigns).toContain(campaignId);

    // Replay of identical webhook event ID is deduplicated without double-counting
    const replayWebhook = await fetch(`${baseUrl}/api/v1/webhooks/esp`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        'Content-Type': 'application/json',
        'X-ESP-Timestamp': ts,
        'X-ESP-Signature': `sha256=${sig}`,
      },
      body: webhookBody,
    });
    const replayJson = (await replayWebhook.json()) as {
      processedEvents: number;
      deduplicatedEvents: number;
    };
    expect(replayJson.processedEvents).toBe(0);
    expect(replayJson.deduplicatedEvents).toBe(1);

    // Owner / Marketing Manager received in-app auto-pause alert
    const alerts = await db.query<{ id: string }>(
      `SELECT id FROM notifications WHERE user_id = 'usr_mkt_1' AND dedupe_key = $1`,
      [`cmpg_autopause:${campaignId}:usr_mkt_1`],
    );
    expect(alerts.rows.length).toBe(1);
  });
});
