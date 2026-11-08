import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import {
  TaskTypeSchema,
  UpdateTaskInputSchema,
  formatDateTime,
  formatRelative,
  type StatusTone,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Select, Textarea } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type TaskRow } from '@/lib/api.js';
import {
  CreateForm,
  DataPanel,
  Field,
  PageHeader,
  SearchBox,
  errorMessage,
  fieldError,
  str,
} from '@/features/shared/live-kit.js';
import {
  ListFooter,
  OwnerFilter,
  Toolbar,
  UserSelect,
  allOf,
  can,
  useMe,
  usePagedList,
  useSearchText,
  useUrlState,
} from '@/features/shared/list-kit.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import {
  EditDrawer,
  changedFields,
  formError,
  issuesOf,
  serverFieldErrors,
} from '@/features/records/record-form.js';

const PRIORITY_TONE: Record<TaskRow['priority'], StatusTone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
};

export const TASK_TYPE_LABEL: Record<string, string> = {
  call: 'Call',
  email: 'Email',
  follow_up: 'Follow-up',
  meeting: 'Meeting',
  research: 'Research',
  proposal: 'Proposal',
  internal: 'Internal',
  trial_checkin: 'Trial check-in',
  sla_first_response: 'First response',
};

const VIEWS = [
  { id: 'open', label: 'Open' },
  { id: 'today', label: 'Today' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'done', label: 'Done' },
] as const;

const DEFAULTS = { view: 'open', q: '', assignee: '@me' };

