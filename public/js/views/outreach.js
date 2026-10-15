import {
  h, icon, GET, POST, PATCH, DEL, store, loadMeta, qs, num, pct, ratio, date, dateTime, ago, cap, toast, modal, confirmDialog, promptDialog,
  navigate, debounce, busy, canManage,
} from '../core.js';
import {
  pageHeader, dataTable, pager, tabs, btn, iconBtn, muted, pill, card, statTile, emptyState, richEditor, selectInput, searchInput,
  openEmailViewer, kv, TEMPLATE_VARS,
} from '../components.js';
import { openComposer } from '../forms.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const EMAIL_TONE = { sent: 'green', received: 'blue', failed: 'red', queued: 'slate', sending: 'yellow', cancelled: 'slate' };

function engagement(e) {
  const out = [];
  if (e.direction === 'in') out.push(h('span', { class: 'chip chip-green' }, icon('reply'), 'Reply'));
  if (e.open_count) out.push(h('span', { class: 'chip chip-blue', title: `First opened ${dateTime(e.opened_at)}` }, icon('eye'), num(e.open_count)));
  if (e.click_count) out.push(h('span', { class: 'chip chip-violet' }, icon('pointer'), num(e.click_count)));
  if (e.replied_at && e.direction === 'out') out.push(h('span', { class: 'chip chip-green' }, icon('reply'), 'Replied'));
  if (e.bounced) out.push(h('span', { class: 'chip chip-red' }, 'Bounced'));
  return out.length ? h('span', { class: 'chips' }, out) : null;
}

// ======================= EMAILS =======================
const emailState = { tab: 'all', q: '', offset: 0 };

export async function emailsView(el) {
  const go = (patch) => { Object.assign(emailState, patch); refresh(); };
  const filter = { all: {}, sent: { direction: 'out', status: 'sent' }, received: { direction: 'in' }, queued: { status: 'queued' }, failed: { status: 'failed' } }[emailState.tab];
  const [data, stats] = await Promise.all([
    GET(`/emails${qs({ ...filter, q: emailState.q, offset: emailState.offset, limit: 50 })}`),
    GET('/emails/stats?days=30'),
  ]);
  const s = stats.stats;
  el.append(
    pageHeader('Emails', {
      subtitle: 'Every email sent from the CRM, with replies synced from your inbox (IMAP).',
      actions: [btn('Compose', { primary: true, iconName: 'mail', onClick: () => openComposer({ onSent: refresh }) })],
    }),
    h('div', { class: 'stats' },
      statTile('Sent (30 days)', num(s.sent), stats.queued ? `${num(stats.queued)} queued` : 'Nothing queued', { iconName: 'send' }),
      statTile('Open rate', pct(ratio(s.opened, s.sent)), `${num(s.opened)} opened`, { iconName: 'eye' }),
      statTile('Click rate', pct(ratio(s.clicked, s.sent)), `${num(s.clicked)} clicked`, { iconName: 'pointer' }),
      statTile('Reply rate', pct(ratio(s.replied, s.sent)), `${num(stats.received)} replies received`, { iconName: 'reply' }),
      statTile('Bounced / failed', `${num(s.bounced)} / ${num(stats.failed)}`, 'Bounces are auto-suppressed', { iconName: 'alert' })),
    h('div', { class: 'toolbar' },
      tabs([{ id: 'all', label: 'All' }, { id: 'sent', label: 'Sent' }, { id: 'received', label: 'Replies' }, { id: 'queued', label: 'Queued', count: stats.queued || null }, { id: 'failed', label: 'Failed', count: stats.failed || null }],
        emailState.tab, (tab) => go({ tab, offset: 0 })),
      h('span', { class: 'grow' }),
      searchInput(emailState.q, (q) => go({ q, offset: 0 }), 'Search subject or recipient…')),
    dataTable({
      rows: data.emails,
      onRowClick: (r) => openEmailViewer(r.id),
      columns: [
        { label: '', width: '32px', render: (r) => icon(r.direction === 'in' ? 'reply' : 'send', r.direction === 'in' ? 'text-good' : 'muted') },
        { label: 'Contact', render: (r) => (r.contact_id ? h('a', { href: `#/contacts/${r.contact_id}`, class: 'strong' }, r.contact_name) : h('span', null, r.direction === 'in' ? r.from_addr : r.to_addr)) },
        { label: 'Subject', render: (r) => h('span', { class: 'clamp-1' }, r.subject || '(no subject)') },
        { label: 'Status', render: (r) => h('span', { class: 'row-gap' }, pill(r.status, EMAIL_TONE[r.status]), engagement(r)) },
        { label: 'Sent by', key: 'user_name', cls: 'hide-lg' },
        { label: 'Date', cls: 'nowrap', render: (r) => h('span', { title: dateTime(r.sent_at || r.created_at) }, ago(r.sent_at || r.created_at)) },
        { label: '', render: (r) => (r.status === 'failed' ? btn('Retry', { small: true, onClick: (e) => busy(e.currentTarget, async () => { const x = await POST(`/emails/${r.id}/retry`); toast(x.email.status === 'sent' ? 'Sent' : `Failed: ${x.email.error}`, x.email.status === 'sent' ? 'ok' : 'error'); refresh(); }) }) : null) },
      ],
      empty: emptyState({ iconName: 'inbox', title: 'No emails yet', text: 'Send an email from a contact, start a sequence, or launch a campaign.' }),
    }),
    pager({ total: data.total, limit: data.limit, offset: data.offset, onChange: (offset) => go({ offset }) }));
}

