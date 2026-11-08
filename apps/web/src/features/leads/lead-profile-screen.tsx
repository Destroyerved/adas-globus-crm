import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatRelative } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { can, useMe } from '@/features/shared/list-kit.js';
import { LeadEditDrawer } from '@/features/records/edit-drawers.js';
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
import { LEAD_STATUS_TONE } from './leads-screen.js';

/** Lead page (PRD 3.2, 4.4): details, status, owner, tags, tasks and the timeline. */
export function LeadProfileScreen({
  leadId,
  onBack,
  onOpenCompany,
  onOpenContact,
  onOpenDeal,
}: {
  leadId: string | null;
  onBack: () => void;
  onOpenCompany: (id: string) => void;
  onOpenContact: (id: string) => void;
  onOpenDeal: (id: string) => void;
}) {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();
  const [editing, setEditing] = useState(false);
  const key = ['lead', leadId] as const;
  const profile = useQuery({
    queryKey: key,
    queryFn: () => api.getLead(leadId as string),
    enabled: leadId !== null,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ['leads'] }),
    ]);

  const convert = useMutation({
    mutationFn: () => api.convertLead({ leadId: leadId as string }),
    onSuccess: async (result) => {
      toast('Converted. A deal was created in New business.');
      await queryClient.invalidateQueries();
      if (result.dealId) onOpenDeal(result.dealId);
    },
  });

  const back = <BackLink label="All leads" onClick={onBack} />;
  if (leadId === null) {
    return (
      <div className="space-y-[16px]">
        {back}
        <p className="text-ink-2">Choose a lead from the list.</p>
      </div>
    );
  }
  if (!profile.isSuccess) return <ProfileStatus back={back} query={profile} />;

  const { lead, tasks, owner } = profile.data;
  const canWrite = can(me, 'leads.write');
  const open = lead.status_category !== 'closed' && lead.status !== 'Converted';

  return (
    <div className="space-y-[16px]" data-testid="lead-profile-screen">
      {back}
      <ProfileHeader
        eyebrow="LEAD"
        title={lead.full_name}
        meta={
          <>
            <StatusBadge tone={LEAD_STATUS_TONE[lead.status] ?? 'neutral'}>
              {lead.status}
            </StatusBadge>
            <MarketBadge market={lead.market} />
            {lead.firm_name && <span>{lead.firm_name}</span>}
            <span>· Owner {owner?.name ?? '—'}</span>
          </>
        }
        actions={
          <>
            {canWrite && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit lead
              </Button>
            )}
            {canWrite && open && (
              <Button
                variant="primary"
                disabled={convert.isPending}
                onClick={() => convert.mutate()}
              >
                {convert.isPending ? 'Converting…' : 'Convert to deal'}
              </Button>
            )}
            {can(me, 'records.delete') && (
              <DeleteRecordButton
                entityType="lead"
                entityId={lead.id}
                name={lead.full_name}
                onDeleted={onBack}
              />
            )}
          </>
        }
      />
      {convert.isError && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(convert.error)}
        </p>
      )}
      {lead.status === 'Disqualified' && lead.disqualification_reason && (
        <p className="m-0 text-[14px] text-ink-2">Disqualified: {lead.disqualification_reason}</p>
      )}

      <TwoColumn
        main={
          <>
            <Panel title="Details" padded>
              <DetailList
                items={[
                  ['Work email', lead.email],
                  ['Phone', lead.phone_e164],
                  ['Job title', lead.title],
                  ['Firm', lead.firm_name],
                  [
                    'Website',
                    lead.domain ? (
                      <a
                        href={`https://${lead.domain}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary-ink font-semibold"
                      >
                        {lead.domain}
                      </a>
                    ) : null,
                  ],
                  ['State or province', lead.state_province],
                  ['Firm size', lead.staff_band ? `${lead.staff_band} staff` : null],
                  ['Source', lead.source],
                  ['Services needed', (lead.services_needed ?? []).join(', ')],
                  ['Software', (lead.software_stack ?? []).join(', ')],
                  [
                    'Last contacted',
                    lead.last_contacted_at ? formatRelative(lead.last_contacted_at) : 'Never',
                  ],
                  ['Added', formatDate(lead.created_at, timeZone)],
                ]}
              />
            </Panel>
            <Panel title="Timeline" padded>
              <Timeline
                entityType="lead"
                entityId={lead.id}
                canWrite={canWrite}
                onChanged={() => void refresh()}
              />
            </Panel>
          </>
        }
        aside={
          <>
            <Panel title="Tags" padded>
              <TagEditor
                entityType="lead"
                entityId={lead.id}
                tags={lead.tags ?? []}
                canWrite={canWrite}
                onSaved={() => void refresh()}
              />
            </Panel>
            {(lead.company_id || lead.contact_id || lead.converted_deal_id) && (
              <Panel title="Linked records" padded>
                <div className="grid gap-[8px] justify-items-start">
                  {lead.company_id && (
                    <Button variant="link" onClick={() => onOpenCompany(lead.company_id as string)}>
                      Open company
                    </Button>
                  )}
                  {lead.contact_id && (
                    <Button variant="link" onClick={() => onOpenContact(lead.contact_id as string)}>
                      Open contact
                    </Button>
                  )}
                  {lead.converted_deal_id && (
                    <Button
                      variant="link"
                      onClick={() => onOpenDeal(lead.converted_deal_id as string)}
                    >
                      Open deal
                    </Button>
                  )}
                </div>
              </Panel>
            )}
            <TasksPanel
              tasks={tasks}
              link={{ leadId: lead.id }}
              canWrite={can(me, 'tasks.write')}
              queryKeys={[key]}
            />
          </>
        }
      />

      {editing && (
        <LeadEditDrawer
          lead={lead}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
            void queryClient.invalidateQueries({ queryKey: ['timeline', 'lead', lead.id] });
          }}
        />
      )}
    </div>
  );
}
