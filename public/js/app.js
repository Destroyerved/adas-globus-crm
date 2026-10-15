import {
  h, append, clear, icon, GET, POST, store, loadMeta, route, matchRoute, currentPath, navigate, debounce, toast, toastError, busy, isAdmin,
} from './core.js';
import { avatar, btn, loading, errorBlock, muted, dropdownMenu } from './components.js';
import { openContactForm, openCompanyForm, openDealForm, openActivityForm, openComposer } from './forms.js';
import { dashboardView } from './views/dashboard.js';
import { contactsView, contactDetailView } from './views/contacts.js';
import { companiesView, companyDetailView } from './views/companies.js';
import { dealsView, dealDetailView } from './views/deals.js';
import { tasksView } from './views/tasks.js';
import { emailsView, templatesView, campaignsView, campaignDetailView, sequencesView, sequenceDetailView } from './views/outreach.js';
import { prospectingView } from './views/prospecting.js';
import { integrationsView } from './views/integrations.js';
import { settingsView } from './views/settings.js';

// ---------- theme ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('agp-theme')); } catch { /* storage blocked */ }
function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('agp-theme', next); } catch { /* ignore */ }
}

// ---------- routes ----------
route('/dashboard', dashboardView);
route('/contacts', contactsView);
route('/contacts/:id', contactDetailView);
route('/companies', companiesView);
route('/companies/:id', companyDetailView);
route('/deals', dealsView);
route('/deals/:id', dealDetailView);
route('/tasks', tasksView);
route('/emails', emailsView);
route('/templates', templatesView);
route('/campaigns', campaignsView);
route('/campaigns/:id', campaignDetailView);
route('/sequences', sequencesView);
route('/sequences/:id', sequenceDetailView);
route('/prospecting', prospectingView);
route('/integrations', integrationsView);
route('/integrations/:tab', integrationsView);
route('/settings', settingsView);
route('/settings/:tab', settingsView);

const NAV = [
  { items: [{ path: '/dashboard', label: 'Dashboard', icon: 'dashboard' }] },
  { group: 'CRM', items: [
    { path: '/contacts', label: 'Contacts', icon: 'users' },
    { path: '/companies', label: 'Companies', icon: 'building' },
    { path: '/deals', label: 'Deals', icon: 'kanban' },
    { path: '/tasks', label: 'Tasks', icon: 'task' },
  ] },
  { group: 'Outreach', items: [
    { path: '/emails', label: 'Emails', icon: 'inbox' },
    { path: '/sequences', label: 'Sequences', icon: 'sequence' },
    { path: '/campaigns', label: 'Campaigns', icon: 'send' },
    { path: '/templates', label: 'Templates', icon: 'template' },
  ] },
  { group: 'Growth', items: [
    { path: '/prospecting', label: 'Prospecting', icon: 'target', hint: 'Apollo' },
    { path: '/integrations', label: 'Integrations', icon: 'plug', hint: 'n8n' },
  ] },
  { items: [{ path: '/settings', label: 'Settings', icon: 'settings' }] },
];

const root = document.getElementById('app');
let viewEl;
let sidebarEl;

// ---------- auth screens ----------
function authScreen(content) {
  clear(root).append(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'brand brand-lg' }, h('span', { class: 'brand-mark' }, 'AG'), h('span', null, store.settings.company?.name || 'Adas Globus Pro', h('small', null, 'CRM'))),
      content)));
}

function loginScreen() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const submit = btn('Sign in', { primary: true, type: 'submit' });
  const form = h('form', { class: 'auth-form' },
    h('h1', null, 'Sign in'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Email'), email),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Password'), password),
    submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(submit, async () => {
      const { user } = await POST('/auth/login', { email: email.value, password: password.value });
      store.user = user;
      await boot();
    });
  });
  authScreen(form);
  email.focus();
}

function setupScreen() {
  const f = {
    company: h('input', { class: 'input', value: store.settings.company?.name || 'Adas Globus Pro' }),
    name: h('input', { class: 'input', autocomplete: 'name', required: true }),
    email: h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true }),
    password: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true }),
  };
  const submit = btn('Create admin account', { primary: true, type: 'submit' });
  const form = h('form', { class: 'auth-form' },
    h('h1', null, 'Welcome! Let’s set up your CRM'),
    h('p', { class: 'muted' }, 'This creates the first admin account. You can invite your team afterwards.'),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Company name'), f.company),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Your name'), f.name),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Work email'), f.email),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Password (8+ characters)'), f.password),
    submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(submit, async () => {
      const { user } = await POST('/auth/setup', { company_name: f.company.value, name: f.name.value, email: f.email.value, password: f.password.value });
      store.user = user;
      location.hash = '#/dashboard';
      await boot();
    });
  });
  authScreen(form);
  f.name.focus();
}

// ---------- shell ----------
function globalSearch() {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search contacts, companies, deals…  ( / )', 'aria-label': 'Search' });
  const results = h('div', { class: 'search-results', hidden: true });
  let first = null;
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    const r = await GET(`/search?q=${encodeURIComponent(q)}`).catch(() => null);
    if (!r) return;
    first = null;
    const section = (title, rows, render) => (rows.length ? [h('div', { class: 'sr-head' }, title), rows.map((row) => {
      const [href, label, sub, ico] = render(row);
      first = first || href;
      return h('a', { class: 'sr-item', href, onclick: () => { results.hidden = true; input.value = ''; } }, icon(ico), h('span', null, h('b', null, label), sub ? muted(` ${sub}`) : null));
    })] : []);
    results.replaceChildren(...[
      ...section('Contacts', r.contacts, (c) => [`#/contacts/${c.id}`, c.full_name, [c.email, c.company_name].filter(Boolean).join(' · '), 'user']),
      ...section('Companies', r.companies, (c) => [`#/companies/${c.id}`, c.name, c.domain, 'building']),
      ...section('Deals', r.deals, (d) => [`#/deals/${d.id}`, d.title, d.stage_name, 'kanban']),
    ].flat());
    if (!results.children.length) results.append(h('div', { class: 'sr-empty' }, 'No results'));
    results.hidden = false;
  }, 200);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && first) { location.hash = first; results.hidden = true; input.value = ''; input.blur(); }
    if (e.key === 'Escape') { results.hidden = true; input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 200));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select, [contenteditable]')) { e.preventDefault(); input.focus(); }
  });
  return h('div', { class: 'global-search' }, icon('search'), input, results);
}

