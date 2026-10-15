import crypto from 'node:crypto';
import { config } from '../config.js';
import { get, all, run, insert, update } from '../db.js';
import { requireAuth, requireRole, createApiKey } from '../auth.js';
import { getSettings, publicSettings, saveSettings, getState, SECTIONS } from '../settings.js';
import { EVENT_TYPES, deliver } from '../events.js';
import { verifySmtp, sendEmail } from '../services/mailer.js';
import { testImap, syncInbox } from '../services/imap.js';
import * as apollo from '../services/apollo.js';
import { tick } from '../scheduler.js';
import { Router, HttpError, now, addMs, DAY, required, randomToken, tagsIn, tagsOut, jsonOut, isEmail } from '../util.js';

export const integrationRoutes = Router();
integrationRoutes.use(requireAuth);
const admin = requireRole('admin');

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
};

// ======================= SETTINGS =======================
integrationRoutes.get('/settings', (req, res) => {
  const out = {};
  for (const s of SECTIONS) out[s] = publicSettings(s);
  if (req.user.role !== 'admin') { delete out.smtp; delete out.imap; delete out.apollo; }
  res.json({ settings: out, base_url: config.baseUrl, imap_state: getState('imap', {}) });
});

integrationRoutes.put('/settings/:section', admin, (req, res) => {
  if (!SECTIONS.includes(req.params.section)) throw new HttpError(404, 'Unknown settings section');
  if (req.params.section === 'smtp' && req.body.from_email && !isEmail(req.body.from_email)) throw new HttpError(400, 'From email is not a valid address');
  res.json({ settings: saveSettings(req.params.section, req.body || {}) });
});

integrationRoutes.post('/settings/smtp/test', admin, async (req, res) => {
  try {
    await verifySmtp();
  } catch (err) {
    throw new HttpError(err.status || 502, `SMTP connection failed: ${err.message}`);
  }
  const to = req.body?.to || req.user.email;
  if (!isEmail(to)) return res.json({ ok: true, sent: false });
  const email = await sendEmail({
    to, subject: `Test email from ${getSettings('company').name} CRM`, user: req.user, force: true,
    body: '<p>Your SMTP settings work. Emails from the CRM will be sent through this server.</p>',
  });
  if (email.status !== 'sent') throw new HttpError(502, `Connected, but sending failed: ${email.error}`);
  res.json({ ok: true, sent: true, to, dry_run: getSettings('smtp').dry_run });
});

integrationRoutes.post('/settings/imap/test', admin, async (req, res) => res.json(await testImap()));
integrationRoutes.post('/settings/imap/sync', admin, async (req, res) => res.json(await syncInbox({ force: true })));

// ======================= APOLLO =======================
integrationRoutes.get('/apollo/status', (req, res) => {
  res.json({
    configured: !!getSettings('apollo').api_key,
    credits_30d: get("SELECT COALESCE(SUM(credits), 0) AS n FROM integration_log WHERE integration = 'apollo' AND created_at >= ?", addMs(-30 * DAY)).n,
    log: all("SELECT * FROM integration_log WHERE integration = 'apollo' ORDER BY id DESC LIMIT 25"),
  });
});
integrationRoutes.post('/apollo/test', admin, async (req, res) => res.json(await apollo.testConnection()));
integrationRoutes.post('/apollo/people/search', async (req, res) => res.json(await apollo.searchPeople(req.body || {})));
integrationRoutes.post('/apollo/people/import', async (req, res) => res.json(await apollo.importPeople(req.body || {}, req.user)));
integrationRoutes.post('/apollo/organizations/search', async (req, res) => res.json(await apollo.searchOrganizations(req.body || {})));
integrationRoutes.post('/apollo/organizations/import', async (req, res) => res.json(await apollo.importOrganizations(req.body || {}, req.user)));
integrationRoutes.post('/apollo/enrich/contact/:id', async (req, res) => res.json(await apollo.enrichContact(idParam(req), req.user, { overwrite: !!req.body?.overwrite })));
integrationRoutes.post('/apollo/enrich/contacts', async (req, res) => res.json(await apollo.enrichContacts(req.body?.ids || [], req.user)));
integrationRoutes.post('/apollo/enrich/company/:id', async (req, res) => res.json(await apollo.enrichCompany(idParam(req), req.user, { overwrite: !!req.body?.overwrite })));
integrationRoutes.get('/apollo/sequences', async (req, res) => res.json({ sequences: await apollo.listSequences() }));
integrationRoutes.get('/apollo/email-accounts', async (req, res) => res.json({ email_accounts: await apollo.listEmailAccounts() }));
integrationRoutes.post('/apollo/sequences/push', async (req, res) => res.json(await apollo.pushToSequence(req.body || {}, req.user)));

