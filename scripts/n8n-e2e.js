// End-to-end check of the n8n workflow templates against a real n8n (official Docker image).
// Imports the credential + all templates with the n8n CLI (no n8n account needed), starts n8n,
// then drives real CRM events through the workflows and checks their effects in the CRM.
// Needs Docker and host networking (Linux). Run: npm run n8n-e2e   (CI does this on every PR)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.N8N_IMAGE || 'docker.n8n.io/n8nio/n8n:latest';
const CRM_PORT = 3216;
const N8N_PORT = 5690;
const CRM = `http://127.0.0.1:${CRM_PORT}`;
const N8N = `http://127.0.0.1:${N8N_PORT}`;
const VOLUME = `n8n-e2e-${Date.now()}`;
const CONTAINER = `n8n-e2e-${Date.now()}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-e2e-'));
fs.chmodSync(work, 0o755); // the n8n container runs as uid 1000

const N8N_ENV = [
  'N8N_ENCRYPTION_KEY=e2e-test-encryption-key',
  `N8N_PORT=${N8N_PORT}`,
  'N8N_LISTEN_ADDRESS=127.0.0.1',
  'N8N_DIAGNOSTICS_ENABLED=false',
  'N8N_SECURE_COOKIE=false',
  `WEBHOOK_URL=${N8N}/`,
  'GENERIC_TIMEZONE=UTC',
].flatMap((e) => ['-e', e]);

let fails = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ✓' : '  ✗'} ${label}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args, opts = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000, ...opts });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const n8nCli = (...args) => docker(['run', '--rm', '--network', 'host', '-v', `${VOLUME}:/home/node/.n8n`, '-v', `${work}:/data:ro`, ...N8N_ENV, IMAGE, ...args]);
async function waitFor(fn, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  return null;
}

let apiKey;
async function crm(method, url, body) {
  const res = await fetch(CRM + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}

const SLUGS = ['01-new-lead-alert', '02-website-form-to-crm', '03-deal-won-handoff', '04-reply-follow-up-task', '05-daily-task-digest', '06-apollo-weekly-prospecting', '07-task-due-reminder'];
const CRED = { id: 'crmCredE2E', name: 'Adas Globus CRM API key' };
let crmProc;
let n8nStarted = false;

try {
  // ---------- CRM ----------
  crmProc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(CRM_PORT), DATA_DIR: path.join(work, 'crm-data'), BASE_URL: CRM, MAIL_DRY_RUN: 'true', SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(`${CRM}/api/health`)).ok, 90_000);
  const setup = await fetch(`${CRM}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2E Admin', email: 'e2e@example.test', password: 'e2e-password-1' }) });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const keyRes = await fetch(`${CRM}/api/api-keys`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-agp-request': '1' }, body: JSON.stringify({ name: 'n8n e2e' }) });
  apiKey = (await keyRes.json()).key;
  ok(!!apiKey, 'CRM test instance up with an API key');
  const priya = (await crm('POST', '/api/contacts', { first_name: 'Priya', last_name: 'Sharma', email: 'priya@example.com', company_name: 'Example Industries' })).data.contact;

  // ---------- n8n: import credential + workflows ----------
  console.log(`n8n image: ${IMAGE}`);
  const version = n8nCli('--version');
  console.log(`n8n version: ${version.out.trim().split('\n').pop()}`);
  fs.writeFileSync(path.join(work, 'creds.json'), JSON.stringify([{ ...CRED, type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${apiKey}` } }]), { mode: 0o644 });
  const ic = n8nCli('import:credentials', '--input=/data/creds.json');
  ok(ic.code === 0, `credential imported into n8n${ic.code ? `\n${ic.out.slice(-800)}` : ''}`);

  const wfDir = path.join(work, 'wfs');
  fs.mkdirSync(wfDir, { mode: 0o755 });
  SLUGS.forEach((slug, i) => {
    const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'n8n', `${slug}.json`), 'utf8'));
    wf.id = `e2eWorkflow${i + 1}`;
    for (const n of wf.nodes) {
      if (n.name === 'CRM config') {
        for (const a of n.parameters.assignments.assignments) {
          if (a.name === 'crm_url') a.value = CRM;
          if (a.name === 'digest_to') a.value = 'digest@example.com';
          if (a.name === 'slack_webhook_url') a.value = `${CRM}/api/health`;
        }
      }
      if (n.parameters?.genericAuthType === 'httpHeaderAuth') n.credentials = { httpHeaderAuth: CRED };
    }
    fs.writeFileSync(path.join(wfDir, `${slug}.json`), JSON.stringify(wf), { mode: 0o644 });
  });
  const iw = n8nCli('import:workflow', '--separate', '--input=/data/wfs');
  ok(iw.code === 0, `all ${SLUGS.length} workflow templates imported${iw.code ? `\n${iw.out.slice(-1200)}` : ''}`);

  // n8n 1.x: update:workflow --active=true; n8n 2.x: publish:workflow
  const help = n8nCli('--help').out;
  let activated = 0;
  for (let i = 1; i <= SLUGS.length; i++) {
    const id = `e2eWorkflow${i}`;
    const r = /publish:workflow/.test(help) ? n8nCli('publish:workflow', `--id=${id}`) : n8nCli('update:workflow', `--id=${id}`, '--active=true');
    if (r.code === 0) activated++; else console.log(`    activating ${id} failed:\n${r.out.slice(-600)}`);
  }
  ok(activated === SLUGS.length, `${activated}/${SLUGS.length} workflows activated`);

  // ---------- n8n server ----------
  const run = docker(['run', '-d', '--name', CONTAINER, '--network', 'host', '-v', `${VOLUME}:/home/node/.n8n`, ...N8N_ENV, IMAGE, 'start']);
  n8nStarted = run.code === 0;
  const up = await waitFor(async () => (await fetch(`${N8N}/healthz`)).ok, 180_000);
  ok(!!up, 'n8n server started');
  await sleep(5000);
  const logs = docker(['logs', CONTAINER]).out;
  const activationProblems = logs.split('\n').filter((l) => /could not be activated|has issues|Error/i.test(l));
  ok(!activationProblems.length, `n8n activated every workflow on startup${activationProblems.length ? `\n${activationProblems.slice(0, 10).join('\n')}` : ''}`);

  // 02 · form intake → contact upsert
  const form = await fetch(`${N8N}/webhook/lead-intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Maria Garcia', email: 'maria@contoso.com', company: 'Contoso', phone: '+1 555 0100', message: 'Need a quote' }) });
  ok(form.ok, `n8n accepted a form submission (${form.status})`);
  const maria = await waitFor(async () => (await crm('GET', '/api/contacts?q=maria@contoso.com')).data.contacts?.[0]);
  ok(maria?.company_name === 'Contoso' && maria.tags.includes('n8n'), 'form lead created in the CRM with company and tags');

  // 03 · deal.won → onboarding task + welcome email
  await crm('POST', '/api/webhooks', { name: 'e2e deal won', url: `${N8N}/webhook/crm-deal-won`, events: ['deal.won'] });
  const replyHook = (await crm('POST', '/api/webhooks', { name: 'e2e replies', url: `${N8N}/webhook/crm-email-replied`, events: ['email.replied'] })).data.webhook;
  const stages = (await crm('GET', '/api/stages')).data.stages;
  const deal = (await crm('POST', '/api/deals', { title: 'E2E annual contract', value: 12000, contact_id: priya.id })).data.deal;
  await crm('POST', `/api/deals/${deal.id}/move`, { stage_id: stages.find((s) => s.kind === 'won').id });
  const task = await waitFor(async () => (await crm('GET', '/api/tasks?view=open')).data.tasks.find((t) => t.subject === 'Kick off onboarding: E2E annual contract'));
  ok(task?.priority === 'high', 'deal.won → onboarding task created by n8n');
  const welcome = await waitFor(async () => (await crm('GET', `/api/emails?contact_id=${priya.id}`)).data.emails.find((e) => e.subject === 'Welcome aboard, Priya!'));
  ok(welcome?.status === 'sent', 'deal.won → personalised welcome email sent through the CRM');

  // 04 · email.replied (the CRM's test delivery uses a sample payload for contact #1)
  const t4 = await crm('POST', `/api/webhooks/${replyHook.id}/test`, { event: 'email.replied' });
  ok(t4.data.ok, 'email.replied delivered to n8n');
  const replyTask = await waitFor(async () => (await crm('GET', '/api/tasks?view=open')).data.tasks.find((t) => t.subject.startsWith('Reply from Priya Sharma')));
  ok(!!replyTask, 'email.replied → follow-up task created by n8n');
  const qualified = await waitFor(async () => ((await crm('GET', `/api/contacts/${priya.id}`)).data.contact.status === 'qualified' ? true : null));
  ok(!!qualified, 'email.replied → lead moved to qualified');

  // 05 · daily digest, executed once on demand
  const ex = docker(['exec', CONTAINER, 'n8n', 'execute', '--id=e2eWorkflow5']);
  const digest = await waitFor(async () => (await crm('GET', '/api/emails?q=digest@example.com')).data.emails[0], 60_000);
  ok(/overdue/.test(digest?.subject || ''), `daily digest emailed: "${digest?.subject || ex.out.slice(-600)}"`);
} catch (err) {
  fails++;
  console.error('n8n e2e crashed:', err);
} finally {
  if (fails && n8nStarted) console.log(`\n--- n8n logs ---\n${docker(['logs', '--tail', '80', CONTAINER]).out}`);
  crmProc?.kill();
  docker(['rm', '-f', CONTAINER]);
  docker(['volume', 'rm', '-f', VOLUME]);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(fails ? `\n${fails} check(s) failed` : '\nAll real-n8n checks passed');
  process.exit(fails ? 1 : 0);
}
