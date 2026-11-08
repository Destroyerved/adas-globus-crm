import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import { formatDate } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { ConfirmDialog } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type EntityType, type TaskRow } from '@/lib/api.js';
import { errorMessage, useUserNames } from '@/features/shared/live-kit.js';
import { viewerTimeZone } from './timeline.js';

/** Building blocks shared by the lead, contact, company and deal pages (DESIGN 6.9). */

export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-[6px] bg-transparent border-0 p-0 text-[14px] font-semibold text-primary-ink cursor-pointer hover:underline"
    >
      <ArrowLeft size={16} strokeWidth={1.6} aria-hidden="true" />
      {label}
    </button>
  );
}

/** Loading and error states for a profile page, with the back link kept visible. */
export function ProfileStatus({
  back,
  query,
}: {
  back: ReactNode;
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
}) {
  return (
    <div className="space-y-[16px]">
      {back}
      <div className="bg-surface border border-line rounded-[10px]">
        {query.isPending ? (
          <LoadingState rows={6} />
        ) : (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        )}
      </div>
    </div>
  );
}

export function ProfileHeader({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
      <div className="min-w-0">
        <div className="text-eyebrow text-ink-3 mb-[4px]">{eyebrow}</div>
        <h1 className="text-title-lg text-ink m-0 break-words">{title}</h1>
        {meta && (
          <div className="mt-[6px] flex flex-wrap items-center gap-[8px] text-[14px] text-ink-2">
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-[8px]">{actions}</div>}
    </header>
  );
}

/** Label and value pairs; empty values show a dash so the layout stays steady. */
export function DetailList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="m-0 grid gap-x-[16px] gap-y-[10px] sm:grid-cols-[160px_minmax(0,1fr)]">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[13px] text-ink-3">{label}</dt>
          <dd className="m-0 text-[14px] text-ink break-words">
            {value === null || value === undefined || value === '' ? '—' : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function TwoColumn({ main, aside }: { main: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid gap-[16px] lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-[16px] min-w-0">{main}</div>
      <aside className="space-y-[16px] min-w-0">{aside}</aside>
    </div>
  );
}

type TaskLink = { companyId?: string; contactId?: string; leadId?: string; dealId?: string };

/** Open tasks for a record, with "mark done" and a quick add form (PRD 4.7). */
export function TasksPanel({
  tasks,
  link,
  canWrite,
  queryKeys,
}: {
  tasks: TaskRow[];
  link: TaskLink;
  canWrite: boolean;
  queryKeys: readonly (readonly unknown[])[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const ownerName = useUserNames();
  const timeZone = viewerTimeZone();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  const refresh = () =>
    Promise.all(
      [...queryKeys, ['tasks']].map((key) => queryClient.invalidateQueries({ queryKey: key })),
    );

  const add = useMutation({
    mutationFn: () =>
      api.createTask({
        title: title.trim(),
        dueAt: new Date(`${due}T09:00:00`).toISOString(),
        ...link,
      }),
    onSuccess: async () => {
      setTitle('');
      setDue('');
      toast('Task added.');
      await refresh();
    },
  });

  const complete = useMutation({
    mutationFn: (task: TaskRow) => api.completeTask(task.id),
    onSuccess: async (_row, task) => {
      toast(`Marked "${task.title}" done.`);
      await refresh();
    },
  });

  return (
    <Panel title={`Open tasks (${tasks.length})`} padded>
      {tasks.length === 0 && <p className="m-0 text-[14px] text-ink-2">No open tasks.</p>}
      <ul className="m-0 p-0 list-none space-y-[8px]">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-[8px] text-[14px]">
            {canWrite && (
              <Button
                variant="ghost"
                size="icon"
                disabled={complete.isPending}
                onClick={() => complete.mutate(t)}
                aria-label={`Mark "${t.title}" done`}
              >
                <Check size={16} strokeWidth={1.6} aria-hidden="true" />
              </Button>
            )}
            <div className="min-w-0">
              <div className="text-ink">{t.title}</div>
              <div
                className={`text-[13px] ${Date.parse(t.due_at) < Date.now() ? 'text-danger' : 'text-ink-3'}`}
              >
                Due {formatDate(t.due_at, timeZone)} · {ownerName(t.assignee_user_id)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {complete.isError && (
        <p role="alert" className="m-0 mt-[8px] text-[13px] text-danger">
          {errorMessage(complete.error)}
        </p>
      )}
      {canWrite && (
        <form
          className="mt-[12px] grid gap-[8px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && due) add.mutate();
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New task"
            aria-label="New task title"
            required
          />
          <Input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Due date"
            required
          />
          {add.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(add.error)}
            </p>
          )}
          <Button type="submit" variant="outline" size="sm" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add task'}
          </Button>
        </form>
      )}
    </Panel>
  );
}

/** "Delete" with a confirmation; records are soft-deleted and audited (PRD 9). */
export function DeleteRecordButton({
  entityType,
  entityId,
  name,
  onDeleted,
}: {
  entityType: EntityType;
  entityId: string;
  name: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteRecord(entityType, entityId),
    onSuccess: async () => {
      setOpen(false);
      toast(`Deleted ${name}.`);
      await queryClient.invalidateQueries();
      onDeleted();
    },
  });
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        title={`Delete ${entityType} ${name}?`}
        body={`${name} disappears from lists and search, and its open tasks are cancelled. The deletion is recorded in the audit log.`}
        confirmLabel={`Delete ${entityType}`}
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          setOpen(false);
          remove.reset();
        }}
      />
    </>
  );
}
