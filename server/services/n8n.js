// One-click n8n setup through the n8n public REST API (Settings → n8n API in n8n).
// Installs our workflow templates, creates the CRM credential inside n8n, and registers the CRM webhooks.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../config.js';
import { get, run, insert } from '../db.js';
import { getSettings, getState, setState } from '../settings.js';
import { createApiKey } from '../auth.js';
import { logIntegration } from '../events.js';
import { N8N_TEMPLATES, templateBySlug } from '../n8n-templates.js';
import { HttpError, now, randomToken } from '../util.js';

export const CREDENTIAL_NAME = 'Adas Globus CRM API key';

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
export const n8nBase = () => trimUrl(getSettings('n8n').url);
export const editorBase = () => trimUrl(getSettings('n8n').editor_url) || n8nBase();
export const crmUrlForN8n = () => trimUrl(getSettings('n8n').crm_url) || config.baseUrl;

async function n8nCall(method, apiPath, body) {
  const s = getSettings('n8n');
  const base = n8nBase();
  if (!base || !s.api_key) throw new HttpError(400, 'Add your n8n URL and n8n API key first (Integrations → n8n & webhooks)');
  let res;
  try {
    res = await fetch(`${base}/api/v1${apiPath}`, {
      method,
      headers: { 'X-N8N-API-KEY': s.api_key, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach n8n at ${base}: ${err.cause?.code || err.cause?.message || err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (check the n8n API key)' : res.status === 404 ? ' (is the URL your n8n address, and is the public API enabled?)' : '';
    // Never pass 401 through: the browser would treat it as a CRM sign-out.
    throw new HttpError(res.status === 400 ? 400 : 502, `n8n ${res.status}: ${data.message || res.statusText}${hint}`);
  }
  return data;
}

export async function testConnection() {
  const data = await n8nCall('GET', '/workflows?limit=250');
  logIntegration('n8n', 'test', 'ok', `Connected to ${n8nBase()}`);
  return { ok: true, workflows: (data.data || []).length };
}

// Creates (once) an n8n Header Auth credential holding a fresh CRM API key.
async function ensureCredential(user, force = false) {
  const state = getState('n8n', {});
  if (!force && state.credential_id && state.credential_for === n8nBase()) return state.credential_id;
  const owner = user?.id ? user : get("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
  const { id: keyId, key } = createApiKey('n8n (one-click setup)', owner?.id ?? null);
  try {
    const cred = await n8nCall('POST', '/credentials', {
      name: CREDENTIAL_NAME, type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${key}` },
    });
    setState('n8n', { ...getState('n8n', {}), credential_id: cred.id, credential_for: n8nBase(), api_key_id: keyId });
    logIntegration('n8n', 'credential', 'ok', `Created credential ${cred.id} in n8n`);
    return cred.id;
  } catch (err) {
    run('UPDATE api_keys SET revoked = 1 WHERE id = ?', keyId);
    throw err;
  }
}

function loadTemplate(slug) {
  const file = path.join(ROOT, 'public', 'n8n', `${slug}.json`);
  if (!fs.existsSync(file)) throw new HttpError(404, `Template file ${slug}.json is missing`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function prepareNode(node, credentialId, values) {
  const n = structuredClone(node);
  if (n.type === 'n8n-nodes-base.webhook') n.webhookId = crypto.randomUUID();
  if (n.name === 'CRM config') {
    for (const a of n.parameters?.assignments?.assignments || []) {
      if (a.name === 'crm_url') a.value = crmUrlForN8n();
      else if (values[a.name] !== undefined && values[a.name] !== null && String(values[a.name]).trim() !== '') {
        a.value = a.type === 'number' ? Number(values[a.name]) : String(values[a.name]).trim();
      }
    }
  }
  if (n.type === 'n8n-nodes-base.httpRequest' && n.parameters?.genericAuthType === 'httpHeaderAuth') {
    n.credentials = { httpHeaderAuth: { id: credentialId, name: CREDENTIAL_NAME } };
  }
  return n;
}

const installs = () => getState('n8n', {}).installs || {};
function saveInstall(slug, value) {
  const state = getState('n8n', {});
  const next = { ...(state.installs || {}) };
  if (value) next[slug] = value; else delete next[slug];
  setState('n8n', { ...state, installs: next });
}

export async function listTemplates() {
  const s = getSettings('n8n');
  const configured = !!(n8nBase() && s.api_key);
  let remote = null;
  let status = configured ? 'ok' : 'not_configured';
  let error = null;
  if (configured) {
    try {
      remote = new Map(((await n8nCall('GET', '/workflows?limit=250')).data || []).map((w) => [String(w.id), w]));
    } catch (err) {
      status = 'error';
      error = err.message;
    }
  }
  const inst = installs();
  return {
    configured,
    status,
    error,
    n8n_url: n8nBase(),
    editor_url: editorBase(),
    crm_url_for_n8n: crmUrlForN8n(),
    templates: N8N_TEMPLATES.map((t) => {
      const i = inst[t.slug];
      const wf = i && remote ? remote.get(String(i.workflow_id)) : null;
      return {
        ...t,
        file: `/n8n/${t.slug}.json`,
        installed: i ? {
          workflow_id: i.workflow_id,
          installed_at: i.installed_at,
          values: i.values || {},
          active: wf ? !!wf.active : i.active,
          missing: remote ? !wf : false,
          editor_url: `${editorBase()}/workflow/${i.workflow_id}`,
          webhook_id: i.webhook_id,
        } : null,
        public_webhook_url: t.trigger === 'external' ? `${editorBase()}/webhook/${t.webhookPath}` : null,
      };
    }),
  };
}

export async function installTemplate(slug, { values = {}, activate = true } = {}, user) {
  const tpl = templateBySlug(slug);
  if (!tpl) throw new HttpError(404, 'Unknown template');
  for (const f of tpl.fields) {
    if (f.required && !String(values[f.key] ?? '').trim()) throw new HttpError(400, `${f.label} is required`);
  }
  const wf = loadTemplate(slug);
  if (installs()[slug]) await uninstallTemplate(slug, { force: true });

  const build = (credentialId) => ({
    name: wf.name,
    nodes: wf.nodes.map((n) => prepareNode(n, credentialId, values)),
    connections: wf.connections,
    settings: { executionOrder: 'v1' },
  });
  let credentialId = await ensureCredential(user);
  let created;
  try {
    created = await n8nCall('POST', '/workflows', build(credentialId));
  } catch (err) {
    if (!/credential/i.test(err.message)) throw err;
    // The saved credential was deleted in n8n: make a new one and retry once.
    credentialId = await ensureCredential(user, true);
    created = await n8nCall('POST', '/workflows', build(credentialId));
  }

  let active = false;
  let activationError = null;
  if (activate) {
    try {
      await n8nCall('POST', `/workflows/${created.id}/activate`);
      active = true;
    } catch (err) {
      activationError = err.message;
    }
  }

  let webhookId = null;
  if (tpl.trigger === 'crm') {
    webhookId = insert('webhooks', {
      name: `n8n: ${tpl.title}`,
      url: `${n8nBase()}/webhook/${tpl.webhookPath}`,
      events: tpl.events.join(','),
      secret: `whsec_${randomToken(24)}`,
      headers: '{}',
      active: 1,
      created_at: now(),
    });
  }
  // Remember answers for re-installs, but never secrets.
  const safeValues = Object.fromEntries(Object.entries(values).filter(([k]) => !/token|secret|key|password/i.test(k)));
  saveInstall(slug, { workflow_id: created.id, webhook_id: webhookId, active, installed_at: now(), values: safeValues });
  logIntegration('n8n', 'install', activationError ? 'error' : 'ok',
    `${tpl.title} → workflow ${created.id}${active ? ' (active)' : ''}${activationError ? `; activation failed: ${activationError}` : ''}`);
  return {
    workflow_id: created.id,
    active,
    activation_error: activationError,
    webhook_id: webhookId,
    editor_url: `${editorBase()}/workflow/${created.id}`,
    public_webhook_url: tpl.trigger === 'external' ? `${editorBase()}/webhook/${tpl.webhookPath}` : null,
  };
}

export async function uninstallTemplate(slug, { force = false } = {}) {
  const inst = installs()[slug];
  if (!inst) return { removed: false };
  try {
    await n8nCall('DELETE', `/workflows/${inst.workflow_id}`);
  } catch (err) {
    if (!force && !/ 404/.test(err.message)) throw err;
  }
  if (inst.webhook_id) run('DELETE FROM webhooks WHERE id = ?', inst.webhook_id);
  saveInstall(slug, null);
  logIntegration('n8n', 'uninstall', 'ok', `${slug} (workflow ${inst.workflow_id})`);
  return { removed: true };
}

export async function resetCredential(user) {
  const id = await ensureCredential(user, true);
  return { credential_id: id, note: 'New credential created. Re-install workflows to use it.' };
}
