import { get, all, run, insert, update, tx, listQuery } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { emit } from '../events.js';
import {
  CONTACT_SELECT, CONTACT_FROM, DEAL_SELECT, DEAL_FROM, ACTIVITY_SELECT, ACTIVITY_FROM, CONTACT_STATUSES, ACTIVITY_TYPES,
  serializeContact, serializeCompany, serializeDeal, serializeActivity,
  contactById, companyById, dealById, activityById,
  createContact, updateContact, deleteContact, upsertContact,
  createCompany, updateCompany, deleteCompany,
  createDeal, updateDeal, deleteDeal,
  createActivity, updateActivity, deleteActivity, timeline,
} from '../models.js';
import { Router, HttpError, now, addMs, DAY, parseCsv, toCsv, tagsIn, tagsOut, required } from '../util.js';

export const crmRoutes = Router();
crmRoutes.use(requireAuth);

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
};
const ownerValue = (v, user) => (v === 'me' ? user.id : Number(v));
const idList = (v) => String(v || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);

// ======================= CONTACTS =======================
const CONTACT_SEARCH = ['c.first_name', 'c.last_name', 'c.email', 'c.title', 'c.phone', 'c.city', 'co.name'];
const CONTACT_SORTS = {
  name: 'c.first_name COLLATE NOCASE', created_at: 'c.created_at', updated_at: 'c.updated_at', last_contacted_at: 'c.last_contacted_at',
  score: 'c.score', company: 'co.name COLLATE NOCASE', status: 'c.status', email: 'c.email',
};

export function contactWhere(q = {}, user) {
  const where = [];
  const params = [];
  if (q.status) { where.push('c.status = ?'); params.push(q.status); }
  if (q.owner_id) { where.push('c.owner_id = ?'); params.push(ownerValue(q.owner_id, user)); }
  if (q.company_id) { where.push('c.company_id = ?'); params.push(Number(q.company_id)); }
  if (q.tag) { where.push('c.tags LIKE ?'); params.push(`%,${String(q.tag).trim().toLowerCase()},%`); }
  if (q.source) { where.push('c.source = ?'); params.push(q.source); }
  if (q.has_email === '1' || q.has_email === true) where.push("c.email IS NOT NULL AND c.email != ''");
  if (q.unsubscribed === '0' || q.unsubscribed === false) where.push('c.unsubscribed = 0');
  if (q.unsubscribed === '1' || q.unsubscribed === true) where.push('c.unsubscribed = 1');
  if (q.created_after) { where.push('c.created_at >= ?'); params.push(q.created_after); }
  if (q.sequence_id) { where.push('c.id IN (SELECT contact_id FROM enrollments WHERE sequence_id = ?)'); params.push(Number(q.sequence_id)); }
  if (q.min_score) { where.push('c.score >= ?'); params.push(Number(q.min_score)); }
  const ids = Array.isArray(q.ids) ? q.ids.map(Number).filter(Boolean) : idList(q.ids);
  if (ids.length) { where.push(`c.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  return { where, params };
}

crmRoutes.get('/contacts', (req, res) => {
  const { where, params } = contactWhere(req.query, req.user);
  const r = listQuery({
    select: CONTACT_SELECT, from: CONTACT_FROM, where, params, search: req.query.q, searchCols: CONTACT_SEARCH,
    sort: req.query.sort, sorts: CONTACT_SORTS, defaultSort: 'c.created_at DESC', limit: req.query.limit, offset: req.query.offset,
  });
  res.json({ contacts: r.rows.map(serializeContact), total: r.total, limit: r.limit, offset: r.offset });
});

crmRoutes.get('/contacts/export.csv', (req, res) => {
  const { where, params } = contactWhere(req.query, req.user);
  // listQuery caps a page at 1000 rows, so page through for a full export
  const page = (offset) => listQuery({
    select: CONTACT_SELECT, from: CONTACT_FROM, where, params, search: req.query.q, searchCols: CONTACT_SEARCH,
    sort: req.query.sort, sorts: CONTACT_SORTS, defaultSort: 'c.created_at DESC', limit: 1000, offset,
  });
  const first = page(0);
  let rows = first.rows;
  for (let off = 1000; off < first.total; off += 1000) rows = rows.concat(page(off).rows);
  const csv = toCsv(rows.map(serializeContact), [
    { key: 'id' }, { key: 'first_name' }, { key: 'last_name' }, { key: 'email' }, { key: 'phone' }, { key: 'mobile' }, { key: 'title' },
    { key: 'company_name', label: 'company' }, { key: 'company_domain', label: 'company_domain' }, { key: 'status' }, { key: 'source' },
    { key: 'tags' }, { key: 'score' }, { key: 'city' }, { key: 'state' }, { key: 'country' }, { key: 'linkedin_url' },
    { key: 'owner_name', label: 'owner' }, { key: 'unsubscribed' }, { key: 'last_contacted_at' }, { key: 'created_at' },
  ]);
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${csv}`);
});

