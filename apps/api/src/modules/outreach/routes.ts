import { type Router } from '../../platform/http/router.js';
import { type OutreachService } from './index.js';

export function registerOutreachRoutes(router: Router, outreach: OutreachService): void {
  // Templates (sequence, campaign, inbox)
  router.get('/api/v1/templates', async (ctx) => {
    const items = await outreach.listTemplates(ctx.user, {
      channel: ctx.query.get('channel') ?? undefined,
      market: ctx.query.get('market') ?? undefined,
      q: ctx.query.get('q') ?? undefined,
    });
    ctx.json(200, { items });
  });

  router.post('/api/v1/templates', async (ctx) => {
    ctx.json(201, await outreach.createTemplate(ctx.user, (await ctx.body()) as never));
  });

  router.patch('/api/v1/templates/:id', async (ctx) => {
    ctx.json(
      200,
      await outreach.updateTemplate(ctx.user, ctx.params['id'] ?? '', (await ctx.body()) as never),
    );
  });

  // Sequences (PRD 4.12)
  router.get('/api/v1/sequences', async (ctx) => {
    const items = await outreach.listSequences(ctx.user);
    ctx.json(200, { items });
  });

  router.post('/api/v1/sequences', async (ctx) => {
    ctx.json(201, await outreach.createSequence(ctx.user, (await ctx.body()) as never));
  });

  router.get('/api/v1/sequences/:id', async (ctx) => {
    ctx.json(200, await outreach.getSequenceDetail(ctx.user, ctx.params['id'] ?? ''));
  });

  router.patch('/api/v1/sequences/:id', async (ctx) => {
    ctx.json(
      200,
      await outreach.updateSequence(ctx.user, ctx.params['id'] ?? '', (await ctx.body()) as never),
    );
  });

  router.post('/api/v1/sequences/enroll', async (ctx) => {
    const body = (await ctx.body()) as Record<string, unknown>;
    const enrolled = await outreach.enrollInSequence(ctx.user, body as never);
    if (body['executeStepOneImmediately'] === true) {
      const stepResult = await outreach.executeSequenceEnrollmentStep(enrolled.enrollmentId, {
        bypassSendWindow: true,
      });
      ctx.json(201, { ...enrolled, stepOneSend: stepResult });
      return;
    }
    ctx.json(201, enrolled);
  });

  router.post('/api/v1/sequences/:id/enroll', async (ctx) => {
    const result = await outreach.batchEnrollInSequence(
      ctx.user,
      ctx.params['id'] ?? '',
      (await ctx.body()) as never,
    );
    ctx.json(201, result);
  });

  router.post('/api/v1/enrollments/:id/state', async (ctx) => {
    ctx.json(
      200,
      await outreach.updateEnrollmentState(
        ctx.user,
        ctx.params['id'] ?? '',
        (await ctx.body()) as never,
      ),
    );
  });

  router.post('/api/v1/enrollments/:id/stop', async (ctx) => {
    const raw = (await ctx.body().catch(() => ({}))) as Record<string, unknown>;
    ctx.json(
      200,
      await outreach.updateEnrollmentState(ctx.user, ctx.params['id'] ?? '', {
        action: 'stop',
        reason: typeof raw['reason'] === 'string' ? raw['reason'] : 'Stopped manually',
      }),
    );
  });

  // Static Lists & Dynamic Segments (PRD 4.13, 6.8)
  router.get('/api/v1/lists', async (ctx) => {
    const items = await outreach.listMarketingLists(ctx.user);
    ctx.json(200, { items });
  });

  router.post('/api/v1/lists', async (ctx) => {
    ctx.json(201, await outreach.createMarketingList(ctx.user, (await ctx.body()) as never));
  });

  router.get('/api/v1/lists/:id', async (ctx) => {
    ctx.json(200, await outreach.getMarketingListDetail(ctx.user, ctx.params['id'] ?? ''));
  });

  router.patch('/api/v1/lists/:id', async (ctx) => {
    ctx.json(
      200,
      await outreach.updateMarketingList(
        ctx.user,
        ctx.params['id'] ?? '',
        (await ctx.body()) as never,
      ),
    );
  });

  router.post('/api/v1/lists/:id/members', async (ctx) => {
    ctx.json(
      200,
      await outreach.addListMembers(ctx.user, ctx.params['id'] ?? '', (await ctx.body()) as never),
    );
  });

  router.delete('/api/v1/lists/:id/members/:contactId', async (ctx) => {
    ctx.json(
      200,
      await outreach.removeListMember(
        ctx.user,
        ctx.params['id'] ?? '',
        ctx.params['contactId'] ?? '',
      ),
    );
  });

  // Verified Sender Identities & Sending Subdomains (PRD 5.4, 4.17)
  router.get('/api/v1/sender-identities', async (ctx) => {
    const items = await outreach.listSenderIdentities(ctx.user);
    ctx.json(200, { items });
  });

  router.post('/api/v1/sender-identities', async (ctx) => {
    ctx.json(201, await outreach.createSenderIdentity(ctx.user, (await ctx.body()) as never));
  });

  router.patch('/api/v1/sender-identities/:id', async (ctx) => {
    ctx.json(
      200,
      await outreach.updateSenderIdentity(
        ctx.user,
        ctx.params['id'] ?? '',
        (await ctx.body()) as never,
      ),
    );
  });

  // Marketing Campaigns (PRD 4.13)
  router.get('/api/v1/campaigns', async (ctx) => {
    const items = await outreach.listCampaigns(ctx.user);
    ctx.json(200, { items });
  });

  router.post('/api/v1/campaigns', async (ctx) => {
    ctx.json(201, await outreach.createCampaign(ctx.user, (await ctx.body()) as never));
  });

  router.get('/api/v1/campaigns/:id', async (ctx) => {
    ctx.json(200, await outreach.getCampaignDetail(ctx.user, ctx.params['id'] ?? ''));
  });

  router.patch('/api/v1/campaigns/:id', async (ctx) => {
    ctx.json(
      200,
      await outreach.updateCampaign(ctx.user, ctx.params['id'] ?? '', (await ctx.body()) as never),
    );
  });

  router.get('/api/v1/campaigns/:id/preflight', async (ctx) => {
    ctx.json(200, await outreach.getCampaignPreflight(ctx.user, ctx.params['id'] ?? ''));
  });

  router.post('/api/v1/campaigns/:id/submit', async (ctx) => {
    ctx.json(200, await outreach.submitCampaignForApproval(ctx.user, ctx.params['id'] ?? ''));
  });

  router.post('/api/v1/campaigns/:id/approve', async (ctx) => {
    ctx.json(200, await outreach.approveCampaign(ctx.user, ctx.params['id'] ?? ''));
  });

  router.post('/api/v1/campaigns/:id/test-send', async (ctx) => {
    ctx.json(
      200,
      await outreach.testSendCampaign(
        ctx.user,
        ctx.params['id'] ?? '',
        (await ctx.body()) as never,
      ),
    );
  });

  router.post('/api/v1/campaigns/:id/schedule', async (ctx) => {
    ctx.json(
      200,
      await outreach.scheduleCampaign(
        ctx.user,
        ctx.params['id'] ?? '',
        (await ctx.body().catch(() => ({}))) as never,
      ),
    );
  });

  router.post('/api/v1/campaigns/:id/pause', async (ctx) => {
    const body = (await ctx.body().catch(() => ({}))) as Record<string, unknown>;
    ctx.json(
      200,
      await outreach.pauseCampaign(
        ctx.user,
        ctx.params['id'] ?? '',
        typeof body['reason'] === 'string' ? body['reason'] : 'Paused manually',
      ),
    );
  });

  router.post('/api/v1/campaigns/:id/cancel', async (ctx) => {
    ctx.json(200, await outreach.cancelCampaign(ctx.user, ctx.params['id'] ?? ''));
  });

  // Contact Outreach History (PRD 4.4)
  router.get('/api/v1/contacts/:id/outreach', async (ctx) => {
    ctx.json(200, await outreach.getContactOutreachHistory(ctx.user, ctx.params['id'] ?? ''));
  });
}
