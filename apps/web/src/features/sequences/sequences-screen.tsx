import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import {
  formatDate,
  formatDateTime,
  formatNumber,
  type Market,
  type SequenceStepInput,
  type StatusTone,
} from '@adas/shared';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Drawer } from '@/components/ui/drawer.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type OutreachTemplateRow, type SequenceSummaryRow } from '@/lib/api.js';
import { PageHeader, errorMessage } from '@/features/shared/live-kit.js';
import { can, useMe, useUrlState } from '@/features/shared/list-kit.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { FormRow } from '@/features/settings/settings-kit.js';

const SEQ_STATUS_TONE: Record<string, StatusTone> = {
  active: 'success',
  paused: 'warning',
  draft: 'neutral',
  archived: 'neutral',
};

const ENROLLMENT_STATUS_TONE: Record<string, StatusTone> = {
  active: 'brand',
  paused: 'warning',
  replied: 'success',
  completed: 'info',
  bounced: 'danger',
  unsubscribed: 'danger',
  stopped_suppressed: 'danger',
  stopped_meeting: 'success',
  stopped_deal_won: 'success',
  stopped_merged: 'neutral',
  stopped_manual: 'neutral',
};

const ENROLLMENT_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  replied: 'Replied',
  completed: 'Completed',
  bounced: 'Bounced',
  unsubscribed: 'Unsubscribed',
  stopped_suppressed: 'Suppressed',
  stopped_meeting: 'Meeting booked',
  stopped_deal_won: 'Deal opened',
  stopped_merged: 'Merged',
  stopped_manual: 'Stopped',
  stopped_mailbox: 'Mailbox paused',
};

const URL_DEFAULTS = {
  tab: 'sequences',
  seq: '',
} as const;

