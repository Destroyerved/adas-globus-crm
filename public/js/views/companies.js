import { h, icon, GET, POST, DEL, store, qs, money, num, date, ago, toast, confirmDialog, navigate } from '../core.js';
import {
  pageHeader, dataTable, pager, searchInput, selectInput, pill, avatar, tagList, btn, muted, card, kv, timelineView, emptyState,
  openEmailViewer, dropdownMenu,
} from '../components.js';
import { openCompanyForm, openContactForm, openDealForm, openActivityForm } from '../forms.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const state = { q: '', owner_id: '', tag: '', sort: '-created_at', offset: 0, limit: 50 };

export async function companiesView(el) {
  const data = await GET(`/companies${qs({ q: state.q, owner_id: state.owner_id, tag: state.tag, sort: state.sort, offset: state.offset, limit: state.limit })}`);
  const go = (patch) => { Object.assign(state, patch); refresh(); };
  el.append(
    pageHeader('Companies', {
      subtitle: `${num(data.total)} accounts`,
      actions: [
        h('a', { class: 'btn', href: `/api/companies/export.csv${qs({ q: state.q, owner_id: state.owner_id, tag: state.tag })}`, download: '' }, icon('download'), h('span', null, 'Export')),
        btn('New company', { primary: true, iconName: 'plus', onClick: () => openCompanyForm({ onSaved: (c) => navigate(`#/companies/${c.id}`) }) }),
      ],
    }),
    h('div', { class: 'toolbar' },
      searchInput(state.q, (q) => go({ q, offset: 0 }), 'Search name, domain, industry…'),
      selectInput([{ value: 'me', label: 'My companies' }, ...store.meta.users.map((u) => ({ value: u.id, label: u.name }))], state.owner_id, (v) => go({ owner_id: v, offset: 0 }), { placeholder: 'All owners' }),
      selectInput(store.meta.tags, state.tag, (v) => go({ tag: v, offset: 0 }), { placeholder: 'All tags' })),
    dataTable({
      rows: data.companies,
      sort: state.sort,
      onSort: (sort) => go({ sort }),
      onRowClick: (r) => navigate(`#/companies/${r.id}`),
      columns: [
        { label: 'Company', sort: 'name', render: (r) => h('div', { class: 'cell-person' }, avatar(r.name), h('div', null, h('a', { class: 'strong', href: `#/companies/${r.id}` }, r.name), h('div', { class: 'muted small' }, r.domain || '—'))) },
        { label: 'Industry', sort: 'industry', key: 'industry' },
        { label: 'Employees', sort: 'employees', cls: 'num hide-md', render: (r) => (r.employees ? num(r.employees) : muted('—')) },
        { label: 'Contacts', cls: 'num', render: (r) => num(r.contact_count) },
        { label: 'Open deals', cls: 'num', render: (r) => (r.open_deals ? `${num(r.open_deals)} · ${money(r.open_value, { compact: true })}` : muted('—')) },
        { label: 'Location', cls: 'hide-md', render: (r) => [r.city, r.country].filter(Boolean).join(', ') || muted('—') },
        { label: 'Owner', key: 'owner_name', cls: 'hide-lg' },
        { label: 'Tags', cls: 'hide-lg', render: (r) => tagList(r.tags) || muted('—') },
      ],
      empty: emptyState({ iconName: 'building', title: 'No companies yet', text: 'Companies are created automatically when you add contacts with a company name or import from Apollo.' }),
    }),
    pager({ total: data.total, limit: data.limit, offset: data.offset, onChange: (offset) => go({ offset }) }));
}

