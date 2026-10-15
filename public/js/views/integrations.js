import {
  h, icon, GET, POST, PUT, PATCH, DEL, store, loadMeta, num, dateTime, ago, cap, toast, modal, confirmDialog, busy, isAdmin, navigate, copy,
} from '../core.js';
import {
  pageHeader, tabs, btn, iconBtn, muted, pill, card, kv, emptyState, dataTable, copyField, formFields, selectInput,
} from '../components.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const MASK = '••••••••';

const TABS = [
  { id: 'apollo', label: 'Apollo.io', icon: 'target' },
  { id: 'email', label: 'Email (SMTP / IMAP)', icon: 'mail' },
  { id: 'n8n', label: 'n8n & webhooks', icon: 'workflow' },
  { id: 'api', label: 'API keys', icon: 'key' },
  { id: 'forms', label: 'Lead forms', icon: 'form' },
  { id: 'logs', label: 'Logs', icon: 'log' },
];

export async function integrationsView(el, { tab = 'apollo' } = {}) {
  el.append(pageHeader('Integrations', { subtitle: 'Connect Apollo, your mailbox, n8n and your website.' }),
    tabs(TABS.filter((t) => isAdmin() || t.id === 'forms'), tab, (t) => navigate(`#/integrations/${t}`)));
  if (!isAdmin() && tab !== 'forms') {
    el.append(emptyState({ iconName: 'key', title: 'Admins only', text: 'Ask an admin to manage integrations.' }));
    return;
  }
  const body = h('div', { class: 'tab-body' });
  el.append(body);
  await ({ apollo: apolloTab, email: emailTab, n8n: n8nTab, api: apiTab, forms: formsTab, logs: logsTab }[tab] || apolloTab)(body);
}

function settingsForm(section, spec, values, { onSaved, extraActions = [] } = {}) {
  const form = formFields(spec, values);
  const save = btn('Save', { primary: true, onClick: (e) => busy(e.currentTarget, async () => {
    const v = form.values();
    const res = await PUT(`/settings/${section}`, v);
    store.settings[section] = res.settings;
    toast('Saved');
    onSaved?.(res.settings);
  }) });
  return { el: h('div', { class: 'stack' }, form.el, h('div', { class: 'row-gap' }, save, ...extraActions)), form };
}

// ======================= APOLLO =======================
async function apolloTab(el) {
  const [{ settings }, status] = await Promise.all([GET('/settings'), GET('/apollo/status')]);
  const s = settings.apollo;
  const testBtn = btn('Test connection', { iconName: 'zap', onClick: (e) => busy(e.currentTarget, async () => {
    const r = await POST('/apollo/test');
    toast(`Apollo connected${r.sample_total !== null ? ` · ${num(r.sample_total)} CEOs in the database` : ''}`);
    refresh();
  }) });
  const f = settingsForm('apollo', [
    { name: 'api_key', label: 'Apollo API key', type: 'password', span: 2, autocomplete: 'off', help: 'Apollo → Settings → Integrations → API → Create new key. Use a master key to push contacts into Apollo sequences.' },
    { name: 'default_tags', label: 'Tags for imported contacts', placeholder: 'apollo' },
    { name: 'default_status', label: 'Status for imported contacts', type: 'select', options: store.meta.contact_statuses },
    { name: 'reveal_personal_emails', label: 'Also reveal personal emails when enriching (extra credits, check GDPR rules)', type: 'checkbox', span: 2 },
  ], { ...s, api_key: s.api_key }, { onSaved: refresh, extraActions: [testBtn] });
  el.append(
    h('div', { class: 'grid-2' },
      card('Connection', h('div', { class: 'stack' },
        h('div', { class: 'row-gap' }, status.configured ? pill('Connected', 'green') : pill('Not connected', 'slate'), muted(`${num(status.credits_30d)} credits used in the last 30 days (estimated)`)),
        f.el)),
      card('What you get', h('ul', { class: 'checklist' },
        h('li', null, icon('check'), h('span', null, h('b', null, 'Prospecting: '), 'search 250M+ people and companies (free search) and import them as contacts.')),
        h('li', null, icon('check'), h('span', null, h('b', null, 'Enrichment: '), 'fill in email, title, LinkedIn, phone and company data for any contact or company.')),
        h('li', null, icon('check'), h('span', null, h('b', null, 'Apollo sequences: '), 'push selected CRM contacts into an existing Apollo sequence.')),
        h('li', null, icon('check'), h('span', null, h('b', null, 'n8n: '), 'the apollo.imported webhook fires after every import, so you can chain more automation.'))))),
    card('Recent Apollo activity', dataTable({
      rows: status.log,
      columns: [
        { label: 'When', render: (r) => h('span', { title: dateTime(r.created_at) }, ago(r.created_at)) },
        { label: 'Action', render: (r) => cap(r.action) },
        { label: 'Result', render: (r) => pill(r.status, r.status === 'ok' ? 'green' : 'red') },
        { label: 'Details', render: (r) => h('span', { class: 'small' }, r.detail) },
        { label: 'Credits', cls: 'num', render: (r) => (r.credits ? num(r.credits) : muted('—')) },
      ],
      empty: h('div', { class: 'table-empty' }, 'No Apollo calls yet.'),
    })));
}

