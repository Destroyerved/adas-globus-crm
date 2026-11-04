import { useState, type KeyboardEvent } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CheckCircle2, ClockAlert, Plus, Trophy, X, XCircle } from 'lucide-react';
import { formatMoney, type Currency, type Market } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import {
  INITIAL_KANBAN_DEALS,
  KANBAN_STAGES,
  type SyntheticDealCard,
  type SyntheticKanbanStage,
} from '@/lib/synthetic-data.js';
import { type ScreenDataState } from '@/features/leads/leads-screen.js';

export interface DealsKanbanScreenProps {
  onOpenCompany: (companyId: string) => void;
}

const FX_CAD_TO_USD = 0.74;

function toReportingUsdMinor(card: SyntheticDealCard): bigint {
  if (card.currency === 'USD') {
    return card.monthlyValueMinor;
  }
  return BigInt(Math.round(Number(card.monthlyValueMinor) * FX_CAD_TO_USD));
}

interface DraggableDealCardProps {
  deal: SyntheticDealCard;
  isKeyboardGrabbed: boolean;
  onCardKeyDown: (event: KeyboardEvent<HTMLDivElement>, deal: SyntheticDealCard) => void;
  onOpenCompany: () => void;
}

function DraggableDealCard({
  deal,
  isKeyboardGrabbed,
  onCardKeyDown,
  onOpenCompany,
}: DraggableDealCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: deal.id,
  });

  const style: React.CSSProperties | undefined = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        boxShadow: 'var(--shadow-lift)',
        zIndex: 20,
      }
    : isKeyboardGrabbed
      ? {
          boxShadow: 'var(--shadow-lift)',
        }
      : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      tabIndex={0}
      role="listitem"
      aria-roledescription="draggable deal card"
      aria-label={`${deal.companyName} — ${deal.dealName}, ${formatMoney({ amountMinor: deal.monthlyValueMinor, currency: deal.currency }, { compact: true, perMonth: true })}`}
      onKeyDown={(e) => onCardKeyDown(e, deal)}
      className={`rounded-[8px] p-[12px] bg-surface border transition-[border-color,box-shadow,translate] duration-200 cursor-grab active:cursor-grabbing ${
        isDragging
          ? 'border-dashed border-line-strong opacity-85'
          : isKeyboardGrabbed
            ? 'border-primary bg-tint'
            : 'border-line hover:-translate-y-[2px] hover:border-line-strong'
      }`}
    >
      <div className="flex items-start justify-between gap-[8px]">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenCompany();
          }}
          className="font-semibold text-ink text-[14px] text-left hover:underline cursor-pointer bg-transparent border-0 p-0"
        >
          {deal.companyName}
        </button>
        <span className="font-semibold text-ink text-[13.5px] tabular-nums whitespace-nowrap shrink-0">
          {formatMoney(
            { amountMinor: deal.monthlyValueMinor, currency: deal.currency },
            { compact: true, perMonth: true },
          )}
        </span>
      </div>

      <p className="text-body-sm text-ink-2 mt-[4px] mb-0">{deal.dealName}</p>

      <div className="flex items-center justify-between gap-[8px] mt-[10px]">
        <div className="flex items-center gap-[6px]">
          <MarketBadge market={deal.market} />
          <span className="text-[12px] text-ink-3">
            {deal.fteLabel} · {deal.engagementModel}
          </span>
        </div>
        <span
          className="inline-grid place-items-center h-[24px] w-[24px] rounded-pill bg-tint text-primary-ink text-[11px] font-semibold shrink-0"
          title={`Owner: ${deal.ownerName}`}
        >
          {deal.ownerInitials}
        </span>
      </div>

      {deal.badgeText && deal.badgeTone && (
        <div className="mt-[10px] pt-[8px] border-t border-line flex items-center justify-between">
          <StatusBadge
            tone={deal.badgeTone}
            icon={<ClockAlert size={13} strokeWidth={1.6} aria-hidden="true" />}
          >
            {deal.badgeText}
          </StatusBadge>
        </div>
      )}
    </div>
  );
}

interface DroppableStageColumnProps {
  stage: SyntheticKanbanStage;
  deals: SyntheticDealCard[];
  grabbedDealId: string | null;
  onCardKeyDown: (event: KeyboardEvent<HTMLDivElement>, deal: SyntheticDealCard) => void;
  onOpenCompany: () => void;
}