// ======================= WEBHOOKS (n8n, Make, Zapier, Slack…) =======================
function validWebhookUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}
function normalizeEvents(v) {
  const list = (Array.isArray(v) ? v : String(v || '*').split(',')).map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((e) => e !== '*' && !e.endsWith('.*') && !EVENT_TYPES.includes(e));
  if (bad.length) throw new HttpError(400, `Unknown event(s): ${bad.join(', ')}`);
  return list.length ? list.join(',') : '*';
}
function headersJson(v) {
  const obj = typeof v === 'string' ? jsonOut(v, null) : v;
  if (v && obj === null) throw new HttpError(400, 'Custom headers must be a JSON object');
  return JSON.stringify(obj || {});
}
const webhookOut = (w) => ({
  ...w,
  active: !!w.active,
  headers: jsonOut(w.headers),
  events: w.events.split(','),
  stats: get(`SELECT COUNT(*) AS total, COALESCE(SUM(success), 0) AS ok FROM webhook_deliveries WHERE webhook_id = ? AND created_at >= ?`, w.id, addMs(-7 * DAY)),
});

integrationRoutes.get('/webhooks', admin, (req, res) => {
  res.json({ webhooks: all('SELECT * FROM webhooks ORDER BY created_at DESC').map(webhookOut), events: EVENT_TYPES });
});
integrationRoutes.post('/webhooks', admin, (req, res) => {
  required(req.body || {}, ['url']);
  if (!validWebhookUrl(req.body.url)) throw new HttpError(400, 'Webhook URL must start with http:// or https://');
  const id = insert('webhooks', {
    name: req.body.name || new URL(req.body.url).hostname, url: req.body.url.trim(), events: normalizeEvents(req.body.events),
    secret: req.body.secret || `whsec_${randomToken(24)}`, headers: headersJson(req.body.headers), active: req.body.active === false ? 0 : 1, created_at: now(),
  });
  res.status(201).json({ webhook: webhookOut(get('SELECT * FROM webhooks WHERE id = ?', id)) });
});
integrationRoutes.patch('/webhooks/:id', admin, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM webhooks WHERE id = ?', id)) throw new HttpError(404, 'Webhook not found');
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.url !== undefined) {
    if (!validWebhookUrl(req.body.url)) throw new HttpError(400, 'Webhook URL must start with http:// or https://');
    patch.url = req.body.url.trim();
  }
  if (req.body.events !== undefined) patch.events = normalizeEvents(req.body.events);
  if (req.body.headers !== undefined) patch.headers = headersJson(req.body.headers);
  if (req.body.active !== undefined) patch.active = req.body.active ? 1 : 0;
  update('webhooks', id, patch);
  res.json({ webhook: webhookOut(get('SELECT * FROM webhooks WHERE id = ?', id)) });
});
integrationRoutes.post('/webhooks/:id/rotate-secret', admin, (req, res) => {
  const id = idParam(req);
  update('webhooks', id, { secret: `whsec_${randomToken(24)}` });
  res.json({ webhook: webhookOut(get('SELECT * FROM webhooks WHERE id = ?', id)) });
});
integrationRoutes.delete('/webhooks/:id', admin, (req, res) => {
  run('DELETE FROM webhooks WHERE id = ?', idParam(req));
  res.json({ ok: true });
});
integrationRoutes.post('/webhooks/:id/test', admin, async (req, res) => {
  const hook = get('SELECT * FROM webhooks WHERE id = ?', idParam(req));
  if (!hook) throw new HttpError(404, 'Webhook not found');
  const event = req.body?.event && EVENT_TYPES.includes(req.body.event) ? req.body.event : 'contact.created';
  const payload = { id: crypto.randomUUID(), event, created_at: now(), source: 'adas-globus-crm', test: true, data: samplePayload(event) };
  res.json(await deliver(hook, payload, 1));
});
integrationRoutes.get('/webhooks/:id/deliveries', admin, (req, res) => {
  res.json({
    deliveries: all(`SELECT id, event, status_code, response, attempt, success, next_retry_at, duration_ms, created_at, payload
                     FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 100`, idParam(req)),
  });
});
integrationRoutes.post('/webhook-deliveries/:id/redeliver', admin, async (req, res) => {
  const d = get('SELECT * FROM webhook_deliveries WHERE id = ?', idParam(req));
  if (!d) throw new HttpError(404, 'Delivery not found');
  const hook = get('SELECT * FROM webhooks WHERE id = ?', d.webhook_id);
  res.json(await deliver(hook, JSON.parse(d.payload), d.attempt + 1));
});