// ======================= EMAIL =======================
const SMTP_PRESETS = [
  { name: 'Gmail / Google Workspace', smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, imap: { host: 'imap.gmail.com', port: 993, secure: true }, note: 'Use an App Password (Google Account → Security → 2-Step Verification → App passwords).' },
  { name: 'Microsoft 365 / Outlook', smtp: { host: 'smtp.office365.com', port: 587, secure: false }, imap: { host: 'outlook.office365.com', port: 993, secure: true }, note: 'SMTP AUTH must be enabled for the mailbox in the Microsoft 365 admin center.' },
  { name: 'Zoho Mail', smtp: { host: 'smtp.zoho.com', port: 465, secure: true }, imap: { host: 'imap.zoho.com', port: 993, secure: true }, note: 'For India data centre accounts use smtp.zoho.in / imap.zoho.in.' },
  { name: 'Hostinger', smtp: { host: 'smtp.hostinger.com', port: 465, secure: true }, imap: { host: 'imap.hostinger.com', port: 993, secure: true } },
  { name: 'GoDaddy', smtp: { host: 'smtpout.secureserver.net', port: 465, secure: true }, imap: { host: 'imap.secureserver.net', port: 993, secure: true } },
  { name: 'Brevo', smtp: { host: 'smtp-relay.brevo.com', port: 587, secure: false }, note: 'Use your Brevo SMTP login and SMTP key.' },
  { name: 'SendGrid', smtp: { host: 'smtp.sendgrid.net', port: 587, secure: false, user: 'apikey' }, note: 'Username is literally "apikey"; password is your SendGrid API key.' },
  { name: 'Amazon SES', smtp: { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false }, note: 'Change the region in the host to match your SES region.' },
];

