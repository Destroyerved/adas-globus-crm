import { createHmac, randomUUID } from 'node:crypto';
import type { Currency, Market, SessionUser } from '@adas/shared';
import { type DatabaseService, sha256Hex } from '../../platform/db/index.js';
import { DomainError } from '../../platform/errors/index.js';
import { convertCurrencyMinor } from '../../platform/money/index.js';
import { normalizeEmail } from '../../platform/normalize/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';

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

export class IntelligenceService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * PRD §4.15 & §14 (A9) — Multi-currency pipeline rollup in integer minor units.
   * Converts CAD deals to USD using the `fx_rates` table (`rate_scaled`, 1_000_000 = 1.000000).
   */
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

  /**
   * PRD §4.16 — Configurable, explainable lead scoring engine.
   */
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

  /**
   * PRD §8.3 — Apollo prospect import & enrichment with daily credit guard and `apollo_person_id` deduplication.
   */
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

        // Check existing by apollo_person_id OR primary_email
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

        await tx.query(
          `INSERT INTO apollo_credit_ledger (id, action, credits_used, apollo_person_id, actor_user_id)
           VALUES ($1, 'prospect_import', $2, $3, $4)`,
          [`acl_${randomUUID()}`, creditsPerProspect, p.apolloPersonId, user.id],
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

  /**
   * PRD §8.4 — Microsoft Bookings webhook handler (creates meeting activity + prep task).
   */
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
          contact?.id ?? cleanEmail,
          contact?.company_id ?? null,
          contact?.id ?? null,
          `Microsoft Bookings: ${input.serviceName}`,
          `Scheduled by ${input.customerName} (${cleanEmail}) for ${input.startTimeIso}`,
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
          `Bookings consultation prep: ${input.customerName} (${input.serviceName})`,
          input.startTimeIso,
          ownerId,
          contact?.team_id ?? 'team_us',
          contact?.company_id ?? null,
          contact?.id ?? null,
        ],
      );

      return {
        activityId,
        taskId,
        contactId: contact?.id ?? null,
      };
    });
  }

  /**
   * PRD §8.5 & §8.6 — Sign and dispatch outbound webhook payloads for n8n + manage API tokens.
   */
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
      }>(`SELECT * FROM outbox_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`),
      this.db.query<{
        id: string;
        target_url: string;
        secret_hmac: string;
        event_types: string[];
      }>(`SELECT * FROM webhook_endpoints WHERE active = TRUE`),
    ]);

    const deliveries: Array<{ eventId: string; eventType: string; signatureHeader: string }> = [];

    for (const evt of eventsRes.rows) {
      for (const ep of endpointsRes.rows) {
        const subscribed = Array.isArray(ep.event_types) ? ep.event_types : [];
        if (subscribed.includes(evt.event_type)) {
          const body = JSON.stringify({
            id: evt.id,
            eventType: evt.event_type,
            aggregateType: evt.aggregate_type,
            aggregateId: evt.aggregate_id,
            payload: evt.payload,
          });
          const signatureHeader = this.signWebhookPayload(body, ep.secret_hmac);
          deliveries.push({
            eventId: evt.id,
            eventType: evt.event_type,
            signatureHeader,
          });
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
    scopes: string[] = ['leads:read', 'deals:read'],
  ): Promise<{ id: string; rawToken: string; tokenPrefix: string }> {
    requireCapability(user, 'settings.manage');
    const rawToken = `adas_pat_${randomUUID().replace(/-/g, '')}`;
    const tokenPrefix = rawToken.slice(0, 14);
    const tokenSha256 = sha256Hex(rawToken);
    const id = `pat_${randomUUID()}`;

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO api_tokens (id, name, token_prefix, token_sha256, scopes, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
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

    return { id, rawToken, tokenPrefix };
  }
}
