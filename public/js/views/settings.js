import {
  h, GET, POST, PUT, PATCH, DEL, store, loadMeta, num, date, ago, cap, toast, modal, confirmDialog, busy, isAdmin, canManage, navigate,
} from '../core.js';
import { pageHeader, tabs, btn, iconBtn, muted, pill, card, emptyState, dataTable, formFields, richEditor, avatar, selectInput } from '../components.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

const TABS = [
  { id: 'company', label: 'Company', admin: true },
  { id: 'pipeline', label: 'Pipeline', manager: true },
  { id: 'users', label: 'Team', admin: true },
  { id: 'email', label: 'Email sending', admin: true },
  { id: 'suppressions', label: 'Unsubscribes', manager: true },
  { id: 'profile', label: 'My profile' },
];

export async function settingsView(el, { tab } = {}) {
  const visible = TABS.filter((t) => (t.admin ? isAdmin() : t.manager ? canManage() : true));
  const active = visible.find((t) => t.id === tab)?.id || visible[0].id;
  const body = h('div', { class: 'tab-body' });
  el.append(pageHeader('Settings'), tabs(visible, active, (t) => navigate(`#/settings/${t}`)), body);
  await ({ company: companyTab, pipeline: pipelineTab, users: usersTab, email: emailRulesTab, suppressions: suppressionsTab, profile: profileTab }[active])(body);
}

async function saveSection(section, values) {
  const r = await PUT(`/settings/${section}`, values);
  await loadMeta();
  toast('Settings saved');
  return r;
}

const TIMEZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'America/New_York']; }
})();
const CURRENCIES = ['USD', 'INR', 'AED', 'EUR', 'GBP', 'SAR', 'SGD', 'AUD', 'CAD', 'JPY', 'CNY', 'ZAR'];

async function companyTab(el) {
  const s = store.settings.company;
  const f = formFields([
    { name: 'name', label: 'Company name', required: true },
    { name: 'website', label: 'Website' },
    { name: 'phone', label: 'Phone' },
    { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES.includes(s.currency) ? CURRENCIES : [s.currency, ...CURRENCIES] },
    { name: 'timezone', label: 'Time zone (used for business-hours sending)', type: 'select', options: TIMEZONES },
    { name: 'address', label: 'Postal address (shown in email footers, required by anti-spam laws)', span: 2 },
  ], s);
  el.append(card('Company profile', h('div', { class: 'stack' }, f.el,
    btn('Save', { primary: true, onClick: (e) => busy(e.currentTarget, async () => { if (f.validate()) { await saveSection('company', f.values()); refresh(); } }) }))));
}

async function pipelineTab(el) {
  const { stages } = await GET('/stages');
  const rows = stages.map((s, i) => {
    const name = h('input', { class: 'input', value: s.name, 'aria-label': 'Stage name' });
    const prob = h('input', { class: 'input input-xs', type: 'number', min: 0, max: 100, value: s.probability, 'aria-label': 'Probability' });
    const kind = selectInput([{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }], s.kind, () => {});
    const save = async () => {
      await PATCH(`/stages/${s.id}`, { name: name.value, probability: Number(prob.value), kind: kind.value });
      await loadMeta();
      toast('Stage saved');
    };
    [name, prob].forEach((x) => x.addEventListener('change', save));
    kind.addEventListener('change', save);
    const move = async (dir) => {
      const ids = stages.map((x) => x.id);
      const [x] = ids.splice(i, 1);
      ids.splice(i + dir, 0, x);
      await POST('/stages/reorder', { ids });
      await loadMeta();
      refresh();
    };
    return h('li', { class: 'stage-row' },
      h('span', { class: 'stage-pos' }, i + 1), name,
      h('span', { class: 'row-gap' }, prob, muted('%')), kind,
      muted(`${num(s.deal_count)} deals`),
      iconBtn('arrowUp', 'Move up', i > 0 ? () => move(-1) : null),
      iconBtn('chevronDown', 'Move down', i < stages.length - 1 ? () => move(1) : null),
      iconBtn('trash', 'Delete stage', async () => {
        let moveTo = '';
        if (s.deal_count) {
          const others = stages.filter((x) => x.id !== s.id);
          const sel = selectInput(others.map((x) => ({ value: x.id, label: x.name })), others[0]?.id, () => {});
          const ok = await new Promise((resolve) => modal({
            title: `Delete “${s.name}”`,
            body: h('div', { class: 'stack' }, h('p', null, `${s.deal_count} deal(s) are in this stage. Move them to:`), sel),
            actions: [{ label: 'Cancel', onClick: ({ close }) => { resolve(false); close(); } }, { label: 'Delete stage', danger: true, onClick: ({ close }) => { moveTo = sel.value; resolve(true); close(); } }],
            onClose: () => resolve(false),
          }));
          if (!ok) return;
        } else if (!await confirmDialog(`Delete stage “${s.name}”?`, { danger: true, confirmLabel: 'Delete' })) return;
        await DEL(`/stages/${s.id}${moveTo ? `?move_to=${moveTo}` : ''}`);
        await loadMeta();
        refresh();
      }));
  });
  el.append(card('Deal pipeline', h('div', { class: 'stack' },
    muted('Rename stages, set the win probability used for weighted pipeline, and mark which stages close a deal as won or lost. Changes save automatically.'),
    h('ol', { class: 'stage-list' }, rows),
    btn('Add stage', { iconName: 'plus', onClick: async () => {
      await POST('/stages', { name: 'New stage', probability: 50, kind: 'open' });
      await loadMeta();
      refresh();
    } }))));
}

