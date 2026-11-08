import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatMoney, formatNumber, type Currency } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { api, type BoardStage, type DealRow, type StageRow } from '@/lib/api.js';
import {
  DataPanel,
  PageHeader,
  SearchBox,
  errorMessage,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
  useUserNames,
} from '@/features/shared/live-kit.js';
import {
  ListFooter,
  OwnerFilter,
  SortHeader,
  Toolbar,
  allOf,
  can,
  useMe,
  usePagedList,
  useSearchText,
  useUrlState,
} from '@/features/shared/list-kit.js';
import { StageMover } from './stage-mover.js';

function monthly(minor: string, currency: Currency, compact = false): string {
  return formatMoney({ amountMinor: BigInt(minor), currency }, { perMonth: true, compact });
}

const DEFAULTS = { q: '', owner: '', pipeline: '', view: 'board', sort: '-updatedAt', stage: '' };

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
    setState({ q: '', owner: '', stage: '' });
  };

  return (
    <div className="space-y-[16px]" data-testid="deals-kanban-screen">
      <PageHeader kicker={pipeline?.name ?? 'Pipeline'} title="Deals" />
      <Toolbar>
        <SearchBox value={search} onChange={setSearch} label="Search deal or company" />
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-[8px]">
          {(pipelines.data?.length ?? 0) > 1 && (
            <Select
              aria-label="Pipeline"
              value={pipeline?.id ?? ''}
              onChange={(e) => setState({ pipeline: e.target.value, stage: '' })}
              className="sm:w-[180px]"
            >
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
          pipelineId={pipeline.id}
          stages={pipeline.stages}
          state={state}
          setState={setState}
          filtered={filtered}
          onClear={clearFilters}
          onOpenDeal={onOpenDeal}
        />
      )}
    </div>
  );
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
  const ownerName = useUserNames();
  const board = useQuery({
    queryKey: ['board', pipelineId, { owner, q }],
    queryFn: () => api.board(pipelineId, { owner: owner || undefined, q: q || undefined }),
  });
  const totalDeals = useMemo(
    () => (board.data?.stages ?? []).reduce((sum, s) => sum + s.count, 0),
    [board.data],
  );

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

  return (
    <div className="relative overflow-x-auto pb-[8px]" aria-busy={board.isFetching || undefined}>
      <div className="flex gap-[12px] min-w-max">
        {board.data.stages.map((stage: BoardStage) => (
          <section
            key={stage.id}
            aria-label={`${stage.name}, ${stage.count} deals`}
            className="w-[288px] shrink-0 bg-bg-alt rounded-[10px] p-[8px]"
          >
            <header className="px-[4px] pb-[8px]">
              <div className="flex justify-between items-baseline">
                <h2 className="m-0 text-[14px] font-semibold text-ink">{stage.name}</h2>
                <span className="text-[13px] text-ink-3 tabular-nums">
                  {formatNumber(stage.count)}
                </span>
              </div>
              <div className="text-[12.5px] text-ink-3 tabular-nums">
                {stage.totals.length === 0
                  ? '—'
                  : stage.totals
                      .map((t) => monthly(t.monthlyValueMinor, t.currency, true))
                      .join(' · ')}
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
        ))}
      </div>
    </div>
  );
}

function DealCard({
  deal,
  stages,
  ownerName,
  canMove,
  onOpenDeal,
}: {
  deal: DealRow;
  stages: StageRow[];
  ownerName: string;
  canMove: boolean;
  onOpenDeal: (id: string) => void;
}) {
  return (
    <div className="bg-surface border border-line rounded-[8px] p-[12px] space-y-[6px]">
      <button
        type="button"
        onClick={() => onOpenDeal(deal.id)}
        className="block w-full bg-transparent border-0 p-0 text-left cursor-pointer group"
      >
        <span className="block font-semibold text-ink group-hover:underline">
          {deal.company_name ?? deal.name}
        </span>
        <span className="block text-[13.5px] text-ink-2">{deal.name}</span>
      </button>
      <div className="flex justify-between text-[13px] text-ink-3 gap-[8px]">
        <span className="tabular-nums text-ink">
          {monthly(deal.monthly_value_minor, deal.currency)}
        </span>
        <span>{ownerName}</span>
      </div>
      <div className="flex flex-wrap items-center gap-[6px] text-[12.5px] text-ink-3">
        {deal.expected_close_date && (
          <span>Expected close {formatDate(deal.expected_close_date)}</span>
        )}
        {deal.is_idle && (
          <StatusBadge tone="warning">No activity for {deal.idle_days ?? 14} days</StatusBadge>
        )}
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
  filtered,
  onClear,
  onOpenDeal,
}: {
  pipelineId: string;
  stages: StageRow[];
  state: typeof DEFAULTS;
  setState: (patch: Partial<typeof DEFAULTS>) => void;
  filtered: boolean;
  onClear: () => void;
  onOpenDeal: (id: string) => void;
}) {
  const ownerName = useUserNames();
  const filter = allOf([
    { field: 'pipelineId', op: 'eq', value: pipelineId },
    state.stage !== '' && { field: 'stage', op: 'eq', value: state.stage },
    state.owner !== '' && { field: 'ownerId', op: 'eq', value: state.owner },
  ]);
  const { query, items, total } = usePagedList(
    ['deals', { q: state.q, sort: state.sort, filter }],
    (cursor) => api.listDeals({ q: state.q, sort: state.sort, filter, cursor, limit: 50 }),
  );
  const listFiltered = filtered || state.stage !== '';

  return (
    <div className="space-y-[8px]">
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
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <SortHeader
                label="Deal"
                field="name"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                className="pl-[16px]"
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
            {items.map((d) => (
              <tr key={d.id} className={rowClass}>
                <td className={`${tdClass} pl-[16px] min-w-[220px]`}>
                  <button
                    type="button"
                    onClick={() => onOpenDeal(d.id)}
                    className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                  >
                    {d.name}
                  </button>
                  <div className="text-[13px] text-ink-3">{d.company_name}</div>
                </td>
                <td className={tdClass}>
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
                <td className={`${tdClass} text-right tabular-nums whitespace-nowrap`}>
                  {monthly(d.monthly_value_minor, d.currency)}
                </td>
                <td className={`${tdClass} text-ink-2 whitespace-nowrap`}>
                  {d.expected_close_date ? formatDate(d.expected_close_date) : '—'}
                </td>
                <td className={`${tdClass} text-ink-2 whitespace-nowrap`}>
                  {ownerName(d.owner_user_id)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
    </div>
  );
}
