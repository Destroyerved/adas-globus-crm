import { useMemo, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AddSuppressedDomainInputSchema,
  AddSuppressionInputSchema,
  LiftSuppressionInputSchema,
  RemoveSuppressedDomainInputSchema,
  formatDate,
  formatNumber,
  type ManualSuppressionReason,
  type StatusTone,
  type SuppressionStateFilter,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type SuppressedDomainView, type SuppressionView } from '@/lib/api.js';
import {
  CreateForm,
  DataPanel,
  Field,
  SearchBox,
  errorMessage,
  fieldError,
  rowClass,
  str,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { Toolbar, can, useMe, useUrlState } from '@/features/shared/list-kit.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { FormRow } from './settings-kit.js';

const DEFAULTS = { sq: '', sreason: '', sstate: 'active' };

const REASON_META: Record<SuppressionView['reason'], { label: string; tone: StatusTone }> = {
  unsubscribe: { label: 'Unsubscribed', tone: 'warning' },
  complaint: { label: 'Marked as spam', tone: 'danger' },
  hard_bounce: { label: 'Email bounced', tone: 'danger' },
  manual_dnc: { label: 'Do not contact', tone: 'neutral' },
  privacy_erasure: { label: 'Privacy erasure', tone: 'danger' },
};

const MANUAL_REASON_OPTIONS: { value: ManualSuppressionReason; label: string }[] = [
  { value: 'manual_dnc', label: 'Do not contact' },
  { value: 'unsubscribe', label: 'Unsubscribed' },
  { value: 'hard_bounce', label: 'Email bounced' },
  { value: 'complaint', label: 'Marked as spam' },
];

/**
 * Email suppressions and blocked domains (PRD 4.17, 4.18, 5.1, 5.5).
 * People with compliance.manage can search and add suppressions; lifting a suppression or
 * removing a domain block requires privacy.manage and a written reason. Privacy erasure
 * rows hold only a hash and can never be lifted.
 */
export function SuppressionsTab() {
  const me = useMe();
  const canLift = can(me, 'privacy.manage');
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();
  const [state, setState] = useUrlState(DEFAULTS);

  const [addingEmail, setAddingEmail] = useState(false);
  const [addingDomain, setAddingDomain] = useState(false);
  const [lifting, setLifting] = useState<SuppressionView | null>(null);
  const [liftReason, setLiftReason] = useState('');
  const [liftValidation, setLiftValidation] = useState<string | null>(null);

  const [removingDomain, setRemovingDomain] = useState<SuppressedDomainView | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [removeValidation, setRemoveValidation] = useState<string | null>(null);

  const stateFilter: SuppressionStateFilter =
    state.sstate === 'lifted' || state.sstate === 'all' ? state.sstate : 'active';

  const filters = {
    q: state.sq || undefined,
    reason: state.sreason || undefined,
    state: stateFilter,
  };

  const suppressionsQuery = useInfiniteQuery({
    queryKey: ['suppressions', filters],
    queryFn: ({ pageParam }) => api.listSuppressions({ ...filters, cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });

  const domainsQuery = useQuery({
    queryKey: ['suppressed-domains'],
    queryFn: api.listSuppressedDomains,
  });

  const rows = useMemo(
    () => suppressionsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [suppressionsQuery.data],
  );
  const total = suppressionsQuery.data?.pages[0]?.total ?? 0;
  const filtered = Boolean(state.sq || state.sreason || stateFilter !== 'active');

  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['suppressions'] }),
      queryClient.invalidateQueries({ queryKey: ['suppressed-domains'] }),
      queryClient.invalidateQueries({ queryKey: ['contacts'] }),
      queryClient.invalidateQueries({ queryKey: ['contact'] }),
      queryClient.invalidateQueries({ queryKey: ['audit-logs'] }),
    ]);

  const addEmailMutation = useMutation({
    mutationFn: api.addSuppression,
    onSuccess: async (created) => {
      setAddingEmail(false);
      toast(`Suppressed ${created.email ?? 'address'}.`);
      await refreshAll();
    },
  });

  const liftMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.liftSuppression(id, { reason }),
    onSuccess: async (updated) => {
      setLifting(null);
      setLiftReason('');
      setLiftValidation(null);
      toast(`Lifted suppression for ${updated.email ?? 'address'}.`);
      await refreshAll();
    },
  });

  const addDomainMutation = useMutation({
    mutationFn: api.addSuppressedDomain,
    onSuccess: async (created) => {
      setAddingDomain(false);
      toast(`Blocked ${created.domain}.`);
      await refreshAll();
    },
  });

  const removeDomainMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.removeSuppressedDomain(id, { reason }),
    onSuccess: async () => {
      const domainName = removingDomain?.domain ?? 'domain';
      setRemovingDomain(null);
      setRemoveReason('');
      setRemoveValidation(null);
      toast(`Removed block on ${domainName}.`);
      await refreshAll();
    },
  });

  return (
    <div className="space-y-[24px]" data-testid="suppressions-tab">
      <section className="space-y-[12px]" aria-labelledby="suppressions-email-heading">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-[8px]">
          <div>
            <h2 id="suppressions-email-heading" className="text-title text-ink m-0">
              Email suppressions{' '}
              <span className="text-ink-3 font-normal tabular-nums">({formatNumber(total)})</span>
            </h2>
            <p className="m-0 mt-[2px] text-[13px] text-ink-3">
              Addresses on this list never receive sequences or campaigns. Search by email or
              64-character hash.
            </p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              addEmailMutation.reset();
              setAddingEmail(true);
            }}
          >
            Add suppression
          </Button>
        </div>

        {addingEmail && (
          <CreateForm
            title="Suppress an email address"
            submitLabel="Suppress address"
            pending={addEmailMutation.isPending}
            error={addEmailMutation.error}
            onClose={() => setAddingEmail(false)}
            onSubmit={(data) => {
              const parsed = AddSuppressionInputSchema.safeParse({
                email: str(data, 'email'),
                reason: (str(data, 'reason') || 'manual_dnc') as ManualSuppressionReason,
                source: 'manual_settings',
                notes: str(data, 'notes') || undefined,
              });
              if (!parsed.success) return;
              addEmailMutation.mutate(parsed.data);
            }}
          >
            <Field label="Email address" error={fieldError(addEmailMutation.error, 'email')}>
              <Input name="email" type="email" placeholder="partner@firm-example.com" required />
            </Field>
            <Field label="Reason" error={fieldError(addEmailMutation.error, 'reason')}>
              <Select name="reason" defaultValue="manual_dnc">
                {MANUAL_REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes" optional error={fieldError(addEmailMutation.error, 'notes')}>
                <Input
                  name="notes"
                  placeholder="For example: asked by phone not to receive marketing"
                  maxLength={500}
                />
              </Field>
            </div>
          </CreateForm>
        )}

        <Toolbar>
          <SearchBox
            value={state.sq}
            onChange={(value) => setState({ sq: value })}
            label="Search email or hash"
          />
          <Select
            aria-label="Suppression status"
            value={stateFilter}
            onChange={(e) => setState({ sstate: e.target.value })}
            className="sm:w-[160px]"
          >
            <option value="active">Active only</option>
            <option value="lifted">Lifted</option>
            <option value="all">All records</option>
          </Select>
          <Select
            aria-label="Suppression reason"
            value={state.sreason}
            onChange={(e) => setState({ sreason: e.target.value })}
            className="sm:w-[190px]"
          >
            <option value="">Any reason</option>
            {Object.entries(REASON_META).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => setState({ sq: '', sreason: '', sstate: 'active' })}
            >
              Clear filters
            </Button>
          )}
        </Toolbar>

        <DataPanel
          query={suppressionsQuery}
          isEmpty={rows.length === 0}
          scrollLabel="Email suppressions"
          emptyTitle={filtered ? 'No suppressions match these filters' : 'No suppressed addresses'}
          emptyDescription={
            filtered
              ? 'Clear the filters to see active suppressions.'
              : 'Unsubscribes, bounces, spam complaints and manual blocks appear here automatically.'
          }
          footer={
            suppressionsQuery.hasNextPage ? (
              <div className="px-[12px] py-[10px] border-t border-line">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={suppressionsQuery.isFetchingNextPage}
                  onClick={() => void suppressionsQuery.fetchNextPage()}
                >
                  {suppressionsQuery.isFetchingNextPage ? 'Loading…' : 'Show older'}
                </Button>
              </div>
            ) : null
          }
        >
          <table className={tableClass}>
            <caption className="sr-only">Email suppressions</caption>
            <thead>
              <tr className={theadRowClass}>
                <th className={thClass}>Address</th>
                <th className={`${thClass} hidden sm:table-cell`}>Reason</th>
                <th className={`${thClass} hidden md:table-cell`}>Source & notes</th>
                <th className={`${thClass} hidden sm:table-cell`}>Recorded</th>
                <th className={`${thClass} hidden sm:table-cell`}>State</th>
                {canLift && <th className={`${thClass} text-right`}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const meta = REASON_META[s.reason];
                const isLifted = Boolean(s.liftedAt);
                const stateBadge = s.isPermanent ? (
                  <StatusBadge tone="danger">Permanent</StatusBadge>
                ) : isLifted ? (
                  <StatusBadge tone="neutral">Lifted</StatusBadge>
                ) : (
                  <StatusBadge tone="warning">Active</StatusBadge>
                );
                return (
                  <tr key={s.id} className={rowClass}>
                    <td className={`${tdClass} max-w-[210px] sm:max-w-none`}>
                      {s.email ? (
                        <div className="font-semibold text-ink truncate" title={s.email}>
                          {s.email}
                        </div>
                      ) : (
                        <div className="font-semibold text-ink-2">Erased address</div>
                      )}
                      <div
                        className="font-mono text-[12px] text-ink-3 truncate"
                        title={s.emailSha256}
                      >
                        {s.emailSha256.slice(0, 16)}…
                      </div>
                      <div className="sm:hidden mt-[4px] flex flex-wrap gap-[4px]">
                        <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                        {stateBadge}
                      </div>
                    </td>
                    <td className={`${tdClass} hidden sm:table-cell`}>
                      <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    </td>
                    <td className={`${tdClass} hidden md:table-cell text-[13px] text-ink-2`}>
                      <div>{s.source.replace(/_/g, ' ')}</div>
                      {s.notes && <div className="text-ink-3 line-clamp-1">{s.notes}</div>}
                      {isLifted && s.liftedReason && (
                        <div className="text-ink-3 line-clamp-1">Lifted: {s.liftedReason}</div>
                      )}
                    </td>
                    <td className={`${tdClass} hidden sm:table-cell whitespace-nowrap text-ink-2`}>
                      {formatDate(s.createdAt, timeZone)}
                    </td>
                    <td className={`${tdClass} hidden sm:table-cell`}>{stateBadge}</td>
                    {canLift && (
                      <td className={`${tdClass} text-right`}>
                        {!isLifted && !s.isPermanent ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Lift suppression for ${s.email ?? s.emailSha256.slice(0, 12)}`}
                            onClick={() => {
                              liftMutation.reset();
                              setLiftReason('');
                              setLiftValidation(null);
                              setLifting(s);
                            }}
                          >
                            Lift
                          </Button>
                        ) : (
                          <span className="text-[12.5px] text-ink-3">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataPanel>
      </section>

      <section className="space-y-[12px]" aria-labelledby="suppressions-domain-heading">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-[8px]">
          <div>
            <h2 id="suppressions-domain-heading" className="text-title text-ink m-0">
              Blocked domains{' '}
              <span className="text-ink-3 font-normal tabular-nums">
                ({formatNumber(domainsQuery.data?.length ?? 0)})
              </span>
            </h2>
            <p className="m-0 mt-[2px] text-[13px] text-ink-3">
              Block an entire firm domain from receiving outreach. Shared mailbox providers such as
              gmail.com cannot be blocked here.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              addDomainMutation.reset();
              setAddingDomain(true);
            }}
          >
            Block domain
          </Button>
        </div>

        {addingDomain && (
          <CreateForm
            title="Block a corporate domain"
            submitLabel="Block domain"
            pending={addDomainMutation.isPending}
            error={addDomainMutation.error}
            onClose={() => setAddingDomain(false)}
            onSubmit={(data) => {
              const parsed = AddSuppressedDomainInputSchema.safeParse({
                domain: str(data, 'domain'),
                reason: str(data, 'reason'),
              });
              if (!parsed.success) return;
              addDomainMutation.mutate(parsed.data);
            }}
          >
            <Field label="Domain" error={fieldError(addDomainMutation.error, 'domain')}>
              <Input name="domain" placeholder="competitor-cpa.com" required />
            </Field>
            <Field label="Reason" error={fieldError(addDomainMutation.error, 'reason')}>
              <Input
                name="reason"
                placeholder="For example: managing partner requested firm-wide opt-out"
                required
              />
            </Field>
          </CreateForm>
        )}

        <DataPanel
          query={domainsQuery}
          isEmpty={(domainsQuery.data?.length ?? 0) === 0}
          scrollLabel="Blocked domains"
          emptyTitle="No blocked domains"
          emptyDescription="Add a firm domain when an organisation asks not to be contacted at all."
        >
          <table className={tableClass}>
            <caption className="sr-only">Blocked corporate domains</caption>
            <thead>
              <tr className={theadRowClass}>
                <th className={thClass}>Domain</th>
                <th className={thClass}>Reason</th>
                <th className={`${thClass} hidden sm:table-cell`}>Added</th>
                {canLift && <th className={`${thClass} text-right`}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {(domainsQuery.data ?? []).map((d) => (
                <tr key={d.id} className={rowClass}>
                  <td className={`${tdClass} font-semibold text-ink`}>{d.domain}</td>
                  <td className={`${tdClass} text-ink-2`}>{d.reason}</td>
                  <td className={`${tdClass} hidden sm:table-cell whitespace-nowrap text-ink-2`}>
                    {formatDate(d.createdAt, timeZone)}
                  </td>
                  {canLift && (
                    <td className={`${tdClass} text-right`}>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove block on ${d.domain}`}
                        onClick={() => {
                          removeDomainMutation.reset();
                          setRemoveReason('');
                          setRemoveValidation(null);
                          setRemovingDomain(d);
                        }}
                      >
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </DataPanel>
      </section>

      <ConfirmDialog
        open={lifting !== null}
        title="Lift email suppression"
        tone="primary"
        confirmLabel="Lift suppression"
        pending={liftMutation.isPending}
        error={liftValidation ?? (liftMutation.isError ? errorMessage(liftMutation.error) : null)}
        onCancel={() => {
          setLifting(null);
          setLiftReason('');
          setLiftValidation(null);
        }}
        onConfirm={() => {
          if (!lifting) return;
          const parsed = LiftSuppressionInputSchema.safeParse({ reason: liftReason });
          if (!parsed.success) {
            setLiftValidation(
              parsed.error.issues[0]?.message ?? 'Enter a reason of at least 5 characters.',
            );
            return;
          }
          setLiftValidation(null);
          liftMutation.mutate({ id: lifting.id, reason: parsed.data.reason });
        }}
        body={
          <div className="space-y-[12px]">
            <p className="m-0">
              Lifting the suppression on{' '}
              <strong className="text-ink">{lifting?.email ?? 'this address'}</strong> allows future
              outreach if the contact’s consent basis permits it. The suppression entry remains on
              record with your note.
            </p>
            <FormRow id="lift-suppression-reason" label="Reason for lifting">
              <Textarea
                id="lift-suppression-reason"
                rows={3}
                value={liftReason}
                onChange={(e) => setLiftReason(e.target.value)}
                placeholder="Written confirmation from recipient asking to receive updates again"
              />
            </FormRow>
          </div>
        }
      />

      <ConfirmDialog
        open={removingDomain !== null}
        title="Remove domain block"
        tone="primary"
        confirmLabel="Remove domain block"
        pending={removeDomainMutation.isPending}
        error={
          removeValidation ??
          (removeDomainMutation.isError ? errorMessage(removeDomainMutation.error) : null)
        }
        onCancel={() => {
          setRemovingDomain(null);
          setRemoveReason('');
          setRemoveValidation(null);
        }}
        onConfirm={() => {
          if (!removingDomain) return;
          const parsed = RemoveSuppressedDomainInputSchema.safeParse({ reason: removeReason });
          if (!parsed.success) {
            setRemoveValidation(
              parsed.error.issues[0]?.message ?? 'Enter a reason of at least 5 characters.',
            );
            return;
          }
          setRemoveValidation(null);
          removeDomainMutation.mutate({ id: removingDomain.id, reason: parsed.data.reason });
        }}
        body={
          <div className="space-y-[12px]">
            <p className="m-0">
              Removing <strong className="text-ink">{removingDomain?.domain}</strong> allows
              outreach to addresses at this domain unless an individual address is suppressed.
            </p>
            <FormRow id="remove-domain-reason" label="Reason for removing">
              <Textarea
                id="remove-domain-reason"
                rows={3}
                value={removeReason}
                onChange={(e) => setRemoveReason(e.target.value)}
                placeholder="Firm signed engagement letter and requested onboarding emails"
              />
            </FormRow>
          </div>
        }
      />
    </div>
  );
}
