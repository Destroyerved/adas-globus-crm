import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  ApolloEnrichContactInputSchema,
  ApolloImportInputSchema,
  ApolloSearchInputSchema,
  CreateWebhookEndpointInputSchema,
  MicrosoftBookingsWebhookPayloadSchema,
  UpdateApolloCreditLimitInputSchema,
  UpdateWebhookEndpointInputSchema,
  WEBHOOK_EVENT_TYPES,
  type ApolloImportInput,
  type ApolloSearchInput,
  type CreateWebhookEndpointInput,
  type Currency,
  type Market,
  type MicrosoftBookingsWebhookPayload,
  type SessionUser,
  type UpdateApolloCreditLimitInput,
  type UpdateWebhookEndpointInput,
} from '@adas/shared';
import { ApolloClient, type ApolloPersonPreview } from '../../platform/apollo/index.js';
import { type SecretBox } from '../../platform/crypto/index.js';
import { type DatabaseService, type DbTx, sha256Hex } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { convertCurrencyMinor } from '../../platform/money/index.js';
import {
  extractDomainFromEmail,
  normalizeCompanyDomain,
  normalizeEmail,
} from '../../platform/normalize/index.js';
import { type OutboxEvent } from '../../platform/outbox/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';
import {
  signAdasWebhookPayload,
  validateWebhookTargetUrl,
  verifyTimestampedHmacSignature,
} from '../../platform/webhooks/index.js';
import { addNotification } from '../notifications/index.js';

export interface PipelineRollupReport {
  reportingCurrency: Currency;
  openDealsCount: number;
  wonDealsCount: number;
  totalOpenMonthlyMinor: string;
  totalWeightedMonthlyMinor: string;
  totalWonMonthlyMinor: string;
  byMarket: Record<string, { openCount: number; openMonthlyMinorInReportingCurrency: string }>;
}

export interface LeadScoreEvaluation {
  totalScore: number;
  breakdown: Array<{
    ruleId: string;
    ruleName: string;
    category: string;
    points: number;
  }>;
}

export interface IntelligenceServiceOptions {
  apolloClient?: ApolloClient;
  secretBox?: SecretBox | null;
  bookingsWebhookSecretFile?: string;
  bookingsWebhookSecret?: string | null;
  nodeEnv?: string;
  mailLive?: boolean;
  publicHost?: string;
  allowPrivateWebhookTargets?: boolean;
  connectorFlags?: {
    entraConfigured?: boolean;
    graphConfigured?: boolean;
    googleConfigured?: boolean;
    gmailConfigured?: boolean;
    espConfigured?: boolean;
    espProvider?: string;
    espSendingDomain?: string;
  };
}

export interface WebhookEndpointView {
  id: string;
  name: string;
  description: string | null;
  target_url: string;
  secret_hint: string;
  event_types: string[];
  active: boolean;
  last_status_code: number | null;
  last_delivered_at: string | null;
  last_error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryView {
  id: string;
  endpoint_id: string;
  outbox_event_id: string | null;
  event_type: string;
  status: 'pending' | 'retrying' | 'delivered' | 'failed';
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  available_at: string;
  delivered_at: string | null;
  created_at: string;
}

function isoOrNull(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') {
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? val : parsed.toISOString();
  }
  return null;
}

function staffBandFromEmployees(count: number | null | undefined): string {
  if (!count || count <= 0) return '1–10';
  if (count <= 10) return '1–10';
  if (count <= 20) return '11–20';
  if (count <= 50) return '21–50';
  if (count <= 100) return '51–100';
  return '100+';
}

export class IntelligenceService {
  private readonly apollo: ApolloClient;
  private readonly secretBox: SecretBox | null;
  private readonly bookingsWebhookSecretFile: string | undefined;
  private readonly explicitBookingsSecret: string | null;
  private readonly nodeEnv: string;
  private readonly mailLive: boolean;
  private readonly publicHost: string;
  private readonly allowPrivateWebhookTargets: boolean;
  private readonly connectorFlags: NonNullable<IntelligenceServiceOptions['connectorFlags']>;

  constructor(
    private readonly db: DatabaseService,
    options: IntelligenceServiceOptions = {},
  ) {
    this.apollo = options.apolloClient ?? new ApolloClient();
    this.secretBox = options.secretBox ?? null;
    this.bookingsWebhookSecretFile = options.bookingsWebhookSecretFile;
    this.explicitBookingsSecret = options.bookingsWebhookSecret ?? null;
    this.nodeEnv = options.nodeEnv ?? 'development';
    this.mailLive = options.mailLive ?? false;
    this.publicHost = options.publicHost ?? 'go.adasglobuspro.com';
    this.allowPrivateWebhookTargets =
      options.allowPrivateWebhookTargets ?? this.nodeEnv !== 'production';
    this.connectorFlags = options.connectorFlags ?? {};
  }

  private readBookingsSecret(): string | null {
    if (this.explicitBookingsSecret && this.explicitBookingsSecret.trim().length > 0) {
      return this.explicitBookingsSecret.trim();
    }
    if (!this.bookingsWebhookSecretFile || !existsSync(this.bookingsWebhookSecretFile)) {
      return null;
    }
    const raw = readFileSync(this.bookingsWebhookSecretFile, 'utf8').trim();
    if (!raw || raw.startsWith('00000000') || raw.toLowerCase() === 'changeme') {
      return null;
    }
    return raw;
  }

  isBookingsConfigured(): boolean {
    return this.readBookingsSecret() !== null;
  }

  // ---------------------------------------------------------------------------
  // Admin Integrations Overview (PRD 4.14, 4.17)
  // ---------------------------------------------------------------------------

