import { useMemo, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatRelative, formatTime } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type EntityType, type TimelineItem } from '@/lib/api.js';
import { SandboxedEmailBody } from '@/features/inbox/sandboxed-email-body.js';
import { errorMessage, fieldError } from '@/features/shared/live-kit.js';
import { useMe } from '@/features/shared/list-kit.js';

/**
 * Record timeline (PRD 3.4, 4.3-4.7; DESIGN 6.10): notes, logged calls, meetings and emails,
 * and status or stage changes, newest first and grouped by day. Logging happens here too.
 */

type Composer = 'note' | 'call' | 'meeting' | 'email_logged';

const COMPOSERS: { id: Composer; label: string; submit: string; placeholder: string }[] = [
  { id: 'note', label: 'Note', submit: 'Add note', placeholder: 'Write a note for the team' },
  {
    id: 'call',
    label: 'Call',
    submit: 'Log call',
    placeholder: 'What was said, and what happens next?',
  },
  {
    id: 'meeting',
    label: 'Meeting',
    submit: 'Log meeting',
    placeholder: 'Who was there and what was agreed?',
  },
  {
    id: 'email_logged',
    label: 'Email',
    submit: 'Log email',
    placeholder: 'Summarise the email you sent or received',
  },
];

const CALL_OUTCOMES = [
  'Connected',
  'Left voicemail',
  'No answer',
  'Wrong number',
  'Asked to call back',
];

export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function dayLabel(at: string, timeZone: string): string {
  const day = formatDate(at, timeZone);
  if (day === formatDate(new Date(), timeZone)) return 'Today';
  if (day === formatDate(new Date(Date.now() - 86_400_000), timeZone)) return 'Yesterday';
  return day;
}

export function Timeline({
  entityType,
  entityId,
  canWrite,
  onChanged,
}: {
  entityType: EntityType;
  entityId: string;
  canWrite: boolean;
  /** Called after something is logged, so the page can refresh status or "last contacted". */
  onChanged?: () => void;
}) {
  const timeZone = viewerTimeZone();
  const key = ['timeline', entityType, entityId] as const;
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.timeline(entityType, entityId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const groups = useMemo(() => {
    const out: { label: string; items: TimelineItem[] }[] = [];
    for (const item of items) {
      const label = dayLabel(item.at, timeZone);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item);
      else out.push({ label, items: [item] });
    }
    return out;
  }, [items, timeZone]);

  return (
    <div className="space-y-[16px]">
      {canWrite && (
        <TimelineComposer entityType={entityType} entityId={entityId} onLogged={onChanged} />
      )}
      {query.isPending && <LoadingState rows={4} />}
      {query.isError && (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}
      {query.isSuccess && items.length === 0 && (
        <p className="m-0 text-ink-2">Nothing has happened here yet.</p>
      )}
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="m-0 mb-[8px] text-eyebrow text-ink-3">{group.label}</h3>
          <ol className="m-0 p-0 list-none border-l border-line ml-[4px]">
            {group.items.map((item) => (
              <TimelineEntry
                key={`${item.source}-${item.id}`}
                item={item}
                timeZone={timeZone}
                entityType={entityType}
                entityId={entityId}
              />
            ))}
          </ol>
        </section>
      ))}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </Button>
      )}
    </div>
  );
}

