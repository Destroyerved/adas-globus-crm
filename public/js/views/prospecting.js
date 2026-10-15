import { h, icon, GET, POST, store, loadMeta, num, toast, busy, isAdmin, navigate } from '../core.js';
import { pageHeader, tabs, btn, muted, pill, card, emptyState, dataTable, selectInput } from '../components.js';

const SENIORITIES = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry'];
const EMPLOYEE_RANGES = ['1,10', '11,50', '51,200', '201,500', '501,1000', '1001,5000', '5001,10000', '10001,'];
const rangeLabel = (r) => (r.endsWith(',') ? `${r.slice(0, -1)}+` : r.replace(',', '–'));

const state = {
  tab: 'people',
  people: { person_titles: '', person_seniorities: [], person_locations: '', organization_locations: '', organization_num_employees_ranges: [], q_organization_domains_list: '', q_keywords: '', per_page: 25, page: 1 },
  orgs: { q_organization_name: '', organization_locations: '', organization_num_employees_ranges: [], q_organization_keyword_tags: '', per_page: 25, page: 1 },
  peopleResults: null,
  orgResults: null,
  selected: new Map(),
  selectedOrgs: new Map(),
  importTags: 'apollo',
  reveal: true,
};

const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

function chipGroup(options, selected, label = (x) => x) {
  return h('div', { class: 'chip-group' }, options.map((o) => {
    const cb = h('input', { type: 'checkbox', checked: selected.includes(o) });
    cb.addEventListener('change', () => {
      const i = selected.indexOf(o);
      if (cb.checked && i < 0) selected.push(o);
      if (!cb.checked && i >= 0) selected.splice(i, 1);
    });
    return h('label', { class: 'chip-check' }, cb, h('span', null, label(o)));
  }));
}

function textArea(obj, key, placeholder, rows = 3) {
  const t = h('textarea', { class: 'input', rows, placeholder }, obj[key]);
  t.addEventListener('input', () => { obj[key] = t.value; });
  return t;
}
function textInput(obj, key, placeholder) {
  const t = h('input', { class: 'input', value: obj[key], placeholder });
  t.addEventListener('input', () => { obj[key] = t.value; });
  return t;
}