function formatMinutesOfDay(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function EnrollInSequenceDrawer({
  open,
  onClose,
  defaultSequenceId,
  lockedContactIds,
  onEnrolled,
}: {
  open: boolean;
  onClose: () => void;
  defaultSequenceId?: string;
  lockedContactIds?: string[];
  onEnrolled?: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [sequenceId, setSequenceId] = useState(defaultSequenceId ?? '');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>(lockedContactIds ?? []);
  const [search, setSearch] = useState('');
  const [lastOutcome, setLastOutcome] = useState<{
    enrolledCount: number;
    skipped: Array<{ contactId: string; reasonCode: string; reasonMessage: string }>;
  } | null>(null);

  const sequencesQuery = useQuery({
    queryKey: ['sequences'],
    queryFn: api.listSequences,
    enabled: open && !defaultSequenceId,
  });

  const contactsQuery = useQuery({
    queryKey: ['contacts-picker', search],
    queryFn: () => api.listContacts({ q: search || undefined, limit: 50 }),
    enabled: open && (!lockedContactIds || lockedContactIds.length === 0),
  });

  const activeSequenceId = defaultSequenceId || sequenceId || sequencesQuery.data?.[0]?.id || '';
  const contactIdsToSubmit =
    lockedContactIds && lockedContactIds.length > 0 ? lockedContactIds : selectedContactIds;

  const enrollMutation = useMutation({
    mutationFn: () =>
      api.batchEnrollSequence(activeSequenceId, {
        contactIds: contactIdsToSubmit,
      }),
    onSuccess: async (res) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sequences'] }),
        queryClient.invalidateQueries({ queryKey: ['sequence', activeSequenceId] }),
        queryClient.invalidateQueries({ queryKey: ['contact'] }),
        queryClient.invalidateQueries({ queryKey: ['contact-outreach'] }),
      ]);
      onEnrolled?.();
      if (res.skipped.length === 0) {
        toast(`Enrolled ${res.enrolled.length} contact${res.enrolled.length === 1 ? '' : 's'}.`);
        setSelectedContactIds([]);
        setLastOutcome(null);
        onClose();
      } else {
        setLastOutcome({
          enrolledCount: res.enrolled.length,
          skipped: res.skipped,
        });
        toast(
          `Enrolled ${res.enrolled.length}; ${res.skipped.length} skipped by eligibility checks.`,
        );
      }
    },
  });

  const toggleContact = (cid: string) => {
    setSelectedContactIds((prev) =>
      prev.includes(cid) ? prev.filter((id) => id !== cid) : [...prev, cid],
    );
  };

  return (
    <Drawer
      open={open}
      title="Enroll contacts in sequence"
      description="Each contact is checked against market consent, suppression, and active-sequence rules before enrollment."
      onClose={() => {
        setLastOutcome(null);
        onClose();
      }}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setLastOutcome(null);
              onClose();
            }}
          >
            Close
          </Button>
          <Button
            variant="primary"
            disabled={
              !activeSequenceId || contactIdsToSubmit.length === 0 || enrollMutation.isPending
            }
            onClick={() => enrollMutation.mutate()}
          >
            {enrollMutation.isPending
              ? 'Checking & enrolling…'
              : `Enroll ${contactIdsToSubmit.length || ''} contact${contactIdsToSubmit.length === 1 ? '' : 's'}`.trim()}
          </Button>
        </>
      }
    >
      <div className="space-y-[14px]">
        {!defaultSequenceId && (
          <FormRow id="enroll-sequence-select" label="Sequence">
            <Select
              id="enroll-sequence-select"
              value={activeSequenceId}
              onChange={(e) => setSequenceId(e.target.value)}
            >
              {(sequencesQuery.data ?? [])
                .filter((s) => s.status === 'active')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.market})
                  </option>
                ))}
            </Select>
          </FormRow>
        )}

        {(!lockedContactIds || lockedContactIds.length === 0) && (
          <>
            <FormRow id="enroll-contact-search" label="Find contacts">
              <Input
                id="enroll-contact-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, email, or firm…"
              />
            </FormRow>
            <div
              className="border border-line rounded-[8px] max-h-[280px] overflow-y-auto divide-y divide-line"
              tabIndex={0}
              role="region"
              aria-label="Selectable contacts"
            >
              {contactsQuery.isPending ? (
                <div className="p-[12px] text-[13px] text-ink-3">Loading contacts…</div>
              ) : (contactsQuery.data?.items ?? []).length === 0 ? (
                <div className="p-[12px] text-[13px] text-ink-3">No matching contacts found.</div>
              ) : (
                (contactsQuery.data?.items ?? []).map((c) => {
                  const checked = selectedContactIds.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex items-start gap-[10px] px-[12px] py-[10px] cursor-pointer hover:bg-bg-alt"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleContact(c.id)}
                        className="mt-[3px]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-medium text-ink">
                          {c.full_name} <span className="text-[12px] text-ink-3">({c.market})</span>
                        </span>
                        <span className="block text-[12px] text-ink-2 truncate">
                          {c.primary_email}
                          {c.company_name ? ` · ${c.company_name}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </>
        )}

        {enrollMutation.isError && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {errorMessage(enrollMutation.error)}
          </p>
        )}

        {lastOutcome && (
          <Callout tone={lastOutcome.skipped.length > 0 ? 'warning' : 'brand'}>
            <div className="space-y-[6px]">
              <div className="font-semibold">
                Enrolled {lastOutcome.enrolledCount}; skipped {lastOutcome.skipped.length}
              </div>
              {lastOutcome.skipped.length > 0 && (
                <ul className="m-0 pl-[18px] text-[13px] space-y-[4px]">
                  {lastOutcome.skipped.map((sk) => (
                    <li key={sk.contactId}>
                      <span className="font-medium">{sk.reasonCode.replace(/_/g, ' ')}:</span>{' '}
                      {sk.reasonMessage}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Callout>
        )}
      </div>
    </Drawer>
  );
}

function SequenceEditorDrawer({
  open,
  onClose,
  templates,
  canRaiseCap,
}: {
  open: boolean;
  onClose: () => void;
  templates: OutreachTemplateRow[];
  canRaiseCap: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [market, setMarket] = useState<Market>('US');
  const [dailyCap, setDailyCap] = useState('50');
  const [stopOnCompanyReply, setStopOnCompanyReply] = useState(true);
  const [steps, setSteps] = useState<SequenceStepInput[]>([
    {
      stepOrder: 1,
      stepKind: 'email',
      delayBusinessDays: 0,
      subjectTemplate: '3-day tax & accounting pod trial for {{company.name|your firm}}',
      bodyTemplate:
        'Hi {{contact.first_name|there}},\n\nWould {{company.name|your firm}} be open to a 3-day no-cost trial of a dedicated Senior Tax Preparer?',
      replyInThread: false,
      taskType: 'call',
    },
    {
      stepOrder: 2,
      stepKind: 'task',
      delayBusinessDays: 2,
      subjectTemplate: '',
      bodyTemplate: '',
      replyInThread: true,
      taskType: 'call',
      taskTitle: 'Call {{contact.first_name}} regarding trial availability',
    },
  ]);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createSequence({
        name: name.trim(),
        description: description.trim() || null,
        market,
        dailyCapPerMailbox: Math.max(1, Math.min(canRaiseCap ? 150 : 50, Number(dailyCap) || 50)),
        stopOnCompanyReply,
        steps: steps.map((st, idx) => ({ ...st, stepOrder: idx + 1 })),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sequences'] });
      toast('Sequence created.');
      setName('');
      setDescription('');
      onClose();
    },
  });

  const addStep = (kind: 'email' | 'task') => {
    setSteps((prev) => [
      ...prev,
      {
        stepOrder: prev.length + 1,
        stepKind: kind,
        delayBusinessDays: 3,
        subjectTemplate: kind === 'email' ? 'Re: 3-day trial for {{company.name|your firm}}' : '',
        bodyTemplate:
          kind === 'email'
            ? 'Hi {{contact.first_name|there}}, sharing a quick follow-up ahead of busy season.'
            : '',
        replyInThread: true,
        taskType: 'call',
        taskTitle: kind === 'task' ? 'Follow-up call with {{contact.first_name}}' : null,
      },
    ]);
  };

  const updateStep = (index: number, patch: Partial<SequenceStepInput>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const removeStep = (index: number) => {
    if (steps.length <= 1) return;
    setSteps((prev) =>
      prev.filter((_, i) => i !== index).map((s, idx) => ({ ...s, stepOrder: idx + 1 })),
    );
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate();
  };

  return (
    <Drawer
      open={open}
      width={560}
      title="New sequence"
      description="Personal multi-step outreach sent from each owner’s connected mailbox during recipient business hours."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || steps.length === 0 || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? 'Saving…' : 'Create sequence'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-[14px]">
        <FormRow id="seq-name-input" label="Sequence name">
          <Input
            id="seq-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. U.S. CPA Busy Season Prep Pod"
            required
          />
        </FormRow>
        <FormRow id="seq-desc-input" label="Description (optional)">
          <Input
            id="seq-desc-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Target firm profile and goal"
          />
        </FormRow>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-[12px]">
          <FormRow id="seq-market-select" label="Market">
            <Select
              id="seq-market-select"
              value={market}
              onChange={(e) => setMarket(e.target.value as Market)}
            >
              <option value="US">United States (US)</option>
              <option value="CA">Canada (CA)</option>
              <option value="OTHER">Other markets</option>
            </Select>
          </FormRow>
          <FormRow
            id="seq-cap-input"
            label={canRaiseCap ? 'Daily mailbox cap (max 150)' : 'Daily mailbox cap (max 50)'}
          >
            <Input
              id="seq-cap-input"
              type="number"
              min={1}
              max={canRaiseCap ? 150 : 50}
              value={dailyCap}
              onChange={(e) => setDailyCap(e.target.value)}
            />
          </FormRow>
        </div>

        <label className="flex items-center gap-[8px] text-[13px] text-ink cursor-pointer">
          <input
            type="checkbox"
            checked={stopOnCompanyReply}
            onChange={(e) => setStopOnCompanyReply(e.target.checked)}
          />
          <span>Stop sequence for colleagues at the same firm when anyone replies</span>
        </label>

        <div className="pt-[8px] border-t border-line space-y-[12px]">
          <div className="flex flex-wrap items-center justify-between gap-[8px]">
            <h3 className="m-0 text-[14px] font-semibold text-ink">Steps ({steps.length})</h3>
            <div className="flex flex-wrap gap-[8px]">
              <Button type="button" variant="secondary" size="sm" onClick={() => addStep('email')}>
                <Plus size={14} aria-hidden="true" /> Add email step
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => addStep('task')}>
                <Plus size={14} aria-hidden="true" /> Add task step
              </Button>
            </div>
          </div>

          {steps.map((st, idx) => (
            <div
              key={idx}
              className="border border-line rounded-[8px] p-[12px] bg-bg-alt space-y-[10px]"
            >
              <div className="flex items-center justify-between gap-[8px]">
                <span className="text-[13px] font-semibold text-ink">
                  Step {idx + 1} · {st.stepKind === 'task' ? 'Task' : 'Email'}
                </span>
                {steps.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove step ${idx + 1}`}
                    onClick={() => removeStep(idx)}
                    className="bg-transparent border-0 text-ink-3 hover:text-danger cursor-pointer p-[4px]"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-[10px]">
                <FormRow id={`step-delay-${idx}`} label="Wait (business days)">
                  <Input
                    id={`step-delay-${idx}`}
                    type="number"
                    min={0}
                    max={90}
                    value={String(st.delayBusinessDays)}
                    onChange={(e) =>
                      updateStep(idx, {
                        delayBusinessDays: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                </FormRow>
                {st.stepKind === 'email' ? (
                  <FormRow id={`step-tpl-${idx}`} label="Load from template">
                    <Select
                      id={`step-tpl-${idx}`}
                      value={st.templateId ?? ''}
                      onChange={(e) => {
                        const chosen = templates.find((t) => t.id === e.target.value);
                        if (chosen) {
                          updateStep(idx, {
                            templateId: chosen.id,
                            subjectTemplate: chosen.subject,
                            bodyTemplate: chosen.body_text,
                          });
                        } else {
                          updateStep(idx, { templateId: null });
                        }
                      }}
                    >
                      <option value="">Custom copy</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </FormRow>
                ) : (
                  <FormRow id={`step-task-type-${idx}`} label="Task type">
                    <Select
                      id={`step-task-type-${idx}`}
                      value={st.taskType ?? 'call'}
                      onChange={(e) =>
                        updateStep(idx, {
                          taskType: e.target.value as SequenceStepInput['taskType'],
                        })
                      }
                    >
                      <option value="call">Phone call</option>
                      <option value="research">Manual LinkedIn research</option>
                      <option value="follow_up">Follow-up</option>
                    </Select>
                  </FormRow>
                )}
              </div>

              {st.stepKind === 'email' ? (
                <>
                  <FormRow id={`step-subj-${idx}`} label="Subject">
                    <Input
                      id={`step-subj-${idx}`}
                      value={st.subjectTemplate ?? ''}
                      onChange={(e) => updateStep(idx, { subjectTemplate: e.target.value })}
                    />
                  </FormRow>
                  <FormRow id={`step-body-${idx}`} label="Plain-text body">
                    <Textarea
                      id={`step-body-${idx}`}
                      rows={3}
                      value={st.bodyTemplate ?? ''}
                      onChange={(e) => updateStep(idx, { bodyTemplate: e.target.value })}
                    />
                  </FormRow>
                  {idx > 0 && (
                    <label className="flex items-center gap-[8px] text-[12px] text-ink-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={st.replyInThread ?? true}
                        onChange={(e) => updateStep(idx, { replyInThread: e.target.checked })}
                      />
                      <span>Send as a reply in the existing email thread</span>
                    </label>
                  )}
                </>
              ) : (
                <FormRow id={`step-task-title-${idx}`} label="Task instructions">
                  <Input
                    id={`step-task-title-${idx}`}
                    value={st.taskTitle ?? ''}
                    onChange={(e) => updateStep(idx, { taskTitle: e.target.value })}
                    placeholder="e.g. Call {{contact.first_name}} at {{company.name}}"
                  />
                </FormRow>
              )}
            </div>
          ))}
        </div>

        {createMutation.isError && (
          <p role="alert" className="m-0 text-[13px] text-danger">
            {errorMessage(createMutation.error)}
          </p>
        )}
      </form>
    </Drawer>
  );
}

export function SequencesScreen({ onOpenContact }: { onOpenContact: (id: string) => void }) {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);

  const activeTab = urlState.tab === 'templates' ? 'templates' : 'sequences';
  const selectedSeqId = urlState.seq || null;

  const [creatingSeq, setCreatingSeq] = useState(false);
  const [enrollingSeqId, setEnrollingSeqId] = useState<string | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplMarket, setTplMarket] = useState<Market>('US');
  const [tplSubject, setTplSubject] = useState('');
  const [tplBody, setTplBody] = useState('');

  const canWrite = can(me, 'sequences.write');
  const canEnroll = can(me, 'sequences.enroll');
  const isAdmin = me?.role === 'Admin';

  const healthQuery = useQuery({
    queryKey: ['healthz'],
    queryFn: api.healthStatus,
  });

  const sequencesQuery = useQuery({
    queryKey: ['sequences'],
    queryFn: api.listSequences,
  });

  const templatesQuery = useQuery({
    queryKey: ['outreach-templates', 'sequence'],
    queryFn: () => api.listOutreachTemplates({ channel: 'sequence' }),
  });

  const detailQuery = useQuery({
    queryKey: ['sequence', selectedSeqId],
    queryFn: () => api.getSequence(selectedSeqId as string),
    enabled: Boolean(selectedSeqId),
  });

  const toggleStatusMutation = useMutation({
    mutationFn: (seq: SequenceSummaryRow) =>
      api.updateSequence(seq.id, {
        version: seq.version,
        status: seq.status === 'active' ? 'paused' : 'active',
      }),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sequences'] }),
        queryClient.invalidateQueries({ queryKey: ['sequence', updated.id] }),
      ]);
      toast(`Sequence ${updated.status === 'active' ? 'activated' : 'paused'}.`);
    },
  });

  const enrollmentActionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'stop' }) =>
      api.updateEnrollmentState(id, { action }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sequences'] }),
        queryClient.invalidateQueries({ queryKey: ['sequence', selectedSeqId] }),
      ]);
      toast('Updated enrollment.');
    },
  });

  const createTemplateMutation = useMutation({
    mutationFn: () =>
      api.createOutreachTemplate({
        name: tplName.trim(),
        channel: 'sequence',
        market: tplMarket,
        subject: tplSubject.trim(),
        bodyText: tplBody.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['outreach-templates', 'sequence'] });
      setCreatingTemplate(false);
      setTplName('');
      setTplSubject('');
      setTplBody('');
      toast('Template saved.');
    },
  });

  return (
    <div className="space-y-[16px] min-w-0" data-testid="sequences-screen">
      <PageHeader
        kicker="GROW"
        title="Sequences"
        count={sequencesQuery.data?.length}
        actions={
          <div className="flex flex-wrap gap-[8px]">
            {activeTab === 'templates' && canWrite && (
              <Button variant="primary" onClick={() => setCreatingTemplate(true)}>
                New template
              </Button>
            )}
            {activeTab === 'sequences' && canWrite && (
              <Button variant="primary" onClick={() => setCreatingSeq(true)}>
                New sequence
              </Button>
            )}
          </div>
        }
      />

      {healthQuery.data && !healthQuery.data.mailLive && (
        <Callout tone="brand">
          Test delivery mode is active: sequence emails are captured in the local mail catcher and
          never reach external inboxes.
        </Callout>
      )}

      {!selectedSeqId && (
        <div
          role="tablist"
          aria-label="Sequences sections"
          className="flex flex-wrap gap-[6px] border-b border-line pb-[10px]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sequences'}
            onClick={() => setUrlState({ tab: 'sequences', seq: '' })}
            className={`h-[34px] px-[14px] rounded-pill text-[13px] font-medium border cursor-pointer ${
              activeTab === 'sequences'
                ? 'bg-navy text-white border-navy'
                : 'bg-surface text-ink-2 border-line hover:text-ink'
            }`}
          >
            Sequences ({sequencesQuery.data?.length ?? 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'templates'}
            onClick={() => setUrlState({ tab: 'templates', seq: '' })}
            className={`h-[34px] px-[14px] rounded-pill text-[13px] font-medium border cursor-pointer ${
              activeTab === 'templates'
                ? 'bg-navy text-white border-navy'
                : 'bg-surface text-ink-2 border-line hover:text-ink'
            }`}
          >
            Templates ({templatesQuery.data?.length ?? 0})
          </button>
        </div>
      )}

      {selectedSeqId ? (
        detailQuery.isPending ? (
          <LoadingState />
        ) : detailQuery.isError ? (
          <ErrorState
            message={errorMessage(detailQuery.error)}
            onRetry={() => void detailQuery.refetch()}
          />
        ) : (
          <div className="space-y-[16px] min-w-0" data-testid="sequence-detail-view">
            <div className="flex flex-wrap items-center justify-between gap-[10px]">
              <button
                type="button"
                onClick={() => setUrlState({ seq: '' })}
                className="inline-flex items-center gap-[6px] bg-transparent border-0 p-0 text-[13px] font-medium text-ink-2 hover:text-ink cursor-pointer"
              >
                <ArrowLeft size={15} aria-hidden="true" /> All sequences
              </button>
              <div className="flex flex-wrap gap-[8px]">
                {canWrite && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={toggleStatusMutation.isPending}
                    onClick={() => toggleStatusMutation.mutate(detailQuery.data.sequence)}
                  >
                    {detailQuery.data.sequence.status === 'active'
                      ? 'Pause sequence'
                      : 'Activate sequence'}
                  </Button>
                )}
                {canEnroll && detailQuery.data.sequence.status === 'active' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setEnrollingSeqId(detailQuery.data.sequence.id)}
                  >
                    Enroll contacts
                  </Button>
                )}
              </div>
            </div>

            <Panel
              title={detailQuery.data.sequence.name}
              actions={
                <div className="flex flex-wrap items-center gap-[6px]">
                  <MarketBadge market={detailQuery.data.sequence.market} />
                  <StatusBadge
                    tone={SEQ_STATUS_TONE[detailQuery.data.sequence.status] ?? 'neutral'}
                  >
                    {detailQuery.data.sequence.status}
                  </StatusBadge>
                </div>
              }
              padded
            >
              <div className="text-[13px] text-ink-2 flex flex-wrap gap-[14px]">
                <span>
                  Send window:{' '}
                  {formatMinutesOfDay(detailQuery.data.sequence.send_window_start_minutes)}–
                  {formatMinutesOfDay(detailQuery.data.sequence.send_window_end_minutes)} recipient
                  local business days
                </span>
                <span>
                  Daily cap: {detailQuery.data.sequence.daily_cap_per_mailbox} per mailbox
                </span>
                <span>
                  Company reply stop:{' '}
                  {detailQuery.data.sequence.stop_on_company_reply ? 'On' : 'Contact only'}
                </span>
              </div>

              <div className="mt-[14px] grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-[10px]">
                {[
                  ['Enrolled', formatNumber(detailQuery.data.metrics.enrolledCount)],
                  ['Sent', formatNumber(detailQuery.data.metrics.sentCount)],
                  [
                    'Replied',
                    `${formatNumber(detailQuery.data.metrics.repliedCount)} (${detailQuery.data.metrics.replyRatePct}%)`,
                  ],
                  ['Bounced', formatNumber(detailQuery.data.metrics.bouncedCount)],
                  ['Unsubscribed', formatNumber(detailQuery.data.metrics.unsubscribedCount)],
                  ['Meetings', formatNumber(detailQuery.data.metrics.meetingsCount)],
                ].map(([label, val]) => (
                  <div
                    key={label}
                    className="border border-line rounded-[8px] px-[12px] py-[10px] bg-bg-alt"
                  >
                    <div className="text-[12px] text-ink-3">{label}</div>
                    <div className="text-[18px] font-semibold text-ink tabular-nums mt-[2px]">
                      {val}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title={`Steps (${detailQuery.data.steps.length})`}>
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Sequence steps and performance"
              >
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[12px] text-ink-3">
                      <th className="py-[10px] px-[14px] font-medium">Step</th>
                      <th className="py-[10px] px-[14px] font-medium">Type</th>
                      <th className="py-[10px] px-[14px] font-medium">Delay</th>
                      <th className="py-[10px] px-[14px] font-medium">Subject or task</th>
                      <th className="py-[10px] px-[14px] font-medium text-right">Sent</th>
                      <th className="py-[10px] px-[14px] font-medium text-right">Replied</th>
                      <th className="py-[10px] px-[14px] font-medium text-right">Reply rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {detailQuery.data.steps.map((st) => (
                      <tr key={st.id}>
                        <td className="py-[10px] px-[14px] font-semibold text-ink tabular-nums">
                          #{st.step_order}
                        </td>
                        <td className="py-[10px] px-[14px]">
                          <StatusBadge tone={st.step_kind === 'task' ? 'info' : 'brand'}>
                            {st.step_kind === 'task' ? `Task (${st.task_type})` : 'Email'}
                          </StatusBadge>
                        </td>
                        <td className="py-[10px] px-[14px] text-ink-2 tabular-nums">
                          {st.delay_business_days === 0
                            ? 'Immediate'
                            : `+${st.delay_business_days} business day${st.delay_business_days === 1 ? '' : 's'}`}
                        </td>
                        <td className="py-[10px] px-[14px] text-ink max-w-[340px] truncate">
                          {st.step_kind === 'task'
                            ? st.task_title || 'Follow-up task'
                            : st.subject_template}
                        </td>
                        <td className="py-[10px] px-[14px] text-right tabular-nums">
                          {formatNumber(st.sent_count)}
                        </td>
                        <td className="py-[10px] px-[14px] text-right tabular-nums">
                          {formatNumber(st.replied_count)}
                        </td>
                        <td className="py-[10px] px-[14px] text-right tabular-nums">
                          {st.replyRatePct}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title={`Enrolled contacts (${detailQuery.data.enrollments.length})`}>
              {detailQuery.data.enrollments.length === 0 ? (
                <EmptyState
                  title="No contacts enrolled yet"
                  description="Enroll contacts to start scheduled personal outreach within their local business hours."
                  actionLabel={
                    canEnroll && detailQuery.data.sequence.status === 'active'
                      ? 'Enroll contacts'
                      : undefined
                  }
                  onAction={() => setEnrollingSeqId(detailQuery.data.sequence.id)}
                />
              ) : (
                <div
                  className="overflow-x-auto"
                  tabIndex={0}
                  role="region"
                  aria-label="Sequence enrollments"
                >
                  <table className="w-full border-collapse text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-[12px] text-ink-3">
                        <th className="py-[10px] px-[14px] font-medium">Contact</th>
                        <th className="py-[10px] px-[14px] font-medium">Status</th>
                        <th className="py-[10px] px-[14px] font-medium">Step</th>
                        <th className="py-[10px] px-[14px] font-medium">Next window</th>
                        <th className="py-[10px] px-[14px] font-medium">Sender</th>
                        <th className="py-[10px] px-[14px] font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {detailQuery.data.enrollments.map((enr) => (
                        <tr key={enr.id}>
                          <td className="py-[10px] px-[14px]">
                            <button
                              type="button"
                              onClick={() => onOpenContact(enr.contact_id)}
                              className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                            >
                              {enr.contact_name}
                            </button>
                            <div className="text-[12px] text-ink-3">
                              {enr.company_name ?? enr.email}
                            </div>
                          </td>
                          <td className="py-[10px] px-[14px]">
                            <StatusBadge tone={ENROLLMENT_STATUS_TONE[enr.status] ?? 'neutral'}>
                              {ENROLLMENT_STATUS_LABEL[enr.status] ?? enr.status}
                            </StatusBadge>
                            {(enr.stop_reason || enr.last_skip_reason) && (
                              <div className="text-[11px] text-ink-3 mt-[2px]">
                                {enr.stop_reason ?? enr.last_skip_reason}
                              </div>
                            )}
                          </td>
                          <td className="py-[10px] px-[14px] tabular-nums">
                            Step {enr.current_step_order}
                          </td>
                          <td className="py-[10px] px-[14px] text-ink-2 tabular-nums">
                            {enr.next_send_at ? formatDateTime(enr.next_send_at, timeZone) : '—'}
                          </td>
                          <td className="py-[10px] px-[14px] text-ink-2">
                            {enr.sender_name ?? '—'}
                          </td>
                          <td className="py-[10px] px-[14px] text-right">
                            {canEnroll && (enr.status === 'active' || enr.status === 'paused') && (
                              <div className="inline-flex flex-wrap justify-end gap-[6px]">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    enrollmentActionMutation.mutate({
                                      id: enr.id,
                                      action: enr.status === 'active' ? 'pause' : 'resume',
                                    })
                                  }
                                >
                                  {enr.status === 'active' ? 'Pause' : 'Resume'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    enrollmentActionMutation.mutate({
                                      id: enr.id,
                                      action: 'stop',
                                    })
                                  }
                                >
                                  Stop
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        )
      ) : activeTab === 'templates' ? (
        templatesQuery.isPending ? (
          <LoadingState />
        ) : templatesQuery.isError ? (
          <ErrorState
            message={errorMessage(templatesQuery.error)}
            onRetry={() => void templatesQuery.refetch()}
          />
        ) : templatesQuery.data.length === 0 ? (
          <Panel>
            <EmptyState
              title="No sequence templates yet"
              description="Save plain-text templates with variables so your team can reuse proven outreach copy."
              actionLabel={canWrite ? 'New template' : undefined}
              onAction={() => setCreatingTemplate(true)}
            />
          </Panel>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">
            {templatesQuery.data.map((tpl) => (
              <Panel
                key={tpl.id}
                title={tpl.name}
                actions={<MarketBadge market={tpl.market} />}
                padded
              >
                <div className="space-y-[8px] text-[13px]">
                  <div className="font-medium text-ink">{tpl.subject}</div>
                  <p className="m-0 text-ink-2 whitespace-pre-line line-clamp-3">{tpl.body_text}</p>
                  <div className="text-[12px] text-ink-3">
                    Updated {formatDate(tpl.updated_at, timeZone)}
                  </div>
                </div>
              </Panel>
            ))}
          </div>
        )
      ) : sequencesQuery.isPending ? (
        <LoadingState />
      ) : sequencesQuery.isError ? (
        <ErrorState
          message={errorMessage(sequencesQuery.error)}
          onRetry={() => void sequencesQuery.refetch()}
        />
      ) : sequencesQuery.data.length === 0 ? (
        <Panel>
          <EmptyState
            title="No outreach sequences yet"
            description="Create a multi-step email and call sequence to contact prospects during their business hours."
            actionLabel={canWrite ? 'New sequence' : undefined}
            onAction={() => setCreatingSeq(true)}
          />
        </Panel>
      ) : (
        <Panel>
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Outreach sequences"
          >
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[12px] text-ink-3">
                  <th className="py-[10px] px-[14px] font-medium">Sequence</th>
                  <th className="py-[10px] px-[14px] font-medium">Market</th>
                  <th className="py-[10px] px-[14px] font-medium">Status</th>
                  <th className="py-[10px] px-[14px] font-medium text-right">Steps</th>
                  <th className="py-[10px] px-[14px] font-medium text-right">Active</th>
                  <th className="py-[10px] px-[14px] font-medium text-right">Sent</th>
                  <th className="py-[10px] px-[14px] font-medium text-right">Replied</th>
                  <th className="py-[10px] px-[14px] font-medium text-right">Cap / day</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sequencesQuery.data.map((seq) => (
                  <tr key={seq.id} className="hover:bg-bg-alt">
                    <td className="py-[12px] px-[14px]">
                      <button
                        type="button"
                        onClick={() => setUrlState({ seq: seq.id })}
                        className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                      >
                        {seq.name}
                      </button>
                      <div className="text-[12px] text-ink-3">Owner {seq.owner_name ?? 'Team'}</div>
                    </td>
                    <td className="py-[12px] px-[14px]">
                      <MarketBadge market={seq.market} />
                    </td>
                    <td className="py-[12px] px-[14px]">
                      <StatusBadge tone={SEQ_STATUS_TONE[seq.status] ?? 'neutral'}>
                        {seq.status}
                      </StatusBadge>
                    </td>
                    <td className="py-[12px] px-[14px] text-right tabular-nums">
                      {formatNumber(seq.step_count)}
                    </td>
                    <td className="py-[12px] px-[14px] text-right tabular-nums">
                      {formatNumber(seq.active_enrollments)} / {formatNumber(seq.enrolled_count)}
                    </td>
                    <td className="py-[12px] px-[14px] text-right tabular-nums">
                      {formatNumber(seq.sent_count)}
                    </td>
                    <td className="py-[12px] px-[14px] text-right tabular-nums">
                      {formatNumber(seq.replied_count)}
                    </td>
                    <td className="py-[12px] px-[14px] text-right tabular-nums">
                      {seq.daily_cap_per_mailbox}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <SequenceEditorDrawer
        open={creatingSeq}
        onClose={() => setCreatingSeq(false)}
        templates={templatesQuery.data ?? []}
        canRaiseCap={Boolean(isAdmin)}
      />

      <EnrollInSequenceDrawer
        open={Boolean(enrollingSeqId)}
        defaultSequenceId={enrollingSeqId ?? undefined}
        onClose={() => setEnrollingSeqId(null)}
      />

      <Drawer
        open={creatingTemplate}
        title="New sequence template"
        description="Plain-text template with variable placeholders such as {{contact.first_name|there}} and {{company.name|your firm}}."
        onClose={() => setCreatingTemplate(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreatingTemplate(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                !tplName.trim() ||
                !tplSubject.trim() ||
                !tplBody.trim() ||
                createTemplateMutation.isPending
              }
              onClick={() => createTemplateMutation.mutate()}
            >
              {createTemplateMutation.isPending ? 'Saving…' : 'Save template'}
            </Button>
          </>
        }
      >
        <div className="space-y-[12px]">
          <FormRow id="tpl-seq-name" label="Template name">
            <Input
              id="tpl-seq-name"
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              placeholder="e.g. Busy Season Tax Senior Trial Intro"
            />
          </FormRow>
          <FormRow id="tpl-seq-market" label="Market">
            <Select
              id="tpl-seq-market"
              value={tplMarket}
              onChange={(e) => setTplMarket(e.target.value as Market)}
            >
              <option value="US">United States (US)</option>
              <option value="CA">Canada (CA)</option>
              <option value="OTHER">Other markets</option>
            </Select>
          </FormRow>
          <FormRow id="tpl-seq-subject" label="Subject line">
            <Input
              id="tpl-seq-subject"
              value={tplSubject}
              onChange={(e) => setTplSubject(e.target.value)}
              placeholder="3-day trial for {{company.name|your firm}}"
            />
          </FormRow>
          <FormRow id="tpl-seq-body" label="Plain-text body">
            <Textarea
              id="tpl-seq-body"
              rows={6}
              value={tplBody}
              onChange={(e) => setTplBody(e.target.value)}
              placeholder="Hi {{contact.first_name|there}}, ..."
            />
          </FormRow>
          {createTemplateMutation.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(createTemplateMutation.error)}
            </p>
          )}
        </div>
      </Drawer>
    </div>
  );
}
