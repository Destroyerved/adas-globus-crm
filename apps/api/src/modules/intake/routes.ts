import { type Router } from '../../platform/http/router.js';
import { type WebsiteIntakeService } from './index.js';

/**
 * Admin routes for market routing rules & recent website inquiry monitoring (PRD 4.10, 4.17).
 * Every service method enforces `settings.manage` directly.
 */
export function registerIntakeRoutes(router: Router, intake: WebsiteIntakeService): void {
  router.get('/api/v1/admin/routing-rules', async (ctx) => {
    ctx.json(200, await intake.listRoutingRules(ctx.user));
  });

  router.put('/api/v1/admin/routing-rules/:market', async (ctx) => {
    ctx.json(
      200,
      await intake.updateRoutingRule(
        ctx.user,
        ctx.params['market'] ?? '',
        await ctx.body(),
        ctx.ip,
      ),
    );
  });

  router.get('/api/v1/admin/inquiries', async (ctx) => {
    ctx.json(
      200,
      await intake.listRecentInquiries(ctx.user, {
        cursor: ctx.query.get('cursor') ?? undefined,
        limit: ctx.query.get('limit') ?? undefined,
        market: ctx.query.get('market') ?? undefined,
        formType: ctx.query.get('formType') ?? undefined,
      }),
    );
  });
}
