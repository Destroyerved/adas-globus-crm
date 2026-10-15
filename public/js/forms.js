// Create/edit dialogs shared across views (also used by the global "New" menu).
import { h, GET, POST, PATCH, store, modal, toast, confirmDialog, cap, fullName, money } from './core.js';
import { formFields, richEditor, btn, muted } from './components.js';

const ownerOptions = () => store.meta.users.map((u) => ({ value: u.id, label: u.name }));
const statusOptions = () => store.meta.contact_statuses.map((s) => ({ value: s, label: cap(s) }));
const stageOptions = () => store.meta.stages.map((s) => ({ value: s.id, label: s.name }));

function sourceList() {
  let dl = document.getElementById('dl-sources');
  if (!dl) {
    dl = h('datalist', { id: 'dl-sources' });
    document.body.append(dl);
  }
  dl.replaceChildren(...['Website', 'Referral', 'Apollo', 'LinkedIn', 'Cold outreach', 'Event', 'Partner', ...store.meta.sources]
    .filter((v, i, a) => a.indexOf(v) === i).map((s) => h('option', { value: s })));
  return 'dl-sources';
}

export function openContactForm({ contact = null, defaults = {}, onSaved } = {}) {
  const c = contact || { status: 'lead', owner_id: store.user.id, ...defaults };
  const form = formFields([
    { name: 'first_name', label: 'First name', autocomplete: 'off' },
    { name: 'last_name', label: 'Last name', autocomplete: 'off' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'title', label: 'Job title' },
    { name: 'company_id', label: 'Company', type: 'picker', kind: 'company', allowCreate: true, createAs: 'company_name', valueLabel: c.company_name },
    { name: 'status', label: 'Status', type: 'select', options: statusOptions() },
    { name: 'owner_id', label: 'Owner', type: 'select', options: ownerOptions(), placeholder: 'Unassigned' },
    { name: 'source', label: 'Source', list: sourceList(), placeholder: 'Website, Referral…' },
    { name: 'tags', label: 'Tags', type: 'tags' },
    { type: 'section', label: 'More details' },
    { name: 'mobile', label: 'Mobile / WhatsApp', type: 'tel' },
    { name: 'linkedin_url', label: 'LinkedIn URL', type: 'url' },
    { name: 'city', label: 'City' },
    { name: 'country', label: 'Country' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 2 },
  ], c);
  const m = modal({
    title: contact ? `Edit ${fullName(contact)}` : 'New contact',
    size: 'lg',
    body: form.el,
    actions: [
      { label: 'Cancel' },
      {
        label: contact ? 'Save changes' : 'Create contact',
        primary: true,
        onClick: async ({ close }) => {
          const v = form.values();
          if (!v.first_name && !v.last_name && !v.email) return toast('Add a name or an email', 'error');
          if (!v.company_name) delete v.company_name;
          const res = contact ? await PATCH(`/contacts/${contact.id}`, v) : await POST('/contacts', v);
          toast(contact ? 'Contact updated' : 'Contact created');
          close();
          onSaved?.(res.contact);
        },
      },
    ],
  });
  return m;
}

export function openCompanyForm({ company = null, onSaved } = {}) {
  const c = company || { owner_id: store.user.id };
  const form = formFields([
    { name: 'name', label: 'Company name', required: true },
    { name: 'website', label: 'Website', placeholder: 'https://' },
    { name: 'industry', label: 'Industry' },
    { name: 'employees', label: 'Employees', type: 'number', min: 0 },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'annual_revenue', label: 'Annual revenue', type: 'number', min: 0 },
    { name: 'city', label: 'City' },
    { name: 'country', label: 'Country' },
    { name: 'owner_id', label: 'Owner', type: 'select', options: ownerOptions(), placeholder: 'Unassigned' },
    { name: 'tags', label: 'Tags', type: 'tags' },
    { name: 'linkedin_url', label: 'LinkedIn URL', type: 'url', span: 2 },
    { name: 'address', label: 'Address', span: 2 },
    { name: 'description', label: 'Description', type: 'textarea', span: 2 },
  ], c);
  return modal({
    title: company ? `Edit ${company.name}` : 'New company',
    size: 'lg',
    body: form.el,
    actions: [
      { label: 'Cancel' },
      {
        label: company ? 'Save changes' : 'Create company',
        primary: true,
        onClick: async ({ close }) => {
          if (!form.validate()) return;
          const v = form.values();
          if (!company && v.website) v.domain = v.website;
          const res = company ? await PATCH(`/companies/${company.id}`, v) : await POST('/companies', v);
          toast(company ? 'Company updated' : 'Company created');
          close();
          onSaved?.(res.company);
        },
      },
    ],
  });
}

