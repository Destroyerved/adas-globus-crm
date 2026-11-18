import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateScoringRuleInputSchema,
  SCORING_CATEGORIES,
  SCORING_FIELD_PATHS,
  SCORING_OPERATORS,
  UpdateScoringRuleInputSchema,
  formatNumber,
  type CreateScoringRuleInput,
  type ScoringCategory,
  type ScoringFieldPath,
  type ScoringOperator,
  type ScoringRuleView,
  type UpdateScoringRuleInput,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import {
  EditDrawer,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
} from '@/features/records/record-form.js';
import { FormRow } from './settings-kit.js';

const CATEGORY_LABEL: Record<ScoringCategory, string> = {
  fit: 'Firm fit',
  engagement: 'Engagement',
  negative: 'Negative signal',
};

const CATEGORY_TONE: Record<ScoringCategory, 'brand' | 'success' | 'danger'> = {
  fit: 'brand',
  engagement: 'success',
  negative: 'danger',
};

const FIELD_LABEL: Record<ScoringFieldPath, string> = {
  staffBand: 'Firm size (staff band)',
  title: 'Job title',
  market: 'Market (US / CA / OTHER)',
  source: 'Lead source',
  softwareStack: 'Accounting software',
  servicesNeeded: 'Services needed',
  hasCallOrMeeting: 'Logged call or meeting',
  missingDomain: 'Personal email without corporate domain',
};

const OPERATOR_LABEL: Record<ScoringOperator, string> = {
  eq: 'equals',
  contains: 'contains',
  in: 'is one of (comma-separated)',
  gt: 'greater than',
  isTrue: 'is true / false',
};

function formatTarget(operator: ScoringOperator, value: unknown): string {
  if (operator === 'isTrue') return value === false ? 'false' : 'true';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value ?? '');
}