async function emailTab(el) {
  const { settings, imap_state: imapState } = await GET('/settings');
  const smtp = settings.smtp;
  const imap = settings.imap;
  const noteEl = h('p', { class: 'help' });

  const smtpForm = settingsForm('smtp', [
    { name: 'host', label: 'SMTP host', placeholder: 'smtp.gmail.com' },
    { name: 'port', label: 'Port', type: 'number' },
    { name: 'user', label: 'Username', autocomplete: 'off', placeholder: 'you@adasglobuspro.com' },
    { name: 'pass', label: 'Password / app password', type: 'password', autocomplete: 'new-password' },
    { name: 'from_name', label: 'From name', placeholder: store.settings.company?.name },
    { name: 'from_email', label: 'From email', type: 'email', placeholder: 'sales@adasglobuspro.com' },
    { name: 'reply_to', label: 'Reply-to (optional)', type: 'email' },
    { name: 'secure', label: 'Use SSL/TLS (port 465)', type: 'checkbox' },
    { name: 'dry_run', label: 'Dry run: log emails but don’t actually send (for testing)', type: 'checkbox', span: 2 },
  ], smtp, {
    extraActions: [btn('Send test email to me', { iconName: 'send', onClick: (e) => busy(e.currentTarget, async () => {
      const r = await POST('/settings/smtp/test', { to: store.user.email });
      toast(r.dry_run ? 'Dry run: connection skipped, test logged' : `Test email sent to ${r.to}`);
    }) })],
  });
  const imapForm = settingsForm('imap', [
    { name: 'enabled', label: 'Sync replies from this inbox every few minutes', type: 'checkbox', span: 2 },
    { name: 'host', label: 'IMAP host', placeholder: 'imap.gmail.com' },
    { name: 'port', label: 'Port', type: 'number' },
    { name: 'user', label: 'Username', autocomplete: 'off' },
    { name: 'pass', label: 'Password / app password', type: 'password', autocomplete: 'new-password' },
    { name: 'mailbox', label: 'Folder', placeholder: 'INBOX' },
    { name: 'secure', label: 'Use SSL/TLS', type: 'checkbox' },
  ], imap, {
    extraActions: [
      btn('Test', { onClick: (e) => busy(e.currentTarget, async () => { const r = await POST('/settings/imap/test'); toast(`Connected · ${num(r.messages)} messages, ${num(r.unseen)} unread`); }) }),
      btn('Sync now', { iconName: 'refresh', onClick: (e) => busy(e.currentTarget, async () => { const r = await POST('/settings/imap/sync'); toast(r.skipped ? `Skipped: ${r.skipped}` : `Scanned ${r.scanned} · ${r.replies} replies · ${r.bounces} bounces`); }) }),
    ],
  });

  const applyPreset = (p) => {
    const set = (form, key, val) => {
      const i = form.inputs[key]?.input;
      if (!i) return;
      if (i.type === 'checkbox') i.checked = !!val; else i.value = val;
    };
    for (const [k, v] of Object.entries(p.smtp)) set(smtpForm.form, k, v);
    if (p.imap) for (const [k, v] of Object.entries(p.imap)) set(imapForm.form, k, v);
    noteEl.textContent = p.note ? `${p.name}: ${p.note}` : `${p.name} settings filled in. Add your username and password, then Save.`;
  };

  el.append(
    card('Quick setup', h('div', { class: 'stack' },
      muted('Pick your email provider to fill in the server settings:'),
      h('div', { class: 'row-gap wrap' }, SMTP_PRESETS.map((p) => btn(p.name, { small: true, onClick: () => applyPreset(p) }))),
      noteEl)),
    h('div', { class: 'grid-2' },
      card('Sending (SMTP)', h('div', { class: 'stack' },
        h('div', null, smtp.host ? pill(smtp.dry_run ? 'Dry run' : 'Configured', smtp.dry_run ? 'yellow' : 'green') : pill(smtp.dry_run ? 'Dry run' : 'Not configured', smtp.dry_run ? 'yellow' : 'slate')),
        smtpForm.el)),
      card('Reply & bounce sync (IMAP)', h('div', { class: 'stack' },
        h('div', null, imap.enabled ? pill('Syncing', 'green') : pill('Off', 'slate'), imapState?.lastSyncAt ? muted(` Last sync ${ago(imapState.lastSyncAt)}`) : null),
        muted('Replies from contacts are logged on their timeline, stop their sequences, and fire the email.replied webhook. Bounces suppress the address.'),
        imapForm.el))),
    card('Deliverability checklist', h('ul', { class: 'checklist' },
      h('li', null, icon('check'), h('span', null, 'Add SPF and DKIM DNS records for adasglobuspro.com with your email provider, and a DMARC record (e.g. ', h('code', null, 'v=DMARC1; p=none; rua=mailto:dmarc@adasglobuspro.com'), ').')),
      h('li', null, icon('check'), h('span', null, `Set BASE_URL to the public address of this CRM (now: ${store.baseUrl}) so open/click tracking and unsubscribe links work for recipients.`)),
      h('li', null, icon('check'), h('span', null, 'Keep the sending rate modest (Settings → Email sending). 20–50 per minute is safe for most mailboxes; Google Workspace allows about 2,000 per day.')),
      h('li', null, icon('check'), h('span', null, 'Campaign and sequence emails always include an unsubscribe link and the List-Unsubscribe header.')))));
}

