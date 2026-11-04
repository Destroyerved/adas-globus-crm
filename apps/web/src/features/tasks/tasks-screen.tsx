import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import { formatDateTime, type StatusTone } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/state-views.js';
import { api, type TaskRow } from '@/lib/api.js';
import {
  CreateForm,
  Field,
  PageHeader,
  errorMessage,
  fieldError,
  str,
  useUserNames,
} from '@/features/shared/live-kit.js';

const PRIORITY_TONE: Record<TaskRow['priority'], StatusTone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
};

/** "Today" and "Overdue" use the viewer's own time zone (PRD 4.7). */
function bucketOf(task: TaskRow, now: Date): 'overdue' | 'today' | 'upcoming' {
  const due = new Date(task.due_at);
  if (due < now) return 'overdue';
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return due <= endOfToday ? 'today' : 'upcoming';
}

const GROUPS = [
  { key: 'overdue', title: 'Overdue', tone: 'danger' },
  { key: 'today', title: 'Due today', tone: 'warning' },
  { key: 'upcoming', title: 'Upcoming', tone: 'neutral' },
] as const;

export function TasksScreen() {
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.listTasks });
  const [formOpen, setFormOpen] = useState(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const open = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.status === 'open')
        .sort((a, b) => a.due_at.localeCompare(b.due_at)),
    [tasks.data],
  );
  const now = new Date();

  const complete = useMutation({
    mutationFn: (task: TaskRow) => api.completeTask(task.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const create = useMutation({
    mutationFn: api.createTask,
    onSuccess: async () => {
      setFormOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  return (
    <div className="space-y-[16px]" data-testid="tasks-screen">
      <PageHeader
        kicker="Follow-ups"
        title="Tasks"
        count={tasks.data ? open.length : undefined}
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>New task</span>
          </Button>
        }
      />

      {formOpen && (
        <CreateForm
          title="New task"
          submitLabel="Save task"
          pending={create.isPending}
          error={create.error}
          onClose={() => setFormOpen(false)}
          onSubmit={(data) =>
            create.mutate({
              title: str(data, 'title'),
              dueAt: new Date(str(data, 'due')).toISOString(),
              priority: str(data, 'priority') as TaskRow['priority'],
            })
          }
        >
          <Field label="Task" error={fieldError(create.error, 'title')}>
            <Input name="title" required autoComplete="off" />
          </Field>
          <Field label="Due" error={fieldError(create.error, 'dueAt')}>
            <Input name="due" type="datetime-local" required />
          </Field>
          <Field label="Priority">
            <select
              name="priority"
              defaultValue="normal"
              className="h-[36px] rounded-[8px] border border-input bg-surface px-[12px] text-[14px]"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </Field>
        </CreateForm>
      )}

      {complete.isError && (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {errorMessage(complete.error)}
        </p>
      )}

      <div className="bg-surface border border-line rounded-[10px] overflow-hidden">
        {tasks.isPending && <LoadingState rows={5} />}
        {tasks.isError && (
          <ErrorState message={errorMessage(tasks.error)} onRetry={() => void tasks.refetch()} />
        )}
        {tasks.isSuccess && open.length === 0 && (
          <EmptyState
            title="No open tasks"
            description="Tasks you schedule appear here, with today’s at the top."
            actionLabel="New task"
            actionVariant="primary"
            onAction={() => setFormOpen(true)}
          />
        )}
        {tasks.isSuccess &&
          open.length > 0 &&
          GROUPS.map((group) => {
            const items = open.filter((t) => bucketOf(t, now) === group.key);
            if (items.length === 0) return null;
            return (
              <section key={group.key} aria-label={group.title}>
                <h2 className="m-0 px-[16px] pt-[16px] pb-[8px] text-eyebrow text-ink-3">
                  {group.title.toUpperCase()} · {items.length}
                </h2>
                <ul className="m-0 p-0 list-none">
                  {items.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-[12px] px-[16px] py-[10px] border-t border-line"
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={complete.isPending}
                        onClick={() => complete.mutate(t)}
                        aria-label={`Mark "${t.title}" done`}
                      >
                        <Check size={16} strokeWidth={1.6} aria-hidden="true" />
                      </Button>
                      <div className="min-w-0 flex-1">
                        <div className="text-ink">{t.title}</div>
                        <div className="text-[13px] text-ink-3">
                          {formatDateTime(t.due_at, timeZone)} · {ownerName(t.assignee_user_id)}
                        </div>
                      </div>
                      <StatusBadge
                        tone={group.key === 'overdue' ? 'danger' : PRIORITY_TONE[t.priority]}
                      >
                        {group.key === 'overdue' ? 'Overdue' : t.priority}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
      </div>
    </div>
  );
}