const dropdown = dropdownMenu;

function shell() {
  sidebarEl = h('aside', { class: 'sidebar' },
    h('a', { class: 'brand', href: '#/dashboard' }, h('span', { class: 'brand-mark' }, 'AG'), h('span', null, store.settings.company?.name || 'CRM', h('small', null, 'CRM'))),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map((g) => h('div', { class: 'nav-group' },
      g.group ? h('div', { class: 'nav-title' }, g.group) : null,
      g.items.map((it) => h('a', { class: 'nav-item', href: `#${it.path}`, dataset: { path: it.path } }, icon(it.icon), h('span', null, it.label), it.hint ? h('span', { class: 'nav-hint' }, it.hint) : null))))),
    h('div', { class: 'sidebar-foot' }, muted(`${store.settings.company?.name || ''} · v1.0`)));

  const newBtn = btn('New', { primary: true, iconName: 'plus' });
  const goTo = (base) => (rec) => rec && navigate(`#/${base}/${rec.id}`);
  const newMenu = dropdown(newBtn, [
    { label: 'Contact', icon: 'user', onClick: () => openContactForm({ onSaved: goTo('contacts') }) },
    { label: 'Company', icon: 'building', onClick: () => openCompanyForm({ onSaved: goTo('companies') }) },
    { label: 'Deal', icon: 'kanban', onClick: () => openDealForm({ onSaved: goTo('deals') }) },
    { label: 'Task', icon: 'task', onClick: () => openActivityForm({ type: 'task', onSaved: () => navigate('#/tasks') }) },
    { label: 'Email', icon: 'mail', onClick: () => openComposer({}) },
  ]);
  const userBtn = h('button', { class: 'user-btn', type: 'button', 'aria-label': 'Account menu' }, avatar(store.user.name, 'sm'), h('span', { class: 'user-name' }, store.user.name), icon('chevronDown'));
  const userMenu = dropdown(userBtn, [
    { label: 'My profile', icon: 'user', onClick: () => navigate('#/settings/profile') },
    { label: 'Toggle dark mode', icon: 'eye', onClick: toggleTheme },
    '-',
    { label: 'Sign out', icon: 'logout', onClick: async () => { await POST('/auth/logout').catch(() => {}); store.user = null; location.hash = '#/login'; boot(); } },
  ]);
  const menuBtn = h('button', { class: 'icon-btn menu-toggle', type: 'button', 'aria-label': 'Open menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu'));
  viewEl = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  clear(root).append(h('div', { class: 'app' },
    sidebarEl,
    h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }),
    h('div', { class: 'main' }, h('header', { class: 'topbar' }, menuBtn, globalSearch(), h('div', { class: 'topbar-actions' }, newMenu, userMenu)), viewEl)));
}

let renderToken = 0;
async function render() {
  // Hash changes during sign-in/setup fire before the shell exists; boot() renders once it is built.
  if (!store.user || !sidebarEl?.isConnected) return;
  const { path, query } = currentPath();
  if (path === '/login' || path === '/') { location.hash = '#/dashboard'; return; }
  document.body.classList.remove('nav-open');
  for (const a of sidebarEl.querySelectorAll('.nav-item')) a.classList.toggle('active', path === a.dataset.path || path.startsWith(`${a.dataset.path}/`));
  const m = matchRoute(path);
  const token = ++renderToken;
  clear(viewEl).append(loading());
  if (!m) { clear(viewEl).append(errorBlock(new Error('Page not found'))); return; }
  try {
    const container = h('div', { class: 'view-inner' });
    // Views build pages with conditional pieces; skip null/false children instead of printing "null".
    container.append = (...kids) => append(container, kids);
    await m.handler(container, m.params, query);
    if (token !== renderToken) return; // a newer navigation won
    clear(viewEl).append(container);
    viewEl.scrollTop = 0;
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    clear(viewEl).append(errorBlock(err, render));
  }
}
// Views call this after a change to redraw the current page in place.
window.addEventListener('crm:refresh', render);
window.addEventListener('hashchange', render);

async function boot() {
  try {
    const status = await GET('/auth/status');
    store.settings.company = { ...(store.settings.company || {}), name: status.company };
    if (status.needs_setup) return setupScreen();
    const { user } = await GET('/auth/me').catch(() => ({ user: null }));
    if (!user) return loginScreen();
    store.user = user;
    await loadMeta();
    shell();
    if (!location.hash || location.hash === '#/login') location.hash = '#/dashboard';
    await render();
    if (isAdmin() && !store.settings.smtp?.host && !store.settings.smtp?.dry_run && !sessionStorageGet('smtp-nudge')) {
      sessionStorageSet('smtp-nudge', '1');
      toast('Tip: connect your mailbox under Integrations → Email to start sending.');
    }
  } catch (err) {
    toastError(err);
    clear(root).append(errorBlock(err, boot));
  }
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

boot();
