import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Check, Trash2, Users } from 'lucide-react';
import type { SavedView, SavedViewEntity, TableDensity } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type CurrentUser, type Filter } from '@/lib/api.js';
import { Field, errorMessage, fieldError } from './live-kit.js';
import { useMe } from './list-kit.js';

/**
 * Saved views bar & remembered table density toggle (PRD 4.5, 4.6, 4.8; DESIGN 6.3, 6.5).
 */

function densityStorageKey(userId: string | undefined, entity: SavedViewEntity): string {
  return `adas.density.${userId ?? 'anon'}.${entity}`;
}

export function useTableDensity(
  entity: SavedViewEntity,
): [TableDensity, (next: TableDensity) => void] {
  const me = useMe();
  const key = densityStorageKey(me?.id, entity);
  const [density, setDensityState] = useState<TableDensity>(() => {
    try {
      const saved = window.localStorage.getItem(key);
      return saved === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
      if (saved === 'compact' || saved === 'comfortable') {
        setDensityState(saved);
      }
    } catch {
      // Ignore storage access errors in restricted browsers.
    }
  }, [key]);

  const setDensity = useCallback(
    (next: TableDensity) => {
      setDensityState(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Ignore storage errors.
      }
    },
    [key],
  );

  return [density, setDensity];
}

export function densityRowClass(density: TableDensity, selected = false): string {
  const height = density === 'compact' ? 'h-[36px]' : 'h-[44px]';
  const fill = selected ? 'bg-tint row-selected' : 'hover:bg-bg-alt';
  return `${height} border-b border-line last:border-b-0 ${fill}`;
}

export function densityTdClass(density: TableDensity): string {
  return density === 'compact'
    ? 'px-[12px] py-[4px] align-middle'
    : 'px-[12px] py-[8px] align-middle';
}

function canUserShareView(me: CurrentUser | undefined, entity: SavedViewEntity): boolean {
  if (!me?.capabilities) return false;
  if (me.capabilities['settings.manage'] === 'all') return true;
  const plural = entity === 'company' ? 'companies' : `${entity}s`;
  const readScope = me.capabilities[`${plural}.read`];
  const writeScope = me.capabilities[`${plural}.write`];
  return (
    writeScope === 'team' ||
    writeScope === 'all' ||
    (readScope === 'all' && writeScope !== undefined && writeScope !== 'none')
  );
}

function normalizeParams(
  params: Record<string, string>,
  defaults: Record<string, string>,
  ignoreKeys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (ignoreKeys.includes(k)) continue;
    const def = defaults[k] ?? '';
    if (v !== def) out[k] = v;
  }
  return out;
}

function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, idx) => k === bKeys[idx] && a[k] === b[k]);
}

export interface SavedViewsBarProps {
  entity: SavedViewEntity;
  state: Record<string, string>;
  defaults: Record<string, string>;
  /** Keys in `state` that are not part of filter params (e.g. `sort`, `view`). */
  excludeParamKeys?: readonly string[];
  filter: Filter | null;
  sort: string;
  density: TableDensity;
  onChangeDensity: (density: TableDensity) => void;
  onApplyView: (next: {
    params: Record<string, string>;
    sort: string;
    density: TableDensity;
  }) => void;
}