// ======================= N8N & WEBHOOKS =======================
const WORKFLOWS = [
  { file: '01-new-lead-alert.json', title: 'New lead → Slack / email alert', desc: 'Listens for contact.created and form.submitted, then posts a message to Slack (or swap in Telegram, WhatsApp, Teams).' },
  { file: '02-website-form-to-crm.json', title: 'Any form → CRM contact + sequence', desc: 'Public n8n webhook for Typeform, Webflow, Facebook Lead Ads, etc. Upserts the contact and enrolls them in a sequence.' },
  { file: '03-deal-won-handoff.json', title: 'Deal won → onboarding handoff', desc: 'On deal.won: creates an onboarding task, emails the customer a welcome note, and notifies the team.' },
  { file: '04-reply-follow-up-task.json', title: 'Email reply → follow-up task', desc: 'On email.replied: creates a high-priority task for the owner and marks the contact as qualified.' },
  { file: '05-daily-task-digest.json', title: 'Daily task digest', desc: 'Every weekday at 8:30, pulls overdue and today’s tasks from the CRM and emails a summary.' },
  { file: '06-apollo-weekly-prospecting.json', title: 'Weekly Apollo prospecting', desc: 'Every Monday, searches Apollo for your ideal customer profile and imports new people into the CRM, tagged for review.' },
  { file: '07-task-due-reminder.json', title: 'Task due → WhatsApp / Telegram reminder', desc: 'On task.due: sends the assignee a reminder through Telegram (or WhatsApp Cloud API).' },
];

function openWebhookForm(hook, events, onSaved) {
  const w = hook || { name: 'n8n', url: '', events: ['*'], headers: {}, active: true };
  const name = h('input', { class: 'input', value: w.name });
  const url = h('input', { class: 'input mono', value: w.url, placeholder: 'https://your-n8n.example.com/webhook/crm-events' });
  const all = h('input', { type: 'checkbox', checked: w.events.includes('*') });
  const groups = {};
  for (const e of events) (groups[e.split('.')[0]] ||= []).push(e);
  const boxes = new Map();
  const grid = h('div', { class: 'event-grid' }, Object.entries(groups).map(([g, list]) => h('div', { class: 'event-group' },
    h('b', null, cap(g)),
    list.map((e) => {
      const cb = h('input', { type: 'checkbox', checked: w.events.includes(e) || w.events.includes(`${g}.*`) });
      boxes.set(e, cb);
      return h('label', { class: 'field-check small' }, cb, h('span', { class: 'mono' }, e));
    }))));
  const syncAll = () => { grid.classList.toggle('disabled', all.checked); boxes.forEach((cb) => { cb.disabled = all.checked; }); };
  all.addEventListener('change', syncAll);
  syncAll();
  const headers = h('textarea', { class: 'input mono', rows: 3, placeholder: '{"X-N8N-Auth": "a-long-random-value"}' }, Object.keys(w.headers || {}).length ? JSON.stringify(w.headers, null, 2) : '');
  const active = h('input', { type: 'checkbox', checked: w.active });
  modal({
    title: hook ? 'Edit webhook' : 'Add webhook',
    size: 'lg',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
        h('label', { class: 'field field-check' }, active, h('span', null, 'Active'))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Webhook URL (n8n Webhook node → Production URL)'), url),
      h('label', { class: 'field field-check' }, all, h('span', null, h('b', null, 'Send all events'))),
      grid,
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Extra headers (JSON, optional)'), headers,
        h('span', { class: 'help' }, 'Use with the n8n Webhook node’s Header Auth: e.g. {"X-N8N-Auth": "secret"}. Every request is also signed with X-CRM-Signature (HMAC-SHA256).')),
      hook ? copyField(hook.secret, { label: 'Signing secret' }) : null),
    actions: [
      { label: 'Cancel' },
      {
        label: hook ? 'Save' : 'Add webhook',
        primary: true,
        onClick: async ({ close }) => {
          let hdrs = {};
          if (headers.value.trim()) {
            try { hdrs = JSON.parse(headers.value); } catch { return toast('Headers must be valid JSON', 'error'); }
          }
          const evts = all.checked ? ['*'] : [...boxes].filter(([, cb]) => cb.checked).map(([e]) => e);
          if (!evts.length) return toast('Choose at least one event', 'error');
          const payload = { name: name.value, url: url.value.trim(), events: evts, headers: hdrs, active: active.checked };
          if (hook) await PATCH(`/webhooks/${hook.id}`, payload); else await POST('/webhooks', payload);
          toast('Webhook saved');
          close();
          onSaved();
        },
      },
    ],
  });
}

