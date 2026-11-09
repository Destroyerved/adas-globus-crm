import { type Router } from '../../platform/http/router.js';
import { type DuplicateService } from './service.js';

/**
 * Duplicate queue, merge and undo routes (PRD 4.9, 6.7). Every service method checks
 * `duplicates.merge`, write access and scope itself.
 */
export function registerDuplicateRoutes(router: Router, duplicates: DuplicateService): void {
  const id = (params: Record<string, string>) => params['id'] ?? '';

  router.get('/api/v1/duplicates', async (ctx) =>
    ctx.json(200, await duplicates.list(ctx.user, ctx.query)),
  );
  router.get('/api/v1/duplicates/:id', async (ctx) =>
    ctx.json(200, await duplicates.get(ctx.user, id(ctx.params))),
  );
  router.post('/api/v1/duplicates/:id/dismiss', async (ctx) =>
    ctx.json(200, await duplicates.dismiss(ctx.user, id(ctx.params), ctx.ip)),
  );

  for (const [path, entity] of [
    ['contacts', 'contact'],
    ['companies', 'company'],
  ] as const) {
    router.get(`/api/v1/${path}/:id/merge-preview`, async (ctx) =>
      ctx.json(
        200,
        await duplicates.preview(ctx.user, entity, id(ctx.params), ctx.query.get('with') ?? ''),
      ),
    );
    router.post(`/api/v1/${path}/:id/merge`, async (ctx) =>
      ctx.json(
        200,
        await duplicates.merge(ctx.user, entity, id(ctx.params), await ctx.body(), ctx.ip),
      ),
    );
  }

  router.get('/api/v1/merges', async (ctx) =>
    ctx.json(200, await duplicates.listMerges(ctx.user, ctx.query.get('entity'))),
  );
  router.get('/api/v1/merges/:id', async (ctx) =>
    ctx.json(200, await duplicates.getMerge(ctx.user, id(ctx.params))),
  );
  router.post('/api/v1/merges/:id/undo', async (ctx) =>
    ctx.json(200, await duplicates.undo(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );
}
