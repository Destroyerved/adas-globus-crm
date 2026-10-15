import { get, all, run, insert, update, tx, listQuery } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { contactById, fullName, CONTACT_FROM } from '../models.js';
import {
  prepareEmail, deliverEmail, sendEmail, processQueue, render, buildVars, TEMPLATE_VARIABLES, suppress, isSuppressed,
} from '../services/mailer.js';
import { enroll, getSteps } from '../services/sequencer.js';
import { contactWhere } from './crm.js';
import { Router, HttpError, now, addMs, DAY, required, ensureHtml, jsonOut, isEmail } from '../util.js';

export const mailRoutes = Router();
mailRoutes.use(requireAuth);

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
};

// ======================= TEMPLATES =======================
mailRoutes.get('/templates', (req, res) => {
  res.json({
    templates: all(`SELECT t.*, (SELECT COUNT(*) FROM emails WHERE template_id = t.id AND status = 'sent') AS sent_count,
                      (SELECT COUNT(*) FROM emails WHERE template_id = t.id AND opened_at IS NOT NULL) AS open_count,
                      (SELECT COUNT(*) FROM emails WHERE template_id = t.id AND replied_at IS NOT NULL) AS reply_count
                    FROM email_templates t ORDER BY t.category, t.name`),
    variables: TEMPLATE_VARIABLES,
  });
});
mailRoutes.get('/templates/:id', (req, res) => {
  const t = get('SELECT * FROM email_templates WHERE id = ?', idParam(req));
  if (!t) throw new HttpError(404, 'Template not found');
  res.json({ template: t });
});
mailRoutes.post('/templates', (req, res) => {
  required(req.body || {}, ['name', 'subject', 'body']);
  const t = now();
  const id = insert('email_templates', {
    name: req.body.name.trim(), subject: req.body.subject, body: req.body.body, category: req.body.category || null,
    created_by: req.user.id, created_at: t, updated_at: t,
  });
  res.status(201).json({ template: get('SELECT * FROM email_templates WHERE id = ?', id) });
});
mailRoutes.patch('/templates/:id', (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM email_templates WHERE id = ?', id)) throw new HttpError(404, 'Template not found');
  const patch = {};
  for (const k of ['name', 'subject', 'body', 'category']) if (req.body[k] !== undefined) patch[k] = req.body[k];
  update('email_templates', id, { ...patch, updated_at: now() });
  res.json({ template: get('SELECT * FROM email_templates WHERE id = ?', id) });
});
mailRoutes.delete('/templates/:id', (req, res) => {
  run('DELETE FROM email_templates WHERE id = ?', idParam(req));
  res.json({ ok: true });
});
mailRoutes.post('/templates/preview', (req, res) => {
  const contact = req.body.contact_id ? contactById(Number(req.body.contact_id)) : null;
  const sample = contact || { first_name: 'Alex', last_name: 'Sample', email: 'alex@example.com', company_name: 'Example Ltd', title: 'Head of Operations' };
  const vars = { ...buildVars(sample, req.user), unsubscribe_url: '#unsubscribe' };
  res.json({ subject: render(req.body.subject || '', vars), body: render(ensureHtml(req.body.body || ''), vars, { html: true }) });
});

// ======================= EMAILS =======================
const EMAIL_SELECT = `e.id, e.direction, e.status, e.contact_id, e.deal_id, e.campaign_id, e.enrollment_id, e.template_id, e.from_addr, e.to_addr,
  e.subject, e.error, e.sent_at, e.created_at, e.opened_at, e.open_count, e.clicked_at, e.click_count, e.replied_at, e.bounced,
  c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.email AS contact_email, u.name AS user_name`;
const EMAIL_FROM = 'emails e LEFT JOIN contacts c ON c.id = e.contact_id LEFT JOIN users u ON u.id = e.user_id';
const withContactName = (r) => {
  const out = { ...r, contact_name: r.contact_id ? fullName({ first_name: r.contact_first_name, last_name: r.contact_last_name, email: r.contact_email }) : null };
  delete out.contact_first_name; delete out.contact_last_name;
  return out;
};