async function openDeliveries(hook) {
  const { deliveries } = await GET(`/webhooks/${hook.id}/deliveries`);
  const detail = h('pre', { class: 'code-block', hidden: true });
  modal({
    title: `Deliveries · ${hook.name}`,
    size: 'lg',
    body: h('div', { class: 'stack' },
      dataTable({
        rows: deliveries,
        onRowClick: (d) => {
          let pretty = d.payload;
          try { pretty = JSON.stringify(JSON.parse(d.payload), null, 2); } catch { /* raw */ }
          detail.hidden = false;
          detail.textContent = `// Response ${d.status_code || 'no response'}: ${d.response || ''}\n\n${pretty}`;
        },
        columns: [
          { label: 'Event', render: (d) => h('span', { class: 'mono small' }, d.event) },
          { label: 'Result', render: (d) => pill(d.success ? `${d.status_code}` : (d.status_code ? `${d.status_code}` : 'error'), d.success ? 'green' : 'red') },
          { label: 'Attempt', cls: 'num', key: 'attempt' },
          { label: 'Time', render: (d) => `${d.duration_ms ?? '—'} ms` },
          { label: 'When', render: (d) => h('span', { title: dateTime(d.created_at) }, ago(d.created_at)) },
          { label: '', render: (d) => (d.success ? null : btn('Redeliver', { small: true, onClick: (e) => busy(e.currentTarget, async () => { const r = await POST(`/webhook-deliveries/${d.id}/redeliver`); toast(r.ok ? 'Delivered' : `Failed: ${r.status || r.response}`, r.ok ? 'ok' : 'error'); }) })) },
        ],
        empty: h('div', { class: 'table-empty' }, 'No deliveries yet. Click “Send test” to try it.'),
      }),
      detail),
    actions: [{ label: 'Close' }],
  });
}

async function n8nTab(el) {
  const { webhooks, events } = await GET('/webhooks');
  el.append(
    card('Connect n8n in 3 steps', h('ol', { class: 'steps-guide' },
      h('li', null, h('b', null, 'CRM → n8n (events). '), 'In n8n add a ', h('b', null, 'Webhook'), ' node (HTTP method POST), copy its Production URL, and add it below. Choose which events to send.'),
      h('li', null, h('b', null, 'n8n → CRM (actions). '), 'Create an API key in the ', h('a', { href: '#/integrations/api' }, 'API keys'), ' tab. In n8n add a ', h('b', null, 'Header Auth'), ' credential: name ', h('code', null, 'Authorization'), ', value ', h('code', null, 'Bearer agp_…'), '. Use it on HTTP Request nodes calling ', h('code', null, `${store.baseUrl}/api/…`), '.'),
      h('li', null, h('b', null, 'Import ready-made workflows. '), 'Download a template below and import it in n8n (Workflows → Import from file). Set the CRM URL in its “CRM config” node.'))),
    card('Webhooks', webhooks.length ? dataTable({
      rows: webhooks,
      columns: [
        { label: 'Name', render: (w) => h('div', null, h('b', null, w.name), h('div', { class: 'mono small muted clamp-1' }, w.url)) },
        { label: 'Events', render: (w) => (w.events.includes('*') ? pill('All events', 'blue') : h('span', { class: 'small' }, `${w.events.length} event${w.events.length === 1 ? '' : 's'}`)) },
        { label: 'Status', render: (w) => pill(w.active ? 'active' : 'paused', w.active ? 'green' : 'slate') },
        { label: 'Last delivery', render: (w) => (w.last_delivery_at ? h('span', null, pill(String(w.last_status || 'error'), w.last_status >= 200 && w.last_status < 300 ? 'green' : 'red'), muted(` ${ago(w.last_delivery_at)}`)) : muted('Never')) },
        { label: '7-day success', cls: 'num', render: (w) => (w.stats.total ? `${Math.round((w.stats.ok / w.stats.total) * 100)}% of ${num(w.stats.total)}` : muted('—')) },
        { label: '', render: (w) => h('span', { class: 'row-gap' },
          btn('Send test', { small: true, onClick: (e) => busy(e.currentTarget, async () => { const r = await POST(`/webhooks/${w.id}/test`, { event: 'contact.created' }); toast(r.ok ? `Delivered (${r.status})` : `Failed: ${r.status || ''} ${r.response || ''}`, r.ok ? 'ok' : 'error'); refresh(); }) }),
          iconBtn('log', 'Deliveries', () => openDeliveries(w)),
          iconBtn('edit', 'Edit', () => openWebhookForm(w, events, refresh)),
          iconBtn('trash', 'Delete', async () => { if (await confirmDialog(`Delete webhook “${w.name}”?`, { danger: true, confirmLabel: 'Delete' })) { await DEL(`/webhooks/${w.id}`); refresh(); } })) },
      ],
    }) : emptyState({ iconName: 'workflow', title: 'No webhooks yet', text: 'Add your n8n Webhook URL to start receiving CRM events.' }),
    { actions: btn('Add webhook', { primary: true, small: true, iconName: 'plus', onClick: () => openWebhookForm(null, events, refresh) }) }),
    card('n8n workflow templates', h('div', { class: 'wf-grid' }, WORKFLOWS.map((w) => h('div', { class: 'wf-card' },
      h('div', { class: 'wf-ico' }, icon('workflow')),
      h('div', null, h('b', null, w.title), h('p', { class: 'muted small' }, w.desc),
        h('a', { class: 'btn btn-sm', href: `/n8n/${w.file}`, download: w.file }, icon('download'), h('span', null, 'Download JSON'))))))),
    card('Verifying signatures in n8n (optional)', h('div', { class: 'stack' },
      muted('Each delivery has an X-CRM-Signature header: sha256=HMAC(secret, raw body). In an n8n Code node (with NODE_FUNCTION_ALLOW_BUILTIN=crypto):'),
      h('pre', { class: 'code-block' }, `const crypto = require('crypto');
const secret = 'whsec_…'; // from the webhook's edit dialog
const body = JSON.stringify($json.body);
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
if ($json.headers['x-crm-signature'] !== expected) throw new Error('Bad signature');
return $input.all();`),
      muted('Tip: enable “Raw Body” on the Webhook node for an exact match; re-serialised JSON can differ in key order.'))));
}