async function usersTab(el) {
  const { users } = await GET('/users');
  const openUser = (u) => {
    const f = formFields([
      { name: 'name', label: 'Full name', required: true },
      { name: 'email', label: 'Email', type: 'email', required: !u },
      { name: 'role', label: 'Role', type: 'select', options: [{ value: 'admin', label: 'Admin: everything incl. integrations' }, { value: 'manager', label: 'Manager: CRM + campaigns + pipeline' }, { value: 'sales', label: 'Sales: CRM, email, sequences' }] },
      { name: 'password', label: u ? 'New password (leave blank to keep)' : 'Temporary password (8+ chars)', type: 'password', autocomplete: 'new-password', required: !u },
      u ? { name: 'active', label: 'Active (can sign in)', type: 'checkbox' } : null,
    ].filter(Boolean), u || { role: 'sales' });
    if (u) f.inputs.email.input.disabled = true;
    modal({
      title: u ? `Edit ${u.name}` : 'Add team member',
      body: h('div', { class: 'stack' }, f.el, u ? null : muted('Share the email and temporary password with them; they can change it under My profile.')),
      actions: [{ label: 'Cancel' }, {
        label: u ? 'Save' : 'Add user', primary: true, onClick: async ({ close }) => {
          if (!f.validate()) return;
          const v = f.values();
          if (!v.password) delete v.password;
          if (u) { delete v.email; await PATCH(`/users/${u.id}`, v); } else await POST('/users', v);
          await loadMeta();
          toast('Saved');
          close();
          refresh();
        },
      }],
    });
  };
  el.append(card('Team', dataTable({
    rows: users,
    onRowClick: openUser,
    columns: [
      { label: 'Name', render: (u) => h('div', { class: 'cell-person' }, avatar(u.name), h('div', null, h('b', null, u.name), h('div', { class: 'muted small' }, u.email))) },
      { label: 'Role', render: (u) => pill(u.role, { admin: 'violet', manager: 'blue', sales: 'slate' }[u.role]) },
      { label: 'Status', render: (u) => pill(u.active ? 'active' : 'deactivated', u.active ? 'green' : 'red') },
      { label: 'Last sign-in', render: (u) => (u.last_login_at ? ago(u.last_login_at) : muted('Never')) },
      { label: 'Added', cls: 'hide-md', render: (u) => date(u.created_at) },
    ],
  }), { actions: btn('Add team member', { primary: true, small: true, iconName: 'plus', onClick: () => openUser(null) }) }));
}

