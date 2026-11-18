import { useMemo, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { formatDate, formatMoney, formatNumber, type Currency } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type BoardStage, type DealRow, type StageRow } from '@/lib/api.js';
import {
  DataPanel,
  PageHeader,
  SearchBox,
  errorMessage,
  tableClass,
  thClass,
  theadRowClass,
  useUserNames,
} from '@/features/shared/live-kit.js';
import {
  FilterChips,
  ListFooter,
  OwnerFilter,
  SortHeader,
  Toolbar,
  allOf,
  can,
  rangeLabel,
  rangeParam,
  useMe,
  usePagedList,
  useSearchText,
  useUrlState,
} from '@/features/shared/list-kit.js';
import {
  SavedViewsBar,
  densityRowClass,
  densityTdClass,
  useTableDensity,
} from '@/features/shared/saved-views-bar.js';
import {
  BulkActionBar,
  BulkSelectAllBanner,
  BulkSelectHeaderCell,
  BulkSelectRowCell,
  canUseBulkActions,
  useBulkSelection,
} from '@/features/shared/bulk-action-bar.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { ExportButton } from '@/features/exports/export-button.js';
import { StageMover } from './stage-mover.js';
import {
  StageGateDialog,
  computeMissingStageGateFields,
  invalidateDealBoardQueries,
} from './stage-gate-dialog.js';

function monthly(minor: string, currency: Currency, compact = false): string {
  return formatMoney({ amountMinor: BigInt(minor), currency }, { perMonth: true, compact });
}

const DEFAULTS = {
  q: '',
  owner: '',
  pipeline: '',
  view: 'board',
  sort: '-updatedAt',
  stage: '',
  outcome: '',
  closed: '',
  market: '',
};

const OUTCOME_LABEL: Record<string, string> = { open: 'Open', won: 'Won', lost: 'Lost' };
const MARKET_NAME: Record<string, string> = { US: 'U.S.', CA: 'Canada' };