mailRoutes.get('/emails', (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  for (const k of ['direction', 'status']) if (q[k]) { where.push(`e.${k} = ?`); params.push(q[k]); }
  for (const k of ['contact_id', 'campaign_id', 'enrollment_id', 'deal_id']) if (q[k]) { where.push(`e.${k} = ?`); params.push(Number(q[k])); }
  if (q.opened === '1') where.push('e.opened_at IS NOT NULL');
  if (q.replied === '1') where.push('e.replied_at IS NOT NULL');
  const r = listQuery({
    select: EMAIL_SELECT, from: EMAIL_FROM, where, params, search: q.q, searchCols: ['e.subject', 'e.to_addr', 'e.from_addr', 'c.first_name', 'c.last_name'],
    defaultSort: 'COALESCE(e.sent_at, e.created_at) DESC', limit: q.limit, offset: q.offset,
  });
  res.json({ emails: r.rows.map(withContactName), total: r.total, limit: r.limit, offset: r.offset });
});

mailRoutes.get('/emails/stats', (req, res) => {
  const since = addMs(-(Number(req.query.days) || 30) * DAY);
  res.json({
    stats: get(`SELECT COUNT(*) AS sent, COALESCE(SUM(opened_at IS NOT NULL), 0) AS opened, COALESCE(SUM(clicked_at IS NOT NULL), 0) AS clicked,
                  COALESCE(SUM(replied_at IS NOT NULL), 0) AS replied, COALESCE(SUM(bounced), 0) AS bounced
                FROM emails WHERE direction = 'out' AND status = 'sent' AND sent_at >= ?`, since),
    queued: get("SELECT COUNT(*) AS n FROM emails WHERE status = 'queued'").n,
    failed: get("SELECT COUNT(*) AS n FROM emails WHERE status = 'failed' AND created_at >= ?", since).n,
    received: get("SELECT COUNT(*) AS n FROM emails WHERE direction = 'in' AND created_at >= ?", since).n,
  });
});

mailRoutes.get('/emails/:id', (req, res) => {
  const e = get(`SELECT e.*, c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.email AS contact_email, u.name AS user_name
                 FROM ${EMAIL_FROM} WHERE e.id = ?`, idParam(req));
  if (!e) throw new HttpError(404, 'Email not found');
  res.json({ email: withContactName(e) });
});

mailRoutes.post('/emails/send', async (req, res) => {
  const b = req.body || {};
  if (!b.contact_id && !b.to) throw new HttpError(400, 'Choose a contact or enter a recipient address');
  const email = await sendEmail({
    contactId: b.contact_id ? Number(b.contact_id) : null, to: b.to, subject: b.subject, body: b.body, templateId: b.template_id || null,
    dealId: b.deal_id || null, cc: b.cc, bcc: b.bcc, user: req.user, force: !!b.force, inReplyTo: b.in_reply_to,
  });
  if (email.status === 'failed') throw new HttpError(502, `Sending failed: ${email.error}`, { email_id: email.id });
  res.status(201).json({ email: { id: email.id, status: email.status, sent_at: email.sent_at, error: email.error } });
});

mailRoutes.post('/emails/:id/retry', async (req, res) => {
  const e = get('SELECT * FROM emails WHERE id = ?', idParam(req));
  if (!e) throw new HttpError(404, 'Email not found');
  if (e.status !== 'failed') throw new HttpError(400, 'Only failed emails can be retried');
  const out = await deliverEmail(e.id);
  res.json({ email: { id: out.id, status: out.status, error: out.error } });
});

// ======================= CAMPAIGNS (one-off broadcasts) =======================
function campaignRecipients(filter, user) {
  const { where, params } = contactWhere(filter || {}, user);
  where.push("c.email IS NOT NULL AND c.email != ''", 'c.unsubscribed = 0', 'c.email NOT IN (SELECT email FROM suppressions)');
  return listQuery({
    select: 'c.id, c.first_name, c.last_name, c.email', from: CONTACT_FROM, where, params, search: filter?.q,
    searchCols: ['c.first_name', 'c.last_name', 'c.email', 'co.name'], defaultSort: 'c.id', limit: 1000,
  });
}