async function emailRulesTab(el) {
  const { settings } = await GET('/settings');
  const m = settings.mail;
  const days = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
  const dayBoxes = days.map(([v, label]) => {
    const cb = h('input', { type: 'checkbox', checked: m.business_days.map(String).includes(v) });
    return { v, cb, el: h('label', { class: 'chip-check' }, cb, h('span', null, label)) };
  });
  const f = formFields([
    { name: 'tracking', label: 'Track opens and link clicks', type: 'checkbox', span: 2 },
    { name: 'rate_per_minute', label: 'Max emails per minute (campaigns)', type: 'number', min: 1, max: 500 },
    { name: 'business_start', label: 'Business hours start (0–23)', type: 'number', min: 0, max: 23 },
    { name: 'business_end', label: 'Business hours end (1–24)', type: 'number', min: 1, max: 24 },
  ], m);
  const footer = richEditor({ value: m.footer, minHeight: 100, variables: ['my_company', 'my_address', 'my_address_line', 'my_website', 'unsubscribe_url'] });
  el.append(card('Email sending rules', h('div', { class: 'stack' },
    f.el,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Sequence sending days'), h('div', { class: 'chip-group' }, dayBoxes.map((d) => d.el))),
    muted(`Times use the company time zone (${store.settings.company?.timezone}). Sequences with “business hours only” wait for the next open window.`),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Footer for campaign & sequence emails'), footer.el,
      h('span', { class: 'help' }, 'Must contain {{unsubscribe_url}}. Not added to one-off emails you write by hand.')),
    btn('Save', { primary: true, onClick: (e) => busy(e.currentTarget, async () => {
      const v = f.values();
      v.business_days = dayBoxes.filter((d) => d.cb.checked).map((d) => Number(d.v));
      v.footer = footer.getValue();
      if (v.footer && !v.footer.includes('unsubscribe_url')) return toast('The footer must include {{unsubscribe_url}}', 'error');
      await saveSection('mail', v);
    }) }))));
}

async function suppressionsTab(el) {
  const { suppressions } = await GET('/suppressions');
  const input = h('input', { class: 'input', type: 'email', placeholder: 'someone@example.com' });
  el.append(card('Unsubscribes & bounces', h('div', { class: 'stack' },
    muted('These addresses never receive campaign or sequence emails. Unsubscribe links and bounce detection add to this list automatically.'),
    h('div', { class: 'row-gap' }, input, btn('Add address', { onClick: (e) => busy(e.currentTarget, async () => { await POST('/suppressions', { email: input.value, reason: 'manual' }); toast('Added'); refresh(); }) })),
    dataTable({
      rows: suppressions.map((s) => ({ ...s, id: s.email })),
      columns: [
        { label: 'Email', render: (s) => h('span', { class: 'mono' }, s.email) },
        { label: 'Reason', render: (s) => pill(s.reason, s.reason === 'bounce' ? 'red' : s.reason === 'unsubscribe' ? 'yellow' : 'slate') },
        { label: 'Since', render: (s) => date(s.created_at) },
        { label: '', render: (s) => btn('Remove', { small: true, ghost: true, onClick: async () => {
          if (!await confirmDialog(`Allow emails to ${s.email} again? Only do this if they asked to resubscribe.`, { confirmLabel: 'Remove' })) return;
          await DEL(`/suppressions/${encodeURIComponent(s.email)}`);
          refresh();
        } }) },
      ],
      empty: emptyState({ iconName: 'mail', title: 'No unsubscribes', text: 'Good news: nobody has opted out yet.' }),
    }))));
}

async function profileTab(el) {
  const me = store.user;
  const name = h('input', { class: 'input', value: me.name });
  const sig = richEditor({ value: me.signature || '', minHeight: 120, variables: [] });
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8 });
  el.append(h('div', { class: 'grid-2' },
    card('Profile', h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Email signature (insert with {{signature}})'), sig.el),
      kv([['Email', me.email], ['Role', cap(me.role)]]),
      btn('Save profile', { primary: true, onClick: (e) => busy(e.currentTarget, async () => {
        const { user } = await PATCH('/auth/me', { name: name.value, signature: sig.getValue() });
        store.user = { ...store.user, ...user };
        toast('Profile saved');
      }) }))),
    card('Change password', h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Current password'), cur),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'New password (8+ characters)'), next),
      btn('Update password', { onClick: (e) => busy(e.currentTarget, async () => {
        await PATCH('/auth/me', { current_password: cur.value, new_password: next.value });
        cur.value = ''; next.value = '';
        toast('Password updated');
      }) })))));
}

function kv(rows) {
  return h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}