// ======================= API KEYS & REFERENCE =======================
const API_REF = [
  ['GET', '/api/contacts?q=&status=&tag=&limit=', 'List/search contacts'],
  ['POST', '/api/contacts/upsert', 'Create or update a contact by email (best for n8n). Accepts company_name.'],
  ['POST', '/api/contacts', 'Create a contact'],
  ['PATCH', '/api/contacts/:id', 'Update a contact (status, tags, owner_id, custom…)'],
  ['POST', '/api/contacts/bulk', '{ ids, action: add_tag|remove_tag|set_status|set_owner|delete, value }'],
  ['POST', '/api/companies', 'Create a company'],
  ['POST', '/api/deals', 'Create a deal { title, value, stage_id, contact_id, company_id }'],
  ['POST', '/api/deals/:id/move', 'Move a deal to another stage { stage_id }'],
  ['POST', '/api/activities', 'Log a note/call/meeting/whatsapp { type, subject, body, contact_id }'],
  ['POST', '/api/tasks', 'Create a task { subject, due_at, contact_id, assigned_to, priority }'],
  ['GET', '/api/tasks?view=overdue|today|upcoming', 'List tasks'],
  ['POST', '/api/emails/send', 'Send an email { contact_id | to, subject, body | template_id }'],
  ['POST', '/api/sequences/:id/enroll', 'Enroll contacts { contact_ids: [] } or { filter: { tag } }'],
  ['POST', '/api/apollo/people/search', 'Search Apollo people (person_titles[], person_locations[], …)'],
  ['POST', '/api/apollo/people/import', 'Import Apollo people { people: [{id}], enrich: true, tags }'],
  ['POST', '/api/apollo/enrich/contact/:id', 'Enrich one contact from Apollo'],
  ['GET', '/api/meta', 'Stages, users, statuses, tags, sequences, templates (IDs for automations)'],
  ['GET', '/api/dashboard', 'Pipeline, revenue and email KPIs'],
  ['POST', '/api/public/forms/:token', 'Public lead capture (no API key; form token in URL)'],
];