const CSV_HEADER_MAP = {
  firstname: 'first_name', first: 'first_name', givenname: 'first_name', fname: 'first_name',
  lastname: 'last_name', surname: 'last_name', last: 'last_name', lname: 'last_name', familyname: 'last_name',
  name: '_name', fullname: '_name', contactname: '_name',
  email: 'email', emailaddress: 'email', mail: 'email', workemail: 'email', businessemail: 'email', email1: 'email',
  phone: 'phone', phonenumber: 'phone', telephone: 'phone', workphone: 'phone', workdirectphone: 'phone', directphone: 'phone',
  mobile: 'mobile', mobilephone: 'mobile', cell: 'mobile', cellphone: 'mobile', whatsapp: 'mobile',
  title: 'title', jobtitle: 'title', position: 'title', designation: 'title', role: 'title',
  company: 'company_name', companyname: 'company_name', organization: 'company_name', organisation: 'company_name', account: 'company_name', accountname: 'company_name',
  website: 'company_domain', companywebsite: 'company_domain', domain: 'company_domain', companydomain: 'company_domain', url: 'company_domain',
  linkedin: 'linkedin_url', linkedinurl: 'linkedin_url', personlinkedinurl: 'linkedin_url', linkedinprofile: 'linkedin_url',
  city: 'city', state: 'state', region: 'state', country: 'country',
  tags: 'tags', tag: 'tags', labels: 'tags', status: 'status', leadstatus: 'status', source: 'source', leadsource: 'source', notes: 'notes', note: 'notes',
};

crmRoutes.post('/contacts/import', (req, res) => {
  const { csv, tags, status, update_existing: updateExisting = true } = req.body || {};
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new HttpError(400, 'The CSV needs a header row and at least one data row');
  if (rows.length > 10001) throw new HttpError(400, 'Import at most 10,000 rows at a time');
  const header = rows[0].map((h) => CSV_HEADER_MAP[String(h).toLowerCase().replace(/[^a-z0-9]/g, '')] || null);
  if (!header.some((h) => h === 'email' || h === 'first_name' || h === '_name')) {
    throw new HttpError(400, 'Could not find an Email or Name column in the CSV header');
  }
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  tx(() => {
    rows.slice(1).forEach((cells, i) => {
      const rec = {};
      header.forEach((field, j) => { if (field && cells[j] !== undefined && String(cells[j]).trim() !== '') rec[field] = String(cells[j]).trim(); });
      if (rec._name) {
        const [first, ...rest] = rec._name.split(/\s+/);
        rec.first_name = rec.first_name || first;
        rec.last_name = rec.last_name || rest.join(' ') || null;
        delete rec._name;
      }
      if (rec.status) rec.status = rec.status.toLowerCase();
      if (rec.status && !CONTACT_STATUSES.includes(rec.status)) delete rec.status;
      if (!rec.status && status) rec.status = status;
      rec.tags = [...tagsOut(tagsIn(rec.tags ? rec.tags.replace(/;/g, ',') : '')), ...tagsOut(tagsIn(tags || ''))];
      rec.source = rec.source || 'CSV import';
      if (!rec.email && !rec.first_name && !rec.last_name) { result.skipped++; return; }
      try {
        if (!updateExisting && rec.email && get('SELECT id FROM contacts WHERE email = ?', rec.email.toLowerCase())) { result.skipped++; return; }
        const { created } = upsertContact(rec, req.user, { silent: true });
        if (created) result.created++; else result.updated++;
      } catch (err) {
        if (result.errors.length < 50) result.errors.push({ row: i + 2, error: err.message });
        result.skipped++;
      }
    });
  });
  emit('contacts.imported', { ...result, errors: result.errors.length, by: req.user.name });
  res.json(result);
});