export function openDealForm({ deal = null, defaults = {}, onSaved } = {}) {
  const d = deal || { owner_id: store.user.id, stage_id: store.meta.stages.find((s) => s.kind === 'open')?.id, ...defaults };
  const form = formFields([
    { name: 'title', label: 'Deal name', required: true, span: 2, placeholder: 'e.g. Acme – annual contract' },
    { name: 'value', label: `Value (${store.settings.company?.currency || 'USD'})`, type: 'number', min: 0, step: 'any' },
    { name: 'stage_id', label: 'Stage', type: 'select', options: stageOptions() },
    { name: 'contact_id', label: 'Contact', type: 'picker', kind: 'contact', valueLabel: d.contact_name },
    { name: 'company_id', label: 'Company', type: 'picker', kind: 'company', valueLabel: d.company_name },
    { name: 'expected_close', label: 'Expected close', type: 'date' },
    { name: 'owner_id', label: 'Owner', type: 'select', options: ownerOptions(), placeholder: 'Unassigned' },
    { name: 'probability', label: 'Win probability % (blank = stage default)', type: 'number', min: 0, max: 100 },
    { name: 'source', label: 'Source', list: sourceList() },
    { name: 'tags', label: 'Tags', type: 'tags', span: 2 },
    { name: 'description', label: 'Description', type: 'textarea', span: 2 },
  ], d);
  return modal({
    title: deal ? `Edit ${deal.title}` : 'New deal',
    size: 'lg',
    body: form.el,
    actions: [
      { label: 'Cancel' },
      {
        label: deal ? 'Save changes' : 'Create deal',
        primary: true,
        onClick: async ({ close }) => {
          if (!form.validate()) return;
          const v = form.values();
          v.stage_id = Number(v.stage_id);
          const res = deal ? await PATCH(`/deals/${deal.id}`, v) : await POST('/deals', v);
          toast(deal ? 'Deal updated' : `Deal created${v.value ? ` · ${money(v.value)}` : ''}`);
          close();
          onSaved?.(res.deal);
        },
      },
    ],
  });
}

const ACTIVITY_TYPES = [
  { value: 'note', label: 'Note' }, { value: 'call', label: 'Call' }, { value: 'meeting', label: 'Meeting' },
  { value: 'task', label: 'Task' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' },
  { value: 'linkedin', label: 'LinkedIn' }, { value: 'email', label: 'Email (logged)' },
];

export function openActivityForm({ activity = null, type = 'note', contact = null, deal = null, company = null, onSaved } = {}) {
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setHours(10, 0, 0, 0);
  const a = activity || {
    type, assigned_to: store.user.id, due_at: tomorrow.toISOString(), priority: 'normal',
    contact_id: contact?.id, contact_name: contact?.full_name, deal_id: deal?.id, deal_title: deal?.title,
  };
  const isTask = () => typeSel.value === 'task';
  const form = formFields([
    { name: 'type', label: 'Type', type: 'select', options: ACTIVITY_TYPES },
    { name: 'subject', label: 'Subject', placeholder: 'e.g. Discovery call, Send proposal' },
    { name: 'body', label: 'Details', type: 'textarea', rows: 4, span: 2 },
    { name: 'due_at', label: 'Due', type: 'datetime' },
    { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high'] },
    { name: 'assigned_to', label: 'Assigned to', type: 'select', options: ownerOptions() },
    { name: 'contact_id', label: 'Contact', type: 'picker', kind: 'contact', valueLabel: a.contact_name },
  ], a);
  const typeSel = form.inputs.type.input;
  const taskOnly = ['due_at', 'priority', 'assigned_to'].map((k) => form.inputs[k].input.closest('.field'));
  const sync = () => taskOnly.forEach((el) => { el.hidden = !isTask(); });
  typeSel.addEventListener('change', sync);
  sync();
  return modal({
    title: activity ? 'Edit activity' : (type === 'task' ? 'New task' : 'Log activity'),
    body: form.el,
    actions: [
      { label: 'Cancel' },
      {
        label: activity ? 'Save' : (type === 'task' ? 'Create task' : 'Save'),
        primary: true,
        onClick: async ({ close }) => {
          const v = form.values();
          if (!v.subject && !v.body) return toast('Add a subject or some details', 'error');
          if (!isTask()) { delete v.due_at; delete v.priority; delete v.assigned_to; }
          v.assigned_to = v.assigned_to ? Number(v.assigned_to) : undefined;
          if (deal) v.deal_id = deal.id;
          if (company) v.company_id = company.id;
          const res = activity ? await PATCH(`/activities/${activity.id}`, v) : await POST('/activities', v);
          toast(isTask() ? 'Task saved' : 'Activity logged');
          close();
          onSaved?.(res.activity);
        },
      },
    ],
  });
}

// Compose and send a one-off email.
export function openComposer({ contact = null, deal = null, subject = '', body = '', onSent } = {}) {
  let toPicker = null;
  const toField = contact
    ? h('div', { class: 'compose-to' }, h('b', null, contact.full_name), muted(` <${contact.email || 'no email'}>`))
    : (toPicker = h('input', { class: 'input', type: 'email', placeholder: 'name@company.com' }));
  const tplSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Start from a template…'),
    store.meta.templates.map((t) => h('option', { value: t.id }, `${t.category ? `${t.category} · ` : ''}${t.name}`)));
  const subj = h('input', { class: 'input', value: subject, placeholder: 'Subject' });
  const editor = richEditor({ value: body, minHeight: 240 });
  const cc = h('input', { class: 'input', placeholder: 'Cc (comma separated)' });
  tplSel.addEventListener('change', async () => {
    if (!tplSel.value) return;
    const { template } = await GET(`/templates/${tplSel.value}`);
    subj.value = template.subject;
    editor.setValue(template.body);
  });
  const send = async (force = false) => {
    const payload = {
      contact_id: contact?.id, to: toPicker?.value, subject: subj.value, body: editor.getValue(), cc: cc.value || undefined,
      deal_id: deal?.id, template_id: tplSel.value || undefined, force,
    };
    try {
      await POST('/emails/send', payload);
      return true;
    } catch (err) {
      if (err.status === 409 && !force && await confirmDialog(`${err.message} Send anyway?`, { confirmLabel: 'Send anyway', danger: true })) return send(true);
      throw err;
    }
  };
  return modal({
    title: 'New email',
    size: 'lg',
    body: h('div', { class: 'composer' },
      h('div', { class: 'compose-row' }, h('span', { class: 'label' }, 'To'), toField),
      h('div', { class: 'compose-row' }, h('span', { class: 'label' }, 'Cc'), cc),
      h('div', { class: 'compose-row' }, h('span', { class: 'label' }, 'Template'), tplSel),
      h('div', { class: 'compose-row' }, h('span', { class: 'label' }, 'Subject'), subj),
      editor.el,
      h('p', { class: 'help' }, 'Variables like {{first_name}} are filled in per contact. Use {{first_name|there}} for a fallback.')),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Send email',
        primary: true,
        onClick: async ({ close }) => {
          if (!subj.value.trim()) return toast('Add a subject', 'error');
          if (!editor.getValue()) return toast('Write a message', 'error');
          if (await send()) {
            toast('Email sent');
            close();
            onSent?.();
          }
        },
      },
    ],
  });
}