export function SavedViewsBar({
  entity,
  state,
  defaults,
  excludeParamKeys = ['sort'],
  filter,
  sort,
  density,
  onChangeDensity,
  onApplyView,
}: SavedViewsBarProps) {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canShare = canUserShareView(me, entity);

  const viewsQuery = useQuery({
    queryKey: ['saved-views', entity],
    queryFn: () => api.listSavedViews(entity),
    staleTime: 60_000,
  });
  const views = useMemo(() => viewsQuery.data ?? [], [viewsQuery.data]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [shareTeam, setShareTeam] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SavedView | null>(null);

  useEffect(() => {
    if (!saveDialogOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSaveDialogOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [saveDialogOpen]);

  const currentParams = useMemo(
    () => normalizeParams(state, defaults, excludeParamKeys),
    [state, defaults, excludeParamKeys],
  );
  const defaultSort = defaults['sort'] ?? '-updatedAt';
  const isDefaultState = Object.keys(currentParams).length === 0 && sort === defaultSort;

  const matchedView = useMemo(() => {
    if (selectedId) {
      const byId = views.find((v) => v.id === selectedId);
      if (byId) return byId;
    }
    return (
      views.find((v) => {
        const vp = normalizeParams(v.params, defaults, excludeParamKeys);
        return sameParams(vp, currentParams) && v.sort === sort;
      }) ?? null
    );
  }, [selectedId, views, defaults, excludeParamKeys, currentParams, sort]);

  const isSelectedDirty = useMemo(() => {
    if (!matchedView || selectedId !== matchedView.id) return false;
    const vp = normalizeParams(matchedView.params, defaults, excludeParamKeys);
    return (
      !sameParams(vp, currentParams) || matchedView.sort !== sort || matchedView.density !== density
    );
  }, [matchedView, selectedId, defaults, excludeParamKeys, currentParams, sort, density]);

  const createView = useMutation({
    mutationFn: api.createSavedView,
    onSuccess: async (created) => {
      setSaveDialogOpen(false);
      setNewName('');
      setShareTeam(false);
      setSelectedId(created.id);
      toast(`Saved view "${created.name}".`);
      await queryClient.invalidateQueries({ queryKey: ['saved-views', entity] });
    },
  });

  const updateView = useMutation({
    mutationFn: ({ id, view }: { id: string; view: SavedView }) =>
      api.updateSavedView(id, {
        version: view.version,
        params: currentParams,
        filter,
        sort,
        density,
      }),
    onSuccess: async (updated) => {
      toast(`Updated view "${updated.name}".`);
      await queryClient.invalidateQueries({ queryKey: ['saved-views', entity] });
    },
    onError: (err) => toast(errorMessage(err), 'danger'),
  });

  const deleteView = useMutation({
    mutationFn: (id: string) => api.deleteSavedView(id),
    onSuccess: async (_res, id) => {
      const deletedName = confirmDelete?.name ?? 'view';
      setConfirmDelete(null);
      if (selectedId === id) setSelectedId(null);
      toast(`Deleted view "${deletedName}".`);
      await queryClient.invalidateQueries({ queryKey: ['saved-views', entity] });
    },
    onError: (err) => toast(errorMessage(err), 'danger'),
  });

  const selectAllDefault = () => {
    setSelectedId(null);
    const resetParams: Record<string, string> = {};
    for (const key of Object.keys(defaults)) {
      if (excludeParamKeys.includes(key)) continue;
      resetParams[key] = defaults[key] ?? '';
    }
    onApplyView({ params: resetParams, sort: defaultSort, density });
  };

  const applySavedView = (view: SavedView) => {
    setSelectedId(view.id);
    const nextParams: Record<string, string> = {};
    for (const key of Object.keys(defaults)) {
      if (excludeParamKeys.includes(key)) continue;
      nextParams[key] = view.params[key] ?? defaults[key] ?? '';
    }
    onChangeDensity(view.density);
    onApplyView({ params: nextParams, sort: view.sort, density: view.density });
  };

  const handleSaveSubmit = (e: FormEvent) => {
    e.preventDefault();
    createView.mutate({
      entityType: entity,
      name: newName.trim(),
      isShared: canShare ? shareTeam : false,
      params: currentParams,
      filter,
      sort,
      density,
    });
  };

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-[8px]"
      data-testid={`saved-views-bar-${entity}`}
    >
      <div
        role="toolbar"
        aria-label="Saved views"
        className="flex flex-wrap items-center gap-[6px]"
      >
        <button
          type="button"
          onClick={selectAllDefault}
          aria-pressed={!matchedView && isDefaultState}
          className={`inline-flex items-center gap-[5px] h-[28px] px-[11px] rounded-pill text-[13px] font-medium cursor-pointer transition-colors duration-120 ${
            !matchedView && isDefaultState
              ? 'bg-primary text-primary-foreground border border-primary'
              : 'bg-surface text-ink border border-line-strong hover:border-primary'
          }`}
        >
          {!matchedView && isDefaultState && (
            <Check size={13} strokeWidth={1.8} aria-hidden="true" />
          )}
          <span>All</span>
        </button>

        {views.map((view) => {
          const active = matchedView?.id === view.id;
          return (
            <button
              key={view.id}
              type="button"
              onClick={() => applySavedView(view)}
              aria-pressed={active}
              className={`inline-flex items-center gap-[5px] h-[28px] px-[11px] rounded-pill text-[13px] font-medium cursor-pointer transition-colors duration-120 ${
                active
                  ? 'bg-primary text-primary-foreground border border-primary'
                  : 'bg-surface text-ink border border-line-strong hover:border-primary'
              }`}
            >
              {active && <Check size={13} strokeWidth={1.8} aria-hidden="true" />}
              <span>{view.name}</span>
              {view.isShared && (
                <>
                  <Users
                    size={12}
                    strokeWidth={1.7}
                    aria-hidden="true"
                    className={active ? 'text-primary-foreground opacity-90' : 'text-ink-3'}
                  />
                  <span className="sr-only"> (shared with team)</span>
                </>
              )}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => {
            createView.reset();
            setSaveDialogOpen(true);
          }}
          className="inline-flex items-center gap-[5px] h-[28px] px-[10px] rounded-pill bg-transparent hover:bg-bg-alt text-[13px] font-medium text-ink-2 hover:text-ink border-0 cursor-pointer"
        >
          <BookmarkPlus size={14} strokeWidth={1.6} aria-hidden="true" />
          <span>Save view</span>
        </button>

        {matchedView && matchedView.canEdit && isSelectedDirty && (
          <button
            type="button"
            disabled={updateView.isPending}
            onClick={() => updateView.mutate({ id: matchedView.id, view: matchedView })}
            className="inline-flex items-center gap-[5px] h-[28px] px-[10px] rounded-pill bg-surface border border-primary text-[13px] font-medium text-primary-ink hover:bg-tint cursor-pointer disabled:opacity-50"
          >
            <span>{updateView.isPending ? 'Saving…' : 'Update view'}</span>
          </button>
        )}

        {matchedView && matchedView.canEdit && (
          <button
            type="button"
            onClick={() => setConfirmDelete(matchedView)}
            aria-label={`Delete saved view ${matchedView.name}`}
            className="inline-flex items-center justify-center h-[28px] w-[28px] rounded-pill bg-transparent hover:bg-bg-alt text-ink-3 hover:text-danger border-0 cursor-pointer"
          >
            <Trash2 size={14} strokeWidth={1.6} aria-hidden="true" />
          </button>
        )}
      </div>

      <div
        role="group"
        aria-label="Row density"
        className="inline-flex items-center rounded-pill border border-line-strong bg-surface p-[2px]"
      >
        {(['comfortable', 'compact'] as const).map((mode) => {
          const active = density === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              onClick={() => onChangeDensity(mode)}
              className={`h-[24px] px-[10px] rounded-pill text-[12.5px] font-medium border-0 cursor-pointer transition-colors duration-120 ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-transparent text-ink-2 hover:text-ink'
              }`}
            >
              {mode === 'comfortable' ? 'Comfortable' : 'Compact'}
            </button>
          );
        })}
      </div>

      {saveDialogOpen && (
        <div
          className="fixed inset-0 z-[55] grid place-items-center p-[16px] fade-in"
          style={{ backgroundColor: 'var(--scrim)' }}
        >
          <form
            onSubmit={handleSaveSubmit}
            role="dialog"
            aria-modal="true"
            aria-label="Save current view"
            style={{ boxShadow: 'var(--shadow-dialog)' }}
            className="w-full max-w-[440px] bg-surface rounded-[14px] p-[24px] space-y-[16px]"
          >
            <h2 className="text-title text-ink m-0">Save current view</h2>
            <p className="m-0 text-[13.5px] text-ink-2">
              Saves the current search, filters, sort order and row density so you can return to it
              in one click.
            </p>
            <Field label="View name" error={fieldError(createView.error, 'name')}>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. US qualified leads"
                required
                maxLength={80}
                autoFocus
              />
            </Field>
            {canShare && (
              <label className="flex items-center gap-[8px] text-[13.5px] text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={shareTeam}
                  onChange={(e) => setShareTeam(e.target.checked)}
                  className="h-[16px] w-[16px] rounded-[4px] accent-primary cursor-pointer"
                />
                <span>Share this view with my team</span>
              </label>
            )}
            {createView.error !== null && createView.error !== undefined && (
              <p role="alert" className="m-0 text-[13px] text-danger">
                {errorMessage(createView.error)}
              </p>
            )}
            <div className="flex justify-end gap-[8px]">
              <Button type="button" variant="ghost" onClick={() => setSaveDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={createView.isPending || newName.trim().length === 0}
              >
                {createView.isPending ? 'Saving…' : 'Save view'}
              </Button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete ? `Delete saved view "${confirmDelete.name}"?` : 'Delete saved view?'}
        body={
          confirmDelete?.isShared
            ? 'This removes the shared view for everyone in your team. Records themselves are untouched.'
            : 'This removes the saved view from your toolbar. Records themselves are untouched.'
        }
        confirmLabel="Delete view"
        pending={deleteView.isPending}
        onConfirm={() => {
          if (confirmDelete) deleteView.mutate(confirmDelete.id);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
