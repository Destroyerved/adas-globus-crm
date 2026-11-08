import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AccountStatusSchema,
  LeadSystemStatusSchema,
  UpdateCompanyInputSchema,
  UpdateContactInputSchema,
  UpdateDealInputSchema,
  UpdateLeadInputSchema,
  moneyInputValue,
  parseMoneyInput,
} from '@adas/shared';
import { Input } from '@/components/ui/input.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import {
  api,
  type CompanyRow,
  type ContactRow,
  type CurrentUser,
  type DealRow,
  type LeadRow,
} from '@/lib/api.js';
import { Field } from '@/features/shared/live-kit.js';
import { CompanyPicker } from '@/features/shared/company-picker.js';
import { useMe, useReferenceLists, useUsers } from '@/features/shared/list-kit.js';
import {
  CheckboxGroup,
  EditDrawer,
  changedFields,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
  type Values,
} from './record-form.js';

/** Edit drawers for leads, contacts, companies and deals (PRD 3.1-3.3, 4.3-4.6). */

const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  prospect: 'Prospect',
  client: 'Client',
  former_client: 'Former client',
  partner: 'Partner',
  do_not_contact: 'Do not contact',
};

/** Reassigning needs team or all scope on the capability; own scope keeps the owner. */
function reassignScope(me: CurrentUser | undefined, capability: string): 'team' | 'all' | null {
  const scope = me?.capabilities?.[capability];
  return scope === 'team' || scope === 'all' ? scope : null;
}

