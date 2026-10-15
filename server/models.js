import { get, all, run, insert, update } from './db.js';
import { now, pick, tagsIn, tagsOut, jsonOut, HttpError, isEmail, normalizeDomain } from './util.js';
import { emit } from './events.js';

export const CONTACT_STATUSES = ['lead', 'contacted', 'qualified', 'customer', 'partner', 'churned'];
export const ACTIVITY_TYPES = ['note', 'call', 'meeting', 'task', 'email', 'sms', 'whatsapp', 'linkedin', 'system'];

export const CONTACT_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'mobile', 'title', 'company_id', 'owner_id', 'status', 'source',
  'linkedin_url', 'website', 'city', 'state', 'country', 'timezone', 'tags', 'score', 'email_status', 'unsubscribed', 'apollo_id', 'notes', 'custom'];
export const COMPANY_FIELDS = ['name', 'domain', 'website', 'industry', 'employees', 'annual_revenue', 'phone', 'address', 'city', 'state', 'country',
  'linkedin_url', 'description', 'tags', 'owner_id', 'apollo_id', 'custom'];
export const DEAL_FIELDS = ['title', 'value', 'currency', 'stage_id', 'contact_id', 'company_id', 'owner_id', 'expected_close', 'probability',
  'source', 'lost_reason', 'description', 'tags', 'custom'];
export const ACTIVITY_FIELDS = ['type', 'subject', 'body', 'contact_id', 'company_id', 'deal_id', 'assigned_to', 'due_at', 'done', 'priority', 'meta'];

const INT_FIELDS = new Set(['company_id', 'owner_id', 'contact_id', 'deal_id', 'stage_id', 'assigned_to', 'score', 'employees', 'probability']);
const NUM_FIELDS = new Set(['value', 'annual_revenue']);
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com', 'zoho.com', 'rediffmail.com']);

export const fullName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || 'Unnamed';

// Normalizes a whitelisted input object for storage.
function clean(input, fields) {
  const d = pick(input, fields);
  for (const [k, v] of Object.entries(d)) {
    if (k === 'tags') d[k] = tagsIn(v) ?? '';
    else if (k === 'custom' || k === 'meta') d[k] = JSON.stringify(v && typeof v === 'object' ? v : jsonOut(v, {}));
    else if (INT_FIELDS.has(k)) d[k] = v === '' || v === null || v === undefined ? null : (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : null);
    else if (NUM_FIELDS.has(k)) d[k] = v === '' || v === null || v === undefined ? (k === 'value' ? 0 : null) : Number(v) || 0;
    else if (k === 'unsubscribed' || k === 'done') d[k] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    else if (typeof v === 'string') d[k] = v.trim() === '' ? null : v.trim();
  }
  return d;
}

// ---------- serializers ----------
export function serializeContact(r) {
  if (!r) return null;
  return { ...r, full_name: fullName(r), tags: tagsOut(r.tags), custom: jsonOut(r.custom), unsubscribed: !!r.unsubscribed };
}
export function serializeCompany(r) {
  if (!r) return null;
  return { ...r, tags: tagsOut(r.tags), custom: jsonOut(r.custom) };
}
export function serializeDeal(r) {
  if (!r) return null;
  const out = { ...r, tags: tagsOut(r.tags), custom: jsonOut(r.custom) };
  if ('contact_first_name' in r) {
    out.contact_name = r.contact_id ? fullName({ first_name: r.contact_first_name, last_name: r.contact_last_name, email: r.contact_email }) : null;
    delete out.contact_first_name; delete out.contact_last_name;
  }
  return out;
}
export function serializeActivity(r) {
  if (!r) return null;
  const out = { ...r, done: !!r.done, meta: jsonOut(r.meta) };
  if ('contact_first_name' in r) {
    out.contact_name = r.contact_id ? fullName({ first_name: r.contact_first_name, last_name: r.contact_last_name, email: r.contact_email }) : null;
    delete out.contact_first_name; delete out.contact_last_name;
  }
  return out;
}

export const CONTACT_SELECT = `c.*, co.name AS company_name, co.domain AS company_domain, u.name AS owner_name`;
export const CONTACT_FROM = `contacts c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = c.owner_id`;
export const DEAL_SELECT = `d.*, s.name AS stage_name, s.kind AS stage_kind, s.probability AS stage_probability,
  ct.first_name AS contact_first_name, ct.last_name AS contact_last_name, ct.email AS contact_email,
  co.name AS company_name, u.name AS owner_name`;