integrationRoutes.get('/events', (req, res) => {
  res.json({ events: EVENT_TYPES.map((e) => ({ event: e, sample: samplePayload(e) })) });
});

function samplePayload(event) {
  const contact = { id: 1, first_name: 'Priya', last_name: 'Sharma', full_name: 'Priya Sharma', email: 'priya@example.com', title: 'Head of Procurement', company_id: 1, company_name: 'Example Industries', status: 'lead', tags: ['apollo'], score: 4, owner_id: 1, owner_name: 'Admin' };
  const deal = { id: 1, title: 'Example Industries – annual contract', value: 25000, stage_id: 3, stage_name: 'Meeting booked', status: 'open', contact_id: 1, contact_name: 'Priya Sharma', company_id: 1, company_name: 'Example Industries', owner_id: 1 };
  const email = { id: 1, direction: 'out', status: 'sent', subject: 'Quick idea for Example Industries', to_addr: 'priya@example.com', contact_id: 1, open_count: 1 };
  const activity = { id: 1, type: event.startsWith('task') ? 'task' : 'note', subject: 'Follow up on proposal', contact_id: 1, contact_name: 'Priya Sharma', due_at: now(), done: event === 'task.completed' };
  const [entity] = event.split('.');
  if (entity === 'contact' || entity === 'contacts') return event === 'contacts.imported' ? { created: 10, updated: 2, skipped: 0 } : { contact };
  if (entity === 'company') return { company: { id: 1, name: 'Example Industries', domain: 'example.com', industry: 'Manufacturing' } };
  if (entity === 'deal') return event === 'deal.stage_changed' ? { deal, from_stage: { id: 2, name: 'Qualified' }, to_stage: { id: 3, name: 'Meeting booked' } } : { deal };
  if (entity === 'email') return { email, contact };
  if (entity === 'activity' || entity === 'task') return { activity };
  if (entity === 'sequence') return { sequence: { id: 1, name: 'Cold outreach (4 steps)' }, contact };
  if (entity === 'form') return { form: { id: 1, name: 'Website contact form' }, contact, fields: { message: 'Hello!' } };
  if (entity === 'apollo') return { created: 5, updated: 1, contact_ids: [1, 2, 3, 4, 5, 6], credits_used: 6 };
  return {};
}

