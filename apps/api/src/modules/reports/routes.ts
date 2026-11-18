import { type Router } from '../../platform/http/router.js';
import { type ReportsService } from './reports.service.js';

/** Standard reports & audited CSV export (PRD 4.15, 9, 14). */
export function registerReportRoutes(router: Router, reports: ReportsService): void {
  router.get('/api/v1/reports/options', async (ctx) =>
    ctx.json(200, await reports.options(ctx.user)),
  );
  router.get('/api/v1/reports/:id', async (ctx) =>
    ctx.json(200, await reports.run(ctx.user, ctx.params['id'] ?? '', ctx.query)),
  );
  router.get('/api/v1/reports/:id/export.csv', async (ctx) => {
    const file = await reports.exportCsv(ctx.user, ctx.params['id'] ?? '', ctx.query, ctx.ip);
    ctx.send(200, 'text/csv; charset=utf-8', file.csv, {
      'Content-Disposition': `attachment; filename="${file.filename.replace(/[^\w.-]+/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
  });
}