// Create or update by email (or apollo_id). Handy for n8n / Zapier style automations.
crmRoutes.post('/contacts/upsert', (req, res) => {
  const body = req.body || {};
  if (!body.email && !body.apollo_id) throw new HttpError(400, 'Upsert needs an email (or apollo_id) to match on');
  const { contact, created } = upsertContact(body, req.user, { overwrite: !!body.overwrite });
  res.status(created ? 201 : 200).json({ contact, created });
});

crmRoutes.post('/contacts/bulk', (req, res) => {
  const { ids = [], action, value } = req.body || {};
  const list = ids.map(Number).filter(Boolean);
  if (!list.length) throw new HttpError(400, 'No contacts selected');
  let affected = 0;
  tx(() => {
    for (const id of list) {
      const c = get('SELECT * FROM contacts WHERE id = ?', id);
      if (!c) continue;
      if (action === 'delete') {
        if (!['admin', 'manager'].includes(req.user.role)) throw new HttpError(403, 'Only admins and managers can bulk delete');
        deleteContact(id);
      } else if (action === 'add_tag') updateContact(id, { tags: [...tagsOut(c.tags), ...tagsOut(tagsIn(value))] }, req.user);
      else if (action === 'remove_tag') {
        const remove = new Set(tagsOut(tagsIn(value)));
        updateContact(id, { tags: tagsOut(c.tags).filter((t) => !remove.has(t)) }, req.user);
      } else if (action === 'set_status') updateContact(id, { status: value }, req.user);
      else if (action === 'set_owner') updateContact(id, { owner_id: value }, req.user);
      else throw new HttpError(400, 'Unknown bulk action');
      affected++;
    }
  });
  res.json({ affected });
});

crmRoutes.get('/contacts/:id', (req, res) => {
  const id = idParam(req);
  const contact = contactById(id);
  if (!contact) throw new HttpError(404, 'Contact not found');
  res.json({
    contact,
    deals: all(`SELECT ${DEAL_SELECT} FROM ${DEAL_FROM} WHERE d.contact_id = ? ORDER BY d.created_at DESC`, id).map(serializeDeal),
    tasks: all(`SELECT ${ACTIVITY_SELECT} FROM ${ACTIVITY_FROM} WHERE a.contact_id = ? AND a.type = 'task' AND a.done = 0 ORDER BY a.due_at IS NULL, a.due_at`, id).map(serializeActivity),
    enrollments: all(`SELECT e.*, s.name AS sequence_name, (SELECT COUNT(*) FROM sequence_steps WHERE sequence_id = s.id) AS step_count
                      FROM enrollments e JOIN sequences s ON s.id = e.sequence_id WHERE e.contact_id = ? ORDER BY e.created_at DESC`, id),
    email_stats: get(`SELECT COUNT(*) AS sent, COALESCE(SUM(opened_at IS NOT NULL), 0) AS opened, COALESCE(SUM(clicked_at IS NOT NULL), 0) AS clicked,
                      COALESCE(SUM(replied_at IS NOT NULL), 0) AS replied FROM emails WHERE contact_id = ? AND direction = 'out' AND status = 'sent'`, id),
  });
});

crmRoutes.post('/contacts', (req, res) => {
  res.status(201).json({ contact: createContact(req.body || {}, req.user) });
});
crmRoutes.patch('/contacts/:id', (req, res) => {
  res.json({ contact: updateContact(idParam(req), req.body || {}, req.user) });
});
crmRoutes.delete('/contacts/:id', (req, res) => {
  deleteContact(idParam(req));
  res.json({ ok: true });
});