function OwnerField({
  me,
  capability,
  value,
  onChange,
  error,
}: {
  me: CurrentUser | undefined;
  capability: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const users = useUsers();
  const scope = reassignScope(me, capability);
  if (!scope) return null;
  const options = (users.data ?? []).filter(
    (u) =>
      (!u.status || u.status === 'active') &&
      (scope === 'all' || u.id === me?.id || u.id === value || u.team_id === me?.teamId),
  );
  return (
    <Field label="Owner" error={error}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} invalid={Boolean(error)}>
        {options.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
            {u.team_name ? ` · ${u.team_name}` : ''}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function useSave<T>(
  schema: Parameters<typeof issuesOf>[0],
  mutate: (payload: Values) => Promise<T>,
  onSaved: (row: T) => void,
  message: string,
) {
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: mutate,
    onSuccess: (row) => {
      toast(message);
      onSaved(row);
    },
  });
  const run = (payload: Values, setClientErrors: (e: Record<string, string>) => void) => {
    const issues = issuesOf(schema, payload);
    setClientErrors(issues);
    if (Object.keys(issues).length > 0) return;
    mutation.mutate(payload);
  };
  return { mutation, run };
}

// ---------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------

export function LeadEditDrawer({
  lead,
  onClose,
  onSaved,
}: {
  lead: LeadRow;
  onClose: () => void;
  onSaved: (lead: LeadRow) => void;
}) {
  const me = useMe();
  const refs = useReferenceLists();
  const initial = {
    firstName: lead.first_name,
    lastName: lead.last_name,
    email: lead.email,
    phone: lead.phone_e164 ?? '',
    firmName: lead.firm_name ?? '',
    website: lead.website ?? '',
    title: lead.title ?? '',
    market: lead.market,
    stateProvince: lead.state_province ?? '',
    staffBand: lead.staff_band,
    source: lead.source,
    status: lead.status,
    disqualificationReason: lead.disqualification_reason ?? '',
    statusNote: '',
    ownerUserId: lead.owner_user_id,
    servicesNeeded: lead.services_needed ?? [],
    softwareStack: lead.software_stack ?? [],
  };
  const { values, set } = useDraft(initial);
  const draft = useDraft<Record<string, string>>({});
  const { mutation, run } = useSave(
    UpdateLeadInputSchema,
    (payload) => api.updateLead(lead.id, payload as Values & { version: number }),
    onSaved,
    'Lead saved.',
  );
  const errors = { ...draft.values, ...serverFieldErrors(mutation.error) };
  const statusChanged = values.status !== lead.status;
  const statuses = LeadSystemStatusSchema.options.filter(
    (s) => s !== 'Converted' || lead.status === 'Converted',
  );

  const submit = () => {
    const diff = changedFields(initial, values, [
      'phone',
      'firmName',
      'website',
      'stateProvince',
      'disqualificationReason',
      'statusNote',
    ]);
    if (values.status !== 'Disqualified') delete diff['disqualificationReason'];
    if (!statusChanged) delete diff['statusNote'];
    if (values.status === 'Disqualified' && !values.disqualificationReason) {
      draft.set('disqualificationReason', 'Choose why this lead is disqualified.');
      return;
    }
    if (Object.keys(diff).length === 0) {
      onClose();
      return;
    }
    run({ version: lead.version, ...diff }, (e) => {
      for (const key of Object.keys(draft.values)) draft.set(key, '');
      for (const [k, v] of Object.entries(e)) draft.set(k, v);
    });
  };

  return (
    <EditDrawer
      title={`Edit ${lead.full_name}`}
      description="Changes are saved to the lead's history."
      formId="lead-edit-form"
      pending={mutation.isPending}
      error={formError(mutation.error)}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="First name" error={errors['firstName'] || undefined}>
          <Input value={values.firstName} onChange={(e) => set('firstName', e.target.value)} />
        </Field>
        <Field label="Last name" optional error={errors['lastName'] || undefined}>
          <Input value={values.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </Field>
      </div>
      <Field label="Work email" error={errors['email'] || undefined}>
        <Input
          type="email"
          value={values.email}
          onChange={(e) => set('email', e.target.value)}
          invalid={Boolean(errors['email'])}
        />
      </Field>
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="Phone" optional error={errors['phone'] || undefined}>
          <Input type="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Job title" optional>
          <Input value={values.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Firm" optional>
          <Input value={values.firmName} onChange={(e) => set('firmName', e.target.value)} />
        </Field>
        <Field label="Website" optional error={errors['website'] || undefined}>
          <Input value={values.website} onChange={(e) => set('website', e.target.value)} />
        </Field>
        <Field label="Market">
          <Select value={values.market} onChange={(e) => set('market', e.target.value as never)}>
            <option value="US">United States</option>
            <option value="CA">Canada</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="State or province" optional>
          <Input
            value={values.stateProvince}
            onChange={(e) => set('stateProvince', e.target.value)}
          />
        </Field>
        <Field label="Firm size">
          <Select value={values.staffBand} onChange={(e) => set('staffBand', e.target.value)}>
            {[...new Set([...(refs.data?.['staff_bands'] ?? []), values.staffBand])].map((b) => (
              <option key={b} value={b}>
                {b} staff
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Source">
          <Select value={values.source} onChange={(e) => set('source', e.target.value)}>
            {[...new Set([...(refs.data?.['lead_sources'] ?? []), values.source])].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="Status" error={errors['status'] || undefined}>
          <Select
            value={values.status}
            onChange={(e) => set('status', e.target.value)}
            disabled={lead.status === 'Converted'}
          >
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <OwnerField
          me={me}
          capability="leads.assign"
          value={values.ownerUserId}
          onChange={(v) => set('ownerUserId', v)}
          error={errors['ownerUserId'] || undefined}
        />
      </div>
      {values.status === 'Disqualified' && (
        <Field
          label="Why is it disqualified?"
          error={errors['disqualificationReason'] || undefined}
        >
          <Select
            value={values.disqualificationReason}
            onChange={(e) => set('disqualificationReason', e.target.value)}
            invalid={Boolean(errors['disqualificationReason'])}
          >
            <option value="">Choose a reason</option>
            {(refs.data?.['disqualify_reasons'] ?? []).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {statusChanged && (
        <Field label="Note about the status change" optional>
          <Textarea
            rows={2}
            value={values.statusNote}
            onChange={(e) => set('statusNote', e.target.value)}
          />
        </Field>
      )}
      <CheckboxGroup
        legend="Services needed"
        options={refs.data?.['services'] ?? []}
        value={values.servicesNeeded}
        onChange={(v) => set('servicesNeeded', v)}
      />
      <CheckboxGroup
        legend="Software they use"
        options={refs.data?.['software'] ?? []}
        value={values.softwareStack}
        onChange={(v) => set('softwareStack', v)}
      />
    </EditDrawer>
  );
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export function ContactEditDrawer({
  contact,
  companyName,
  onClose,
  onSaved,
}: {
  contact: ContactRow;
  companyName?: string | null;
  onClose: () => void;
  onSaved: (contact: ContactRow) => void;
}) {
  const me = useMe();
  const [pickedName, setPickedName] = useState(companyName ?? contact.company_name ?? '');
  const initial = {
    companyId: contact.company_id ?? '',
    firstName: contact.first_name,
    lastName: contact.last_name,
    title: contact.title ?? '',
    seniority: contact.seniority,
    jobFunction: contact.job_function,
    primaryEmail: contact.primary_email,
    phone: contact.phone_e164 ?? '',
    market: contact.market,
    timezone: contact.timezone,
    ownerUserId: contact.owner_user_id,
    doNotContact: contact.do_not_contact,
  };
  const { values, set } = useDraft(initial);
  const clientErrors = useDraft<Record<string, string>>({});
  const { mutation, run } = useSave(
    UpdateContactInputSchema,
    (payload) => api.updateContact(contact.id, payload as Values & { version: number }),
    onSaved,
    'Contact saved.',
  );
  const errors = { ...clientErrors.values, ...serverFieldErrors(mutation.error) };

  const submit = () => {
    const diff = changedFields(initial, values, ['phone', 'companyId']);
    if (Object.keys(diff).length === 0) {
      onClose();
      return;
    }
    run({ version: contact.version, ...diff }, (e) => {
      for (const key of Object.keys(clientErrors.values)) clientErrors.set(key, '');
      for (const [k, v] of Object.entries(e)) clientErrors.set(k, v);
    });
  };

  return (
    <EditDrawer
      title={`Edit ${contact.full_name}`}
      formId="contact-edit-form"
      pending={mutation.isPending}
      error={formError(mutation.error)}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="First name" error={errors['firstName'] || undefined}>
          <Input value={values.firstName} onChange={(e) => set('firstName', e.target.value)} />
        </Field>
        <Field label="Last name" error={errors['lastName'] || undefined}>
          <Input value={values.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-[6px] text-label text-ink">
        <span>
          Company <em className="not-italic font-normal text-ink-3">(optional)</em>
        </span>
        <CompanyPicker
          value={values.companyId ? { id: values.companyId, name: pickedName } : null}
          onChange={(picked) => {
            set('companyId', picked?.id ?? '');
            setPickedName(picked?.name ?? '');
          }}
        />
        {errors['companyId'] && (
          <span className="text-[13px] font-normal text-danger">{errors['companyId']}</span>
        )}
      </div>
      <Field label="Work email" error={errors['primaryEmail'] || undefined}>
        <Input
          type="email"
          value={values.primaryEmail}
          onChange={(e) => set('primaryEmail', e.target.value)}
          invalid={Boolean(errors['primaryEmail'])}
        />
      </Field>
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="Phone" optional error={errors['phone'] || undefined}>
          <Input type="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Job title" optional>
          <Input value={values.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Seniority">
          <Input value={values.seniority} onChange={(e) => set('seniority', e.target.value)} />
        </Field>
        <Field label="Job function">
          <Input value={values.jobFunction} onChange={(e) => set('jobFunction', e.target.value)} />
        </Field>
        <Field label="Market">
          <Select value={values.market} onChange={(e) => set('market', e.target.value as never)}>
            <option value="US">United States</option>
            <option value="CA">Canada</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Time zone" error={errors['timezone'] || undefined}>
          <Input value={values.timezone} onChange={(e) => set('timezone', e.target.value)} />
        </Field>
        <OwnerField
          me={me}
          capability="contacts.write"
          value={values.ownerUserId}
          onChange={(v) => set('ownerUserId', v)}
          error={errors['ownerUserId'] || undefined}
        />
      </div>
      <label className="flex items-start gap-[10px] text-[14px] text-ink">
        <input
          type="checkbox"
          checked={values.doNotContact}
          onChange={(e) => set('doNotContact', e.target.checked)}
          className="mt-[3px] accent-[var(--danger)]"
        />
        <span>
          <span className="font-semibold">Do not contact</span>
          <span className="block text-[13px] text-ink-3">
            Stops every sequence for this person and blocks new outreach.
          </span>
        </span>
      </label>
    </EditDrawer>
  );
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

export function CompanyEditDrawer({
  company,
  onClose,
  onSaved,
}: {
  company: CompanyRow;
  onClose: () => void;
  onSaved: (company: CompanyRow) => void;
}) {
  const me = useMe();
  const refs = useReferenceLists();
  const initial = {
    name: company.name,
    websiteOrDomain: company.domain ?? company.website ?? '',
    firmType: company.firm_type,
    market: company.market,
    stateProvince: company.state_province ?? '',
    city: company.city ?? '',
    timezone: company.timezone,
    staffBand: company.staff_band,
    accountStatus: company.account_status,
    ownerUserId: company.owner_user_id,
    accountingSoftware: company.accounting_software ?? [],
    servicesNeeded: company.services_needed ?? [],
  };
  const { values, set } = useDraft(initial);
  const clientErrors = useDraft<Record<string, string>>({});
  const { mutation, run } = useSave(
    UpdateCompanyInputSchema,
    (payload) => api.updateCompany(company.id, payload as Values & { version: number }),
    onSaved,
    'Company saved.',
  );
  const errors = { ...clientErrors.values, ...serverFieldErrors(mutation.error) };

  const submit = () => {
    const diff = changedFields(initial, values, ['websiteOrDomain', 'stateProvince', 'city']);
    if (Object.keys(diff).length === 0) {
      onClose();
      return;
    }
    run({ version: company.version, ...diff }, (e) => {
      for (const key of Object.keys(clientErrors.values)) clientErrors.set(key, '');
      for (const [k, v] of Object.entries(e)) clientErrors.set(k, v);
    });
  };

  return (
    <EditDrawer
      title={`Edit ${company.name}`}
      formId="company-edit-form"
      pending={mutation.isPending}
      error={formError(mutation.error)}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Company name" error={errors['name'] || undefined}>
        <Input value={values.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Website or domain" optional error={errors['websiteOrDomain'] || undefined}>
        <Input
          value={values.websiteOrDomain}
          onChange={(e) => set('websiteOrDomain', e.target.value)}
          invalid={Boolean(errors['websiteOrDomain'])}
        />
      </Field>
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="Firm type">
          <Select value={values.firmType} onChange={(e) => set('firmType', e.target.value)}>
            {[...new Set([...(refs.data?.['firm_types'] ?? []), values.firmType])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Account status">
          <Select
            value={values.accountStatus}
            onChange={(e) => set('accountStatus', e.target.value)}
          >
            {AccountStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {ACCOUNT_STATUS_LABEL[s] ?? s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Market">
          <Select value={values.market} onChange={(e) => set('market', e.target.value as never)}>
            <option value="US">United States</option>
            <option value="CA">Canada</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Firm size">
          <Select value={values.staffBand} onChange={(e) => set('staffBand', e.target.value)}>
            {[...new Set([...(refs.data?.['staff_bands'] ?? []), values.staffBand])].map((b) => (
              <option key={b} value={b}>
                {b} staff
              </option>
            ))}
          </Select>
        </Field>
        <Field label="City" optional>
          <Input value={values.city} onChange={(e) => set('city', e.target.value)} />
        </Field>
        <Field label="State or province" optional>
          <Input
            value={values.stateProvince}
            onChange={(e) => set('stateProvince', e.target.value)}
          />
        </Field>
        <Field label="Time zone" error={errors['timezone'] || undefined}>
          <Input value={values.timezone} onChange={(e) => set('timezone', e.target.value)} />
        </Field>
        <OwnerField
          me={me}
          capability="companies.write"
          value={values.ownerUserId}
          onChange={(v) => set('ownerUserId', v)}
          error={errors['ownerUserId'] || undefined}
        />
      </div>
      {values.accountStatus === 'do_not_contact' && company.account_status !== 'do_not_contact' && (
        <p className="m-0 text-[13px] text-warning">
          Saving blocks outreach to every address at this company&rsquo;s domain.
        </p>
      )}
      <CheckboxGroup
        legend="Accounting software"
        options={refs.data?.['software'] ?? []}
        value={values.accountingSoftware}
        onChange={(v) => set('accountingSoftware', v)}
      />
      <CheckboxGroup
        legend="Services needed"
        options={refs.data?.['services'] ?? []}
        value={values.servicesNeeded}
        onChange={(v) => set('servicesNeeded', v)}
      />
    </EditDrawer>
  );
}

// ---------------------------------------------------------------------------
// Deal
// ---------------------------------------------------------------------------

export function DealEditDrawer({
  deal,
  onClose,
  onSaved,
}: {
  deal: DealRow;
  onClose: () => void;
  onSaved: (deal: DealRow) => void;
}) {
  const me = useMe();
  const refs = useReferenceLists();
  const initial = {
    name: deal.name,
    monthlyValue: moneyInputValue(deal.monthly_value_minor),
    oneTimeValue: moneyInputValue(deal.one_time_value_minor ?? '0'),
    termMonths: String(deal.term_months ?? 12),
    currency: deal.currency,
    fteCount: String(deal.fte_count),
    engagementModel: deal.engagement_model ?? '',
    services: deal.services ?? [],
    probability: deal.probability_override ? String(deal.probability) : '',
    expectedCloseDate: deal.expected_close_date ?? '',
    ownerUserId: deal.owner_user_id,
    trialCandidateRole: deal.trial_candidate_role ?? '',
  };
  const { values, set } = useDraft(initial);
  const clientErrors = useDraft<Record<string, string>>({});
  const { mutation, run } = useSave(
    UpdateDealInputSchema,
    (payload) => api.updateDeal(deal.id, payload as Values & { version: number }),
    onSaved,
    'Deal saved.',
  );
  const errors = { ...clientErrors.values, ...serverFieldErrors(mutation.error) };

  const submit = () => {
    const diff = changedFields(initial, values, ['trialCandidateRole']);
    const payload: Values = { version: deal.version };
    const local: Record<string, string> = {};
    for (const [key, value] of Object.entries(diff)) {
      if (key === 'monthlyValue' || key === 'oneTimeValue') {
        const minor = parseMoneyInput(String(value));
        if (minor === null) local[key] = 'Enter an amount like 4500 or 4500.50.';
        else
          payload[key === 'monthlyValue' ? 'monthlyValueMinor' : 'oneTimeValueMinor'] =
            minor.toString();
      } else if (key === 'termMonths' || key === 'fteCount') {
        payload[key] = Number(value);
      } else if (key === 'probability') {
        payload[key] = value === '' ? null : Number(value);
      } else if (key === 'expectedCloseDate') {
        payload[key] = value === '' ? null : value;
      } else {
        payload[key] = value;
      }
    }
    if (Object.keys(local).length > 0) {
      for (const [k, v] of Object.entries(local)) clientErrors.set(k, v);
      return;
    }
    if (Object.keys(payload).length === 1) {
      onClose();
      return;
    }
    run(payload, (e) => {
      for (const key of Object.keys(clientErrors.values)) clientErrors.set(key, '');
      for (const [k, v] of Object.entries(e)) {
        const field =
          k === 'monthlyValueMinor'
            ? 'monthlyValue'
            : k === 'oneTimeValueMinor'
              ? 'oneTimeValue'
              : k;
        clientErrors.set(field, v);
      }
    });
  };
  const monthlyErr = errors['monthlyValue'] || errors['monthlyValueMinor'];
  const oneTimeErr = errors['oneTimeValue'] || errors['oneTimeValueMinor'];

  return (
    <EditDrawer
      title={`Edit ${deal.name}`}
      description={`${deal.stage_name} · ${deal.company_name ?? ''}`}
      formId="deal-edit-form"
      pending={mutation.isPending}
      error={formError(mutation.error)}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Deal name" error={errors['name'] || undefined}>
        <Input value={values.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="Monthly value" error={monthlyErr || undefined}>
          <Input
            inputMode="decimal"
            value={values.monthlyValue}
            onChange={(e) => set('monthlyValue', e.target.value)}
            invalid={Boolean(monthlyErr)}
          />
        </Field>
        <Field label="Currency">
          <Select
            value={values.currency}
            onChange={(e) => set('currency', e.target.value as never)}
          >
            <option value="USD">US dollars (US$)</option>
            <option value="CAD">Canadian dollars (CA$)</option>
          </Select>
        </Field>
        <Field label="Term in months" error={errors['termMonths'] || undefined}>
          <Input
            type="number"
            min={1}
            max={120}
            value={values.termMonths}
            onChange={(e) => set('termMonths', e.target.value)}
          />
        </Field>
        <Field label="One-time fees" optional error={oneTimeErr || undefined}>
          <Input
            inputMode="decimal"
            value={values.oneTimeValue}
            onChange={(e) => set('oneTimeValue', e.target.value)}
            invalid={Boolean(oneTimeErr)}
          />
        </Field>
        <Field label="Staff (FTE)" error={errors['fteCount'] || undefined}>
          <Input
            type="number"
            min={0.5}
            step={0.5}
            value={values.fteCount}
            onChange={(e) => set('fteCount', e.target.value)}
          />
        </Field>
        <Field label="Engagement model" optional>
          <Select
            value={values.engagementModel}
            onChange={(e) => set('engagementModel', e.target.value)}
          >
            <option value="">Not set</option>
            {[...new Set([...(refs.data?.['engagement_models'] ?? []), values.engagementModel])]
              .filter(Boolean)
              .map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Win chance (%)" optional error={errors['probability'] || undefined}>
          <Input
            type="number"
            min={0}
            max={100}
            placeholder={`Stage default`}
            value={values.probability}
            onChange={(e) => set('probability', e.target.value)}
          />
        </Field>
        <Field label="Expected close" optional error={errors['expectedCloseDate'] || undefined}>
          <Input
            type="date"
            value={values.expectedCloseDate}
            onChange={(e) => set('expectedCloseDate', e.target.value)}
          />
        </Field>
        <Field label="Trial role" optional>
          <Input
            value={values.trialCandidateRole}
            onChange={(e) => set('trialCandidateRole', e.target.value)}
          />
        </Field>
        <OwnerField
          me={me}
          capability="deals.write"
          value={values.ownerUserId}
          onChange={(v) => set('ownerUserId', v)}
          error={errors['ownerUserId'] || undefined}
        />
      </div>
      <CheckboxGroup
        legend="Services"
        options={refs.data?.['services'] ?? []}
        value={values.services}
        onChange={(v) => set('services', v)}
      />
    </EditDrawer>
  );
}
