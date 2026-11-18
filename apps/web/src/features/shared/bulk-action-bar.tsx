import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag, Trash2, UserCheck, X } from 'lucide-react';
import {
  LeadSystemStatusSchema,
  formatNumber,
  type BulkActionInput,
  type LeadSystemStatus,
  type SavedViewEntity,
  type TableDensity,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type CurrentUser, type Filter } from '@/lib/api.js';
import { Field, errorMessage, fieldError } from './live-kit.js';
import { UserSelect, can, useMe, useReferenceLists } from './list-kit.js';

/**
 * Multi-row selection and floating navy bulk-action bar (PRD 4.5, 4.6, 6.7; DESIGN 6.5, 6.11).
 */

const ENTITY_NOUN: Record<SavedViewEntity, { singular: string; plural: string }> = {
  lead: { singular: 'lead', plural: 'leads' },
  contact: { singular: 'contact', plural: 'contacts' },
  company: { singular: 'company', plural: 'companies' },
  deal: { singular: 'deal', plural: 'deals' },
};

export function canUseBulkActions(me: CurrentUser | undefined, entity: SavedViewEntity): boolean {
  const plural = ENTITY_NOUN[entity].plural;
  const assignCap = entity === 'lead' ? 'leads.assign' : `${plural}.write`;
  return can(me, `${plural}.write`) || can(me, assignCap) || can(me, 'records.delete');
}

export interface BulkSelection {
  selectedIds: Set<string>;
  selectAllMatching: boolean;
  setSelectAllMatching: (next: boolean) => void;
  isSelected: (id: string) => boolean;
  allLoadedSelected: boolean;
  someLoadedSelected: boolean;
  toggleOne: (id: string) => void;
  toggleAllLoaded: () => void;
  clear: () => void;
}

export function useBulkSelection(
  items: readonly { id: string }[],
  resetKey: string,
): BulkSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  useEffect(() => {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  }, [resetKey]);

  const isSelected = useCallback(
    (id: string) => selectAllMatching || selectedIds.has(id),
    [selectAllMatching, selectedIds],
  );

  const allLoadedSelected = useMemo(
    () => items.length > 0 && items.every((item) => isSelected(item.id)),
    [items, isSelected],
  );

  const someLoadedSelected = useMemo(
    () => items.some((item) => isSelected(item.id)),
    [items, isSelected],
  );

  const toggleOne = useCallback(
    (id: string) => {
      if (selectAllMatching) {
        const next = new Set(items.map((i) => i.id));
        next.delete(id);
        setSelectAllMatching(false);
        setSelectedIds(next);
        return;
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [items, selectAllMatching],
  );

  const toggleAllLoaded = useCallback(() => {
    if (allLoadedSelected) {
      setSelectAllMatching(false);
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(items.map((i) => i.id)));
  }, [allLoadedSelected, items]);

  const clear = useCallback(() => {
    setSelectAllMatching(false);
    setSelectedIds(new Set());
  }, []);

  return {
    selectedIds,
    selectAllMatching,
    setSelectAllMatching,
    isSelected,
    allLoadedSelected,
    someLoadedSelected,
    toggleOne,
    toggleAllLoaded,
    clear,
  };
}

export function BulkSelectHeaderCell({
  selection,
  noun,
}: {
  selection: BulkSelection;
  noun: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = selection.someLoadedSelected && !selection.allLoadedSelected;
    }
  }, [selection.someLoadedSelected, selection.allLoadedSelected]);

  return (
    <th scope="col" className="w-[40px] pl-[16px] pr-[4px] align-middle">
      <input
        ref={ref}
        type="checkbox"
        aria-label={`Select all loaded ${noun}`}
        checked={selection.allLoadedSelected}
        onChange={selection.toggleAllLoaded}
        className="h-[16px] w-[16px] rounded-[4px] accent-primary cursor-pointer align-middle"
      />
    </th>
  );
}