// ======================= COMPANIES =======================
const COMPANY_SELECT = `co.*, u.name AS owner_name,
  (SELECT COUNT(*) FROM contacts WHERE company_id = co.id) AS contact_count,
  (SELECT COUNT(*) FROM deals WHERE company_id = co.id AND status = 'open') AS open_deals,
  (SELECT COALESCE(SUM(value), 0) FROM deals WHERE company_id = co.id AND status = 'open') AS open_value`;
const COMPANY_FROM = 'companies co LEFT JOIN users u ON u.id = co.owner_id';
const COMPANY_SORTS = { name: 'co.name COLLATE NOCASE', created_at: 'co.created_at', updated_at: 'co.updated_at', employees: 'co.employees', industry: 'co.industry' };

function companyWhere(q, user) {
  const where = [];
  const params = [];
  if (q.industry) { where.push('co.industry = ?'); params.push(q.industry); }
  if (q.owner_id) { where.push('co.owner_id = ?'); params.push(ownerValue(q.owner_id, user)); }
  if (q.tag) { where.push('co.tags LIKE ?'); params.push(`%,${String(q.tag).trim().toLowerCase()},%`); }
  if (q.country) { where.push('co.country = ?'); params.push(q.country); }
  return { where, params };
}

crmRoutes.get('/companies', (req, res) => {
  const { where, params } = companyWhere(req.query, req.user);
  const r = listQuery({
    select: COMPANY_SELECT, from: COMPANY_FROM, where, params, search: req.query.q, searchCols: ['co.name', 'co.domain', 'co.industry', 'co.city', 'co.country'],
    sort: req.query.sort, sorts: COMPANY_SORTS, defaultSort: 'co.created_at DESC', limit: req.query.limit, offset: req.query.offset,
  });
  res.json({ companies: r.rows.map(serializeCompany), total: r.total, limit: r.limit, offset: r.offset });
});

crmRoutes.get('/companies/export.csv', (req, res) => {
  const { where, params } = companyWhere(req.query, req.user);
  const rows = listQuery({ select: COMPANY_SELECT, from: COMPANY_FROM, where, params, search: req.query.q, searchCols: ['co.name', 'co.domain'], defaultSort: 'co.name', limit: 1000 }).rows;
  const csv = toCsv(rows.map(serializeCompany), ['id', 'name', 'domain', 'website', 'industry', 'employees', 'annual_revenue', 'phone', 'city', 'state', 'country',
    'linkedin_url', 'tags', 'contact_count', 'open_deals', 'open_value', 'owner_name', 'created_at'].map((key) => ({ key })));
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="companies-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${csv}`);
});