// ======================= API KEYS =======================
integrationRoutes.get('/api-keys', admin, (req, res) => {
  res.json({
    api_keys: all(`SELECT k.id, k.name, k.prefix, k.revoked, k.created_at, k.last_used_at, u.name AS user_name
                   FROM api_keys k LEFT JOIN users u ON u.id = k.user_id ORDER BY k.revoked, k.created_at DESC`),
  });
});
integrationRoutes.post('/api-keys', admin, (req, res) => {
  const name = String(req.body?.name || '').trim() || 'n8n';
  if (!req.user.id) throw new HttpError(400, 'Create API keys from a signed-in user, not with another API key');
  const { id, key } = createApiKey(name, req.user.id);
  res.status(201).json({ id, name, key, note: 'Copy this key now. It will not be shown again.' });
});
integrationRoutes.delete('/api-keys/:id', admin, (req, res) => {
  run('UPDATE api_keys SET revoked = 1 WHERE id = ?', idParam(req));
  res.json({ ok: true });
});

// ======================= LEAD CAPTURE FORMS =======================
const formOut = (f) => f && ({
  ...f, active: !!f.active, create_deal: !!f.create_deal, tags: tagsOut(f.tags),
  endpoint: `${config.baseUrl}/api/public/forms/${f.token}`,
});
integrationRoutes.get('/forms', (req, res) => {
  res.json({ forms: all('SELECT f.*, s.name AS sequence_name FROM forms f LEFT JOIN sequences s ON s.id = f.sequence_id ORDER BY f.created_at DESC').map(formOut) });
});
function formFields(body) {
  const out = {};
  if (body.name !== undefined) out.name = String(body.name).trim();
  if (body.tags !== undefined) out.tags = tagsIn(body.tags) || '';
  if (body.status !== undefined) out.status = body.status || 'lead';
  if (body.source !== undefined) out.source = body.source || null;
  if (body.owner_id !== undefined) out.owner_id = body.owner_id ? Number(body.owner_id) : null;
  if (body.sequence_id !== undefined) out.sequence_id = body.sequence_id ? Number(body.sequence_id) : null;
  if (body.redirect_url !== undefined) out.redirect_url = body.redirect_url || null;
  if (body.create_deal !== undefined) out.create_deal = body.create_deal ? 1 : 0;
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  if (out.redirect_url && !/^https?:\/\//.test(out.redirect_url)) throw new HttpError(400, 'Redirect URL must start with http:// or https://');
  return out;
}
integrationRoutes.post('/forms', (req, res) => {
  required(req.body || {}, ['name']);
  const id = insert('forms', { owner_id: req.user.id, ...formFields(req.body), token: randomToken(18), created_at: now() });
  res.status(201).json({ form: formOut(get('SELECT * FROM forms WHERE id = ?', id)) });
});
integrationRoutes.patch('/forms/:id', (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM forms WHERE id = ?', id)) throw new HttpError(404, 'Form not found');
  update('forms', id, formFields(req.body || {}));
  res.json({ form: formOut(get('SELECT * FROM forms WHERE id = ?', id)) });
});
integrationRoutes.delete('/forms/:id', (req, res) => {
  run('DELETE FROM forms WHERE id = ?', idParam(req));
  res.json({ ok: true });
});

// ======================= SYSTEM =======================
// Runs sequences, the email queue, webhook retries and task reminders immediately.
integrationRoutes.post('/system/run-scheduler', admin, async (req, res) => {
  await tick();
  res.json({ ok: true, ran_at: now() });
});

// ======================= LOGS =======================
integrationRoutes.get('/integration-log', admin, (req, res) => {
  const where = req.query.integration ? 'WHERE integration = ?' : '';
  const params = req.query.integration ? [req.query.integration] : [];
  res.json({ log: all(`SELECT * FROM integration_log ${where} ORDER BY id DESC LIMIT 200`, ...params) });
});

