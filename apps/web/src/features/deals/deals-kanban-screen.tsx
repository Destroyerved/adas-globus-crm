import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney, type Currency } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state-views.js';
import { PIPELINE_STAGES, api, type DealRow } from '@/lib/api.js';
import { PageHeader, errorMessage, useUserNames } from '@/features/shared/live-kit.js';

/** Stages that need extra details before a deal can enter them (PRD 3.3). */
const STAGE_REQUIREMENT: Record<string, { field: string; label: string; type: string }> = {
  'Free Trial (3-Day)': { field: 'trialCandidateRole', label: 'Trial role', type: 'text' },
  Won: { field: 'contractStartDate', label: 'Contract start date', type: 'date' },
  Lost: { field: 'lostReason', label: 'Why was it lost?', type: 'text' },
};

function monthly(minor: string, currency: Currency): string {
  return formatMoney({ amountMinor: BigInt(minor), currency }, { perMonth: true });
}

function DealCard({
  deal,
  companyName,
  ownerName,
}: {
  deal: DealRow;
  companyName: string;
  ownerName: string;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const [detail, setDetail] = useState('');
  const requirement = STAGE_REQUIREMENT[target];

  const move = useMutation({
    mutationFn: () =>
      api.moveDealStage(deal.id, {
        stageName: target,
        version: deal.version,
        ...(requirement ? { [requirement.field]: detail.trim() } : {}),
      }),
    onSuccess: async () => {
      setTarget('');
      setDetail('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['deals'] }),
        queryClient.invalidateQueries({ queryKey: ['company', deal.company_id] }),
      ]);
    },
  });

  return (
    <div className="bg-surface border border-line rounded-[8px] p-[12px] space-y-[6px]">
      <div className="font-semibold text-ink">{companyName}</div>
      <div className="text-[13.5px] text-ink-2">{deal.name}</div>
      <div className="flex justify-between text-[13px] text-ink-3 gap-[8px]">
        <span className="tabular-nums text-ink">
          {monthly(deal.monthly_value_minor, deal.currency)}
        </span>
        <span>{ownerName}</span>
      </div>
      {deal.expected_close_date && (
        <div className="text-[12.5px] text-ink-3">
          Expected close {formatDate(deal.expected_close_date)}
        </div>
      )}
      <form
        className="grid gap-[6px] pt-[4px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (target && (!requirement || detail.trim())) move.mutate();
        }}
      >
        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setDetail('');
            move.reset();
          }}
          aria-label={`Move ${deal.name} to another stage`}
          className="h-[32px] rounded-[8px] border border-input bg-surface px-[8px] text-[13px]"
        >
          <option value="">Move to…</option>
          {PIPELINE_STAGES.filter((s) => s !== deal.stage_name).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {requirement && (
          <Input
            type={requirement.type}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder={requirement.label}
            aria-label={requirement.label}
            required
          />
        )}
        {target && (
          <Button type="submit" variant="outline" size="sm" disabled={move.isPending}>
            {move.isPending ? 'Moving…' : `Move to ${target}`}
          </Button>
        )}
        {move.isError && (
          <p role="alert" className="m-0 text-[12.5px] text-danger">
            {errorMessage(move.error)}
          </p>
        )}
      </form>
    </div>
  );
}

export function DealsKanbanScreen({ onOpenCompany }: { onOpenCompany: (id: string) => void }) {
  const deals = useQuery({ queryKey: ['deals'], queryFn: api.listDeals });
  const companies = useQuery({ queryKey: ['companies'], queryFn: api.listCompanies });
  const ownerName = useUserNames();

  const companyName = useMemo(() => {
    const byId = new Map((companies.data ?? []).map((c) => [c.id, c.name]));
    return (id: string) => byId.get(id) ?? 'Company';
  }, [companies.data]);

  const byStage = useMemo(() => {
    const map = new Map<string, DealRow[]>(PIPELINE_STAGES.map((s) => [s, []]));
    for (const d of deals.data ?? []) map.get(d.stage_name)?.push(d);
    return map;
  }, [deals.data]);

  const openCount = (deals.data ?? []).filter((d) => d.stage_category === 'open').length;

  return (
    <div className="space-y-[16px]" data-testid="deals-kanban-screen">
      <PageHeader
        kicker="New business pipeline"
        title="Deals"
        count={deals.data ? openCount : undefined}
      />
      {deals.isPending && (
        <div className="bg-surface border border-line rounded-[10px]">
          <LoadingState rows={5} />
        </div>
      )}
      {deals.isError && (
        <div className="bg-surface border border-line rounded-[10px]">
          <ErrorState message={errorMessage(deals.error)} onRetry={() => void deals.refetch()} />
        </div>
      )}
      {deals.isSuccess && deals.data.length === 0 && (
        <div className="bg-surface border border-line rounded-[10px]">
          <EmptyState
            title="No deals yet"
            description="Convert a qualified lead to create its first deal."
          />
        </div>
      )}
      {deals.isSuccess && deals.data.length > 0 && (
        <div className="relative overflow-x-auto pb-[8px]">
          <div className="flex gap-[12px] min-w-max">
            {PIPELINE_STAGES.map((stage) => {
              const items = byStage.get(stage) ?? [];
              return (
                <section
                  key={stage}
                  aria-label={`${stage}, ${items.length} deals`}
                  className="w-[288px] shrink-0 bg-bg-alt rounded-[10px] p-[8px]"
                >
                  <header className="px-[4px] pb-[8px] flex justify-between items-baseline">
                    <h2 className="m-0 text-[14px] font-semibold text-ink">{stage}</h2>
                    <span className="text-[13px] text-ink-3 tabular-nums">{items.length}</span>
                  </header>
                  <ul className="m-0 p-0 list-none space-y-[8px]">
                    {items.map((deal) => (
                      <li key={deal.id}>
                        <DealCard
                          deal={deal}
                          companyName={companyName(deal.company_id)}
                          ownerName={ownerName(deal.owner_user_id)}
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
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