// ======================= TEMPLATES =======================
function previewModal(subject, body, contactId) {
  return POST('/templates/preview', { subject, body, contact_id: contactId }).then((p) => {
    const frame = h('iframe', { class: 'email-frame', sandbox: 'allow-same-origin', title: 'Preview' });
    frame.srcdoc = `<!doctype html><html><head><style>body{font:14px/1.55 system-ui,sans-serif;color:#1d2433;background:#fff;margin:0;padding:12px}</style></head><body>${p.body}</body></html>`;
    frame.addEventListener('load', () => { try { frame.style.height = `${frame.contentDocument.documentElement.scrollHeight + 16}px`; } catch { /* ignore */ } });
    modal({ title: 'Preview', size: 'lg', body: h('div', null, kv([['Subject', h('b', null, p.subject)]]), muted('Shown with sample contact data.'), frame), actions: [{ label: 'Close' }] });
  });
}

function openTemplateEditor(tpl, onSaved) {
  const t = tpl || { name: '', category: '', subject: '', body: '' };
  const name = h('input', { class: 'input', value: t.name, placeholder: 'e.g. Cold intro – manufacturing' });
  const category = h('input', { class: 'input', value: t.category || '', placeholder: 'Outreach, Sales, Onboarding…' });
  const subject = h('input', { class: 'input', value: t.subject, placeholder: 'Quick idea for {{company}}' });
  const editor = richEditor({ value: t.body, minHeight: 280 });
  modal({
    title: tpl ? `Edit template` : 'New template',
    size: 'lg',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Category'), category)),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Subject'), subject),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Body'), editor.el),
      h('p', { class: 'help' }, `Variables: ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(' ')}. Add a fallback with {{first_name|there}}. Campaign and sequence emails get your unsubscribe footer automatically.`)),
    actions: [
      { label: 'Preview', onClick: () => previewModal(subject.value, editor.getValue()) },
      { label: 'Cancel' },
      {
        label: 'Save template',
        primary: true,
        onClick: async ({ close }) => {
          const body = { name: name.value.trim(), category: category.value.trim() || null, subject: subject.value, body: editor.getValue() };
          if (!body.name || !body.subject || !body.body) return toast('Name, subject and body are required', 'error');
          if (tpl) await PATCH(`/templates/${tpl.id}`, body); else await POST('/templates', body);
          await loadMeta();
          toast('Template saved');
          close();
          onSaved?.();
        },
      },
    ],
  });
}

