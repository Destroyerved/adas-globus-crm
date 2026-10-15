import { h, icon, GET, POST, DEL, store, qs, money, num, date, ago, toast, confirmDialog, promptDialog, navigate } from '../core.js';
import {
  pageHeader, dataTable, pager, searchInput, selectInput, pill, avatar, tagList, btn, muted, card, kv, timelineView, segmented,
  openEmailViewer, dropdownMenu, emptyState,
} from '../components.js';
import { openDealForm, openActivityForm, openComposer } from '../forms.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const state = { mode: 'board', q: '', owner_id: '', status: '', sort: '-created_at', offset: 0 };
const STATUS_TONE = { open: 'blue', won: 'green', lost: 'red' };

async function moveDeal(deal, stage) {
  let lostReason;
  if (stage.kind === 'lost') {
    lostReason = await promptDialog('Why was this deal lost?', { title: `Mark “${deal.title}” as lost`, placeholder: 'e.g. Went with a competitor, no budget', confirmLabel: 'Mark as lost' });
    if (lostReason === null) return false;
  }
  await POST(`/deals/${deal.id}/move`, { stage_id: stage.id, lost_reason: lostReason || undefined });
  toast(stage.kind === 'won' ? `🎉 Won ${money(deal.value)}` : `Moved to ${stage.name}`);
  return true;
}

export async function dealsView(el) {
  const go = (patch) => { Object.assign(state, patch); refresh(); };
  const header = pageHeader('Deals', {
    actions: [
      segmented([{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }], state.mode, (mode) => go({ mode })),
      btn('New deal', { primary: true, iconName: 'plus', onClick: () => openDealForm({ onSaved: refresh }) }),
    ],
  });
  const toolbar = h('div', { class: 'toolbar' },
    searchInput(state.q, (q) => go({ q, offset: 0 }), 'Search deals, companies, contacts…'),
    selectInput([{ value: 'me', label: 'My deals' }, ...store.meta.users.map((u) => ({ value: u.id, label: u.name }))], state.owner_id, (v) => go({ owner_id: v }), { placeholder: 'All owners' }),
    state.mode === 'list' ? selectInput([{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }], state.status, (v) => go({ status: v, offset: 0 }), { placeholder: 'Any status' }) : null);

  if (state.mode === 'list') {
    const data = await GET(`/deals${qs({ q: state.q, owner_id: state.owner_id, status: state.status, sort: state.sort, offset: state.offset, limit: 50 })}`);
    el.append(header, toolbar,
      dataTable({
        rows: data.deals,
        sort: state.sort,
        onSort: (sort) => go({ sort }),
        onRowClick: (r) => navigate(`#/deals/${r.id}`),
        columns: [
          { label: 'Deal', sort: 'title', render: (r) => h('a', { class: 'strong', href: `#/deals/${r.id}` }, r.title) },
          { label: 'Value', sort: 'value', cls: 'num', render: (r) => money(r.value) },
          { label: 'Stage', sort: 'stage', render: (r) => h('span', null, pill(r.status, STATUS_TONE[r.status]), muted(` ${r.stage_name || ''}`)) },
          { label: 'Company', render: (r) => (r.company_id ? h('a', { href: `#/companies/${r.company_id}` }, r.company_name) : muted('—')) },
          { label: 'Contact', cls: 'hide-md', render: (r) => (r.contact_id ? h('a', { href: `#/contacts/${r.contact_id}` }, r.contact_name) : muted('—')) },
          { label: 'Expected close', sort: 'expected_close', cls: 'hide-md', render: (r) => date(r.expected_close) },
          { label: 'Owner', key: 'owner_name', cls: 'hide-lg' },
        ],
        empty: emptyState({ iconName: 'kanban', title: 'No deals found', text: 'Create a deal or change the filters.' }),
      }),
      pager({ total: data.total, limit: data.limit, offset: data.offset, onChange: (offset) => go({ offset }) }));
    return;
  }

  const { stages } = await GET(`/deals/board${qs({ q: state.q, owner_id: state.owner_id })}`);
  const openStages = stages.filter((s) => s.kind === 'open');
  const openValue = openStages.reduce((s, x) => s + x.total_value, 0);
  const openCount = openStages.reduce((s, x) => s + x.count, 0);
  header.querySelector('.page-title').append(h('p', { class: 'subtitle' }, `${num(openCount)} open deals · ${money(openValue)} in pipeline`));

  const byId = new Map(stages.flatMap((s) => s.deals.map((d) => [d.id, d])));
  const board = h('div', { class: 'kanban', role: 'list' }, stages.map((s) => {
    const list = h('div', { class: 'kcol-list' }, s.deals.map((d) => dealCard(d)));
    const totalEl = h('span', { class: 'kcol-total' }, money(s.total_value, { compact: true }));
    const countEl = h('span', { class: 'count' }, num(s.count));
    const col = h('section', { class: `kcol kcol-${s.kind}`, role: 'listitem', 'aria-label': s.name },
      h('header', { class: 'kcol-head' }, h('div', null, h('b', null, s.name), countEl), totalEl,
        h('div', { class: 'kcol-prob muted small' }, s.kind === 'open' ? `${s.probability}% probability` : s.kind === 'won' ? 'Closed won (90 days)' : 'Closed lost (90 days)')),
      list,
      s.kind === 'open' ? h('button', { class: 'kcol-add', type: 'button', onclick: () => openDealForm({ defaults: { stage_id: s.id }, onSaved: refresh }) }, icon('plus'), 'Add deal') : null);
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const deal = byId.get(Number(e.dataTransfer.getData('text/plain')));
      if (!deal || deal.stage_id === s.id) return;
      try {
        if (await moveDeal(deal, s)) refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return col;
  }));
  el.append(header, toolbar, board);
}

function dealCard(d) {
  const overdue = d.status === 'open' && d.expected_close && new Date(d.expected_close) < new Date(new Date().toDateString());
  const c = h('article', { class: 'kcard', draggable: 'true', tabindex: '0', 'aria-label': `${d.title}, ${money(d.value)}` },
    h('div', { class: 'kcard-title' }, d.title),
    h('div', { class: 'kcard-sub muted small' }, d.company_name || d.contact_name || 'No company'),
    h('div', { class: 'kcard-foot' },
      h('b', null, money(d.value, { compact: true })),
      d.expected_close ? h('span', { class: `small ${overdue ? 'text-danger' : 'muted'}` }, icon('calendar'), date(d.expected_close)) : null,
      d.owner_name ? avatar(d.owner_name, 'xs') : null));
  c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(d.id)); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
  c.addEventListener('dragend', () => c.classList.remove('dragging'));
  c.addEventListener('click', () => navigate(`#/deals/${d.id}`));
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(`#/deals/${d.id}`); });
  return c;
}

