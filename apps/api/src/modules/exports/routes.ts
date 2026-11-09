import { type Router } from '../../platform/http/router.js';
import { type ExportService } from './service.js';

/** Export routes (PRD 4.9, 6.11). Every service method checks `exports.run` and ownership. */
export function registerExportRoutes(router: Router, exports: ExportService): void {
  const id = (params: Record<string, string>) => params['id'] ?? '';

  router.post('/api/v1/exports', async (ctx) =>
    ctx.json(201, await exports.create(ctx.user, await ctx.body(), ctx.ip)),
  );
  router.get('/api/v1/exports/:id', async (ctx) =>
    ctx.json(200, await exports.get(ctx.user, id(ctx.params))),
  );
  // Files are served only through the API, to the person who asked (PRD 6.11).
  router.get('/api/v1/exports/:id/download', async (ctx) => {
    const file = await exports.download(ctx.user, id(ctx.params), ctx.ip);
    ctx.send(200, 'text/csv; charset=utf-8', file.csv, {
      'Content-Disposition': `attachment; filename="${file.filename.replace(/[^\w.-]+/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
  });
}