async function apiTab(el) {
  const [{ api_keys: keys }, { events }] = await Promise.all([GET('/api-keys'), GET('/events')]);
  const create = btn('Create API key', { primary: true, small: true, iconName: 'plus', onClick: async () => {
    const name = h('input', { class: 'input', value: 'n8n' });
    modal({
      title: 'Create API key',
      body: h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name (where will it be used?)'), name),
      actions: [{ label: 'Cancel' }, {
        label: 'Create', primary: true, onClick: async ({ close }) => {
          const r = await POST('/api-keys', { name: name.value });
          close();
          modal({
            title: 'Your new API key',
            body: h('div', { class: 'stack' }, h('p', null, h('b', null, 'Copy it now. '), 'For security it won’t be shown again.'), copyField(r.key),
              muted('In n8n: Credentials → New → Header Auth. Name: Authorization · Value: Bearer <key>')),
            actions: [{ label: 'Done', primary: true, onClick: ({ close: c2 }) => { c2(); refresh(); } }],
          });
        },
      }],
    });
  } });
  const sampleSel = selectInput(events.map((e) => e.event), events[0]?.event, (v) => { sample.textContent = JSON.stringify({ id: 'uuid', event: v, created_at: new Date().toISOString(), source: 'adas-globus-crm', data: events.find((e) => e.event === v).sample }, null, 2); });
  const sample = h('pre', { class: 'code-block' });
  sampleSel.dispatchEvent(new Event('change'));
  el.append(
    card('API keys', dataTable({
      rows: keys,
      columns: [
        { label: 'Name', render: (k) => h('b', null, k.name) },
        { label: 'Key', render: (k) => h('span', { class: 'mono small' }, `${k.prefix}…`) },
        { label: 'Created by', key: 'user_name' },
        { label: 'Last used', render: (k) => (k.last_used_at ? ago(k.last_used_at) : muted('Never')) },
        { label: 'Status', render: (k) => pill(k.revoked ? 'revoked' : 'active', k.revoked ? 'red' : 'green') },
        { label: '', render: (k) => (k.revoked ? null : btn('Revoke', { small: true, danger: true, onClick: async () => { if (await confirmDialog(`Revoke “${k.name}”? Anything using it stops working.`, { danger: true, confirmLabel: 'Revoke' })) { await DEL(`/api-keys/${k.id}`); refresh(); } } })) },
      ],
      empty: h('div', { class: 'table-empty' }, 'No API keys yet.'),
    }), { actions: create }),
    card('REST API quick reference', h('div', { class: 'stack' },
      kv([['Base URL', h('code', null, `${store.baseUrl}/api`)], ['Auth header', h('code', null, 'Authorization: Bearer agp_…')], ['Format', 'JSON in, JSON out']]),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Method'), h('th', null, 'Endpoint'), h('th', null, 'What it does'))),
        h('tbody', null, API_REF.map(([m, p, d]) => h('tr', null, h('td', null, pill(m, m === 'GET' ? 'blue' : m === 'POST' ? 'green' : 'violet')), h('td', { class: 'mono small' }, p), h('td', { class: 'small' }, d)))))),
      h('pre', { class: 'code-block' }, `curl -X POST ${store.baseUrl}/api/contacts/upsert \\
  -H "Authorization: Bearer agp_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"priya@acme.com","first_name":"Priya","company_name":"Acme","tags":["n8n"]}'`))),
    card('Webhook event payloads', h('div', { class: 'stack' }, sampleSel, sample)));
}

// ======================= LEAD FORMS =======================
function embedSnippet(f) {
  return `<form action="${f.endpoint}" method="POST">
  <input name="name" placeholder="Full name" required>
  <input name="email" type="email" placeholder="Work email" required>
  <input name="phone" placeholder="Phone">
  <input name="company" placeholder="Company">
  <textarea name="message" placeholder="How can we help?"></textarea>
  <!-- spam trap: keep hidden -->
  <input name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
  <button type="submit">Send</button>
</form>`;
}

