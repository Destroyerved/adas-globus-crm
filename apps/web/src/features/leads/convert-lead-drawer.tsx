import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ConvertLeadInputSchema,
  formatMoney,
  parseMoneyInput,
  type ConvertLeadInput,
  type Currency,
} from '@adas/shared';
import { Input } from '@/components/ui/input.js';
import { Callout } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type LeadRow } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import {
  CheckboxGroup,
  EditDrawer,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
} from '@/features/records/record-form.js';
import { FormRow } from '@/features/settings/settings-kit.js';

type DealMode = 'new' | 'existing' | 'none';

/**
 * Interactive Lead Conversion Drawer (PRD 3.2, 4.5, 4.6):
 * creates or matches the Contact and Company, and lets the owner create a new Deal (choosing
 * pipeline, stage, monthly value, term, FTEs, services and 3-day Free Trial) or link an open Deal.
 */
export function ConvertLeadDrawer({
  lead,
  onClose,
  onConverted,
}: {
  lead: LeadRow;
  onClose: () => void;
  onConverted: (result: {
    leadId: string;
    companyId: string | null;
    contactId: string;
    dealId: string | null;
  }) => void;
}) {
  const toast = useToast();
  const defaultFirm = lead.firm_name?.trim() || lead.full_name;
  const defaultCurrency: Currency = lead.market === 'CA' ? 'CAD' : 'USD';
  const defaultServices =
    lead.services_needed && lead.services_needed.length > 0
      ? lead.services_needed
      : ['Tax preparation and review'];

  const pipelinesQuery = useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
  const refsQuery = useQuery({ queryKey: ['reference-lists'], queryFn: api.referenceLists });
  const companyProfileQuery = useQuery({
    queryKey: ['company', lead.company_id],
    queryFn: () => api.getCompanyProfile(lead.company_id as string),
    enabled: Boolean(lead.company_id),
  });

  const openDeals = useMemo(
    () => (companyProfileQuery.data?.deals ?? []).filter((d) => d.stage_category === 'open'),
    [companyProfileQuery.data],
  );

  const [dealMode, setDealMode] = useState<DealMode>('new');
  const { values, set } = useDraft({
    pipelineId: 'pipeline_new_business',
    stageId: '',
    existingDealId: '',
    dealName: `${defaultFirm} — Accounting Staffing`,
    currency: defaultCurrency,
    monthlyAmount: '4800',
    termMonths: '12',
    fteCount: '1',
    engagementModel: 'Full-time',
    services: defaultServices,
    startFreeTrial: false,
    trialCandidateRole: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const pipelines = pipelinesQuery.data ?? [];
  const selectedPipeline =
    pipelines.find((p) => p.id === values.pipelineId) ??
    pipelines.find((p) => p.is_default) ??
    pipelines[0];
  const openStages = (selectedPipeline?.stages ?? []).filter((s) => s.category === 'open');
  const activeStage = openStages.find((s) => s.id === values.stageId) ?? openStages[0] ?? null;
  const needsTrialRole = Boolean(values.startFreeTrial || activeStage?.is_trial);

  const convert = useMutation({
    mutationFn: (payload: ConvertLeadInput) => api.convertLead(payload),
    onSuccess: (result) => {
      toast(
        result.dealId
          ? `Converted ${lead.full_name} and opened the deal.`
          : `Converted ${lead.full_name} to a contact.`,
      );
      onConverted(result);
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });

  const submit = () => {
    const nextErrors: Record<string, string> = {};
    const minor = parseMoneyInput(values.monthlyAmount);
    if (dealMode === 'new' && minor === null) {
      nextErrors['monthlyValueMinor'] = 'Enter a non-negative monthly amount.';
    }
    if (dealMode === 'existing' && !values.existingDealId) {
      nextErrors['existingDealId'] = 'Choose an open deal to link.';
    }
    if (dealMode === 'new' && needsTrialRole && !values.trialCandidateRole.trim()) {
      nextErrors['trialCandidateRole'] = 'Enter the candidate role for the 3-day free trial.';
    }

    const payload: ConvertLeadInput = {
      leadId: lead.id,
      createDeal: dealMode === 'new',
      existingDealId: dealMode === 'existing' ? values.existingDealId : null,
      pipelineId: selectedPipeline?.id ?? values.pipelineId,
      stageId: dealMode === 'new' && activeStage ? activeStage.id : null,
      dealName: values.dealName.trim() || undefined,
      monthlyValueMinor: (minor ?? 0n).toString(),
      termMonths: Number(values.termMonths) || 12,
      currency: values.currency,
      fteCount: Number(values.fteCount) || 1,
      engagementModel: values.engagementModel,
      services: values.services,
      startFreeTrial: values.startFreeTrial,
      trialCandidateRole: values.trialCandidateRole.trim() || null,
    };

    const schemaIssues = issuesOf(ConvertLeadInputSchema, payload);
    const mergedErrors = { ...schemaIssues, ...nextErrors };
    setErrors(mergedErrors);
    if (Object.keys(mergedErrors).length === 0) {
      convert.mutate(payload);
    }
  };

  const engagementModels = refsQuery.data?.['engagement_models'] ?? [
    'Full-time',
    'Part-time',
    'Seasonal',
    'Trial-first',
  ];
  const serviceOptions = refsQuery.data?.['services'] ?? defaultServices;

  return (
    <EditDrawer
      title={`Convert ${lead.full_name}`}
      description="Create or match the contact and company, and optionally open or link a staffing deal."
      formId="convert-lead-form"
      pending={convert.isPending}
      error={convert.isError && Object.keys(errors).length === 0 ? formError(convert.error) : null}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Convert lead"
    >
      {pipelinesQuery.isPending ? (
        <LoadingState rows={4} />
      ) : pipelinesQuery.isError ? (
        <ErrorState
          message={errorMessage(pipelinesQuery.error)}
          onRetry={() => void pipelinesQuery.refetch()}
        />
      ) : (
        <>
          <Callout>
            <div className="text-[13px] text-ink">
              <strong>Contact:</strong> {lead.full_name} ({lead.email})
              {lead.firm_name || lead.domain ? (
                <>
                  {' '}
                  · <strong>Company:</strong> {lead.firm_name ?? lead.domain}
                </>
              ) : (
                <> · Personal email without a firm name (no company will be created)</>
              )}
            </div>
          </Callout>

          <FormRow id="convert-deal-mode" label="Opportunity">
            <Select
              id="convert-deal-mode"
              value={dealMode}
              onChange={(e) => setDealMode(e.target.value as DealMode)}
            >
              <option value="new">Create a new deal</option>
              {openDeals.length > 0 && (
                <option value="existing">Link an existing open deal ({openDeals.length})</option>
              )}
              <option value="none">Convert to contact &amp; company only</option>
            </Select>
          </FormRow>

          {dealMode === 'existing' && (
            <FormRow id="convert-existing-deal" label="Open deal" error={errors['existingDealId']}>
              <Select
                id="convert-existing-deal"
                value={values.existingDealId}
                onChange={(e) => set('existingDealId', e.target.value)}
              >
                <option value="">Choose an open deal…</option>
                {openDeals.map((deal) => (
                  <option key={deal.id} value={deal.id}>
                    {deal.name} ({deal.stage_name} ·{' '}
                    {formatMoney(
                      { amountMinor: BigInt(deal.monthly_value_minor), currency: deal.currency },
                      { perMonth: true },
                    )}
                    )
                  </option>
                ))}
              </Select>
            </FormRow>
          )}

          {dealMode === 'new' && (
            <>
              <div className="grid gap-[12px] sm:grid-cols-2">
                <FormRow id="convert-pipeline" label="Pipeline" error={errors['pipelineId']}>
                  <Select
                    id="convert-pipeline"
                    value={selectedPipeline?.id ?? ''}
                    onChange={(e) => {
                      set('pipelineId', e.target.value);
                      set('stageId', '');
                    }}
                  >
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </FormRow>

                <FormRow id="convert-stage" label="Starting stage" error={errors['stageId']}>
                  <Select
                    id="convert-stage"
                    value={activeStage?.id ?? ''}
                    disabled={values.startFreeTrial}
                    onChange={(e) => set('stageId', e.target.value)}
                  >
                    {openStages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.probability}%)
                      </option>
                    ))}
                  </Select>
                </FormRow>
              </div>

              <FormRow id="convert-deal-name" label="Deal name" error={errors['dealName']}>
                <Input
                  id="convert-deal-name"
                  value={values.dealName}
                  invalid={Boolean(errors['dealName'])}
                  onChange={(e) => set('dealName', e.target.value)}
                />
              </FormRow>

              <div className="grid gap-[12px] sm:grid-cols-3">
                <FormRow id="convert-currency" label="Currency" error={errors['currency']}>
                  <Select
                    id="convert-currency"
                    value={values.currency}
                    onChange={(e) => set('currency', e.target.value as Currency)}
                  >
                    <option value="USD">USD</option>
                    <option value="CAD">CAD</option>
                  </Select>
                </FormRow>

                <FormRow
                  id="convert-monthly"
                  label="Monthly fee"
                  error={errors['monthlyValueMinor']}
                >
                  <Input
                    id="convert-monthly"
                    inputMode="decimal"
                    value={values.monthlyAmount}
                    invalid={Boolean(errors['monthlyValueMinor'])}
                    onChange={(e) => set('monthlyAmount', e.target.value)}
                  />
                </FormRow>

                <FormRow id="convert-term" label="Term (months)" error={errors['termMonths']}>
                  <Input
                    id="convert-term"
                    type="number"
                    min={1}
                    max={120}
                    value={values.termMonths}
                    invalid={Boolean(errors['termMonths'])}
                    onChange={(e) => set('termMonths', e.target.value)}
                  />
                </FormRow>
              </div>

              <div className="grid gap-[12px] sm:grid-cols-2">
                <FormRow id="convert-fte" label="Staff (FTE)" error={errors['fteCount']}>
                  <Input
                    id="convert-fte"
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={values.fteCount}
                    invalid={Boolean(errors['fteCount'])}
                    onChange={(e) => set('fteCount', e.target.value)}
                  />
                </FormRow>

                <FormRow
                  id="convert-engagement"
                  label="Engagement model"
                  error={errors['engagementModel']}
                >
                  <Select
                    id="convert-engagement"
                    value={values.engagementModel}
                    onChange={(e) => set('engagementModel', e.target.value)}
                  >
                    {engagementModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </FormRow>
              </div>

              <CheckboxGroup
                legend="Services"
                options={serviceOptions}
                value={values.services}
                onChange={(next) => set('services', next)}
              />

              <label className="flex items-start gap-[8px] text-[13.5px] text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={values.startFreeTrial}
                  onChange={(e) => set('startFreeTrial', e.target.checked)}
                  className="mt-[3px] accent-[var(--primary)]"
                />
                <span>
                  Start a 3-day free trial immediately (moves to Free Trial stage and creates the
                  check-in task)
                </span>
              </label>

              {needsTrialRole && (
                <FormRow
                  id="convert-trial-role"
                  label="Trial candidate role"
                  hint="For example: Senior US Tax Preparer (UltraTax)"
                  error={errors['trialCandidateRole']}
                >
                  <Input
                    id="convert-trial-role"
                    value={values.trialCandidateRole}
                    invalid={Boolean(errors['trialCandidateRole'])}
                    onChange={(e) => set('trialCandidateRole', e.target.value)}
                    placeholder="Senior Tax Preparer"
                  />
                </FormRow>
              )}
            </>
          )}
        </>
      )}
    </EditDrawer>
  );
}
