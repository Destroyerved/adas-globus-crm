import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';
import { api } from '@/lib/api.js';
import { useUserNames } from '@/features/shared/live-kit.js';
import { can, useMe } from '@/features/shared/list-kit.js';
import { CompanyEditDrawer } from '@/features/records/edit-drawers.js';
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
import { Timeline } from '@/features/records/timeline.js';
import { ACCOUNT_STATUS_LABEL, accountStatusTone } from './companies-screen.js';

/** Company page (PRD 4.3; DESIGN 6.9, 6.10). */
export function CompanyProfileScreen({
  companyId,
  onBack,
  onOpenDeals,
  onOpenContact,
  onOpenDeal,
}: {
  companyId: string | null;
  onBack: () => void;
  onOpenDeals: () => void;
  onOpenContact: (id: string) => void;
  onOpenDeal: (id: string) => void;
}) {
  const me = useMe();
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const [editing, setEditing] = useState(false);
  const key = ['company', companyId] as const;
  const profile = useQuery({
    queryKey: key,
    queryFn: () => api.getCompanyProfile(companyId as string),
    enabled: companyId !== null,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ['companies'] }),
    ]);

  const back = <BackLink label="All companies" onClick={onBack} />;
  if (companyId === null) {
    return (
      <div className="space-y-[16px]">
        {back}
        <p className="text-ink-2">Choose a company from the list.</p>
      </div>
    );
  }
  if (!profile.isSuccess) return <ProfileStatus back={back} query={profile} />;

  const { company, contacts, deals, tasks } = profile.data;
  const location = [company.city, company.state_province].filter(Boolean).join(', ');
  const canWrite = can(me, 'companies.write');

  return (
    <div className="space-y-[16px]" data-testid="company-profile-screen">
      {back}
      <ProfileHeader
        eyebrow="COMPANY"
        title={company.name}
        meta={
          <>
            <StatusBadge tone={accountStatusTone(company.account_status)}>
              {ACCOUNT_STATUS_LABEL[company.account_status] ?? company.account_status}
            </StatusBadge>
            <MarketBadge market={company.market} />
            {location && <span>{location}</span>}
            <span>· {company.firm_type}</span>
            <span>· Owner {ownerName(company.owner_user_id)}</span>
            {company.domain && (
              <a
                href={`https://${company.domain}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary-ink font-semibold"
              >
                · {company.domain}
              </a>
            )}
          </>
        }
        actions={
          <>
            {canWrite && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit company
              </Button>
            )}
            {can(me, 'records.delete') && (
              <DeleteRecordButton
                entityType="company"
                entityId={company.id}
                name={company.name}
                onDeleted={onBack}
              />
            )}
          </>
        }
      />

      <TwoColumn
        main={
          <>
            <Panel title={`Contacts (${contacts.length})`} padded>
              {contacts.length === 0 ? (
                <p className="m-0 text-ink-2">No contacts at this company yet.</p>
              ) : (
                <ul className="divide-y divide-line m-0 p-0 list-none">
                  {contacts.map((c) => (
                    <li key={c.id} className="py-[10px] flex flex-wrap justify-between gap-[8px]">
                      <div>
                        <button
                          type="button"
                          onClick={() => onOpenContact(c.id)}
                          className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                        >
                          {c.full_name}
                        </button>
                        <div className="text-[13px] text-ink-3">
                          {[c.title, c.primary_email].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      {c.do_not_contact && <StatusBadge tone="danger">Do not contact</StatusBadge>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Timeline" padded>
              <Timeline
                entityType="company"
                entityId={company.id}
                canWrite={canWrite}
                onChanged={() => void refresh()}
              />
            </Panel>
          </>
        }
        aside={
          <>
            <Panel
              title={`Deals (${deals.length})`}
              padded
              actions={
                deals.length > 0 ? (
                  <Button variant="link" onClick={onOpenDeals}>
                    Open board
                  </Button>
                ) : undefined
              }
            >
              {deals.length === 0 ? (
                <p className="m-0 text-ink-2">No deals yet. Convert a lead to start one.</p>
              ) : (
                <ul className="m-0 p-0 list-none space-y-[10px]">
                  {deals.map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => onOpenDeal(d.id)}
                        className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                      >
                        {d.name}
                      </button>
                      <div className="text-[13px] text-ink-2 flex flex-wrap gap-[6px] items-center">
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
                        <span className="tabular-nums">
                          {formatMoney(
                            { amountMinor: BigInt(d.monthly_value_minor), currency: d.currency },
                            { perMonth: true },
                          )}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Tags" padded>
              <TagEditor
                entityType="company"
                entityId={company.id}
                tags={company.tags ?? []}
                canWrite={canWrite}
                onSaved={() => void refresh()}
              />
            </Panel>
            <Panel title="Details" padded>
              <DetailList
                items={[
                  ['Firm size', company.staff_band ? `${company.staff_band} staff` : null],
                  ['Time zone', company.timezone],
                  ['Software', (company.accounting_software ?? []).join(', ')],
                  ['Services needed', (company.services_needed ?? []).join(', ')],
                ]}
              />
            </Panel>
            <TasksPanel
              tasks={tasks}
              link={{ companyId: company.id }}
              canWrite={can(me, 'tasks.write')}
              queryKeys={[key]}
            />
          </>
        }
      />

      {editing && (
        <CompanyEditDrawer
          company={company}
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
