import crypto from 'node:crypto';
import { all, run, insert } from './db.js';
import { now, addMs, hmac, jsonOut } from './util.js';

// Every event the CRM emits. Subscribe to them from n8n (or anything else) via Integrations → Webhooks.
export const EVENT_TYPES = [
  'contact.created', 'contact.updated', 'contact.deleted', 'contact.unsubscribed', 'contacts.imported',
  'company.created', 'company.updated', 'company.deleted',
  'deal.created', 'deal.updated', 'deal.stage_changed', 'deal.won', 'deal.lost', 'deal.deleted',
  'activity.created', 'task.created', 'task.completed', 'task.due',
  'email.sent', 'email.failed', 'email.opened', 'email.clicked', 'email.replied', 'email.bounced',
  'sequence.enrolled', 'sequence.completed',
  'form.submitted', 'apollo.imported',
];

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

const listeners = new Map();
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

export function emit(type, data) {
  setImmediate(() => {
    for (const fn of listeners.get(type) || []) {
      try { fn(data); } catch (err) { console.error(`[events] listener for ${type} failed:`, err.message); }
    }
    dispatch(type, data).catch((err) => console.error('[webhooks]', err.message));
  });
}

export function eventMatches(subscribed, type) {
  const list = String(subscribed || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.some((e) => e === '*' || e === type || (e.endsWith('.*') && type.startsWith(e.slice(0, -1))));
}

async function dispatch(type, data) {
  const hooks = all('SELECT * FROM webhooks WHERE active = 1').filter((h) => eventMatches(h.events, type));
  if (!hooks.length) return;
  const payload = { id: crypto.randomUUID(), event: type, created_at: now(), source: 'adas-globus-crm', data };
  await Promise.all(hooks.map((h) => deliver(h, payload, 1)));
}

export async function deliver(hook, payload, attempt = 1) {
  const body = JSON.stringify(payload);
  const started = Date.now();
  let status = 0;
  let response = '';
  let ok = false;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'AdasGlobusCRM-Webhooks/1.0',
        'x-crm-event': payload.event,
        'x-crm-delivery': payload.id,
        'x-crm-signature': `sha256=${hmac(hook.secret, body)}`,
        ...jsonOut(hook.headers, {}),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    response = (await res.text()).slice(0, 2000);
    ok = res.ok;
  } catch (err) {
    response = err.cause?.message || err.message;
  }
  insert('webhook_deliveries', {
    webhook_id: hook.id,
    event: payload.event,
    payload: body,
    status_code: status,
    response,
    attempt,
    success: ok ? 1 : 0,
    next_retry_at: !ok && attempt < MAX_ATTEMPTS ? addMs(RETRY_DELAYS_MS[attempt - 1]) : null,
    duration_ms: Date.now() - started,
    created_at: now(),
  });
  run('UPDATE webhooks SET last_status = ?, last_delivery_at = ? WHERE id = ?', status, now(), hook.id);
  return { ok, status, response };
}

export async function retryFailedDeliveries() {
  const due = all(`SELECT d.id, d.payload, d.attempt, w.id AS webhook_id, w.url, w.secret, w.headers, w.active
                   FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
                   WHERE d.success = 0 AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= ?
                   ORDER BY d.next_retry_at LIMIT 50`, now());
  for (const d of due) {
    run('UPDATE webhook_deliveries SET next_retry_at = NULL WHERE id = ?', d.id);
    if (!d.active) continue;
    await deliver({ id: d.webhook_id, url: d.url, secret: d.secret, headers: d.headers }, JSON.parse(d.payload), d.attempt + 1);
  }
  run('DELETE FROM webhook_deliveries WHERE created_at < ?', addMs(-14 * 86_400_000));
}

export function logIntegration(integration, action, status, detail = '', credits = 0) {
  insert('integration_log', {
    integration, action, status, detail: String(detail || '').slice(0, 1000), credits, created_at: now(),
  });
}