export function BulkSelectRowCell({
  id,
  label,
  selection,
  density,
}: {
  id: string;
  label: string;
  selection: BulkSelection;
  density: TableDensity;
}) {
  const selected = selection.isSelected(id);
  const py = density === 'compact' ? 'py-[4px]' : 'py-[8px]';
  return (
    <td
      className={`w-[40px] pl-[16px] pr-[4px] ${py} align-middle`}
      style={selected ? { boxShadow: 'inset 2px 0 0 var(--primary)' } : undefined}
    >
      <input
        type="checkbox"
        aria-label={`Select ${label}`}
        checked={selected}
        onChange={() => selection.toggleOne(id)}
        className="h-[16px] w-[16px] rounded-[4px] accent-primary cursor-pointer align-middle"
      />
    </td>
  );
}

export function BulkSelectAllBanner({
  selection,
  loadedCount,
  total,
  noun,
}: {
  selection: BulkSelection;
  loadedCount: number;
  total: number | undefined;
  noun: string;
}) {
  if (!selection.allLoadedSelected || !total || total <= loadedCount) return null;
  return (
    <div className="bg-tint border-b border-line px-[16px] py-[8px] text-[13px] text-ink flex flex-wrap items-center gap-[8px]">
      {selection.selectAllMatching ? (
        <>
          <span>
            All <strong>{formatNumber(total)}</strong> matching {noun} are selected.
          </span>
          <button
            type="button"
            onClick={selection.clear}
            className="bg-transparent border-0 p-0 text-[13px] font-semibold text-primary-ink hover:underline cursor-pointer"
          >
            Clear selection
          </button>
        </>
      ) : (
        <>
          <span>
            All <strong>{formatNumber(loadedCount)}</strong> {noun} on this page are selected.
          </span>
          <button
            type="button"
            onClick={() => selection.setSelectAllMatching(true)}
            className="bg-transparent border-0 p-0 text-[13px] font-semibold text-primary-ink hover:underline cursor-pointer"
          >
            Select all {formatNumber(total)} matching {noun}
          </button>
        </>
      )}
    </div>
  );
}

type ModalMode = 'assign' | 'status' | 'add_tag' | 'remove_tag' | 'delete' | null;