export function DealsKanbanScreen({
  onOpenCompany,
  onOpenDeal,
}: {
  onOpenCompany: (id: string) => void;
  onOpenDeal: (id: string) => void;
}) {
  const me = useMe();
  const [state, setState] = useUrlState(DEFAULTS);
  const [search, setSearch] = useSearchText(state.q, (q) => setState({ q }));
  const pipelines = useQuery({
    queryKey: ['pipelines'],
    queryFn: api.pipelines,
    staleTime: 300_000,
  });
  const pipeline =
    pipelines.data?.find((p) => p.id === state.pipeline) ??
    pipelines.data?.find((p) => p.is_default) ??
    pipelines.data?.[0];

  const filtered = state.q !== '' || state.owner !== '';
  const clearFilters = () => {
    setSearch('');
    setState({ q: '', owner: '', stage: '', outcome: '', closed: '', market: '' });
  };
  // "All pipelines" only makes sense as a list; the board always shows one pipeline.
  const allPipelines = state.view === 'list' && state.pipeline === 'all';

  return (
    <div className="space-y-[16px]" data-testid="deals-kanban-screen">
      <PageHeader kicker={pipeline?.name ?? 'Pipeline'} title="Deals" />
      <Toolbar>
        <SearchBox value={search} onChange={setSearch} label="Search deal or company" />
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-[8px]">
          {(pipelines.data?.length ?? 0) > 1 && (
            <Select
              aria-label="Pipeline"
              value={allPipelines ? 'all' : (pipeline?.id ?? '')}
              onChange={(e) => setState({ pipeline: e.target.value, stage: '' })}
              className="sm:w-[180px]"
            >
              {state.view === 'list' && <option value="all">All pipelines</option>}
              {(pipelines.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          <OwnerFilter value={state.owner} onChange={(owner) => setState({ owner })} />
          {filtered && (
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
        <div
          role="tablist"
          aria-label="Deals view"
          className="flex gap-[16px] lg:ml-auto border-b border-line"
        >
          {(['board', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={state.view === v}
              className="view-tab"
              onClick={() => setState({ view: v })}
            >
              {v === 'board' ? 'Board' : 'List'}
            </button>
          ))}
        </div>
      </Toolbar>

      {pipelines.isPending && (
        <div className="bg-surface border border-line rounded-[10px]">
          <LoadingState rows={5} />
        </div>
      )}
      {pipelines.isError && (
        <div className="bg-surface border border-line rounded-[10px]">
          <ErrorState
            message={errorMessage(pipelines.error)}
            onRetry={() => void pipelines.refetch()}
          />
        </div>
      )}
      {pipeline && state.view === 'board' && (
        <Board
          pipelineId={pipeline.id}
          stages={pipeline.stages}
          owner={state.owner}
          q={state.q}
          filtered={filtered}
          canMove={can(me, 'deals.write')}
          onClear={clearFilters}
          onOpenCompany={onOpenCompany}
          onOpenDeal={onOpenDeal}
          onShowStage={(stage) => setState({ view: 'list', stage })}
        />
      )}
      {pipeline && state.view === 'list' && (
        <DealList
          pipelineId={allPipelines ? null : pipeline.id}
          stages={pipeline.stages}
          state={state}
          setState={setState}
          onSetSearch={setSearch}
          filtered={filtered}
          onClear={clearFilters}
          onOpenDeal={onOpenDeal}
        />
      )}
    </div>
  );
}

interface KeyboardDragState {
  deal: DealRow;
  targetStageId: string;
}

function Board({
  pipelineId,
  stages,
  owner,
  q,
  filtered,
  canMove,
  onClear,
  onOpenCompany,
  onOpenDeal,
  onShowStage,
}: {
  pipelineId: string;
  stages: StageRow[];
  owner: string;
  q: string;
  filtered: boolean;
  canMove: boolean;
  onClear: () => void;
  onOpenCompany: (id: string) => void;
  onOpenDeal: (id: string) => void;
  onShowStage: (stage: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const ownerName = useUserNames();
  const [pointerDeal, setPointerDeal] = useState<DealRow | null>(null);
  const [hoverStageId, setHoverStageId] = useState<string | null>(null);
  const [keyboardDrag, setKeyboardDrag] = useState<KeyboardDragState | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [gatePrompt, setGatePrompt] = useState<{ deal: DealRow; stage: StageRow } | null>(null);
  const [expandedClosed, setExpandedClosed] = useState<Record<string, boolean>>({});

  const board = useQuery({
    queryKey: ['board', pipelineId, { owner, q }],
    queryFn: () => api.board(pipelineId, { owner: owner || undefined, q: q || undefined }),
  });

  const quickMove = useMutation({
    mutationFn: ({ deal, stage }: { deal: DealRow; stage: StageRow }) =>
      api.moveDealStage(deal.id, { stageName: stage.name, version: deal.version }),
    onSuccess: async (_moved, { deal, stage }) => {
      const msg = `Moved ${deal.name} to ${stage.name}.`;
      toast(msg);
      setLiveMessage(msg);
      await invalidateDealBoardQueries(queryClient, deal);
    },
    onError: (err) => {
      const msg = errorMessage(err);
      toast(msg, 'danger');
      setLiveMessage(msg);
    },
  });

  const orderedStages = useMemo(() => {
    const raw = board.data?.stages ?? [];
    const open = raw.filter((s) => s.category === 'open');
    const closed = raw.filter((s) => s.category !== 'open');
    return [...open, ...closed];
  }, [board.data]);

  const totalDeals = useMemo(
    () => orderedStages.reduce((sum, s) => sum + s.count, 0),
    [orderedStages],
  );

  const allowedStagesForDeal = (deal: DealRow): BoardStage[] =>
    deal.stage_category === 'open'
      ? orderedStages
      : orderedStages.filter((s) => s.category === 'open');

  const commitDrop = (deal: DealRow, targetStage: StageRow) => {
    if (targetStage.name === deal.stage_name) {
      setLiveMessage(`Kept ${deal.name} in ${deal.stage_name}.`);
      return;
    }
    if (deal.stage_category !== 'open' && targetStage.category !== 'open') {
      const msg = 'Closed deals can only be reopened into an open stage.';
      toast(msg, 'danger');
      setLiveMessage(msg);
      return;
    }
    const missing = computeMissingStageGateFields(deal, targetStage);
    if (missing.size > 0) {
      setLiveMessage(`Additional details needed to move ${deal.name} to ${targetStage.name}.`);
      setGatePrompt({ deal, stage: targetStage });
      return;
    }
    quickMove.mutate({ deal, stage: targetStage });
  };

  const handleCardKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, deal: DealRow) => {
    if (!canMove) return;
    const isActive = keyboardDrag?.deal.id === deal.id;
    if (!isActive) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setKeyboardDrag({ deal, targetStageId: deal.stage_id });
        setLiveMessage(
          `Picked up ${deal.name} in ${deal.stage_name}. Use Left and Right arrow keys to choose a stage, Space to drop, or Escape to cancel.`,
        );
      }
      return;
    }

    const candidates = allowedStagesForDeal(deal);
    const currentIndex = Math.max(
      0,
      candidates.findIndex((s) => s.id === keyboardDrag.targetStageId),
    );

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = candidates[Math.min(candidates.length - 1, currentIndex + 1)];
      if (next && next.id !== keyboardDrag.targetStageId) {
        setKeyboardDrag({ deal, targetStageId: next.id });
        setLiveMessage(
          `Over ${next.name}, ${next.count} deals. Press Space to drop or Escape to cancel.`,
        );
      }
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = candidates[Math.max(0, currentIndex - 1)];
      if (prev && prev.id !== keyboardDrag.targetStageId) {
        setKeyboardDrag({ deal, targetStageId: prev.id });
        setLiveMessage(
          `Over ${prev.name}, ${prev.count} deals. Press Space to drop or Escape to cancel.`,
        );
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setKeyboardDrag(null);
      setLiveMessage(`Cancelled moving ${deal.name}.`);
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const targetStage = candidates[currentIndex];
      setKeyboardDrag(null);
      if (targetStage) commitDrop(deal, targetStage);
    }
  };

  if (board.isPending) {
    return (
      <div className="bg-surface border border-line rounded-[10px]">
        <LoadingState rows={5} />
      </div>
    );
  }
  if (board.isError) {
    return (
      <div className="bg-surface border border-line rounded-[10px]">
        <ErrorState message={errorMessage(board.error)} onRetry={() => void board.refetch()} />
      </div>
    );
  }
  if (totalDeals === 0) {
    return (
      <div className="bg-surface border border-line rounded-[10px]">
        <EmptyState
          title={filtered ? 'No deals match these filters' : 'No deals yet'}
          description={
            filtered
              ? 'Clear the search or owner filter to see the whole pipeline.'
              : 'Convert a qualified lead to create its first deal.'
          }
          actionLabel={filtered ? 'Clear filters' : undefined}
          onAction={filtered ? onClear : undefined}
        />
      </div>
    );
  }

  const activeDragDeal = pointerDeal ?? keyboardDrag?.deal ?? null;
  const keyboardTargetStage = keyboardDrag
    ? orderedStages.find((s) => s.id === keyboardDrag.targetStageId)
    : null;

  return (
    <div className="space-y-[8px]">
      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>

      {keyboardDrag && keyboardTargetStage && (
        <div
          data-testid="kanban-keyboard-banner"
          className="flex flex-wrap items-center justify-between gap-[8px] bg-tint border-l-[3px] border-primary rounded-r-[10px] px-[14px] py-[8px] text-[13px] text-ink"
        >
          <span>
            Moving <strong>{keyboardDrag.deal.name}</strong> →{' '}
            <strong>{keyboardTargetStage.name}</strong> · Left/Right arrows to move · Space to drop
            · Esc to cancel
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setKeyboardDrag(null);
              setLiveMessage(`Cancelled moving ${keyboardDrag.deal.name}.`);
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      <div className="relative overflow-x-auto pb-[8px]" aria-busy={board.isFetching || undefined}>
        <div className="flex items-start gap-[12px] min-w-max">
          {orderedStages.map((stage: BoardStage) => {
            const isClosedStage = stage.category !== 'open';
            const isCollapsed = isClosedStage && !expandedClosed[stage.id];
            const canAcceptActive =
              activeDragDeal !== null &&
              (activeDragDeal.stage_category === 'open' || stage.category === 'open');
            const isDropTarget =
              canAcceptActive &&
              (hoverStageId === stage.id || keyboardDrag?.targetStageId === stage.id);
            const mutedInk = isDropTarget ? 'text-ink-2' : 'text-ink-3';

            const onDragOver = (event: DragEvent<HTMLElement>) => {
              if (!canMove || !pointerDeal) return;
              if (pointerDeal.stage_category !== 'open' && stage.category !== 'open') return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (hoverStageId !== stage.id) setHoverStageId(stage.id);
            };
            const onDragLeave = (event: DragEvent<HTMLElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                if (hoverStageId === stage.id) setHoverStageId(null);
              }
            };
            const onDrop = (event: DragEvent<HTMLElement>) => {
              event.preventDefault();
              setHoverStageId(null);
              const dropped = pointerDeal;
              setPointerDeal(null);
              if (!canMove || !dropped) return;
              commitDrop(dropped, stage);
            };

            if (isCollapsed) {
              return (
                <section
                  key={stage.id}
                  data-testid={`board-stage-${stage.id}`}
                  data-collapsed="true"
                  aria-label={`${stage.name}, ${stage.count} deals`}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  className={`w-[224px] shrink-0 rounded-[10px] p-[12px] border border-dashed transition-colors ${
                    isDropTarget ? 'bg-tint border-primary' : 'bg-bg-alt border-line-strong'
                  }`}
                >
                  <div className="flex items-center justify-between gap-[8px]">
                    <div className="flex items-center gap-[6px]">
                      <h2 className="m-0 text-[14px] font-semibold text-ink">{stage.name}</h2>
                      <StatusBadge tone={stage.category === 'won' ? 'success' : 'danger'}>
                        {formatNumber(stage.count)}
                      </StatusBadge>
                    </div>
                    <span className={`text-[12.5px] tabular-nums ${mutedInk}`}>
                      {stage.probability}%
                    </span>
                  </div>
                  <div className={`mt-[4px] text-[12.5px] tabular-nums ${mutedInk}`}>
                    {stage.totals.length === 0
                      ? '—'
                      : stage.totals
                          .map((t) => monthly(t.monthlyValueMinor, t.currency, true))
                          .join(' · ')}
                  </div>
                  <p className={`m-0 mt-[8px] text-[12.5px] ${mutedInk}`}>
                    {activeDragDeal
                      ? `Drop here to mark ${stage.name.toLowerCase()}.`
                      : `Collapsed outcome zone.`}
                  </p>
                  {stage.deals.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedClosed((prev) => ({ ...prev, [stage.id]: true }))}
                      className="mt-[8px] inline-flex items-center gap-[4px] bg-transparent border-0 p-0 text-[12.5px] font-semibold text-primary-ink cursor-pointer hover:underline"
                    >
                      <ChevronRight size={14} strokeWidth={1.6} aria-hidden="true" />
                      <span>Show deals ({formatNumber(stage.deals.length)})</span>
                    </button>
                  )}
                </section>
              );
            }

            return (
              <section
                key={stage.id}
                data-testid={`board-stage-${stage.id}`}
                aria-label={`${stage.name}, ${stage.count} deals`}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={`w-[288px] shrink-0 rounded-[10px] p-[8px] transition-colors ${
                  isDropTarget ? 'bg-tint ring-1 ring-primary' : 'bg-bg-alt'
                }`}
              >
                <header className="px-[4px] pb-[8px]">
                  <div className="flex justify-between items-baseline gap-[8px]">
                    <h2 className="m-0 text-[14px] font-semibold text-ink">{stage.name}</h2>
                    <div className="flex items-center gap-[8px]">
                      <span className={`text-[13px] tabular-nums ${mutedInk}`}>
                        {formatNumber(stage.count)}
                      </span>
                      {isClosedStage && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedClosed((prev) => ({ ...prev, [stage.id]: false }))
                          }
                          className="inline-flex items-center gap-[2px] bg-transparent border-0 p-0 text-[12px] font-semibold text-primary-ink cursor-pointer hover:underline"
                        >
                          <ChevronDown size={14} strokeWidth={1.6} aria-hidden="true" />
                          <span>Collapse</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <div
                    className={`flex justify-between items-baseline gap-[8px] text-[12.5px] tabular-nums ${mutedInk}`}
                  >
                    <span>
                      {stage.totals.length === 0
                        ? '—'
                        : stage.totals
                            .map((t) => monthly(t.monthlyValueMinor, t.currency, true))
                            .join(' · ')}
                    </span>
                    <span>{stage.probability}%</span>
                  </div>
                </header>
                <ul className="m-0 p-0 list-none space-y-[8px]">
                  {stage.deals.map((deal) => (
                    <li key={deal.id}>
                      <DealCard
                        deal={deal}
                        stages={stages}
                        ownerName={ownerName(deal.owner_user_id)}
                        canMove={canMove}
                        isDragging={
                          pointerDeal?.id === deal.id || keyboardDrag?.deal.id === deal.id
                        }
                        isKeyboardPickedUp={keyboardDrag?.deal.id === deal.id}
                        onDragStart={() => {
                          setPointerDeal(deal);
                          setKeyboardDrag(null);
                        }}
                        onDragEnd={() => {
                          setPointerDeal(null);
                          setHoverStageId(null);
                        }}
                        onHandleKeyDown={(e) => handleCardKeyDown(e, deal)}
                        onOpenDeal={onOpenDeal}
                      />
                      <Button
                        variant="link"
                        className="mt-[4px] text-[12.5px]"
                        onClick={() => onOpenCompany(deal.company_id)}
                      >
                        Open company
                      </Button>
                    </li>
                  ))}
                </ul>
                {stage.count > stage.deals.length && (
                  <button
                    type="button"
                    onClick={() => onShowStage(stage.name)}
                    className="mt-[8px] w-full bg-transparent border-0 p-[6px] text-[13px] font-semibold text-primary-ink cursor-pointer hover:underline"
                  >
                    See all {formatNumber(stage.count)} in the list
                  </button>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {gatePrompt && (
        <StageGateDialog
          deal={gatePrompt.deal}
          stage={gatePrompt.stage}
          onClose={() => setGatePrompt(null)}
          onOpenDeal={onOpenDeal}
        />
      )}
    </div>
  );
}

function trialStatusLabel(trialEndsAt: string | null | undefined): {
  label: string;
  tone: 'warning' | 'danger';
} | null {
  if (!trialEndsAt) return null;
  const ms = Date.parse(trialEndsAt) - Date.now();
  if (Number.isNaN(ms)) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return { label: 'Trial ended', tone: 'danger' };
  if (days === 0) return { label: 'Trial ends today', tone: 'warning' };
  return { label: `Trial ends in ${days}d`, tone: 'warning' };
}

function DealCard({
  deal,
  stages,
  ownerName,
  canMove,
  isDragging,
  isKeyboardPickedUp,
  onDragStart,
  onDragEnd,
  onHandleKeyDown,
  onOpenDeal,
}: {
  deal: DealRow;
  stages: StageRow[];
  ownerName: string;
  canMove: boolean;
  isDragging: boolean;
  isKeyboardPickedUp: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onHandleKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onOpenDeal: (id: string) => void;
}) {
  const trialBadge = deal.stage_category === 'open' ? trialStatusLabel(deal.trial_ends_at) : null;

  return (
    <div
      draggable={canMove}
      onDragStart={(e) => {
        if (!canMove) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', deal.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      style={isKeyboardPickedUp ? { boxShadow: 'var(--shadow-lift)' } : undefined}
      className={`rounded-[8px] p-[12px] space-y-[6px] transition-shadow ${
        isDragging
          ? 'bg-bg-alt border border-dashed border-line-strong'
          : 'bg-surface border border-line'
      }`}
    >
      <div className="flex items-start justify-between gap-[6px]">
        <button
          type="button"
          onClick={() => onOpenDeal(deal.id)}
          className="block flex-1 min-w-0 bg-transparent border-0 p-0 text-left cursor-pointer group"
        >
          <span className="block font-semibold text-ink group-hover:underline">
            {deal.company_name ?? deal.name}
          </span>
          <span className="block text-[13.5px] text-ink-2">{deal.name}</span>
        </button>
        {canMove && (
          <button
            type="button"
            aria-label={`Drag ${deal.name}, currently in ${deal.stage_name}`}
            aria-pressed={isKeyboardPickedUp}
            onKeyDown={onHandleKeyDown}
            className="w-[28px] h-[28px] shrink-0 inline-flex items-center justify-center rounded-pill bg-transparent border-0 text-ink-2 hover:bg-bg-alt cursor-grab active:cursor-grabbing"
          >
            <GripVertical size={15} strokeWidth={1.6} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="flex justify-between text-[13px] text-ink-2 gap-[8px]">
        <span className="tabular-nums text-ink">
          {monthly(deal.monthly_value_minor, deal.currency)}
        </span>
        <span>{ownerName}</span>
      </div>
      <div className="flex flex-wrap items-center gap-[6px] text-[12.5px] text-ink-2">
        {deal.expected_close_date && (
          <span>Expected close {formatDate(deal.expected_close_date)}</span>
        )}
        {trialBadge && <StatusBadge tone={trialBadge.tone}>{trialBadge.label}</StatusBadge>}
        {deal.is_idle && <StatusBadge tone="danger">Idle {deal.idle_days ?? 14} days</StatusBadge>}
      </div>
      {canMove && (
        <div className="pt-[4px]">
          {/* A closed deal can only be reopened into an open stage. */}
          <StageMover
            deal={deal}
            stages={
              deal.stage_category === 'open' ? stages : stages.filter((s) => s.category === 'open')
            }
            compact
          />
        </div>
      )}
    </div>
  );
}

function DealList({
  pipelineId,
  stages,
  state,
  setState,
  onSetSearch,
  filtered,
  onClear,
  onOpenDeal,
}: {
  pipelineId: string | null;
  stages: StageRow[];
  state: typeof DEFAULTS;
  setState: (patch: Partial<typeof DEFAULTS>) => void;
  onSetSearch: (q: string) => void;
  filtered: boolean;
  onClear: () => void;
  onOpenDeal: (id: string) => void;
}) {
  const me = useMe();
  const ownerName = useUserNames();
  const [density, setDensity] = useTableDensity('deal');
  const closed = rangeParam(state.closed);
  const filter = allOf([
    pipelineId !== null && { field: 'pipelineId', op: 'eq', value: pipelineId },
    state.stage !== '' && { field: 'stage', op: 'eq', value: state.stage },
    state.owner !== '' && { field: 'ownerId', op: 'eq', value: state.owner },
    state.outcome !== '' && { field: 'stageCategory', op: 'eq', value: state.outcome },
    closed !== null && { field: 'closedAt', op: 'between', value: closed },
    state.market !== '' && { field: 'market', op: 'eq', value: state.market },
  ]);
  const { query, items, total } = usePagedList(
    ['deals', { q: state.q, sort: state.sort, filter }],
    (cursor) => api.listDeals({ q: state.q, sort: state.sort, filter, cursor, limit: 50 }),
  );
  const canBulk = canUseBulkActions(me, 'deal');
  const selection = useBulkSelection(items, JSON.stringify({ q: state.q, filter }));
  const cellClass = densityTdClass(density);

  const listFiltered =
    filtered ||
    state.stage !== '' ||
    state.outcome !== '' ||
    closed !== null ||
    state.market !== '';
  const chips = [
    ...(state.outcome
      ? [
          {
            key: 'outcome',
            label: OUTCOME_LABEL[state.outcome] ?? state.outcome,
            onRemove: () => setState({ outcome: '' }),
          },
        ]
      : []),
    ...(closed
      ? [
          {
            key: 'closed',
            label: `Closed ${rangeLabel(closed, viewerTimeZone())}`,
            onRemove: () => setState({ closed: '' }),
          },
        ]
      : []),
    ...(state.market
      ? [
          {
            key: 'market',
            label: MARKET_NAME[state.market] ?? state.market,
            onRemove: () => setState({ market: '' }),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-[8px]">
      <SavedViewsBar
        entity="deal"
        state={state}
        defaults={DEFAULTS}
        excludeParamKeys={['sort', 'view']}
        filter={filter}
        sort={state.sort}
        density={density}
        onChangeDensity={setDensity}
        onApplyView={({ params, sort }) => {
          onSetSearch(params['q'] ?? '');
          setState({ ...params, sort, view: 'list' });
        }}
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-[8px]">
        <Select
          aria-label="Stage"
          value={state.stage}
          onChange={(e) => setState({ stage: e.target.value })}
          className="sm:w-[220px]"
        >
          <option value="">All stages</option>
          {stages.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </Select>
        <FilterChips chips={chips} />
        <div className="sm:ml-auto">
          <ExportButton entity="deal" q={state.q} sort={state.sort} filter={filter} total={total} />
        </div>
      </div>
      <DataPanel
        query={{ ...query, isFetching: query.isFetching && !query.isFetchingNextPage }}
        isEmpty={items.length === 0}
        emptyTitle={listFiltered ? 'No deals match these filters' : 'No deals yet'}
        emptyDescription={
          listFiltered
            ? 'Clear the filters to see every deal in this pipeline.'
            : 'Convert a qualified lead to create its first deal.'
        }
        emptyActionLabel={listFiltered ? 'Clear filters' : undefined}
        onEmptyAction={listFiltered ? onClear : undefined}
        footer={
          <ListFooter
            noun="deals"
            shown={items.length}
            total={total}
            hasMore={query.hasNextPage}
            loading={query.isFetchingNextPage}
            onMore={() => void query.fetchNextPage()}
          />
        }
      >
        {canBulk && (
          <BulkSelectAllBanner
            selection={selection}
            loadedCount={items.length}
            total={total}
            noun="deals"
          />
        )}
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              {canBulk && <BulkSelectHeaderCell selection={selection} noun="deals" />}
              <SortHeader
                label="Deal"
                field="name"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                className={canBulk ? '' : 'pl-[16px]'}
              />
              <th scope="col" className={thClass}>
                Stage
              </th>
              <SortHeader
                label="Monthly value"
                field="value"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                descFirst
                className="text-right"
              />
              <SortHeader
                label="Expected close"
                field="closeDate"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
              />
              <th scope="col" className={thClass}>
                Owner
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => {
              const selected = canBulk && selection.isSelected(d.id);
              return (
                <tr key={d.id} className={densityRowClass(density, selected)}>
                  {canBulk && (
                    <BulkSelectRowCell
                      id={d.id}
                      label={d.name}
                      selection={selection}
                      density={density}
                    />
                  )}
                  <td className={`${cellClass} ${canBulk ? '' : 'pl-[16px]'} min-w-[220px]`}>
                    <button
                      type="button"
                      onClick={() => onOpenDeal(d.id)}
                      className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                    >
                      {d.name}
                    </button>
                    <div className="text-[13px] text-ink-3">{d.company_name}</div>
                    {d.tags && d.tags.length > 0 && (
                      <div className="flex flex-wrap gap-[4px] mt-[2px]">
                        {d.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="inline-block px-[6px] py-[1px] rounded-pill bg-bg-alt text-[11.5px] text-ink-2"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={cellClass}>
                    <StatusBadge
                      tone={
                        d.stage_category === 'won'
                          ? 'success'
                          : d.stage_category === 'lost'
                            ? 'danger'
                            : 'brand'
                      }
                    >
                      {d.stage_name}
                    </StatusBadge>
                  </td>
                  <td className={`${cellClass} text-right tabular-nums whitespace-nowrap`}>
                    {monthly(d.monthly_value_minor, d.currency)}
                  </td>
                  <td className={`${cellClass} text-ink-2 whitespace-nowrap`}>
                    {d.expected_close_date ? formatDate(d.expected_close_date) : '—'}
                  </td>
                  <td className={`${cellClass} text-ink-2 whitespace-nowrap`}>
                    {ownerName(d.owner_user_id)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>

      {canBulk && (
        <BulkActionBar
          entity="deal"
          selection={selection}
          total={total}
          q={state.q}
          filter={filter}
        />
      )}
    </div>
  );
}