export async function templatesView(el) {
  const { templates } = await GET('/templates');
  const groups = {};
  for (const t of templates) (groups[t.category || 'General'] ||= []).push(t);
  el.append(
    pageHeader('Email templates', {
      subtitle: 'Reusable emails with personalization variables, used in one-off emails, sequences and campaigns.',
      actions: [btn('New template', { primary: true, iconName: 'plus', onClick: () => openTemplateEditor(null, refresh) })],
    }),
    templates.length ? Object.entries(groups).map(([cat, list]) => h('section', { class: 'tpl-group' },
      h('h2', { class: 'section-title' }, cat),
      h('div', { class: 'tpl-grid' }, list.map((t) => h('article', { class: 'card tpl-card' },
        h('div', { class: 'tpl-head' }, h('h3', null, t.name),
          h('div', { class: 'row-gap' },
            iconBtn('eye', 'Preview', () => previewModal(t.subject, t.body)),
            iconBtn('edit', 'Edit', () => openTemplateEditor(t, refresh)),
            iconBtn('copy', 'Duplicate', async () => { await POST('/templates', { name: `${t.name} (copy)`, category: t.category, subject: t.subject, body: t.body }); await loadMeta(); refresh(); }),
            iconBtn('trash', 'Delete', async () => {
              if (!await confirmDialog(`Delete template “${t.name}”?`, { danger: true, confirmLabel: 'Delete' })) return;
              await DEL(`/templates/${t.id}`); await loadMeta(); refresh();
            }))),
        h('div', { class: 'tpl-subject' }, t.subject),
        h('div', { class: 'muted small' }, `Sent ${num(t.sent_count)} · ${pct(ratio(t.open_count, t.sent_count))} opened · ${pct(ratio(t.reply_count, t.sent_count))} replied`)))))) : emptyState({ iconName: 'template', title: 'No templates yet', text: 'Create your first reusable email.' }));
}

// ======================= CAMPAIGNS =======================
const CAMPAIGN_TONE = { draft: 'slate', sending: 'yellow', sent: 'green', cancelled: 'red' };

export async function campaignsView(el) {
  const { campaigns } = await GET('/campaigns');
  el.append(
    pageHeader('Campaigns', {
      subtitle: 'One-off email blasts to a filtered list of contacts. Sent at a safe rate through your mailbox.',
      actions: [btn('New campaign', {
        primary: true, iconName: 'plus', onClick: async () => {
          const name = await promptDialog('Campaign name', { title: 'New campaign', confirmLabel: 'Create draft' });
          if (!name) return;
          const { campaign } = await POST('/campaigns', { name, filter: {} });
          navigate(`#/campaigns/${campaign.id}`);
        },
      })],
    }),
    dataTable({
      rows: campaigns,
      onRowClick: (r) => navigate(`#/campaigns/${r.id}`),
      columns: [
        { label: 'Campaign', render: (r) => h('a', { class: 'strong', href: `#/campaigns/${r.id}` }, r.name) },
        { label: 'Status', render: (r) => pill(r.status, CAMPAIGN_TONE[r.status]) },
        { label: 'Recipients', cls: 'num', render: (r) => num(r.stats.total) },
        { label: 'Sent', cls: 'num', render: (r) => num(r.stats.sent) },
        { label: 'Opened', cls: 'num', render: (r) => pct(ratio(r.stats.opened, r.stats.sent)) },
        { label: 'Clicked', cls: 'num hide-md', render: (r) => pct(ratio(r.stats.clicked, r.stats.sent)) },
        { label: 'Replied', cls: 'num', render: (r) => pct(ratio(r.stats.replied, r.stats.sent)) },
        { label: 'Created', cls: 'hide-md', render: (r) => date(r.created_at) },
      ],
      empty: emptyState({ iconName: 'send', title: 'No campaigns yet', text: 'Pick an audience by tag, status or owner, write the email, and send.' }),
    }));
}

