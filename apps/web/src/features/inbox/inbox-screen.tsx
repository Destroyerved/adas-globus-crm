import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  CheckSquare,
  Download,
  MailPlus,
  Paperclip,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import {
  formatDateTime,
  formatNumber,
  formatRelative,
  type EmailAttachmentView,
  type EmailMessageView,
  type InboxThreadFilterStatus,
  type InboxThreadSummary,
} from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Callout, Panel } from '@/components/ui/panel.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { PageHeader, errorMessage } from '@/features/shared/live-kit.js';
import { can, useDebounced, useMe, useUrlState } from '@/features/shared/list-kit.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { ComposeEmailDrawer } from './compose-email-drawer.js';
import { SandboxedEmailBody } from './sandboxed-email-body.js';

const STATUS_TABS: { id: InboxThreadFilterStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'replied', label: 'Replied' },
  { id: 'archived', label: 'Archived' },
];

const URL_DEFAULTS = {
  status: 'all',
  q: '',
  thread: '',
} as const;

function saveDownloadedBlob(blob: Blob, filename: string): void {
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

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function InboxScreen({
  onOpenContact,
  onOpenCompany,
  onOpenDeal,
}: {
  onOpenContact: (id: string) => void;
  onOpenCompany: (id: string) => void;
  onOpenDeal: (id: string) => void;
}) {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const timeZone = viewerTimeZone();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const statusFilter: InboxThreadFilterStatus = (
    ['all', 'open', 'replied', 'archived'].includes(urlState.status) ? urlState.status : 'all'
  ) as InboxThreadFilterStatus;
  const debouncedQuery = useDebounced(urlState.q.trim(), 200);

  const [composing, setComposing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [setupHintProvider, setSetupHintProvider] = useState<
    'microsoft_graph' | 'google_gmail' | null
  >(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const canSend = can(me, 'inbox.send');
  const canCreateTask = can(me, 'tasks.write');
  const canReadDeals = can(me, 'deals.read');

  // "/" keyboard shortcut focuses the Inbox search input
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (isField) return;
      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const mailboxQuery = useQuery({
    queryKey: ['inbox-mailbox'],
    queryFn: api.inboxMailbox,
  });

  const threadsQuery = useQuery({
    queryKey: ['inbox-threads', statusFilter, debouncedQuery],
    queryFn: () =>
      api.listInboxThreads({
        status: statusFilter,
        q: debouncedQuery || undefined,
      }),
  });

  const threads = threadsQuery.data?.items ?? [];
  const counts = threadsQuery.data?.counts ?? { all: 0, open: 0, replied: 0, archived: 0 };
  const activeThreadId =
    urlState.thread && threads.some((t) => t.id === urlState.thread)
      ? urlState.thread
      : urlState.thread || (threads[0]?.id ?? '');

  const detailQuery = useQuery({
    queryKey: ['inbox-thread', activeThreadId],
    queryFn: () => api.getInboxThread(activeThreadId),
    enabled: Boolean(activeThreadId),
  });

  const dealsQuery = useQuery({
    queryKey: ['inbox-linkable-deals'],
    queryFn: () => api.listDeals({ limit: 50 }),
    enabled: canReadDeals && Boolean(activeThreadId),
  });

  const templatesQuery = useQuery({
    queryKey: ['inbox-templates'],
    queryFn: api.listInboxTemplates,
    enabled: canSend,
  });

  const syncMutation = useMutation({
    mutationFn: api.syncInboxMailbox,
    onSuccess: async (res) => {
      toast(
        res.syncedMessages > 0
          ? `Synced ${formatNumber(res.syncedMessages)} messages.`
          : 'Mailbox is up to date.',
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox-mailbox'] }),
        queryClient.invalidateQueries({ queryKey: ['inbox-threads'] }),
        ...(activeThreadId
          ? [queryClient.invalidateQueries({ queryKey: ['inbox-thread', activeThreadId] })]
          : []),
      ]);
    },
    onError: (err) => toast(errorMessage(err)),
  });

  const disconnectMutation = useMutation({
    mutationFn: api.disconnectInboxMailbox,
    onSuccess: async (res) => {
      setDisconnecting(false);
      toast(
        res.pausedSequences > 0
          ? `Mailbox disconnected and ${formatNumber(res.pausedSequences)} active sequences paused.`
          : 'Mailbox disconnected.',
      );
      await queryClient.invalidateQueries({ queryKey: ['inbox-mailbox'] });
    },
    onError: (err) => toast(errorMessage(err)),
  });

  const selectThread = (id: string) => {
    setUrlState({ thread: id });
    setMobileDetailOpen(true);
  };

  const mailbox = mailboxQuery.data;
  const filtered = Boolean(urlState.q.trim() || statusFilter !== 'all');

  return (
    <div className="space-y-[16px]" data-testid="inbox-screen">
      <PageHeader
        kicker="Communications"
        title="Inbox"
        count={threadsQuery.isSuccess ? (counts['all'] ?? threads.length) : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-[8px]">
            {mailbox?.connected && (
              <Button
                variant="outline"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {syncMutation.isPending ? 'Syncing…' : 'Sync now'}
              </Button>
            )}
            {canSend && (
              <Button variant="primary" onClick={() => setComposing(true)}>
                <MailPlus size={16} aria-hidden="true" />
                Compose email
              </Button>
            )}
          </div>
        }
      />

      <div
        role="tablist"
        aria-label="Conversation status"
        className="flex gap-[20px] border-b border-line overflow-x-auto"
      >
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={statusFilter === tab.id}
            className="view-tab"
            onClick={() => {
              setUrlState({ status: tab.id, thread: '' });
              setMobileDetailOpen(false);
            }}
          >
            {`${tab.label}${threadsQuery.isSuccess ? ` (${formatNumber(counts[tab.id] ?? 0)})` : ''}`}
          </button>
        ))}
      </div>

      {/* Mailbox Connection Status Strip */}
      {mailbox && (
        <Panel padded>
          <div className="flex flex-wrap items-center justify-between gap-[12px]">
            <div className="min-w-0 space-y-[2px]">
              <div className="flex flex-wrap items-center gap-[8px]">
                <span className="text-[14px] font-semibold text-ink">
                  {mailbox.email ?? 'No mailbox connected'}
                </span>
                {mailbox.provider && (
                  <StatusBadge tone="neutral">
                    {mailbox.provider === 'google_gmail' ? 'Google Workspace' : 'Microsoft 365'}
                  </StatusBadge>
                )}
                <StatusBadge
                  tone={
                    mailbox.status === 'connected'
                      ? 'success'
                      : mailbox.status === 'Needs Reconnect'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {mailbox.status === 'connected'
                    ? 'Connected'
                    : mailbox.status === 'Needs Reconnect'
                      ? 'Needs reconnect'
                      : 'Not connected'}
                </StatusBadge>
                {!mailbox.mailLive && <StatusBadge tone="info">Sandbox · Mailpit</StatusBadge>}
              </div>
              <p className="m-0 text-[12.5px] text-ink-3">
                {mailbox.connected
                  ? `${formatNumber(mailbox.sentTodayCount)} of ${formatNumber(mailbox.dailySendCap)} daily sends used${mailbox.lastSyncedAt ? ` · Last synced ${formatRelative(mailbox.lastSyncedAt)}` : ''}`
                  : 'Connect your Microsoft 365 or Google Workspace mailbox to sync client threads and automate outreach.'}
                {mailbox.lastError ? ` · ${mailbox.lastError}` : ''}
              </p>
            </div>

            {canSend && (
              <div className="flex flex-wrap items-center gap-[8px]">
                {mailbox.connected ? (
                  <Button variant="ghost" size="sm" onClick={() => setDisconnecting(true)}>
                    Disconnect
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="connect-microsoft-mailbox-btn"
                      onClick={() => {
                        if (!mailbox.entraConfigured) {
                          setSetupHintProvider('microsoft_graph');
                          return;
                        }
                        window.location.assign(api.inboxOAuthStartUrl('microsoft_graph'));
                      }}
                    >
                      {mailbox.status === 'Needs Reconnect' &&
                      mailbox.provider === 'microsoft_graph'
                        ? 'Reconnect Microsoft 365'
                        : 'Connect Microsoft 365'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="connect-google-mailbox-btn"
                      onClick={() => {
                        if (!mailbox.googleConfigured) {
                          setSetupHintProvider('google_gmail');
                          return;
                        }
                        window.location.assign(api.inboxOAuthStartUrl('google_gmail'));
                      }}
                    >
                      {mailbox.status === 'Needs Reconnect' && mailbox.provider === 'google_gmail'
                        ? 'Reconnect Google Workspace'
                        : 'Connect Google Workspace'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>

          {setupHintProvider === 'microsoft_graph' && !mailbox.entraConfigured && (
            <div className="mt-[10px]">
              <Callout tone="warning">
                Microsoft 365 is not configured on this server yet. Add your Entra tenant ID, client
                ID and client secret file to connect a live Outlook mailbox.
              </Callout>
            </div>
          )}
          {setupHintProvider === 'google_gmail' && !mailbox.googleConfigured && (
            <div className="mt-[10px]">
              <Callout tone="warning">
                Google Workspace is not configured on this server yet. Add your Google OAuth client
                ID and client secret file to connect a live Gmail mailbox.
              </Callout>
            </div>
          )}
        </Panel>
      )}

      {/* Search toolbar */}
      <div className="flex flex-wrap items-center gap-[10px]">
        <div className="relative flex-1 min-w-[220px] max-w-[420px]">
          <Search
            size={16}
            aria-hidden="true"
            className="absolute left-[12px] top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
          />
          <Input
            ref={searchInputRef}
            value={urlState.q}
            onChange={(e) => setUrlState({ q: e.target.value })}
            placeholder="Search conversations by subject, contact or firm…"
            aria-label="Search conversations"
            className="pl-[34px]"
          />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setUrlState({ status: 'all', q: '', thread: '' });
              setMobileDetailOpen(false);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Main Split Workspace */}
      {threadsQuery.isPending ? (
        <Panel>
          <LoadingState rows={5} />
        </Panel>
      ) : threadsQuery.isError ? (
        <Panel>
          <ErrorState
            message={errorMessage(threadsQuery.error)}
            onRetry={() => void threadsQuery.refetch()}
          />
        </Panel>
      ) : threads.length === 0 ? (
        <Panel>
          <EmptyState
            title={filtered ? 'No conversations match these filters' : 'No conversations yet'}
            description={
              filtered
                ? 'Clear the search or switch back to All conversations.'
                : 'Synced client emails and messages you send from the CRM appear here.'
            }
            actionLabel={filtered ? 'Clear filters' : canSend ? 'Compose email' : undefined}
            onAction={
              filtered
                ? () => setUrlState({ status: 'all', q: '', thread: '' })
                : canSend
                  ? () => setComposing(true)
                  : undefined
            }
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-[16px] items-start">
          {/* Left: Thread List */}
          <div className={`min-w-0 ${mobileDetailOpen ? 'hidden lg:block' : 'block'}`}>
            <Panel padded={false}>
              <ul className="m-0 p-0 list-none divide-y divide-line" aria-label="Conversations">
                {threads.map((thread) => {
                  const isActive = thread.id === activeThreadId;
                  return (
                    <li key={thread.id}>
                      <button
                        type="button"
                        onClick={() => selectThread(thread.id)}
                        aria-current={isActive ? 'true' : undefined}
                        className={`w-full text-left px-[16px] py-[12px] bg-transparent border-0 border-l-2 cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-tint border-l-primary'
                            : 'border-l-transparent hover:bg-bg-alt'
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-[8px]">
                          <span className="text-[13.5px] font-semibold text-ink truncate">
                            {thread.contactName ??
                              thread.companyName ??
                              thread.contactEmail ??
                              'Unknown contact'}
                          </span>
                          <span
                            className="text-[12px] text-ink-3 whitespace-nowrap tabular-nums"
                            title={formatDateTime(thread.lastMessageAt, timeZone)}
                          >
                            {formatRelative(thread.lastMessageAt)}
                          </span>
                        </div>
                        {thread.companyName && thread.contactName && (
                          <div className="text-[12px] text-ink-3 truncate">
                            {thread.companyName}
                          </div>
                        )}
                        <div className="mt-[2px] text-[13.5px] font-medium text-ink truncate">
                          {thread.subject}
                        </div>
                        <div className="mt-[2px] text-[12.5px] text-ink-2 truncate">
                          {thread.snippet || 'No preview'}
                        </div>
                        <div className="mt-[6px] flex flex-wrap items-center gap-[6px]">
                          <StatusBadge
                            tone={
                              thread.status === 'replied'
                                ? 'brand'
                                : thread.status === 'archived'
                                  ? 'neutral'
                                  : 'info'
                            }
                          >
                            {thread.status === 'replied'
                              ? 'Replied'
                              : thread.status === 'archived'
                                ? 'Archived'
                                : 'Open'}
                          </StatusBadge>
                          <span className="text-[12px] text-ink-3 tabular-nums">
                            {thread.messageCount === 1
                              ? '1 message'
                              : `${formatNumber(thread.messageCount)} messages`}
                          </span>
                          {thread.unreadCount > 0 && (
                            <StatusBadge tone="brand">
                              {formatNumber(thread.unreadCount)} unread
                            </StatusBadge>
                          )}
                          {thread.hasFailedOutbound && (
                            <StatusBadge tone="danger">Send failed</StatusBadge>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          </div>

          {/* Right: Active Thread Detail */}
          <div className={`min-w-0 ${mobileDetailOpen ? 'block' : 'hidden lg:block'}`}>
            {mobileDetailOpen && (
              <div className="mb-[8px] lg:hidden">
                <Button variant="ghost" size="sm" onClick={() => setMobileDetailOpen(false)}>
                  <ArrowLeft size={16} aria-hidden="true" />
                  All conversations
                </Button>
              </div>
            )}

            {!activeThreadId ? (
              <Panel>
                <p className="m-0 text-ink-2">Select a conversation on the left to read it.</p>
              </Panel>
            ) : detailQuery.isPending ? (
              <Panel>
                <LoadingState rows={4} />
              </Panel>
            ) : detailQuery.isError ? (
              <Panel>
                <ErrorState
                  message={errorMessage(detailQuery.error)}
                  onRetry={() => void detailQuery.refetch()}
                />
              </Panel>
            ) : (
              <ThreadDetailPane
                thread={detailQuery.data.thread}
                messages={detailQuery.data.messages}
                deals={dealsQuery.data?.items ?? []}
                templates={templatesQuery.data ?? []}
                canSend={canSend}
                canCreateTask={canCreateTask}
                canReadDeals={canReadDeals}
                timeZone={timeZone}
                onOpenContact={onOpenContact}
                onOpenCompany={onOpenCompany}
                onOpenDeal={onOpenDeal}
              />
            )}
          </div>
        </div>
      )}

      <ComposeEmailDrawer
        open={composing}
        onClose={() => setComposing(false)}
        onSent={(detail) => {
          setUrlState({ thread: detail.thread.id });
          setMobileDetailOpen(true);
        }}
      />

      <ConfirmDialog
        open={disconnecting}
        title={`Disconnect ${mailbox?.provider === 'google_gmail' ? 'Google Workspace' : 'Microsoft 365'} mailbox?`}
        body="Syncing will stop and any active sequences sending from your mailbox will pause immediately."
        confirmLabel="Disconnect mailbox"
        tone="danger"
        pending={disconnectMutation.isPending}
        onCancel={() => setDisconnecting(false)}
        onConfirm={() => disconnectMutation.mutate()}
      />
    </div>
  );
}

function ThreadDetailPane({
  thread,
  messages,
  deals,
  templates,
  canSend,
  canCreateTask,
  canReadDeals,
  timeZone,
  onOpenContact,
  onOpenCompany,
  onOpenDeal,
}: {
  thread: InboxThreadSummary;
  messages: EmailMessageView[];
  deals: { id: string; name: string }[];
  templates: { id: string; name: string; market: string; bodyText: string }[];
  canSend: boolean;
  canCreateTask: boolean;
  canReadDeals: boolean;
  timeZone: string;
  onOpenContact: (id: string) => void;
  onOpenCompany: (id: string) => void;
  onOpenDeal: (id: string) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [replyBody, setReplyBody] = useState('');
  const [replyTemplateId, setReplyTemplateId] = useState('');
  const [taskModalMsg, setTaskModalMsg] = useState<EmailMessageView | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);

  const updateThreadMutation = useMutation({
    mutationFn: (patch: { status?: 'open' | 'archived'; dealId?: string | null }) =>
      api.updateInboxThread(thread.id, patch),
    onSuccess: async (_, vars) => {
      if (vars.status) {
        toast(vars.status === 'archived' ? 'Conversation archived.' : 'Conversation reopened.');
      } else {
        toast(vars.dealId ? 'Linked conversation to deal.' : 'Unlinked deal.');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox-thread', thread.id] }),
        queryClient.invalidateQueries({ queryKey: ['inbox-threads'] }),
      ]);
    },
    onError: (err) => toast(errorMessage(err)),
  });

  const replyMutation = useMutation({
    mutationFn: () =>
      api.replyInboxThread(thread.id, {
        bodyText: replyBody.trim(),
        ccEmails: [],
        templateId: replyTemplateId || null,
      }),
    onSuccess: async () => {
      setReplyBody('');
      setReplyTemplateId('');
      toast('Reply sent.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox-thread', thread.id] }),
        queryClient.invalidateQueries({ queryKey: ['inbox-threads'] }),
        queryClient.invalidateQueries({ queryKey: ['inbox-mailbox'] }),
      ]);
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: () => {
      if (!taskModalMsg) throw new Error('No message selected');
      return api.createTaskFromEmail(taskModalMsg.id, {
        title: taskTitle.trim() || `Follow up: ${taskModalMsg.subject}`,
        priority: 'normal',
      });
    },
    onSuccess: async () => {
      setTaskModalMsg(null);
      setTaskTitle('');
      toast('Task created from email.');
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => toast(errorMessage(err)),
  });

  const handleDownloadAttachment = async (att: EmailAttachmentView) => {
    setDownloadingAttId(att.id);
    try {
      const file = await api.downloadEmailAttachment(att.messageId, att.id);
      saveDownloadedBlob(file.blob, file.filename || att.filename);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setDownloadingAttId(null);
    }
  };

  const handleReplySubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!replyBody.trim()) return;
    replyMutation.mutate();
  };

  return (
    <div className="space-y-[16px]">
      <Panel padded>
        <div className="flex flex-wrap items-start justify-between gap-[12px]">
          <div className="min-w-0 space-y-[4px]">
            <h2 className="m-0 text-title text-ink break-words">{thread.subject}</h2>
            <div className="flex flex-wrap items-center gap-[8px] text-[13px] text-ink-2">
              {thread.contactId && thread.contactName && (
                <button
                  type="button"
                  onClick={() => onOpenContact(thread.contactId as string)}
                  className="bg-transparent border-0 p-0 font-semibold text-primary-ink cursor-pointer hover:underline"
                >
                  {thread.contactName}
                </button>
              )}
              {thread.companyId && thread.companyName && (
                <button
                  type="button"
                  onClick={() => onOpenCompany(thread.companyId as string)}
                  className="bg-transparent border-0 p-0 font-semibold text-primary-ink cursor-pointer hover:underline"
                >
                  · {thread.companyName}
                </button>
              )}
              {thread.dealId && thread.dealName && (
                <button
                  type="button"
                  onClick={() => onOpenDeal(thread.dealId as string)}
                  className="bg-transparent border-0 p-0 font-semibold text-primary-ink cursor-pointer hover:underline"
                >
                  · Deal: {thread.dealName}
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-[8px]">
            {canReadDeals && (
              <Select
                aria-label="Link conversation to deal"
                value={thread.dealId ?? ''}
                onChange={(e) =>
                  updateThreadMutation.mutate({
                    dealId: e.target.value ? e.target.value : null,
                  })
                }
                className="w-[210px]"
              >
                <option value="">No linked deal</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={updateThreadMutation.isPending}
              onClick={() =>
                updateThreadMutation.mutate({
                  status: thread.status === 'archived' ? 'open' : 'archived',
                })
              }
            >
              <Archive size={15} aria-hidden="true" />
              {thread.status === 'archived' ? 'Move to open' : 'Archive'}
            </Button>
          </div>
        </div>
      </Panel>

      {/* Messages */}
      <div className="space-y-[12px]">
        {messages.map((msg) => (
          <Panel key={msg.id} padded>
            <div className="flex flex-wrap items-baseline justify-between gap-[8px] pb-[10px] mb-[10px] border-b border-line">
              <div className="min-w-0 space-y-[2px]">
                <div className="flex flex-wrap items-center gap-[6px]">
                  <span className="text-[13.5px] font-semibold text-ink break-all">
                    {msg.fromEmail}
                  </span>
                  <StatusBadge tone={msg.direction === 'inbound' ? 'info' : 'neutral'}>
                    {msg.direction === 'inbound' ? 'Received' : 'Sent'}
                  </StatusBadge>
                  {msg.outboundStatus === 'failed' && (
                    <StatusBadge tone="danger">Delivery failed</StatusBadge>
                  )}
                </div>
                <div className="text-[12px] text-ink-3 break-all">
                  To: {msg.toEmails.join(', ') || '—'}
                  {msg.ccEmails.length > 0 ? ` · Cc: ${msg.ccEmails.join(', ')}` : ''}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-[8px]">
                <span className="text-[12px] text-ink-3 whitespace-nowrap tabular-nums">
                  {formatDateTime(msg.sentAt, timeZone)}
                </span>
                {canCreateTask && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setTaskModalMsg(msg);
                      setTaskTitle(`Follow up on email: ${msg.subject}`);
                    }}
                  >
                    <CheckSquare size={14} aria-hidden="true" />
                    Create task
                  </Button>
                )}
              </div>
            </div>

            {msg.errorDetail && (
              <div className="mb-[10px]">
                <Callout tone="danger">{msg.errorDetail}</Callout>
              </div>
            )}

            <SandboxedEmailBody
              subject={msg.subject}
              bodyText={msg.bodyText}
              bodyHtmlSanitized={msg.bodyHtmlSanitized}
              hasRemoteImages={msg.hasRemoteImages}
            />

            {msg.attachments.length > 0 && (
              <div className="mt-[12px] pt-[10px] border-t border-line flex flex-wrap gap-[8px]">
                {msg.attachments.map((att) => (
                  <button
                    key={att.id}
                    type="button"
                    disabled={downloadingAttId === att.id}
                    onClick={() => void handleDownloadAttachment(att)}
                    className="inline-flex items-center gap-[6px] h-[30px] px-[12px] rounded-pill bg-bg-alt border border-line text-[12.5px] font-medium text-ink cursor-pointer hover:border-primary"
                  >
                    <Paperclip size={13} aria-hidden="true" />
                    <span className="truncate max-w-[200px]">{att.filename}</span>
                    <span className="text-ink-3 tabular-nums">
                      ({formatByteSize(att.sizeBytes)})
                    </span>
                    <Download size={13} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </Panel>
        ))}
      </div>

      {/* Inline Task Creator */}
      {taskModalMsg && (
        <Panel title="Create task from email" padded>
          <form
            className="space-y-[10px]"
            onSubmit={(e) => {
              e.preventDefault();
              createTaskMutation.mutate();
            }}
          >
            <label htmlFor="email-task-title" className="block text-label text-ink-2">
              Task title
            </label>
            <Input
              id="email-task-title"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-[8px]">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={createTaskMutation.isPending || !taskTitle.trim()}
              >
                {createTaskMutation.isPending ? 'Creating…' : 'Save task'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setTaskModalMsg(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {/* Reply Composer */}
      {canSend && (
        <Panel title="Reply" padded>
          <form onSubmit={handleReplySubmit} className="space-y-[10px]">
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <label htmlFor="reply-template" className="text-label text-ink-2">
                Insert template (optional)
              </label>
              <Select
                id="reply-template"
                value={replyTemplateId}
                onChange={(e) => {
                  const id = e.target.value;
                  setReplyTemplateId(id);
                  const tpl = templates.find((t) => t.id === id);
                  if (tpl) setReplyBody(tpl.bodyText);
                }}
                className="sm:w-[260px]"
              >
                <option value="">Choose a template…</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name} ({tpl.market})
                  </option>
                ))}
              </Select>
            </div>

            <Textarea
              rows={4}
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              aria-label="Write a reply"
              placeholder="Write your reply…"
            />

            {replyMutation.isError && (
              <p role="alert" className="m-0 text-[13px] text-danger">
                {errorMessage(replyMutation.error)}
              </p>
            )}

            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                disabled={replyMutation.isPending || !replyBody.trim()}
              >
                <Send size={15} aria-hidden="true" />
                {replyMutation.isPending ? 'Sending…' : 'Send reply'}
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </div>
  );
}
