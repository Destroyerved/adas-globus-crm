import { type Router } from '../../platform/http/router.js';
import { type IntelligenceService } from './index.js';

/**
 * Integrations, Apollo prospecting/enrichment, and Outbound Webhooks routes (PRD 4.14, 4.17).
 * Note: Public `/api/v1/webhooks/bookings` is handled directly on raw HTTP body in `main.ts`
 * so HMAC-SHA256 verification runs before authentication on `go.`.
 */
export function registerIntelligenceRoutes(
  router: Router,
  intelligence: IntelligenceService,
): void {
  const id = (params: Record<string, string>, key = 'id') => params[key] ?? '';

  // Admin integrations overview & Apollo credit limit
  router.get('/api/v1/admin/integrations', async (ctx) => {
    ctx.json(200, await intelligence.getIntegrationsOverview(ctx.user));
  });
  router.put('/api/v1/admin/apollo/credit-limit', async (ctx) => {
    ctx.json(
      200,
      await intelligence.updateApolloCreditLimit(ctx.user, (await ctx.body()) as never, ctx.ip),
    );
  });

  // Apollo prospecting & contact enrichment
  router.get('/api/v1/apollo/status', async (ctx) => {
    ctx.json(200, await intelligence.getApolloStatus(ctx.user));
  });
  router.post('/api/v1/apollo/search', async (ctx) => {
    ctx.json(200, await intelligence.searchApollo(ctx.user, (await ctx.body()) as never));
  });
  router.post('/api/v1/apollo/import', async (ctx) => {
    ctx.json(
      201,
      await intelligence.importFromApollo(ctx.user, (await ctx.body()) as never, ctx.ip),
    );
  });
  router.post('/api/v1/contacts/:id/enrich-apollo', async (ctx) => {
    ctx.json(
      200,
      await intelligence.enrichContactWithApollo(
        ctx.user,
        id(ctx.params),
        await ctx.body(),
        ctx.ip,
      ),
    );
  });

  // Outbound webhooks management
  router.get('/api/v1/admin/webhooks', async (ctx) => {
    ctx.json(200, await intelligence.listWebhooks(ctx.user));
  });
  router.post('/api/v1/admin/webhooks', async (ctx) => {
    ctx.json(201, await intelligence.createWebhook(ctx.user, (await ctx.body()) as never, ctx.ip));
  });
  router.patch('/api/v1/admin/webhooks/:id', async (ctx) => {
    ctx.json(
      200,
      await intelligence.updateWebhook(
        ctx.user,
        id(ctx.params),
        (await ctx.body()) as never,
        ctx.ip,
      ),
    );
  });
  router.delete('/api/v1/admin/webhooks/:id', async (ctx) => {
    ctx.json(200, await intelligence.deleteWebhook(ctx.user, id(ctx.params), ctx.ip));
  });
  router.get('/api/v1/admin/webhooks/:id/deliveries', async (ctx) => {
    ctx.json(200, await intelligence.listWebhookDeliveries(ctx.user, id(ctx.params)));
  });
  router.post('/api/v1/admin/webhooks/:id/test', async (ctx) => {
    ctx.json(200, await intelligence.testWebhook(ctx.user, id(ctx.params), ctx.ip));
  });
}