export async function campaignDetailView(el, { id }) {
  const { campaign: c } = await GET(`/campaigns/${id}`);
  const back = { href: '#/campaigns', label: 'Campaigns' };
  if (c.status !== 'draft') {
    const s = c.stats;
    const { emails } = await GET(`/emails?campaign_id=${c.id}&limit=200`);
    el.append(
      pageHeader(c.name, {
        back,
        subtitle: `${cap(c.status)} · ${c.sent_at ? dateTime(c.sent_at) : ''}`,
        actions: [
          c.status === 'sending' ? btn('Cancel remaining', { danger: true, onClick: async () => { const r = await POST(`/campaigns/${c.id}/cancel`); toast(`${r.cancelled} cancelled`); refresh(); } }) : null,
          btn('Refresh', { iconName: 'refresh', onClick: refresh }),
        ],
      }),
      h('div', { class: 'stats' },
        statTile('Delivered', `${num(s.sent)} / ${num(s.total)}`, s.queued ? `${num(s.queued)} still queued` : `${num(s.failed)} failed`),
        statTile('Opened', pct(ratio(s.opened, s.sent)), `${num(s.opened)} people`),
        statTile('Clicked', pct(ratio(s.clicked, s.sent)), `${num(s.clicked)} people`),
        statTile('Replied', pct(ratio(s.replied, s.sent)), `${num(s.replied)} people`),
        statTile('Bounced', num(s.bounced), 'Suppressed automatically')),
      card('Recipients', dataTable({
        rows: emails,
        onRowClick: (r) => openEmailViewer(r.id),
        columns: [
          { label: 'Contact', render: (r) => (r.contact_id ? h('a', { href: `#/contacts/${r.contact_id}` }, r.contact_name) : r.to_addr) },
          { label: 'Email', key: 'to_addr', cls: 'hide-md' },
          { label: 'Status', render: (r) => h('span', { class: 'row-gap' }, pill(r.status, EMAIL_TONE[r.status]), engagement(r)) },
          { label: 'Sent', render: (r) => (r.sent_at ? ago(r.sent_at) : muted('—')) },
        ],
      })));
    return;
  }

  const filter = { ...(c.filter || {}) };
  const ids = Array.isArray(filter.ids) ? filter.ids : [];
  const countEl = h('b', null, '…');
  const sampleEl = h('span', { class: 'muted small' });
  const updateCount = debounce(async () => {
    const r = await POST(`/campaigns/${c.id}/recipients`, { filter: currentFilter() }).catch(() => null);
    if (!r) return;
    countEl.textContent = `${num(r.total)}${r.capped ? '+ (first 1,000 will be sent)' : ''}`;
    sampleEl.textContent = r.sample.length ? `e.g. ${r.sample.slice(0, 3).map((x) => x.email).join(', ')}` : '';
  }, 250);
  const f = {
    status: selectInput(store.meta.contact_statuses, filter.status, updateCount, { placeholder: 'Any status' }),
    tag: selectInput(store.meta.tags, filter.tag, updateCount, { placeholder: 'Any tag' }),
    owner_id: selectInput(store.meta.users.map((u) => ({ value: u.id, label: u.name })), filter.owner_id, updateCount, { placeholder: 'Any owner' }),
    source: selectInput(store.meta.sources, filter.source, updateCount, { placeholder: 'Any source' }),
    min_score: h('input', { class: 'input', type: 'number', min: 0, value: filter.min_score || '', placeholder: '0' }),
  };
  f.min_score.addEventListener('input', updateCount);
  let useIds = ids.length > 0;
  const idsNote = useIds ? h('div', { class: 'banner small' }, `Limited to ${ids.length} contacts you selected. `, h('button', { class: 'link-btn', type: 'button', onclick: () => { useIds = false; idsNote.remove(); updateCount(); } }, 'Use filters instead')) : null;
  function currentFilter() {
    const out = { status: f.status.value, tag: f.tag.value, owner_id: f.owner_id.value, source: f.source.value, min_score: f.min_score.value };
    if (useIds) out.ids = ids;
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== '' && v !== undefined));
  }
  const tplSel = selectInput(store.meta.templates.map((t) => ({ value: t.id, label: t.name })), c.template_id || '', async (v) => {
    if (!v) return;
    const { template } = await GET(`/templates/${v}`);
    subject.value = template.subject;
    editor.setValue(template.body);
  }, { placeholder: 'Start from a template (optional)' });
  const subject = h('input', { class: 'input', value: c.subject, placeholder: 'Subject line' });
  const editor = richEditor({ value: c.body, minHeight: 300 });
  const save = () => PATCH(`/campaigns/${c.id}`, { subject: subject.value, body: editor.getValue(), template_id: tplSel.value || null, filter: currentFilter() });
  updateCount();

  el.append(
    pageHeader(c.name, {
      back,
      subtitle: 'Draft',
      actions: [
        btn('Delete', { ghost: true, iconName: 'trash', onClick: async () => { if (await confirmDialog('Delete this draft?', { danger: true, confirmLabel: 'Delete' })) { await DEL(`/campaigns/${c.id}`); navigate('#/campaigns'); } } }),
        btn('Preview', { iconName: 'eye', onClick: () => previewModal(subject.value, editor.getValue()) }),
        btn('Send test to me', { iconName: 'mail', onClick: (e) => busy(e.currentTarget, async () => {
          await POST('/emails/send', { to: store.user.email, subject: `[TEST] ${subject.value}`, body: editor.getValue(), force: true });
          toast(`Test sent to ${store.user.email}`);
        }) }),
        btn('Save draft', { onClick: (e) => busy(e.currentTarget, async () => { await save(); toast('Draft saved'); }) }),
        canManage() ? btn('Send campaign', { primary: true, iconName: 'send', onClick: (e) => busy(e.currentTarget, async () => {
          if (!subject.value.trim() || !editor.getValue()) return toast('Add a subject and a message', 'error');
          await save();
          if (!await confirmDialog(`Send “${subject.value}” to ${countEl.textContent} contacts now? Unsubscribed and bounced addresses are skipped.`, { confirmLabel: 'Send now' })) return;
          const r = await POST(`/campaigns/${c.id}/send`);
          toast(`${num(r.queued)} emails queued. Sending at your configured rate.`);
          refresh();
        }) }) : null,
      ],
    }),
    h('div', { class: 'detail' },
      h('div', { class: 'detail-side' },
        card('Audience', h('div', { class: 'stack' },
          idsNote,
          h('div', { class: 'form-grid one' },
            h('label', { class: 'field' }, h('span', { class: 'label' }, 'Status'), f.status),
            h('label', { class: 'field' }, h('span', { class: 'label' }, 'Tag'), f.tag),
            h('label', { class: 'field' }, h('span', { class: 'label' }, 'Owner'), f.owner_id),
            h('label', { class: 'field' }, h('span', { class: 'label' }, 'Source'), f.source),
            h('label', { class: 'field' }, h('span', { class: 'label' }, 'Minimum lead score'), f.min_score)),
          h('div', { class: 'audience-count' }, countEl, muted(' recipients'), h('br'), sampleEl),
          h('p', { class: 'help' }, 'Only contacts with an email address who have not unsubscribed or bounced are included.')))),
      h('div', { class: 'detail-main' },
        card('Message', h('div', { class: 'stack' },
          tplSel,
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Subject'), subject),
          editor.el,
          h('p', { class: 'help' }, 'Your unsubscribe footer (Settings → Email sending) is added automatically. Use {{first_name|there}} for personalization with a fallback.'))))));
}

