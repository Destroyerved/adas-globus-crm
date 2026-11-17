import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDateTime,
  formatNumber,
  formatRelative,
  type InquiryFormType,
  type InquirySummaryView,
  type Market,
  type RoutingMode,
  type RoutingRuleView,
} from '@adas/shared';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { formError } from '@/features/records/record-form.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import {
  errorMessage,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { api, type AdminUserRow, type TeamRow } from '@/lib/api.js';
import { MARKET_LABEL } from './settings-kit.js';

const MARKET_SUBTITLE: Record<Market, string> = {
  US: 'Firms in the United States.',
  CA: 'Firms in Canadian provinces and territories.',
  OTHER: 'Visitors outside the United States and Canada.',
};

const FORM_LABEL: Record<InquiryFormType, string> = {
  trial: 'Free trial',
  contact: 'Contact',
  consultation: 'Consultation',
};

export function RoutingTab({ onOpenLead }: { onOpenLead?: (leadId: string) => void }) {
  const rules = useQuery({ queryKey: ['admin', 'routing-rules'], queryFn: api.routingRules });
  const teams = useQuery({ queryKey: ['admin', 'teams'], queryFn: api.adminTeams });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.adminUsers });

  if (rules.isPending || teams.isPending || users.isPending) {
    return <LoadingState rows={6} />;
  }
  const err = rules.error ?? teams.error ?? users.error;
  if (err) {
    return (
      <ErrorState
        message={errorMessage(err)}
        onRetry={() => {
          void rules.refetch();
          void teams.refetch();
          void users.refetch();
        }}
      />
    );
  }

  const activeWriters = (users.data ?? []).filter(
    (u) => u.status === 'active' && u.role_name !== 'Read-Only / Analyst',
  );

  return (
    <div className="space-y-[20px]" data-testid="routing-tab">
      <div className="space-y-[4px]">
        <h2 className="m-0 text-[16px] font-semibold text-ink">Website inquiry routing</h2>
        <p className="m-0 text-[13.5px] text-ink-2">
          Choose how new trial and contact submissions from the website are assigned in each market.
          Every new inquiry creates a lead, notifies the owner and starts a one-business-day reply
          task.
        </p>
      </div>

      <div className="grid gap-[16px] lg:grid-cols-3">
        {(rules.data ?? []).map((rule) => (
          <RoutingRuleCard
            key={`${rule.market}-${rule.version}`}
            rule={rule}
            teams={teams.data ?? []}
            activeUsers={activeWriters}
          />
        ))}
      </div>

      <RecentInquiriesPanel onOpenLead={onOpenLead} />
    </div>
  );
}

