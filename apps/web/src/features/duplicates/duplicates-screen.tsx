import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatRelative,
  type DuplicateCandidateView,
  type DuplicateRecordView,
  type MergeEntity,
  type MergeView,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { useToast } from '@/components/ui/toast.js';
import { useMe, useUrlState } from '@/features/shared/list-kit.js';
import {
  DataPanel,
  PageHeader,
  errorMessage,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { api } from '@/lib/api.js';
import { describeMoved, entityNoun } from './merge-kit.js';
import { MergeReview } from './merge-review.js';

/**
 * Duplicates (PRD 4.9): pairs of contacts or companies that may be the same wait here for
 * review. Merging keeps one record, moves everything linked to the other, and can be undone
 * for 30 days.
 */
export function DuplicatesScreen({
  pairId,
  onOpenPair,
  onBack,
  onOpenRecord,
}: {
  pairId: string | null;
  onOpenPair: (id: string) => void;
  onBack: () => void;
  onOpenRecord: (entity: MergeEntity, id: string) => void;
}) {
  return pairId ? (
    <MergeReview key={pairId} pairId={pairId} onBack={onBack} onOpenRecord={onOpenRecord} />
  ) : (
    <DuplicateList onOpenPair={onOpenPair} onOpenRecord={onOpenRecord} />
  );
}

const VIEWS = [
  { id: 'contact', label: 'Contacts' },
  { id: 'company', label: 'Companies' },
  { id: 'merges', label: 'Recent merges' },
] as const;

function DuplicateList({
  onOpenPair,
  onOpenRecord,
}: {
  onOpenPair: (id: string) => void;
  onOpenRecord: (entity: MergeEntity, id: string) => void;
}) {
  const [state, setState] = useUrlState({ view: 'contact' });
  const view = VIEWS.some((v) => v.id === state.view) ? state.view : 'contact';
  return (
    <div className="space-y-[16px]" data-testid="duplicates-screen">
      <PageHeader kicker="Data" title="Duplicates" />
      <div
        role="tablist"
        aria-label="Duplicate views"
        className="flex gap-[20px] border-b border-line overflow-x-auto"
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            className="view-tab"
            onClick={() => setState({ view: v.id })}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === 'merges' ? (
        <MergeHistory onOpenRecord={onOpenRecord} />
      ) : (
        <Queue key={view} entity={view as MergeEntity} onOpenPair={onOpenPair} />
      )}
    </div>
  );
}

function RecordCell({ record }: { record: DuplicateRecordView }) {
  return (
    <div className="min-w-0">
      <div className="font-semibold text-ink truncate">{record.name || '—'}</div>
      <div className="text-[13px] text-ink-3 truncate">
        {[record.detail, record.context].filter(Boolean).join(' · ') || '—'}
      </div>
    </div>
  );
}