crmRoutes.get('/companies/:id', (req, res) => {
  const id = idParam(req);
  const company = serializeCompany(get(`SELECT ${COMPANY_SELECT} FROM ${COMPANY_FROM} WHERE co.id = ?`, id));
  if (!company) throw new HttpError(404, 'Company not found');
  res.json({
    company,
    contacts: all(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM} WHERE c.company_id = ? ORDER BY c.first_name`, id).map(serializeContact),
    deals: all(`SELECT ${DEAL_SELECT} FROM ${DEAL_FROM} WHERE d.company_id = ? ORDER BY d.created_at DESC`, id).map(serializeDeal),
  });
});
crmRoutes.post('/companies', (req, res) => res.status(201).json({ company: createCompany(req.body || {}, req.user) }));
crmRoutes.patch('/companies/:id', (req, res) => res.json({ company: updateCompany(idParam(req), req.body || {}, req.user) }));
crmRoutes.delete('/companies/:id', (req, res) => { deleteCompany(idParam(req)); res.json({ ok: true }); });

// ======================= PIPELINE STAGES =======================
crmRoutes.get('/stages', (req, res) => {
  res.json({
    stages: all(`SELECT s.*, (SELECT COUNT(*) FROM deals WHERE stage_id = s.id) AS deal_count FROM stages s ORDER BY s.position, s.id`),
  });
});

crmRoutes.post('/stages', requireRole('admin', 'manager'), (req, res) => {
  required(req.body, ['name']);
  const kind = ['open', 'won', 'lost'].includes(req.body.kind) ? req.body.kind : 'open';
  const pos = (get('SELECT MAX(position) AS p FROM stages').p ?? -1) + 1;
  const id = insert('stages', { name: String(req.body.name).trim(), probability: Number(req.body.probability) || 0, kind, position: pos });
  res.status(201).json({ stage: get('SELECT * FROM stages WHERE id = ?', id) });
});

crmRoutes.patch('/stages/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = idParam(req);
  const stage = get('SELECT * FROM stages WHERE id = ?', id);
  if (!stage) throw new HttpError(404, 'Stage not found');
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).trim() || stage.name;
  if (req.body.probability !== undefined) patch.probability = Math.min(100, Math.max(0, Number(req.body.probability) || 0));
  if (req.body.kind !== undefined && ['open', 'won', 'lost'].includes(req.body.kind)) patch.kind = req.body.kind;
  update('stages', id, patch);
  if (patch.kind && patch.kind !== stage.kind) {
    run('UPDATE deals SET status = ?, closed_at = CASE WHEN ? = \'open\' THEN NULL ELSE COALESCE(closed_at, ?) END WHERE stage_id = ?', patch.kind, patch.kind, now(), id);
  }
  res.json({ stage: get('SELECT * FROM stages WHERE id = ?', id) });
});

crmRoutes.post('/stages/reorder', requireRole('admin', 'manager'), (req, res) => {
  const ids = (req.body?.ids || []).map(Number);
  tx(() => ids.forEach((id, i) => run('UPDATE stages SET position = ? WHERE id = ?', i, id)));
  res.json({ ok: true });
});

crmRoutes.delete('/stages/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = idParam(req);
  if (get('SELECT COUNT(*) AS n FROM stages').n <= 1) throw new HttpError(400, 'The pipeline needs at least one stage');
  const count = get('SELECT COUNT(*) AS n FROM deals WHERE stage_id = ?', id).n;
  if (count) {
    const moveTo = Number(req.query.move_to || req.body?.move_to);
    const target = moveTo && moveTo !== id ? get('SELECT * FROM stages WHERE id = ?', moveTo) : null;
    if (!target) throw new HttpError(400, `This stage has ${count} deal(s). Choose another stage to move them to.`);
    run('UPDATE deals SET stage_id = ?, status = ? WHERE stage_id = ?', target.id, target.kind, id);
  }
  run('DELETE FROM stages WHERE id = ?', id);
  res.json({ ok: true });
});

// ======================= DEALS =======================
const DEAL_SORTS = { title: 'd.title COLLATE NOCASE', value: 'd.value', created_at: 'd.created_at', expected_close: 'd.expected_close', stage: 's.position', updated_at: 'd.updated_at' };

function dealWhere(q, user) {
  const where = [];
  const params = [];
  if (q.stage_id) { where.push('d.stage_id = ?'); params.push(Number(q.stage_id)); }
  if (q.status) { where.push('d.status = ?'); params.push(q.status); }
  if (q.owner_id) { where.push('d.owner_id = ?'); params.push(ownerValue(q.owner_id, user)); }
  if (q.contact_id) { where.push('d.contact_id = ?'); params.push(Number(q.contact_id)); }
  if (q.company_id) { where.push('d.company_id = ?'); params.push(Number(q.company_id)); }
  if (q.closing_before) { where.push('d.expected_close <= ?'); params.push(q.closing_before); }
  return { where, params };
}
const DEAL_SEARCH = ['d.title', 'co.name', 'ct.first_name', 'ct.last_name', 'ct.email'];

crmRoutes.get('/deals', (req, res) => {
  const { where, params } = dealWhere(req.query, req.user);
  const r = listQuery({
    select: DEAL_SELECT, from: DEAL_FROM, where, params, search: req.query.q, searchCols: DEAL_SEARCH,
    sort: req.query.sort, sorts: DEAL_SORTS, defaultSort: 'd.created_at DESC', limit: req.query.limit, offset: req.query.offset,
  });
  res.json({ deals: r.rows.map(serializeDeal), total: r.total, limit: r.limit, offset: r.offset });
});

crmRoutes.get('/deals/board', (req, res) => {
  const { where, params } = dealWhere({ owner_id: req.query.owner_id }, req.user);
  // Closed deals stay on the board for 90 days
  where.push("(d.status = 'open' OR d.closed_at >= ?)");
  params.push(addMs(-90 * DAY));
  const stages = all('SELECT * FROM stages ORDER BY position, id');
  const deals = listQuery({
    select: DEAL_SELECT, from: DEAL_FROM, where, params, search: req.query.q, searchCols: DEAL_SEARCH,
    defaultSort: 'd.position ASC, d.id ASC', limit: 1000,
  }).rows.map(serializeDeal);
  res.json({
    stages: stages.map((s) => {
      const list = deals.filter((d) => d.stage_id === s.id);
      return { ...s, deals: list, count: list.length, total_value: list.reduce((sum, d) => sum + (Number(d.value) || 0), 0) };
    }),
  });
});

crmRoutes.get('/deals/:id', (req, res) => {
  const id = idParam(req);
  const deal = dealById(id);
  if (!deal) throw new HttpError(404, 'Deal not found');
  res.json({
    deal,
    tasks: all(`SELECT ${ACTIVITY_SELECT} FROM ${ACTIVITY_FROM} WHERE a.deal_id = ? AND a.type = 'task' AND a.done = 0 ORDER BY a.due_at`, id).map(serializeActivity),
  });
});
crmRoutes.post('/deals', (req, res) => res.status(201).json({ deal: createDeal(req.body || {}, req.user) }));
crmRoutes.patch('/deals/:id', (req, res) => res.json({ deal: updateDeal(idParam(req), req.body || {}, req.user) }));
crmRoutes.post('/deals/:id/move', (req, res) => {
  required(req.body || {}, ['stage_id']);
  res.json({ deal: updateDeal(idParam(req), { stage_id: req.body.stage_id, position: req.body.position, lost_reason: req.body.lost_reason }, req.user) });
});
crmRoutes.delete('/deals/:id', (req, res) => { deleteDeal(idParam(req)); res.json({ ok: true }); });

// ======================= ACTIVITIES & TASKS =======================
function activityWhere(q, user) {
  const where = [];
  const params = [];
  if (q.type) { where.push('a.type = ?'); params.push(q.type); }
  if (q.contact_id) { where.push('a.contact_id = ?'); params.push(Number(q.contact_id)); }
  if (q.company_id) { where.push('a.company_id = ?'); params.push(Number(q.company_id)); }
  if (q.deal_id) { where.push('a.deal_id = ?'); params.push(Number(q.deal_id)); }
  if (q.assigned_to) { where.push('a.assigned_to = ?'); params.push(ownerValue(q.assigned_to, user)); }
  if (q.done === '0' || q.done === '1') { where.push('a.done = ?'); params.push(Number(q.done)); }
  return { where, params };
}

crmRoutes.get('/activities', (req, res) => {
  const { where, params } = activityWhere(req.query, req.user);
  const r = listQuery({
    select: ACTIVITY_SELECT, from: ACTIVITY_FROM, where, params, search: req.query.q, searchCols: ['a.subject', 'a.body'],
    defaultSort: 'a.created_at DESC', limit: req.query.limit, offset: req.query.offset,
  });
  res.json({ activities: r.rows.map(serializeActivity), total: r.total });
});

crmRoutes.get('/tasks', (req, res) => {
  const { where, params } = activityWhere({ ...req.query, type: 'task' }, req.user);
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const endToday = new Date(startToday.getTime() + DAY);
  const view = req.query.view || 'open';
  const nowIso = now();
  if (view === 'overdue') { where.push('a.done = 0 AND a.due_at < ?'); params.push(nowIso); }
  else if (view === 'today') { where.push('a.done = 0 AND a.due_at >= ? AND a.due_at < ?'); params.push(nowIso, endToday.toISOString()); }
  else if (view === 'upcoming') { where.push('a.done = 0 AND (a.due_at >= ? OR a.due_at IS NULL)'); params.push(endToday.toISOString()); }
  else if (view === 'done') where.push('a.done = 1');
  else if (view === 'open') where.push('a.done = 0');
  const r = listQuery({
    select: ACTIVITY_SELECT, from: ACTIVITY_FROM, where, params, search: req.query.q, searchCols: ['a.subject', 'a.body', 'ct.first_name', 'ct.last_name'],
    defaultSort: view === 'done' ? 'a.done_at DESC' : 'a.due_at IS NULL, a.due_at ASC', limit: req.query.limit || 200, offset: req.query.offset,
  });
  res.json({ tasks: r.rows.map(serializeActivity), total: r.total });
});

crmRoutes.post('/activities', (req, res) => res.status(201).json({ activity: createActivity(req.body || {}, req.user) }));
crmRoutes.post('/tasks', (req, res) => res.status(201).json({ activity: createActivity({ ...(req.body || {}), type: 'task' }, req.user) }));
crmRoutes.patch('/activities/:id', (req, res) => res.json({ activity: updateActivity(idParam(req), req.body || {}, req.user) }));
crmRoutes.post('/activities/:id/complete', (req, res) => res.json({ activity: updateActivity(idParam(req), { done: req.body?.done ?? true }, req.user) }));
crmRoutes.delete('/activities/:id', (req, res) => { deleteActivity(idParam(req)); res.json({ ok: true }); });

crmRoutes.get('/timeline', (req, res) => {
  const q = req.query;
  res.json({ items: timeline({ contact_id: Number(q.contact_id) || null, company_id: Number(q.company_id) || null, deal_id: Number(q.deal_id) || null }) });
});

// ======================= SEARCH =======================
crmRoutes.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ contacts: [], companies: [], deals: [] });
  const like = `%${q}%`;
  res.json({
    contacts: all(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM}
                   WHERE (c.first_name || ' ' || COALESCE(c.last_name, '')) LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR co.name LIKE ?
                   ORDER BY c.updated_at DESC LIMIT 6`, like, like, like, like).map(serializeContact),
    companies: all('SELECT * FROM companies WHERE name LIKE ? OR domain LIKE ? ORDER BY updated_at DESC LIMIT 5', like, like).map(serializeCompany),
    deals: all(`SELECT ${DEAL_SELECT} FROM ${DEAL_FROM} WHERE d.title LIKE ? ORDER BY d.updated_at DESC LIMIT 5`, like).map(serializeDeal),
  });
});

