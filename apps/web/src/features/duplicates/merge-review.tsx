import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import {
  formatDate,
  type MergeEntity,
  type MergePreviewView,
  type MergeRecordView,
  type MergeSide,
  type MergeView,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { useMe } from '@/features/shared/list-kit.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { ApiError, api } from '@/lib/api.js';
import { describeMoved, entityNoun, entityPlural } from './merge-kit.js';

/**
 * Reviewing one possible duplicate (PRD 4.9): both records side by side, a choice per field,
 * what will move, then merge (undoable for 30 days) or mark them as not duplicates.
 */
export function MergeReview({
  pairId,
  onBack,
  onOpenRecord,
}: {
  pairId: string;
  onBack: () => void;
  onOpenRecord: (entity: MergeEntity, id: string) => void;
}) {
  const me = useMe();
  const tz = me?.timezone ?? 'UTC';
  const pair = useQuery({
    queryKey: ['duplicates', 'pair', pairId],
    queryFn: () => api.getDuplicate(pairId),
  });
  const [keepSecond, setKeepSecond] = useState(false);
  const [merged, setMerged] = useState<MergeView | null>(null);

  const back = (
    <Button variant="ghost" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
      All duplicates
    </Button>
  );

  if (merged) {
    return (
      <div className="space-y-[16px]" data-testid="merge-review">
        {back}
        <MergeDone merge={merged} timeZone={tz} onBack={onBack} onOpenRecord={onOpenRecord} />
      </div>
    );
  }
  if (pair.isPending) {
    return (
      <div className="space-y-[16px]">
        {back}
        <LoadingState rows={8} />
      </div>
    );
  }
  if (pair.isError) {
    // A pair that was merged, dismissed or lost a record no longer waits for review.
    const gone = pair.error instanceof ApiError && pair.error.status === 404;
    return (
      <div className="space-y-[16px]">
        {back}
        {gone ? (
          <Panel padded={false}>
            <EmptyState
              title="This pair is no longer waiting for review"
              description="Someone merged it or marked it as not duplicates, or one of the records was removed. Merges stay under Recent merges for 30 days."
              actionLabel="All duplicates"
              actionVariant="outline"
              onAction={onBack}
            />
          </Panel>
        ) : (
          <ErrorState message={errorMessage(pair.error)} onRetry={() => void pair.refetch()} />
        )}
      </div>
    );
  }

  const p = pair.data;
  const kept = keepSecond ? p.b : p.a;
  const other = keepSecond ? p.a : p.b;
  return (
    <div className="space-y-[16px]" data-testid="merge-review">
      {back}
      <div className="min-w-0">
        <div className="kicker mb-[4px]">Possible duplicate · {entityNoun(p.entity)}</div>
        <h1 className="text-title-lg text-ink m-0 break-words">
          {p.a.name} and {p.b.name}
        </h1>
        <p className="m-0 mt-[4px] text-[14px] text-ink-2">
          {p.reason} · found {p.foundBy === 'import' ? 'by an import' : 'by the regular check'} on{' '}
          {formatDate(p.createdAt, tz)}
        </p>
      </div>
      <MergeForm
        key={kept.id}
        entity={p.entity}
        pairId={p.id}
        keptId={kept.id}
        mergedId={other.id}
        timeZone={tz}
        onSwap={() => setKeepSecond((v) => !v)}
        onMerged={setMerged}
        onDismissed={onBack}
        onOpenRecord={onOpenRecord}
      />
    </div>
  );
}

function MergeForm({
  entity,
  pairId,
  keptId,
  mergedId,
  timeZone,
  onSwap,
  onMerged,
  onDismissed,
  onOpenRecord,
}: {
  entity: MergeEntity;
  pairId: string;
  keptId: string;
  mergedId: string;
  timeZone: string;
  onSwap: () => void;
  onMerged: (merge: MergeView) => void;
  onDismissed: () => void;
  onOpenRecord: (entity: MergeEntity, id: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const preview = useQuery({
    queryKey: ['merge-preview', entity, keptId, mergedId],
    queryFn: () => api.mergePreview(entity, keptId, mergedId),
  });
  const [take, setTake] = useState<Record<string, MergeSide> | null>(null);
  const [confirming, setConfirming] = useState(false);

  const merge = useMutation({
    mutationFn: (p: MergePreviewView) =>
      api.mergeRecords(entity, keptId, {
        mergedId,
        keptVersion: p.kept.version,
        mergedVersion: p.merged.version,
        take: take ?? p.defaults,
        candidateId: pairId,
      }),
    onSuccess: async (result) => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ['duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['merges'] });
      onMerged(result);
    },
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissDuplicate(pairId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['duplicates'] });
      toast('Marked as not duplicates.', 'success');
      onDismissed();
    },
  });

  if (preview.isPending) return <LoadingState rows={8} />;
  if (preview.isError) {
    return (
      <ErrorState message={errorMessage(preview.error)} onRetry={() => void preview.refetch()} />
    );
  }
  const p = preview.data;
  const choice = take ?? p.defaults;
  const noun = entityNoun(entity).toLowerCase();

  return (
    <>
      <div className="grid gap-[12px] sm:grid-cols-2">
        <RecordCard
          record={p.kept}
          kept
          entity={entity}
          timeZone={timeZone}
          onOpen={() => onOpenRecord(entity, p.kept.id)}
        />
        <RecordCard
          record={p.merged}
          kept={false}
          entity={entity}
          timeZone={timeZone}
          onSwap={onSwap}
          onOpen={() => onOpenRecord(entity, p.merged.id)}
        />
      </div>

      <Panel title="Choose what to keep">
        <p className="m-0 mb-[8px] text-[14px] text-ink-2">
          Pick the value the kept {noun} should have. Blank fields are filled from the other {noun}.
        </p>
        <div className="divide-y divide-line">
          {p.fields.map((field) => {
            const keptValue = p.kept.fields[field.key] ?? null;
            const mergedValue = p.merged.fields[field.key] ?? null;
            const labelId = `${id}-${field.key}`;
            if (keptValue === mergedValue) {
              return (
                <div
                  key={field.key}
                  className="py-[12px] grid gap-[4px] sm:grid-cols-[180px_1fr] sm:items-baseline"
                >
                  <div className="text-[14px] font-semibold text-ink">{field.label}</div>
                  <div className="text-[14px] text-ink-2 break-words">
                    {keptValue ?? <span className="text-ink-3">Blank</span>}
                    <span className="text-ink-3"> · same on both</span>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={field.key}
                role="radiogroup"
                aria-labelledby={labelId}
                className="py-[12px] grid gap-[8px] sm:grid-cols-[180px_1fr_1fr] sm:items-start"
              >
                <div id={labelId} className="text-[14px] font-semibold text-ink sm:pt-[8px]">
                  {field.label}
                </div>
                {(['kept', 'merged'] as const).map((side) => {
                  const value = side === 'kept' ? keptValue : mergedValue;
                  const checked = choice[field.key] === side;
                  const from = side === 'kept' ? p.kept.name : p.merged.name;
                  return (
                    <label
                      key={side}
                      className={`flex items-start gap-[8px] rounded-[8px] border px-[12px] py-[8px] cursor-pointer text-[14px] ${checked ? 'border-primary bg-tint' : 'border-line'}`}
                    >
                      <input
                        type="radio"
                        name={labelId}
                        value={side}
                        checked={checked}
                        onChange={() => setTake({ ...choice, [field.key]: side })}
                        className="mt-[3px] h-[16px] w-[16px] shrink-0 accent-[var(--primary)]"
                      />
                      <span className="min-w-0 break-words text-ink">
                        {value ?? <span className="text-ink-3">Blank</span>}
                        <span className="sr-only"> (from {from})</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
      </Panel>

      {p.notes.length > 0 && (
        <Callout>
          <ul className="m-0 pl-[18px] space-y-[4px]">
            {p.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Callout>
      )}

      {dismiss.error && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(dismiss.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button variant="primary" onClick={() => setConfirming(true)}>
          Merge {entityPlural(entity)}
        </Button>
        <Button variant="secondary" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
          {dismiss.isPending ? 'Saving…' : 'Not duplicates'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Merge ${p.merged.name} into ${p.kept.name}?`}
        body={
          <>
            Everything linked to {p.merged.name} moves to {p.kept.name}, and {p.merged.name} is
            removed. You can undo this for 30 days.
          </>
        }
        confirmLabel={`Merge ${entityPlural(entity)}`}
        pending={merge.isPending}
        error={merge.error ? errorMessage(merge.error) : null}
        onConfirm={() => merge.mutate(p)}
        onCancel={() => {
          setConfirming(false);
          if (merge.error) void preview.refetch();
          merge.reset();
        }}
      />
    </>
  );
}

function RecordCard({
  record,
  kept,
  entity,
  timeZone,
  onSwap,
  onOpen,
}: {
  record: MergeRecordView;
  kept: boolean;
  entity: MergeEntity;
  timeZone: string;
  onSwap?: () => void;
  onOpen: () => void;
}) {
  const linked = describeMoved(record.linked);
  // Tells two records with the same name apart.
  const detail = record.fields[entity === 'contact' ? 'email' : 'website'] ?? null;
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-[8px]">
        <StatusBadge tone={kept ? 'brand' : 'neutral'}>
          {kept ? 'Keep' : 'Merge into the kept one'}
        </StatusBadge>
        {record.doNotContact && <StatusBadge tone="danger">Do not contact</StatusBadge>}
      </div>
      <h2 className="text-title text-ink m-0 mt-[8px] break-words">{record.name}</h2>
      {detail && <p className="m-0 text-[14px] text-ink-2 break-words">{detail}</p>}
      <p className="m-0 text-[13px] text-ink-3">Added {formatDate(record.createdAt, timeZone)}</p>
      <p className="m-0 mt-[12px] text-[14px] text-ink-2">
        {linked ? `Linked: ${linked}` : 'Nothing linked yet'}
      </p>
      <div className="mt-[12px] flex flex-wrap items-center gap-[12px]">
        <Button variant="link" onClick={onOpen}>
          Open {entityNoun(entity).toLowerCase()}
        </Button>
        {onSwap && (
          <Button variant="outline" size="sm" onClick={onSwap}>
            Keep this one instead
          </Button>
        )}
      </div>
    </Panel>
  );
}

function MergeDone({
  merge,
  timeZone,
  onBack,
  onOpenRecord,
}: {
  merge: MergeView;
  timeZone: string;
  onBack: () => void;
  onOpenRecord: (entity: MergeEntity, id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState(merge);
  const [confirming, setConfirming] = useState(false);
  const undo = useMutation({
    mutationFn: () => api.undoMerge(view.id),
    onSuccess: async (result) => {
      setView(result);
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ['duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['merges'] });
    },
  });
  const noun = entityNoun(view.entity).toLowerCase();
  const moved = describeMoved(view.moved);

  if (view.undoneAt) {
    const edited = view.keptFields.filter((f) => f !== 'Do not contact');
    return (
      <Panel title="Merge undone">
        <p className="m-0 text-[14px] text-ink-2">
          {view.merged.name} is a separate {noun} again, with everything that was linked to it.
        </p>
        {edited.length > 0 && (
          <Callout tone="warning" className="mt-[12px]">
            These fields of {view.kept.name} were changed after the merge, so they were left as they
            are: {edited.join(', ')}.
          </Callout>
        )}
        {view.keptFields.includes('Do not contact') && (
          <Callout tone="warning" className="mt-[12px]">
            {view.kept.name} stays marked do not contact. Turn it off by hand only if that came from
            the other {noun} alone.
          </Callout>
        )}
        <div className="mt-[16px] flex flex-wrap gap-[8px]">
          <Button variant="primary" onClick={() => onOpenRecord(view.entity, view.merged.id)}>
            Open {view.merged.name}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Back to duplicates
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={`Merged into ${view.kept.name}`}>
      <p className="m-0 text-[14px] text-ink-2">
        {view.merged.name} was merged into {view.kept.name}.
        {moved ? ` ${moved.charAt(0).toUpperCase()}${moved.slice(1)} moved across.` : ''}
      </p>
      <p className="m-0 mt-[6px] text-[13px] text-ink-3">
        You can undo this until {formatDate(view.undoUntil, timeZone)}.
      </p>
      <div className="mt-[16px] flex flex-wrap gap-[8px]">
        <Button variant="primary" onClick={() => onOpenRecord(view.entity, view.kept.id)}>
          Open {noun}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Undo merge
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back to duplicates
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Undo this merge?"
        body={
          <>
            {view.merged.name} comes back as a separate {noun}, with everything that was linked to
            it. Changes made to {view.kept.name} since the merge stay.
          </>
        }
        confirmLabel="Undo merge"
        pending={undo.isPending}
        error={undo.error ? errorMessage(undo.error) : null}
        onConfirm={() => undo.mutate()}
        onCancel={() => {
          setConfirming(false);
          undo.reset();
        }}
      />
    </Panel>
  );
}