function TimelineComposer({
  entityType,
  entityId,
  onLogged,
}: {
  entityType: EntityType;
  entityId: string;
  onLogged?: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<Composer>('note');
  const [detail, setDetail] = useState('');
  const [outcome, setOutcome] = useState('');
  const composer = COMPOSERS.find((c) => c.id === mode) ?? COMPOSERS[0];

  const save = useMutation({
    mutationFn: async () => {
      if (mode === 'note') {
        await api.createNote({ entityType, entityId, body: detail.trim() });
        return;
      }
      await api.logActivity({
        activityType: mode,
        entityType,
        entityId,
        detail: detail.trim(),
        outcome: mode === 'call' && outcome ? outcome : undefined,
      });
    },
    onSuccess: async () => {
      setDetail('');
      setOutcome('');
      toast(mode === 'note' ? 'Note added.' : `${composer?.label ?? 'Activity'} logged.`);
      await queryClient.invalidateQueries({ queryKey: ['timeline', entityType, entityId] });
      onLogged?.();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'note' && !detail.trim()) return;
    save.mutate();
  };

  return (
    <form onSubmit={submit} aria-label="Add to timeline" className="space-y-[8px]">
      <div role="radiogroup" aria-label="What to add" className="flex flex-wrap gap-[6px]">
        {COMPOSERS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={mode === c.id}
            onClick={() => {
              setMode(c.id);
              save.reset();
            }}
            className={`h-[30px] px-[12px] rounded-pill text-[13px] font-semibold border cursor-pointer ${mode === c.id ? 'bg-tint text-primary-ink border-primary' : 'bg-surface text-ink-2 border-line hover:bg-bg-alt'}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <Textarea
        rows={3}
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder={composer?.placeholder}
        aria-label={composer?.placeholder ?? 'Details'}
        invalid={Boolean(fieldError(save.error, mode === 'note' ? 'body' : 'detail'))}
      />
      <div className="flex flex-wrap items-center gap-[8px]">
        {mode === 'call' && (
          <Select
            aria-label="Call outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            className="sm:w-[200px]"
          >
            <option value="">Outcome (optional)</option>
            {CALL_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        )}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={save.isPending || (mode === 'note' && !detail.trim())}
        >
          {save.isPending ? 'Saving…' : composer?.submit}
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(save.error)}
        </p>
      )}
    </form>
  );
}

function TimelineEntry({
  item,
  timeZone,
  entityType,
  entityId,
}: {
  item: TimelineItem;
  timeZone: string;
  entityType: EntityType;
  entityId: string;
}) {
  const me = useMe();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [expandedEmail, setExpandedEmail] = useState(false);
  const [body, setBody] = useState(item.detail);
  const isEmail = item.source === 'email';
  const isUserAction = item.source === 'note' || isEmail || item.actor_user_id !== null;
  const canEditNote = item.source === 'note' && me?.id === item.actor_user_id;
  const version = Number(item.metadata['version'] ?? 1);
  const edited =
    item.source === 'note' &&
    typeof item.metadata['updatedAt'] === 'string' &&
    Date.parse(item.metadata['updatedAt']) - Date.parse(item.at) > 1000;

  const emailDirection = item.metadata['direction'] === 'inbound' ? 'inbound' : 'outbound';
  const emailOutboundStatus = String(item.metadata['outboundStatus'] ?? 'sent');
  const emailHtmlSanitized =
    typeof item.metadata['bodyHtmlSanitized'] === 'string' && item.metadata['bodyHtmlSanitized']
      ? item.metadata['bodyHtmlSanitized']
      : null;
  const emailLong =
    isEmail &&
    (Boolean(emailHtmlSanitized) || item.detail.split('\n').length > 4 || item.detail.length > 220);

  const save = useMutation({
    mutationFn: () => api.updateNote(item.id, { version, body: body.trim() }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['timeline', entityType, entityId] });
    },
  });

  return (
    <li className="relative pl-[20px] pb-[16px]">
      <span
        aria-hidden="true"
        className={`absolute left-[-5px] top-[6px] h-[9px] w-[9px] rounded-full ${isUserAction ? 'timeline-dot-user' : 'bg-line-strong'}`}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-[8px] gap-y-[4px]">
        <div className="flex flex-wrap items-center gap-[6px]">
          <span className="font-semibold text-ink">{item.title}</span>
          {isEmail && (
            <StatusBadge tone={emailDirection === 'inbound' ? 'info' : 'neutral'}>
              {emailDirection === 'inbound' ? 'Email received' : 'Email sent'}
            </StatusBadge>
          )}
          {isEmail && emailOutboundStatus === 'failed' && (
            <StatusBadge tone="danger">Delivery failed</StatusBadge>
          )}
        </div>
        <span className="text-[13px] text-ink-3 whitespace-nowrap" title={formatRelative(item.at)}>
          {formatTime(item.at, timeZone)}
        </span>
      </div>
      <div className="text-[12.5px] text-ink-3">
        {item.actor_name ?? 'System'}
        {typeof item.metadata['outcome'] === 'string' && item.metadata['outcome']
          ? ` · ${item.metadata['outcome']}`
          : ''}
        {edited ? ' · edited' : ''}
      </div>
      {editing ? (
        <form
          className="mt-[6px] space-y-[6px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) save.mutate();
          }}
        >
          <Textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Edit note"
          />
          {save.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(save.error)}
            </p>
          )}
          <div className="flex gap-[8px]">
            <Button type="submit" variant="primary" size="sm" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save note'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setBody(item.detail);
                save.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : isEmail && expandedEmail ? (
        <div className="mt-[6px] p-[10px] rounded-[8px] bg-bg-alt border border-line">
          <SandboxedEmailBody
            subject={item.title}
            bodyText={item.detail}
            bodyHtmlSanitized={emailHtmlSanitized}
            hasRemoteImages={
              emailHtmlSanitized ? emailHtmlSanitized.includes('data-remote-url=') : false
            }
          />
        </div>
      ) : (
        item.detail && (
          <p
            className={`m-0 mt-[2px] text-[13.5px] text-ink-2 whitespace-pre-line break-words ${
              emailLong ? 'line-clamp-4' : ''
            }`}
          >
            {item.detail}
          </p>
        )
      )}
      {isEmail && emailLong && (
        <button
          type="button"
          onClick={() => setExpandedEmail((v) => !v)}
          className="mt-[4px] bg-transparent border-0 p-0 text-[12.5px] font-semibold text-primary-ink cursor-pointer hover:underline"
        >
          {expandedEmail ? 'Collapse email' : 'Show full email'}
        </button>
      )}
      {canEditNote && !editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-[2px] bg-transparent border-0 p-0 text-[12.5px] font-semibold text-primary-ink cursor-pointer hover:underline"
        >
          Edit note
        </button>
      )}
    </li>
  );
}