function parseTarget(operator: ScoringOperator, text: string): unknown {
  if (operator === 'isTrue') return text !== 'false';
  if (operator === 'in') {
    return text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (operator === 'gt') {
    const n = Number(text.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return text.trim();
}

/**
 * Settings → Scoring (PRD 4.5, 4.16, 4.17): configurable rule-based lead & contact scoring.
 */
export function ScoringTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScoringRuleView | null>(null);
  const [deleting, setDeleting] = useState<ScoringRuleView | null>(null);

  const rulesQuery = useQuery({
    queryKey: ['admin', 'scoring-rules'],
    queryFn: api.listScoringRules,
  });

  const recalc = useMutation({
    mutationFn: api.recalculateScores,
    onSuccess: async (res) => {
      toast(
        `Recalculated ${formatNumber(res.leadsUpdated)} leads and ${formatNumber(res.contactsUpdated)} contacts.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leads'] }),
        queryClient.invalidateQueries({ queryKey: ['contacts'] }),
      ]);
    },
  });

  const toggleActive = useMutation({
    mutationFn: (rule: ScoringRuleView) =>
      api.updateScoringRule(rule.id, { version: rule.version, active: !rule.active }),
    onSuccess: async (updated) => {
      toast(updated.active ? `Enabled "${updated.name}".` : `Paused "${updated.name}".`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'scoring-rules'] });
    },
  });

  const remove = useMutation({
    mutationFn: (ruleId: string) => api.deleteScoringRule(ruleId),
    onSuccess: async () => {
      toast('Deleted scoring rule.');
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'scoring-rules'] });
    },
  });

  return (
    <div className="space-y-[16px]" data-testid="settings-scoring-tab">
      <Callout>
        <div className="flex flex-wrap items-center justify-between gap-[10px]">
          <p className="m-0 text-[13.5px] text-ink">
            Scores combine firm fit, real engagement (calls, meetings and inquiries) and deductions
            between 0 and 100. Email opens are never scored because automated security scanners
            trigger false opens.
          </p>
          <div className="flex flex-wrap gap-[8px]">
            <Button variant="secondary" disabled={recalc.isPending} onClick={() => recalc.mutate()}>
              {recalc.isPending ? 'Recalculating…' : 'Recalculate all scores'}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add scoring rule
            </Button>
          </div>
        </div>
      </Callout>

      {(recalc.isError || toggleActive.isError) && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(recalc.error ?? toggleActive.error)}
        </p>
      )}

      {rulesQuery.isPending ? (
        <LoadingState rows={5} />
      ) : rulesQuery.isError ? (
        <ErrorState
          message={errorMessage(rulesQuery.error)}
          onRetry={() => void rulesQuery.refetch()}
        />
      ) : rulesQuery.data.length === 0 ? (
        <Panel padded={false}>
          <EmptyState
            title="No scoring rules yet"
            description="Add fit and engagement rules so reps can sort leads by firm suitability and verified conversations."
            actionLabel="Add scoring rule"
            onAction={() => setCreating(true)}
          />
        </Panel>
      ) : (
        <Panel title={`Scoring rules (${rulesQuery.data.length})`} padded={false}>
          <ul className="m-0 p-0 list-none divide-y divide-line">
            {rulesQuery.data.map((rule) => {
              const positive = rule.points >= 0;
              return (
                <li
                  key={rule.id}
                  className="px-[16px] py-[12px] flex flex-wrap items-start justify-between gap-[10px]"
                >
                  <div className="min-w-0 space-y-[4px]">
                    <div className="flex flex-wrap items-center gap-[8px]">
                      <span className="font-semibold text-ink break-words">{rule.name}</span>
                      <StatusBadge tone={CATEGORY_TONE[rule.category]}>
                        {CATEGORY_LABEL[rule.category]}
                      </StatusBadge>
                      <span
                        className={`tabular-nums text-[13px] font-semibold ${positive ? 'text-success' : 'text-danger'}`}
                      >
                        {positive ? `+${formatNumber(rule.points)}` : formatNumber(rule.points)} pts
                      </span>
                      {!rule.active && <StatusBadge tone="neutral">Paused</StatusBadge>}
                    </div>
                    <div className="text-[12.5px] text-ink-2 break-words">
                      When <strong>{FIELD_LABEL[rule.fieldPath]}</strong>{' '}
                      {OPERATOR_LABEL[rule.operator]}{' '}
                      <code>{formatTarget(rule.operator, rule.targetValue)}</code>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-[6px]">
                    <Button variant="secondary" size="sm" onClick={() => setEditing(rule)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggleActive.isPending}
                      onClick={() => toggleActive.mutate(rule)}
                    >
                      {rule.active ? 'Pause' : 'Enable'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        remove.reset();
                        setDeleting(rule);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {creating && (
        <ScoringRuleDrawer
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await queryClient.invalidateQueries({ queryKey: ['admin', 'scoring-rules'] });
          }}
        />
      )}

      {editing && (
        <ScoringRuleDrawer
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await queryClient.invalidateQueries({ queryKey: ['admin', 'scoring-rules'] });
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={deleting ? `Delete "${deleting.name}"?` : 'Delete scoring rule?'}
        body="Existing scores keep their current value until a record is updated or you run Recalculate all scores."
        confirmLabel="Delete rule"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </div>
  );
}

function ScoringRuleDrawer({
  existing,
  onClose,
  onSaved,
}: {
  existing?: ScoringRuleView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { values, set } = useDraft({
    name: existing?.name ?? '',
    category: (existing?.category ?? 'fit') as ScoringCategory,
    fieldPath: (existing?.fieldPath ?? 'staffBand') as ScoringFieldPath,
    operator: (existing?.operator ?? 'in') as ScoringOperator,
    targetText: existing ? formatTarget(existing.operator, existing.targetValue) : '',
    points: String(existing?.points ?? 15),
    active: existing?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: (payload: CreateScoringRuleInput) => api.createScoringRule(payload),
    onSuccess: (created) => {
      toast(`Created "${created.name}".`);
      onSaved();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });

  const update = useMutation({
    mutationFn: (payload: UpdateScoringRuleInput) =>
      api.updateScoringRule((existing as ScoringRuleView).id, payload),
    onSuccess: (updated) => {
      toast(`Saved "${updated.name}".`);
      onSaved();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });

  const submit = () => {
    const targetValue = parseTarget(values.operator, values.targetText);
    const pointsNum = Number(values.points);
    const nextErrors: Record<string, string> = {};

    if (!Number.isInteger(pointsNum) || pointsNum < -100 || pointsNum > 100 || pointsNum === 0) {
      nextErrors['points'] = 'Enter a non-zero whole number between -100 and 100.';
    }
    if (values.operator === 'in' && (!Array.isArray(targetValue) || targetValue.length === 0)) {
      nextErrors['targetValue'] = 'Enter at least one comma-separated value.';
    } else if (values.operator === 'gt' && !Number.isFinite(targetValue)) {
      nextErrors['targetValue'] = 'Enter a valid number.';
    } else if (
      (values.operator === 'eq' || values.operator === 'contains') &&
      (!targetValue || String(targetValue).trim().length === 0)
    ) {
      nextErrors['targetValue'] = 'Enter a value to match.';
    }

    if (existing) {
      const payload: UpdateScoringRuleInput = {
        version: existing.version,
        name: values.name.trim(),
        category: values.category,
        fieldPath: values.fieldPath,
        operator: values.operator,
        targetValue,
        points: pointsNum,
        active: values.active,
      };
      const issues = { ...issuesOf(UpdateScoringRuleInputSchema, payload), ...nextErrors };
      setErrors(issues);
      if (Object.keys(issues).length === 0) update.mutate(payload);
    } else {
      const payload: CreateScoringRuleInput = {
        name: values.name.trim(),
        category: values.category,
        fieldPath: values.fieldPath,
        operator: values.operator,
        targetValue,
        points: pointsNum,
        active: values.active,
      };
      const issues = { ...issuesOf(CreateScoringRuleInputSchema, payload), ...nextErrors };
      setErrors(issues);
      if (Object.keys(issues).length === 0) create.mutate(payload);
    }
  };

  const pending = create.isPending || update.isPending;
  const mutError = create.error ?? update.error;

  return (
    <EditDrawer
      title={existing ? `Edit ${existing.name}` : 'Add scoring rule'}
      description="Matched rules add or subtract points; total score is clamped between 0 and 100."
      formId="scoring-rule-form"
      pending={pending}
      error={mutError && Object.keys(errors).length === 0 ? formError(mutError) : null}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={existing ? 'Save rule' : 'Create rule'}
    >
      <FormRow id="sr-name" label="Rule name" error={errors['name']}>
        <Input
          id="sr-name"
          value={values.name}
          invalid={Boolean(errors['name'])}
          placeholder="CPA firm with 11–200 staff"
          onChange={(e) => set('name', e.target.value)}
        />
      </FormRow>

      <div className="grid gap-[12px] sm:grid-cols-2">
        <FormRow id="sr-category" label="Category" error={errors['category']}>
          <Select
            id="sr-category"
            value={values.category}
            onChange={(e) => set('category', e.target.value as ScoringCategory)}
          >
            {SCORING_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </FormRow>

        <FormRow id="sr-points" label="Points (-100 to +100)" error={errors['points']}>
          <Input
            id="sr-points"
            type="number"
            min={-100}
            max={100}
            value={values.points}
            invalid={Boolean(errors['points'])}
            onChange={(e) => set('points', e.target.value)}
          />
        </FormRow>
      </div>

      <FormRow id="sr-field" label="Signal" error={errors['fieldPath']}>
        <Select
          id="sr-field"
          value={values.fieldPath}
          onChange={(e) => {
            const nextField = e.target.value as ScoringFieldPath;
            set('fieldPath', nextField);
            if (nextField === 'hasCallOrMeeting' || nextField === 'missingDomain') {
              set('operator', 'isTrue');
              set('targetText', 'true');
            }
          }}
        >
          {SCORING_FIELD_PATHS.map((f) => (
            <option key={f} value={f}>
              {FIELD_LABEL[f]}
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow id="sr-operator" label="Condition" error={errors['operator']}>
        <Select
          id="sr-operator"
          value={values.operator}
          onChange={(e) => {
            const nextOp = e.target.value as ScoringOperator;
            set('operator', nextOp);
            if (
              nextOp === 'isTrue' &&
              values.targetText !== 'true' &&
              values.targetText !== 'false'
            ) {
              set('targetText', 'true');
            }
          }}
        >
          {SCORING_OPERATORS.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABEL[op]}
            </option>
          ))}
        </Select>
      </FormRow>

      <FormRow
        id="sr-target"
        label="Match value"
        hint={
          values.operator === 'in'
            ? 'Separate values with commas, for example: 11–20, 21–50, 51–200'
            : undefined
        }
        error={errors['targetValue']}
      >
        {values.operator === 'isTrue' ? (
          <Select
            id="sr-target"
            value={values.targetText === 'false' ? 'false' : 'true'}
            onChange={(e) => set('targetText', e.target.value)}
          >
            <option value="true">True</option>
            <option value="false">False</option>
          </Select>
        ) : (
          <Input
            id="sr-target"
            value={values.targetText}
            invalid={Boolean(errors['targetValue'])}
            placeholder={values.operator === 'in' ? 'Partner, Principal, Managing Partner' : 'US'}
            onChange={(e) => set('targetText', e.target.value)}
          />
        )}
      </FormRow>

      <label className="flex items-center gap-[8px] text-[13.5px] text-ink cursor-pointer">
        <input
          type="checkbox"
          checked={values.active}
          onChange={(e) => set('active', e.target.checked)}
          className="accent-[var(--primary)]"
        />
        <span>Rule is active</span>
      </label>
    </EditDrawer>
  );
}