function Queue({ entity, onOpenPair }: { entity: MergeEntity; onOpenPair: (id: string) => void }) {
  const me = useMe();
  const tz = me?.timezone ?? 'UTC';
  const query = useInfiniteQuery({
    queryKey: ['duplicates', entity],
    queryFn: ({ pageParam }) => api.listDuplicates(entity, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items: DuplicateCandidateView[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const plural = entity === 'contact' ? 'contacts' : 'companies';
  return (
    <DataPanel
      query={query}
      isEmpty={items.length === 0}
      emptyTitle={`No possible duplicate ${plural}`}
      emptyDescription={`When an import or the CRM's regular check finds ${plural} that may be the same, they wait here for someone to review.`}
      footer={
        query.hasNextPage && (
          <Button
            variant="ghost"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        )
      }
    >
      <table className={tableClass}>
        <thead>
          <tr className={theadRowClass}>
            <th scope="col" className={thClass}>
              Record
            </th>
            <th scope="col" className={`${thClass} hidden sm:table-cell`}>
              May be the same as
            </th>
            <th scope="col" className={`${thClass} hidden md:table-cell`}>
              Why
            </th>
            <th scope="col" className={`${thClass} hidden md:table-cell`}>
              Found
            </th>
            <th scope="col" className={thClass}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((pair) => (
            <tr key={pair.id} className={rowClass}>
              <td className={`${tdClass} max-w-[210px] sm:max-w-[260px]`}>
                <RecordCell record={pair.a} />
                {/* On phones the other record and the reason fold into this cell. */}
                <div className="sm:hidden mt-[8px]">
                  <div className="text-[12.5px] text-ink-3">May be the same as</div>
                  <RecordCell record={pair.b} />
                </div>
                <div className="md:hidden mt-[6px] text-[13px] text-ink-2">{pair.reason}</div>
              </td>
              <td className={`${tdClass} max-w-[260px] hidden sm:table-cell`}>
                <RecordCell record={pair.b} />
              </td>
              <td className={`${tdClass} text-ink-2 hidden md:table-cell`}>{pair.reason}</td>
              <td className={`${tdClass} text-ink-2 whitespace-nowrap hidden md:table-cell`}>
                <span title={formatDate(pair.createdAt, tz)}>{formatRelative(pair.createdAt)}</span>
                <span className="block text-[12.5px] text-ink-3">
                  {pair.foundBy === 'import' ? 'By an import' : 'By the regular check'}
                </span>
              </td>
              <td className={`${tdClass} text-right`}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenPair(pair.id)}
                  aria-label={`Review ${pair.a.name} and ${pair.b.name}`}
                >
                  Review
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataPanel>
  );
}

function MergeHistory({
  onOpenRecord,
}: {
  onOpenRecord: (entity: MergeEntity, id: string) => void;
}) {
  const me = useMe();
  const tz = me?.timezone ?? 'UTC';
  const results = useQueries({
    queries: (['contact', 'company'] as const).map((entity) => ({
      queryKey: ['merges', entity],
      queryFn: () => api.listMerges(entity),
    })),
  });
  const failed = results.find((r) => r.isError);
  const query = {
    isPending: results.some((r) => r.isPending),
    isError: Boolean(failed),
    isSuccess: results.every((r) => r.isSuccess),
    error: failed?.error ?? null,
    refetch: () => Promise.all(results.map((r) => r.refetch())),
  };
  const items = results
    .flatMap((r) => r.data ?? [])
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const [undoing, setUndoing] = useState<MergeView | null>(null);

  return (
    <>
      <DataPanel
        query={query}
        isEmpty={items.length === 0}
        emptyTitle="No merges yet"
        emptyDescription="Merges you can see appear here, and each one can be undone for 30 days."
      >
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th scope="col" className={thClass}>
                Kept
              </th>
              <th scope="col" className={`${thClass} hidden sm:table-cell`}>
                Merged into it
              </th>
              <th scope="col" className={`${thClass} hidden md:table-cell`}>
                What moved
              </th>
              <th scope="col" className={`${thClass} hidden md:table-cell`}>
                Merged
              </th>
              <th scope="col" className={thClass}>
                <span className="sr-only">Undo</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const canUndo = !m.undoneAt && Date.parse(m.undoUntil) > Date.now();
              return (
                <tr key={m.id} className={rowClass}>
                  <td className={`${tdClass} max-w-[200px] sm:max-w-[240px]`}>
                    {m.kept.active ? (
                      <button
                        type="button"
                        onClick={() => onOpenRecord(m.entity, m.kept.id)}
                        className="font-semibold text-ink hover:underline cursor-pointer bg-transparent border-0 p-0 text-left truncate max-w-full"
                      >
                        {m.kept.name}
                      </button>
                    ) : (
                      <span className="font-semibold text-ink-2">{m.kept.name}</span>
                    )}
                    <span className="block text-[12.5px] text-ink-3">{entityNoun(m.entity)}</span>
                    {/* On phones the merged record and the date fold into this cell. */}
                    <span className="sm:hidden block mt-[6px] text-[13px] text-ink-2 truncate">
                      Merged in: {m.merged.name}
                    </span>
                    <span className="md:hidden block text-[12.5px] text-ink-3">
                      {formatRelative(m.mergedAt)} by {m.mergedBy.name}
                    </span>
                  </td>
                  <td className={`${tdClass} max-w-[220px] truncate hidden sm:table-cell`}>
                    {m.merged.name}
                  </td>
                  <td className={`${tdClass} text-ink-2 max-w-[280px] hidden md:table-cell`}>
                    {describeMoved(m.moved) || <span className="text-ink-3">Nothing linked</span>}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-ink-2 hidden md:table-cell`}>
                    <span title={formatDate(m.mergedAt, tz)}>{formatRelative(m.mergedAt)}</span>
                    <span className="block text-[12.5px] text-ink-3">by {m.mergedBy.name}</span>
                  </td>
                  <td className={`${tdClass} text-right whitespace-nowrap`}>
                    {m.undoneAt ? (
                      <StatusBadge tone="neutral">Undone</StatusBadge>
                    ) : canUndo ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setUndoing(m)}
                        aria-label={`Undo the merge of ${m.merged.name}`}
                      >
                        Undo
                      </Button>
                    ) : (
                      <span className="text-[13px] text-ink-3">Too late to undo</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>
      {undoing && <UndoDialog merge={undoing} onClose={() => setUndoing(null)} />}
    </>
  );
}

function UndoDialog({ merge, onClose }: { merge: MergeView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const undo = useMutation({
    mutationFn: () => api.undoMerge(merge.id),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['merges'] });
      await queryClient.invalidateQueries({ queryKey: ['duplicates'] });
      toast(
        result.keptFields.length > 0
          ? `Merge undone. Left as edited since: ${result.keptFields.join(', ')}.`
          : 'Merge undone.',
        'success',
      );
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title="Undo this merge?"
      body={
        <>
          {merge.merged.name} comes back as a separate {entityNoun(merge.entity).toLowerCase()},
          with everything that was linked to it. Changes made to {merge.kept.name} since the merge
          stay.
        </>
      }
      confirmLabel="Undo merge"
      pending={undo.isPending}
      error={undo.error ? errorMessage(undo.error) : null}
      onConfirm={() => undo.mutate()}
      onCancel={onClose}
    />
  );
}
