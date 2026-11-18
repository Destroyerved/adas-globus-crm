import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PrivacyEraseInputSchema,
  RecordConsentInputSchema,
  WithdrawConsentInputSchema,
  formatDate,
  formatMoney,
  formatRelative,
  formatTime,
  type ConsentBasis,
  type ConsentPurpose,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { errorMessage, useUserNames } from '@/features/shared/live-kit.js';
import { can, useMe } from '@/features/shared/list-kit.js';
import { MergeWithButton } from '@/features/duplicates/direct-merge-drawer.js';
import { CustomFieldsPanel } from '@/features/records/custom-fields-panel.js';
import { ContactEditDrawer } from '@/features/records/edit-drawers.js';
import {
  EditDrawer,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
} from '@/features/records/record-form.js';
import {
  BackLink,
  DeleteRecordButton,
  DetailList,
  ProfileHeader,
  ProfileStatus,
  TasksPanel,
  TwoColumn,
} from '@/features/records/profile-kit.js';
import { ScorePanel } from '@/features/records/score-panel.js';
import { TagEditor } from '@/features/records/tag-editor.js';
import { Timeline, viewerTimeZone } from '@/features/records/timeline.js';
import { FormRow } from '@/features/settings/settings-kit.js';
import { ComposeEmailDrawer } from '@/features/inbox/compose-email-drawer.js';
import { EnrollInSequenceDrawer } from '@/features/sequences/sequences-screen.js';
import { ContactChannelsPanel } from './contact-channels-panel.js';
import { VERIFICATION_TONE } from './contacts-screen.js';

const SUPPRESSION_LABEL: Record<string, string> = {
  unsubscribe: 'Unsubscribed',
  complaint: 'Marked as spam',
  hard_bounce: 'Email bounced',
  manual_dnc: 'Do not contact',
  privacy_erasure: 'Privacy erasure request',
  domain_suppressed: 'Domain blocked',
};

const CONSENT_BASIS_LABEL: Record<ConsentBasis, string> = {
  express: 'Express opt-in',
  implied_inquiry: 'Implied — recent inquiry (6 months)',
  implied_ebr: 'Implied — active client relationship (24 months)',
  implied_published: 'Implied — published business address',
  legitimate_interest_b2b: 'US business outreach',
};

function saveDownloadedFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function safeLocalTime(tz: string): string | null {
  try {
    return formatTime(new Date(), tz);
  } catch {
    return null;
  }
}

