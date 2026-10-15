import {
  h, icon, GET, POST, PATCH, DEL, store, qs, money, num, date, ago, cap, toast, modal, confirmDialog, promptDialog, navigate, canManage, busy,
} from '../core.js';
import {
  pageHeader, dataTable, pager, searchInput, selectInput, pill, avatar, tagList, btn, iconBtn, muted, card, kv, tabs, timelineView,
  emptyState, openEmailViewer, segmented, dropdownMenu,
} from '../components.js';
import { openContactForm, openActivityForm, openComposer, openEnrollDialog, openDealForm, openApolloPushDialog } from '../forms.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const state = { q: '', status: '', owner_id: '', tag: '', source: '', sort: '-created_at', offset: 0, limit: 50, selected: new Set() };

function filterParams() {
  return { q: state.q, status: state.status, owner_id: state.owner_id, tag: state.tag, source: state.source };
}

export async function contactsView(el, params, query) {
  if (query.tag !== undefined) state.tag = query.tag;
  if (query.status !== undefined) state.status = query.status;
  const data = await GET(`/contacts${qs({ ...filterParams(), sort: state.sort, offset: state.offset, limit: state.limit })}`);
  const go = (patch) => { Object.assign(state, patch); refresh(); };
  const meta = store.meta;

  const toolbar = h('div', { class: 'toolbar' },
    searchInput(state.q, (q) => go({ q, offset: 0 }), 'Search name, email, company…'),
    selectInput(meta.contact_statuses, state.status, (v) => go({ status: v, offset: 0 }), { placeholder: 'All statuses' }),
    selectInput([{ value: 'me', label: 'My contacts' }, ...meta.users.map((u) => ({ value: u.id, label: u.name }))], state.owner_id, (v) => go({ owner_id: v, offset: 0 }), { placeholder: 'All owners' }),
    selectInput(meta.tags, state.tag, (v) => go({ tag: v, offset: 0 }), { placeholder: 'All tags' }),
    selectInput(meta.sources, state.source, (v) => go({ source: v, offset: 0 }), { placeholder: 'All sources' }),
    (state.q || state.status || state.owner_id || state.tag || state.source)
      ? btn('Clear', { ghost: true, small: true, onClick: () => go({ q: '', status: '', owner_id: '', tag: '', source: '', offset: 0 }) }) : null);

  const bulk = h('div', { class: 'bulkbar', hidden: !state.selected.size });
  const renderBulk = () => {
    const ids = [...state.selected];
    bulk.hidden = !ids.length;
    bulk.replaceChildren(
      h('b', null, `${ids.length} selected`),
      btn('Enroll in sequence', { small: true, iconName: 'sequence', onClick: () => openEnrollDialog(ids, { onDone: refresh }) }),
      btn('Email campaign', { small: true, iconName: 'send', onClick: () => createCampaignFor(ids) }),
      btn('Add tag', { small: true, iconName: 'plus', onClick: async () => {
        const tag = await promptDialog('Tag to add', { title: `Tag ${ids.length} contacts`, confirmLabel: 'Add tag' });
        if (tag) { await POST('/contacts/bulk', { ids, action: 'add_tag', value: tag }); toast('Tag added'); refresh(); }
      } }),
      bulkSelect('Set status', meta.contact_statuses.map((s) => ({ value: s, label: cap(s) })), (v) => POST('/contacts/bulk', { ids, action: 'set_status', value: v })),
      bulkSelect('Assign owner', meta.users.map((u) => ({ value: u.id, label: u.name })), (v) => POST('/contacts/bulk', { ids, action: 'set_owner', value: v })),
      btn('Enrich (Apollo)', { small: true, iconName: 'sparkles', onClick: (e) => busy(e.currentTarget, async () => {
        const r = await POST('/apollo/enrich/contacts', { ids });
        toast(`Apollo: ${r.matched} enriched, ${r.unmatched} no match${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
        refresh();
      }) }),
      btn('Apollo sequence', { small: true, iconName: 'zap', onClick: () => openApolloPushDialog(ids) }),
      canManage() ? btn('Delete', { small: true, danger: true, iconName: 'trash', onClick: async () => {
        if (!await confirmDialog(`Delete ${ids.length} contacts and their activity? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' })) return;
        await POST('/contacts/bulk', { ids, action: 'delete' });
        state.selected.clear();
        toast('Contacts deleted');
        refresh();
      } }) : null,
      btn('', { small: true, ghost: true, iconName: 'x', title: 'Clear selection', onClick: () => { state.selected.clear(); refresh(); } }));
  };
  const bulkSelect = (label, options, run) => {
    const s = selectInput(options, '', async (v) => { if (!v) return; await run(v); toast('Updated'); refresh(); }, { placeholder: label, cls: 'input-sm' });
    return s;
  };
  renderBulk();

  const table = dataTable({
    selectable: true,
    selected: state.selected,
    onSelectionChange: renderBulk,
    sort: state.sort,
    onSort: (sort) => go({ sort }),
    onRowClick: (r) => navigate(`#/contacts/${r.id}`),
    rows: data.contacts,
    columns: [
      { label: 'Name', sort: 'name', render: (r) => h('div', { class: 'cell-person' }, avatar(r.full_name), h('div', null, h('a', { href: `#/contacts/${r.id}`, class: 'strong' }, r.full_name), h('div', { class: 'muted small' }, r.email || 'No email', r.unsubscribed ? ' · unsubscribed' : ''))) },
      { label: 'Company', sort: 'company', render: (r) => (r.company_id ? h('a', { href: `#/companies/${r.company_id}` }, r.company_name) : muted('—')) },
      { label: 'Title', key: 'title', cls: 'hide-md' },
      { label: 'Status', sort: 'status', render: (r) => pill(r.status) },
      { label: 'Score', sort: 'score', cls: 'num hide-md', render: (r) => num(r.score) },
      { label: 'Owner', key: 'owner_name', cls: 'hide-lg' },
      { label: 'Last contacted', sort: 'last_contacted_at', cls: 'hide-md', render: (r) => (r.last_contacted_at ? ago(r.last_contacted_at) : muted('Never')) },
      { label: 'Tags', cls: 'hide-lg', render: (r) => tagList(r.tags) || muted('—') },
    ],
    empty: emptyState({
      iconName: 'users', title: state.q || state.status || state.tag ? 'No contacts match these filters' : 'No contacts yet',
      text: 'Add contacts by hand, import a CSV, capture them from a website form, or find prospects with Apollo.',
      action: h('div', { class: 'row-gap' }, btn('New contact', { primary: true, iconName: 'plus', onClick: () => openContactForm({ onSaved: (c) => navigate(`#/contacts/${c.id}`) }) }),
        btn('Find prospects', { iconName: 'target', onClick: () => navigate('#/prospecting') })),
    }),
  });

  el.append(
    pageHeader('Contacts', {
      subtitle: `${num(data.total)} ${data.total === 1 ? 'person' : 'people'}`,
      actions: [
        btn('Import CSV', { iconName: 'upload', onClick: openImport }),
        h('a', { class: 'btn', href: `/api/contacts/export.csv${qs(filterParams())}`, download: '' }, icon('download'), h('span', null, 'Export')),
        btn('New contact', { primary: true, iconName: 'plus', onClick: () => openContactForm({ onSaved: (c) => navigate(`#/contacts/${c.id}`) }) }),
      ],
    }),
    toolbar, bulk, table,
    pager({ total: data.total, limit: data.limit, offset: data.offset, onChange: (offset) => go({ offset }) }));
}

async function createCampaignFor(ids) {
  const name = await promptDialog('Campaign name', { title: 'New email campaign', value: `Campaign ${new Date().toLocaleDateString()}`, confirmLabel: 'Create draft' });
  if (!name) return;
  const { campaign } = await POST('/campaigns', { name, filter: { ids } });
  navigate(`#/campaigns/${campaign.id}`);
}

function openImport() {
  const file = h('input', { type: 'file', accept: '.csv,text/csv', class: 'input' });
  const text = h('textarea', { class: 'input mono', rows: 8, placeholder: 'first_name,last_name,email,company,title\nPriya,Sharma,priya@acme.com,Acme,Head of Ops' });
  const tags = h('input', { class: 'input', placeholder: 'e.g. expo-2026' });
  const status = selectInput(store.meta.contact_statuses, 'lead', () => {});
  const updateExisting = h('input', { type: 'checkbox', checked: true });
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 12 * 1024 * 1024) return toast('File is too large (max 12 MB)', 'error');
    const reader = new FileReader();
    reader.onload = () => { text.value = reader.result; };
    reader.readAsText(f);
  });
  modal({
    title: 'Import contacts from CSV',
    size: 'lg',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Columns are matched automatically: First Name, Last Name, Name, Email, Phone, Mobile, Title, Company, Website, LinkedIn, City, Country, Tags, Status, Source. Apollo, LinkedIn Sales Navigator and HubSpot exports work as-is.'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'CSV file'), file),
      h('label', { class: 'field' }, h('span', { class: 'label' }, '…or paste CSV'), text),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Add tags to every row'), tags),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Default status'), status)),
      h('label', { class: 'field field-check' }, updateExisting, h('span', null, 'Update contacts that already exist (matched by email)'))),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import',
        primary: true,
        onClick: async ({ close }) => {
          if (!text.value.trim()) return toast('Choose a file or paste CSV text', 'error');
          const r = await POST('/contacts/import', { csv: text.value, tags: tags.value, status: status.value, update_existing: updateExisting.checked });
          toast(`Imported: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped`);
          if (r.errors.length) console.warn('Import issues', r.errors);
          close();
          refresh();
        },
      },
    ],
  });
}