// Enroll one or more contacts in a sequence.
export function openEnrollDialog(contactIds, { onDone } = {}) {
  const active = store.meta.sequences.filter((s) => s.status === 'active');
  if (!store.meta.sequences.length) return toast('Create a sequence first (Outreach → Sequences)', 'error');
  const sel = h('select', { class: 'input' }, store.meta.sequences.map((s) => h('option', { value: s.id }, `${s.name}${s.status !== 'active' ? ' (paused)' : ''}`)));
  if (active[0]) sel.value = String(active[0].id);
  return modal({
    title: `Enroll ${contactIds.length} contact${contactIds.length === 1 ? '' : 's'} in a sequence`,
    body: h('div', null,
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Sequence'), sel),
      h('p', { class: 'help' }, 'Contacts without an email address, unsubscribed contacts and contacts already active in the sequence are skipped.')),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Enroll',
        primary: true,
        onClick: async ({ close }) => {
          const r = await POST(`/sequences/${sel.value}/enroll`, { contact_ids: contactIds });
          toast(`${r.enrolled} enrolled${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
          close();
          onDone?.(r);
        },
      },
    ],
  });
}

// Push CRM contacts into an Apollo sequence (Apollo sends the emails).
export async function openApolloPushDialog(contactIds) {
  const body = h('div', null, h('p', null, 'Loading your Apollo sequences…'));
  const m = modal({ title: 'Add to Apollo sequence', body, actions: [{ label: 'Cancel' }] });
  try {
    const [{ sequences }, { email_accounts: accounts }] = await Promise.all([GET('/apollo/sequences'), GET('/apollo/email-accounts')]);
    const seq = h('select', { class: 'input' }, sequences.map((s) => h('option', { value: s.id }, `${s.name}${s.active ? '' : ' (inactive)'}`)));
    const acc = h('select', { class: 'input' }, accounts.map((a) => h('option', { value: a.id, selected: a.default }, a.email)));
    body.replaceChildren(
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Apollo sequence'), seq),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Send from mailbox'), acc),
      h('p', { class: 'help' }, `${contactIds.length} contact(s) will be created in Apollo (deduplicated) and added to the sequence. Requires an Apollo master API key.`));
    const go = btn('Add to sequence', {
      primary: true,
      onClick: async () => {
        go.disabled = true;
        try {
          const r = await POST('/apollo/sequences/push', { contact_ids: contactIds, sequence_id: seq.value, email_account_id: acc.value });
          toast(`${r.added} added to Apollo sequence${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
          m.close();
        } catch (err) { toast(err.message, 'error'); go.disabled = false; }
      },
    });
    m.el.querySelector('.modal-foot').append(go);
  } catch (err) {
    body.replaceChildren(h('p', { class: 'error-text' }, err.message));
  }
}