/** Local date-time text for a datetime-local input, in the browser's zone. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TasksScreen({
  onOpenRecord,
}: {
  onOpenRecord: (screen: 'company' | 'contact' | 'lead' | 'deal', id: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const [state, setState] = useUrlState(DEFAULTS);
  const [search, setSearch] = useSearchText(state.q, (q) => setState({ q }));
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TaskRow | null>(null);

  const filter = allOf([
    state.assignee !== '' && { field: 'assigneeId', op: 'eq', value: state.assignee },
  ]);
  const sort = state.view === 'done' ? '-completedAt' : 'dueAt';
  const { query, items, total } = usePagedList(
    ['tasks', { view: state.view, q: state.q, filter, sort }],
    (cursor) => api.listTasks({ view: state.view, q: state.q, filter, sort, cursor, limit: 50 }),
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tasks'] });
  const complete = useMutation({
    mutationFn: (task: TaskRow) => api.completeTask(task.id),
    onSuccess: async (_row, task) => {
      toast(`Marked "${task.title}" done.`);
      await refresh();
    },
    onError: (err) => toast(errorMessage(err), 'danger'),
  });

  const create = useMutation({
    mutationFn: api.createTask,
    onSuccess: async () => {
      setFormOpen(false);
      toast('Task added.');
      await refresh();
    },
  });

  const canWrite = can(me, 'tasks.write');
  const filtered = state.q !== '' || state.assignee !== '@me';
  const now = Date.now();
  const timeZone = viewerTimeZone();

  return (
    <div className="space-y-[16px]" data-testid="tasks-screen">
      <PageHeader
        kicker="Follow-ups"
        title="Tasks"
        count={total}
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setFormOpen(true)}>
              <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
              <span>New task</span>
            </Button>
          ) : undefined
        }
      />

      {formOpen && (
        <CreateForm
          title="New task"
          submitLabel="Save task"
          pending={create.isPending}
          error={create.error}
          onClose={() => setFormOpen(false)}
          onSubmit={(data) => {
            const due = str(data, 'due');
            const reminder = str(data, 'reminder');
            create.mutate({
              title: str(data, 'title'),
              dueAt: due ? new Date(due).toISOString() : '',
              priority: str(data, 'priority') as TaskRow['priority'],
              taskType: str(data, 'taskType'),
              assigneeUserId: str(data, 'assignee') || undefined,
              reminderAt: reminder ? new Date(reminder).toISOString() : null,
            });
          }}
        >
          <Field label="Task" error={fieldError(create.error, 'title')}>
            <Input name="title" required autoComplete="off" />
          </Field>
          <Field label="Due" error={fieldError(create.error, 'dueAt')}>
            <Input name="due" type="datetime-local" required />
          </Field>
          <Field label="Type">
            <Select name="taskType" defaultValue="follow_up">
              {TaskTypeSchema.options.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABEL[t] ?? t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select name="priority" defaultValue="normal">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </Select>
          </Field>
          <Field label="Assignee" error={fieldError(create.error, 'assigneeUserId')}>
            <AssigneeSelect name="assignee" defaultValue={me?.id ?? ''} />
          </Field>
          <Field label="Remind me" optional error={fieldError(create.error, 'reminderAt')}>
            <Input name="reminder" type="datetime-local" />
          </Field>
        </CreateForm>
      )}

      <div
        role="tablist"
        aria-label="Task views"
        className="flex gap-[20px] border-b border-line overflow-x-auto"
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={state.view === v.id}
            className="view-tab"
            onClick={() => setState({ view: v.id })}
          >
            {v.label}
          </button>
        ))}
      </div>

      <Toolbar>
        <SearchBox value={search} onChange={setSearch} label="Search task or record" />
        <div className="flex flex-wrap gap-[8px]">
          <OwnerFilter
            label="Assignee"
            value={state.assignee}
            onChange={(assignee) => setState({ assignee })}
          />
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                setState({ q: '', assignee: '@me' });
              }}
            >
              Reset filters
            </Button>
          )}
        </div>
      </Toolbar>

      <DataPanel
        query={{ ...query, isFetching: query.isFetching && !query.isFetchingNextPage }}
        isEmpty={items.length === 0}
        emptyTitle={
          state.view === 'done'
            ? 'Nothing completed yet'
            : state.view === 'overdue'
              ? 'Nothing overdue'
              : 'No open tasks'
        }
        emptyDescription={
          filtered
            ? 'Try another assignee, or clear the search.'
            : 'Tasks you schedule appear here, soonest first.'
        }
        emptyActionLabel={canWrite && state.view !== 'done' ? 'New task' : undefined}
        onEmptyAction={() => setFormOpen(true)}
        footer={
          <ListFooter
            noun="tasks"
            shown={items.length}
            total={total}
            hasMore={query.hasNextPage}
            loading={query.isFetchingNextPage}
            onMore={() => void query.fetchNextPage()}
          />
        }
      >
        <ul className="m-0 p-0 list-none">
          {items.map((t) => {
            const overdue = t.status === 'open' && Date.parse(t.due_at) < now;
            const related = t.deal_id
              ? { screen: 'deal' as const, id: t.deal_id, name: t.deal_name }
              : t.contact_id
                ? { screen: 'contact' as const, id: t.contact_id, name: t.contact_name }
                : t.lead_id
                  ? { screen: 'lead' as const, id: t.lead_id, name: t.lead_name }
                  : t.company_id
                    ? { screen: 'company' as const, id: t.company_id, name: t.company_name }
                    : null;
            return (
              <li
                key={t.id}
                className="flex items-center gap-[12px] px-[16px] py-[10px] border-b border-line last:border-b-0"
              >
                {t.status === 'open' && canWrite ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={complete.isPending}
                    onClick={() => complete.mutate(t)}
                    aria-label={`Mark "${t.title}" done`}
                  >
                    <Check size={16} strokeWidth={1.6} aria-hidden="true" />
                  </Button>
                ) : (
                  <span className="w-[32px] shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setEditing(t)}
                    className="bg-transparent border-0 p-0 text-left text-ink hover:underline cursor-pointer"
                  >
                    {t.title}
                  </button>
                  <div className="text-[13px] text-ink-3 flex flex-wrap gap-x-[6px]">
                    <span>{TASK_TYPE_LABEL[t.task_type] ?? t.task_type}</span>
                    <span>
                      ·{' '}
                      {t.status === 'completed' && t.completed_at
                        ? `Done ${formatRelative(t.completed_at)}`
                        : formatDateTime(t.due_at, timeZone)}
                    </span>
                    <span>· {t.assignee_name ?? '—'}</span>
                    {related && related.name && (
                      <button
                        type="button"
                        onClick={() => onOpenRecord(related.screen, related.id)}
                        className="bg-transparent border-0 p-0 text-[13px] font-semibold text-primary-ink cursor-pointer hover:underline"
                      >
                        · {related.name}
                      </button>
                    )}
                  </div>
                  {t.outcome && <div className="text-[13px] text-ink-2 mt-[2px]">{t.outcome}</div>}
                </div>
                {overdue ? (
                  <StatusBadge tone="danger">Overdue</StatusBadge>
                ) : t.status === 'open' ? (
                  <StatusBadge tone={PRIORITY_TONE[t.priority]}>{t.priority}</StatusBadge>
                ) : (
                  <StatusBadge tone="success">Done</StatusBadge>
                )}
              </li>
            );
          })}
        </ul>
      </DataPanel>

      {editing && (
        <TaskDrawer
          task={editing}
          canWrite={canWrite}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function AssigneeSelect({ name, defaultValue }: { name: string; defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <>
      <input type="hidden" name={name} value={value} />
      <UserSelect label="Assignee" value={value} onChange={setValue} />
    </>
  );
}

/** Edit a task, complete it with an outcome, or cancel it (PRD 4.7). */
function TaskDrawer({
  task,
  canWrite,
  onClose,
  onSaved,
}: {
  task: TaskRow;
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const initial = {
    title: task.title,
    taskType: task.task_type,
    priority: task.priority,
    dueAt: toLocalInput(task.due_at),
    reminderAt: toLocalInput(task.reminder_at),
    assigneeUserId: task.assignee_user_id,
  };
  const [values, setValues] = useState(initial);
  const [outcome, setOutcome] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof initial, value: string) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.updateTask(task.id, payload as Record<string, unknown> & { version: number }),
    onSuccess: () => {
      toast('Task saved.');
      onSaved();
    },
  });
  const complete = useMutation({
    mutationFn: () => api.completeTask(task.id, outcome.trim() || undefined),
    onSuccess: () => {
      toast(`Marked "${task.title}" done.`);
      onSaved();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.updateTask(task.id, { version: task.version, status: 'cancelled' }),
    onSuccess: () => {
      toast('Task cancelled.');
      onSaved();
    },
  });
  const errors = { ...clientErrors, ...serverFieldErrors(save.error) };
  const open = task.status === 'open';

  const submit = () => {
    if (!canWrite || !open) {
      onClose();
      return;
    }
    const diff = changedFields(initial, values);
    const payload: Record<string, unknown> = { version: task.version };
    for (const [key, value] of Object.entries(diff)) {
      if (key === 'dueAt') payload[key] = value ? new Date(String(value)).toISOString() : undefined;
      else if (key === 'reminderAt')
        payload[key] = value ? new Date(String(value)).toISOString() : null;
      else payload[key] = value;
    }
    const issues = issuesOf(UpdateTaskInputSchema, payload);
    setClientErrors(issues);
    if (Object.keys(issues).length > 0) return;
    if (Object.keys(payload).length === 1) {
      onClose();
      return;
    }
    save.mutate(payload);
  };

  const editable = canWrite && open;
  return (
    <EditDrawer
      title={editable ? 'Edit task' : task.title}
      description={task.status === 'completed' ? 'Completed' : undefined}
      formId="task-edit-form"
      pending={save.isPending}
      error={formError(save.error) ?? (complete.isError ? errorMessage(complete.error) : null)}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={editable ? 'Save changes' : 'Close'}
    >
      <Field label="Task" error={errors['title']}>
        <Input
          value={values.title}
          disabled={!editable}
          onChange={(e) => set('title', e.target.value)}
        />
      </Field>
      <div className="grid gap-[12px] sm:grid-cols-2">
        <Field label="Due" error={errors['dueAt']}>
          <Input
            type="datetime-local"
            value={values.dueAt}
            disabled={!editable}
            onChange={(e) => set('dueAt', e.target.value)}
          />
        </Field>
        <Field label="Remind me" optional error={errors['reminderAt']}>
          <Input
            type="datetime-local"
            value={values.reminderAt}
            disabled={!editable}
            onChange={(e) => set('reminderAt', e.target.value)}
          />
        </Field>
        <Field label="Type">
          <Select
            value={values.taskType}
            disabled={!editable}
            onChange={(e) => set('taskType', e.target.value)}
          >
            {TaskTypeSchema.options.map((t) => (
              <option key={t} value={t}>
                {TASK_TYPE_LABEL[t] ?? t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select
            value={values.priority}
            disabled={!editable}
            onChange={(e) => set('priority', e.target.value)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </Field>
      </div>
      {editable && (
        <Field label="Assignee" error={errors['assigneeUserId']}>
          <UserSelect
            label="Assignee"
            value={values.assigneeUserId}
            onChange={(v) => set('assigneeUserId', v)}
          />
        </Field>
      )}
      {editable && (
        <div className="border-t border-line pt-[14px] grid gap-[8px]">
          <Field label="Outcome" optional>
            <Textarea
              rows={2}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="What happened? This goes on the record's timeline."
            />
          </Field>
          <div className="flex flex-wrap gap-[8px]">
            <Button
              variant="outline"
              size="sm"
              disabled={complete.isPending}
              onClick={() => complete.mutate()}
            >
              {complete.isPending ? 'Saving…' : 'Mark done'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel task
            </Button>
          </div>
          {cancel.isError && (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {errorMessage(cancel.error)}
            </p>
          )}
        </div>
      )}
      {task.outcome && (
        <Field label="Outcome">
          <p className="m-0 text-[14px] font-normal text-ink-2 whitespace-pre-line">
            {task.outcome}
          </p>
        </Field>
      )}
    </EditDrawer>
  );
}
