// Apollo.io connector. Docs: https://docs.apollo.io/reference
// People search (mixed_people/api_search) is free; enrichment (people/match, bulk_match) and org search use credits.
import { get, insert } from '../db.js';
import { getSettings } from '../settings.js';
import { emit, logIntegration } from '../events.js';
import { upsertContact, upsertCompany, updateContact, updateCompany, contactById, companyById } from '../models.js';
import { HttpError, normalizeDomain, chunk, isEmail, now } from '../util.js';

const BASE = 'https://api.apollo.io/api/v1';

function toQuery(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.filter((x) => x !== '' && x !== null && x !== undefined).forEach((x) => q.append(`${k}[]`, String(x)));
    else q.append(k, String(v));
  }
  return q.toString();
}

async function call(method, path, { query, body, action } = {}) {
  const { api_key: apiKey } = getSettings('apollo');
  if (!apiKey) throw new HttpError(400, 'Add your Apollo API key under Integrations → Apollo first');
  const qs = query ? toQuery(query) : '';
  let res;
  try {
    res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json', 'cache-control': 'no-cache' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    logIntegration('apollo', action || path, 'error', err.message);
    throw new HttpError(502, `Could not reach Apollo: ${err.cause?.message || err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = data.error || data.message || (Array.isArray(data.errors) ? data.errors.join(', ') : '') || data.raw || res.statusText;
    const hint = {
      401: ' Check that the API key is correct.',
      403: ' Your Apollo plan or API key does not allow this endpoint (some need a master API key).',
      429: ' Apollo rate limit reached; try again shortly.',
    }[res.status] || '';
    logIntegration('apollo', action || path, 'error', `${res.status} ${msg}`);
    // Never pass Apollo's 401 through: the browser would treat it as a CRM sign-out.
    throw new HttpError(res.status === 422 ? 400 : 502, `Apollo error ${res.status}: ${String(msg).replace(/\.+$/, '')}.${hint}`);
  }
  return data;
}

// ---------- mapping ----------
const cleanEmail = (e) => (e && isEmail(e) && !/not_unlocked|@domain\.com$/i.test(e) ? String(e).toLowerCase() : null);

export function mapPerson(p) {
  const phone = p.phone_numbers?.[0]?.sanitized_number || p.contact?.phone_numbers?.[0]?.sanitized_number || null;
  return {
    apollo_id: p.id || null,
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    email: cleanEmail(p.email) || cleanEmail(p.personal_emails?.[0]),
    email_status: p.email_status || null,
    title: p.title || null,
    linkedin_url: p.linkedin_url || null,
    city: p.city || null,
    state: p.state || null,
    country: p.country || null,
    timezone: p.time_zone || null,
    phone,
  };
}

export function mapOrg(o) {
  if (!o || !o.name) return null;
  return {
    apollo_id: o.id || null,
    name: o.name,
    domain: o.primary_domain || normalizeDomain(o.website_url),
    website: o.website_url || null,
    industry: o.industry || null,
    employees: o.estimated_num_employees || null,
    annual_revenue: o.annual_revenue || null,
    phone: o.phone || o.primary_phone?.number || o.sanitized_phone || null,
    linkedin_url: o.linkedin_url || null,
    city: o.city || null,
    state: o.state || null,
    country: o.country || null,
    address: o.raw_address || o.street_address || null,
    description: o.short_description || null,
  };
}

const ARRAY_FILTERS = ['person_titles', 'person_not_titles', 'person_locations', 'person_seniorities', 'organization_locations',
  'organization_num_employees_ranges', 'q_organization_domains_list', 'contact_email_status', 'organization_ids', 'q_organization_keyword_tags'];
const SCALAR_FILTERS = ['q_keywords', 'q_person_name', 'include_similar_titles', 'q_organization_name'];

function filtersFrom(input = {}) {
  const out = {};
  for (const k of ARRAY_FILTERS) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = (Array.isArray(v) ? v : String(v).split(/\n|;/)).map((x) => String(x).trim()).filter(Boolean);
    if (!out[k].length) delete out[k];
  }
  for (const k of SCALAR_FILTERS) if (input[k] !== undefined && input[k] !== '') out[k] = input[k];
  out.page = Math.max(1, parseInt(input.page, 10) || 1);
  out.per_page = Math.min(100, Math.max(1, parseInt(input.per_page, 10) || 25));
  return out;
}

// ---------- API ----------
export async function testConnection() {
  const data = await call('POST', '/mixed_people/api_search', { query: { per_page: 1, person_titles: ['ceo'] }, action: 'test' });
  logIntegration('apollo', 'test', 'ok', 'Connection OK');
  return { ok: true, sample_total: data.total_entries ?? null };
}

export async function searchPeople(input) {
  const query = filtersFrom(input);
  const data = await call('POST', '/mixed_people/api_search', { query, action: 'people_search' });
  const total = data.total_entries ?? data.pagination?.total_entries ?? 0;
  logIntegration('apollo', 'people_search', 'ok', `${total} matches (page ${query.page})`);
  const people = (data.people || []).map((p) => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name || null,
    last_name_obfuscated: p.last_name_obfuscated || null,
    title: p.title || null,
    has_email: p.has_email ?? null,
    has_direct_phone: p.has_direct_phone ?? null,
    city: p.city || null,
    country: p.country || null,
    linkedin_url: p.linkedin_url || null,
    organization_name: p.organization?.name || null,
    in_crm: !!get('SELECT id FROM contacts WHERE apollo_id = ?', p.id),
  }));
  return { people, total, page: query.page, per_page: query.per_page };
}

export async function searchOrganizations(input) {
  const query = filtersFrom(input);
  const data = await call('POST', '/mixed_companies/search', { query, action: 'org_search' });
  const orgs = [...(data.organizations || []), ...(data.accounts || [])];
  const total = data.pagination?.total_entries ?? orgs.length;
  logIntegration('apollo', 'org_search', 'ok', `${total} matches`);
  return {
    organizations: orgs.map((o) => ({ ...mapOrg(o), in_crm: !!(o.id && get('SELECT id FROM companies WHERE apollo_id = ?', o.id)) })).filter((o) => o.name),
    total,
    page: query.page,
  };
}

export async function importPeople({ people = [], enrich = true, reveal_personal_emails: revealPersonal, tags, status, owner_id: ownerId }, user) {
  if (!Array.isArray(people) || !people.length) throw new HttpError(400, 'Select at least one person to import');
  if (people.length > 500) throw new HttpError(400, 'Import at most 500 people at a time');
  const settings = getSettings('apollo');
  const extraTags = tags ?? settings.default_tags;
  const result = { created: 0, updated: 0, failed: [], contact_ids: [], credits_used: 0, enriched: !!enrich };
  let records = people;
  if (enrich) {
    records = [];
    for (const group of chunk(people, 10)) {
      const data = await call('POST', '/people/bulk_match', {
        query: { reveal_personal_emails: !!(revealPersonal ?? settings.reveal_personal_emails) },
        body: { details: group.map((p) => ({ id: p.id })) },
        action: 'bulk_match',
      });
      const matches = (data.matches || []).filter(Boolean);
      result.credits_used += Number(data.credits_consumed ?? matches.length) || 0;
      const byId = new Map(matches.map((m) => [m.id, m]));
      for (const p of group) records.push(byId.get(p.id) || p);
    }
  }
  for (const p of records) {
    try {
      const org = mapOrg(p.organization) || (p.organization_name ? { name: p.organization_name } : null);
      const companyId = org ? upsertCompany({ ...org, tags: extraTags }, user).company.id : null;
      const { contact, created } = upsertContact({
        ...mapPerson(p),
        company_id: companyId,
        source: 'Apollo',
        status: status || settings.default_status || 'lead',
        tags: extraTags,
        owner_id: ownerId || user?.id || null,
      }, user);
      if (created) result.created++; else result.updated++;
      result.contact_ids.push(contact.id);
    } catch (err) {
      result.failed.push({ id: p.id, name: p.first_name, error: err.message });
    }
  }
  logIntegration('apollo', 'import', 'ok', `${result.created} created, ${result.updated} updated, ${result.failed.length} failed`, result.credits_used);
  emit('apollo.imported', { created: result.created, updated: result.updated, contact_ids: result.contact_ids, credits_used: result.credits_used, by: user?.name || null });
  return result;
}

export async function importOrganizations({ organizations = [], tags }, user) {
  const settings = getSettings('apollo');
  const result = { created: 0, updated: 0, company_ids: [] };
  for (const o of organizations) {
    if (!o?.name) continue;
    const { company, created } = upsertCompany({ ...o, tags: tags ?? settings.default_tags }, user);
    if (created) result.created++; else result.updated++;
    result.company_ids.push(company.id);
  }
  logIntegration('apollo', 'import_orgs', 'ok', `${result.created} created, ${result.updated} updated`);
  return result;
}

export async function enrichContact(id, user, { overwrite = false } = {}) {
  const c = get(`SELECT c.*, co.domain AS company_domain, co.name AS company_name
                 FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ?`, id);
  if (!c) throw new HttpError(404, 'Contact not found');
  const settings = getSettings('apollo');
  const q = { reveal_personal_emails: !!settings.reveal_personal_emails };
  if (c.apollo_id) q.id = c.apollo_id;
  if (c.email) q.email = c.email;
  if (c.linkedin_url) q.linkedin_url = c.linkedin_url;
  if (c.first_name) q.first_name = c.first_name;
  if (c.last_name) q.last_name = c.last_name;
  if (c.company_domain) q.domain = c.company_domain;
  else if (c.company_name) q.organization_name = c.company_name;
  if (!q.id && !q.email && !q.linkedin_url && !(q.first_name && (q.domain || q.organization_name))) {
    throw new HttpError(400, 'To enrich, the contact needs an email, a LinkedIn URL, or a name plus company');
  }
  const data = await call('POST', '/people/match', { query: q, action: 'people_match' });
  if (!data.person) {
    logIntegration('apollo', 'people_match', 'ok', `No match for contact #${id}`);
    return { matched: false, updated_fields: [], contact: contactById(id) };
  }
  const person = mapPerson(data.person);
  const patch = {};
  for (const [k, v] of Object.entries(person)) if (v && (overwrite || !c[k])) patch[k] = v;
  const org = mapOrg(data.person.organization);
  if (!c.company_id && org) patch.company_id = upsertCompany(org, user).company.id;
  const contact = Object.keys(patch).length ? updateContact(id, patch, user) : contactById(id);
  insert('activities', {
    type: 'system', subject: `Enriched from Apollo${Object.keys(patch).length ? `: ${Object.keys(patch).join(', ')}` : ' (no new data)'}`,
    contact_id: id, user_id: user?.id ?? null, done: 1, created_at: now(),
  });
  logIntegration('apollo', 'people_match', 'ok', `Contact #${id}: ${Object.keys(patch).join(', ') || 'no new data'}`, 1);
  return { matched: true, updated_fields: Object.keys(patch), contact };
}

export async function enrichContacts(ids, user) {
  const out = { matched: 0, unmatched: 0, failed: [] };
  for (const id of ids.slice(0, 200)) {
    try {
      const r = await enrichContact(Number(id), user);
      if (r.matched) out.matched++; else out.unmatched++;
    } catch (err) {
      out.failed.push({ id, error: err.message });
    }
  }
  return out;
}

export async function enrichCompany(id, user, { overwrite = false } = {}) {
  const co = get('SELECT * FROM companies WHERE id = ?', id);
  if (!co) throw new HttpError(404, 'Company not found');
  const domain = co.domain || normalizeDomain(co.website);
  if (!domain) throw new HttpError(400, 'Add the company website or domain first');
  const data = await call('GET', '/organizations/enrich', { query: { domain }, action: 'org_enrich' });
  const org = mapOrg(data.organization);
  if (!org) return { matched: false, updated_fields: [], company: companyById(id) };
  const patch = {};
  for (const [k, v] of Object.entries(org)) if (v && k !== 'name' && (overwrite || !co[k])) patch[k] = v;
  const company = Object.keys(patch).length ? updateCompany(id, patch, user) : companyById(id);
  logIntegration('apollo', 'org_enrich', 'ok', `Company #${id}: ${Object.keys(patch).join(', ') || 'no new data'}`, 1);
  return { matched: true, updated_fields: Object.keys(patch), company };
}

export async function listSequences() {
  const data = await call('POST', '/emailer_campaigns/search', { query: { per_page: 100 }, action: 'sequences' });
  return (data.emailer_campaigns || []).map((s) => ({ id: s.id, name: s.name, active: s.active, num_steps: s.num_steps ?? null }));
}

export async function listEmailAccounts() {
  const data = await call('GET', '/email_accounts', { action: 'email_accounts' });
  return (data.email_accounts || []).map((a) => ({ id: a.id, email: a.email, active: a.active, default: a.default }));
}

export async function pushToSequence({ contact_ids: contactIds = [], sequence_id: sequenceId, email_account_id: emailAccountId }, user) {
  if (!sequenceId || !emailAccountId) throw new HttpError(400, 'Choose an Apollo sequence and a sending mailbox');
  const apolloIds = [];
  const skipped = [];
  for (const id of contactIds.slice(0, 200)) {
    const c = contactById(Number(id));
    if (!c?.email) { skipped.push({ id, reason: 'no email' }); continue; }
    if (c.unsubscribed) { skipped.push({ id, reason: 'unsubscribed' }); continue; }
    const data = await call('POST', '/contacts', {
      query: {
        first_name: c.first_name, last_name: c.last_name, email: c.email, title: c.title,
        organization_name: c.company_name, website_url: c.company_domain, linkedin_url: c.linkedin_url, run_dedupe: true,
      },
      action: 'create_contact',
    });
    if (data.contact?.id) {
      apolloIds.push(data.contact.id);
      insert('activities', { type: 'system', subject: 'Added to an Apollo sequence', contact_id: c.id, user_id: user?.id ?? null, done: 1, created_at: now() });
    }
  }
  if (!apolloIds.length) throw new HttpError(400, 'None of the selected contacts could be pushed (they need an email address)');
  await call('POST', `/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids`, {
    query: { emailer_campaign_id: sequenceId, contact_ids: apolloIds, send_email_from_email_account_id: emailAccountId },
    action: 'add_to_sequence',
  });
  logIntegration('apollo', 'add_to_sequence', 'ok', `${apolloIds.length} contacts → sequence ${sequenceId}`);
  return { added: apolloIds.length, skipped };
}