export function BulkActionBar({
  entity,
  selection,
  total,
  q,
  filter,
}: {
  entity: SavedViewEntity;
  selection: BulkSelection;
  total: number | undefined;
  q: string;
  filter: Filter | null;
}) {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const refLists = useReferenceLists();
  const tagsQuery = useQuery({
    queryKey: ['tags'],
    queryFn: api.listTags,
    staleTime: 60_000,
  });

  const [modal, setModal] = useState<ModalMode>(null);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [status, setStatus] = useState<LeadSystemStatus>('Contacted');
  const [dqReason, setDqReason] = useState('');
  const [tagText, setTagText] = useState('');
  const [bgJobId, setBgJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!modal || modal === 'delete') return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setModal(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [modal]);

  const { singular, plural } = ENTITY_NOUN[entity];
  const canWrite = can(me, `${plural}.write`);
  const canAssign = can(me, entity === 'lead' ? 'leads.assign' : `${plural}.write`);
  const canDelete = can(me, 'records.delete');

  const count = selection.selectAllMatching
    ? (total ?? selection.selectedIds.size)
    : selection.selectedIds.size;

  useEffect(() => {
    if (me?.id && !ownerUserId) setOwnerUserId(me.id);
  }, [me?.id, ownerUserId]);

  const invalidateAll = useCallback(
    () =>
      Promise.all(
        ['leads', 'contacts', 'companies', 'deals', 'board', 'tags', 'notifications'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
    [queryClient],
  );

  // Poll background bulk jobs (>500 rows) until completion
  useEffect(() => {
    if (!bgJobId) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const job = await api.getBulkJob(bgJobId);
        if (cancelled) return;
        if (job.status === 'completed') {
          setBgJobId(null);
          await invalidateAll();
          toast(
            `Bulk update finished: ${formatNumber(job.succeededRows)} ${
              job.succeededRows === 1 ? singular : plural
            } updated.`,
          );
        } else if (job.status === 'failed') {
          setBgJobId(null);
          toast(job.failureReason ?? 'The bulk update failed.', 'danger');
        }
      } catch {
        if (!cancelled) setBgJobId(null);
      }
    }, 1_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bgJobId, invalidateAll, plural, singular, toast]);

  const bulkMutation = useMutation({
    mutationFn: (input: BulkActionInput) => api.runBulkAction(entity, input),
    onSuccess: async (res) => {
      setModal(null);
      setTagText('');
      setDqReason('');
      selection.clear();
      if (res.background) {
        setBgJobId(res.id);
        toast(`Updating ${formatNumber(res.totalRows)} ${plural} in the background…`);
        return;
      }
      await invalidateAll();
      toast(
        `Updated ${formatNumber(res.succeededRows)} ${
          res.succeededRows === 1 ? singular : plural
        }.`,
      );
    },
  });

  if (count === 0) return null;

  const baseSelection = (): Pick<BulkActionInput, 'ids' | 'selectAll' | 'q' | 'filter'> =>
    selection.selectAllMatching
      ? { selectAll: true, q, filter }
      : { ids: [...selection.selectedIds] };

  const openModal = (next: ModalMode) => {
    bulkMutation.reset();
    setModal(next);
  };

  const handleDialogSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (modal === 'assign') {
      bulkMutation.mutate({ ...baseSelection(), action: 'assign', ownerUserId });
    } else if (modal === 'status') {
      bulkMutation.mutate({
        ...baseSelection(),
        action: 'status',
        status,
        disqualificationReason: status === 'Disqualified' ? dqReason : null,
      });
    } else if (modal === 'add_tag' || modal === 'remove_tag') {
      bulkMutation.mutate({
        ...baseSelection(),
        action: modal,
        tag: tagText.trim(),
      });
    }
  };

  const dqReasons = refLists.data?.['disqualify_reasons'] ?? [];
  const leadStatuses = LeadSystemStatusSchema.options.filter((s) => s !== 'Converted');
  const nounForCount = count === 1 ? singular : plural;

  const navBtnClass =
    'inline-flex items-center gap-[6px] h-[32px] px-[11px] rounded-pill bg-transparent hover:bg-navy-2 text-primary-foreground text-[13px] font-medium border-0 cursor-pointer';

  return (
    <>
      <div
        role="region"
        aria-label="Bulk actions"
        data-testid={`bulk-action-bar-${entity}`}
        style={{ boxShadow: 'var(--shadow-dialog)' }}
        className="fixed bottom-[16px] left-1/2 -translate-x-1/2 z-[45] w-[calc(100vw-24px)] sm:w-auto max-w-[calc(100vw-24px)] bg-navy text-primary-foreground rounded-[16px] sm:rounded-pill px-[12px] py-[8px] sm:py-[6px] flex flex-wrap items-center justify-center gap-[4px]"
      >
        <span className="px-[8px] text-[13.5px] font-medium whitespace-nowrap">
          <strong className="text-cyan font-semibold tabular-nums">{formatNumber(count)}</strong>{' '}
          selected
        </span>

        {canAssign && (
          <button type="button" onClick={() => openModal('assign')} className={navBtnClass}>
            <UserCheck size={15} strokeWidth={1.6} aria-hidden="true" />
            <span>Assign</span>
          </button>
        )}

        {entity === 'lead' && canWrite && (
          <button type="button" onClick={() => openModal('status')} className={navBtnClass}>
            <span>Change status</span>
          </button>
        )}

        {canWrite && (
          <>
            <button type="button" onClick={() => openModal('add_tag')} className={navBtnClass}>
              <Tag size={15} strokeWidth={1.6} aria-hidden="true" />
              <span>Add tag</span>
            </button>
            <button type="button" onClick={() => openModal('remove_tag')} className={navBtnClass}>
              <span>Remove tag</span>
            </button>
          </>
        )}

        {canDelete && (
          <button type="button" onClick={() => openModal('delete')} className={navBtnClass}>
            <Trash2 size={15} strokeWidth={1.6} aria-hidden="true" />
            <span>Delete</span>
          </button>
        )}

        <button
          type="button"
          onClick={selection.clear}
          aria-label="Clear selection"
          className="inline-flex items-center justify-center h-[28px] w-[28px] rounded-pill bg-transparent hover:bg-navy-2 text-primary-foreground border-0 cursor-pointer"
        >
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {(modal === 'assign' ||
        modal === 'status' ||
        modal === 'add_tag' ||
        modal === 'remove_tag') && (
        <div
          className="fixed inset-0 z-[55] grid place-items-center p-[16px] fade-in"
          style={{ backgroundColor: 'var(--scrim)' }}
        >
          <form
            onSubmit={handleDialogSubmit}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === 'assign'
                ? `Assign ${formatNumber(count)} ${nounForCount}`
                : modal === 'status'
                  ? `Change status for ${formatNumber(count)} ${nounForCount}`
                  : modal === 'add_tag'
                    ? `Add tag to ${formatNumber(count)} ${nounForCount}`
                    : `Remove tag from ${formatNumber(count)} ${nounForCount}`
            }
            style={{ boxShadow: 'var(--shadow-dialog)' }}
            className="w-full max-w-[440px] bg-surface rounded-[14px] p-[24px] space-y-[16px]"
          >
            <h2 className="text-title text-ink m-0">
              {modal === 'assign' && `Assign ${formatNumber(count)} ${nounForCount}`}
              {modal === 'status' && `Change status for ${formatNumber(count)} ${nounForCount}`}
              {modal === 'add_tag' && `Add tag to ${formatNumber(count)} ${nounForCount}`}
              {modal === 'remove_tag' && `Remove tag from ${formatNumber(count)} ${nounForCount}`}
            </h2>

            {modal === 'assign' && (
              <Field label="New owner" error={fieldError(bulkMutation.error, 'ownerUserId')}>
                <UserSelect value={ownerUserId} onChange={setOwnerUserId} label="New owner" />
              </Field>
            )}

            {modal === 'status' && (
              <>
                <Field label="Lead status" error={fieldError(bulkMutation.error, 'status')}>
                  <Select
                    aria-label="Lead status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as LeadSystemStatus)}
                  >
                    {leadStatuses.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
                {status === 'Disqualified' && (
                  <Field
                    label="Disqualify reason"
                    error={fieldError(bulkMutation.error, 'disqualificationReason')}
                  >
                    <Select
                      aria-label="Disqualify reason"
                      value={dqReason}
                      onChange={(e) => setDqReason(e.target.value)}
                      required
                    >
                      <option value="">Choose a reason…</option>
                      {dqReasons.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </>
            )}

            {(modal === 'add_tag' || modal === 'remove_tag') && (
              <Field label="Tag" error={fieldError(bulkMutation.error, 'tag')}>
                <Input
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  list={`bulk-tags-${entity}`}
                  placeholder="e.g. tax-season-2027"
                  required
                  maxLength={50}
                  autoFocus
                />
                <datalist id={`bulk-tags-${entity}`}>
                  {(tagsQuery.data ?? []).map((t) => (
                    <option key={t.id} value={t.name} />
                  ))}
                </datalist>
              </Field>
            )}

            {bulkMutation.error !== null && bulkMutation.error !== undefined && (
              <p role="alert" className="m-0 text-[13px] text-danger">
                {errorMessage(bulkMutation.error)}
              </p>
            )}

            <div className="flex justify-end gap-[8px]">
              <Button type="button" variant="ghost" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={bulkMutation.isPending}>
                {bulkMutation.isPending
                  ? 'Applying…'
                  : modal === 'assign'
                    ? `Assign ${formatNumber(count)} ${nounForCount}`
                    : modal === 'status'
                      ? 'Update status'
                      : modal === 'add_tag'
                        ? 'Add tag'
                        : 'Remove tag'}
              </Button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={modal === 'delete'}
        title={`Delete ${formatNumber(count)} ${nounForCount}?`}
        body={`Soft-deletes ${formatNumber(count)} ${nounForCount} inside your permission scope and cancels their open tasks.`}
        confirmLabel={`Delete ${formatNumber(count)} ${nounForCount}`}
        pending={bulkMutation.isPending}
        error={bulkMutation.error ? errorMessage(bulkMutation.error) : null}
        onConfirm={() => bulkMutation.mutate({ ...baseSelection(), action: 'delete' })}
        onCancel={() => setModal(null)}
      />
    </>
  );
}
