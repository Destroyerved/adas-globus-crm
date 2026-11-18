import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MONTH_SHORT, formatDate, formatNumber, formatTime } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { api, type TaskRow } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { allOf } from '@/features/shared/list-kit.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function ymdInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseYmd(ymd: string): { year: number; month: number; day: number } {
  const [y, m, d] = ymd.split('-').map(Number);
  return { year: y || 2026, month: m || 1, day: d || 1 };
}

function addDaysYmd(ymd: string, deltaDays: number): string {
  const { year, month, day } = parseYmd(ymd);
  const dt = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addMonthsYmd(ymd: string, deltaMonths: number): string {
  const { year, month } = parseYmd(ymd);
  const dt = new Date(Date.UTC(year, month - 1 + deltaMonths, 1, 12, 0, 0));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-01`;
}

/** ISO weekday where Monday = 0 .. Sunday = 6. */
function isoWeekdayIndex(ymd: string): number {
  const { year, month, day } = parseYmd(ymd);
  const jsDay = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
  return (jsDay + 6) % 7;
}

/** Approximate start-of-day UTC instant for `ymd` in `timeZone`. */
function startOfDayUtcIso(ymd: string, timeZone: string): string {
  const { year, month, day } = parseYmd(ymd);
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(guess));
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );
  const offsetMs = asUtc - guess;
  return new Date(guess - offsetMs).toISOString();
}

export function TasksCalendar({
  mode,
  onModeChange,
  assignee,
  taskType,
  q,
  statusView,
  timeZone,
  canWrite,
  onNewTask,
  onSelectTask,
}: {
  mode: 'week' | 'month';
  onModeChange: (mode: 'week' | 'month') => void;
  assignee: string;
  taskType: string;
  q: string;
  statusView: string;
  timeZone: string;
  canWrite: boolean;
  onNewTask: () => void;
  onSelectTask: (task: TaskRow) => void;
}) {
  const todayYmd = useMemo(() => ymdInZone(new Date(), timeZone), [timeZone]);
  const [anchorYmd, setAnchorYmd] = useState(todayYmd);

  const { days, rangeLabelText, focusMonth } = useMemo(() => {
    if (mode === 'week') {
      const start = addDaysYmd(anchorYmd, -isoWeekdayIndex(anchorYmd));
      const list = Array.from({ length: 7 }, (_, idx) => addDaysYmd(start, idx));
      const end = list[6] ?? start;
      const startDate = new Date(`${start}T12:00:00Z`);
      const endDate = new Date(`${end}T12:00:00Z`);
      return {
        days: list,
        rangeLabelText: `${formatDate(startDate, 'UTC')} – ${formatDate(endDate, 'UTC')}`,
        focusMonth: null as number | null,
      };
    }

    const { year, month } = parseYmd(anchorYmd);
    const pad = (n: number) => String(n).padStart(2, '0');
    const firstOfMonth = `${year}-${pad(month)}-01`;
    const gridStart = addDaysYmd(firstOfMonth, -isoWeekdayIndex(firstOfMonth));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastOfMonth = `${year}-${pad(month)}-${pad(daysInMonth)}`;
    const trailing = 6 - isoWeekdayIndex(lastOfMonth);
    const totalCells = isoWeekdayIndex(firstOfMonth) + daysInMonth + trailing;
    const list = Array.from({ length: totalCells }, (_, idx) => addDaysYmd(gridStart, idx));
    const monthName = MONTH_SHORT[month - 1] ?? '';
    return {
      days: list,
      rangeLabelText: `${monthName} ${year}`,
      focusMonth: month,
    };
  }, [anchorYmd, mode]);

  const firstDay = days[0] ?? todayYmd;
  const afterLastDay = addDaysYmd(days[days.length - 1] ?? todayYmd, 1);
  const startIso = useMemo(() => startOfDayUtcIso(firstDay, timeZone), [firstDay, timeZone]);
  const endIso = useMemo(() => startOfDayUtcIso(afterLastDay, timeZone), [afterLastDay, timeZone]);

  const statusFilter = statusView === 'done' ? 'completed' : 'open';
  const filter = allOf([
    assignee !== '' && { field: 'assigneeId', op: 'eq', value: assignee },
    taskType !== '' && { field: 'taskType', op: 'eq', value: taskType },
    { field: 'status', op: 'eq', value: statusFilter },
    { field: 'dueAt', op: 'between', value: [startIso, endIso] },
  ]);

  const calendarViewParam = statusView === 'team' ? 'team' : 'all';
  const query = useQuery({
    queryKey: ['tasks', 'calendar', { view: calendarViewParam, q, filter }],
    queryFn: () =>
      api.listTasks({
        view: calendarViewParam,
        q,
        filter,
        sort: 'dueAt',
        limit: 200,
      }),
  });

  const tasksByDay = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    for (const item of query.data?.items ?? []) {
      const key = ymdInZone(new Date(item.due_at), timeZone);
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [query.data, timeZone]);

  const stepPrev = () =>
    setAnchorYmd((prev) => (mode === 'week' ? addDaysYmd(prev, -7) : addMonthsYmd(prev, -1)));
  const stepNext = () =>
    setAnchorYmd((prev) => (mode === 'week' ? addDaysYmd(prev, 7) : addMonthsYmd(prev, 1)));

  const nowMs = Date.now();
  const totalInWindow = query.data?.items.length ?? 0;

  return (
    <div
      data-testid="tasks-calendar"
      className="bg-surface border border-line rounded-[10px] overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-[10px] px-[16px] py-[12px] border-b border-line">
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button
            variant="ghost"
            size="icon"
            onClick={stepPrev}
            aria-label={mode === 'week' ? 'Previous week' : 'Previous month'}
          >
            <ChevronLeft size={16} strokeWidth={1.6} aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAnchorYmd(todayYmd)}>
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={stepNext}
            aria-label={mode === 'week' ? 'Next week' : 'Next month'}
          >
            <ChevronRight size={16} strokeWidth={1.6} aria-hidden="true" />
          </Button>
          <h2 className="m-0 ml-[4px] text-[15px] font-semibold text-ink tabular-nums">
            {rangeLabelText}
          </h2>
        </div>

        <div
          role="group"
          aria-label="Calendar range"
          className="inline-flex rounded-pill border border-line-strong p-[2px] bg-bg-alt"
        >
          {(['week', 'month'] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={active}
                onClick={() => onModeChange(m)}
                className={`px-[12px] h-[28px] rounded-pill text-[13px] font-medium border-0 cursor-pointer transition-colors ${
                  active ? 'bg-primary text-primary-foreground' : 'bg-transparent text-ink-2'
                }`}
              >
                {m === 'week' ? 'Week' : 'Month'}
              </button>
            );
          })}
        </div>
      </div>

      {query.isPending && <LoadingState rows={5} />}
      {query.isError && (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      )}

      {!query.isPending && !query.isError && (
        <>
          {/* Desktop 7-column calendar grid */}
          <div className="hidden md:block">
            <div className="grid grid-cols-7 border-b border-line bg-bg-alt">
              {WEEKDAYS.map((dayName) => (
                <div
                  key={dayName}
                  className="px-[10px] py-[8px] text-label text-ink-3 border-r border-line last:border-r-0"
                >
                  {dayName}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((ymd, idx) => {
                const { month, day } = parseYmd(ymd);
                const outsideMonth = focusMonth !== null && month !== focusMonth;
                const isToday = ymd === todayYmd;
                const dayTasks = tasksByDay.get(ymd) ?? [];
                return (
                  <div
                    key={ymd}
                    className={`min-h-[116px] p-[8px] border-b border-line ${
                      idx % 7 !== 6 ? 'border-r border-line' : ''
                    } ${outsideMonth ? 'bg-bg-alt' : 'bg-surface'}`}
                  >
                    <div className="flex items-center justify-between gap-[4px] mb-[6px]">
                      <span
                        className={`inline-flex items-center justify-center min-w-[24px] h-[24px] px-[6px] rounded-pill text-[12.5px] font-semibold tabular-nums ${
                          isToday
                            ? 'bg-primary text-primary-foreground'
                            : outsideMonth
                              ? 'text-ink-3'
                              : 'text-ink'
                        }`}
                      >
                        {day}
                      </span>
                      {dayTasks.length > 0 && (
                        <span className="text-[11.5px] text-ink-3 tabular-nums">
                          {formatNumber(dayTasks.length)}
                        </span>
                      )}
                    </div>
                    <ul className="m-0 p-0 list-none space-y-[4px]">
                      {dayTasks.slice(0, 4).map((t) => {
                        const overdue = t.status === 'open' && Date.parse(t.due_at) < nowMs;
                        return (
                          <li key={t.id}>
                            <button
                              type="button"
                              onClick={() => onSelectTask(t)}
                              className={`w-full text-left px-[6px] py-[4px] rounded-[6px] border text-[12px] leading-[16px] cursor-pointer truncate block ${
                                overdue
                                  ? 'bg-danger-bg border-danger text-danger font-medium'
                                  : t.status === 'completed'
                                    ? 'bg-success-bg border-line text-success'
                                    : 'bg-tint border-line text-ink hover:border-primary'
                              }`}
                              title={`${formatTime(t.due_at, timeZone)} · ${t.title}`}
                            >
                              <span className="tabular-nums font-semibold">
                                {formatTime(t.due_at, timeZone)}
                              </span>{' '}
                              <span>{t.title}</span>
                            </button>
                          </li>
                        );
                      })}
                      {dayTasks.length > 4 && (
                        <li className="text-[11.5px] text-ink-3 px-[4px]">
                          +{formatNumber(dayTasks.length - 4)} more
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile agenda view (375px-safe, zero horizontal scroll) */}
          <div className="md:hidden">
            {totalInWindow === 0 ? (
              <EmptyState
                title="No tasks in this period"
                description="Step to another date range or schedule a new follow-up."
                actionLabel={canWrite && statusView !== 'done' ? 'New task' : undefined}
                onAction={canWrite && statusView !== 'done' ? onNewTask : undefined}
              />
            ) : (
              <div className="divide-y divide-line">
                {days
                  .filter((ymd) => (tasksByDay.get(ymd)?.length ?? 0) > 0)
                  .map((ymd) => {
                    const dayTasks = tasksByDay.get(ymd) ?? [];
                    const dayLabel = formatDate(new Date(`${ymd}T12:00:00Z`), 'UTC');
                    return (
                      <div key={ymd} className="p-[14px] space-y-[8px]">
                        <div className="flex items-center justify-between gap-[8px]">
                          <span className="text-eyebrow text-ink-2">{dayLabel}</span>
                          {ymd === todayYmd && <StatusBadge tone="brand">Today</StatusBadge>}
                        </div>
                        <ul className="m-0 p-0 list-none space-y-[6px]">
                          {dayTasks.map((t) => {
                            const overdue = t.status === 'open' && Date.parse(t.due_at) < nowMs;
                            return (
                              <li key={t.id}>
                                <button
                                  type="button"
                                  onClick={() => onSelectTask(t)}
                                  className="w-full text-left p-[10px] rounded-[8px] border border-line bg-bg-alt flex items-center justify-between gap-[8px] cursor-pointer"
                                >
                                  <div className="min-w-0">
                                    <div className="font-semibold text-ink truncate">{t.title}</div>
                                    <div className="text-[12.5px] text-ink-2 tabular-nums">
                                      {formatTime(t.due_at, timeZone)} · {t.assignee_name ?? '—'}
                                    </div>
                                  </div>
                                  {overdue ? (
                                    <StatusBadge tone="danger">Overdue</StatusBadge>
                                  ) : t.status === 'completed' ? (
                                    <StatusBadge tone="success">Done</StatusBadge>
                                  ) : (
                                    <StatusBadge tone="brand">{t.priority}</StatusBadge>
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