// ======================= DASHBOARD =======================
crmRoutes.get('/dashboard', (req, res) => {
  const mine = req.query.owner === 'me';
  const own = (col) => (mine ? ` AND ${col} = ${Number(req.user.id) || 0}` : '');
  const d30 = addMs(-30 * DAY);
  const d90 = addMs(-90 * DAY);
  const nowD = new Date();
  const monthStart = new Date(nowD.getFullYear(), nowD.getMonth(), 1).toISOString();
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const endToday = new Date(startToday.getTime() + DAY);

  const pipeline = all(`SELECT s.id, s.name, s.probability, COUNT(d.id) AS count, COALESCE(SUM(d.value), 0) AS value
                        FROM stages s LEFT JOIN deals d ON d.stage_id = s.id AND d.status = 'open' ${own('d.owner_id')}
                        WHERE s.kind = 'open' GROUP BY s.id ORDER BY s.position`);
  const open = get(`SELECT COUNT(*) AS count, COALESCE(SUM(d.value), 0) AS value,
                      COALESCE(SUM(d.value * COALESCE(d.probability, s.probability) / 100.0), 0) AS weighted
                    FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.status = 'open' ${own('d.owner_id')}`);
  const wonMonth = get(`SELECT COUNT(*) AS count, COALESCE(SUM(value), 0) AS value FROM deals WHERE status = 'won' AND closed_at >= ? ${own('owner_id')}`, monthStart);
  const closed90 = get(`SELECT COALESCE(SUM(status = 'won'), 0) AS won, COALESCE(SUM(status = 'lost'), 0) AS lost FROM deals WHERE status IN ('won', 'lost') AND closed_at >= ? ${own('owner_id')}`, d90);

  const months = [];
  for (let i = 5; i >= 0; i--) {
    const m = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
    months.push({ key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`, label: m.toLocaleString('en', { month: 'short' }), value: 0, count: 0 });
  }
  const sixAgo = new Date(nowD.getFullYear(), nowD.getMonth() - 5, 1).toISOString();
  for (const r of all(`SELECT substr(closed_at, 1, 7) AS month, COALESCE(SUM(value), 0) AS value, COUNT(*) AS count
                       FROM deals WHERE status = 'won' AND closed_at >= ? ${own('owner_id')} GROUP BY month`, sixAgo)) {
    const m = months.find((x) => x.key === r.month);
    if (m) { m.value = r.value; m.count = r.count; }
  }

  const email = get(`SELECT COUNT(*) AS sent, COALESCE(SUM(opened_at IS NOT NULL), 0) AS opened, COALESCE(SUM(clicked_at IS NOT NULL), 0) AS clicked,
                       COALESCE(SUM(replied_at IS NOT NULL), 0) AS replied, COALESCE(SUM(bounced), 0) AS bounced
                     FROM emails WHERE direction = 'out' AND status = 'sent' AND sent_at >= ? ${own('user_id')}`, d30);
  const contacts = get(`SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?), 0) AS new_30d FROM contacts WHERE 1 = 1 ${own('owner_id')}`, d30);
  const nowIso = now();
  const taskCounts = get(`SELECT COALESCE(SUM(due_at < ?), 0) AS overdue, COALESCE(SUM(due_at >= ? AND due_at < ?), 0) AS today
                          FROM activities WHERE type = 'task' AND done = 0 AND assigned_to = ?`,
  nowIso, nowIso, endToday.toISOString(), req.user.id || 0);

  res.json({
    open_pipeline: open,
    pipeline,
    won_this_month: wonMonth,
    win_rate: closed90.won + closed90.lost ? closed90.won / (closed90.won + closed90.lost) : null,
    closed_90d: closed90,
    won_by_month: months,
    email_30d: email,
    contacts,
    tasks: taskCounts,
    active_enrollments: get("SELECT COUNT(*) AS n FROM enrollments WHERE status = 'active'").n,
    my_tasks: all(`SELECT ${ACTIVITY_SELECT} FROM ${ACTIVITY_FROM} WHERE a.type = 'task' AND a.done = 0 AND a.assigned_to = ?
                   ORDER BY a.due_at IS NULL, a.due_at LIMIT 8`, req.user.id || 0).map(serializeActivity),
    closing_soon: all(`SELECT ${DEAL_SELECT} FROM ${DEAL_FROM} WHERE d.status = 'open' AND d.expected_close IS NOT NULL AND d.expected_close <= ? ${own('d.owner_id')}
                       ORDER BY d.expected_close LIMIT 6`, addMs(30 * DAY).slice(0, 10)).map(serializeDeal),
    recent: all(`SELECT ${ACTIVITY_SELECT} FROM ${ACTIVITY_FROM} ORDER BY a.created_at DESC LIMIT 12`).map(serializeActivity),
    sources: all(`SELECT COALESCE(source, 'Unknown') AS source, COUNT(*) AS count FROM contacts WHERE 1 = 1 ${own('owner_id')}
                  GROUP BY COALESCE(source, 'Unknown') ORDER BY count DESC LIMIT 6`),
  });
});

// Lookup data the UI and automations need in one call.
crmRoutes.get('/meta', (req, res) => {
  res.json({
    stages: all('SELECT * FROM stages ORDER BY position'),
    users: all('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name'),
    contact_statuses: CONTACT_STATUSES,
    activity_types: ACTIVITY_TYPES,
    tags: [...new Set(all("SELECT tags FROM contacts WHERE tags != '' LIMIT 5000").flatMap((r) => tagsOut(r.tags)))].sort(),
    sources: all("SELECT DISTINCT source FROM contacts WHERE source IS NOT NULL AND source != '' ORDER BY source LIMIT 100").map((r) => r.source),
    sequences: all('SELECT id, name, status FROM sequences ORDER BY name'),
    templates: all('SELECT id, name, subject, category FROM email_templates ORDER BY name'),
    me: { id: req.user.id, name: req.user.name, role: req.user.role },
  });
});

