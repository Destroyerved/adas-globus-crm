import { type Router } from '../../platform/http/router.js';
import { type ImportService } from './service.js';

/** Import routes (PRD 4.9, 6.7). Every service method checks `imports.run` and scope itself. */
export function registerImportRoutes(
  router: Router,
  imports: ImportService,
  /** MAX_IMPORT_UPLOAD_BYTES (PRD 4.9: 50 MB). */
  maxBytes: number,
): void {
  const id = (params: Record<string, string>) => params['id'] ?? '';

  // The file is the raw request body; its name travels in a header, never in the URL.
  router.post('/api/v1/imports', async (ctx) => {
    const header = ctx.req.headers['x-upload-filename'];
    let filename = 'import';
    if (typeof header === 'string' && header) {
      try {
        filename = decodeURIComponent(header);
      } catch {
        filename = 'import';
      }
    }
    const data = await ctx.raw(maxBytes);
    ctx.json(201, await imports.upload(ctx.user, filename, data, ctx.ip));
  });
  router.get('/api/v1/imports', async (ctx) => ctx.json(200, await imports.list(ctx.user)));
  router.get('/api/v1/imports/templates', async (ctx) =>
    ctx.json(200, await imports.listTemplates(ctx.user, ctx.query.get('entity'))),
  );
  router.post('/api/v1/imports/templates', async (ctx) =>
    ctx.json(201, await imports.saveTemplate(ctx.user, await ctx.body())),
  );
  router.get('/api/v1/imports/:id', async (ctx) =>
    ctx.json(200, await imports.get(ctx.user, id(ctx.params))),
  );
  router.put('/api/v1/imports/:id/mapping', async (ctx) =>
    ctx.json(200, await imports.setMapping(ctx.user, id(ctx.params), await ctx.body())),
  );
  router.post('/api/v1/imports/:id/dry-run', async (ctx) =>
    ctx.json(200, await imports.requestDryRun(ctx.user, id(ctx.params), await ctx.body())),
  );
  router.post('/api/v1/imports/:id/run', async (ctx) =>
    ctx.json(200, await imports.requestRun(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );
  router.post('/api/v1/imports/:id/rollback', async (ctx) =>
    ctx.json(200, await imports.requestUndo(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );
  router.get('/api/v1/imports/:id/rows', async (ctx) =>
    ctx.json(200, await imports.rows(ctx.user, id(ctx.params), ctx.query)),
  );
  router.get('/api/v1/imports/:id/errors.csv', async (ctx) => {
    const file = await imports.errorsFile(ctx.user, id(ctx.params), ctx.ip);
    ctx.send(200, 'text/csv; charset=utf-8', file.csv, {
      'Content-Disposition': `attachment; filename="${file.filename.replace(/[^\w.-]+/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
  });
}