function RoutingRuleCard({
  rule,
  teams,
  activeUsers,
}: {
  rule: RoutingRuleView;
  teams: TeamRow[];
  activeUsers: AdminUserRow[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<RoutingMode>(rule.mode);
  const [teamId, setTeamId] = useState<string>(rule.teamId ?? teams[0]?.id ?? '');
  const [ownerUserId, setOwnerUserId] = useState<string>(
    rule.ownerUserId ?? activeUsers[0]?.id ?? '',
  );

  const dirty =
    mode !== rule.mode ||
    (mode === 'round_robin' && teamId !== (rule.teamId ?? '')) ||
    (mode === 'named_owner' && ownerUserId !== (rule.ownerUserId ?? ''));

  const save = useMutation({
    mutationFn: () =>
      api.updateRoutingRule(rule.market, {
        version: rule.version,
        mode,
        teamId: mode === 'round_robin' ? teamId : null,
        ownerUserId: mode === 'named_owner' ? ownerUserId : null,
      }),
    onSuccess: async () => {
      toast(`Saved ${MARKET_LABEL[rule.market]} routing.`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'routing-rules'] });
    },
  });

  const modeId = `routing-mode-${rule.market}`;
  const targetId = `routing-target-${rule.market}`;

  return (
    <Panel title={MARKET_LABEL[rule.market]} actions={<MarketBadge market={rule.market} />} padded>
      <div className="space-y-[12px]" data-testid={`routing-card-${rule.market}`}>
        <p className="m-0 text-[13px] text-ink-2">{MARKET_SUBTITLE[rule.market]}</p>

        <div className="space-y-[6px]">
          <label htmlFor={modeId} className="field-label block">
            Assignment method
          </label>
          <Select id={modeId} value={mode} onChange={(e) => setMode(e.target.value as RoutingMode)}>
            <option value="round_robin">Round-robin within a team</option>
            <option value="named_owner">Named owner</option>
          </Select>
        </div>

        {mode === 'round_robin' ? (
          <div className="space-y-[6px]">
            <label htmlFor={targetId} className="field-label block">
              Sales team
            </label>
            <Select id={targetId} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {!teamId && <option value="">Choose a team</option>}
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="space-y-[6px]">
            <label htmlFor={targetId} className="field-label block">
              Assigned owner
            </label>
            <Select
              id={targetId}
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
            >
              {!ownerUserId && <option value="">Choose an active person</option>}
              {activeUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.role_name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <p className="m-0 text-[12.5px] text-ink-3">
          {rule.mode === 'round_robin' ? (
            <>
              {formatNumber(rule.eligibleMemberCount)} active{' '}
              {rule.eligibleMemberCount === 1 ? 'member' : 'members'}
              {rule.lastAssignedName ? ` · Last assigned: ${rule.lastAssignedName}` : ''}
            </>
          ) : (
            <>Assigned to {rule.ownerName ?? '—'}</>
          )}
        </p>

        {rule.updatedByName && (
          <p className="m-0 text-[12px] text-ink-3">
            Changed by {rule.updatedByName} {formatRelative(rule.updatedAt)}
          </p>
        )}

        {save.isError && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {formError(save.error)}
          </p>
        )}

        <div className="flex justify-end pt-[4px]">
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save rule'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function RecentInquiriesPanel({ onOpenLead }: { onOpenLead?: (leadId: string) => void }) {
  const timeZone = viewerTimeZone();
  const [market, setMarket] = useState<Market | ''>('');
  const [formType, setFormType] = useState<InquiryFormType | ''>('');
  const [cursor, setCursor] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'inquiries', { market, formType, cursor }],
    queryFn: () => api.recentInquiries({ market, formType, cursor, limit: 25 }),
  });

  const hasFilters = market !== '' || formType !== '';

  return (
    <Panel
      title={
        list.data
          ? `Recent website inquiries (${formatNumber(list.data.total)})`
          : 'Recent website inquiries'
      }
      padded={false}
    >
      <div className="flex flex-wrap items-end gap-[12px] px-[20px] py-[14px] border-b border-line">
        <div className="space-y-[4px] min-w-[160px]">
          <label htmlFor="inquiry-filter-market" className="field-label block">
            Market
          </label>
          <Select
            id="inquiry-filter-market"
            value={market}
            onChange={(e) => {
              setMarket(e.target.value as Market | '');
              setCursor(null);
            }}
          >
            <option value="">All markets</option>
            <option value="US">United States</option>
            <option value="CA">Canada</option>
            <option value="OTHER">Other</option>
          </Select>
        </div>

        <div className="space-y-[4px] min-w-[160px]">
          <label htmlFor="inquiry-filter-form" className="field-label block">
            Form
          </label>
          <Select
            id="inquiry-filter-form"
            value={formType}
            onChange={(e) => {
              setFormType(e.target.value as InquiryFormType | '');
              setCursor(null);
            }}
          >
            <option value="">All forms</option>
            <option value="trial">Free trial</option>
            <option value="contact">Contact</option>
            <option value="consultation">Consultation</option>
          </Select>
        </div>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMarket('');
              setFormType('');
              setCursor(null);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {list.isPending && (
        <div className="p-[20px]">
          <LoadingState rows={4} />
        </div>
      )}

      {list.isError && (
        <div className="p-[20px]">
          <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </div>
      )}

      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          title={hasFilters ? 'No inquiries match these filters' : 'No website inquiries yet'}
          description={
            hasFilters
              ? 'Try clearing the market or form filter to see earlier submissions.'
              : 'When a visitor submits the free-trial or contact form on the website, it appears here with its assigned owner and reply task.'
          }
          actionLabel={hasFilters ? 'Clear filters' : undefined}
          actionVariant="outline"
          onAction={
            hasFilters
              ? () => {
                  setMarket('');
                  setFormType('');
                  setCursor(null);
                }
              : undefined
          }
        />
      )}

      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <div
            className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
            tabIndex={0}
            role="region"
            aria-label="Recent website inquiries"
          >
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Lead</th>
                  <th className={`${thClass} hidden sm:table-cell`}>Form</th>
                  <th className={`${thClass} hidden sm:table-cell`}>Market</th>
                  <th className={`${thClass} hidden md:table-cell`}>Outcome</th>
                  <th className={`${thClass} hidden md:table-cell`}>Assigned to</th>
                  <th className={thClass}>Received</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <InquiryRow
                    key={item.id}
                    item={item}
                    timeZone={timeZone}
                    onOpenLead={onOpenLead}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {(cursor !== null || list.data.nextCursor !== null) && (
            <div className="flex items-center justify-between px-[20px] py-[12px] border-t border-line">
              <Button
                variant="ghost"
                size="sm"
                disabled={cursor === null}
                onClick={() => setCursor(null)}
              >
                Newest page
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!list.data.nextCursor}
                onClick={() => setCursor(list.data.nextCursor)}
              >
                Older inquiries
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function InquiryRow({
  item,
  timeZone,
  onOpenLead,
}: {
  item: InquirySummaryView;
  timeZone: string;
  onOpenLead?: (leadId: string) => void;
}) {
  const outcomeBadge = item.deduplicated ? (
    <StatusBadge tone="neutral">Merged repeat</StatusBadge>
  ) : item.slaTaskStatus === 'completed' ? (
    <StatusBadge tone="success">Replied</StatusBadge>
  ) : (
    <StatusBadge tone="info">Lead created</StatusBadge>
  );

  return (
    <tr className={rowClass}>
      <td className={tdClass}>
        <div className="space-y-[4px]">
          {item.leadId && onOpenLead ? (
            <button
              type="button"
              onClick={() => onOpenLead(item.leadId as string)}
              className="font-semibold text-ink hover:underline bg-transparent border-0 p-0 text-left cursor-pointer"
            >
              {item.leadName ?? 'Open lead'}
            </button>
          ) : (
            <span className="font-semibold text-ink-2">{item.leadName ?? 'Removed lead'}</span>
          )}
          {item.firmName && <div className="text-[12.5px] text-ink-2">{item.firmName}</div>}
          <div className="flex flex-wrap items-center gap-[6px] sm:hidden pt-[2px]">
            <MarketBadge market={item.market} />
            <span className="text-[12px] text-ink-2">{FORM_LABEL[item.formType]}</span>
            {outcomeBadge}
          </div>
        </div>
      </td>
      <td className={`${tdClass} hidden sm:table-cell text-ink-2`}>{FORM_LABEL[item.formType]}</td>
      <td className={`${tdClass} hidden sm:table-cell`}>
        <MarketBadge market={item.market} />
      </td>
      <td className={`${tdClass} hidden md:table-cell`}>{outcomeBadge}</td>
      <td className={`${tdClass} hidden md:table-cell text-ink-2`}>
        {item.assignedUserName ?? '—'}
      </td>
      <td className={`${tdClass} text-ink-2 whitespace-nowrap`}>
        {formatDateTime(item.createdAt, timeZone)}
      </td>
    </tr>
  );
}