function DroppableStageColumn({
  stage,
  deals,
  grabbedDealId,
  onCardKeyDown,
  onOpenCompany,
}: DroppableStageColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: stage.id });

  const stageTotalUsdMinor = deals.reduce((acc, card) => acc + toReportingUsdMinor(card), 0n);

  return (
    <section
      ref={setNodeRef}
      aria-label={`${stage.name} stage`}
      data-testid={`kanban-col-${stage.id}`}
      className={`w-[288px] shrink-0 rounded-[10px] p-[8px] flex flex-col gap-[8px] transition-colors duration-120 ${
        isOver ? 'bg-tint border border-primary' : 'bg-bg-alt border border-transparent'
      }`}
    >
      {/* Column header (DESIGN.md §6.8) */}
      <header className="px-[6px] pt-[4px] pb-[6px] border-b border-line">
        <div className="flex items-center justify-between gap-[8px]">
          <div className="flex items-center gap-[6px]">
            <h2 className="text-[14px] font-semibold text-ink m-0">{stage.name}</h2>
            <span className="text-[13px] text-ink-3 tabular-nums">{deals.length}</span>
          </div>
          <span className="text-[13px] text-ink-3 tabular-nums">{stage.probability}%</span>
        </div>
        <div className="text-[13px] text-ink-3 tabular-nums mt-[2px]">
          {formatMoney({ amountMinor: stageTotalUsdMinor, currency: 'USD' }, { perMonth: true })}{' '}
          <span>total</span>
        </div>
      </header>

      <div className="flex flex-col gap-[8px] min-h-[180px]" role="list">
        {deals.map((deal) => (
          <DraggableDealCard
            key={deal.id}
            deal={deal}
            isKeyboardGrabbed={grabbedDealId === deal.id}
            onCardKeyDown={onCardKeyDown}
            onOpenCompany={onOpenCompany}
          />
        ))}
      </div>
    </section>
  );
}

function CollapsedOutcomeDropZone({
  id,
  label,
  count,
  valueLabel,
  tone,
}: {
  id: string;
  label: string;
  count: number;
  valueLabel: string;
  tone: 'won' | 'lost';
}) {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      role="region"
      aria-label={`${label} drop zone`}
      className={`rounded-[10px] p-[12px] border transition-colors duration-120 ${
        isOver ? 'bg-tint border-primary' : 'bg-surface border-line'
      }`}
    >
      <div className="flex items-center justify-between gap-[8px]">
        <span className="inline-flex items-center gap-[6px] font-semibold text-ink text-[14px]">
          {tone === 'won' ? (
            <Trophy size={15} strokeWidth={1.6} className="text-success" aria-hidden="true" />
          ) : (
            <XCircle size={15} strokeWidth={1.6} className="text-ink-3" aria-hidden="true" />
          )}
          <span>{label}</span>
        </span>
        <span className="text-[13px] text-ink-3 tabular-nums">{count} deals</span>
      </div>
      <div className="text-[13px] text-ink-2 tabular-nums mt-[4px]">{valueLabel}</div>
      <div className="mt-[8px] pt-[8px] border-t border-dashed border-line-strong text-[12px] text-ink-3">
        Drop card here to mark {label.toLowerCase()}
      </div>
    </div>
  );
}

