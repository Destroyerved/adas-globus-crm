import { type Router } from '../../platform/http/router.js';
import { type InboxService } from './inbox.service.js';

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value) && value[0]) return value[0].trim() || null;
  return null;
}

export function registerInboxRoutes(router: Router, inbox: InboxService): void {
  router.get('/api/v1/inbox/mailbox', async (ctx) => {
    ctx.json(200, await inbox.getMailboxStatus(ctx.user));
  });

  router.post('/api/v1/inbox/mailbox/sync', async (ctx) => {
    ctx.json(200, await inbox.syncUserMailboxNow(ctx.user));
  });

  router.post('/api/v1/inbox/mailbox/disconnect', async (ctx) => {
    ctx.json(200, await inbox.disconnectMailbox(ctx.user, ctx.ip));
  });

  router.get('/api/v1/admin/mailboxes', async (ctx) => {
    ctx.json(200, await inbox.listAdminMailboxes(ctx.user));
  });

  router.get('/api/v1/inbox/threads', async (ctx) => {
    ctx.json(200, await inbox.listThreads(ctx.user, Object.fromEntries(ctx.query.entries())));
  });

  router.get('/api/v1/inbox/threads/:id', async (ctx) => {
    ctx.json(200, await inbox.getThreadDetail(ctx.user, ctx.params['id'] ?? ''));
  });

  router.post('/api/v1/inbox/send', async (ctx) => {
    const idem = headerString(ctx.req.headers['idempotency-key']);
    ctx.json(201, await inbox.sendEmail(ctx.user, await ctx.body(), idem));
  });

  router.post('/api/v1/inbox/threads/:id/reply', async (ctx) => {
    const idem = headerString(ctx.req.headers['idempotency-key']);
    ctx.json(
      201,
      await inbox.replyToThread(ctx.user, ctx.params['id'] ?? '', await ctx.body(), idem),
    );
  });

  router.patch('/api/v1/inbox/threads/:id', async (ctx) => {
    ctx.json(200, await inbox.updateThread(ctx.user, ctx.params['id'] ?? '', await ctx.body()));
  });

  router.post('/api/v1/inbox/messages/:id/task', async (ctx) => {
    ctx.json(
      201,
      await inbox.createTaskFromMessage(ctx.user, ctx.params['id'] ?? '', await ctx.body()),
    );
  });

  router.post('/api/v1/inbox/manual-link', async (ctx) => {
    ctx.json(200, await inbox.manualLinkMessage(ctx.user, await ctx.body()));
  });

  router.get('/api/v1/inbox/messages/:messageId/attachments/:attachmentId', async (ctx) => {
    const file = await inbox.downloadAttachmentOnDemand(
      ctx.user,
      ctx.params['messageId'] ?? '',
      ctx.params['attachmentId'] ?? '',
    );
    ctx.send(200, file.mimeType, file.buffer, {
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'private, no-store',
    });
  });

  router.get('/api/v1/inbox/templates', async (ctx) => {
    ctx.json(200, await inbox.listTemplates(ctx.user));
  });

  router.post('/api/v1/inbox/templates', async (ctx) => {
    ctx.json(201, await inbox.createTemplate(ctx.user, await ctx.body()));
  });
}