export const DEAL_FROM = `deals d LEFT JOIN stages s ON s.id = d.stage_id LEFT JOIN contacts ct ON ct.id = d.contact_id
  LEFT JOIN companies co ON co.id = d.company_id LEFT JOIN users u ON u.id = d.owner_id`;
export const ACTIVITY_SELECT = `a.*, ct.first_name AS contact_first_name, ct.last_name AS contact_last_name, ct.email AS contact_email,
  co.name AS company_name, dl.title AS deal_title, u.name AS user_name, asg.name AS assigned_name`;
export const ACTIVITY_FROM = `activities a LEFT JOIN contacts ct ON ct.id = a.contact_id LEFT JOIN companies co ON co.id = a.company_id
  LEFT JOIN deals dl ON dl.id = a.deal_id LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users asg ON asg.id = a.assigned_to`;

export const contactById = (id) => serializeContact(get(`SELECT ${CONTACT_SELECT} FROM ${CONTACT_FROM} WHERE c.id = ?`, id));
export const companyById = (id) => serializeCompany(get(`SELECT co.*, u.name AS owner_name FROM companies co LEFT JOIN users u ON u.id = co.owner_id WHERE co.id = ?`, id));
export const dealById = (id) => serializeDeal(get(`SELECT ${DEAL_SELECT} FROM ${DEAL_FROM} WHERE d.id = ?`, id));
export const activityById = (id) => serializeActivity(get(`SELECT ${ACTIVITY_SELECT} FROM ${ACTIVITY_FROM} WHERE a.id = ?`, id));

function mustExist(table, id, label) {
  if (id === null || id === undefined) return;
  if (!get(`SELECT id FROM ${table} WHERE id = ?`, id)) throw new HttpError(400, `${label} #${id} does not exist`);
}

// ---------- companies ----------
export function createCompany(input, user, { silent = false } = {}) {
  const d = clean(input, COMPANY_FIELDS);
  if (!d.name) {
    if (d.domain) d.name = d.domain;
    else throw new HttpError(400, 'Company name is required');
  }
  if (d.domain) d.domain = normalizeDomain(d.domain);
  else if (d.website) d.domain = normalizeDomain(d.website);
  if (d.owner_id === undefined) d.owner_id = user?.id ?? null;
  const t = now();
  const id = insert('companies', { tags: '', custom: '{}', ...d, created_at: t, updated_at: t });
  const company = companyById(id);
  if (!silent) emit('company.created', { company });
  return company;
}

