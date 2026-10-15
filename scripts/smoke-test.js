// End-to-end smoke test: boots the CRM against a throwaway database and exercises the main API flows.
// Run with: npm run smoke
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agp-crm-smoke-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const HOOK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) failures++;
};

// Webhook receiver standing in for n8n
const received = [];
const hookServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ headers: req.headers, body: JSON.parse(body || '{}'), raw: body });
    res.end('ok');
  });
}).listen(HOOK_PORT);

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, BASE_URL: BASE, MAIL_DRY_RUN: 'true', SCHEDULER_INTERVAL_MS: '3600000', APP_SECRET: 'smoke-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

let cookie = '';
async function api(method, url, body, { key, raw } = {}) {
  const headers = { 'x-agp-request': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers.authorization = `Bearer ${key}`;
  else if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (raw) return res;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`Server did not start:\n${serverLog}`);
}

try {
  await waitForServer();
  console.log(`CRM up on ${BASE}\n`);

  console.log('Auth');
  ok((await api('GET', '/api/auth/status')).data.needs_setup === true, 'fresh install asks for setup');
  const setup = await api('POST', '/api/auth/setup', { name: 'Admin User', email: 'admin@example.com', password: 'supersecret1', company_name: 'Adas Globus Pro' });
  ok(setup.status === 201 && cookie, 'admin account created and signed in');
  ok((await api('GET', '/api/auth/me')).data.user.role === 'admin', 'session works');
  const noHeader = await fetch(`${BASE}/api/contacts`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  ok(noHeader.status === 403, 'cookie requests without CSRF header are rejected');

  console.log('\nWebhooks');
  const hook = await api('POST', '/api/webhooks', { name: 'n8n test', url: `http://127.0.0.1:${HOOK_PORT}/webhook/crm`, events: ['*'] });
  ok(hook.status === 201 && hook.data.webhook.secret.startsWith('whsec_'), 'webhook created with signing secret');

  console.log('\nContacts & companies');
  const c1 = await api('POST', '/api/contacts', { first_name: 'Priya', last_name: 'Sharma', email: 'Priya@Acme-Industries.com', title: 'Head of Ops', company_name: 'Acme Industries', tags: 'vip, india' });
  ok(c1.status === 201 && c1.data.contact.company_name === 'Acme Industries', 'contact created with company auto-linked');
  ok(c1.data.contact.company_domain === 'acme-industries.com', 'company domain inferred from work email');
  const contactId = c1.data.contact.id;
  const up = await api('POST', '/api/contacts/upsert', { email: 'priya@acme-industries.com', phone: '+91 98765 43210' });
  ok(up.status === 200 && up.data.created === false && up.data.contact.phone, 'upsert by email updates existing contact');
  const list = await api('GET', '/api/contacts?q=priya&tag=vip');
  ok(list.data.total === 1, 'search + tag filter');
  const csv = 'First Name,Last Name,Email,Company,Title\nRahul,Verma,rahul@globex.io,Globex,CTO\nAnna,Lee,anna@initech.com,Initech,VP Sales\n,,,,';
  const imp = await api('POST', '/api/contacts/import', { csv, tags: 'imported' });
  ok(imp.data.created === 2, `CSV import created 2 contacts (got ${JSON.stringify(imp.data)})`);
  const exp = await api('GET', '/api/contacts/export.csv', undefined, { raw: true });
  ok((await exp.text()).includes('rahul@globex.io'), 'CSV export');

  console.log('\nDeals pipeline');
  const stages = (await api('GET', '/api/stages')).data.stages;
  ok(stages.length === 7, 'default pipeline has 7 stages');
  const deal = await api('POST', '/api/deals', { title: 'Acme annual contract', value: 25000, contact_id: contactId });
  ok(deal.status === 201 && deal.data.deal.company_name === 'Acme Industries', 'deal created, company inherited from contact');
  const won = stages.find((s) => s.kind === 'won');
  const moved = await api('POST', `/api/deals/${deal.data.deal.id}/move`, { stage_id: won.id });
  ok(moved.data.deal.status === 'won' && moved.data.deal.closed_at, 'moving to Won closes the deal');
  const board = await api('GET', '/api/deals/board');
  ok(board.data.stages.find((s) => s.id === won.id).count === 1, 'board groups deals by stage');

  console.log('\nTasks & timeline');
  const task = await api('POST', '/api/tasks', { subject: 'Call Priya', contact_id: contactId, due_at: new Date(Date.now() - 60_000).toISOString() });
  ok(task.status === 201, 'task created');
  ok((await api('GET', '/api/tasks?view=overdue&assigned_to=me')).data.total === 1, 'overdue task view');
  await api('POST', `/api/activities/${task.data.activity.id}/complete`, {});
  ok((await api('GET', '/api/tasks?view=done')).data.total === 1, 'task completed');
  await api('POST', '/api/activities', { type: 'call', subject: 'Discovery call', body: 'Interested in Q1', contact_id: contactId });
  const tl = await api('GET', `/api/timeline?contact_id=${contactId}`);
  ok(tl.data.items.length >= 3, `timeline merges activities (${tl.data.items.length} items)`);

  console.log('\nEmail (dry-run SMTP)');
  const tpls = (await api('GET', '/api/templates')).data.templates;
  ok(tpls.length >= 5, 'starter templates seeded');
  const prev = await api('POST', '/api/templates/preview', { subject: 'Hi {{first_name|there}}', body: 'Hello {{first_name}} at {{company}}', contact_id: contactId });
  ok(prev.data.subject === 'Hi Priya' && prev.data.body.includes('Acme Industries'), 'template variables render');
  const sent = await api('POST', '/api/emails/send', { contact_id: contactId, subject: 'Hello {{first_name}}', body: 'Check <a href="https://example.com/offer">our offer</a>' });
  ok(sent.status === 201 && sent.data.email.status === 'sent', 'email sent');
  const emails = (await api('GET', `/api/emails?contact_id=${contactId}`)).data.emails;
  const full = (await api('GET', `/api/emails/${emails[0].id}`)).data.email;
  ok(full.body.includes('/t/o/') && full.body.includes('/t/c/'), 'open pixel + click tracking injected');
  const trackingId = full.tracking_id;
  await fetch(`${BASE}/t/o/${trackingId}.gif`);
  const clickUrl = full.body.match(/href="([^"]*\/t\/c\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  const click = await fetch(clickUrl, { redirect: 'manual' });
  ok(click.status === 302 && click.headers.get('location') === 'https://example.com/offer', 'click redirects to original URL');
  const tampered = await fetch(clickUrl.replace('example.com', 'evil.com'), { redirect: 'manual' });
  ok(tampered.status === 400, 'tampered click link rejected (no open redirect)');
  const after = (await api('GET', `/api/emails/${emails[0].id}`)).data.email;
  ok(after.open_count === 1 && after.click_count === 1, 'open and click recorded');

  console.log('\nSequences');
  const seq = await api('POST', '/api/sequences', {
    name: 'Test sequence', business_hours: false,
    steps: [
      { type: 'email', subject: 'Step one for {{first_name}}', body: 'First touch' },
      { type: 'task', delay_days: 0, task_title: 'Call {{full_name}}' },
      { type: 'email', delay_days: 2, body: 'Bumping this up' },
    ],
  });
  ok(seq.status === 201 && seq.data.steps.length === 3, 'sequence with 3 steps created');
  const rahul = (await api('GET', '/api/contacts?q=rahul')).data.contacts[0];
  const en = await api('POST', `/api/sequences/${seq.data.sequence.id}/enroll`, { contact_ids: [rahul.id] });
  ok(en.data.enrolled === 1, 'contact enrolled');
  await api('POST', '/api/system/run-scheduler', {});
  await api('POST', '/api/system/run-scheduler', {});
  const sd = (await api('GET', `/api/sequences/${seq.data.sequence.id}`)).data;
  ok(sd.enrollments[0].current_step === 2 && sd.email_stats.sent === 1, 'scheduler sent step 1, created task, waits 2 days for step 3');

  console.log('\nCampaign');
  const camp = await api('POST', '/api/campaigns', { name: 'Imported list blast', subject: 'News for {{company}}', body: 'Hi {{first_name}}!', filter: { tag: 'imported' } });
  const rc = await api('POST', `/api/campaigns/${camp.data.campaign.id}/recipients`, {});
  ok(rc.data.total === 2, 'campaign audience resolved from filter');
  const cs = await api('POST', `/api/campaigns/${camp.data.campaign.id}/send`, {});
  ok(cs.data.queued === 2, 'campaign queued');
  await sleep(500);
  await api('POST', '/api/system/run-scheduler', {});
  const cd = (await api('GET', `/api/campaigns/${camp.data.campaign.id}`)).data.campaign;
  ok(cd.stats.sent === 2, `campaign delivered (${JSON.stringify(cd.stats)})`);

  console.log('\nUnsubscribe');
  const unsubPage = await fetch(`${BASE}/u/${trackingId}`);
  ok(unsubPage.status === 200 && (await unsubPage.text()).includes('Unsubscribe'), 'unsubscribe page');
  await fetch(`${BASE}/u/${trackingId}`, { method: 'POST' });
  const blocked = await api('POST', '/api/emails/send', { contact_id: contactId, subject: 'x', body: 'y' });
  ok(blocked.status === 409, 'emails to unsubscribed contacts are blocked');

  console.log('\nLead form');
  const form = await api('POST', '/api/forms', { name: 'Website contact', tags: 'website', create_deal: true });
  const sub = await fetch(`${BASE}/api/public/forms/${form.data.form.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Maria Garcia', email: 'maria@contoso.com', company: 'Contoso', message: 'Need a quote' }),
  });
  const subData = await sub.json();
  ok(sub.status === 200 && subData.contact_id, 'public form creates contact');
  const maria = (await api('GET', `/api/contacts/${subData.contact_id}`)).data;
  ok(maria.contact.tags.includes('website') && maria.deals.length === 1, 'form applies tags and opens a deal');

  console.log('\nAPI keys (n8n)');
  const k = await api('POST', '/api/api-keys', { name: 'n8n' });
  ok(k.data.key?.startsWith('agp_'), 'API key issued');
  const viaKey = await api('POST', '/api/contacts', { first_name: 'From', last_name: 'n8n', email: 'n8n@example.com' }, { key: k.data.key });
  ok(viaKey.status === 201, 'API key can create contacts without cookies/CSRF header');
  const badKey = await api('GET', '/api/contacts', undefined, { key: 'agp_wrong' });
  ok(badKey.status === 401, 'invalid API key rejected');

  console.log('\nSettings');
  await api('PUT', '/api/settings/apollo', { api_key: 'test-apollo-key-123' });
  const s = (await api('GET', '/api/settings')).data.settings;
  ok(s.apollo.api_key === '••••••••', 'secrets are masked in API responses');
  const dbText = fs.readFileSync(path.join(dataDir, 'crm.db')).toString('latin1');
  ok(!dbText.includes('test-apollo-key-123'), 'secrets are encrypted at rest');
  const apolloNoNet = await api('POST', '/api/apollo/people/search', { person_titles: ['ceo'] });
  ok([400, 502].includes(apolloNoNet.status), `Apollo errors surface cleanly (status ${apolloNoNet.status})`);

  console.log('\nDashboard');
  const dash = (await api('GET', '/api/dashboard')).data;
  ok(dash.won_this_month.value === 25000 && dash.email_30d.sent >= 4, 'dashboard aggregates deals and email');

  await sleep(800);
  console.log('\nWebhook deliveries');
  const events = new Set(received.map((r) => r.body.event));
  for (const e of ['contact.created', 'deal.won', 'email.sent', 'email.opened', 'email.clicked', 'task.completed', 'sequence.enrolled', 'form.submitted', 'contact.unsubscribed']) {
    ok(events.has(e), `received ${e}`);
  }
  const sample = received[0];
  const expected = `sha256=${crypto.createHmac('sha256', hook.data.webhook.secret).update(sample.raw).digest('hex')}`;
  ok(sample.headers['x-crm-signature'] === expected, 'webhook HMAC signature verifies');
} catch (err) {
  failures++;
  console.error('\nSmoke test crashed:', err);
  console.error(serverLog);
} finally {
  server.kill();
  hookServer.close();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows may hold the file briefly */ }
  if (/\[error\]/.test(serverLog)) {
    console.log('\nServer errors logged:\n', serverLog.split('\n').filter((l) => l.includes('[error]') || l.includes('    at ')).slice(0, 30).join('\n'));
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
