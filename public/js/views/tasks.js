import { h, icon, GET, POST, DEL, store, qs, num, dateTime, ago, toast, confirmDialog } from '../core.js';
import { pageHeader, tabs, segmented, searchInput, btn, iconBtn, muted, pill, emptyState } from '../components.js';
import { openActivityForm } from '../forms.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const state = { view: 'open', who: 'me', q: '' };
const PRIORITY_TONE = { high: 'red', normal: 'slate', low: 'slate' };

export async function tasksView(el, params, query) {
  if (query.view) state.view = query.view;
  const assigned = state.who === 'me' ? 'me' : '';
  const base = { assigned_to: assigned, q: state.q };
  const [list, overdue, today, upcoming] = await Promise.all([
    GET(`/tasks${qs({ ...base, view: state.view })}`),
    GET(`/tasks${qs({ ...base, view: 'overdue', limit: 1 })}`),
    GET(`/tasks${qs({ ...base, view: 'today', limit: 1 })}`),
    GET(`/tasks${qs({ ...base, view: 'upcoming', limit: 1 })}`),
  ]);
  const go = (patch) => { Object.assign(state, patch); if (patch.view) history.replaceState(null, '', '#/tasks'); refresh(); };

  const rows = list.tasks.map((t) => {
    const isOverdue = !t.done && t.due_at && new Date(t.due_at) < new Date();
    const cb = h('input', { type: 'checkbox', checked: t.done, 'aria-label': `Mark ${t.subject} done` });
    cb.addEventListener('change', async () => {
      await POST(`/activities/${t.id}/complete`, { done: cb.checked });
      toast(cb.checked ? 'Task completed' : 'Task reopened');
      refresh();
    });
    return h('li', { class: `task-row ${t.done ? 'done' : ''}` },
      cb,
      h('div', { class: 'task-main' },
        h('div', { class: 'task-title' }, t.subject || 'Untitled task', t.priority === 'high' ? pill('high', PRIORITY_TONE.high) : null),
        t.body ? h('div', { class: 'muted small clamp-2' }, t.body) : null,
        h('div', { class: 'muted small' },
          t.contact_id ? [icon('user'), h('a', { href: `#/contacts/${t.contact_id}` }, t.contact_name), '  '] : null,
          t.deal_id ? [icon('kanban'), h('a', { href: `#/deals/${t.deal_id}` }, t.deal_title), '  '] : null,
          state.who !== 'me' && t.assigned_name ? `→ ${t.assigned_name}` : null)),
      h('div', { class: `task-due ${isOverdue ? 'text-danger' : 'muted'}`, title: t.due_at ? dateTime(t.due_at) : '' },
        t.done ? `Done ${ago(t.done_at)}` : t.due_at ? (isOverdue ? `Overdue ${ago(t.due_at)}` : dateTime(t.due_at)) : 'No due date'),
      h('div', { class: 'task-actions' },
        iconBtn('edit', 'Edit task', () => openActivityForm({ activity: t, type: 'task', onSaved: refresh })),
        iconBtn('trash', 'Delete task', async () => {
          if (!await confirmDialog('Delete this task?', { danger: true, confirmLabel: 'Delete' })) return;
          await DEL(`/activities/${t.id}`);
          refresh();
        })));
  });

  el.append(
    pageHeader('Tasks', {
      actions: [
        segmented([{ value: 'me', label: 'Mine' }, { value: 'all', label: 'Everyone' }], state.who, (who) => go({ who })),
        btn('New task', { primary: true, iconName: 'plus', onClick: () => openActivityForm({ type: 'task', onSaved: refresh }) }),
      ],
    }),
    h('div', { class: 'toolbar' },
      tabs([
        { id: 'overdue', label: 'Overdue', count: overdue.total },
        { id: 'today', label: 'Today', count: today.total },
        { id: 'upcoming', label: 'Upcoming', count: upcoming.total },
        { id: 'open', label: 'All open' },
        { id: 'done', label: 'Completed' },
      ], state.view, (view) => go({ view })),
      h('span', { class: 'grow' }),
      searchInput(state.q, (q) => go({ q }), 'Search tasks…')),
    rows.length
      ? h('ul', { class: 'task-list card' }, rows)
      : emptyState({ iconName: 'task', title: state.view === 'overdue' ? 'Nothing overdue' : 'No tasks here', text: 'Tasks also get created automatically by sequence steps.' }),
    list.total > list.tasks.length ? muted(`Showing ${num(list.tasks.length)} of ${num(list.total)}`) : null);
}
