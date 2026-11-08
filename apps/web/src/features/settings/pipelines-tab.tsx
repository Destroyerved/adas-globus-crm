import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  CreateStageInputSchema,
  UpdateStageInputSchema,
  formatNumber,
  type StageRequiredField,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type AdminPipelineRow, type AdminStageRow } from '@/lib/api.js';
import {
  DataPanel,
  errorMessage,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import {
  EditDrawer,
  changedFields,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
} from '@/features/records/record-form.js';
import { FormRow } from './settings-kit.js';

const REQUIRED_LABEL: Record<StageRequiredField, string> = {
  primary_contact_id: 'Primary contact',
  trial_candidate_role: 'Trial role',
  contract_start_date: 'Contract start date',
  lost_reason: 'Lost reason',
};

const CATEGORY: Record<string, { label: string; tone: 'brand' | 'success' | 'danger' }> = {
  open: { label: 'Open', tone: 'brand' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'danger' },
};

/** Pipelines and stages (PRD 3.3): names, probability, idle warning and required details. */
export function PipelinesTab() {
  const pipelines = useQuery({ queryKey: ['admin', 'pipelines'], queryFn: api.adminPipelines });
  const [pipelineId, setPipelineId] = useState('');
  const items = pipelines.data ?? [];
  const pipeline = items.find((p) => p.id === pipelineId) ?? items[0];

  return (
    <div className="space-y-[12px]">
      {items.length > 1 && (
        <div role="tablist" aria-label="Pipelines" className="flex gap-[20px] border-b border-line">
          {items.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === pipeline?.id}
              className="view-tab"
              onClick={() => setPipelineId(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <DataPanel
        query={pipelines}
        isEmpty={items.length === 0}
        emptyTitle="No pipelines"
        emptyDescription="Pipelines come with the CRM. Reload the page."
      >
        {pipeline && <StageTable pipeline={pipeline} />}
      </DataPanel>
    </div>
  );
}

function StageTable({ pipeline }: { pipeline: AdminPipelineRow }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminStageRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<AdminStageRow | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'pipelines'] }),
      queryClient.invalidateQueries({ queryKey: ['pipelines'] }),
      queryClient.invalidateQueries({ queryKey: ['board'] }),
    ]);
  const move = useMutation({
    mutationFn: (input: { stage: AdminStageRow; direction: 'up' | 'down' }) =>
      api.moveStage(input.stage.id, input.stage.version, input.direction),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (stage: AdminStageRow) => api.deleteStage(stage.id),
    onSuccess: async () => {
      toast(`Removed ${removing?.name ?? 'the stage'}.`);
      setRemoving(null);
      await refresh();
    },
  });
  const open = pipeline.stages.filter((s) => s.category === 'open');

  return (
    <div>
      <table className={tableClass}>
        <caption className="sr-only">Stages in {pipeline.name}</caption>
        <thead>
          <tr className={theadRowClass}>
            <th className={thClass}>Stage</th>
            <th className={`${thClass} text-right`}>Probability</th>
            <th className={`${thClass} text-right hidden md:table-cell`}>Idle after</th>
            <th className={`${thClass} hidden lg:table-cell`}>Needs first</th>
            <th className={`${thClass} text-right hidden sm:table-cell`}>Deals</th>
            <th className={thClass}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {pipeline.stages.map((s) => {
            const index = open.findIndex((o) => o.id === s.id);
            const category = CATEGORY[s.category] ?? CATEGORY['open'];
            return (
              <tr key={s.id} className={rowClass}>
                <td className={tdClass}>
                  <div className="flex flex-wrap items-center gap-[6px]">
                    <span className="font-semibold text-ink">{s.name}</span>
                    {category && <StatusBadge tone={category.tone}>{category.label}</StatusBadge>}
                    {s.is_trial && <StatusBadge tone="info">Free trial</StatusBadge>}
                  </div>
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>{s.probability}%</td>
                <td className={`${tdClass} text-right tabular-nums hidden md:table-cell`}>
                  {s.category === 'open' ? `${formatNumber(s.idle_days)} days` : '—'}
                </td>
                <td className={`${tdClass} hidden lg:table-cell text-ink-2`}>
                  {s.required_fields.length
                    ? s.required_fields
                        .map((f) => REQUIRED_LABEL[f as StageRequiredField] ?? f)
                        .join(', ')
                    : '—'}
                </td>
                <td className={`${tdClass} text-right tabular-nums hidden sm:table-cell`}>
                  {formatNumber(s.deal_count)}
                </td>
                <td className={`${tdClass} text-right whitespace-nowrap`}>
                  {/* Fixed slots keep the buttons in the same columns on every row. */}
                  <span className="inline-flex items-center justify-end">
                    <span className="inline-flex w-[72px] justify-end">
                      {s.category === 'open' && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move ${s.name} up`}
                            disabled={index <= 0 || move.isPending}
                            onClick={() => move.mutate({ stage: s, direction: 'up' })}
                          >
                            <ArrowUp size={16} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move ${s.name} down`}
                            disabled={index === open.length - 1 || move.isPending}
                            onClick={() => move.mutate({ stage: s, direction: 'down' })}
                          >
                            <ArrowDown size={16} aria-hidden="true" />
                          </Button>
                        </>
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${s.name}`}
                      onClick={() => setEditing(s)}
                    >
                      Edit
                    </Button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-[8px] px-[12px] py-[12px] border-t border-line">
        <p className="m-0 text-[13px] text-ink-3">
          New stages go before Won. Won is always 100% and lost is always 0%.
        </p>
        {move.isError && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {errorMessage(move.error)}
          </p>
        )}
        <Button variant="secondary" onClick={() => setEditing('new')}>
          Add stage
        </Button>
      </div>
      {editing && (
        <StageDrawer
          pipeline={pipeline}
          stage={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
          onRemove={
            editing !== 'new' &&
            editing.category === 'open' &&
            editing.deal_count === 0 &&
            open.length > 1
              ? () => {
                  setRemoving(editing);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'stage'}?`}
        body="No deals are in this stage. Its history stays on the deals that passed through it."
        confirmLabel="Remove stage"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => removing && remove.mutate(removing)}
        onCancel={() => {
          setRemoving(null);
          remove.reset();
        }}
      />
    </div>
  );
}

function StageDrawer({
  pipeline,
  stage,
  onClose,
  onSaved,
  onRemove,
}: {
  pipeline: AdminPipelineRow;
  stage: AdminStageRow | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
  /** Present only when the stage can be removed: open, empty and not the last open stage. */
  onRemove?: () => void;
}) {
  const toast = useToast();
  const initial = {
    name: stage?.name ?? '',
    probability: stage?.probability ?? 50,
    idleDays: stage?.idle_days ?? 14,
    requiredFields: (stage?.required_fields ?? []) as StageRequiredField[],
    isTrial: stage?.is_trial ?? false,
  };
  const { values, set } = useDraft(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const category = stage?.category ?? 'open';
  const changes = changedFields(initial, values);
  const save = useMutation({
    mutationFn: () =>
      stage
        ? api.updateStage(stage.id, { version: stage.version, ...changes })
        : api.createStage(pipeline.id, {
            name: values.name,
            probability: values.probability,
            idleDays: values.idleDays,
          }),
    onSuccess: async (saved) => {
      toast(stage ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
      await onSaved();
      onClose();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });
  const submit = () => {
    if (stage && Object.keys(changes).length === 0) return onClose();
    const issues = stage
      ? issuesOf(UpdateStageInputSchema, { version: stage.version, ...changes })
      : issuesOf(CreateStageInputSchema, values);
    setErrors(issues);
    if (Object.keys(issues).length === 0) save.mutate();
  };
  const toggleField = (field: StageRequiredField, on: boolean) =>
    set(
      'requiredFields',
      on ? [...values.requiredFields, field] : values.requiredFields.filter((f) => f !== field),
    );

  return (
    <EditDrawer
      title={stage ? `Edit ${stage.name}` : `Add a stage to ${pipeline.name}`}
      description={
        stage && stage.deal_count > 0
          ? `${formatNumber(stage.deal_count)} deals are in this stage. A new name or probability applies to them too.`
          : undefined
      }
      formId="stage-form"
      pending={save.isPending}
      error={save.isError && Object.keys(errors).length === 0 ? formError(save.error) : null}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={stage ? 'Save changes' : 'Add stage'}
    >
      <FormRow id="stage-name" label="Stage name" error={errors['name']}>
        <Input
          id="stage-name"
          value={values.name}
          invalid={Boolean(errors['name'])}
          onChange={(e) => set('name', e.target.value)}
        />
      </FormRow>
      <FormRow
        id="stage-probability"
        label="Probability (%)"
        hint={
          category === 'open'
            ? 'Used for the weighted pipeline unless a deal has its own.'
            : 'Fixed for won and lost stages.'
        }
        error={errors['probability']}
      >
        <Input
          id="stage-probability"
          type="number"
          min={0}
          max={100}
          disabled={category !== 'open'}
          value={String(values.probability)}
          invalid={Boolean(errors['probability'])}
          onChange={(e) => set('probability', Number(e.target.value))}
        />
      </FormRow>
      {category === 'open' && (
        <FormRow
          id="stage-idle"
          label="Flag as idle after (days)"
          hint="Deals with no activity for this long are flagged to their owner."
          error={errors['idleDays']}
        >
          <Input
            id="stage-idle"
            type="number"
            min={1}
            max={365}
            value={String(values.idleDays)}
            invalid={Boolean(errors['idleDays'])}
            onChange={(e) => set('idleDays', Number(e.target.value))}
          />
        </FormRow>
      )}
      {stage && (
        <fieldset className="m-0 p-0 border-0 grid gap-[6px]">
          <legend className="text-label text-ink mb-[6px]">Before a deal enters this stage</legend>
          {(Object.keys(REQUIRED_LABEL) as StageRequiredField[]).map((field) => {
            const forced = field === 'lost_reason' && category === 'lost';
            return (
              <label key={field} className="flex items-center gap-[8px] text-[14px] text-ink">
                <input
                  type="checkbox"
                  checked={forced || values.requiredFields.includes(field)}
                  disabled={forced}
                  onChange={(e) => toggleField(field, e.target.checked)}
                  className="h-[16px] w-[16px] accent-[var(--primary)]"
                />
                {REQUIRED_LABEL[field]} is required
              </label>
            );
          })}
          {errors['requiredFields'] && (
            <p className="m-0 text-[13px] text-danger">{errors['requiredFields']}</p>
          )}
        </fieldset>
      )}
      {stage && category === 'open' && (
        <label className="flex items-start gap-[8px] text-[14px] text-ink">
          <input
            type="checkbox"
            checked={values.isTrial}
            onChange={(e) => set('isTrial', e.target.checked)}
            className="mt-[3px] h-[16px] w-[16px] accent-[var(--primary)]"
          />
          <span>
            This is the free trial stage
            <span className="block text-[13px] text-ink-3">
              Entering it starts the 3-day trial and creates daily check-in tasks. One stage per
              pipeline.
            </span>
          </span>
        </label>
      )}
      {onRemove && (
        <div className="pt-[12px] border-t border-line">
          <Button type="button" variant="outline" onClick={onRemove}>
            Remove this stage
          </Button>
          <p className="m-0 mt-[6px] text-[13px] text-ink-3">
            No deals are in it. You'll be asked to confirm.
          </p>
        </div>
      )}
    </EditDrawer>
  );
}
