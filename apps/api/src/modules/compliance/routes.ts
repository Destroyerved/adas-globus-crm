import { PrivacyEraseInputSchema } from '@adas/shared';
import { type Router } from '../../platform/http/router.js';
import { requireCapability } from '../../platform/scope/index.js';
import { checkSendable, type ComplianceService } from './index.js';

/**
 * Signed-in HTTP routes for suppressions, suppressed domains, contact consent,
 * and privacy access / erasure operations (PRD 4.17, 4.18, 5.1–5.6).
 */
export function registerComplianceRoutes(router: Router, compliance: ComplianceService): void {
  router.post('/api/v1/compliance/check-sendable', async (ctx) => {
    requireCapability(ctx.user, 'compliance.manage');
    const body = await ctx.body();
    if (
      typeof body['email'] === 'string' &&
      body['suppressedEmail'] === undefined &&
      body['suppressedDomain'] === undefined
    ) {
      const channel =
        body['channel'] === 'campaign' || body['channel'] === 'one_to_one'
          ? body['channel']
          : 'sequence';
      ctx.json(
        200,
        await compliance.evaluateRecipientSendability({
          email: body['email'],
          channel,
          senderUserId: ctx.user.id,
          bypassSendWindow: Boolean(body['bypassSendWindow']),
        }),
      );
      return;
    }
    ctx.json(200, checkSendable(body as never));
  });

  router.get('/api/v1/compliance/suppressions', async (ctx) => {
    const query = Object.fromEntries(ctx.query.entries());
    ctx.json(200, await compliance.listSuppressions(ctx.user, query));
  });

  router.post('/api/v1/compliance/suppressions', async (ctx) => {
    ctx.json(201, await compliance.addManualSuppression(ctx.user, await ctx.body(), ctx.ip));
  });

  router.post('/api/v1/compliance/suppressions/:id/lift', async (ctx) => {
    ctx.json(
      200,
      await compliance.liftSuppression(
        ctx.user,
        ctx.params['id'] as string,
        await ctx.body(),
        ctx.ip,
      ),
    );
  });

  router.get('/api/v1/compliance/suppressed-domains', async (ctx) => {
    ctx.json(200, await compliance.listSuppressedDomains(ctx.user));
  });

  router.post('/api/v1/compliance/suppressed-domains', async (ctx) => {
    ctx.json(201, await compliance.addManualSuppressedDomain(ctx.user, await ctx.body(), ctx.ip));
  });

  router.post('/api/v1/compliance/suppressed-domains/:id/remove', async (ctx) => {
    ctx.json(
      200,
      await compliance.removeSuppressedDomain(
        ctx.user,
        ctx.params['id'] as string,
        await ctx.body(),
        ctx.ip,
      ),
    );
  });

  router.post('/api/v1/contacts/:id/consents', async (ctx) => {
    ctx.json(
      201,
      await compliance.recordContactConsent(
        ctx.user,
        ctx.params['id'] as string,
        await ctx.body(),
        ctx.ip,
      ),
    );
  });

  router.post('/api/v1/contacts/:id/consents/withdraw', async (ctx) => {
    ctx.json(
      200,
      await compliance.withdrawContactConsent(
        ctx.user,
        ctx.params['id'] as string,
        await ctx.body(),
        ctx.ip,
      ),
    );
  });

  router.get('/api/v1/contacts/:id/privacy-export', async (ctx) => {
    const contactId = ctx.params['id'] as string;
    if (ctx.query.get('format') === 'csv') {
      const { filename, csv } = await compliance.exportContactPrivacyCsv(
        ctx.user,
        contactId,
        ctx.ip,
      );
      ctx.send(200, 'text/csv; charset=utf-8', csv, {
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      return;
    }
    const bundle = await compliance.exportContactPrivacyData(ctx.user, contactId, ctx.ip);
    const day = String(bundle['exportedAt'] ?? new Date().toISOString()).slice(0, 10);
    ctx.json(200, bundle, {
      'Content-Disposition': `attachment; filename="privacy-export-${contactId}-${day}.json"`,
      'Cache-Control': 'no-store',
    });
  });

  router.post('/api/v1/contacts/:id/privacy-erase', async (ctx) => {
    const input = PrivacyEraseInputSchema.parse(await ctx.body());
    ctx.json(
      200,
      await compliance.eraseContactPrivacyData(ctx.user, ctx.params['id'] as string, {
        reason: input.reason,
        ipAddress: ctx.ip,
      }),
    );
  });
}