// ======================= SEQUENCES =======================
const ENROLL_TONE = { active: 'green', paused: 'yellow', completed: 'blue', replied: 'violet', failed: 'red', unsubscribed: 'red', bounced: 'red', stopped: 'slate' };

export async function sequencesView(el) {
  const { sequences } = await GET('/sequences');
  el.append(
    pageHeader('Sequences', {
      subtitle: 'Automated multi-step follow-ups. Emails go out from your mailbox; contacts are removed automatically when they reply.',
      actions: [btn('New sequence', {
        primary: true, iconName: 'plus', onClick: async () => {
          const name = await promptDialog('Sequence name', { title: 'New sequence', placeholder: 'e.g. Post-demo follow-up', confirmLabel: 'Create' });
          if (!name) return;
          const { sequence } = await POST('/sequences', { name, status: 'paused' });
          await loadMeta();
          navigate(`#/sequences/${sequence.id}`);
        },
      })],
    }),
    sequences.length ? h('div', { class: 'seq-grid' }, sequences.map((s) => {
      const toggle = h('input', { type: 'checkbox', class: 'switch', checked: s.status === 'active', 'aria-label': 'Active' });
      toggle.addEventListener('change', async () => {
        await PATCH(`/sequences/${s.id}`, { status: toggle.checked ? 'active' : 'paused' });
        await loadMeta();
        toast(toggle.checked ? 'Sequence activated' : 'Sequence paused');
      });
      const es = s.email_stats;
      return h('article', { class: 'card seq-card' },
        h('div', { class: 'seq-head' }, h('a', { href: `#/sequences/${s.id}`, class: 'strong' }, s.name), h('label', { class: 'switch-wrap' }, toggle, h('span', { class: 'small muted' }, s.status === 'active' ? 'Active' : 'Paused'))),
        s.description ? h('p', { class: 'muted small clamp-2' }, s.description) : null,
        h('div', { class: 'mini-stats' },
          h('div', null, h('b', null, num(s.step_count)), muted('steps')),
          h('div', null, h('b', null, num(s.stats.active)), muted('active')),
          h('div', null, h('b', null, pct(ratio(es.opened, es.sent))), muted('opened')),
          h('div', null, h('b', null, pct(ratio(s.stats.replied, s.stats.enrolled))), muted('replied'))),
        h('a', { class: 'btn btn-sm', href: `#/sequences/${s.id}` }, 'Open', icon('arrowRight')));
    })) : emptyState({ iconName: 'sequence', title: 'No sequences yet', text: 'Create a sequence of emails and tasks, then enroll contacts.' }));
}