export async function companyDetailView(el, { id }) {
  const [data, tl] = await Promise.all([GET(`/companies/${id}`), GET(`/timeline?company_id=${id}`)]);
  const co = data.company;
  const more = dropdownMenu(btn('', { iconName: 'more', title: 'More actions' }), [
    { label: 'Enrich with Apollo', icon: 'sparkles', onClick: async () => {
      const r = await POST(`/apollo/enrich/company/${co.id}`, {}).catch((e) => toast(e.message, 'error'));
      if (r) { toast(r.matched ? (r.updated_fields.length ? `Updated: ${r.updated_fields.join(', ')}` : 'Apollo had nothing new') : 'No match in Apollo'); refresh(); }
    } },
    { label: 'Find people at this company', icon: 'target', onClick: () => navigate(`#/prospecting?domain=${encodeURIComponent(co.domain || '')}`) },
    { label: 'Delete company', icon: 'trash', danger: true, onClick: async () => {
      if (!await confirmDialog(`Delete ${co.name}? Contacts and deals are kept but unlinked.`, { danger: true, confirmLabel: 'Delete' })) return;
      await DEL(`/companies/${co.id}`);
      toast('Company deleted');
      navigate('#/companies');
    } },
  ]);
  el.append(
    pageHeader(co.name, {
      back: { href: '#/companies', label: 'Companies' },
      actions: [
        btn('Add contact', { iconName: 'user', onClick: () => openContactForm({ defaults: { company_id: co.id, company_name: co.name }, onSaved: refresh }) }),
        btn('New deal', { iconName: 'kanban', onClick: () => openDealForm({ defaults: { company_id: co.id, company_name: co.name }, onSaved: refresh }) }),
        btn('Edit', { iconName: 'edit', onClick: () => openCompanyForm({ company: co, onSaved: refresh }) }),
        more,
      ],
    }),
    h('div', { class: 'detail' },
      h('div', { class: 'detail-side' },
        card(null, h('div', { class: 'profile' },
          h('div', { class: 'profile-top' }, avatar(co.name, 'lg'), h('div', null, h('h2', null, co.name), h('div', { class: 'muted' }, co.industry || ''))),
          h('div', { class: 'profile-quick' },
            co.website ? h('a', { class: 'chip-link', href: /^https?:/.test(co.website) ? co.website : `https://${co.website}`, target: '_blank', rel: 'noopener' }, icon('globe'), co.domain || 'Website') : null,
            co.phone ? h('a', { class: 'chip-link', href: `tel:${co.phone}` }, icon('phone'), co.phone) : null,
            co.linkedin_url ? h('a', { class: 'chip-link', href: co.linkedin_url, target: '_blank', rel: 'noopener' }, icon('linkedin'), 'LinkedIn') : null),
          kv([
            ['Employees', co.employees ? num(co.employees) : null],
            ['Annual revenue', co.annual_revenue ? money(co.annual_revenue, { compact: true }) : null],
            ['Location', [co.address, co.city, co.state, co.country].filter(Boolean).join(', ')],
            ['Owner', co.owner_name],
            ['Open pipeline', co.open_deals ? `${money(co.open_value)} in ${co.open_deals} deal(s)` : null],
            ['Tags', tagList(co.tags)],
            ['Created', date(co.created_at)],
          ]),
          co.description ? h('p', { class: 'notes' }, co.description) : null)),
        card(`Deals (${data.deals.length})`, data.deals.length
          ? h('ul', { class: 'deal-mini' }, data.deals.map((d) => h('li', null, h('a', { href: `#/deals/${d.id}` }, d.title), h('span', { class: 'muted small' }, d.stage_name), h('b', null, money(d.value, { compact: true })))))
          : muted('No deals yet.'))),
      h('div', { class: 'detail-main' },
        card(`People (${data.contacts.length})`, data.contacts.length
          ? dataTable({
            rows: data.contacts,
            onRowClick: (r) => navigate(`#/contacts/${r.id}`),
            columns: [
              { label: 'Name', render: (r) => h('a', { href: `#/contacts/${r.id}`, class: 'strong' }, r.full_name) },
              { label: 'Title', key: 'title' },
              { label: 'Email', key: 'email', cls: 'hide-md' },
              { label: 'Status', render: (r) => pill(r.status) },
              { label: 'Last contacted', cls: 'hide-md', render: (r) => (r.last_contacted_at ? ago(r.last_contacted_at) : muted('Never')) },
            ],
          })
          : muted('No contacts at this company yet.')),
        card('Activity', timelineView(tl.items, { onOpenEmail: openEmailViewer, showContact: true }),
          { actions: btn('Log activity', { small: true, ghost: true, iconName: 'plus', onClick: () => openActivityForm({ company: co, onSaved: refresh }) }) }))));
}