const campaignStats = (id) => get(`SELECT COUNT(*) AS total, COALESCE(SUM(status = 'sent'), 0) AS sent, COALESCE(SUM(status = 'queued'), 0) AS queued,
    COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(opened_at IS NOT NULL), 0) AS opened, COALESCE(SUM(clicked_at IS NOT NULL), 0) AS clicked,
    COALESCE(SUM(replied_at IS NOT NULL), 0) AS replied, COALESCE(SUM(bounced), 0) AS bounced FROM emails WHERE campaign_id = ?`, id);
const campaignOut = (c) => c && ({ ...c, filter: jsonOut(c.filter), stats: campaignStats(c.id) });

mailRoutes.get('/campaigns', (req, res) => {
  res.json({ campaigns: all('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 200').map(campaignOut) });
});
mailRoutes.get('/campaigns/:id', (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', idParam(req));
  if (!c) throw new HttpError(404, 'Campaign not found');
  res.json({ campaign: campaignOut(c) });
});
mailRoutes.post('/campaigns', (req, res) => {
  required(req.body || {}, ['name']);
  const id = insert('campaigns', {
    name: req.body.name.trim(), subject: req.body.subject || '', body: req.body.body || '', template_id: req.body.template_id || null,
    filter: req.body.filter || {}, status: 'draft', created_by: req.user.id, created_at: now(),
  });
  res.status(201).json({ campaign: campaignOut(get('SELECT * FROM campaigns WHERE id = ?', id)) });
});
mailRoutes.patch('/campaigns/:id', (req, res) => {
  const id = idParam(req);
  const c = get('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) throw new HttpError(404, 'Campaign not found');
  if (c.status !== 'draft') throw new HttpError(400, 'Only draft campaigns can be edited');
  const patch = {};
  for (const k of ['name', 'subject', 'body', 'template_id', 'filter']) if (req.body[k] !== undefined) patch[k] = req.body[k];
  update('campaigns', id, patch);
  res.json({ campaign: campaignOut(get('SELECT * FROM campaigns WHERE id = ?', id)) });
});
mailRoutes.delete('/campaigns/:id', (req, res) => {
  const id = idParam(req);
  run("UPDATE emails SET status = 'cancelled' WHERE campaign_id = ? AND status = 'queued'", id);
  run('DELETE FROM campaigns WHERE id = ?', id);
  res.json({ ok: true });
});
mailRoutes.post('/campaigns/:id/recipients', (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', idParam(req));
  if (!c) throw new HttpError(404, 'Campaign not found');
  const r = campaignRecipients(req.body?.filter || jsonOut(c.filter), req.user);
  res.json({ total: Math.min(r.total, 1000), capped: r.total > 1000, sample: r.rows.slice(0, 10) });
});
mailRoutes.post('/campaigns/:id/send', requireRole('admin', 'manager'), (req, res) => {
  const id = idParam(req);
  const c = get('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) throw new HttpError(404, 'Campaign not found');
  if (c.status !== 'draft') throw new HttpError(400, 'This campaign was already sent');
  if (!c.template_id && (!c.subject || !c.body)) throw new HttpError(400, 'Add a subject and body, or pick a template');
  const r = campaignRecipients(jsonOut(c.filter), req.user);
  if (!r.rows.length) throw new HttpError(400, 'No recipients match this campaign’s filter');
  let queued = 0;
  tx(() => {
    for (const ct of r.rows) {
      try {
        prepareEmail({ contactId: ct.id, subject: c.subject, body: c.body, templateId: c.template_id, user: req.user, campaignId: id, bulk: true });
        queued++;
      } catch { /* skipped: suppressed or invalid */ }
    }
    update('campaigns', id, { status: 'sending', total: queued, sent_at: now() });
  });
  processQueue().catch((err) => console.error('[campaign]', err.message));
  res.json({ queued, campaign: campaignOut(get('SELECT * FROM campaigns WHERE id = ?', id)) });
});
mailRoutes.post('/campaigns/:id/cancel', (req, res) => {
  const id = idParam(req);
  const n = run("UPDATE emails SET status = 'cancelled' WHERE campaign_id = ? AND status = 'queued'", id).changes;
  run("UPDATE campaigns SET status = 'cancelled' WHERE id = ? AND status = 'sending'", id);
  res.json({ cancelled: n });
});

// ======================= SEQUENCES =======================
function validateSteps(steps) {
  if (!Array.isArray(steps)) return null;
  return steps.map((s, i) => {
    const type = s.type === 'task' ? 'task' : 'email';
    if (type === 'email' && !s.template_id && !String(s.body || '').trim()) throw new HttpError(400, `Step ${i + 1}: choose a template or write the email body`);
    if (type === 'email' && i === 0 && !s.template_id && !String(s.subject || '').trim()) throw new HttpError(400, 'Step 1: the first email needs a subject');
    if (type === 'task' && !String(s.task_title || '').trim()) throw new HttpError(400, `Step ${i + 1}: give the task a title`);
    return {
      position: i, type, delay_days: Math.max(0, parseInt(s.delay_days, 10) || 0), delay_hours: Math.max(0, parseInt(s.delay_hours, 10) || 0),
      template_id: s.template_id ? Number(s.template_id) : null, subject: s.subject || null, body: s.body || null, task_title: s.task_title || null,
    };
  });
}

const sequenceStats = (id) => get(`SELECT COUNT(*) AS enrolled, COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'completed'), 0) AS completed,
    COALESCE(SUM(status = 'replied'), 0) AS replied, COALESCE(SUM(status IN ('failed', 'bounced')), 0) AS failed,
    COALESCE(SUM(status = 'unsubscribed'), 0) AS unsubscribed, COALESCE(SUM(status = 'paused'), 0) AS paused
  FROM enrollments WHERE sequence_id = ?`, id);
const sequenceEmailStats = (id) => get(`SELECT COUNT(*) AS sent, COALESCE(SUM(e.opened_at IS NOT NULL), 0) AS opened,
    COALESCE(SUM(e.clicked_at IS NOT NULL), 0) AS clicked, COALESCE(SUM(e.replied_at IS NOT NULL), 0) AS replied
  FROM emails e JOIN enrollments en ON en.id = e.enrollment_id WHERE en.sequence_id = ? AND e.status = 'sent'`, id);

mailRoutes.get('/sequences', (req, res) => {
  res.json({
    sequences: all('SELECT * FROM sequences ORDER BY created_at DESC').map((s) => ({
      ...s, stop_on_reply: !!s.stop_on_reply, business_hours: !!s.business_hours,
      step_count: get('SELECT COUNT(*) AS n FROM sequence_steps WHERE sequence_id = ?', s.id).n,
      stats: sequenceStats(s.id), email_stats: sequenceEmailStats(s.id),
    })),
  });
});

mailRoutes.get('/sequences/:id', (req, res) => {
  const id = idParam(req);
  const s = get('SELECT * FROM sequences WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'Sequence not found');
  const enrollments = all(`SELECT en.*, c.first_name, c.last_name, c.email, co.name AS company_name
                           FROM enrollments en JOIN contacts c ON c.id = en.contact_id LEFT JOIN companies co ON co.id = c.company_id
                           WHERE en.sequence_id = ? ORDER BY en.updated_at DESC LIMIT 500`, id)
    .map((e) => ({ ...e, contact_name: fullName(e) }));
  res.json({
    sequence: { ...s, stop_on_reply: !!s.stop_on_reply, business_hours: !!s.business_hours },
    steps: getSteps(id),
    enrollments,
    stats: sequenceStats(id),
    email_stats: sequenceEmailStats(id),
  });
});

function saveSequence(id, body, user) {
  const t = now();
  const steps = validateSteps(body.steps);
  return tx(() => {
    const fields = {};
    for (const k of ['name', 'description', 'status']) if (body[k] !== undefined) fields[k] = body[k];
    for (const k of ['stop_on_reply', 'business_hours']) if (body[k] !== undefined) fields[k] = body[k] ? 1 : 0;
    if (fields.status && !['active', 'paused'].includes(fields.status)) throw new HttpError(400, 'Status must be active or paused');
    if (id) update('sequences', id, { ...fields, updated_at: t });
    else {
      if (!fields.name) throw new HttpError(400, 'Sequence name is required');
      id = insert('sequences', { status: 'active', stop_on_reply: 1, business_hours: 1, ...fields, created_by: user.id, created_at: t, updated_at: t });
    }
    if (steps) {
      run('DELETE FROM sequence_steps WHERE sequence_id = ?', id);
      for (const s of steps) insert('sequence_steps', { ...s, sequence_id: id });
      // Keep active enrollments pointing at a valid step
      run(`UPDATE enrollments SET current_step = MIN(current_step, ?) WHERE sequence_id = ? AND status = 'active'`, Math.max(0, steps.length - 1), id);
    }
    return id;
  });
}

mailRoutes.post('/sequences', (req, res) => {
  const id = saveSequence(null, req.body || {}, req.user);
  res.status(201).json({ sequence: get('SELECT * FROM sequences WHERE id = ?', id), steps: getSteps(id) });
});
mailRoutes.patch('/sequences/:id', (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM sequences WHERE id = ?', id)) throw new HttpError(404, 'Sequence not found');
  saveSequence(id, req.body || {}, req.user);
  res.json({ sequence: get('SELECT * FROM sequences WHERE id = ?', id), steps: getSteps(id) });
});
mailRoutes.delete('/sequences/:id', (req, res) => {
  run('DELETE FROM sequences WHERE id = ?', idParam(req));
  res.json({ ok: true });
});

mailRoutes.post('/sequences/:id/enroll', (req, res) => {
  const id = idParam(req);
  let ids = (req.body?.contact_ids || []).map(Number).filter(Boolean);
  if (!ids.length && req.body?.filter) {
    const { where, params } = contactWhere(req.body.filter, req.user);
    ids = listQuery({ select: 'c.id', from: CONTACT_FROM, where, params, search: req.body.filter.q, searchCols: ['c.first_name', 'c.last_name', 'c.email', 'co.name'], defaultSort: 'c.id', limit: 1000 }).rows.map((r) => r.id);
  }
  if (!ids.length) throw new HttpError(400, 'No contacts selected');
  res.json(tx(() => enroll(id, ids, req.user)));
});

mailRoutes.post('/enrollments/:id/:action', (req, res) => {
  const id = idParam(req);
  const en = get('SELECT * FROM enrollments WHERE id = ?', id);
  if (!en) throw new HttpError(404, 'Enrollment not found');
  const t = now();
  const { action } = req.params;
  if (action === 'pause') update('enrollments', id, { status: 'paused', updated_at: t });
  else if (action === 'stop') update('enrollments', id, { status: 'stopped', updated_at: t });
  else if (action === 'resume') {
    const c = get('SELECT email, unsubscribed FROM contacts WHERE id = ?', en.contact_id);
    if (c?.unsubscribed || isSuppressed(c?.email)) throw new HttpError(400, 'This contact has unsubscribed');
    const steps = getSteps(en.sequence_id);
    if (en.current_step >= steps.length) throw new HttpError(400, 'This enrollment has no steps left');
    const next = en.next_run_at && en.next_run_at > t ? en.next_run_at : t;
    update('enrollments', id, { status: 'active', next_run_at: next, last_error: null, updated_at: t });
  } else throw new HttpError(400, 'Unknown action');
  res.json({ enrollment: get('SELECT * FROM enrollments WHERE id = ?', id) });
});
mailRoutes.delete('/enrollments/:id', (req, res) => {
  run('DELETE FROM enrollments WHERE id = ?', idParam(req));
  res.json({ ok: true });
});

// ======================= SUPPRESSIONS =======================
mailRoutes.get('/suppressions', (req, res) => {
  res.json({ suppressions: all('SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 2000') });
});
mailRoutes.post('/suppressions', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
  suppress(email, req.body.reason || 'manual');
  res.status(201).json({ ok: true });
});
mailRoutes.delete('/suppressions/:email', requireRole('admin', 'manager'), (req, res) => {
  const email = String(req.params.email).toLowerCase();
  run('DELETE FROM suppressions WHERE email = ?', email);
  run('UPDATE contacts SET unsubscribed = 0 WHERE email = ?', email);
  res.json({ ok: true });
});