export function DealsKanbanScreen({ onOpenCompany }: DealsKanbanScreenProps) {
  const [deals, setDeals] = useState<SyntheticDealCard[]>(INITIAL_KANBAN_DEALS);
  const [wonCount, setWonCount] = useState(14);
  const [lostCount, setLostCount] = useState(5);
  const [dataState, setDataState] = useState<ScreenDataState>('loaded');
  const [pipelineTab, setPipelineTab] = useState<'new_business' | 'expansion'>('new_business');
  const [grabbedDealId, setGrabbedDealId] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [newDealFirm, setNewDealFirm] = useState('');
  const [newDealTitle, setNewDealTitle] = useState('');
  const [newDealMonthlyMajor, setNewDealMonthlyMajor] = useState('5600');
  const [newDealCurrency, setNewDealCurrency] = useState<Currency>('USD');
  const [newDealMarket, setNewDealMarket] = useState<Market>('US');

  const handleCreateDeal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDealFirm.trim() || !newDealTitle.trim()) {
      return;
    }
    const parsedMajor = Number(newDealMonthlyMajor) || 5600;
    const created: SyntheticDealCard = {
      id: `deal_${Date.now()}`,
      stageId: 'stage_new',
      companyName: newDealFirm.trim(),
      dealName: newDealTitle.trim(),
      monthlyValueMinor: BigInt(Math.round(parsedMajor * 100)),
      currency: newDealCurrency,
      termMonths: 12,
      market: newDealMarket,
      fteLabel: '2.0 FTE',
      engagementModel: 'Full-time',
      ownerName: 'Arjun Mehta',
      ownerInitials: 'AM',
    };
    setDeals((prev) => [created, ...prev]);
    setNewDealFirm('');
    setNewDealTitle('');
    setNewDealOpen(false);
    setLiveAnnouncement(`Created deal ${created.dealName} for ${created.companyName}.`);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const moveDealToStage = (dealId: string, targetStageId: string) => {
    const deal = deals.find((d) => d.id === dealId);
    if (!deal) {
      return;
    }

    if (targetStageId === 'zone_won') {
      setDeals((prev) => prev.filter((d) => d.id !== dealId));
      setWonCount((c) => c + 1);
      setLiveAnnouncement(`Moved ${deal.companyName} deal to Won.`);
      return;
    }

    if (targetStageId === 'zone_lost') {
      setDeals((prev) => prev.filter((d) => d.id !== dealId));
      setLostCount((c) => c + 1);
      setLiveAnnouncement(`Moved ${deal.companyName} deal to Lost.`);
      return;
    }

    const stage = KANBAN_STAGES.find((s) => s.id === targetStageId);
    if (!stage || deal.stageId === targetStageId) {
      return;
    }

    setDeals((prev) =>
      prev.map((item) => (item.id === dealId ? { ...item, stageId: targetStageId } : item)),
    );
    setLiveAnnouncement(`Moved ${deal.companyName} — ${deal.dealName} to ${stage.name}.`);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) {
      return;
    }
    moveDealToStage(String(active.id), String(over.id));
  };

  // Keyboard accessible Kanban interaction (DESIGN.md §6.8: Space to pick up, arrows to move, Space to drop, Escape to cancel)
  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, deal: SyntheticDealCard) => {
    if (event.key === ' ') {
      event.preventDefault();
      if (grabbedDealId === deal.id) {
        setGrabbedDealId(null);
        const stageName = KANBAN_STAGES.find((s) => s.id === deal.stageId)?.name ?? 'current stage';
        setLiveAnnouncement(`Dropped ${deal.companyName} in ${stageName}.`);
      } else {
        setGrabbedDealId(deal.id);
        setLiveAnnouncement(
          `Picked up ${deal.companyName}. Use Left and Right arrow keys to move stages, Space to drop, Escape to cancel.`,
        );
      }
      return;
    }

    if (grabbedDealId === deal.id) {
      const currentIdx = KANBAN_STAGES.findIndex((s) => s.id === deal.stageId);
      if (event.key === 'ArrowRight' && currentIdx < KANBAN_STAGES.length - 1) {
        event.preventDefault();
        const nextStage = KANBAN_STAGES[currentIdx + 1];
        if (nextStage) {
          moveDealToStage(deal.id, nextStage.id);
        }
      } else if (event.key === 'ArrowLeft' && currentIdx > 0) {
        event.preventDefault();
        const prevStage = KANBAN_STAGES[currentIdx - 1];
        if (prevStage) {
          moveDealToStage(deal.id, prevStage.id);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setGrabbedDealId(null);
        setLiveAnnouncement(`Cancelled moving ${deal.companyName}.`);
      }
    }
  };

  const totalOpenUsdMinor = deals.reduce((acc, card) => acc + toReportingUsdMinor(card), 0n);

  return (
    <div className="space-y-[16px]" data-testid="deals-kanban-screen">
      {/* Live region for screen reader announcements (DESIGN.md §6.8, §9.2) */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      {/* Page header (DESIGN.md §5.3) */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
        <div>
          <div className="kicker mb-[4px]">Recurring engagement pipeline</div>
          <h1 className="text-display text-ink m-0">
            <strong>Deals</strong>{' '}
            <span className="text-ink-3 font-light tabular-nums">
              {deals.length} open ·{' '}
              {formatMoney({ amountMinor: totalOpenUsdMinor, currency: 'USD' }, { perMonth: true })}
            </span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button variant="primary" onClick={() => setNewDealOpen((prev) => !prev)}>
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>New deal</span>
          </Button>
        </div>
      </div>

      {newDealOpen && (
        <form
          onSubmit={handleCreateDeal}
          aria-label="Create new deal"
          className="bg-surface border border-line rounded-[10px] p-[16px] space-y-[12px]"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-title text-ink m-0">New recurring staffing opportunity</h2>
            <button
              type="button"
              onClick={() => setNewDealOpen(false)}
              aria-label="Close new deal form"
              className="text-ink-3 hover:text-ink bg-transparent border-0 cursor-pointer"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-[10px]">
            <Input
              placeholder="CPA firm name"
              aria-label="Deal CPA firm name"
              value={newDealFirm}
              onChange={(e) => setNewDealFirm(e.target.value)}
              required
            />
            <Input
              placeholder="Deal / pod name (e.g. 2 FTE Tax Pod)"
              aria-label="Deal pod name"
              value={newDealTitle}
              onChange={(e) => setNewDealTitle(e.target.value)}
              required
            />
            <Input
              type="number"
              placeholder="Monthly value"
              aria-label="Monthly recurring value"
              value={newDealMonthlyMajor}
              onChange={(e) => setNewDealMonthlyMajor(e.target.value)}
              required
            />
            <div className="flex items-center gap-[8px]">
              <select
                aria-label="Deal currency"
                value={newDealCurrency}
                onChange={(e) => {
                  const curr = e.target.value as Currency;
                  setNewDealCurrency(curr);
                  setNewDealMarket(curr === 'CAD' ? 'CA' : 'US');
                }}
                className="h-[36px] rounded-[8px] border border-line-field bg-surface px-[10px] text-[14px] text-ink"
              >
                <option value="USD">USD (US)</option>
                <option value="CAD">CAD (CA)</option>
              </select>
              <Button type="submit" variant="primary" size="md">
                Save deal
              </Button>
            </div>
          </div>
        </form>
      )}

      {/* Pipeline tabs + state preview switcher */}
      <div className="flex flex-wrap items-center justify-between gap-[12px] border-b border-line">
        <div
          className="flex items-center gap-[20px] overflow-x-auto"
          role="tablist"
          aria-label="Deal pipelines"
        >
          <button
            type="button"
            role="tab"
            aria-selected={pipelineTab === 'new_business'}
            onClick={() => setPipelineTab('new_business')}
            className="view-tab"
          >
            <span>New business · Board</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pipelineTab === 'expansion'}
            onClick={() => setPipelineTab('expansion')}
            className="view-tab"
          >
            <span>Expansion · Board</span>
          </button>
        </div>

        <div className="flex items-center gap-[8px] mb-[6px]">
          <span className="hidden md:inline-flex items-center gap-[5px] text-[12.5px] text-ink-3">
            <CheckCircle2 size={14} strokeWidth={1.6} className="text-primary" aria-hidden="true" />
            <span>Reporting currency: USD (CA$ converted at 0.74)</span>
          </span>
          <div
            className="inline-flex items-center rounded-pill border border-line bg-surface p-[2px]"
            role="group"
            aria-label="Kanban state preview"
          >
            {(['loaded', 'empty', 'loading', 'error'] as const).map((st) => (
              <button
                key={st}
                type="button"
                aria-pressed={dataState === st}
                onClick={() => setDataState(st)}
                className={`h-[26px] px-[8px] rounded-pill text-[12px] font-medium capitalize cursor-pointer border-0 ${
                  dataState === st
                    ? 'bg-tint text-primary-ink font-semibold'
                    : 'bg-transparent text-ink-3'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {dataState === 'loading' && (
        <div className="bg-surface border border-line rounded-[10px]">
          <LoadingState rows={6} />
        </div>
      )}

      {dataState === 'error' && (
        <div className="bg-surface border border-line rounded-[10px]">
          <ErrorState
            message="Could not load the New business pipeline stages."
            requestId="req_01jc9xa4m1r8z"
            onRetry={() => setDataState('loaded')}
          />
        </div>
      )}

      {dataState === 'empty' && (
        <div className="bg-surface border border-line rounded-[10px]">
          <EmptyState
            title="No open deals in this pipeline"
            description="Convert a qualified lead or create a new opportunity to track discovery calls, 3-day free trials and proposals."
            actionLabel="New deal"
            onAction={() => setDataState('loaded')}
          />
        </div>
      )}

      {/* Kanban board area with horizontal scroll inside its container (DESIGN.md §5, §6.8) */}
      {dataState === 'loaded' && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div
            className="flex items-start gap-[12px] overflow-x-auto pb-[12px]"
            data-testid="kanban-board-scroll"
          >
            {KANBAN_STAGES.map((stage) => {
              const stageDeals = deals.filter((d) => d.stageId === stage.id);
              return (
                <DroppableStageColumn
                  key={stage.id}
                  stage={stage}
                  deals={stageDeals}
                  grabbedDealId={grabbedDealId}
                  onCardKeyDown={handleCardKeyDown}
                  onOpenCompany={() => onOpenCompany('comp_01')}
                />
              );
            })}

            {/* Collapsed Won and Lost drop zones at the end of the board (DESIGN.md §6.8) */}
            <div className="w-[220px] shrink-0 flex flex-col gap-[12px]">
              <CollapsedOutcomeDropZone
                id="zone_won"
                label="Won"
                count={wonCount}
                valueLabel="US$64,200/mo won (Q4)"
                tone="won"
              />
              <CollapsedOutcomeDropZone
                id="zone_lost"
                label="Lost"
                count={lostCount}
                valueLabel="US$14,800/mo lost (Q4)"
                tone="lost"
              />
            </div>
          </div>
        </DndContext>
      )}
    </div>
  );
}
