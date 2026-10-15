import { h, GET, POST, store, money, num, pct, ratio, date, ago, toast } from '../core.js';
import { pageHeader, segmented, statTile, card, barChart, columnChart, timelineView, emptyState, btn, muted, pill } from '../components.js';
import { openActivityForm } from '../forms.js';

let owner = 'all';

function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

export async function dashboardView(el) {
  const d = await GET(`/dashboard?owner=${owner}`);
  const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
  const first = store.user.name.split(' ')[0];

  const e = d.email_30d;
  const tiles = h('div', { class: 'stats' },
    statTile('Open pipeline', money(d.open_pipeline.value, { compact: true }), `${num(d.open_pipeline.count)} deals · ${money(d.open_pipeline.weighted, { compact: true })} weighted`, { iconName: 'kanban' }),
    statTile('Won this month', money(d.won_this_month.value, { compact: true }), `${num(d.won_this_month.count)} deal${d.won_this_month.count === 1 ? '' : 's'} closed`, { iconName: 'dollar' }),
    statTile('Win rate (90 days)', pct(d.win_rate), `${num(d.closed_90d.won)} won · ${num(d.closed_90d.lost)} lost`, { iconName: 'target' }),
    statTile('New contacts (30 days)', num(d.contacts.new_30d), `${num(d.contacts.total)} contacts in total`, { iconName: 'users' }),
    statTile('Email replies (30 days)', pct(ratio(e.replied, e.sent)), `${num(e.sent)} sent · ${pct(ratio(e.opened, e.sent))} opened`, { iconName: 'mail' }));

  const pipelineBody = d.pipeline.some((s) => s.count)
    ? barChart(d.pipeline.map((s) => ({ label: s.name, value: s.value, count: s.count })), { format: (v) => money(v, { compact: true }), detail: (x) => `${num(x.count)} deal${x.count === 1 ? '' : 's'}` })
    : emptyState({ iconName: 'kanban', title: 'No open deals yet', text: 'Deals you add appear here grouped by stage.', action: btn('Open pipeline', { small: true, onClick: () => { location.hash = '#/deals'; } }) });

  const wonBody = d.won_by_month.every((m) => !m.value) ? emptyState({ iconName: 'dollar', title: 'No won deals yet', text: 'Revenue from deals marked Won shows here by month.' }) : columnChart(d.won_by_month.map((m) => ({ label: m.label, value: m.value, count: m.count })), {
    format: (v) => money(v, { compact: true }), detail: (x) => `${num(x.count)} won`,
  });

  const tasksBody = d.my_tasks.length
    ? h('ul', { class: 'task-mini' }, d.my_tasks.map((t) => {
      const overdue = t.due_at && new Date(t.due_at) < new Date();
      const cb = h('input', { type: 'checkbox', 'aria-label': `Complete ${t.subject}` });
      cb.addEventListener('change', async () => {
        await POST(`/activities/${t.id}/complete`, { done: true });
        toast('Task completed');
        refresh();
      });
      return h('li', null, cb, h('div', null,
        h('div', { class: 'task-mini-title' }, t.subject),
        h('div', { class: 'muted small' }, t.contact_name ? h('a', { href: `#/contacts/${t.contact_id}` }, t.contact_name) : null, t.contact_name ? ' · ' : '',
          h('span', { class: overdue ? 'text-danger' : '' }, t.due_at ? (overdue ? `Overdue · ${ago(t.due_at)}` : `Due ${ago(t.due_at)}`) : 'No due date'))));
    }))
    : emptyState({ iconName: 'task', title: 'You’re all caught up', text: 'No open tasks assigned to you.' });

  const closingBody = d.closing_soon.length
    ? h('ul', { class: 'deal-mini' }, d.closing_soon.map((x) => h('li', null,
      h('a', { href: `#/deals/${x.id}` }, x.title),
      h('span', { class: 'muted small' }, `${x.stage_name} · closes ${date(x.expected_close)}`),
      h('b', null, money(x.value, { compact: true })))))
    : muted('No open deals with a close date in the next 30 days.');

  const sourcesBody = d.sources.length
    ? barChart(d.sources.map((s) => ({ label: s.source, value: s.count })), { format: num, detail: () => 'contacts' })
    : muted('No contacts yet.');

  el.append(
    pageHeader(`${greeting()}, ${first}`, {
      subtitle: `Here’s what’s happening at ${store.settings.company?.name || 'your company'}.`,
      actions: [
        segmented([{ value: 'me', label: 'Mine' }, { value: 'all', label: 'Everyone' }], owner, (v) => { owner = v; refresh(); }),
        btn('Log activity', { iconName: 'plus', onClick: () => openActivityForm({ onSaved: refresh }) }),
      ],
    }),
    d.tasks.overdue ? h('a', { class: 'banner banner-warn', href: '#/tasks?view=overdue' }, `You have ${num(d.tasks.overdue)} overdue task${d.tasks.overdue === 1 ? '' : 's'}`, muted(' — review now →')) : null,
    tiles,
    h('div', { class: 'grid-2' },
      card('Open pipeline by stage', pipelineBody, { actions: h('a', { href: '#/deals', class: 'link' }, 'View board') }),
      card('Won revenue, last 6 months', wonBody)),
    h('div', { class: 'grid-3' },
      card(`My tasks${d.tasks.today ? ` · ${d.tasks.today} today` : ''}`, tasksBody, { actions: h('a', { href: '#/tasks', class: 'link' }, 'All tasks') }),
      card('Closing in the next 30 days', closingBody),
      card('Lead sources', sourcesBody)),
    card('Recent activity', timelineView(d.recent.map((a) => ({ kind: 'activity', date: a.created_at, ...a })), { showContact: true }),
      { actions: d.active_enrollments ? h('span', null, pill(`${d.active_enrollments} in active sequences`, 'blue')) : null }),
  );
}