export async function dealDetailView(el, { id }) {
  const [data, tl] = await Promise.all([GET(`/deals/${id}`), GET(`/timeline?deal_id=${id}`)]);
  const d = data.deal;
  const stages = store.meta.stages;
  const current = stages.findIndex((s) => s.id === d.stage_id);

  const path = h('div', { class: 'stage-path', role: 'list' }, stages.map((s, i) => h('button', {
    type: 'button', role: 'listitem',
    class: `stage-step ${s.id === d.stage_id ? 'current' : ''} ${i < current && s.kind === 'open' ? 'past' : ''} stage-${s.kind}`,
    title: `Move to ${s.name}`,
    onclick: async () => { if (s.id !== d.stage_id && await moveDeal(d, s).catch((e) => toast(e.message, 'error'))) refresh(); },
  }, s.name)));

  const more = dropdownMenu(btn('', { iconName: 'more', title: 'More actions' }), [
    { label: 'Edit deal', icon: 'edit', onClick: () => openDealForm({ deal: d, onSaved: refresh }) },
    { label: 'Delete deal', icon: 'trash', danger: true, onClick: async () => {
      if (!await confirmDialog(`Delete “${d.title}”?`, { danger: true, confirmLabel: 'Delete' })) return;
      await DEL(`/deals/${d.id}`);
      toast('Deal deleted');
      navigate('#/deals');
    } },
  ]);
  const contactForEmail = d.contact_id ? { id: d.contact_id, full_name: d.contact_name, email: d.contact_email } : null;

  el.append(
    pageHeader(d.title, {
      back: { href: '#/deals', label: 'Deals' },
      subtitle: `${money(d.value)} · ${d.stage_name}${d.status !== 'open' ? ` · closed ${date(d.closed_at)}` : ''}`,
      actions: [
        contactForEmail?.email ? btn('Email contact', { iconName: 'mail', onClick: () => openComposer({ contact: contactForEmail, deal: d, onSent: refresh }) }) : null,
        btn('Task', { iconName: 'task', onClick: () => openActivityForm({ type: 'task', deal: d, contact: contactForEmail, onSaved: refresh }) }),
        btn('Edit', { iconName: 'edit', onClick: () => openDealForm({ deal: d, onSaved: refresh }) }),
        more,
      ],
    }),
    path,
    h('div', { class: 'detail' },
      h('div', { class: 'detail-side' },
        card('Details', kv([
          ['Status', pill(d.status, STATUS_TONE[d.status])],
          ['Value', h('b', null, money(d.value))],
          ['Win probability', `${d.probability ?? d.stage_probability ?? 0}%`],
          ['Contact', d.contact_id ? h('a', { href: `#/contacts/${d.contact_id}` }, d.contact_name) : null],
          ['Company', d.company_id ? h('a', { href: `#/companies/${d.company_id}` }, d.company_name) : null],
          ['Owner', d.owner_name],
          ['Expected close', date(d.expected_close)],
          ['Source', d.source],
          d.lost_reason ? ['Lost reason', d.lost_reason] : null,
          ['Tags', tagList(d.tags)],
          ['In stage since', d.stage_changed_at ? ago(d.stage_changed_at) : null],
          ['Created', date(d.created_at)],
        ])),
        d.description ? card('Description', h('p', { class: 'notes' }, d.description)) : null,
        card(`Open tasks (${data.tasks.length})`, data.tasks.length
          ? timelineView(data.tasks.map((t) => ({ kind: 'activity', date: t.due_at || t.created_at, ...t })), { onToggleTask: async (t, done) => { await POST(`/activities/${t.id}/complete`, { done }); refresh(); } })
          : muted('No open tasks.'))),
      h('div', { class: 'detail-main' },
        card('Activity', timelineView(tl.items, { onOpenEmail: openEmailViewer, onToggleTask: async (t, done) => { await POST(`/activities/${t.id}/complete`, { done }); refresh(); } }),
          { actions: btn('Log activity', { small: true, ghost: true, iconName: 'plus', onClick: () => openActivityForm({ deal: d, contact: contactForEmail, onSaved: refresh }) }) }))));
}
