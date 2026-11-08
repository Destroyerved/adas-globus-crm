import { type Router } from '../../platform/http/router.js';
import { type DashboardService } from './dashboard.service.js';

/** Role dashboard (PRD 4.2): the layout, then one request per widget. */
export function registerDashboardRoutes(router: Router, dashboard: DashboardService): void {
  router.get('/api/v1/dashboard', async (ctx) => ctx.json(200, await dashboard.layout(ctx.user)));
  router.get('/api/v1/dashboard/widgets/:id', async (ctx) =>
    ctx.json(200, await dashboard.widget(ctx.user, ctx.params['id'] ?? '', ctx.query)),
  );
}