function openFormEditor(form, onSaved) {
  const f = form || { name: 'Website contact form', tags: ['website'], status: 'lead', active: true, create_deal: false, owner_id: store.user.id };
  const fields = formFields([
    { name: 'name', label: 'Form name', required: true },
    { name: 'source', label: 'Source label', placeholder: `Form: ${f.name}` },
    { name: 'tags', label: 'Tags to add', type: 'tags' },
    { name: 'status', label: 'Contact status', type: 'select', options: store.meta.contact_statuses },
    { name: 'owner_id', label: 'Assign to', type: 'select', options: store.meta.users.map((u) => ({ value: u.id, label: u.name })), placeholder: 'Unassigned' },
    { name: 'sequence_id', label: 'Enroll in sequence', type: 'select', options: store.meta.sequences.map((s) => ({ value: s.id, label: s.name })), placeholder: 'None' },
    { name: 'redirect_url', label: 'Redirect after submit (HTML forms)', placeholder: 'https://adasglobuspro.com/thank-you', span: 2 },
    { name: 'create_deal', label: 'Also open a deal for each submission', type: 'checkbox' },
    { name: 'active', label: 'Active', type: 'checkbox' },
  ], f);
  modal({
    title: form ? 'Edit form' : 'New lead form',
    size: 'lg',
    body: fields.el,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', primary: true, onClick: async ({ close }) => {
        if (!fields.validate()) return;
        const v = fields.values();
        if (form) await PATCH(`/forms/${form.id}`, v); else await POST('/forms', v);
        toast('Form saved');
        close();
        onSaved();
      },
    }],
  });
}

async function formsTab(el) {
  const { forms } = await GET('/forms');
  el.append(card('Lead capture forms', h('div', { class: 'stack' },
    muted('Each form gets a public endpoint. Post to it from your website, landing pages, or an n8n workflow (Facebook/Google Lead Ads, Typeform, Webflow…). New leads are created or updated by email.'),
    forms.length ? forms.map((f) => h('div', { class: 'form-card' },
      h('div', { class: 'form-card-head' },
        h('div', null, h('b', null, f.name), ' ', pill(f.active ? 'active' : 'off', f.active ? 'green' : 'slate'),
          h('div', { class: 'muted small' }, `${num(f.submissions)} submissions${f.sequence_name ? ` · enrolls in ${f.sequence_name}` : ''}${f.create_deal ? ' · opens a deal' : ''}`)),
        h('div', { class: 'row-gap' },
          iconBtn('edit', 'Edit', () => openFormEditor(f, refresh)),
          iconBtn('trash', 'Delete', async () => { if (await confirmDialog(`Delete form “${f.name}”? Its endpoint stops working.`, { danger: true, confirmLabel: 'Delete' })) { await DEL(`/forms/${f.id}`); refresh(); } }))),
      copyField(f.endpoint, { label: 'Endpoint (POST JSON or form data)' }),
      h('details', null, h('summary', null, 'HTML embed code'), h('pre', { class: 'code-block' }, embedSnippet(f)),
        btn('Copy HTML', { small: true, iconName: 'copy', onClick: () => copy(embedSnippet(f)) })),
      h('details', null, h('summary', null, 'JSON example (n8n HTTP Request node)'), h('pre', { class: 'code-block' }, `POST ${f.endpoint}
Content-Type: application/json

{ "first_name": "Priya", "last_name": "Sharma", "email": "priya@acme.com",
  "phone": "+91 98765 43210", "company": "Acme", "message": "Need a quote" }`))))
      : emptyState({ iconName: 'form', title: 'No forms yet', text: 'Create a form to capture leads from your website.' })),
  { actions: btn('New form', { primary: true, small: true, iconName: 'plus', onClick: () => openFormEditor(null, refresh) }) }));
}

// ======================= LOGS =======================
async function logsTab(el) {
  const { log } = await GET('/integration-log');
  el.append(card('Integration log', dataTable({
    rows: log,
    columns: [
      { label: 'When', render: (r) => h('span', { title: dateTime(r.created_at) }, ago(r.created_at)) },
      { label: 'Integration', render: (r) => cap(r.integration) },
      { label: 'Action', render: (r) => cap(r.action) },
      { label: 'Status', render: (r) => pill(r.status, r.status === 'ok' ? 'green' : 'red') },
      { label: 'Details', render: (r) => h('span', { class: 'small' }, r.detail) },
    ],
    empty: h('div', { class: 'table-empty' }, 'Nothing logged yet.'),
  }), { actions: btn('Run scheduler now', { small: true, iconName: 'play', onClick: (e) => busy(e.currentTarget, async () => { await POST('/system/run-scheduler'); toast('Sequences, email queue and webhook retries processed'); }) }) }));
}

export { MASK, loadMeta };
