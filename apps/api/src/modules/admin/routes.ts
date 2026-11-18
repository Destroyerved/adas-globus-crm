import { type Router } from '../../platform/http/router.js';
import { type AdminService } from './admin.service.js';

/** Administration routes (PRD 4.17). Every service method checks the capability itself. */
export function registerAdminRoutes(router: Router, admin: AdminService): void {
  const id = (params: Record<string, string>, key = 'id') => params[key] ?? '';

  router.get('/api/v1/admin/users', async (ctx) => ctx.json(200, await admin.listUsers(ctx.user)));
  router.post('/api/v1/admin/users', async (ctx) =>
    ctx.json(201, await admin.inviteUser(ctx.user, await ctx.body(), ctx.ip)),
  );
  router.patch('/api/v1/admin/users/:id', async (ctx) =>
    ctx.json(200, await admin.updateUser(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );

  router.get('/api/v1/admin/teams', async (ctx) => ctx.json(200, await admin.listTeams(ctx.user)));
  router.post('/api/v1/admin/teams', async (ctx) =>
    ctx.json(201, await admin.createTeam(ctx.user, await ctx.body(), ctx.ip)),
  );
  router.patch('/api/v1/admin/teams/:id', async (ctx) =>
    ctx.json(200, await admin.updateTeam(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );

  router.get('/api/v1/admin/roles', async (ctx) => ctx.json(200, await admin.listRoles(ctx.user)));
  router.put('/api/v1/admin/roles/:id/capabilities', async (ctx) =>
    ctx.json(
      200,
      await admin.updateRoleCapabilities(ctx.user, id(ctx.params), await ctx.body(), ctx.ip),
    ),
  );

  router.get('/api/v1/admin/pipelines', async (ctx) =>
    ctx.json(200, await admin.listPipelines(ctx.user)),
  );
  router.post('/api/v1/admin/pipelines/:id/stages', async (ctx) =>
    ctx.json(201, await admin.createStage(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );
  router.patch('/api/v1/admin/stages/:id', async (ctx) =>
    ctx.json(200, await admin.updateStage(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );
  router.post('/api/v1/admin/stages/:id/move', async (ctx) =>
    ctx.json(200, await admin.moveStage(ctx.user, id(ctx.params), await ctx.body(), ctx.ip)),
  );
  router.delete('/api/v1/admin/stages/:id', async (ctx) =>
    ctx.json(200, await admin.deleteStage(ctx.user, id(ctx.params), ctx.ip)),
  );

  router.get('/api/v1/admin/settings', async (ctx) =>
    ctx.json(200, await admin.listSettings(ctx.user)),
  );
  router.put('/api/v1/admin/settings/:key', async (ctx) =>
    ctx.json(
      200,
      await admin.updateSetting(
        ctx.user,
        decodeURIComponent(id(ctx.params, 'key')),
        await ctx.body(),
        ctx.ip,
      ),
    ),
  );

  router.get('/api/v1/admin/fx-rates', async (ctx) =>
    ctx.json(200, await admin.listFxRates(ctx.user)),
  );
  router.post('/api/v1/admin/fx-rates', async (ctx) =>
    ctx.json(201, await admin.upsertFxRate(ctx.user, await ctx.body(), ctx.ip)),
  );
  router.delete('/api/v1/admin/fx-rates/:id', async (ctx) =>
    ctx.json(200, await admin.deleteFxRate(ctx.user, id(ctx.params), ctx.ip)),
  );

  router.get('/api/v1/audit-logs', async (ctx) =>
    ctx.json(200, await admin.listAuditLogs(ctx.user, ctx.query)),
  );
  router.get('/api/v1/audit-logs/actions', async (ctx) =>
    ctx.json(200, await admin.auditActions(ctx.user)),
  );
}
