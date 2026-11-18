import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney, formatNumber, type Currency } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';
import { api } from '@/lib/api.js';
import { useUserNames } from '@/features/shared/live-kit.js';
import { can, useMe } from '@/features/shared/list-kit.js';
import { DealEditDrawer } from '@/features/records/edit-drawers.js';
import { CustomFieldsPanel } from '@/features/records/custom-fields-panel.js';
import {
  BackLink,
  DeleteRecordButton,
  DetailList,
  ProfileHeader,
  ProfileStatus,
  TasksPanel,
  TwoColumn,
} from '@/features/records/profile-kit.js';
import { TagEditor } from '@/features/records/tag-editor.js';
import { Timeline, viewerTimeZone } from '@/features/records/timeline.js';
import { StageMover } from './stage-mover.js';
import { DealContactsPanel } from './deal-contacts-panel.js';

function money(minor: string | undefined, currency: Currency, perMonth = false): string {
  return formatMoney({ amountMinor: BigInt(minor ?? '0'), currency }, { perMonth });
}

/** Deal page (PRD 3.3, 4.6): stage, value, contract terms, stakeholder contacts, tasks and timeline. */
export function DealProfileScreen({
  dealId,
  onBack,
  onOpenCompany,
  onOpenContact,
}: {
  dealId: string | null;
  onBack: () => void;
  onOpenCompany: (id: string) => void;
  onOpenContact: (id: string) => void;
}) {
  const me = useMe();
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const timeZone = viewerTimeZone();
  const [editing, setEditing] = useState(false);
  const key = ['deal', dealId] as const;
  const profile = useQuery({
    queryKey: key,
    queryFn: () => api.getDeal(dealId as string),
    enabled: dealId !== null,
  });
  const refresh = () =>
    Promise.all(
      [key, ['deals'], ['board']].map((k) => queryClient.invalidateQueries({ queryKey: k })),
    );

  const back = <BackLink label="Deals" onClick={onBack} />;
  if (dealId === null) {
    return (
      <div className="space-y-[16px]">
        {back}
        <p className="text-ink-2">Choose a deal from the board.</p>
      </div>
    );
  }
  if (!profile.isSuccess) return <ProfileStatus back={back} query={profile} />;

  const { deal, company, primaryContact, dealContacts = [], tasks, stages } = profile.data;
  const canWrite = can(me, 'deals.write');
  const tone =
    deal.stage_category === 'won' ? 'success' : deal.stage_category === 'lost' ? 'danger' : 'brand';
  const current = stages.find((s) => s.name === deal.stage_name);

  return (
    <div className="space-y-[16px]" data-testid="deal-profile-screen">
      {back}
      <ProfileHeader
        eyebrow="DEAL"
        title={deal.name}
        meta={
          <>
            <StatusBadge tone={tone}>{deal.stage_name}</StatusBadge>
            {company && <MarketBadge market={company.market} />}
            {company && (
              <button
                type="button"
                onClick={() => onOpenCompany(company.id)}
                className="bg-transparent border-0 p-0 text-[14px] font-semibold text-primary-ink cursor-pointer hover:underline"
              >
                {company.name}
              </button>
            )}
            <span className="tabular-nums">
              · {money(deal.monthly_value_minor, deal.currency, true)}
            </span>
            <span>· Owner {ownerName(deal.owner_user_id)}</span>
          </>
        }
        actions={
          <>
            {canWrite && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit deal
              </Button>
            )}
            {can(me, 'records.delete') && (
              <DeleteRecordButton
                entityType="deal"
                entityId={deal.id}
                name={deal.name}
                onDeleted={onBack}
              />
            )}
          </>
        }
      />

      <ol aria-label="Pipeline stages" className="m-0 p-0 list-none flex flex-wrap gap-[6px]">
        {stages.map((s) => {
          const reached = current
            ? s.stage_order <= current.stage_order && s.category === 'open'
            : false;
          const isCurrent = s.name === deal.stage_name;
          return (
            <li
              key={s.id}
              aria-current={isCurrent ? 'step' : undefined}
              className={`h-[28px] px-[12px] inline-flex items-center rounded-pill text-[12.5px] font-semibold ${isCurrent ? 'bg-primary text-primary-foreground' : reached ? 'bg-tint text-primary-ink' : 'bg-bg-alt text-ink-3'}`}
            >
              {s.name}
            </li>
          );
        })}
      </ol>

      <TwoColumn
        main={
          <>
            <Panel title="Deal terms" padded>
              <DetailList
                items={[
                  ['Monthly value', money(deal.monthly_value_minor, deal.currency, true)],
                  ['Term', deal.term_months ? `${formatNumber(deal.term_months)} months` : null],
                  ['One-time fees', money(deal.one_time_value_minor, deal.currency)],
                  [
                    'Contract value',
                    money(
                      (
                        BigInt(deal.monthly_value_minor) * BigInt(deal.term_months ?? 12) +
                        BigInt(deal.one_time_value_minor ?? '0')
                      ).toString(),
                      deal.currency,
                    ),
                  ],
                  ['Staff (FTE)', String(deal.fte_count)],
                  ['Engagement model', deal.engagement_model],
                  ['Services', (deal.services ?? []).join(', ')],
                  [
                    'Win chance',
                    `${deal.probability}%${deal.probability_override ? ' (set by hand)' : ''}`,
                  ],
                  [
                    'Expected close',
                    deal.expected_close_date ? formatDate(deal.expected_close_date) : null,
                  ],
                  ['Trial role', deal.trial_candidate_role],
                  ['Closed', deal.closed_at ? formatDate(deal.closed_at, timeZone) : null],
                  ['Lost reason', deal.lost_reason],
                ]}
              />
            </Panel>
            <CustomFieldsPanel
              entityType="deal"
              entityId={deal.id}
              version={deal.version}
              values={deal.custom_fields}
              canWrite={canWrite}
              onSaved={() => void refresh()}
            />
            <Panel title="Timeline" padded>
              <Timeline
                entityType="deal"
                entityId={deal.id}
                canWrite={canWrite}
                onChanged={() => void refresh()}
              />
            </Panel>
          </>
        }
        aside={
          <>
            {canWrite && (
              <Panel title="Move stage" padded>
                <StageMover
                  deal={deal}
                  stages={
                    deal.stage_category === 'open'
                      ? stages
                      : stages.filter((s) => s.category === 'open')
                  }
                />
              </Panel>
            )}
            <DealContactsPanel
              dealId={deal.id}
              companyId={deal.company_id}
              primaryContact={primaryContact}
              dealContacts={dealContacts}
              canWrite={canWrite}
              onOpenContact={onOpenContact}
              onChanged={() => void refresh()}
            />
            <Panel title="Tags" padded>
              <TagEditor
                entityType="deal"
                entityId={deal.id}
                tags={deal.tags ?? []}
                canWrite={canWrite}
                onSaved={() => void refresh()}
              />
            </Panel>
            <TasksPanel
              tasks={tasks}
              link={{ dealId: deal.id, companyId: deal.company_id }}
              canWrite={can(me, 'tasks.write')}
              queryKeys={[key]}
            />
          </>
        }
      />

      {editing && (
        <DealEditDrawer
          deal={{ ...deal, company_name: company?.name }}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