function stepEditor(step, index, total, actions) {
  const s = step;
  const type = selectInput([{ value: 'email', label: 'Send email' }, { value: 'task', label: 'Create task' }], s.type, (v) => { s.type = v; s._editor = null; actions.redraw(); });
  const days = h('input', { class: 'input input-xs', type: 'number', min: 0, value: s.delay_days || 0, 'aria-label': 'Days' });
  const hours = h('input', { class: 'input input-xs', type: 'number', min: 0, max: 23, value: s.delay_hours || 0, 'aria-label': 'Hours' });
  days.addEventListener('input', () => { s.delay_days = Number(days.value) || 0; });
  hours.addEventListener('input', () => { s.delay_hours = Number(hours.value) || 0; });
  let body;
  if (s.type === 'email') {
    const tpl = selectInput(store.meta.templates.map((t) => ({ value: t.id, label: t.name })), s.template_id || '', (v) => {
      if (s._editor) s.body = s._editor.getValue();
      s._editor = null;
      s.template_id = v ? Number(v) : null;
      actions.redraw();
    }, { placeholder: 'Write a custom email' });
    if (s.template_id) {
      const t = store.meta.templates.find((x) => x.id === s.template_id);
      body = h('div', { class: 'stack' }, tpl, h('div', { class: 'muted small' }, 'Subject: ', h('b', null, t?.subject || '')));
    } else {
      const subject = h('input', { class: 'input', value: s.subject || '', placeholder: index === 0 ? 'Subject' : 'Subject (leave blank to reply in the same thread)' });
      subject.addEventListener('input', () => { s.subject = subject.value; });
      s._editor = richEditor({ value: s.body || '', minHeight: 160 });
      body = h('div', { class: 'stack' }, tpl, subject, s._editor.el);
    }
  } else {
    const title = h('input', { class: 'input', value: s.task_title || '', placeholder: 'e.g. Call {{full_name}} at {{company}}' });
    const notes = h('textarea', { class: 'input', rows: 2, placeholder: 'Notes for the task (optional)' }, s.body || '');
    title.addEventListener('input', () => { s.task_title = title.value; });
    notes.addEventListener('input', () => { s.body = notes.value; });
    body = h('div', { class: 'stack' }, title, notes, muted('The task is assigned to the contact’s owner.'));
  }
  return h('li', { class: 'step card' },
    h('div', { class: 'step-num' }, index + 1),
    h('div', { class: 'step-main' },
      h('div', { class: 'step-head' },
        type,
        h('span', { class: 'step-wait' }, 'Wait', days, 'days', hours, 'hours', h('span', { class: 'muted' }, index === 0 ? 'after enrolling' : 'after the previous step')),
        h('span', { class: 'grow' }),
        iconBtn('arrowUp', 'Move up', index > 0 ? () => actions.move(index, -1) : null),
        iconBtn('chevronDown', 'Move down', index < total - 1 ? () => actions.move(index, 1) : null),
        iconBtn('trash', 'Remove step', () => actions.remove(index))),
      body));
}