export async function prospectingView(el, params, query) {
  const status = await GET('/apollo/status');
  if (query.domain) { state.people.q_organization_domains_list = query.domain; state.tab = 'people'; }
  const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

  const header = pageHeader('Prospecting', {
    subtitle: 'Search Apollo’s B2B database and import prospects straight into your CRM.',
    actions: [
      h('span', { class: 'muted small' }, `${num(status.credits_30d)} Apollo credits used in 30 days`),
      isAdmin() ? btn('Apollo settings', { iconName: 'settings', onClick: () => navigate('#/integrations/apollo') }) : null,
    ],
  });
  if (!status.configured) {
    el.append(header, emptyState({
      iconName: 'target',
      title: 'Connect Apollo to start prospecting',
      text: 'Add your Apollo.io API key to search people and companies, enrich contacts with emails and phone numbers, and push contacts into Apollo sequences.',
      action: isAdmin() ? btn('Connect Apollo', { primary: true, onClick: () => navigate('#/integrations/apollo') }) : muted('Ask an admin to add the Apollo API key.'),
    }));
    return;
  }

  const resultsBox = h('div');
  const tabBar = tabs([{ id: 'people', label: 'People', icon: 'users' }, { id: 'orgs', label: 'Companies', icon: 'building' }], state.tab, (t) => { state.tab = t; refresh(); });

  if (state.tab === 'people') {
    const f = state.people;
    const searchBtn = btn('Search Apollo', { primary: true, iconName: 'search', type: 'submit' });
    const form = h('form', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Job titles (one per line)'), textArea(f, 'person_titles', 'CEO\nHead of Procurement\nOperations Manager')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Seniority'), chipGroup(SENIORITIES, f.person_seniorities, (s) => s.replace('_', '-').replace('c-suite', 'C-suite'))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Person location (one per line)'), textArea(f, 'person_locations', 'Mumbai, India\nDubai\nUnited Kingdom', 2)),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Company HQ location'), textArea(f, 'organization_locations', 'India', 2)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Company size (employees)'), chipGroup(EMPLOYEE_RANGES, f.organization_num_employees_ranges, rangeLabel)),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Company domains (one per line)'), textArea(f, 'q_organization_domains_list', 'acme.com', 2)),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Keywords'), textInput(f, 'q_keywords', 'e.g. logistics, SaaS')),
      searchBtn,
      muted('People search is free in Apollo. Importing with emails revealed uses enrichment credits.'));
    const run = (page = 1) => busy(searchBtn, async () => {
      f.page = page;
      state.peopleResults = await POST('/apollo/people/search', {
        ...f, person_titles: lines(f.person_titles), person_locations: lines(f.person_locations), organization_locations: lines(f.organization_locations),
        q_organization_domains_list: lines(f.q_organization_domains_list),
      });
      drawPeople();
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); run(1); });

    const drawPeople = () => {
      const r = state.peopleResults;
      if (!r) { resultsBox.replaceChildren(emptyState({ iconName: 'search', title: 'Search for prospects', text: 'Combine titles, seniority, location and company size. Results show here.' })); return; }
      const sel = state.selected;
      const selIds = new Set(sel.keys());
      const importBar = h('div', { class: 'bulkbar' });
      const drawBar = () => {
        const tags = h('input', { class: 'input input-sm', value: state.importTags, placeholder: 'tags', 'aria-label': 'Tags for imported contacts' });
        tags.addEventListener('input', () => { state.importTags = tags.value; });
        const reveal = h('input', { type: 'checkbox', checked: state.reveal });
        reveal.addEventListener('change', () => { state.reveal = reveal.checked; });
        const seqSel = selectInput(store.meta.sequences.map((s) => ({ value: s.id, label: s.name })), '', () => {}, { placeholder: 'Don’t enroll', cls: 'input-sm' });
        const go = btn(`Import ${sel.size || ''}`.trim(), { primary: true, small: true, iconName: 'download', disabled: !sel.size });
        go.addEventListener('click', () => busy(go, async () => {
          const res = await POST('/apollo/people/import', { people: [...sel.values()], enrich: state.reveal, tags: state.importTags });
          let msg = `Imported ${res.created} new, ${res.updated} updated`;
          if (res.enriched) msg += ` · ${res.credits_used} credits`;
          if (seqSel.value && res.contact_ids.length) {
            const en = await POST(`/sequences/${seqSel.value}/enroll`, { contact_ids: res.contact_ids });
            msg += ` · ${en.enrolled} enrolled`;
          }
          toast(msg);
          for (const p of r.people) if (sel.has(p.id)) p.in_crm = true;
          sel.clear();
          await loadMeta();
          drawPeople();
        }));
        importBar.replaceChildren(h('b', null, `${sel.size} selected`),
          h('label', { class: 'field-check small' }, reveal, h('span', null, 'Reveal emails (uses credits)')),
          h('span', { class: 'small muted' }, 'Tags'), tags,
          h('span', { class: 'small muted' }, 'Then'), seqSel, go);
      };
      drawBar();
      const pages = Math.max(1, Math.ceil(Math.min(r.total, 50000) / r.per_page));
      resultsBox.replaceChildren(
        h('div', { class: 'results-head' }, h('b', null, `${num(r.total)} people found`),
          h('div', { class: 'pager-btns' },
            btn('', { iconName: 'chevronLeft', small: true, disabled: r.page <= 1, title: 'Previous page', onClick: () => run(r.page - 1) }),
            h('span', { class: 'pager-page' }, `Page ${r.page} of ${num(pages)}`),
            btn('', { iconName: 'chevronRight', small: true, disabled: r.page >= pages, title: 'Next page', onClick: () => run(r.page + 1) }))),
        importBar,
        dataTable({
          rows: r.people,
          selectable: true,
          selected: selIds,
          onSelectionChange: (ids) => {
            for (const p of r.people) { if (ids.has(p.id)) sel.set(p.id, p); else sel.delete(p.id); }
            drawBar();
          },
          columns: [
            { label: 'Name', render: (p) => h('div', null, h('b', null, [p.first_name, p.last_name || p.last_name_obfuscated].filter(Boolean).join(' ')),
              p.linkedin_url ? h('a', { href: p.linkedin_url, target: '_blank', rel: 'noopener', class: 'inline-ico', title: 'LinkedIn' }, icon('linkedin')) : null) },
            { label: 'Title', render: (p) => p.title || muted('—') },
            { label: 'Company', render: (p) => p.organization_name || muted('—') },
            { label: 'Location', cls: 'hide-md', render: (p) => [p.city, p.country].filter(Boolean).join(', ') || muted('—') },
            { label: 'Data', render: (p) => h('span', { class: 'chips' },
              p.has_email ? h('span', { class: 'chip chip-green' }, icon('mail'), 'Email') : h('span', { class: 'chip' }, 'No email'),
              p.has_direct_phone ? h('span', { class: 'chip chip-blue' }, icon('phone'), 'Phone') : null) },
            { label: '', render: (p) => (p.in_crm ? pill('In CRM', 'green') : null) },
          ],
          empty: h('div', { class: 'table-empty' }, 'No matches. Try broader titles or fewer filters.'),
        }));
    };
    drawPeople();
    el.append(header, tabBar, h('div', { class: 'prospect' }, card('Filters', form, { cls: 'prospect-filters' }), h('div', { class: 'prospect-results' }, resultsBox)));
    return;
  }

  // Companies tab
  const f = state.orgs;
  const searchBtn = btn('Search companies', { primary: true, iconName: 'search', type: 'submit' });
  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Company name'), textInput(f, 'q_organization_name', 'e.g. Tata')),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'HQ location (one per line)'), textArea(f, 'organization_locations', 'India\nUnited Arab Emirates', 2)),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Employees'), chipGroup(EMPLOYEE_RANGES, f.organization_num_employees_ranges, rangeLabel)),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Industry keywords (one per line)'), textArea(f, 'q_organization_keyword_tags', 'manufacturing\nlogistics', 2)),
    searchBtn,
    muted('Apollo charges credits for organization search.'));
  const run = (page = 1) => busy(searchBtn, async () => {
    f.page = page;
    state.orgResults = await POST('/apollo/organizations/search', { ...f, organization_locations: lines(f.organization_locations), q_organization_keyword_tags: lines(f.q_organization_keyword_tags) });
    drawOrgs();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); run(1); });
  const drawOrgs = () => {
    const r = state.orgResults;
    if (!r) { resultsBox.replaceChildren(emptyState({ iconName: 'building', title: 'Search for companies', text: 'Find target accounts, import them, then find the right people at each.' })); return; }
    const sel = state.selectedOrgs;
    const key = (o) => o.apollo_id || o.name;
    const importBtn = btn(`Import ${sel.size || ''} companies`, { primary: true, small: true, iconName: 'download', disabled: !sel.size, onClick: (e) => busy(e.currentTarget, async () => {
      const res = await POST('/apollo/organizations/import', { organizations: [...sel.values()], tags: state.importTags });
      toast(`Imported ${res.created} new, ${res.updated} updated`);
      for (const o of r.organizations) if (sel.has(key(o))) o.in_crm = true;
      sel.clear();
      drawOrgs();
    }) });
    resultsBox.replaceChildren(
      h('div', { class: 'results-head' }, h('b', null, `${num(r.total)} companies`),
        h('div', { class: 'pager-btns' },
          btn('', { iconName: 'chevronLeft', small: true, disabled: r.page <= 1, onClick: () => run(r.page - 1) }),
          h('span', { class: 'pager-page' }, `Page ${r.page}`),
          btn('', { iconName: 'chevronRight', small: true, disabled: r.organizations.length < f.per_page, onClick: () => run(r.page + 1) }))),
      h('div', { class: 'bulkbar' }, h('b', null, `${sel.size} selected`), importBtn),
      dataTable({
        rows: r.organizations.map((o) => ({ ...o, id: key(o) })),
        selectable: true,
        selected: new Set(sel.keys()),
        onSelectionChange: (ids) => { for (const o of r.organizations) { if (ids.has(key(o))) sel.set(key(o), o); else sel.delete(key(o)); } drawOrgs(); },
        columns: [
          { label: 'Company', render: (o) => h('div', null, h('b', null, o.name), h('div', { class: 'muted small' }, o.domain || '')) },
          { label: 'Industry', render: (o) => o.industry || muted('—') },
          { label: 'Employees', cls: 'num', render: (o) => (o.employees ? num(o.employees) : muted('—')) },
          { label: 'Location', cls: 'hide-md', render: (o) => [o.city, o.country].filter(Boolean).join(', ') || muted('—') },
          { label: '', render: (o) => h('span', { class: 'row-gap' }, o.in_crm ? pill('In CRM', 'green') : null,
            o.domain ? btn('People', { small: true, ghost: true, onClick: () => { state.tab = 'people'; state.people.q_organization_domains_list = o.domain; refresh(); } }) : null) },
        ],
      }));
  };
  drawOrgs();
  el.append(header, tabBar, h('div', { class: 'prospect' }, card('Filters', form, { cls: 'prospect-filters' }), h('div', { class: 'prospect-results' }, resultsBox)));
}
