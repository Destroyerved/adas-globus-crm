import { type Router } from '../../platform/http/router.js';
import { type HealthService } from './index.js';

/**
 * Authenticated Admin System Health & Dead-Letter Queue management routes
 * (PRD 6.9, 10.6, 11 Phase 1).
 * Public `/healthz` and `/api/v1/healthz` readiness checks are served before session auth in `main.ts`.
 */
export function registerHealthRoutes(router: Router, health: HealthService): void {
  const id = (params: Record<string, string>, key = 'id') => params[key] ?? '';

  router.get('/api/v1/admin/system-health', async (ctx) => {
    ctx.json(200, await health.getSystemHealthOverview(ctx.user));
  });

  router.post('/api/v1/admin/outbox/retry-all', async (ctx) => {
    ctx.json(200, await health.retryAllDeadLetters(ctx.user, ctx.ip));
  });

  router.post('/api/v1/admin/outbox/:id/retry', async (ctx) => {
    ctx.json(200, await health.retryDeadLetterEvent(ctx.user, id(ctx.params), ctx.ip));
  });

  router.delete('/api/v1/admin/outbox/:id', async (ctx) => {
    ctx.json(200, await health.purgeDeadLetterEvent(ctx.user, id(ctx.params), ctx.ip));
  });
}