function openEnrollPicker(sequenceId, onDone) {
  const chosen = new Map();
  const list = h('div', { class: 'pick-list' });
  const count = h('b', null, '0');
  const search = async (q) => {
    const { contacts } = await GET(`/contacts${qs({ q, has_email: 1, unsubscribed: 0, limit: 30 })}`);
    list.replaceChildren(...contacts.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(c.id) });
      cb.addEventListener('change', () => { if (cb.checked) chosen.set(c.id, c); else chosen.delete(c.id); count.textContent = chosen.size; });
      return h('label', { class: 'pick-row' }, cb, h('span', null, h('b', null, c.full_name), muted(` ${c.email}${c.company_name ? ` · ${c.company_name}` : ''}`)));
    }));
    if (!contacts.length) list.append(muted('No contacts found'));
  };
  const tagSel = selectInput(store.meta.tags, '', () => {}, { placeholder: 'Choose a tag' });
  const statusSel = selectInput(store.meta.contact_statuses, '', () => {}, { placeholder: 'Any status' });
  let mode = 'pick';
  const pickPane = h('div', { class: 'stack' }, searchInput('', search, 'Search contacts with an email…'), list, h('div', null, count, muted(' selected')));
  const filterPane = h('div', { class: 'stack', hidden: true },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Everyone tagged'), tagSel),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'With status'), statusSel),
    muted('Up to 1,000 matching contacts are enrolled.'));
  const tabBar = h('div');
  const drawTabs = () => tabBar.replaceChildren(tabs([{ id: 'pick', label: 'Pick contacts' }, { id: 'filter', label: 'By tag / status' }], mode, (m) => { mode = m; pickPane.hidden = m !== 'pick'; filterPane.hidden = m !== 'filter'; drawTabs(); }));
  drawTabs();
  search('');
  modal({
    title: 'Enroll contacts',
    size: 'lg',
    body: h('div', { class: 'stack' }, tabBar, pickPane, filterPane),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Enroll',
        primary: true,
        onClick: async ({ close }) => {
          const payload = mode === 'pick' ? { contact_ids: [...chosen.keys()] } : { filter: { tag: tagSel.value, status: statusSel.value, has_email: '1' } };
          if (mode === 'pick' && !chosen.size) return toast('Select at least one contact', 'error');
          if (mode === 'filter' && !tagSel.value && !statusSel.value) return toast('Choose a tag or status', 'error');
          const r = await POST(`/sequences/${sequenceId}/enroll`, payload);
          toast(`${r.enrolled} enrolled${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
          close();
          onDone();
        },
      },
    ],
  });
}

export async function sequenceDetailView(el, { id }) {
  const data = await GET(`/sequences/${id}`);
  const seq = data.sequence;
  let steps = data.steps.map((s) => ({ ...s }));
  const stepsList = h('ol', { class: 'steps' });
  const actions = {
    redraw: () => {
      steps.forEach((s) => { if (s._editor) s.body = s._editor.getValue(); });
      stepsList.replaceChildren(...steps.map((s, i) => stepEditor(s, i, steps.length, actions)));
    },
    move: (i, dir) => { actions.redraw(); const [x] = steps.splice(i, 1); steps.splice(i + dir, 0, x); actions.redraw(); },
    remove: (i) => { steps.splice(i, 1); actions.redraw(); },
  };
  actions.redraw();
  const add = (type) => { actions.redraw(); steps.push(type === 'email' ? { type, delay_days: steps.length ? 3 : 0, delay_hours: 0, subject: '', body: '' } : { type, delay_days: 1, delay_hours: 0, task_title: '' }); actions.redraw(); };

  const name = h('input', { class: 'input input-title', value: seq.name, 'aria-label': 'Sequence name' });
  const desc = h('input', { class: 'input', value: seq.description || '', placeholder: 'What is this sequence for?' });
  const stop = h('input', { type: 'checkbox', checked: seq.stop_on_reply });
  const biz = h('input', { type: 'checkbox', checked: seq.business_hours });
  const active = h('input', { type: 'checkbox', class: 'switch', checked: seq.status === 'active' });

  const save = async () => {
    steps.forEach((s) => { if (s._editor) s.body = s._editor.getValue(); });
    const payload = {
      name: name.value.trim(), description: desc.value, stop_on_reply: stop.checked, business_hours: biz.checked, status: active.checked ? 'active' : 'paused',
      steps: steps.map((s) => {
        const usesTemplate = s.type === 'email' && s.template_id;
        return {
          type: s.type, delay_days: s.delay_days, delay_hours: s.delay_hours, template_id: usesTemplate ? s.template_id : null,
          subject: usesTemplate || s.type === 'task' ? null : s.subject || null, body: usesTemplate ? null : s.body || null, task_title: s.type === 'task' ? s.task_title || null : null,
        };
      }),
    };
    await PATCH(`/sequences/${seq.id}`, payload);
    await loadMeta();
    toast('Sequence saved');
  };

  const st = data.stats;
  const es = data.email_stats;
  el.append(
    pageHeader(seq.name, {
      back: { href: '#/sequences', label: 'Sequences' },
      actions: [
        btn('Delete', { ghost: true, iconName: 'trash', onClick: async () => {
          if (!await confirmDialog('Delete this sequence and all its enrollments?', { danger: true, confirmLabel: 'Delete' })) return;
          await DEL(`/sequences/${seq.id}`); await loadMeta(); navigate('#/sequences');
        } }),
        btn('Enroll contacts', { iconName: 'users', onClick: () => openEnrollPicker(seq.id, refresh) }),
        btn('Save', { primary: true, iconName: 'check', onClick: (e) => busy(e.currentTarget, async () => { await save(); refresh(); }) }),
      ],
    }),
    h('div', { class: 'stats' },
      statTile('Enrolled', num(st.enrolled), `${num(st.active)} active · ${num(st.paused)} paused`),
      statTile('Completed', num(st.completed), `${num(st.failed)} failed`),
      statTile('Replied', pct(ratio(st.replied, st.enrolled)), `${num(st.replied)} contacts`),
      statTile('Emails sent', num(es.sent), `${pct(ratio(es.opened, es.sent))} opened · ${pct(ratio(es.clicked, es.sent))} clicked`)),
    h('div', { class: 'detail detail-rev' },
      h('div', { class: 'detail-main' },
        card('Steps', h('div', { class: 'stack' },
          steps.length ? null : muted('No steps yet. Add an email to get started.'),
          stepsList,
          h('div', { class: 'row-gap' }, btn('Add email step', { iconName: 'mail', onClick: () => add('email') }), btn('Add task step', { iconName: 'task', onClick: () => add('task') }))))),
      h('div', { class: 'detail-side' },
        card('Settings', h('div', { class: 'stack' },
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Description'), desc),
          h('label', { class: 'field field-check' }, active, h('span', null, 'Active (sends steps on schedule)')),
          h('label', { class: 'field field-check' }, stop, h('span', null, 'Stop for a contact when they reply')),
          h('label', { class: 'field field-check' }, biz, h('span', null, 'Only send during business hours')),
          muted('Business hours and time zone are set in Settings → Email sending. Reply detection needs IMAP (Integrations → Email).'))))),
    card(`Enrollments (${data.enrollments.length})`, dataTable({
      rows: data.enrollments,
      columns: [
        { label: 'Contact', render: (r) => h('a', { href: `#/contacts/${r.contact_id}`, class: 'strong' }, r.contact_name) },
        { label: 'Company', key: 'company_name', cls: 'hide-md' },
        { label: 'Status', render: (r) => pill(r.status, ENROLL_TONE[r.status]) },
        { label: 'Step', render: (r) => `${Math.min(r.current_step + 1, data.steps.length)} / ${data.steps.length}` },
        { label: 'Next step', cls: 'hide-md', render: (r) => (r.status === 'active' && r.next_run_at ? h('span', { title: dateTime(r.next_run_at) }, ago(r.next_run_at)) : muted(r.last_error || '—')) },
        { label: '', render: (r) => h('span', { class: 'row-gap' },
          r.status === 'active' ? iconBtn('pause', 'Pause', async () => { await POST(`/enrollments/${r.id}/pause`); refresh(); }) : null,
          ['paused', 'failed', 'stopped'].includes(r.status) ? iconBtn('play', 'Resume', async () => { await POST(`/enrollments/${r.id}/resume`).catch((e) => toast(e.message, 'error')); refresh(); }) : null,
          r.status === 'active' ? iconBtn('stop', 'Stop', async () => { await POST(`/enrollments/${r.id}/stop`); refresh(); }) : null,
          iconBtn('trash', 'Remove', async () => { await DEL(`/enrollments/${r.id}`); refresh(); })) },
      ],
      empty: h('div', { class: 'table-empty' }, 'No one enrolled yet.'),
    })));
}