  async getIntegrationsOverview(user: SessionUser): Promise<{
    connectors: {
      entraSso: { configured: boolean };
      microsoftGraphMail: { configured: boolean; connectedMailboxes: number };
      googleSso: { configured: boolean };
      googleGmailMail: { configured: boolean; connectedMailboxes: number };
      espCampaigns: {
        configured: boolean;
        provider: string;
        sendingDomain: string;
        mailLive: boolean;
      };
      apollo: {
        configured: boolean;
        dailyCap: number;
        creditsUsedToday: number;
        remainingDailyCredits: number;
      };
      microsoftBookings: {
        configured: boolean;
        webhookUrl: string;
        eventsProcessed30d: number;
      };
      outboundWebhooks: {
        activeEndpointsCount: number;
        delivered24hCount: number;
        failed24hCount: number;
        availableEventTypes: readonly string[];
      };
    };
    recentApolloLedger: Array<{
      id: string;
      action: string;
      creditsUsed: number;
      entityType: string | null;
      actorName: string | null;
      createdAt: string;
    }>;
  }> {
    requireCapability(user, 'settings.manage');

    const [mbxCountRes, apolloStatus, bookingsCountRes, whActiveRes, whStatsRes, apolloLedgerRes] =
      await Promise.all([
        this.db.query<{ graph_cnt: number; gmail_cnt: number }>(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'connected' AND provider = 'microsoft_graph')::int AS graph_cnt,
             COUNT(*) FILTER (WHERE status = 'connected' AND provider = 'google_gmail')::int AS gmail_cnt
           FROM mailbox_connections`,
        ),
        this.readApolloCreditSummary(),
        this.db.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM booking_events WHERE created_at >= NOW() - INTERVAL '30 days'`,
        ),
        this.db.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM webhook_endpoints WHERE active = TRUE`,
        ),
        this.db.query<{ delivered: number; failed: number }>(
          `SELECT
           COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM webhook_deliveries
         WHERE created_at >= NOW() - INTERVAL '24 hours'`,
        ),
        this.db.query<{
          id: string;
          action: string;
          credits_used: number;
          entity_type: string | null;
          actor_name: string | null;
          created_at: Date | string;
        }>(
          `SELECT l.id, l.action, l.credits_used, l.entity_type, u.name AS actor_name, l.created_at
         FROM apollo_credit_ledger l
         LEFT JOIN users u ON u.id = l.actor_user_id
         ORDER BY l.created_at DESC
         LIMIT 20`,
        ),
      ]);

    return {
      connectors: {
        entraSso: {
          configured: Boolean(this.connectorFlags.entraConfigured),
        },
        microsoftGraphMail: {
          configured: Boolean(this.connectorFlags.graphConfigured),
          connectedMailboxes: mbxCountRes.rows[0]?.graph_cnt ?? 0,
        },
        googleSso: {
          configured: Boolean(this.connectorFlags.googleConfigured),
        },
        googleGmailMail: {
          configured: Boolean(this.connectorFlags.gmailConfigured),
          connectedMailboxes: mbxCountRes.rows[0]?.gmail_cnt ?? 0,
        },
        espCampaigns: {
          configured: Boolean(this.connectorFlags.espConfigured),
          provider: this.connectorFlags.espProvider ?? 'postmark',
          sendingDomain: this.connectorFlags.espSendingDomain ?? 'mail.adasglobuspro.com',
          mailLive: this.mailLive,
        },
        apollo: {
          configured: this.apollo.isConfigured(),
          dailyCap: apolloStatus.dailyCap,
          creditsUsedToday: apolloStatus.creditsUsedToday,
          remainingDailyCredits: apolloStatus.remainingDailyCredits,
        },
        microsoftBookings: {
          configured: this.isBookingsConfigured(),
          webhookUrl: `https://${this.publicHost}/api/v1/webhooks/bookings`,
          eventsProcessed30d: bookingsCountRes.rows[0]?.cnt ?? 0,
        },
        outboundWebhooks: {
          activeEndpointsCount: whActiveRes.rows[0]?.cnt ?? 0,
          delivered24hCount: whStatsRes.rows[0]?.delivered ?? 0,
          failed24hCount: whStatsRes.rows[0]?.failed ?? 0,
          availableEventTypes: WEBHOOK_EVENT_TYPES,
        },
      },
      recentApolloLedger: apolloLedgerRes.rows.map((r) => ({
        id: r.id,
        action: r.action,
        creditsUsed: Number(r.credits_used),
        entityType: r.entity_type,
        actorName: r.actor_name,
        createdAt: isoOrNull(r.created_at) ?? new Date().toISOString(),
      })),
    };
  }

  private async readApolloCreditSummary(): Promise<{
    dailyCap: number;
    creditsUsedToday: number;
    remainingDailyCredits: number;
  }> {
    const [usedRes, capRes] = await Promise.all([
      this.db.query<{ used: number }>(
        `SELECT COALESCE(SUM(credits_used), 0)::int AS used
         FROM apollo_credit_ledger
         WHERE created_at >= CURRENT_DATE`,
      ),
      this.db.query<{ value_json: number }>(
        `SELECT value_json FROM settings WHERE key = 'apollo.daily_credit_limit' LIMIT 1`,
      ),
    ]);
    const creditsUsedToday = Number(usedRes.rows[0]?.used ?? 0);
    const dailyCap = Number(capRes.rows[0]?.value_json ?? 200);
    return {
      dailyCap,
      creditsUsedToday,
      remainingDailyCredits: Math.max(0, dailyCap - creditsUsedToday),
    };
  }

  async getApolloStatus(user: SessionUser): Promise<{
    configured: boolean;
    dailyCap: number;
    creditsUsedToday: number;
    remainingDailyCredits: number;
  }> {
    requireCapability(user, 'contacts.read');
    const summary = await this.readApolloCreditSummary();
    return {
      configured: this.apollo.isConfigured(),
      ...summary,
    };
  }

  async updateApolloCreditLimit(
    user: SessionUser,
    rawInput: UpdateApolloCreditLimitInput,
    ip: string | null = null,
  ): Promise<{ dailyCap: number; creditsUsedToday: number; remainingDailyCredits: number }> {
    requireCapability(user, 'settings.manage');
    const input = UpdateApolloCreditLimitInputSchema.parse(rawInput);

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO settings (key, value_json, updated_by_user_id, updated_at)
         VALUES ('apollo.daily_credit_limit', $1::jsonb, $2, NOW())
         ON CONFLICT (key) DO UPDATE
           SET value_json = EXCLUDED.value_json,
               updated_by_user_id = EXCLUDED.updated_by_user_id,
               version = settings.version + 1,
               updated_at = NOW()`,
        [JSON.stringify(input.dailyCreditLimit), user.id],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'apollo.credit_limit_updated',
        entityType: 'setting',
        entityId: 'apollo.daily_credit_limit',
        metadata: { dailyCreditLimit: input.dailyCreditLimit },
        ipAddress: ip,
      });
    });

    return this.readApolloCreditSummary();
  }

  // ---------------------------------------------------------------------------
  // Real Apollo Search, Confirmed Import & Contact Enrichment (PRD 4.14, 5, 8.7)
  // ---------------------------------------------------------------------------

  async searchApollo(
    user: SessionUser,
    rawInput: ApolloSearchInput,
  ): Promise<{
    items: Array<
      ApolloPersonPreview & {
        alreadyInCrm: boolean;
        existingContactId: string | null;
        suppressed: boolean;
        estimatedCreditCost: number;
      }
    >;
    totalEntries: number;
    page: number;
    perPage: number;
    dailyCap: number;
    creditsUsedToday: number;
    remainingDailyCredits: number;
  }> {
    requireCapability(user, 'contacts.read');
    const input = ApolloSearchInputSchema.parse(rawInput);
    const [searchRes, creditSummary] = await Promise.all([
      this.apollo.searchPeople(input),
      this.readApolloCreditSummary(),
    ]);

    const personIds = searchRes.people.map((p) => p.apolloPersonId);
    const emails = searchRes.people
      .map((p) => (p.email ? normalizeEmail(p.email) : null))
      .filter((e): e is string => e !== null);
    const emailHashes = emails.map((e) => sha256Hex(e));
    const domains = [
      ...new Set(
        searchRes.people
          .map((p) => normalizeCompanyDomain(p.domain))
          .filter((d): d is string => d !== null),
      ),
    ];

    const [byApolloId, byExtId, byEmail, suppressedEmails, suppressedDomains] = await Promise.all([
      personIds.length > 0
        ? this.db.query<{ id: string; apollo_person_id: string }>(
            `SELECT id, apollo_person_id FROM contacts
             WHERE apollo_person_id = ANY($1::text[]) AND deleted_at IS NULL`,
            [personIds],
          )
        : Promise.resolve({ rows: [] as Array<{ id: string; apollo_person_id: string }> }),
      personIds.length > 0
        ? this.db.query<{ entity_id: string; external_id: string }>(
            `SELECT entity_id, external_id FROM external_ids
             WHERE provider = 'apollo' AND entity_type = 'contact' AND external_id = ANY($1::text[])`,
            [personIds],
          )
        : Promise.resolve({ rows: [] as Array<{ entity_id: string; external_id: string }> }),
      emails.length > 0
        ? this.db.query<{ contact_id: string; email: string }>(
            `SELECT ce.contact_id, ce.email FROM contact_emails ce
             JOIN contacts c ON c.id = ce.contact_id
             WHERE ce.email = ANY($1::text[]) AND c.deleted_at IS NULL`,
            [emails],
          )
        : Promise.resolve({ rows: [] as Array<{ contact_id: string; email: string }> }),
      emailHashes.length > 0
        ? this.db.query<{ email_sha256: string }>(
            `SELECT email_sha256 FROM suppressions
             WHERE email_sha256 = ANY($1::text[]) AND lifted_at IS NULL`,
            [emailHashes],
          )
        : Promise.resolve({ rows: [] as Array<{ email_sha256: string }> }),
      domains.length > 0
        ? this.db.query<{ domain: string }>(
            `SELECT domain FROM suppressed_domains WHERE domain = ANY($1::text[])`,
            [domains],
          )
        : Promise.resolve({ rows: [] as Array<{ domain: string }> }),
    ]);

    const existingByApollo = new Map<string, string>();
    for (const row of byApolloId.rows) existingByApollo.set(row.apollo_person_id, row.id);
    for (const row of byExtId.rows) {
      if (!existingByApollo.has(row.external_id)) {
        existingByApollo.set(row.external_id, row.entity_id);
      }
    }
    const existingByEmail = new Map<string, string>();
    for (const row of byEmail.rows) existingByEmail.set(row.email, row.contact_id);

    const suppressedHashSet = new Set(suppressedEmails.rows.map((r) => r.email_sha256));
    const suppressedDomainSet = new Set(suppressedDomains.rows.map((r) => r.domain));

    const items = searchRes.people.map((p) => {
      const normEmail = p.email ? normalizeEmail(p.email) : null;
      const normDom = normalizeCompanyDomain(p.domain);
      const matchedId =
        existingByApollo.get(p.apolloPersonId) ??
        (normEmail ? existingByEmail.get(normEmail) : undefined) ??
        null;
      const isSuppressed =
        (normEmail !== null && suppressedHashSet.has(sha256Hex(normEmail))) ||
        (normDom !== null && suppressedDomainSet.has(normDom));
      const alreadyInCrm = matchedId !== null;
      return {
        ...p,
        alreadyInCrm,
        existingContactId: matchedId,
        suppressed: isSuppressed,
        estimatedCreditCost: alreadyInCrm || isSuppressed ? 0 : 1,
      };
    });

    return {
      items,
      totalEntries: searchRes.totalEntries,
      page: searchRes.page,
      perPage: searchRes.perPage,
      ...creditSummary,
    };
  }

  /**
   * Confirmed Apollo prospect import (PRD 4.14, 5; AGENTS.md §10):
   * - Requires upfront `confirmedCreditCost >= requiredCredits` before consuming credits.
   * - Calls `ApolloClient.matchPerson` when email needs unlocking.
   * - Never imports suppressed or privacy-erased addresses (`suppressions` + `suppressed_domains`).
   * - Deduplicates on `external_ids`, `contacts.apollo_person_id`, and `contact_emails`.
   * - Stores zero `consent_records` (Apollo ownership is never marketing consent).
   */
  async importFromApollo(
    user: SessionUser,
    rawInput: ApolloImportInput,
    ip: string | null = null,
  ): Promise<{
    createdCount: number;
    deduplicatedCount: number;
    skippedSuppressedCount: number;
    skippedMissingEmailCount: number;
    creditsConsumed: number;
    remainingDailyCredits: number;
    contactIds: string[];
  }> {
    requireCapability(user, 'contacts.write');
    const input = ApolloImportInputSchema.parse(rawInput);
    const creditSummary = await this.readApolloCreditSummary();

    // Pre-scan which candidates are already known or suppressed before spending credits
    const prechecked: Array<{
      candidate: ApolloImportInput['candidates'][number];
      existingContactId: string | null;
      knownSuppressed: boolean;
    }> = [];

    for (const c of input.candidates) {
      const cleanEmail = c.email ? normalizeEmail(c.email) : null;
      const cleanDomain = normalizeCompanyDomain(c.domain || cleanEmail || '');

      const existing = await this.findExistingContactForApollo(c.apolloPersonId, cleanEmail);
      if (existing) {
        prechecked.push({
          candidate: c,
          existingContactId: existing,
          knownSuppressed: false,
        });
        continue;
      }

      const isSuppressed = await this.isAddressOrDomainSuppressed(cleanEmail, cleanDomain);
      prechecked.push({
        candidate: c,
        existingContactId: null,
        knownSuppressed: isSuppressed,
      });
    }

    const netNewCount = prechecked.filter(
      (item) => !item.existingContactId && !item.knownSuppressed,
    ).length;

    if (netNewCount > 0 && input.confirmedCreditCost < netNewCount) {
      throw new DomainError({
        status: 422,
        code: 'APOLLO_CREDIT_CONFIRMATION_REQUIRED',
        title: 'Credit confirmation required before enrichment',
        detail: `Importing ${netNewCount} new prospect(s) costs up to ${netNewCount} Apollo credit(s). Confirm the credit cost to continue.`,
      });
    }

    if (creditSummary.creditsUsedToday + netNewCount > creditSummary.dailyCap) {
      throw new DomainError({
        status: 422,
        code: 'APOLLO_CREDIT_CAP_EXCEEDED',
        title: 'Apollo daily credit cap reached',
        detail: `Importing ${netNewCount} prospect(s) exceeds the ${creditSummary.dailyCap} daily credit limit (${creditSummary.creditsUsedToday} already used today).`,
      });
    }

    let createdCount = 0;
    let deduplicatedCount = 0;
    let skippedSuppressedCount = 0;
    let skippedMissingEmailCount = 0;
    let creditsConsumed = 0;
    const contactIds: string[] = [];

    for (const entry of prechecked) {
      const { candidate } = entry;
      if (entry.knownSuppressed) {
        skippedSuppressedCount += 1;
        continue;
      }

      if (entry.existingContactId) {
        deduplicatedCount += 1;
        contactIds.push(entry.existingContactId);
        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE contacts
             SET apollo_person_id = COALESCE(apollo_person_id, $2),
                 updated_at = NOW()
             WHERE id = $1`,
            [entry.existingContactId, candidate.apolloPersonId],
          );
          await this.upsertExternalId(tx, {
            provider: 'apollo',
            entityType: 'contact',
            entityId: entry.existingContactId as string,
            externalId: candidate.apolloPersonId,
          });
        });
        continue;
      }

      // Unlock corporate email via real Apollo /v1/people/match if not already supplied
      let resolvedEmail = candidate.email ? normalizeEmail(candidate.email) : null;
      let resolvedStatus: 'valid' | 'risky' | 'invalid' | 'unknown' = resolvedEmail
        ? 'valid'
        : 'unknown';
      let resolvedTitle = candidate.title;
      let resolvedFirm = candidate.firmName;
      let resolvedDomain = candidate.domain;
      let resolvedApolloOrgId = candidate.apolloOrgId ?? null;
      let estimatedEmployees: number | null = null;

      if (!resolvedEmail) {
        const matched = await this.apollo.matchPerson({
          apolloPersonId: candidate.apolloPersonId,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          domain: candidate.domain || undefined,
          organizationName: candidate.firmName || undefined,
        });
        creditsConsumed += 1;
        await this.db.query(
          `INSERT INTO apollo_credit_ledger (id, action, credits_used, apollo_person_id, apollo_org_id, entity_type, actor_user_id)
           VALUES ($1, 'person_match', 1, $2, $3, 'contact', $4)`,
          [
            `acl_${randomUUID()}`,
            candidate.apolloPersonId,
            matched?.apolloOrgId ?? resolvedApolloOrgId,
            user.id,
          ],
        );
        if (matched) {
          resolvedEmail = matched.email ? normalizeEmail(matched.email) : null;
          resolvedStatus = matched.emailVerificationStatus;
          resolvedTitle = matched.title ?? resolvedTitle;
          resolvedFirm = matched.firmName ?? resolvedFirm;
          resolvedDomain = matched.domain ?? resolvedDomain;
          resolvedApolloOrgId = matched.apolloOrgId ?? resolvedApolloOrgId;
          estimatedEmployees = matched.estimatedEmployees;
        }
      } else {
        creditsConsumed += 1;
        await this.db.query(
          `INSERT INTO apollo_credit_ledger (id, action, credits_used, apollo_person_id, apollo_org_id, entity_type, actor_user_id)
           VALUES ($1, 'prospect_import', 1, $2, $3, 'contact', $4)`,
          [`acl_${randomUUID()}`, candidate.apolloPersonId, resolvedApolloOrgId, user.id],
        );
      }

      if (!resolvedEmail) {
        skippedMissingEmailCount += 1;
        continue;
      }

      const cleanCorpDomain = normalizeCompanyDomain(
        resolvedDomain || extractDomainFromEmail(resolvedEmail) || '',
      );

      // Suppression ALWAYS wins, even after email unlock (AGENTS.md §10)
      if (await this.isAddressOrDomainSuppressed(resolvedEmail, cleanCorpDomain)) {
        skippedSuppressedCount += 1;
        continue;
      }

      // Check again in case unlocked email matches an existing CRM contact
      const existingAfterUnlock = await this.findExistingContactForApollo(
        candidate.apolloPersonId,
        resolvedEmail,
      );
      if (existingAfterUnlock) {
        deduplicatedCount += 1;
        contactIds.push(existingAfterUnlock);
        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE contacts
             SET apollo_person_id = COALESCE(apollo_person_id, $2),
                 updated_at = NOW()
             WHERE id = $1`,
            [existingAfterUnlock, candidate.apolloPersonId],
          );
          await this.upsertExternalId(tx, {
            provider: 'apollo',
            entityType: 'contact',
            entityId: existingAfterUnlock,
            externalId: candidate.apolloPersonId,
          });
        });
        continue;
      }

      const createdId = await this.db.transaction(async (tx) => {
        let companyId: string | null = null;
        if (cleanCorpDomain) {
          const cmpRes = await tx.query<{ id: string }>(
            `SELECT id FROM companies WHERE domain = $1 AND deleted_at IS NULL LIMIT 1`,
            [cleanCorpDomain],
          );
          if (cmpRes.rows[0]) {
            companyId = cmpRes.rows[0].id;
          } else {
            companyId = `cmp_${randomUUID()}`;
            await tx.query(
              `INSERT INTO companies (
                 id, name, domain, website, firm_type, market, staff_band,
                 account_status, owner_user_id, team_id
               ) VALUES ($1, $2, $3, $4, 'CPA firm', $5, $6, 'prospect', $7, $8)`,
              [
                companyId,
                resolvedFirm.trim() || cleanCorpDomain,
                cleanCorpDomain,
                `https://${cleanCorpDomain}`,
                candidate.market,
                staffBandFromEmployees(estimatedEmployees),
                user.id,
                user.teamId ?? 'team_us',
              ],
            );
          }
          if (resolvedApolloOrgId && companyId) {
            await this.upsertExternalId(tx, {
              provider: 'apollo',
              entityType: 'company',
              entityId: companyId,
              externalId: resolvedApolloOrgId,
            });
          }
        }

        const contactId = `cnt_${randomUUID()}`;
        const fullName = `${candidate.firstName} ${candidate.lastName}`.trim();
        await tx.query(
          `INSERT INTO contacts (
             id, company_id, first_name, last_name, full_name, title, primary_email,
             market, owner_user_id, team_id, apollo_person_id, email_verification_status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            contactId,
            companyId,
            candidate.firstName,
            candidate.lastName,
            fullName,
            resolvedTitle ?? '',
            resolvedEmail,
            candidate.market,
            user.id,
            user.teamId ?? 'team_us',
            candidate.apolloPersonId,
            resolvedStatus,
          ],
        );

        await tx.query(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
           VALUES ($1, $2, $3, TRUE, $4)
           ON CONFLICT (email) DO NOTHING`,
          [`ce_${randomUUID()}`, contactId, resolvedEmail, resolvedStatus],
        );

        await this.upsertExternalId(tx, {
          provider: 'apollo',
          entityType: 'contact',
          entityId: contactId,
          externalId: candidate.apolloPersonId,
        });

        await this.db.addOutboxEvent(tx, {
          eventType: 'contact.created',
          aggregateType: 'contact',
          aggregateId: contactId,
          payload: {
            contactId,
            companyId,
            market: candidate.market,
            source: 'apollo',
          },
        });

        return contactId;
      });

      createdCount += 1;
      contactIds.push(createdId);
    }

    await this.db.transaction(async (tx) => {
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'apollo.imported',
        entityType: 'contact',
        entityId: 'batch',
        metadata: {
          candidateCount: input.candidates.length,
          createdCount,
          deduplicatedCount,
          skippedSuppressedCount,
          skippedMissingEmailCount,
          creditsConsumed,
        },
        ipAddress: ip,
      });
    });

    const afterSummary = await this.readApolloCreditSummary();
    return {
      createdCount,
      deduplicatedCount,
      skippedSuppressedCount,
      skippedMissingEmailCount,
      creditsConsumed,
      remainingDailyCredits: afterSummary.remainingDailyCredits,
      contactIds,
    };
  }

  async enrichContactWithApollo(
    user: SessionUser,
    contactId: string,
    rawInput: unknown,
    ip: string | null = null,
  ): Promise<{
    enriched: boolean;
    updatedFields: string[];
    creditsConsumed: number;
    remainingDailyCredits: number;
  }> {
    requireCapability(user, 'contacts.write');
    const input = ApolloEnrichContactInputSchema.parse(rawInput ?? {});
    if (input.confirmedCreditCost < 1) {
      throw new DomainError({
        status: 422,
        code: 'APOLLO_CREDIT_CONFIRMATION_REQUIRED',
        title: 'Confirm 1 Apollo credit before enriching this contact',
        detail: 'Contact enrichment consumes 1 Apollo credit; confirm the cost to continue.',
      });
    }

    const scope = scopeWhere(user, 'contacts.write', { alias: 'c', startParamIndex: 2 });
    const cntRes = await this.db.query<{
      id: string;
      first_name: string;
      last_name: string;
      primary_email: string;
      title: string;
      apollo_person_id: string | null;
      email_verification_status: string;
      company_id: string | null;
      company_name: string | null;
      company_domain: string | null;
    }>(
      `SELECT c.id, c.first_name, c.last_name, c.primary_email, c.title,
              c.apollo_person_id, c.email_verification_status, c.company_id,
              cmp.name AS company_name, cmp.domain AS company_domain
       FROM contacts c
       LEFT JOIN companies cmp ON cmp.id = c.company_id AND cmp.deleted_at IS NULL
       WHERE c.id = $1 AND c.deleted_at IS NULL AND (${scope.sql})
       LIMIT 1`,
      [contactId, ...scope.params],
    );
    const contact = cntRes.rows[0];
    if (!contact) {
      throw new NotFoundDomainError('Contact', contactId);
    }

    const creditSummary = await this.readApolloCreditSummary();
    if (creditSummary.creditsUsedToday + 1 > creditSummary.dailyCap) {
      throw new DomainError({
        status: 422,
        code: 'APOLLO_CREDIT_CAP_EXCEEDED',
        title: 'Apollo daily credit cap reached',
        detail: `Daily Apollo credit cap (${creditSummary.dailyCap}) reached.`,
      });
    }

    const matched = await this.apollo.matchPerson({
      apolloPersonId: contact.apollo_person_id ?? undefined,
      email: contact.primary_email,
      firstName: contact.first_name,
      lastName: contact.last_name,
      domain: contact.company_domain ?? undefined,
      organizationName: contact.company_name ?? undefined,
    });

    const updatedFields: string[] = [];
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO apollo_credit_ledger (id, action, credits_used, apollo_person_id, apollo_org_id, entity_type, entity_id, actor_user_id)
         VALUES ($1, 'contact_enrich', 1, $2, $3, 'contact', $4, $5)`,
        [
          `acl_${randomUUID()}`,
          matched?.apolloPersonId ?? contact.apollo_person_id,
          matched?.apolloOrgId ?? null,
          contact.id,
          user.id,
        ],
      );

      if (matched) {
        const nextTitle = !contact.title && matched.title ? matched.title : contact.title;
        const nextVerification =
          contact.email_verification_status === 'unknown' &&
          matched.emailVerificationStatus !== 'unknown'
            ? matched.emailVerificationStatus
            : contact.email_verification_status;
        if (nextTitle !== contact.title) updatedFields.push('title');
        if (nextVerification !== contact.email_verification_status) {
          updatedFields.push('email_verification_status');
        }
        if (!contact.apollo_person_id && matched.apolloPersonId) {
          updatedFields.push('apollo_person_id');
        }

        await tx.query(
          `UPDATE contacts
           SET title = $2,
               email_verification_status = $3,
               apollo_person_id = COALESCE(apollo_person_id, $4),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1`,
          [contact.id, nextTitle, nextVerification, matched.apolloPersonId],
        );

        await this.upsertExternalId(tx, {
          provider: 'apollo',
          entityType: 'contact',
          entityId: contact.id,
          externalId: matched.apolloPersonId,
        });

        for (const fieldName of updatedFields) {
          await tx.query(
            `INSERT INTO record_history (id, entity_type, entity_id, field_name, old_value, new_value, changed_by_user_id, via)
             VALUES ($1, 'contact', $2, $3, $4::jsonb, $5::jsonb, $6, 'api')`,
            [
              `rh_${randomUUID()}`,
              contact.id,
              fieldName,
              JSON.stringify(null),
              JSON.stringify('enriched'),
              user.id,
            ],
          );
        }
      }

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'apollo.contact_enriched',
        entityType: 'contact',
        entityId: contact.id,
        metadata: {
          matched: Boolean(matched),
          updatedFieldCount: updatedFields.length,
        },
        ipAddress: ip,
      });
    });

    const after = await this.readApolloCreditSummary();
    return {
      enriched: Boolean(matched),
      updatedFields,
      creditsConsumed: 1,
      remainingDailyCredits: after.remainingDailyCredits,
    };
  }

  private async findExistingContactForApollo(
    apolloPersonId: string,
    cleanEmail: string | null,
  ): Promise<string | null> {
    const extRes = await this.db.query<{ entity_id: string }>(
      `SELECT e.entity_id FROM external_ids e
       JOIN contacts c ON c.id = e.entity_id
       WHERE e.provider = 'apollo' AND e.entity_type = 'contact'
         AND e.external_id = $1 AND c.deleted_at IS NULL
       LIMIT 1`,
      [apolloPersonId],
    );
    if (extRes.rows[0]) return extRes.rows[0].entity_id;

    if (cleanEmail) {
      const cntRes = await this.db.query<{ id: string }>(
        `SELECT c.id FROM contacts c
         LEFT JOIN contact_emails ce ON ce.contact_id = c.id
         WHERE c.deleted_at IS NULL
           AND (c.apollo_person_id = $1 OR c.primary_email = $2 OR ce.email = $2)
         LIMIT 1`,
        [apolloPersonId, cleanEmail],
      );
      return cntRes.rows[0]?.id ?? null;
    }

    const apolloRes = await this.db.query<{ id: string }>(
      `SELECT id FROM contacts WHERE apollo_person_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [apolloPersonId],
    );
    return apolloRes.rows[0]?.id ?? null;
  }

  private async isAddressOrDomainSuppressed(
    cleanEmail: string | null,
    cleanDomain: string | null,
    runner: Pick<DbTx, 'query'> = this.db,
  ): Promise<boolean> {
    if (cleanEmail) {
      const hash = sha256Hex(cleanEmail);
      const supRes = await runner.query<{ id: string }>(
        `SELECT id FROM suppressions WHERE email_sha256 = $1 AND lifted_at IS NULL LIMIT 1`,
        [hash],
      );
      if (supRes.rows[0]) return true;
    }
    const dom = cleanDomain ?? (cleanEmail ? normalizeCompanyDomain(cleanEmail) : null);
    if (dom) {
      const domRes = await runner.query<{ id: string }>(
        `SELECT id FROM suppressed_domains WHERE domain = $1 LIMIT 1`,
        [dom],
      );
      if (domRes.rows[0]) return true;
    }
    return false;
  }

  private async upsertExternalId(
    tx: DbTx,
    input: {
      provider: 'apollo' | 'bigin' | 'bookings' | 'other';
      entityType: 'contact' | 'company' | 'lead' | 'deal';
      entityId: string;
      externalId: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO external_ids (id, provider, entity_type, entity_id, external_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (provider, entity_type, external_id) DO UPDATE
         SET entity_id = EXCLUDED.entity_id`,
      [
        `ext_${randomUUID()}`,
        input.provider,
        input.entityType,
        input.entityId,
        input.externalId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // Outbound Webhooks CRUD & Real HTTP Delivery Worker (PRD 4.14, 4.17, 6.9, 9)
  // ---------------------------------------------------------------------------

  private mapWebhookRow(r: Record<string, unknown>): WebhookEndpointView {
    const rawSecret = typeof r['secret_hmac'] === 'string' ? r['secret_hmac'] : '';
    const hint =
      typeof r['secret_hint'] === 'string' && r['secret_hint'].length > 0
        ? r['secret_hint']
        : rawSecret
          ? `${rawSecret.slice(0, 10)}…`
          : 'whsec_••••';
    return {
      id: String(r['id']),
      name: String(r['name']),
      description: (r['description'] as string | null) ?? null,
      target_url: String(r['target_url']),
      secret_hint: hint,
      event_types: Array.isArray(r['event_types']) ? (r['event_types'] as string[]) : [],
      active: Boolean(r['active']),
      last_status_code: typeof r['last_status_code'] === 'number' ? r['last_status_code'] : null,
      last_delivered_at: isoOrNull(r['last_delivered_at']),
      last_error: (r['last_error'] as string | null) ?? null,
      version: Number(r['version'] ?? 1),
      created_at: isoOrNull(r['created_at']) ?? new Date().toISOString(),
      updated_at: isoOrNull(r['updated_at']) ?? new Date().toISOString(),
    };
  }

  private sealEndpointSecret(
    endpointId: string,
    rawSecret: string,
  ): {
    secretHmac: string;
    secretCiphertext: string | null;
    secretKeyVersion: number | null;
    secretHint: string;
  } {
    const secretHint = `${rawSecret.slice(0, 10)}…`;
    if (this.secretBox) {
      return {
        secretHmac: '',
        secretCiphertext: this.secretBox.seal(rawSecret, `webhook_endpoint:${endpointId}:secret`),
        secretKeyVersion: this.secretBox.keyVersion,
        secretHint,
      };
    }
    return {
      secretHmac: rawSecret,
      secretCiphertext: null,
      secretKeyVersion: null,
      secretHint,
    };
  }

  private openEndpointSecret(row: {
    id: string;
    secret_hmac: string;
    secret_ciphertext: string | null;
  }): string {
    if (row.secret_ciphertext && this.secretBox) {
      return this.secretBox.open(row.secret_ciphertext, `webhook_endpoint:${row.id}:secret`);
    }
    return row.secret_hmac;
  }

  async listWebhooks(user: SessionUser): Promise<{ items: WebhookEndpointView[] }> {
    requireCapability(user, 'settings.manage');
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM webhook_endpoints ORDER BY created_at DESC`,
    );
    return { items: res.rows.map((r) => this.mapWebhookRow(r)) };
  }

  async createWebhook(
    user: SessionUser,
    rawInput: CreateWebhookEndpointInput,
    ip: string | null = null,
  ): Promise<{ endpoint: WebhookEndpointView; signingSecret: string }> {
    requireCapability(user, 'settings.manage');
    const input = CreateWebhookEndpointInputSchema.parse(rawInput);
    const validatedUrl = validateWebhookTargetUrl(input.targetUrl, {
      production: this.nodeEnv === 'production',
      allowPrivateTargets: this.allowPrivateWebhookTargets,
    });

    const id = `wh_${randomUUID()}`;
    const signingSecret = input.signingSecret ?? `whsec_${randomBytes(24).toString('hex')}`;
    const sealed = this.sealEndpointSecret(id, signingSecret);
    const uniqueEvents = [...new Set(input.eventTypes)];

    const row = await this.db.transaction(async (tx) => {
      const inserted = await tx.query<Record<string, unknown>>(
        `INSERT INTO webhook_endpoints (
           id, name, description, target_url, secret_hmac, secret_ciphertext, secret_key_version,
           secret_hint, event_types, active, created_by_user_id, version, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 1, NOW())
         RETURNING *`,
        [
          id,
          input.name,
          input.description ?? null,
          validatedUrl,
          sealed.secretHmac,
          sealed.secretCiphertext,
          sealed.secretKeyVersion,
          sealed.secretHint,
          JSON.stringify(uniqueEvents),
          input.active,
          user.id,
        ],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'webhook.created',
        entityType: 'webhook_endpoint',
        entityId: id,
        metadata: {
          name: input.name,
          targetHost: new URL(validatedUrl).host,
          eventTypes: uniqueEvents,
          active: input.active,
        },
        ipAddress: ip,
      });

      return inserted.rows[0] ?? {};
    });

    return {
      endpoint: this.mapWebhookRow(row),
      signingSecret,
    };
  }

  async updateWebhook(
    user: SessionUser,
    endpointId: string,
    rawInput: UpdateWebhookEndpointInput,
    ip: string | null = null,
  ): Promise<{ endpoint: WebhookEndpointView; rotatedSigningSecret: string | null }> {
    requireCapability(user, 'settings.manage');
    const input = UpdateWebhookEndpointInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const existingRes = await tx.query<Record<string, unknown>>(
        `SELECT * FROM webhook_endpoints WHERE id = $1 FOR UPDATE`,
        [endpointId],
      );
      const existing = existingRes.rows[0];
      if (!existing) {
        throw new NotFoundDomainError('Webhook endpoint', endpointId);
      }
      if (Number(existing['version'] ?? 1) !== input.version) {
        throw new VersionConflictError('Webhook endpoint', endpointId);
      }

      const nextUrl =
        input.targetUrl !== undefined
          ? validateWebhookTargetUrl(input.targetUrl, {
              production: this.nodeEnv === 'production',
              allowPrivateTargets: this.allowPrivateWebhookTargets,
            })
          : String(existing['target_url']);

      let rotatedSigningSecret: string | null = null;
      let secretHmac = String(existing['secret_hmac'] ?? '');
      let secretCiphertext = (existing['secret_ciphertext'] as string | null) ?? null;
      let secretKeyVersion = (existing['secret_key_version'] as number | null) ?? null;
      let secretHint = (existing['secret_hint'] as string | null) ?? 'whsec_••••';

      if (input.rotateSecret) {
        rotatedSigningSecret = `whsec_${randomBytes(24).toString('hex')}`;
        const sealed = this.sealEndpointSecret(endpointId, rotatedSigningSecret);
        secretHmac = sealed.secretHmac;
        secretCiphertext = sealed.secretCiphertext;
        secretKeyVersion = sealed.secretKeyVersion;
        secretHint = sealed.secretHint;
      }

      const nextName = input.name ?? String(existing['name']);
      const nextDesc =
        input.description !== undefined
          ? input.description
          : ((existing['description'] as string | null) ?? null);
      const nextEvents =
        input.eventTypes !== undefined
          ? [...new Set(input.eventTypes)]
          : Array.isArray(existing['event_types'])
            ? (existing['event_types'] as string[])
            : [];
      const nextActive = input.active !== undefined ? input.active : Boolean(existing['active']);

      const updated = await tx.query<Record<string, unknown>>(
        `UPDATE webhook_endpoints
         SET name = $3,
             description = $4,
             target_url = $5,
             secret_hmac = $6,
             secret_ciphertext = $7,
             secret_key_version = $8,
             secret_hint = $9,
             event_types = $10::jsonb,
             active = $11,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [
          endpointId,
          input.version,
          nextName,
          nextDesc,
          nextUrl,
          secretHmac,
          secretCiphertext,
          secretKeyVersion,
          secretHint,
          JSON.stringify(nextEvents),
          nextActive,
        ],
      );
      if (!updated.rows[0]) {
        throw new VersionConflictError('Webhook endpoint', endpointId);
      }

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'webhook.updated',
        entityType: 'webhook_endpoint',
        entityId: endpointId,
        metadata: {
          active: nextActive,
          eventTypes: nextEvents,
          rotatedSecret: Boolean(rotatedSigningSecret),
        },
        ipAddress: ip,
      });

      return {
        endpoint: this.mapWebhookRow(updated.rows[0]),
        rotatedSigningSecret,
      };
    });
  }

  async deleteWebhook(
    user: SessionUser,
    endpointId: string,
    ip: string | null = null,
  ): Promise<{ deleted: true }> {
    requireCapability(user, 'settings.manage');
    await this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; name: string }>(
        `DELETE FROM webhook_endpoints WHERE id = $1 RETURNING id, name`,
        [endpointId],
      );
      if (!existing.rows[0]) {
        throw new NotFoundDomainError('Webhook endpoint', endpointId);
      }
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'webhook.deleted',
        entityType: 'webhook_endpoint',
        entityId: endpointId,
        metadata: { name: existing.rows[0].name },
        ipAddress: ip,
      });
    });
    return { deleted: true };
  }

  async listWebhookDeliveries(
    user: SessionUser,
    endpointId: string,
  ): Promise<{ items: WebhookDeliveryView[] }> {
    requireCapability(user, 'settings.manage');
    const ep = await this.db.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE id = $1 LIMIT 1`,
      [endpointId],
    );
    if (!ep.rows[0]) {
      throw new NotFoundDomainError('Webhook endpoint', endpointId);
    }

    const res = await this.db.query<Record<string, unknown>>(
      `SELECT id, endpoint_id, outbox_event_id, event_type, status, attempts,
              last_status_code, last_error, available_at, delivered_at, created_at
       FROM webhook_deliveries
       WHERE endpoint_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [endpointId],
    );

    return {
      items: res.rows.map((r) => ({
        id: String(r['id']),
        endpoint_id: String(r['endpoint_id']),
        outbox_event_id: (r['outbox_event_id'] as string | null) ?? null,
        event_type: String(r['event_type']),
        status: r['status'] as WebhookDeliveryView['status'],
        attempts: Number(r['attempts'] ?? 0),
        last_status_code: typeof r['last_status_code'] === 'number' ? r['last_status_code'] : null,
        last_error: (r['last_error'] as string | null) ?? null,
        available_at: isoOrNull(r['available_at']) ?? new Date().toISOString(),
        delivered_at: isoOrNull(r['delivered_at']),
        created_at: isoOrNull(r['created_at']) ?? new Date().toISOString(),
      })),
    };
  }

  /**
   * Outbox wildcard (`'*'`) handler: queues matching active webhook endpoints inside the same
   * outbox transaction, deduplicated on `(endpoint_id, outbox_event_id)` (PRD 4.14, 6.9).
   */
  async enqueueMatchingWebhooks(event: OutboxEvent, tx: DbTx): Promise<void> {
    const endpointsRes = await tx.query<{ id: string; event_types: unknown }>(
      `SELECT id, event_types FROM webhook_endpoints WHERE active = TRUE`,
    );
    if (endpointsRes.rows.length === 0) return;

    const envelope = {
      id: event.id,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.createdAt,
      payload: event.payload,
    };

    for (const ep of endpointsRes.rows) {
      const subscribed = Array.isArray(ep.event_types) ? (ep.event_types as string[]) : [];
      if (!subscribed.includes(event.eventType) && !subscribed.includes('*')) {
        continue;
      }
      await tx.query(
        `INSERT INTO webhook_deliveries (
           id, endpoint_id, outbox_event_id, event_type, payload, status, available_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', NOW())
         ON CONFLICT (endpoint_id, outbox_event_id) DO NOTHING`,
        [`whd_${randomUUID()}`, ep.id, event.id, event.eventType, JSON.stringify(envelope)],
      );
    }
  }

  async testWebhook(
    user: SessionUser,
    endpointId: string,
    ip: string | null = null,
  ): Promise<WebhookDeliveryView> {
    requireCapability(user, 'settings.manage');
    const ep = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM webhook_endpoints WHERE id = $1 LIMIT 1`,
      [endpointId],
    );
    if (!ep.rows[0]) {
      throw new NotFoundDomainError('Webhook endpoint', endpointId);
    }

    const deliveryId = `whd_${randomUUID()}`;
    const envelope = {
      id: `evt_test_${randomUUID()}`,
      eventType: 'webhook.test',
      aggregateType: 'webhook_endpoint',
      aggregateId: endpointId,
      occurredAt: new Date().toISOString(),
      payload: { test: true, endpointId },
    };

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO webhook_deliveries (
           id, endpoint_id, outbox_event_id, event_type, payload, status, available_at
         ) VALUES ($1, $2, NULL, 'webhook.test', $3::jsonb, 'pending', NOW())`,
        [deliveryId, endpointId, JSON.stringify(envelope)],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'webhook.tested',
        entityType: 'webhook_endpoint',
        entityId: endpointId,
        metadata: { deliveryId },
        ipAddress: ip,
      });
    });

    await this.deliverOneWebhook(deliveryId);
    const list = await this.listWebhookDeliveries(user, endpointId);
    const found = list.items.find((d) => d.id === deliveryId);
    if (!found) {
      throw new NotFoundDomainError('Webhook delivery', deliveryId);
    }
    return found;
  }

  /**
   * Worker job `webhook.deliver` — delivers due `webhook_deliveries` over HTTP POST signed with
   * `X-ADAS-Signature: t=<unixSeconds>,v1=<hmacHex>`, retrying with exponential backoff for up
   * to 24 hours (PRD 4.14, 6.9, 9).
   */
  async deliverDueWebhooks(
    limit = 25,
  ): Promise<{ attempted: number; delivered: number; retrying: number; failed: number }> {
    const dueRes = await this.db.query<{ id: string }>(
      `SELECT d.id
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.status IN ('pending', 'retrying')
         AND d.available_at <= NOW()
         AND (e.active = TRUE OR d.event_type = 'webhook.test')
       ORDER BY d.available_at ASC
       LIMIT $1`,
      [limit],
    );

    const summary = { attempted: 0, delivered: 0, retrying: 0, failed: 0 };
    for (const row of dueRes.rows) {
      const outcome = await this.deliverOneWebhook(row.id);
      if (outcome === 'skipped') continue;
      summary.attempted += 1;
      if (outcome === 'delivered') summary.delivered += 1;
      else if (outcome === 'retrying') summary.retrying += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  private async deliverOneWebhook(
    deliveryId: string,
  ): Promise<'delivered' | 'retrying' | 'failed' | 'skipped'> {
    // Claim row with SKIP LOCKED
    const claimed = await this.db.transaction(async (tx) => {
      const res = await tx.query<{
        id: string;
        endpoint_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        attempts: number;
        created_at: Date | string;
        target_url: string;
        secret_hmac: string;
        secret_ciphertext: string | null;
      }>(
        `SELECT d.id, d.endpoint_id, d.event_type, d.payload, d.attempts, d.created_at,
                e.target_url, e.secret_hmac, e.secret_ciphertext
         FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.id = $1 AND d.status IN ('pending', 'retrying')
         FOR UPDATE OF d SKIP LOCKED`,
        [deliveryId],
      );
      return res.rows[0] ?? null;
    });

    if (!claimed) return 'skipped';

    const rawBody = JSON.stringify(claimed.payload);
    let statusCode: number | null = null;
    let errorReason: string | null = null;

    try {
      const safeUrl = validateWebhookTargetUrl(claimed.target_url, {
        production: this.nodeEnv === 'production',
        allowPrivateTargets: this.allowPrivateWebhookTargets,
      });
      const secret = this.openEndpointSecret({
        id: claimed.endpoint_id,
        secret_hmac: claimed.secret_hmac,
        secret_ciphertext: claimed.secret_ciphertext,
      });
      const signed = signAdasWebhookPayload(rawBody, secret);

      const response = await fetch(safeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ADAS-CRM-Webhook/1.0',
          'X-ADAS-Delivery': claimed.id,
          'X-ADAS-Event': claimed.event_type,
          'X-ADAS-Timestamp': signed.timestampHeader,
          'X-ADAS-Signature': signed.signatureHeader,
        },
        body: rawBody,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });

      statusCode = response.status;
      if (response.ok) {
        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE webhook_deliveries
             SET status = 'delivered',
                 attempts = attempts + 1,
                 last_status_code = $2,
                 last_error = NULL,
                 delivered_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [claimed.id, statusCode],
          );
          await tx.query(
            `UPDATE webhook_endpoints
             SET last_status_code = $2,
                 last_delivered_at = NOW(),
                 last_error = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [claimed.endpoint_id, statusCode],
          );
        });
        return 'delivered';
      }
      errorReason = `HTTP ${statusCode}`;
    } catch (err) {
      errorReason = (err as Error).name || 'NetworkError';
    }

    const nextAttempts = claimed.attempts + 1;
    const createdMs = new Date(isoOrNull(claimed.created_at) ?? Date.now()).getTime();
    const elapsedHours = (Date.now() - createdMs) / 3_600_000;
    const exhausted = nextAttempts >= 12 || elapsedHours >= 24;
    const nextStatus = exhausted ? 'failed' : 'retrying';
    const backoffSeconds = Math.min(7_200, 15 * Math.pow(2, claimed.attempts));

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE webhook_deliveries
         SET status = $2,
             attempts = $3,
             last_status_code = $4,
             last_error = $5,
             available_at = NOW() + make_interval(secs => $6),
             updated_at = NOW()
         WHERE id = $1`,
        [claimed.id, nextStatus, nextAttempts, statusCode, errorReason, backoffSeconds],
      );
      await tx.query(
        `UPDATE webhook_endpoints
         SET last_status_code = $2,
             last_error = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [claimed.endpoint_id, statusCode, errorReason],
      );
    });

    return nextStatus;
  }

  // ---------------------------------------------------------------------------
  // Microsoft Bookings Signed Public Webhook (PRD 4.14, 6.5, 7.6, 9)
  // ---------------------------------------------------------------------------

  async handleSignedBookingsWebhook(params: {
    rawBody: string;
    signatureHeader: string | undefined;
    timestampHeader?: string | undefined;
  }): Promise<{
    duplicate: boolean;
    eventType: 'created' | 'updated' | 'cancelled';
    activityId: string | null;
    taskId: string | null;
    contactId: string | null;
  }> {
    const secret = this.readBookingsSecret();
    if (!secret) {
      throw new DomainError({
        status: 503,
        code: 'BOOKINGS_NOT_CONFIGURED',
        title: 'Microsoft Bookings webhook secret is not configured',
        detail: 'Set BOOKINGS_WEBHOOK_SECRET_FILE before sending Bookings webhook events.',
      });
    }

    const verified = verifyTimestampedHmacSignature({
      rawBody: params.rawBody,
      signatureHeader: params.signatureHeader,
      timestampHeader: params.timestampHeader,
      secret,
    });
    if (!verified.ok) {
      throw new DomainError({
        status: 401,
        code: 'INVALID_WEBHOOK_SIGNATURE',
        title: 'Invalid or expired Bookings webhook signature',
        detail: `Bookings webhook signature check failed (${verified.reason ?? 'invalid'}).`,
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(params.rawBody);
    } catch {
      throw new DomainError({
        status: 400,
        code: 'INVALID_JSON',
        title: 'Invalid JSON payload',
        detail: 'Expected JSON webhook body.',
      });
    }

    const payload: MicrosoftBookingsWebhookPayload =
      MicrosoftBookingsWebhookPayloadSchema.parse(parsedJson);
    const cleanEmail =
      normalizeEmail(payload.customerEmail) ?? payload.customerEmail.trim().toLowerCase();
    const emailHash = sha256Hex(cleanEmail);

    return this.db.transaction(async (tx) => {
      const existingEvt = await tx.query<{
        id: string;
        activity_id: string | null;
        task_id: string | null;
        contact_id: string | null;
      }>(
        `SELECT id, activity_id, task_id, contact_id
         FROM booking_events
         WHERE booking_appointment_id = $1 AND event_type = $2
         LIMIT 1`,
        [payload.appointmentId, payload.eventType],
      );
      if (existingEvt.rows[0]) {
        return {
          duplicate: true,
          eventType: payload.eventType,
          activityId: existingEvt.rows[0].activity_id,
          taskId: existingEvt.rows[0].task_id,
          contactId: existingEvt.rows[0].contact_id,
        };
      }

      const cntRes = await tx.query<{
        id: string;
        company_id: string | null;
        owner_user_id: string;
        team_id: string | null;
      }>(
        `SELECT c.id, c.company_id, c.owner_user_id, c.team_id
         FROM contacts c
         LEFT JOIN contact_emails ce ON ce.contact_id = c.id
         WHERE c.deleted_at IS NULL
           AND (c.primary_email = $1 OR ce.email = $1)
         LIMIT 1`,
        [cleanEmail],
      );
      const contact = cntRes.rows[0] ?? null;
      const ownerId = contact?.owner_user_id ?? 'usr_mgr_1';

      if (payload.eventType === 'cancelled') {
        if (contact) {
          await tx.query(
            `UPDATE tasks
             SET status = 'completed',
                 completed_at = NOW(),
                 outcome = 'Cancelled via Microsoft Bookings',
                 updated_at = NOW()
             WHERE contact_id = $1
               AND status = 'open'
               AND id LIKE 'tsk_bk_%'`,
            [contact.id],
          );
        }

        const cancelActId = contact ? `act_${randomUUID()}` : null;
        if (contact && cancelActId) {
          await tx.query(
            `INSERT INTO activities (
               id, entity_type, entity_id, company_id, contact_id, activity_type, title, detail
             ) VALUES ($1, 'contact', $2, $3, $4, 'note', $5, $6)`,
            [
              cancelActId,
              contact.id,
              contact.company_id,
              contact.id,
              `Bookings call cancelled: ${payload.serviceName}`,
              `Appointment scheduled for ${payload.startTimeIso} was cancelled.`,
            ],
          );
        }

        await tx.query(
          `INSERT INTO booking_events (
             id, booking_appointment_id, event_type, service_name, start_at, end_at,
             customer_email_sha256, contact_id, activity_id, task_id
           ) VALUES ($1, $2, 'cancelled', $3, $4, $5, $6, $7, $8, NULL)`,
          [
            `bke_${randomUUID()}`,
            payload.appointmentId,
            payload.serviceName,
            payload.startTimeIso,
            payload.endTimeIso ?? null,
            emailHash,
            contact?.id ?? null,
            cancelActId,
          ],
        );

        return {
          duplicate: false,
          eventType: 'cancelled',
          activityId: cancelActId,
          taskId: null,
          contactId: contact?.id ?? null,
        };
      }

      const activityId = `act_${randomUUID()}`;
      await tx.query(
        `INSERT INTO activities (
           id, entity_type, entity_id, company_id, contact_id, activity_type, title, detail
         ) VALUES ($1, 'contact', $2, $3, $4, 'meeting_booked', $5, $6)`,
        [
          activityId,
          contact?.id ?? payload.appointmentId,
          contact?.company_id ?? null,
          contact?.id ?? null,
          `Microsoft Bookings: ${payload.serviceName}`,
          `Consultation scheduled for ${payload.startTimeIso}`,
        ],
      );

      const taskId = `tsk_bk_${randomUUID()}`;
      await tx.query(
        `INSERT INTO tasks (
           id, title, task_type, priority, status, due_at,
           assignee_user_id, team_id, company_id, contact_id
         ) VALUES ($1, $2, 'call', 'high', 'open', $3, $4, $5, $6, $7)`,
        [
          taskId,
          `Bookings consultation prep: ${payload.serviceName}`,
          payload.startTimeIso,
          ownerId,
          contact?.team_id ?? 'team_us',
          contact?.company_id ?? null,
          contact?.id ?? null,
        ],
      );

      if (contact) {
        await this.upsertExternalId(tx, {
          provider: 'bookings',
          entityType: 'contact',
          entityId: contact.id,
          externalId: payload.appointmentId,
        });

        await addNotification(tx, {
          userId: ownerId,
          kind: 'general',
          title: `Booked meeting: ${payload.serviceName}`,
          body: `Scheduled for ${payload.startTimeIso}. Active outreach sequences have been stopped.`,
          entityType: 'contact',
          entityId: contact.id,
          dedupeKey: `bookings:${payload.appointmentId}:${ownerId}`,
        });

        await this.db.addOutboxEvent(tx, {
          eventType: 'activity.logged',
          aggregateType: 'contact',
          aggregateId: contact.id,
          payload: {
            activityId,
            activityType: 'meeting_booked',
            contactId: contact.id,
            companyId: contact.company_id,
          },
        });
      }

      await tx.query(
        `INSERT INTO booking_events (
           id, booking_appointment_id, event_type, service_name, start_at, end_at,
           customer_email_sha256, contact_id, activity_id, task_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          `bke_${randomUUID()}`,
          payload.appointmentId,
          payload.eventType,
          payload.serviceName,
          payload.startTimeIso,
          payload.endTimeIso ?? null,
          emailHash,
          contact?.id ?? null,
          activityId,
          taskId,
        ],
      );

      return {
        duplicate: false,
        eventType: payload.eventType,
        activityId,
        taskId,
        contactId: contact?.id ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Existing Rollup, Scoring & Acceptance Methods (PRD 4.15, 4.16, 8.3–8.6)
  // ---------------------------------------------------------------------------

  async getPipelineRollupReport(
    user: SessionUser,
    reportingCurrency: Currency = 'USD',
  ): Promise<PipelineRollupReport> {
    const scope = scopeWhere(user, 'reports.read', { alias: 'd', startParamIndex: 1 });

    const [dealsRes, fxRes] = await Promise.all([
      this.db.query<{
        id: string;
        stage_category: 'open' | 'won' | 'lost';
        monthly_value_minor: string | number | bigint;
        currency: Currency;
        probability: number;
        market: Market;
      }>(
        `SELECT d.id, d.stage_category, d.monthly_value_minor, d.currency, d.probability, cmp.market
         FROM deals d
         JOIN companies cmp ON cmp.id = d.company_id
         WHERE d.deleted_at IS NULL AND ${scope.sql}`,
        scope.params,
      ),
      this.db.query<{
        from_currency: Currency;
        to_currency: Currency;
        rate_scaled: string | number | bigint;
      }>(
        `SELECT from_currency, to_currency, rate_scaled FROM fx_rates ORDER BY effective_date DESC`,
      ),
    ]);

    const rateMap = new Map<string, bigint>();
    for (const row of fxRes.rows) {
      const key = `${row.from_currency}->${row.to_currency}`;
      if (!rateMap.has(key)) {
        rateMap.set(key, BigInt(row.rate_scaled));
      }
    }

    const toReportingMinor = (amountMinor: bigint, fromCurrency: Currency): bigint => {
      if (fromCurrency === reportingCurrency) {
        return amountMinor;
      }
      const rate = rateMap.get(`${fromCurrency}->${reportingCurrency}`) ?? 740_000n;
      return convertCurrencyMinor(amountMinor, fromCurrency, reportingCurrency, rate);
    };

    let openDealsCount = 0;
    let wonDealsCount = 0;
    let totalOpenMonthlyMinor = 0n;
    let totalWeightedMonthlyMinor = 0n;
    let totalWonMonthlyMinor = 0n;
    const byMarket: Record<string, { openCount: number; openMinor: bigint }> = {
      US: { openCount: 0, openMinor: 0n },
      CA: { openCount: 0, openMinor: 0n },
    };

    for (const deal of dealsRes.rows) {
      const rawMinor = BigInt(deal.monthly_value_minor);
      const convertedMinor = toReportingMinor(rawMinor, deal.currency);

      if (deal.stage_category === 'open') {
        openDealsCount += 1;
        totalOpenMonthlyMinor += convertedMinor;
        totalWeightedMonthlyMinor += (convertedMinor * BigInt(deal.probability) + 50n) / 100n;
        const bucket = byMarket[deal.market] ?? { openCount: 0, openMinor: 0n };
        bucket.openCount += 1;
        bucket.openMinor += convertedMinor;
        byMarket[deal.market] = bucket;
      } else if (deal.stage_category === 'won') {
        wonDealsCount += 1;
        totalWonMonthlyMinor += convertedMinor;
      }
    }

    return {
      reportingCurrency,
      openDealsCount,
      wonDealsCount,
      totalOpenMonthlyMinor: totalOpenMonthlyMinor.toString(),
      totalWeightedMonthlyMinor: totalWeightedMonthlyMinor.toString(),
      totalWonMonthlyMinor: totalWonMonthlyMinor.toString(),
      byMarket: {
        US: {
          openCount: byMarket['US']?.openCount ?? 0,
          openMonthlyMinorInReportingCurrency: (byMarket['US']?.openMinor ?? 0n).toString(),
        },
        CA: {
          openCount: byMarket['CA']?.openCount ?? 0,
          openMonthlyMinorInReportingCurrency: (byMarket['CA']?.openMinor ?? 0n).toString(),
        },
      },
    };
  }

  async evaluateAndPersistLeadScore(input: {
    leadId?: string;
    contactId?: string;
    staffBand: string;
    title: string;
    source: string;
    softwareStack: string[];
  }): Promise<LeadScoreEvaluation> {
    const rulesRes = await this.db.query<{
      id: string;
      name: string;
      category: string;
      field_path: string;
      operator: string;
      target_value: unknown;
      points: number;
    }>(`SELECT * FROM scoring_rules WHERE active = TRUE ORDER BY points DESC`);

    let totalScore = 0;
    const breakdown: LeadScoreEvaluation['breakdown'] = [];

    for (const rule of rulesRes.rows) {
      let matched = false;
      const fieldValue =
        rule.field_path === 'staffBand'
          ? input.staffBand
          : rule.field_path === 'title'
            ? input.title
            : rule.field_path === 'source'
              ? input.source
              : rule.field_path === 'softwareStack'
                ? input.softwareStack.join(', ')
                : '';

      if (rule.operator === 'in' && Array.isArray(rule.target_value)) {
        matched = rule.target_value.includes(fieldValue);
      } else if (rule.operator === 'contains' && typeof rule.target_value === 'string') {
        matched = fieldValue.toLowerCase().includes(rule.target_value.toLowerCase());
      } else if (rule.operator === 'eq') {
        matched = fieldValue === String(rule.target_value);
      }

      if (matched) {
        totalScore += rule.points;
        breakdown.push({
          ruleId: rule.id,
          ruleName: rule.name,
          category: rule.category,
          points: rule.points,
        });
      }
    }

    const clampedScore = Math.max(0, Math.min(100, totalScore));

    if (input.leadId) {
      await this.db.query(
        `UPDATE leads
         SET lead_score = $2, lead_score_breakdown = $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [input.leadId, clampedScore, JSON.stringify(breakdown)],
      );
    }
    if (input.contactId) {
      await this.db.query(
        `UPDATE contacts
         SET lead_score = $2, lead_score_breakdown = $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [input.contactId, clampedScore, JSON.stringify(breakdown)],
      );
    }

    return {
      totalScore: clampedScore,
      breakdown,
    };
  }

  async importApolloProspects(
    user: SessionUser,
    prospects: Array<{
      apolloPersonId: string;
      firstName: string;
      lastName: string;
      email: string;
      title: string;
      firmName: string;
      domain: string;
      market: Market;
    }>,
    creditsPerProspect = 1,
  ): Promise<{
    createdCount: number;
    deduplicatedCount: number;
    creditsConsumed: number;
    remainingDailyCredits: number;
  }> {
    requireCapability(user, 'contacts.write');

    const [usedRes, capRes] = await Promise.all([
      this.db.query<{ used: number }>(
        `SELECT COALESCE(SUM(credits_used), 0)::int AS used
         FROM apollo_credit_ledger
         WHERE created_at >= CURRENT_DATE`,
      ),
      this.db.query<{ value_json: number }>(
        `SELECT value_json FROM settings WHERE key = 'apollo.daily_credit_limit' LIMIT 1`,
      ),
    ]);

    const usedToday = usedRes.rows[0]?.used ?? 0;
    const dailyCap = Number(capRes.rows[0]?.value_json ?? 200);

    let createdCount = 0;
    let deduplicatedCount = 0;
    let creditsConsumed = 0;

    await this.db.transaction(async (tx) => {
      for (const p of prospects) {
        const cleanEmail = normalizeEmail(p.email);
        if (!cleanEmail) continue;

        if (
          await this.isAddressOrDomainSuppressed(cleanEmail, normalizeCompanyDomain(p.domain), tx)
        ) {
          continue;
        }

        const existingRes = await tx.query<{ id: string }>(
          `SELECT id FROM contacts
           WHERE (apollo_person_id = $1 OR primary_email = $2) AND deleted_at IS NULL
           LIMIT 1`,
          [p.apolloPersonId, cleanEmail],
        );

        if (existingRes.rows[0]) {
          deduplicatedCount += 1;
          await tx.query(
            `UPDATE contacts
             SET apollo_person_id = COALESCE(apollo_person_id, $2),
                 updated_at = NOW()
             WHERE id = $1`,
            [existingRes.rows[0].id, p.apolloPersonId],
          );
          await this.upsertExternalId(tx, {
            provider: 'apollo',
            entityType: 'contact',
            entityId: existingRes.rows[0].id,
            externalId: p.apolloPersonId,
          });
          continue;
        }

        if (usedToday + creditsConsumed + creditsPerProspect > dailyCap) {
          throw new DomainError({
            status: 422,
            code: 'APOLLO_CREDIT_CAP_EXCEEDED',
            title: 'Apollo daily credit cap reached',
            detail: `Daily Apollo credit cap (${dailyCap}) reached; ${usedToday + creditsConsumed} credits already used today.`,
          });
        }

        creditsConsumed += creditsPerProspect;
        createdCount += 1;

        const contactId = `cnt_${randomUUID()}`;
        await tx.query(
          `INSERT INTO contacts (
             id, first_name, last_name, full_name, title, primary_email,
             market, owner_user_id, team_id, apollo_person_id, email_verification_status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid')`,
          [
            contactId,
            p.firstName,
            p.lastName,
            `${p.firstName} ${p.lastName}`.trim(),
            p.title,
            cleanEmail,
            p.market,
            user.id,
            user.teamId ?? 'team_us',
            p.apolloPersonId,
          ],
        );

        await tx.query(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
           VALUES ($1, $2, $3, TRUE, 'valid')
           ON CONFLICT (email) DO NOTHING`,
          [`ce_${randomUUID()}`, contactId, cleanEmail],
        );

        await this.upsertExternalId(tx, {
          provider: 'apollo',
          entityType: 'contact',
          entityId: contactId,
          externalId: p.apolloPersonId,
        });

        await tx.query(
          `INSERT INTO apollo_credit_ledger (id, action, credits_used, apollo_person_id, entity_type, entity_id, actor_user_id)
           VALUES ($1, 'prospect_import', $2, $3, 'contact', $4, $5)`,
          [`acl_${randomUUID()}`, creditsPerProspect, p.apolloPersonId, contactId, user.id],
        );
      }
    });

    return {
      createdCount,
      deduplicatedCount,
      creditsConsumed,
      remainingDailyCredits: Math.max(0, dailyCap - (usedToday + creditsConsumed)),
    };
  }

  async handleMicrosoftBookingsEvent(input: {
    customerEmail: string;
    customerName: string;
    serviceName: string;
    startTimeIso: string;
  }): Promise<{ activityId: string; taskId: string; contactId: string | null }> {
    const cleanEmail = normalizeEmail(input.customerEmail) ?? input.customerEmail.toLowerCase();

    return this.db.transaction(async (tx) => {
      const cntRes = await tx.query<{
        id: string;
        company_id: string | null;
        owner_user_id: string;
        team_id: string | null;
      }>(
        `SELECT id, company_id, owner_user_id, team_id
         FROM contacts
         WHERE primary_email = $1 AND deleted_at IS NULL
         LIMIT 1`,
        [cleanEmail],
      );
      const contact = cntRes.rows[0];
      const ownerId = contact?.owner_user_id ?? 'usr_mgr_1';

      const activityId = `act_${randomUUID()}`;
      await tx.query(
        `INSERT INTO activities (
           id, entity_type, entity_id, company_id, contact_id, activity_type, title, detail
         ) VALUES ($1, 'contact', $2, $3, $4, 'meeting_booked', $5, $6)`,
        [
          activityId,
          contact?.id ?? 'bookings',
          contact?.company_id ?? null,
          contact?.id ?? null,
          `Microsoft Bookings: ${input.serviceName}`,
          `Consultation scheduled for ${input.startTimeIso}`,
        ],
      );

      const taskId = `tsk_bk_${randomUUID()}`;
      await tx.query(
        `INSERT INTO tasks (
           id, title, task_type, priority, status, due_at,
           assignee_user_id, team_id, company_id, contact_id
         ) VALUES ($1, $2, 'call', 'high', 'open', $3, $4, $5, $6, $7)`,
        [
          taskId,
          `Bookings consultation prep: ${input.serviceName}`,
          input.startTimeIso,
          ownerId,
          contact?.team_id ?? 'team_us',
          contact?.company_id ?? null,
          contact?.id ?? null,
        ],
      );

      if (contact) {
        await this.db.addOutboxEvent(tx, {
          eventType: 'activity.logged',
          aggregateType: 'contact',
          aggregateId: contact.id,
          payload: {
            activityId,
            activityType: 'meeting_booked',
            contactId: contact.id,
            companyId: contact.company_id,
          },
        });
      }

      return {
        activityId,
        taskId,
        contactId: contact?.id ?? null,
      };
    });
  }

  signWebhookPayload(payloadJson: string, secretHmac: string): string {
    const digest = createHmac('sha256', secretHmac).update(payloadJson).digest('hex');
    return `sha256=${digest}`;
  }

  async dispatchPendingOutboxEventsToWebhooks(): Promise<{
    processedEvents: number;
    deliveries: Array<{ eventId: string; eventType: string; signatureHeader: string }>;
  }> {
    const [eventsRes, endpointsRes] = await Promise.all([
      this.db.query<{
        id: string;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
        created_at: Date | string;
      }>(`SELECT * FROM outbox_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`),
      this.db.query<{
        id: string;
        target_url: string;
        secret_hmac: string;
        secret_ciphertext: string | null;
        event_types: string[];
      }>(`SELECT * FROM webhook_endpoints WHERE active = TRUE`),
    ]);

    const deliveries: Array<{ eventId: string; eventType: string; signatureHeader: string }> = [];

    for (const evt of eventsRes.rows) {
      for (const ep of endpointsRes.rows) {
        const subscribed = Array.isArray(ep.event_types) ? ep.event_types : [];
        if (subscribed.includes(evt.event_type) || subscribed.includes('*')) {
          const envelope = {
            id: evt.id,
            eventType: evt.event_type,
            aggregateType: evt.aggregate_type,
            aggregateId: evt.aggregate_id,
            payload: evt.payload,
          };
          const body = JSON.stringify(envelope);
          const secret = this.openEndpointSecret({
            id: ep.id,
            secret_hmac: ep.secret_hmac,
            secret_ciphertext: ep.secret_ciphertext,
          });
          const signatureHeader = this.signWebhookPayload(body, secret);
          deliveries.push({
            eventId: evt.id,
            eventType: evt.event_type,
            signatureHeader,
          });

          await this.db.query(
            `INSERT INTO webhook_deliveries (
               id, endpoint_id, outbox_event_id, event_type, payload, status, available_at
             ) VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', NOW())
             ON CONFLICT (endpoint_id, outbox_event_id) DO NOTHING`,
            [`whd_${randomUUID()}`, ep.id, evt.id, evt.event_type, body],
          );
        }
      }
      await this.db.query(
        `UPDATE outbox_events SET status = 'processed', processed_at = NOW() WHERE id = $1`,
        [evt.id],
      );
    }

    return {
      processedEvents: eventsRes.rows.length,
      deliveries,
    };
  }

  async createApiToken(
    user: SessionUser,
    name: string,
    scopes: string[] = ['leads.read', 'deals.read'],
  ): Promise<{ id: string; rawToken: string; tokenPrefix: string }> {
    requireCapability(user, 'settings.manage');
    const rawToken = `adas_pat_${randomUUID().replace(/-/g, '')}`;
    const tokenPrefix = rawToken.slice(0, 14);
    const tokenSha256 = sha256Hex(rawToken);
    const id = `pat_${randomUUID()}`;

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO api_tokens (id, name, token_prefix, token_sha256, scopes, capabilities, scope_level, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $5::jsonb, 'team', $6)`,
        [id, name, tokenPrefix, tokenSha256, JSON.stringify(scopes), user.id],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'api_token.created',
        entityType: 'api_token',
        entityId: id,
        metadata: { name, tokenPrefix, scopes },
      });
    });

    return {
      id,
      rawToken,
      tokenPrefix,
    };
  }
}

export { registerIntelligenceRoutes } from './routes.js';
