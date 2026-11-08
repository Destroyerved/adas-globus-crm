import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney, formatRelative } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { api } from '@/lib/api.js';
import { useUserNames } from '@/features/shared/live-kit.js';
import { can, useMe } from '@/features/shared/list-kit.js';
import { ContactEditDrawer } from '@/features/records/edit-drawers.js';
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
import { VERIFICATION_TONE } from './contacts-screen.js';

const SUPPRESSION_LABEL: Record<string, string> = {
  unsubscribe: 'Unsubscribed',
  complaint: 'Marked as spam',
  hard_bounce: 'Email bounced',
  manual_dnc: 'Do not contact',
  privacy_erasure: 'Privacy erasure request',
};

/** Contact page (PRD 4.4, 5): details, consent and suppression, deals, sequences, timeline. */
export function ContactProfileScreen({
  contactId,
  onBack,
  onOpenCompany,
  onOpenDeal,
  onOpenLead,
}: {
  contactId: string | null;
  onBack: () => void;
  onOpenCompany: (id: string) => void;
  onOpenDeal: (id: string) => void;
  onOpenLead: (id: string) => void;
}) {
  const me = useMe();
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const timeZone = viewerTimeZone();
  const [editing, setEditing] = useState(false);
  const key = ['contact', contactId] as const;
  const profile = useQuery({
    queryKey: key,
    queryFn: () => api.getContact(contactId as string),
    enabled: contactId !== null,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ['contacts'] }),
    ]);

  const back = <BackLink label="All contacts" onClick={onBack} />;
  if (contactId === null) {
    return (
      <div className="space-y-[16px]">
        {back}
        <p className="text-ink-2">Choose a contact from the list.</p>
      </div>
    );
  }
  if (!profile.isSuccess) return <ProfileStatus back={back} query={profile} />;

  const {
    contact,
    company,
    emails,
    phones,
    deals,
    leads,
    tasks,
    suppression,
    consent,
    enrollments,
  } = profile.data;
  const canWrite = can(me, 'contacts.write');

  return (
    <div className="space-y-[16px]" data-testid="contact-profile-screen">
      {back}
      <ProfileHeader
        eyebrow="CONTACT"
        title={contact.full_name}
        meta={
          <>
            <MarketBadge market={contact.market} />
            {contact.title && <span>{contact.title}</span>}
            {company && (
              <button
                type="button"
                onClick={() => onOpenCompany(company.id)}
                className="bg-transparent border-0 p-0 text-[14px] font-semibold text-primary-ink cursor-pointer hover:underline"
              >
                · {company.name}
              </button>
            )}
            <span>· Owner {ownerName(contact.owner_user_id)}</span>
          </>
        }
        actions={
          <>
            {canWrite && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit contact
              </Button>
            )}
            {can(me, 'records.delete') && (
              <DeleteRecordButton
                entityType="contact"
                entityId={contact.id}
                name={contact.full_name}
                onDeleted={onBack}
              />
            )}
          </>
        }
      />

      {(contact.do_not_contact || suppression) && (
        <Callout tone="danger">
          {suppression
            ? `${SUPPRESSION_LABEL[suppression.reason] ?? 'Suppressed'} on ${formatDate(suppression.created_at, timeZone)}. No email can be sent to this address.`
            : 'Marked do not contact. No outreach can be sent to this person.'}
        </Callout>
      )}

      <TwoColumn
        main={
          <>
            <Panel title="Details" padded>
              <DetailList
                items={[
                  [
                    'Email',
                    <span key="e" className="inline-flex flex-wrap items-center gap-[6px]">
                      {contact.primary_email}
                      {contact.email_verification_status in VERIFICATION_TONE && (
                        <StatusBadge
                          tone={
                            VERIFICATION_TONE[
                              contact.email_verification_status as keyof typeof VERIFICATION_TONE
                            ]
                          }
                        >
                          {contact.email_verification_status}
                        </StatusBadge>
                      )}
                    </span>,
                  ],
                  [
                    'Other emails',
                    emails
                      .filter((e) => !e.is_primary)
                      .map((e) => e.email)
                      .join(', '),
                  ],
                  ['Phone', phones.map((p) => `${p.phone_e164} (${p.phone_label})`).join(', ')],
                  ['Seniority', contact.seniority],
                  ['Job function', contact.job_function],
                  ['Time zone', contact.timezone],
                  [
                    'Last contacted',
                    contact.last_contacted_at ? formatRelative(contact.last_contacted_at) : 'Never',
                  ],
                  [
                    'Consent',
                    consent
                      ? `${consent.basis.replace(/_/g, ' ')} · ${consent.status}${consent.expires_at ? ` until ${formatDate(consent.expires_at, timeZone)}` : ''}`
                      : 'No consent on record',
                  ],
                ]}
              />
            </Panel>
            <Panel title="Timeline" padded>
              <Timeline
                entityType="contact"
                entityId={contact.id}
                canWrite={canWrite}
                onChanged={() => void refresh()}
              />
            </Panel>
          </>
        }
        aside={
          <>
            <Panel title={`Deals (${deals.length})`} padded>
              {deals.length === 0 ? (
                <p className="m-0 text-[14px] text-ink-2">Not on any deal.</p>
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
                        <StatusBadge tone="brand">{d.stage_name}</StatusBadge>
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
            {leads.length > 0 && (
              <Panel title="Leads" padded>
                <ul className="m-0 p-0 list-none space-y-[8px]">
                  {leads.map((l) => (
                    <li key={l.id} className="text-[14px]">
                      <button
                        type="button"
                        onClick={() => onOpenLead(l.id)}
                        className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                      >
                        {l.source}
                      </button>
                      <div className="text-[13px] text-ink-3">
                        {l.status} · {formatDate(l.created_at, timeZone)}
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
            <Panel title="Sequences" padded>
              {enrollments.length === 0 ? (
                <p className="m-0 text-[14px] text-ink-2">Not in any sequence.</p>
              ) : (
                <ul className="m-0 p-0 list-none space-y-[8px]">
                  {enrollments.map((e) => (
                    <li key={e.id} className="text-[14px]">
                      <div className="text-ink">{e.sequence_name}</div>
                      <div className="text-[13px] text-ink-3">
                        {e.status} · since {formatDate(e.enrolled_at, timeZone)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Tags" padded>
              <TagEditor
                entityType="contact"
                entityId={contact.id}
                tags={contact.tags ?? []}
                canWrite={canWrite}
                onSaved={() => void refresh()}
              />
            </Panel>
            <TasksPanel
              tasks={tasks}
              link={{ contactId: contact.id, companyId: contact.company_id ?? undefined }}
              canWrite={can(me, 'tasks.write')}
              queryKeys={[key]}
            />
          </>
        }
      />

      {editing && (
        <ContactEditDrawer
          contact={contact}
          companyName={company?.name ?? null}
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
