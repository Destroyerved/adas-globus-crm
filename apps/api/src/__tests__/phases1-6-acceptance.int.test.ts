import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

describe('Phases 1–6 PostgreSQL 17 Integration & Acceptance Suite (PRD §12.1 A1–A20)', () => {
  const env = validateEnv({
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    MAIL_LIVE: 'false',
  });

  const app = createAppServer(env, DatabaseService.forTests());
  const { db, services, transport } = app;

  beforeAll(async () => {
    await db.ensureInitialized();
  });

  afterAll(async () => {
    await db.close();
  });

  // -------------------------------------------------------------------------
  // Phase 1: Auth, Scopes (own/team/all), Host Routing & Append-Only Grants
  // -------------------------------------------------------------------------

  it('Phase 1: enforces invite-only Entra OIDC, break-glass TOTP login, CSRF & host routing (PRD §3.1, §6.1, §9)', async () => {
    // Uninvited user is rejected with 403 USER_NOT_INVITED
    await expect(
      services.auth.signInWithEntraOidc('stranger@external.example.com'),
    ).rejects.toMatchObject({
      status: 403,
      code: 'USER_NOT_INVITED',
    });

    // Invited user succeeds and writes audit_logs
    const oidcSession = await services.auth.signInWithEntraOidc('arjun@adasglobuspro.example.com');
    expect(oidcSession.user.role).toBe('Sales Manager');
    expect(oidcSession.sessionId).toMatch(/^ses_/);

    // Break-glass admin login requires valid password + 6-digit TOTP
    await expect(
      services.auth.signInBreakGlass({
        email: 'ved@adasglobuspro.example.com',
        password: 'correct-horse-battery-staple',
        totpCode: '000000',
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_BREAK_GLASS_CREDENTIALS',
    });

    const bgSession = await services.auth.signInBreakGlass({
      email: 'ved@adasglobuspro.example.com',
      password: 'correct-horse-battery-staple',
      totpCode: '123456',
    });
    expect(bgSession.user.role).toBe('Admin');

    // Host routing: go.* allows /u/* and /api/v1/public/*, blocks /api/v1/deals
    expect(
      services.auth.verifyHostRouteAccess('go.adasglobuspro.com', '/u/token_123').allowed,
    ).toBe(true);
    expect(
      services.auth.verifyHostRouteAccess('go.adasglobuspro.com', '/api/v1/public/inquiries')
        .allowed,
    ).toBe(true);
    expect(
      services.auth.verifyHostRouteAccess('go.adasglobuspro.com', '/api/v1/deals').allowed,
    ).toBe(false);
    expect(
      services.auth.verifyHostRouteAccess('crm.adasglobuspro.com', '/api/v1/deals').allowed,
    ).toBe(true);

    // CSRF Origin verification
    expect(
      services.auth.verifyCsrfOrigin('https://crm.adasglobuspro.com', [
        'https://crm.adasglobuspro.com',
      ]),
    ).toBe(true);
    expect(
      services.auth.verifyCsrfOrigin('https://evil.example.com', ['https://crm.adasglobuspro.com']),
    ).toBe(false);
  });

  it('Phase 1: enforces own, team, and all scopes in SQL across Leads, Companies, and Deals (PRD §3.3)', async () => {
    const admin = await services.auth.resolveSessionUser('usr_admin_1'); // all scope
    const usManager = await services.auth.resolveSessionUser('usr_mgr_1'); // team_us scope
    const caBdr = await services.auth.resolveSessionUser('usr_bdr_1'); // own scope (usr_bdr_1)

    const [adminLeads, managerLeads, bdrLeads] = await Promise.all([
      services.crm.listLeads(admin),
      services.crm.listLeads(usManager),
      services.crm.listLeads(caBdr),
    ]);

    expect(adminLeads.length).toBeGreaterThanOrEqual(4);
    // US Manager sees only team_us leads
    expect(managerLeads.every((l) => l['team_id'] === 'team_us')).toBe(true);
    // CA BDR sees only their own leads (usr_bdr_1)
    expect(bdrLeads.every((l) => l['owner_user_id'] === 'usr_bdr_1')).toBe(true);
    expect(adminLeads.length).toBeGreaterThan(bdrLeads.length);
  });

  it('Phase 1 & Database Rule: rejects UPDATE/DELETE on audit_logs and DELETE on suppressions in PostgreSQL (PRD §5.3, §7.4, §9)', async () => {
    const admin = await services.auth.resolveSessionUser('usr_admin_1');
    await services.auth.changeUserRole(admin, 'usr_bdr_2', 'role_bdr');

    // Attempt to UPDATE audit_logs must fail at PostgreSQL level
    await expect(db.query(`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(
      /audit_logs is append-only/i,
    );

    // Attempt to DELETE FROM audit_logs must fail at PostgreSQL level
    await expect(db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/audit_logs is append-only/i);

    // Add a suppression and verify DELETE FROM suppressions fails at PostgreSQL level
    await services.compliance.addSuppression({
      email: 'immutable-check@example.com',
      reason: 'manual_dnc',
      source: 'test',
      actorUserId: admin.id,
    });

    await expect(
      db.query(`DELETE FROM suppressions WHERE email = 'immutable-check@example.com'`),
    ).rejects.toThrow(/suppressions cannot be deleted/i);
  });

  // -------------------------------------------------------------------------
  // Phase 2: Core Records, Intake, Imports, Duplicates, Suppressions & Privacy
  // -------------------------------------------------------------------------

  it('A1 & A2: Website inquiry endpoint creates Lead, Company, Contact, Consent, and one-business-day reply task; deduplicates repeat in 24h; skips company on gmail.com (PRD §4.10)', async () => {
    // A1: Corporate trial form submission
    const first = await services.intake.handlePublicInquiry({
      name: 'bourbon partner',
      firstName: 'claire',
      lastName: 'bennett',
      email: 'Claire.Bennett@BennettTaxCPA.example.com',
      phone: '(312) 555-0199',
      firm: 'Bennett Tax & Audit CPA',
      website: 'https://www.BennettTaxCPA.example.com/services',
      country: 'US',
      formType: 'trial',
      services: ['Tax Preparation'],
      software: ['UltraTax CS'],
    });

    expect(first.accepted).toBe(true);
    expect(first.deduplicated).toBe(false);
    expect(first.leadId).toMatch(/^lead_/);
    expect(first.companyId).toMatch(/^cmp_/);
    expect(first.contactId).toMatch(/^cnt_/);
    expect(first.slaTaskId).toMatch(/^tsk_sla_/);

    // Repeat submission within 24 hours updates existing open lead instead of duplicating
    const repeat = await services.intake.handlePublicInquiry({
      firstName: 'Claire',
      lastName: 'Bennett',
      email: 'claire.bennett@bennetttaxcpa.example.com',
      firm: 'Bennett Tax & Audit CPA',
      country: 'US',
      formType: 'trial',
      message: 'Adding 1 more FTE to trial request',
    });

    expect(repeat.accepted).toBe(true);
    expect(repeat.deduplicated).toBe(true);
    expect(repeat.leadId).toBe(first.leadId);

    // Honeypot bot submission is silently dropped
    const bot = await services.intake.handlePublicInquiry({
      email: 'spam@bot.example.com',
      formType: 'contact',
      company_website_hp: 'http://spam-link.example.com',
    });
    expect(bot.honeypotDropped).toBe(true);
    expect(bot.leadId).toBeNull();

    // A2: Free-mail (gmail.com) inquiry creates Contact + Lead with companyId = null
    const freeMail = await services.intake.handlePublicInquiry({
      firstName: 'Solo',
      lastName: 'Practitioner',
      email: 'solo.cpa.practitioner@gmail.com',
      country: 'CA',
      formType: 'consultation',
    });
    expect(freeMail.accepted).toBe(true);
    expect(freeMail.companyId).toBeNull();
    expect(freeMail.contactId).toMatch(/^cnt_/);
  });

  it('A13: accepts the live website form payloads exactly as adasglobuspro.com sends them (PRD §4.10)', async () => {
    // Homepage trial form: name, email, firm, phone, need, country (full name), software, message
    const trial = await services.intake.handlePublicInquiry({
      name: 'Tara Trial',
      email: 'tara@trialform.example.ca',
      firm: 'Trial Form CPA',
      phone: '+1 416 555 0100',
      need: 'Tax preparation and review',
      country: 'Canada',
      software: 'TaxCycle, CaseWare',
      message: 'Busy season help',
    } as never);
    const trialLead = await db.query<{
      market: string;
      source: string;
      services_needed: string[];
      software_stack: string[];
    }>(`SELECT market, source, services_needed, software_stack FROM leads WHERE id = $1`, [
      trial.leadId,
    ]);
    expect(trialLead.rows[0]).toMatchObject({
      market: 'CA',
      source: 'Website: trial form',
      services_needed: ['Tax preparation and review'],
      software_stack: ['TaxCycle', 'CaseWare'],
    });
    const consent = await db.query<{ basis: string }>(
      `SELECT basis FROM consent_records WHERE contact_id = $1`,
      [trial.contactId],
    );
    expect(consent.rows[0]?.basis).toBe('implied_inquiry');

    // Contact form: location, interests (comma-separated), and an empty `website` honeypot
    const contact = await services.intake.handlePublicInquiry({
      name: 'Cara Contact',
      email: 'cara@contactform.example.com',
      firm: 'Contact Form CPA',
      phone: '',
      location: 'Ontario',
      interests: 'Audit support, A dedicated team',
      message: 'Hello',
      website: '',
    } as never);
    const contactLead = await db.query<{
      market: string;
      source: string;
      state_province: string;
      services_needed: string[];
    }>(`SELECT market, source, state_province, services_needed FROM leads WHERE id = $1`, [
      contact.leadId,
    ]);
    expect(contactLead.rows[0]).toMatchObject({
      market: 'CA',
      source: 'Website: contact form',
      state_province: 'Ontario',
      services_needed: ['Audit support', 'A dedicated team'],
    });

    // A bot that fills the contact form's hidden `website` field is dropped
    const bot = await services.intake.handlePublicInquiry({
      name: 'Bot',
      email: 'bot@spamform.example.com',
      location: 'Texas',
      interests: 'x',
      website: 'http://spam.example.com',
    } as never);
    expect(bot.honeypotDropped).toBe(true);
    expect(bot.leadId).toBeNull();
  });

  it('refuses a second open lead for the same email (PRD §3.1)', async () => {
    const manager = await services.auth.resolveSessionUser('usr_mgr_1');
    await services.crm.createLead(manager, {
      firstName: 'Una',
      lastName: 'Once',
      email: 'una.once@onelead.example.com',
      market: 'US',
    } as never);
    await expect(
      services.crm.createLead(manager, {
        firstName: 'Una',
        lastName: 'Twice',
        email: 'UNA.ONCE@onelead.example.com',
        market: 'US',
      } as never),
    ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_OPEN_LEAD' });
  });

  it('A3 & A4: Company domain normalization deduplicates existing firm, and stale version throws 409 Conflict (PRD §4.3, §6.5)', async () => {
    const manager = await services.auth.resolveSessionUser('usr_mgr_1');

    // A3: www.AcmeTax.example.com/about resolves to existing cmp_acme ('acmetax.example.com')
    const dupCheck = await services.crm.createOrFindCompany(manager, {
      name: 'Acme Tax Duplicate Attempt',
      websiteOrDomain: 'https://www.AcmeTax.example.com/about-us:8443',
      firmType: 'CPA firm',
      market: 'US',
      timezone: 'America/Chicago',
      staffBand: '21–50',
      accountStatus: 'prospect',
      accountingSoftware: [],
      servicesNeeded: [],
      estimatedRevenueMinor: '0',
      currency: 'USD',
    });
    expect(dupCheck.created).toBe(false);
    expect(dupCheck.company['id']).toBe('cmp_acme');

    // A4: Optimistic concurrency check on updateCompany
    const updated = await services.crm.updateCompany(manager, 'cmp_acme', {
      version: 1,
      staffBand: '51–100',
    });
    expect(updated['version']).toBe(2);
    expect(updated['staff_band']).toBe('51–100');

    // Stale version = 1 now throws 409 VERSION_CONFLICT
    await expect(
      services.crm.updateCompany(manager, 'cmp_acme', {
        version: 1,
        staffBand: '100+',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
    });

    // Verify record_history was written
    const historyRes = await db.query(
      `SELECT * FROM record_history WHERE entity_type = 'company' AND entity_id = 'cmp_acme' AND field_name = 'staff_band'`,
    );
    expect(historyRes.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('A5 & A13: CSV import dry-run previews counts, live run creates contacts, suppression always wins, and rollback soft-deletes created rows (PRD §4.9, §5.3)', async () => {
    const admin = await services.auth.resolveSessionUser('usr_admin_1');

    // Add a suppressed address first (A13)
    await services.compliance.addSuppression({
      email: 'opted-out@cpa-import.example.com',
      reason: 'unsubscribe',
      source: 'test_a13',
      actorUserId: admin.id,
    });

    const importRows = [
      {
        firstName: 'New',
        lastName: 'PartnerOne',
        email: 'partner1@newfirm1.example.com',
        firmName: 'New Firm One CPA',
        website: 'https://newfirm1.example.com',
        market: 'US' as const,
        source: 'CSV Import',
        legacyNoConsent: false,
      },
      {
        firstName: 'DuplicateInFile',
        lastName: 'PartnerOne',
        email: 'PARTNER1@newfirm1.example.com',
        firmName: 'New Firm One CPA',
        market: 'US' as const,
        source: 'CSV Import',
        legacyNoConsent: false,
      },
      {
        firstName: 'Opted',
        lastName: 'Out',
        email: 'opted-out@cpa-import.example.com',
        firmName: 'Suppressed CPA',
        market: 'US' as const,
        source: 'CSV Import',
        legacyNoConsent: false,
      },
      {
        firstName: 'Broken',
        lastName: 'Email',
        email: 'not-an-email',
        market: 'US' as const,
        source: 'CSV Import',
        legacyNoConsent: false,
      },
    ];

    // 1. Dry-run preview
    const dryRun = await services.dataQuality.runCsvImport(admin, {
      fileName: 'cpa-prospects.csv',
      dryRun: true,
      duplicatePolicy: 'update_blank',
      rows: importRows,
    });

    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.createdCount).toBe(1);
    expect(dryRun.skippedDuplicateCount).toBe(1);
    expect(dryRun.skippedSuppressedCount).toBe(1);
    expect(dryRun.errorCount).toBe(1);

    // 2. Live execution
    const liveRun = await services.dataQuality.runCsvImport(admin, {
      fileName: 'cpa-prospects.csv',
      dryRun: false,
      duplicatePolicy: 'update_blank',
      rows: importRows,
    });

    expect(liveRun.dryRun).toBe(false);
    expect(liveRun.createdCount).toBe(1);
    expect(liveRun.createdEntityIds.length).toBe(1);

    // Verify suppressed email is STILL not sendable after import (A13)
    const sendableAfterImport = await services.compliance.evaluateRecipientSendability({
      email: 'opted-out@cpa-import.example.com',
      channel: 'sequence',
    });
    expect(sendableAfterImport.sendable).toBe(false);
    expect(sendableAfterImport.reasonCode).toBe('SUPPRESSED_EMAIL');

    // 3. Rollback import job
    const rollback = await services.dataQuality.rollbackImportJob(admin, liveRun.id);
    expect(rollback.rolledBack).toBe(true);
    expect(rollback.affectedCount).toBe(1);
  });

  it('A6: Contact merge moves secondary emails, deals, tasks, and sequence enrollments to survivor and supports undo (PRD §4.8)', async () => {
    const admin = await services.auth.resolveSessionUser('usr_admin_1');

    const survivor = await services.crm.createContact(admin, {
      companyId: 'cmp_acme',
      firstName: 'survivor',
      lastName: 'partner',
      title: 'Managing Partner',
      jobFunction: 'Partner / Principal',
      seniority: 'Partner',
      primaryEmail: 'survivor.merge@acmetax.example.com',
      secondaryEmails: [],
      market: 'US',
      timezone: 'America/Chicago',
      doNotContact: false,
    });

    const duplicate = await services.crm.createContact(admin, {
      companyId: 'cmp_acme',
      firstName: 'duplicate',
      lastName: 'partner',
      title: 'Partner',
      jobFunction: 'Partner / Principal',
      seniority: 'Partner',
      primaryEmail: 'duplicate.merge@acmetax.example.com',
      secondaryEmails: ['alt.merge@acmetax.example.com'],
      market: 'US',
      timezone: 'America/Chicago',
      doNotContact: false,
    });

    const survivorId = String(survivor['id']);
    const duplicateId = String(duplicate['id']);

    const merged = await services.dataQuality.mergeContacts(admin, {
      survivorContactId: survivorId,
      duplicateContactId: duplicateId,
    });

    expect(merged.survivorContactId).toBe(survivorId);
    expect(merged.secondaryEmailsCount).toBeGreaterThanOrEqual(3);

    // Undo the merge and verify duplicate contact is restored
    const undone = await services.dataQuality.undoContactMerge(admin, merged.mergeLogId);
    expect(undone.undone).toBe(true);
    expect(undone.restoredContactId).toBe(duplicateId);
  });

  // -------------------------------------------------------------------------
  // Phase 3: Lead Conversion, Deals, Free Trial Tasks, FX Rollup & Bigin
  // -------------------------------------------------------------------------

  it('A7 & A8: Lead conversion with Free Trial creates Company, Contact, Deal, and 3-Day check-in tasks; Deal Lost requires lostReason; Deal Won emits deal.won (PRD §4.2, §4.5)', async () => {
    const manager = await services.auth.resolveSessionUser('usr_mgr_1');

    const lead = await services.crm.createLead(manager, {
      firstName: 'Evelyn',
      lastName: 'Harper',
      email: 'eharper@harpercpa.example.com',
      firmName: 'Harper & Associates CPA',
      website: 'https://harpercpa.example.com',
      title: 'Managing Partner',
      market: 'US',
      staffBand: '21–50',
      source: 'Website: 3-day trial form',
      status: 'Qualified',
      servicesNeeded: ['Tax Preparation'],
      softwareStack: ['UltraTax CS'],
    });

    // A7: Convert lead with startFreeTrial = true
    const converted = await services.crm.convertLead(manager, {
      leadId: String(lead['id']),
      createDeal: true,
      monthlyValueMinor: '720000',
      currency: 'USD',
      fteCount: 2,
      engagementModel: 'Trial-first',
      startFreeTrial: true,
      services: ['Tax Preparation'],
    });

    expect(converted.companyId).toMatch(/^cmp_/);
    expect(converted.contactId).toMatch(/^cnt_/);
    expect(converted.dealId).toMatch(/^deal_/);
    expect(converted.trialTaskIds).toHaveLength(3);

    const dealId = String(converted.dealId);

    // A8: Moving Deal to Lost without lostReason fails with 422 VALIDATION_FAILED
    await expect(
      services.crm.moveDealStage(manager, dealId, {
        stageName: 'Lost',
        version: 1,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
    });

    // Moving Deal to Won sets won_at and emits deal.won outbox event
    const wonDeal = await services.crm.moveDealStage(manager, dealId, {
      stageName: 'Won',
      version: 1,
      contractStartDate: '2026-12-01',
    });
    expect(wonDeal['stage_category']).toBe('won');
    expect(wonDeal['won_at']).toBeTruthy();
  });

  it('A9: Multi-currency pipeline rollup converts CAD deals to USD in integer minor units (PRD §4.15, §14)', async () => {
    const admin = await services.auth.resolveSessionUser('usr_admin_1');
    const report = await services.intelligence.getPipelineRollupReport(admin, 'USD');

    expect(report.reportingCurrency).toBe('USD');
    expect(report.openDealsCount).toBeGreaterThanOrEqual(3);
    expect(report.wonDealsCount).toBeGreaterThanOrEqual(2);
    expect(BigInt(report.totalOpenMonthlyMinor)).toBeGreaterThan(1_000_000n);
    // CA market open deals (CAD 620,000 minor * 0.74 = USD 458,800 minor)
    expect(report.byMarket['CA']?.openMonthlyMinorInReportingCurrency).toBe('458800');
  });

  // -------------------------------------------------------------------------
  // Phase 4, 5a, 5b: Inbox, Sequences, Unsubscribe, Privacy, Campaigns
  // -------------------------------------------------------------------------

  it('A10 & A11: Inbox sync links known contact emails, ignores unknown senders, and sends replies via Mailpit (PRD §4.11, §8.7)', async () => {
    const manager = await services.auth.resolveSessionUser('usr_mgr_1');

    // Unknown sender is ignored (privacy rule A10)
    const ignored = await services.outreach.syncMailboxMessage({
      providerMessageId: 'graph_unknown_001',
      direction: 'inbound',
      fromEmail: 'personal.newsletter@unrelated.example.org',
      toEmails: ['arjun@adasglobuspro.example.com'],
      subject: 'Unrelated personal email',
      bodyText: 'Should never enter CRM',
    });
    expect(ignored.synced).toBe(false);
    expect(ignored.reason).toBe('unknown_participant_ignored');

    // Known contact email is synced to thread
    const synced = await services.outreach.syncMailboxMessage({
      providerMessageId: 'graph_known_002',
      direction: 'inbound',
      fromEmail: 'jane.patel@acmetax.example.com',
      toEmails: ['arjun@adasglobuspro.example.com'],
      subject: 'Question on UltraTax workflow',
      bodyText: 'Can your preparers access UltraTax via Citrix?',
    });
    expect(synced.synced).toBe(true);
    expect(synced.threadId).toBeTruthy();

    // A11: Sending reply from Inbox uses MailpitTransport
    const beforeCount = transport.getSentMessages().length;
    const reply = await services.outreach.sendInboxReply(manager, {
      contactId: 'cnt_jane',
      subject: 'Re: Question on UltraTax workflow',
      bodyText: 'Yes, our tax preparers work inside your Citrix or RDS environment.',
    });
    expect(reply.sent).toBe(true);
    expect(transport.getSentMessages().length).toBe(beforeCount + 1);
  });

  it('A15, A16, A17, A18: Sequence enrollment, send.message gate, inbound reply auto-stop, hard bounce suppression, and RFC 8058 one-click unsubscribe (PRD §4.12, §5.4)', async () => {
    const manager = await services.auth.resolveSessionUser('usr_mgr_1');

    // Enroll Elena (cnt_elena) in US CPA sequence
    const enrollment = await services.outreach.enrollInSequence(manager, {
      sequenceId: 'seq_us_cpa_trial',
      contactId: 'cnt_elena',
    });
    expect(enrollment.status).toBe('active');

    // A18: Execute Step 1 via send.message job
    const step1Send = await services.outreach.executeSequenceEnrollmentStep(
      enrollment.enrollmentId,
      { bypassSendWindow: true },
    );
    expect(step1Send.sent).toBe(true);
    expect(step1Send.messageSendId).toMatch(/^msnd_/);

    // Idempotent replay of the exact same step returns deduplicated = true without double-sending
    const replay = await services.outreach.executeSendMessageJob({
      idempotencyKey: `seq_${enrollment.enrollmentId}_step_1`,
      channel: 'sequence',
      recipientEmail: 'elena@ridgewaycpa.example.com',
      contactId: 'cnt_elena',
      senderUserId: manager.id,
      sequenceEnrollmentId: enrollment.enrollmentId,
      subject: 'Replay test',
      bodyText: 'Replay test',
      bypassSendWindow: true,
    });
    expect(replay.deduplicated).toBe(true);
    expect(replay.messageSendId).toBe(step1Send.messageSendId);

    // A15: Inbound reply from Elena stops her active sequence enrollment (`status = 'replied'`) and creates a follow-up task
    const replySync = await services.outreach.syncMailboxMessage({
      providerMessageId: 'graph_elena_reply_1',
      direction: 'inbound',
      fromEmail: 'elena@ridgewaycpa.example.com',
      toEmails: ['arjun@adasglobuspro.example.com'],
      subject: 'Re: 3-day risk-free tax pod trial for Ridgeway CPA Group',
      bodyText: 'Let us schedule a quick call Thursday afternoon.',
    });
    expect(replySync.stoppedSequenceEnrollments).toBe(1);
    expect(replySync.followUpTaskId).toMatch(/^tsk_reply_/);

    // A16: Hard bounce on a second enrollment marks it bounced and suppresses future sends
    const bdrCa = await services.auth.resolveSessionUser('usr_bdr_1');
    const caEnroll = await services.outreach.enrollInSequence(bdrCa, {
      sequenceId: 'seq_ca_cpa_inquiry',
      contactId: 'cnt_sophie',
    });
    const bounceRes = await services.outreach.handleHardBounce(
      'stremblay@laurentian-cpa.example.ca',
    );
    expect(bounceRes.suppressed).toBe(true);
    expect(bounceRes.stoppedEnrollments).toBe(1);

    const checkBounced = await services.outreach.executeSequenceEnrollmentStep(
      caEnroll.enrollmentId,
      { bypassSendWindow: true },
    );
    expect(checkBounced.sent).toBe(false);
    expect(checkBounced.reasonCode).toBe('SUPPRESSED_EMAIL');

    // A17: Public one-click unsubscribe token (without login) immediately suppresses and stops sequences
    const unsubToken = await services.compliance.createUnsubscribeToken({
      email: 'm.vance@northstarcpa.example.ca',
      contactId: 'cnt_marcus',
    });
    const unsubResult = await services.compliance.handleUnsubscribeToken(unsubToken);
    expect(unsubResult.unsubscribed).toBe(true);

    const checkUnsubbed = await services.compliance.evaluateRecipientSendability({
      email: 'm.vance@northstarcpa.example.ca',
      channel: 'sequence',
    });
    expect(checkUnsubbed.sendable).toBe(false);
    expect(checkUnsubbed.reasonCode).toBe('SUPPRESSED_EMAIL');
  });

  it('A14: Privacy access export returns contact data and privacy erasure anonymizes PII while preserving deal financials and SHA-256 suppression (PRD §5.5)', async () => {
    const admin = await services.auth.resolveSessionUser('usr_admin_1');

    // Create a contact with a deal, then export and erase
    const contact = await services.crm.createContact(admin, {
      companyId: 'cmp_clearwater',
      firstName: 'Privacy',
      lastName: 'Subject',
      title: 'Partner',
      jobFunction: 'Partner / Principal',
      seniority: 'Partner',
      primaryEmail: 'privacy.subject@clearwaterllp.example.com',
      secondaryEmails: [],
      market: 'US',
      timezone: 'America/New_York',
      doNotContact: false,
    });
    const contactId = String(contact['id']);

    const exported = await services.compliance.exportContactPrivacyData(admin, contactId);
    expect(exported['contact']).toBeTruthy();

    const erased = await services.compliance.eraseContactPrivacyData(admin, contactId);
    expect(erased.erased).toBe(true);
    expect(erased.emailSha256).toHaveLength(64);

    // Cleartext email is NULL in suppressions, but SHA-256 blocks future sendability!
    const supRow = await db.query<{ email: string | null; email_sha256: string }>(
      `SELECT email, email_sha256 FROM suppressions WHERE email_sha256 = $1 LIMIT 1`,
      [erased.emailSha256],
    );
    expect(supRow.rows[0]?.email).toBeNull();

    const checkErased = await services.compliance.evaluateRecipientSendability({
      email: 'privacy.subject@clearwaterllp.example.com',
      channel: 'sequence',
    });
    expect(checkErased.sendable).toBe(false);
    expect(checkErased.reasonCode).toBe('SUPPRESSED_EMAIL');
  });

  it('A19 & A20: Campaign approval enforces Marketing Manager/Admin permission, and >3% bounce or >0.1% complaint auto-pauses campaign (PRD §4.13)', async () => {
    const bdr = await services.auth.resolveSessionUser('usr_bdr_1');
    const mktManager = await services.auth.resolveSessionUser('usr_mkt_1');

    const campaign = await services.outreach.createCampaign(mktManager, {
      name: 'Q1 Tax Season Capacity Briefing',
      subject: 'Dedicated Tax Preparer Pods for Q1',
      bodyHtml: '<p>Book your 3-day free trial.</p>',
      market: 'US',
      recipientContactIds: [],
    });
    const campaignId = String(campaign['id']);

    // A19: BDR cannot approve a campaign (403 FORBIDDEN_CAPABILITY)
    await expect(services.outreach.approveCampaign(bdr, campaignId)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN_CAPABILITY',
    });

    // A19: the creator cannot approve their own campaign (PRD §2.4)
    await expect(services.outreach.approveCampaign(mktManager, campaignId)).rejects.toMatchObject({
      status: 403,
      code: 'SELF_APPROVAL_NOT_ALLOWED',
    });

    // A second approver (Admin) approves successfully
    const admin = await services.auth.resolveSessionUser('usr_admin_1');
    const approved = await services.outreach.approveCampaign(admin, campaignId);
    expect(approved['status']).toBe('approved');

    // A20: 4 bounces out of 100 sends (4.0% > 3.0% threshold) immediately auto-pauses the campaign
    const paused = await services.outreach.recordCampaignMetricsAndCheckThresholds(campaignId, {
      sentCount: 100,
      deliveredCount: 96,
      bouncedCount: 4,
      complainedCount: 0,
    });
    expect(paused.autoPaused).toBe(true);
    expect(paused.status).toBe('paused_deliverability');
    expect(paused.pausedReason).toMatch(/3\.00% threshold/);
  });

  // -------------------------------------------------------------------------
  // Phase 6: Apollo Credit Guard, Bookings, Webhooks, Lead Scoring & EXPLAIN
  // -------------------------------------------------------------------------

  it('Phase 6: Apollo deduplicates by apollo_person_id and enforces daily credit guard; Bookings creates task; Webhooks sign HMAC; Lead Scoring explains points (PRD §4.16, §8.3–8.6)', async () => {
    const admin = await services.auth.resolveSessionUser('usr_admin_1');

    // 1. Apollo import & deduplication
    const apolloBatch1 = await services.intelligence.importApolloProspects(admin, [
      {
        apolloPersonId: 'apollo_p_9001',
        firstName: 'Grant',
        lastName: 'ThorntonTest',
        email: 'g.thornton@midwestcpa.example.com',
        title: 'Tax Partner',
        firmName: 'Midwest CPA LLP',
        domain: 'midwestcpa.example.com',
        market: 'US',
      },
    ]);
    expect(apolloBatch1.createdCount).toBe(1);
    expect(apolloBatch1.creditsConsumed).toBe(1);

    // Re-importing the same apollo_person_id deduplicates without consuming another credit
    const apolloBatch2 = await services.intelligence.importApolloProspects(admin, [
      {
        apolloPersonId: 'apollo_p_9001',
        firstName: 'Grant',
        lastName: 'ThorntonTest',
        email: 'g.thornton@midwestcpa.example.com',
        title: 'Tax Partner',
        firmName: 'Midwest CPA LLP',
        domain: 'midwestcpa.example.com',
        market: 'US',
      },
    ]);
    expect(apolloBatch2.createdCount).toBe(0);
    expect(apolloBatch2.deduplicatedCount).toBe(1);
    expect(apolloBatch2.creditsConsumed).toBe(0);

    // Requesting credits above the daily cap (200) throws 422 APOLLO_CREDIT_CAP_EXCEEDED
    await expect(
      services.intelligence.importApolloProspects(
        admin,
        [
          {
            apolloPersonId: 'apollo_p_9002',
            firstName: 'Over',
            lastName: 'Limit',
            email: 'over.limit@midwestcpa.example.com',
            title: 'Partner',
            firmName: 'Midwest CPA LLP',
            domain: 'midwestcpa.example.com',
            market: 'US',
          },
        ],
        250,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'APOLLO_CREDIT_CAP_EXCEEDED',
    });

    // 2. Microsoft Bookings webhook
    const booking = await services.intelligence.handleMicrosoftBookingsEvent({
      customerEmail: 'jane.patel@acmetax.example.com',
      customerName: 'Jane Patel',
      serviceName: '3-Day Free Trial Scoping Call',
      startTimeIso: '2026-11-10T16:00:00.000Z',
    });
    expect(booking.contactId).toBe('cnt_jane');
    expect(booking.taskId).toMatch(/^tsk_bk_/);

    // 3. Lead scoring engine with explanation
    const score = await services.intelligence.evaluateAndPersistLeadScore({
      leadId: 'lead_jane',
      staffBand: '21–50',
      title: 'Managing Partner',
      source: 'Website: 3-day trial form',
      softwareStack: ['UltraTax CS', 'QuickBooks'],
    });
    expect(score.totalScore).toBe(95);
    expect(score.breakdown.length).toBe(4);

    // 4. Outbound webhook HMAC dispatch & API token creation
    const dispatched = await services.intelligence.dispatchPendingOutboxEventsToWebhooks();
    expect(dispatched.processedEvents).toBeGreaterThan(0);
    expect(dispatched.deliveries.some((d) => d.signatureHeader.startsWith('sha256='))).toBe(true);

    const token = await services.intelligence.createApiToken(admin, 'n8n Production Worker');
    expect(token.rawToken).toMatch(/^adas_pat_/);

    // 5. EXPLAIN ANALYZE query plan check
    const plan = await db.explainAnalyze(
      `SELECT id, name, domain FROM companies WHERE domain = $1 AND deleted_at IS NULL`,
      ['acmetax.example.com'],
    );
    expect(plan.join('\n')).toMatch(/Execution Time/i);
  });
});
