import { type Router } from '../../platform/http/router.js';
import { parseListRequest } from '../../platform/list/index.js';
import { type CrmService } from './index.js';
import { BulkActionService } from './bulk.js';
import { CrmListService, LEAD_LIST, TASK_LIST } from './lists.js';
import { CrmRecordService } from './records.js';
import { SavedViewService } from './saved-views.js';
import { CrmTimelineService } from './timeline.js';

/**
 * HTTP routes for companies, contacts, leads, deals, tasks, notes, tags, activities, saved views,
 * bulk actions and timelines (PRD 6.7). Controllers stay thin: parse, call the service, return JSON.
 */
export function registerCrmRoutes(
  router: Router,
  services: {
    crm: CrmService;
    lists: CrmListService;
    records: CrmRecordService;
    timeline: CrmTimelineService;
    savedViews?: SavedViewService;
    bulk?: BulkActionService;
  },
): void {
  const { crm, lists, records, timeline, savedViews, bulk } = services;

  // ---- Leads (PRD 4.5)
  router.get('/api/v1/leads', async (ctx) => {
    ctx.json(
      200,
      await lists.list('leads', ctx.user, parseListRequest(ctx.query, LEAD_LIST.defaultSort)),
    );
  });
  router.post('/api/v1/leads', async (ctx) => {
    ctx.json(201, await crm.createLead(ctx.user, (await ctx.body()) as never));
  });
  router.post('/api/v1/leads/convert', async (ctx) => {
    ctx.json(200, await crm.convertLead(ctx.user, (await ctx.body()) as never));
  });
  if (bulk) {
    router.post('/api/v1/leads/bulk', async (ctx) => {
      const res = await bulk.submit(ctx.user, 'lead', await ctx.body(), ctx.ip);
      ctx.json(res.background ? 202 : 200, res);
    });
  }
  router.post('/api/v1/leads/:id/convert', async (ctx) => {
    const body = await ctx.body();
    ctx.json(200, await crm.convertLead(ctx.user, { ...body, leadId: ctx.params['id'] } as never));
  });
  router.get('/api/v1/leads/:id', async (ctx) => {
    ctx.json(200, await timeline.leadProfile(ctx.user, ctx.params['id'] ?? ''));
  });
  router.patch('/api/v1/leads/:id', async (ctx) => {
    ctx.json(200, await records.updateLead(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });
  router.delete('/api/v1/leads/:id', async (ctx) => {
    ctx.json(200, await records.softDelete(ctx.user, 'lead', ctx.params['id'] ?? '', ctx.ip));
  });

  // ---- Contacts (PRD 4.4)
  router.get('/api/v1/contacts', async (ctx) => {
    ctx.json(
      200,
      await lists.list('contacts', ctx.user, parseListRequest(ctx.query, '-updatedAt')),
    );
  });
  router.post('/api/v1/contacts', async (ctx) => {
    ctx.json(201, await crm.createContact(ctx.user, (await ctx.body()) as never));
  });
  if (bulk) {
    router.post('/api/v1/contacts/bulk', async (ctx) => {
      const res = await bulk.submit(ctx.user, 'contact', await ctx.body(), ctx.ip);
      ctx.json(res.background ? 202 : 200, res);
    });
  }
  router.get('/api/v1/contacts/:id', async (ctx) => {
    ctx.json(200, await timeline.contactProfile(ctx.user, ctx.params['id'] ?? ''));
  });
  router.patch('/api/v1/contacts/:id', async (ctx) => {
    ctx.json(200, await records.updateContact(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });
  router.delete('/api/v1/contacts/:id', async (ctx) => {
    ctx.json(200, await records.softDelete(ctx.user, 'contact', ctx.params['id'] ?? '', ctx.ip));
  });

  // ---- Companies (PRD 4.3)
  router.get('/api/v1/companies', async (ctx) => {
    ctx.json(
      200,
      await lists.list('companies', ctx.user, parseListRequest(ctx.query, '-updatedAt')),
    );
  });
  router.post('/api/v1/companies', async (ctx) => {
    const result = await crm.createOrFindCompany(ctx.user, (await ctx.body()) as never);
    ctx.json(result.created ? 201 : 200, result);
  });
  if (bulk) {
    router.post('/api/v1/companies/bulk', async (ctx) => {
      const res = await bulk.submit(ctx.user, 'company', await ctx.body(), ctx.ip);
      ctx.json(res.background ? 202 : 200, res);
    });
  }
  router.get('/api/v1/companies/:id', async (ctx) => {
    ctx.json(200, await crm.getCompanyProfile(ctx.user, ctx.params['id'] ?? ''));
  });
  router.patch('/api/v1/companies/:id', async (ctx) => {
    ctx.json(200, await records.updateCompany(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });
  router.delete('/api/v1/companies/:id', async (ctx) => {
    ctx.json(200, await records.softDelete(ctx.user, 'company', ctx.params['id'] ?? '', ctx.ip));
  });

  // ---- Deals and pipelines (PRD 3.3, 4.6)
  router.get('/api/v1/deals', async (ctx) => {
    ctx.json(200, await lists.list('deals', ctx.user, parseListRequest(ctx.query, '-updatedAt')));
  });
  router.post('/api/v1/deals', async (ctx) => {
    ctx.json(201, await crm.createDeal(ctx.user, (await ctx.body()) as never));
  });
  if (bulk) {
    router.post('/api/v1/deals/bulk', async (ctx) => {
      const res = await bulk.submit(ctx.user, 'deal', await ctx.body(), ctx.ip);
      ctx.json(res.background ? 202 : 200, res);
    });
  }
  router.get('/api/v1/deals/:id', async (ctx) => {
    ctx.json(200, await timeline.dealProfile(ctx.user, ctx.params['id'] ?? ''));
  });
  router.patch('/api/v1/deals/:id', async (ctx) => {
    ctx.json(200, await records.updateDeal(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });
  const moveStage = async (ctx: Parameters<Parameters<Router['post']>[1]>[0]) => {
    ctx.json(
      200,
      await crm.moveDealStage(ctx.user, ctx.params['id'] ?? '', (await ctx.body()) as never),
    );
  };
  router.patch('/api/v1/deals/:id/stage', moveStage);
  router.post('/api/v1/deals/:id/move', moveStage);
  router.delete('/api/v1/deals/:id', async (ctx) => {
    ctx.json(200, await records.softDelete(ctx.user, 'deal', ctx.params['id'] ?? '', ctx.ip));
  });
  router.get('/api/v1/pipelines', async (ctx) => {
    ctx.json(200, { items: await timeline.pipelines() });
  });
  router.get('/api/v1/pipelines/:id/board', async (ctx) => {
    ctx.json(
      200,
      await lists.board(ctx.user, ctx.params['id'] ?? '', {
        ownerId: ctx.query.get('owner'),
        q: (ctx.query.get('q') ?? '').trim().slice(0, 200),
      }),
    );
  });

  // ---- Tasks (PRD 4.7)
  router.get('/api/v1/tasks', async (ctx) => {
    ctx.json(
      200,
      await lists.list('tasks', ctx.user, parseListRequest(ctx.query, TASK_LIST.defaultSort), {
        taskView: ctx.query.get('view') ?? 'open',
      }),
    );
  });
  router.post('/api/v1/tasks', async (ctx) => {
    ctx.json(201, await crm.createTask(ctx.user, (await ctx.body()) as never));
  });
  router.patch('/api/v1/tasks/:id', async (ctx) => {
    ctx.json(200, await records.updateTask(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });
  router.post('/api/v1/tasks/:id/complete', async (ctx) => {
    ctx.json(200, await records.completeTask(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });

  // ---- Timeline, activities, notes, tags, reference lists (PRD 3.4, 4.7)
  router.get('/api/v1/timeline', async (ctx) => {
    ctx.json(
      200,
      await timeline.timeline(
        ctx.user,
        ctx.query.get('entityType') ?? '',
        ctx.query.get('entityId') ?? '',
        { before: ctx.query.get('before'), limit: Number(ctx.query.get('limit') ?? 50) },
      ),
    );
  });
  router.post('/api/v1/activities', async (ctx) => {
    ctx.json(201, await timeline.logActivity(ctx.user, await ctx.body()));
  });
  router.post('/api/v1/notes', async (ctx) => {
    ctx.json(201, await timeline.createNote(ctx.user, await ctx.body()));
  });
  router.patch('/api/v1/notes/:id', async (ctx) => {
    ctx.json(200, await timeline.updateNote(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });
  router.get('/api/v1/tags', async (ctx) => {
    ctx.json(200, { items: await timeline.listTags() });
  });
  router.put('/api/v1/tags/:entityType/:entityId', async (ctx) => {
    ctx.json(
      200,
      await timeline.setTags(
        ctx.user,
        ctx.params['entityType'] ?? '',
        ctx.params['entityId'] ?? '',
        await ctx.body(),
      ),
    );
  });
  router.get('/api/v1/reference-lists', async (ctx) => {
    ctx.json(200, await timeline.referenceLists());
  });

  // ---- Saved views (PRD 4.8) & bulk job progress (PRD 6.7)
  if (savedViews) {
    router.get('/api/v1/saved-views', async (ctx) => {
      ctx.json(200, await savedViews.list(ctx.user, ctx.query.get('entity') ?? ''));
    });
    router.post('/api/v1/saved-views', async (ctx) => {
      ctx.json(201, await savedViews.create(ctx.user, await ctx.body(), ctx.ip));
    });
    router.patch('/api/v1/saved-views/:id', async (ctx) => {
      ctx.json(
        200,
        await savedViews.update(ctx.user, ctx.params['id'] ?? '', await ctx.body(), ctx.ip),
      );
    });
    router.delete('/api/v1/saved-views/:id', async (ctx) => {
      ctx.json(200, await savedViews.remove(ctx.user, ctx.params['id'] ?? '', ctx.ip));
    });
  }
  if (bulk) {
    router.get('/api/v1/bulk-jobs/:id', async (ctx) => {
      ctx.json(200, await bulk.getJob(ctx.user, ctx.params['id'] ?? ''));
    });
  }
}

export {
  BulkActionService,
  CrmListService,
  CrmRecordService,
  CrmTimelineService,
  SavedViewService,
};