export function updateCompany(id, input, user, { silent = false } = {}) {
  const existing = get('SELECT * FROM companies WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'Company not found');
  const d = clean(input, COMPANY_FIELDS);
  if ('name' in d && !d.name) throw new HttpError(400, 'Company name cannot be empty');
  if ('domain' in d) d.domain = normalizeDomain(d.domain);
  if (!Object.keys(d).length) return companyById(id);
  update('companies', id, { ...d, updated_at: now() });
  const company = companyById(id);
  if (!silent) emit('company.updated', { company, changed: Object.keys(d) });
  return company;
}

export function deleteCompany(id) {
  const company = companyById(id);
  if (!company) throw new HttpError(404, 'Company not found');
  run('DELETE FROM companies WHERE id = ?', id);
  emit('company.deleted', { company });
  return company;
}

export function findCompany({ apollo_id, domain, name }) {
  if (apollo_id) { const r = get('SELECT * FROM companies WHERE apollo_id = ?', apollo_id); if (r) return r; }
  const dom = normalizeDomain(domain);
  if (dom) { const r = get('SELECT * FROM companies WHERE domain = ?', dom); if (r) return r; }
  if (name) { const r = get('SELECT * FROM companies WHERE name = ? COLLATE NOCASE', String(name).trim()); if (r) return r; }
  return null;
}

// Finds a company by apollo id / domain / name, filling only empty fields unless overwrite is set.
export function upsertCompany(data, user, { overwrite = false, silent = false } = {}) {
  const existing = findCompany(data);
  if (!existing) return { company: createCompany(data, user, { silent }), created: true };
  const patch = {};
  for (const [k, v] of Object.entries(pick(data, COMPANY_FIELDS))) {
    if (v === null || v === undefined || v === '') continue;
    if (k === 'tags') { patch.tags = [...tagsOut(existing.tags), ...tagsOut(tagsIn(v))]; continue; }
    if (overwrite || existing[k] === null || existing[k] === '') patch[k] = v;
  }
  const company = Object.keys(patch).length ? updateCompany(existing.id, patch, user, { silent }) : companyById(existing.id);
  return { company, created: false };
}

// ---------- contacts ----------
function resolveCompany(input, user, silent = false) {
  if (input.company_id) return input.company_id;
  const name = input.company_name || input.company;
  let domain = input.company_domain || null;
  if (!domain && input.email && isEmail(input.email)) {
    const d = String(input.email).split('@')[1].toLowerCase();
    if (!FREE_MAIL.has(d)) domain = d;
  }
  if (!name && !input.company_domain) return undefined;
  const { company } = upsertCompany({ name: name || domain, domain }, user, { silent });
  return company.id;
}

export function createContact(input, user, { silent = false } = {}) {
  const d = clean(input, CONTACT_FIELDS);
  if (d.email) {
    d.email = d.email.toLowerCase();
    if (!isEmail(d.email)) throw new HttpError(400, `Invalid email address: ${d.email}`);
  }
  if (!d.first_name && !d.last_name && !d.email) throw new HttpError(400, 'A contact needs at least a name or an email');
  if (d.status && !CONTACT_STATUSES.includes(d.status)) throw new HttpError(400, `Status must be one of: ${CONTACT_STATUSES.join(', ')}`);
  const companyId = resolveCompany(input, user, silent);
  if (companyId !== undefined) d.company_id = companyId;
  mustExist('companies', d.company_id, 'Company');
  if (d.owner_id === undefined) d.owner_id = user?.id ?? null;
  const t = now();
  const id = insert('contacts', { tags: '', custom: '{}', status: 'lead', ...d, created_at: t, updated_at: t });
  const contact = contactById(id);
  if (!silent) emit('contact.created', { contact });
  return contact;
}

export function updateContact(id, input, user, { silent = false } = {}) {
  const existing = get('SELECT * FROM contacts WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'Contact not found');
  const d = clean(input, CONTACT_FIELDS);
  if (d.email) {
    d.email = d.email.toLowerCase();
    if (!isEmail(d.email)) throw new HttpError(400, `Invalid email address: ${d.email}`);
  }
  if (d.status && !CONTACT_STATUSES.includes(d.status)) throw new HttpError(400, `Status must be one of: ${CONTACT_STATUSES.join(', ')}`);
  if (!('company_id' in d) && (input.company_name || input.company)) d.company_id = resolveCompany({ ...input, email: d.email || existing.email }, user, silent);
  if ('company_id' in d) mustExist('companies', d.company_id, 'Company');
  const changed = Object.keys(d).filter((k) => String(d[k] ?? '') !== String(existing[k] ?? ''));
  if (!changed.length) return contactById(id);
  update('contacts', id, { ...d, updated_at: now() });
  const contact = contactById(id);
  if (!silent) emit('contact.updated', { contact, changed });
  return contact;
}

export function deleteContact(id) {
  const contact = contactById(id);
  if (!contact) throw new HttpError(404, 'Contact not found');
  run('DELETE FROM contacts WHERE id = ?', id);
  emit('contact.deleted', { contact });
  return contact;
}

export function findContact({ apollo_id, email }) {
  if (apollo_id) { const r = get('SELECT * FROM contacts WHERE apollo_id = ?', apollo_id); if (r) return r; }
  if (email) { const r = get('SELECT * FROM contacts WHERE email = ?', String(email).trim().toLowerCase()); if (r) return r; }
  return null;
}

export function upsertContact(data, user, { overwrite = false, silent = false } = {}) {
  const existing = findContact(data);
  if (!existing) return { contact: createContact(data, user, { silent }), created: true };
  const patch = {};
  for (const [k, v] of Object.entries(pick(data, CONTACT_FIELDS))) {
    if (v === null || v === undefined || v === '') continue;
    if (k === 'tags') { patch.tags = [...tagsOut(existing.tags), ...tagsOut(tagsIn(v))]; continue; }
    if (overwrite || existing[k] === null || existing[k] === '') patch[k] = v;
  }
  if (!existing.company_id && (data.company_name || data.company || data.company_domain)) {
    patch.company_id = resolveCompany({ ...data, email: data.email || existing.email }, user, silent);
  }
  const contact = Object.keys(patch).length ? updateContact(existing.id, patch, user, { silent }) : contactById(existing.id);
  return { contact, created: false };
}

export function bumpScore(contactId, points) {
  if (contactId) run('UPDATE contacts SET score = score + ? WHERE id = ?', points, contactId);
}

// ---------- deals ----------
export const stageById = (id) => get('SELECT * FROM stages WHERE id = ?', id);
export const firstOpenStage = () => get("SELECT * FROM stages WHERE kind = 'open' ORDER BY position LIMIT 1") || get('SELECT * FROM stages ORDER BY position LIMIT 1');

export function createDeal(input, user) {
  const d = clean(input, DEAL_FIELDS);
  if (!d.title) throw new HttpError(400, 'Deal title is required');
  const stage = d.stage_id ? stageById(d.stage_id) : firstOpenStage();
  if (!stage) throw new HttpError(400, 'Pipeline stage not found');
  mustExist('contacts', d.contact_id, 'Contact');
  mustExist('companies', d.company_id, 'Company');
  if (d.contact_id && !d.company_id) d.company_id = get('SELECT company_id FROM contacts WHERE id = ?', d.contact_id)?.company_id ?? null;
  if (d.owner_id === undefined) d.owner_id = user?.id ?? null;
  const t = now();
  const maxPos = get('SELECT MAX(position) AS p FROM deals WHERE stage_id = ?', stage.id)?.p ?? 0;
  const id = insert('deals', {
    tags: '', custom: '{}', value: 0, ...d, stage_id: stage.id, status: stage.kind, position: maxPos + 1,
    closed_at: stage.kind === 'open' ? null : t, stage_changed_at: t, created_at: t, updated_at: t,
  });
  const deal = dealById(id);
  emit('deal.created', { deal });
  if (stage.kind === 'won') emit('deal.won', { deal });
  return deal;
}

export function updateDeal(id, input, user) {
  const existing = get('SELECT * FROM deals WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'Deal not found');
  const d = clean(input, DEAL_FIELDS);
  if ('title' in d && !d.title) throw new HttpError(400, 'Deal title cannot be empty');
  if ('contact_id' in d) mustExist('contacts', d.contact_id, 'Contact');
  if ('company_id' in d) mustExist('companies', d.company_id, 'Company');
  const t = now();
  let fromStage = null;
  let toStage = null;
  if (d.stage_id && d.stage_id !== existing.stage_id) {
    toStage = stageById(d.stage_id);
    if (!toStage) throw new HttpError(400, 'Pipeline stage not found');
    fromStage = stageById(existing.stage_id);
    d.status = toStage.kind;
    d.stage_changed_at = t;
    d.closed_at = toStage.kind === 'open' ? null : t;
    if (input.position === undefined) d.position = (get('SELECT MAX(position) AS p FROM deals WHERE stage_id = ?', toStage.id)?.p ?? 0) + 1;
  }
  if (input.position !== undefined) d.position = Number(input.position) || 0;
  if (!Object.keys(d).length) return dealById(id);
  update('deals', id, { ...d, updated_at: t });
  const deal = dealById(id);
  if (toStage) {
    insert('activities', {
      type: 'system', subject: `Stage changed: ${fromStage?.name || '—'} → ${toStage.name}`, deal_id: id,
      contact_id: deal.contact_id, user_id: user?.id ?? null, created_at: t, done: 1,
    });
    emit('deal.stage_changed', { deal, from_stage: fromStage, to_stage: toStage });
    if (toStage.kind === 'won') emit('deal.won', { deal });
    if (toStage.kind === 'lost') emit('deal.lost', { deal, reason: deal.lost_reason });
  } else {
    emit('deal.updated', { deal, changed: Object.keys(d) });
  }
  return deal;
}

export function deleteDeal(id) {
  const deal = dealById(id);
  if (!deal) throw new HttpError(404, 'Deal not found');
  run('DELETE FROM deals WHERE id = ?', id);
  emit('deal.deleted', { deal });
  return deal;
}

// ---------- activities & tasks ----------
export function createActivity(input, user, { silent = false } = {}) {
  const d = clean(input, ACTIVITY_FIELDS);
  if (!d.type) d.type = 'note';
  if (!ACTIVITY_TYPES.includes(d.type)) throw new HttpError(400, `Activity type must be one of: ${ACTIVITY_TYPES.join(', ')}`);
  if (!d.subject && !d.body) throw new HttpError(400, 'Add a subject or some text');
  mustExist('contacts', d.contact_id, 'Contact');
  mustExist('companies', d.company_id, 'Company');
  mustExist('deals', d.deal_id, 'Deal');
  if (d.type === 'task' && d.assigned_to === undefined) d.assigned_to = user?.id ?? null;
  if (d.type !== 'task' && d.done === undefined) d.done = 1;
  const t = now();
  const id = insert('activities', { meta: '{}', ...d, user_id: user?.id ?? null, done_at: d.done ? t : null, created_at: t });
  if (d.contact_id && ['call', 'meeting', 'email', 'sms', 'whatsapp', 'linkedin'].includes(d.type)) {
    run('UPDATE contacts SET last_contacted_at = ? WHERE id = ?', t, d.contact_id);
  }
  const activity = activityById(id);
  if (!silent) emit(d.type === 'task' ? 'task.created' : 'activity.created', { activity });
  return activity;
}

export function updateActivity(id, input, user) {
  const existing = get('SELECT * FROM activities WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'Activity not found');
  const d = clean(input, ACTIVITY_FIELDS);
  if (d.type && !ACTIVITY_TYPES.includes(d.type)) throw new HttpError(400, 'Invalid activity type');
  const completing = 'done' in d && d.done && !existing.done;
  if ('done' in d) d.done_at = d.done ? (existing.done_at || now()) : null;
  if ('due_at' in d && d.due_at !== existing.due_at) d.reminded = 0;
  if (!Object.keys(d).length) return activityById(id);
  update('activities', id, d);
  const activity = activityById(id);
  if (completing && existing.type === 'task') emit('task.completed', { activity, completed_by: user?.name });
  return activity;
}

export function deleteActivity(id) {
  if (!run('DELETE FROM activities WHERE id = ?', id).changes) throw new HttpError(404, 'Activity not found');
}

// Merged activity + email history, newest first.
export function timeline({ contact_id, company_id, deal_id }, limit = 200) {
  let actWhere; let emailWhere; let params;
  if (contact_id) {
    actWhere = 'a.contact_id = ?'; emailWhere = 'e.contact_id = ?'; params = [contact_id];
  } else if (company_id) {
    actWhere = `(a.company_id = ? OR a.contact_id IN (SELECT id FROM contacts WHERE company_id = ?) OR a.deal_id IN (SELECT id FROM deals WHERE company_id = ?))`;
    emailWhere = 'e.contact_id IN (SELECT id FROM contacts WHERE company_id = ?)';
    params = [company_id];
  } else if (deal_id) {
    actWhere = 'a.deal_id = ?'; emailWhere = 'e.deal_id = ?'; params = [deal_id];
  } else return [];
  const actParams = company_id ? [company_id, company_id, company_id] : params;
  const acts = all(`SELECT ${ACTIVITY_SELECT} FROM ${ACTIVITY_FROM} WHERE ${actWhere} ORDER BY a.created_at DESC LIMIT ${limit}`, ...actParams)
    .map((a) => ({ kind: 'activity', date: a.created_at, ...serializeActivity(a) }));
  const emails = all(`SELECT e.id, e.direction, e.status, e.contact_id, e.subject, e.body, e.from_addr, e.to_addr, e.error, e.sent_at, e.created_at,
                        e.opened_at, e.open_count, e.clicked_at, e.click_count, e.replied_at, e.campaign_id, e.enrollment_id, u.name AS user_name
                      FROM emails e LEFT JOIN users u ON u.id = e.user_id
                      WHERE ${emailWhere} ORDER BY e.created_at DESC LIMIT ${limit}`, ...params)
    .map((e) => ({ kind: 'email', date: e.sent_at || e.created_at, ...e }));
  return [...acts, ...emails].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
}