// ======================= DETAIL =======================
let detailTab = 'timeline';

export async function contactDetailView(el, { id }) {
  const [data, tl] = await Promise.all([GET(`/contacts/${id}`), GET(`/timeline?contact_id=${id}`)]);
  const c = data.contact;
  const reload = refresh;

  const statusSel = selectInput(store.meta.contact_statuses, c.status, async (v) => { await PATCH(`/contacts/${c.id}`, { status: v }); toast('Status updated'); });
  const moreMenu = [
    ['Edit details', 'edit', () => openContactForm({ contact: c, onSaved: reload })],
    ['Log activity', 'note', () => openActivityForm({ contact: c, onSaved: reload })],
    ['Enrich with Apollo', 'sparkles', async () => {
      const r = await POST(`/apollo/enrich/contact/${c.id}`, {}).catch((e) => toast(e.message, 'error'));
      if (r) { toast(r.matched ? (r.updated_fields.length ? `Updated: ${r.updated_fields.join(', ')}` : 'Apollo had nothing new') : 'No match found in Apollo'); reload(); }
    }],
    ['Enroll in sequence', 'sequence', () => openEnrollDialog([c.id], { onDone: reload })],
    ['Add to Apollo sequence', 'zap', () => openApolloPushDialog([c.id])],
    ['Delete contact', 'trash', async () => {
      if (!await confirmDialog(`Delete ${c.full_name} and all their activity?`, { danger: true, confirmLabel: 'Delete' })) return;
      await DEL(`/contacts/${c.id}`);
      toast('Contact deleted');
      navigate('#/contacts');
    }],
  ];
  const more = dropdownMenu(btn('', { iconName: 'more', title: 'More actions' }), moreMenu.map(([label, ico, fn]) => ({ label, icon: ico, onClick: fn, danger: ico === 'trash' })));

  const es = data.email_stats;
  const profile = card(null, h('div', { class: 'profile' },
    h('div', { class: 'profile-top' }, avatar(c.full_name, 'lg'),
      h('div', null,
        h('h2', null, c.full_name),
        h('div', { class: 'muted' }, [c.title, c.company_id ? h('a', { href: `#/companies/${c.company_id}` }, c.company_name) : null].filter(Boolean).flatMap((x, i) => (i ? [' at ', x] : [x]))))),
    h('div', { class: 'profile-quick' },
      c.email ? h('a', { class: 'chip-link', href: `mailto:${c.email}` }, icon('mail'), c.email) : null,
      c.phone ? h('a', { class: 'chip-link', href: `tel:${c.phone}` }, icon('phone'), c.phone) : null,
      c.mobile ? h('a', { class: 'chip-link', href: `https://wa.me/${String(c.mobile).replace(/[^\d]/g, '')}`, target: '_blank', rel: 'noopener' }, icon('chat'), 'WhatsApp') : null,
      c.linkedin_url ? h('a', { class: 'chip-link', href: c.linkedin_url, target: '_blank', rel: 'noopener' }, icon('linkedin'), 'LinkedIn') : null),
    c.unsubscribed ? h('div', { class: 'banner banner-warn small' }, 'Unsubscribed: marketing emails and sequences are blocked.') : null,
    kv([
      ['Status', statusSel],
      ['Owner', c.owner_name],
      ['Lead score', h('span', null, h('b', null, num(c.score)), muted(' (opens +1, clicks +3, replies +10, forms +5)'))],
      ['Source', c.source],
      ['Location', [c.city, c.state, c.country].filter(Boolean).join(', ')],
      ['Email status', c.email_status],
      ['Tags', tagList(c.tags)],
      ['Last contacted', c.last_contacted_at ? ago(c.last_contacted_at) : 'Never'],
      ['Created', date(c.created_at)],
      c.apollo_id ? ['Apollo ID', h('span', { class: 'mono small' }, c.apollo_id)] : null,
    ]),
    c.notes ? h('div', { class: 'notes' }, c.notes) : null,
    h('div', { class: 'mini-stats' },
      h('div', null, h('b', null, num(es.sent)), muted('emails sent')),
      h('div', null, h('b', null, num(es.opened)), muted('opened')),
      h('div', null, h('b', null, num(es.clicked)), muted('clicked')),
      h('div', null, h('b', null, num(es.replied)), muted('replied')))));

  const enrollCard = card('Sequences', data.enrollments.length
    ? h('ul', { class: 'list-plain' }, data.enrollments.map((e) => h('li', { class: 'enroll-row' },
      h('div', null, h('a', { href: `#/sequences/${e.sequence_id}` }, e.sequence_name),
        h('div', { class: 'muted small' }, `Step ${Math.min(e.current_step + 1, e.step_count)} of ${e.step_count}`, e.status === 'active' && e.next_run_at ? ` · next ${ago(e.next_run_at)}` : '', e.last_error ? ` · ${e.last_error}` : '')),
      pill(e.status, { active: 'green', paused: 'yellow', completed: 'blue', replied: 'violet', failed: 'red', unsubscribed: 'red', bounced: 'red', stopped: 'slate' }[e.status]),
      e.status === 'active' ? iconBtn('pause', 'Pause', async () => { await POST(`/enrollments/${e.id}/pause`); reload(); })
        : ['paused', 'failed'].includes(e.status) ? iconBtn('play', 'Resume', async () => { await POST(`/enrollments/${e.id}/resume`).catch((err) => toast(err.message, 'error')); reload(); }) : null)))
    : muted('Not in any sequence.'), { actions: btn('Enroll', { small: true, ghost: true, iconName: 'plus', onClick: () => openEnrollDialog([c.id], { onDone: reload }) }) });

  const dealsCard = card('Deals', data.deals.length
    ? h('ul', { class: 'deal-mini' }, data.deals.map((d) => h('li', null, h('a', { href: `#/deals/${d.id}` }, d.title), h('span', { class: 'muted small' }, d.stage_name), h('b', null, money(d.value, { compact: true })))))
    : muted('No deals yet.'), { actions: btn('New deal', { small: true, ghost: true, iconName: 'plus', onClick: () => openDealForm({ defaults: { contact_id: c.id, contact_name: c.full_name, company_id: c.company_id, company_name: c.company_name }, onSaved: reload }) }) });

  // Quick log box
  let logType = 'note';
  const logText = h('textarea', { class: 'input', rows: 3, placeholder: 'Add a note, or log a call/meeting…' });
  const typeSeg = h('div');
  const drawSeg = () => typeSeg.replaceChildren(segmented([
    { value: 'note', label: 'Note' }, { value: 'call', label: 'Call' }, { value: 'meeting', label: 'Meeting' }, { value: 'whatsapp', label: 'WhatsApp' },
  ], logType, (v) => { logType = v; drawSeg(); }));
  drawSeg();
  const saveLog = btn('Save', { primary: true, small: true, onClick: (e) => busy(e.currentTarget, async () => {
    if (!logText.value.trim()) return toast('Write something first', 'error');
    const [subject, ...rest] = logText.value.trim().split('\n');
    await POST('/activities', { type: logType, contact_id: c.id, subject: subject.slice(0, 140), body: rest.join('\n').trim() || (subject.length > 140 ? logText.value : null) });
    toast('Saved');
    reload();
  }) });
  const quickLog = h('div', { class: 'quicklog card' }, logText, h('div', { class: 'quicklog-foot' }, typeSeg, saveLog));

  const openTasks = data.tasks;
  const tlItems = tl.items;
  const tabBody = h('div');
  const drawTab = () => {
    tabBody.replaceChildren(
      tabs([{ id: 'timeline', label: 'Timeline', count: tlItems.length }, { id: 'tasks', label: 'Open tasks', count: openTasks.length }], detailTab, (t) => { detailTab = t; drawTab(); }),
      detailTab === 'timeline'
        ? timelineView(tlItems, { onOpenEmail: openEmailViewer, onToggleTask: async (t, done) => { await POST(`/activities/${t.id}/complete`, { done }); reload(); } })
        : timelineView(openTasks.map((t) => ({ kind: 'activity', date: t.due_at || t.created_at, ...t })), { onToggleTask: async (t, done) => { await POST(`/activities/${t.id}/complete`, { done }); toast('Task completed'); reload(); } }));
  };
  drawTab();

  el.append(
    pageHeader(c.full_name, {
      back: { href: '#/contacts', label: 'Contacts' },
      actions: [
        btn('Email', { iconName: 'mail', primary: true, onClick: () => (c.email ? openComposer({ contact: c, onSent: reload }) : toast('This contact has no email address', 'error')) }),
        btn('Task', { iconName: 'task', onClick: () => openActivityForm({ type: 'task', contact: c, onSaved: reload }) }),
        btn('Edit', { iconName: 'edit', onClick: () => openContactForm({ contact: c, onSaved: reload }) }),
        more,
      ],
    }),
    h('div', { class: 'detail' },
      h('div', { class: 'detail-side' }, profile, dealsCard, enrollCard),
      h('div', { class: 'detail-main' }, quickLog, card(null, tabBody))));
}