/** Contact page (PRD 4.4, 4.18, 5): details, consent and suppression, deals, outreach, privacy, timeline. */
export function ContactProfileScreen({
  contactId,
  onBack,
  onOpenCompany,
  onOpenDeal,
  onOpenLead,
  onOpenContact,
}: {
  contactId: string | null;
  onBack: () => void;
  onOpenCompany: (id: string) => void;
  onOpenDeal: (id: string) => void;
  onOpenLead: (id: string) => void;
  onOpenContact?: (id: string) => void;
}) {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const timeZone = viewerTimeZone();
  const [editing, setEditing] = useState(false);
  const [composingEmail, setComposingEmail] = useState(false);
  const [enrollingInSequence, setEnrollingInSequence] = useState(false);
  const [confirmingApolloEnrich, setConfirmingApolloEnrich] = useState(false);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [withdrawingConsent, setWithdrawingConsent] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawSuppress, setWithdrawSuppress] = useState(false);
  const [withdrawValidation, setWithdrawValidation] = useState<string | null>(null);

  const [erasing, setErasing] = useState(false);
  const [eraseReason, setEraseReason] = useState('');
  const [eraseValidation, setEraseValidation] = useState<string | null>(null);

  const key = ['contact', contactId] as const;
  const profile = useQuery({
    queryKey: key,
    queryFn: () => api.getContact(contactId as string),
    enabled: contactId !== null,
  });
  const apolloStatusQuery = useQuery({
    queryKey: ['apollo-status'],
    queryFn: api.getApolloStatus,
    enabled: contactId !== null && can(me, 'contacts.write'),
  });
  const canReadOutreach = can(me, 'sequences.read') || can(me, 'campaigns.read');
  const outreachQuery = useQuery({
    queryKey: ['contact-outreach', contactId],
    queryFn: () => api.getContactOutreachHistory(contactId as string),
    enabled: contactId !== null && canReadOutreach,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ['contacts'] }),
      queryClient.invalidateQueries({ queryKey: ['timeline', 'contact', contactId] }),
      queryClient.invalidateQueries({ queryKey: ['contact-outreach', contactId] }),
      queryClient.invalidateQueries({ queryKey: ['apollo-status'] }),
    ]);

  const enrichApolloMutation = useMutation({
    mutationFn: (id: string) => api.enrichContactWithApollo(id, 1),
    onSuccess: async (res) => {
      setConfirmingApolloEnrich(false);
      toast(
        res.updatedFields.length > 0
          ? `Enriched via Apollo (${res.updatedFields.join(', ')} updated).`
          : 'Checked Apollo (1 credit used; no missing fields to fill).',
      );
      await refresh();
    },
  });

  const stopEnrollmentMutation = useMutation({
    mutationFn: (enrollmentId: string) =>
      api.stopEnrollment(enrollmentId, 'Stopped from contact profile'),
    onSuccess: async () => {
      toast('Stopped sequence enrollment.');
      await refresh();
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: ({
      id,
      reason,
      suppressAddress,
    }: {
      id: string;
      reason: string;
      suppressAddress: boolean;
    }) => api.withdrawContactConsent(id, { reason, suppressAddress }),
    onSuccess: async (res) => {
      setWithdrawingConsent(false);
      setWithdrawReason('');
      setWithdrawSuppress(false);
      setWithdrawValidation(null);
      toast(res.suppressed ? 'Consent withdrawn and address suppressed.' : 'Consent withdrawn.');
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });

  const exportPrivacyMutation = useMutation({
    mutationFn: async ({ id, format }: { id: string; format: 'json' | 'csv' }) => {
      const file =
        format === 'csv'
          ? await api.downloadContactPrivacyCsv(id)
          : await api.downloadContactPrivacyJson(id);
      saveDownloadedFile(file.blob, file.filename);
      return format;
    },
    onSuccess: async (format) => {
      toast(`Exported personal data (${format.toUpperCase()}).`);
      await queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
    },
  });

  const eraseMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.eraseContactPrivacy(id, { reason }),
    onSuccess: async () => {
      setErasing(false);
      setEraseReason('');
      setEraseValidation(null);
      toast('Erased personal data and recorded permanent suppression.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['contacts'] }),
        queryClient.invalidateQueries({ queryKey: ['leads'] }),
        queryClient.invalidateQueries({ queryKey: ['suppressions'] }),
        queryClient.invalidateQueries({ queryKey: ['audit-logs'] }),
      ]);
      onBack();
    },
  });

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
    marketingBasis,
    enrollments,
  } = profile.data;
  const canWrite = can(me, 'contacts.write');
  const canManagePrivacy = can(me, 'privacy.manage');
  const isBlocked = Boolean(contact.do_not_contact || suppression);
  const basisBadgeText =
    marketingBasis.kind === 'implied' && marketingBasis.expiresAt
      ? `Implied until ${formatDate(marketingBasis.expiresAt, timeZone)}`
      : marketingBasis.label;
  const localTime = contact.timezone ? safeLocalTime(contact.timezone) : null;

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
            {localTime && (
              <span className="tabular-nums" data-testid="contact-local-time">
                · Local time {localTime} ({contact.timezone})
              </span>
            )}
          </>
        }
        actions={
          <>
            {can(me, 'inbox.send') && !isBlocked && (
              <Button variant="primary" onClick={() => setComposingEmail(true)}>
                Send email
              </Button>
            )}
            {canWrite && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit contact
              </Button>
            )}
            {canWrite && apolloStatusQuery.data?.configured && (
              <Button
                variant="secondary"
                onClick={() => {
                  enrichApolloMutation.reset();
                  setConfirmingApolloEnrich(true);
                }}
              >
                Enrich via Apollo
              </Button>
            )}
            {canWrite && (
              <MergeWithButton
                entity="contact"
                recordId={contact.id}
                recordName={contact.full_name}
                onOpenRecord={(id) => (onOpenContact ? onOpenContact(id) : void refresh())}
              />
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

      {isBlocked && (
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
                    'Marketing basis',
                    <span
                      key="mb"
                      className="inline-flex flex-wrap items-center gap-[8px]"
                      data-testid="contact-marketing-basis"
                    >
                      <StatusBadge tone={marketingBasis.tone}>{basisBadgeText}</StatusBadge>
                      <span className="text-[13px] text-ink-2">{marketingBasis.detail}</span>
                    </span>,
                  ],
                  [
                    'Consent record',
                    consent
                      ? `${CONSENT_BASIS_LABEL[consent.basis as ConsentBasis] ?? consent.basis.replace(/_/g, ' ')} · ${consent.status} (${consent.source.replace(/_/g, ' ')})`
                      : 'No consent recorded',
                  ],
                ]}
              />
              {canWrite && !isBlocked && (
                <div className="mt-[16px] pt-[12px] border-t border-line flex flex-wrap gap-[8px]">
                  <Button variant="secondary" size="sm" onClick={() => setRecordingConsent(true)}>
                    Record consent
                  </Button>
                  {consent && consent.status === 'active' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        withdrawMutation.reset();
                        setWithdrawReason('');
                        setWithdrawSuppress(false);
                        setWithdrawValidation(null);
                        setWithdrawingConsent(true);
                      }}
                    >
                      Withdraw consent
                    </Button>
                  )}
                </div>
              )}
            </Panel>
            <ContactChannelsPanel
              contactId={contact.id}
              primaryEmail={contact.primary_email}
              emails={emails}
              phones={phones}
              canWrite={canWrite}
              onChanged={() => void refresh()}
            />
            <CustomFieldsPanel
              entityType="contact"
              entityId={contact.id}
              version={contact.version}
              values={contact.custom_fields}
              canWrite={canWrite}
              onSaved={() => void refresh()}
            />
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
            <ScorePanel score={contact.lead_score} breakdown={contact.lead_score_breakdown} />
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
            <Panel
              title="Outreach"
              padded
              actions={
                can(me, 'sequences.enroll') && !contact.do_not_contact ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setEnrollingInSequence(true)}
                  >
                    Enroll in sequence
                  </Button>
                ) : undefined
              }
            >
              <div className="space-y-[14px]" data-testid="contact-outreach-panel">
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-3 mb-[6px]">
                    Sequences
                  </div>
                  {(outreachQuery.data?.enrollments ?? enrollments).length === 0 ? (
                    <p className="m-0 text-[14px] text-ink-2">Not in any sequence.</p>
                  ) : (
                    <ul className="m-0 p-0 list-none space-y-[8px]">
                      {(outreachQuery.data?.enrollments ?? enrollments).map((e) => {
                        const isActiveOrPaused = e.status === 'active' || e.status === 'paused';
                        return (
                          <li
                            key={e.id}
                            className="flex items-start justify-between gap-[8px] text-[14px]"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-ink">{e.sequence_name}</div>
                              <div className="text-[13px] text-ink-3">
                                {e.status} · since {formatDate(e.enrolled_at, timeZone)}
                                {'current_step_order' in e &&
                                typeof e.current_step_order === 'number'
                                  ? ` · step ${e.current_step_order}`
                                  : ''}
                              </div>
                              {'stop_reason' in e &&
                                typeof e.stop_reason === 'string' &&
                                e.stop_reason && (
                                  <div className="text-[12px] text-ink-3">
                                    Stopped: {e.stop_reason}
                                  </div>
                                )}
                            </div>
                            {isActiveOrPaused && can(me, 'sequences.enroll') && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={stopEnrollmentMutation.isPending}
                                onClick={() => stopEnrollmentMutation.mutate(e.id)}
                              >
                                Stop
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {outreachQuery.data && outreachQuery.data.campaigns.length > 0 && (
                  <div className="pt-[10px] border-t border-line">
                    <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-3 mb-[6px]">
                      Campaigns
                    </div>
                    <ul className="m-0 p-0 list-none space-y-[8px]">
                      {outreachQuery.data.campaigns.map((c) => (
                        <li key={c.id} className="text-[14px]">
                          <div className="font-medium text-ink">{c.campaign_name}</div>
                          <div className="text-[13px] text-ink-3">
                            {c.status}
                            {c.sent_at ? ` · sent ${formatDate(c.sent_at, timeZone)}` : ''}
                            {c.clicked_at ? ' · clicked' : ''}
                            {c.reason_code && c.status === 'skipped' ? ` · ${c.reason_code}` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
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
            {canManagePrivacy && (
              <Panel title="Privacy" padded>
                <div className="space-y-[12px]" data-testid="contact-privacy-panel">
                  <p className="m-0 text-[13px] text-ink-2">
                    Download all personal data held on this contact, or permanently erase it under a
                    verified privacy request.
                  </p>
                  <div className="flex flex-wrap gap-[8px]">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={exportPrivacyMutation.isPending}
                      onClick={() =>
                        exportPrivacyMutation.mutate({ id: contact.id, format: 'json' })
                      }
                    >
                      Export JSON
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={exportPrivacyMutation.isPending}
                      onClick={() =>
                        exportPrivacyMutation.mutate({ id: contact.id, format: 'csv' })
                      }
                    >
                      Export CSV
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        eraseMutation.reset();
                        setEraseReason('');
                        setEraseValidation(null);
                        setErasing(true);
                      }}
                    >
                      Erase personal data…
                    </Button>
                  </div>
                  {exportPrivacyMutation.isError && (
                    <p role="alert" className="m-0 text-[13px] text-danger">
                      {errorMessage(exportPrivacyMutation.error)}
                    </p>
                  )}
                </div>
              </Panel>
            )}
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

      {recordingConsent && (
        <RecordConsentDrawer
          contactId={contact.id}
          contactName={contact.full_name}
          onClose={() => setRecordingConsent(false)}
          onSaved={() => {
            setRecordingConsent(false);
            void refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={withdrawingConsent}
        title={`Withdraw consent for ${contact.full_name}`}
        tone="primary"
        confirmLabel="Withdraw consent"
        pending={withdrawMutation.isPending}
        error={
          withdrawValidation ??
          (withdrawMutation.isError ? errorMessage(withdrawMutation.error) : null)
        }
        onCancel={() => {
          setWithdrawingConsent(false);
          setWithdrawReason('');
          setWithdrawSuppress(false);
          setWithdrawValidation(null);
        }}
        onConfirm={() => {
          const parsed = WithdrawConsentInputSchema.safeParse({
            reason: withdrawReason,
            suppressAddress: withdrawSuppress,
          });
          if (!parsed.success) {
            setWithdrawValidation(parsed.error.issues[0]?.message ?? 'Enter a short reason.');
            return;
          }
          setWithdrawValidation(null);
          withdrawMutation.mutate({
            id: contact.id,
            reason: parsed.data.reason,
            suppressAddress: parsed.data.suppressAddress,
          });
        }}
        body={
          <div className="space-y-[12px]">
            <p className="m-0">
              This marks the contact’s consent as withdrawn and records the change on their
              timeline.
            </p>
            <FormRow id="withdraw-consent-reason" label="Reason">
              <Textarea
                id="withdraw-consent-reason"
                rows={3}
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                placeholder="Asked to stop receiving newsletter updates"
              />
            </FormRow>
            <label className="flex items-start gap-[8px] text-[13px] text-ink cursor-pointer">
              <input
                type="checkbox"
                checked={withdrawSuppress}
                onChange={(e) => setWithdrawSuppress(e.target.checked)}
                className="mt-[2px]"
              />
              <span>Also suppress all future outreach to {contact.primary_email}</span>
            </label>
          </div>
        }
      />

      <ConfirmDialog
        open={erasing}
        title={`Erase personal data for ${contact.full_name}`}
        tone="danger"
        confirmLabel="Erase personal data"
        pending={eraseMutation.isPending}
        error={
          eraseValidation ?? (eraseMutation.isError ? errorMessage(eraseMutation.error) : null)
        }
        onCancel={() => {
          setErasing(false);
          setEraseReason('');
          setEraseValidation(null);
        }}
        onConfirm={() => {
          const parsed = PrivacyEraseInputSchema.safeParse({ reason: eraseReason });
          if (!parsed.success) {
            setEraseValidation(
              parsed.error.issues[0]?.message ?? 'Enter the privacy request reference or reason.',
            );
            return;
          }
          setEraseValidation(null);
          eraseMutation.mutate({ id: contact.id, reason: parsed.data.reason });
        }}
        body={
          <div className="space-y-[12px]">
            <p className="m-0">
              This permanently removes <strong className="text-ink">{contact.full_name}</strong>’s
              names, email addresses, phone numbers, notes, tasks and message bodies. Deal totals
              and activity counts are kept for reporting, and a permanent hashed block stops this
              address from being imported or contacted again.
            </p>
            <FormRow id="privacy-erase-reason" label="Request reference or reason">
              <Textarea
                id="privacy-erase-reason"
                rows={3}
                value={eraseReason}
                onChange={(e) => setEraseReason(e.target.value)}
                placeholder="Verified privacy erasure request received by email"
              />
            </FormRow>
          </div>
        }
      />

      <ComposeEmailDrawer
        open={composingEmail}
        onClose={() => setComposingEmail(false)}
        initialToEmail={contact.primary_email}
        contactId={contact.id}
        companyId={company?.id ?? null}
        onSent={() => void refresh()}
      />

      <EnrollInSequenceDrawer
        open={enrollingInSequence}
        onClose={() => setEnrollingInSequence(false)}
        lockedContactIds={[contact.id]}
        onEnrolled={() => void refresh()}
      />

      <ConfirmDialog
        open={confirmingApolloEnrich}
        title={`Enrich ${contact.full_name} via Apollo`}
        tone="primary"
        confirmLabel="Confirm 1 credit & enrich"
        pending={enrichApolloMutation.isPending}
        error={enrichApolloMutation.isError ? errorMessage(enrichApolloMutation.error) : null}
        onCancel={() => setConfirmingApolloEnrich(false)}
        onConfirm={() => enrichApolloMutation.mutate(contact.id)}
        body={
          <p className="m-0">
            This spends <strong className="text-ink">1 Apollo credit</strong> (
            {apolloStatusQuery.data?.remainingDailyCredits ?? 0} remaining today) to verify work
            email status and fill any blank job title or firm details without overwriting fields
            edited in the CRM.
          </p>
        }
      />
    </div>
  );
}

function RecordConsentDrawer({
  contactId,
  contactName,
  onClose,
  onSaved,
}: {
  contactId: string;
  contactName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { values, set } = useDraft({
    basis: 'express' as ConsentBasis,
    purpose: 'marketing' as ConsentPurpose,
    source: '',
    expiresOn: '',
    proofText: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const payload = {
    basis: values.basis,
    purpose: values.purpose,
    source: values.source.trim(),
    proofText: values.proofText.trim() || undefined,
    expiresAt: values.expiresOn
      ? new Date(`${values.expiresOn}T23:59:59.000Z`).toISOString()
      : undefined,
  };

  const save = useMutation({
    mutationFn: () => api.recordContactConsent(contactId, payload),
    onSuccess: () => {
      toast(`Recorded consent for ${contactName}.`);
      onSaved();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });

  const submit = () => {
    const issues = issuesOf(RecordConsentInputSchema, payload);
    setErrors(issues);
    if (Object.keys(issues).length === 0) save.mutate();
  };

  const showExpiry =
    values.basis === 'implied_inquiry' ||
    values.basis === 'implied_ebr' ||
    values.basis === 'implied_published';

  return (
    <EditDrawer
      title="Record consent"
      description={`Save how ${contactName} agreed to receive outreach or marketing, and keep the wording or reference on file.`}
      formId="record-consent"
      pending={save.isPending}
      error={save.isError && Object.keys(errors).length === 0 ? formError(save.error) : null}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Save consent"
    >
      <FormRow id="consent-basis" label="Basis" error={errors['basis']}>
        <Select
          id="consent-basis"
          value={values.basis}
          onChange={(e) => set('basis', e.target.value as ConsentBasis)}
        >
          {Object.entries(CONSENT_BASIS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow id="consent-purpose" label="Purpose" error={errors['purpose']}>
        <Select
          id="consent-purpose"
          value={values.purpose}
          onChange={(e) => set('purpose', e.target.value as ConsentPurpose)}
        >
          <option value="marketing">Marketing & newsletters</option>
          <option value="outreach">One-to-one business outreach</option>
        </Select>
      </FormRow>
      <FormRow
        id="consent-source"
        label="Where consent came from"
        hint="For example: website checkbox, conference sign-up sheet, signed engagement letter."
        error={errors['source']}
      >
        <Input
          id="consent-source"
          value={values.source}
          invalid={Boolean(errors['source'])}
          onChange={(e) => set('source', e.target.value)}
          placeholder="Website opt-in form"
        />
      </FormRow>
      {showExpiry && (
        <FormRow
          id="consent-expires"
          label="Expires on (optional)"
          hint="Leave blank to apply the standard 6-month inquiry or 24-month client window."
          error={errors['expiresAt']}
        >
          <Input
            id="consent-expires"
            type="date"
            value={values.expiresOn}
            onChange={(e) => set('expiresOn', e.target.value)}
          />
        </FormRow>
      )}
      <FormRow id="consent-proof" label="Proof or notes (optional)" error={errors['proofText']}>
        <Textarea
          id="consent-proof"
          rows={3}
          value={values.proofText}
          onChange={(e) => set('proofText', e.target.value)}
          placeholder="Exact checkbox wording or confirmation email summary"
        />
      </FormRow>
    </EditDrawer>
  );
}
