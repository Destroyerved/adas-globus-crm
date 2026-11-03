import { useState } from 'react';
import { Calendar, CheckCircle2, Clock, Plus } from 'lucide-react';
import { formatCount } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Panel } from '@/components/ui/panel.js';

interface TaskRow {
  id: string;
  title: string;
  firmName: string;
  contactName: string;
  taskType: 'sla_first_response' | 'trial_checkin' | 'call' | 'follow_up';
  priority: 'urgent' | 'high' | 'normal';
  dueLabel: string;
  slaCountdown?: string;
  market: 'US' | 'CA';
  assignee: string;
  completed: boolean;
}

const INITIAL_TASKS: TaskRow[] = [
  {
    id: 'tsk_sla_1',
    title: 'First response SLA (15m): Jane Patel (3-day trial inquiry)',
    firmName: 'Acme Tax & Advisory LLP',
    contactName: 'Jane Patel',
    taskType: 'sla_first_response',
    priority: 'urgent',
    dueLabel: 'Due in 11 min',
    slaCountdown: '11m remaining',
    market: 'US',
    assignee: 'Arjun Mehta',
    completed: false,
  },
  {
    id: 'tsk_trial_d1',
    title: 'Day 1 Free Trial check-in: Review UltraTax CS workpaper batch',
    firmName: 'Acme Tax & Advisory LLP',
    contactName: 'Jane Patel',
    taskType: 'trial_checkin',
    priority: 'high',
    dueLabel: 'Today · 2:00 pm CT',
    market: 'US',
    assignee: 'Arjun Mehta',
    completed: false,
  },
  {
    id: 'tsk_trial_d2',
    title: 'Day 2 Free Trial check-in: Turnaround time & reviewer feedback',
    firmName: 'Acme Tax & Advisory LLP',
    contactName: 'Jane Patel',
    taskType: 'trial_checkin',
    priority: 'high',
    dueLabel: 'Tomorrow · 2:00 pm CT',
    market: 'US',
    assignee: 'Arjun Mehta',
    completed: false,
  },
  {
    id: 'tsk_trial_d3',
    title: 'Day 3 Free Trial wrap-up & FTE conversion proposal',
    firmName: 'Acme Tax & Advisory LLP',
    contactName: 'Jane Patel',
    taskType: 'trial_checkin',
    priority: 'high',
    dueLabel: '6 Nov 2026 · 3:00 pm CT',
    market: 'US',
    assignee: 'Arjun Mehta',
    completed: false,
  },
  {
    id: 'tsk_ca_call',
    title: 'Discovery prep call: T1/T2 CaseWare pod scoping',
    firmName: 'Northstar Chartered Accountants',
    contactName: 'Marcus Vance',
    taskType: 'call',
    priority: 'normal',
    dueLabel: '5 Nov 2026 · 10:30 am ET',
    market: 'CA',
    assignee: 'Priya Nair',
    completed: false,
  },
];

export function TasksScreen() {
  const [tasks, setTasks] = useState<TaskRow[]>(INITIAL_TASKS);
  const [filterType, setFilterType] = useState<'all' | 'sla' | 'trial'>('all');
  const [newTaskTitle, setNewTaskTitle] = useState('');

  const filteredTasks = tasks.filter((t) => {
    if (filterType === 'sla') return t.taskType === 'sla_first_response';
    if (filterType === 'trial') return t.taskType === 'trial_checkin';
    return true;
  });

  const toggleComplete = (id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));
  };

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    setTasks((prev) => [
      {
        id: `tsk_${Date.now()}`,
        title: newTaskTitle.trim(),
        firmName: 'Ridgeway CPA Group',
        contactName: 'Elena Rostova',
        taskType: 'follow_up',
        priority: 'normal',
        dueLabel: 'Today · 4:30 pm CT',
        market: 'US',
        assignee: 'Arjun Mehta',
        completed: false,
      },
      ...prev,
    ]);
    setNewTaskTitle('');
  };

  const openCount = tasks.filter((t) => !t.completed).length;

  return (
    <div
      className="px-[16px] py-[20px] md:px-[28px] md:py-[24px] max-w-[1600px] mx-auto space-y-[20px]"
      data-testid="tasks-screen"
    >
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[16px]">
        <div>
          <div className="eyebrow-rule mb-[6px]">Execution & SLA timers</div>
          <h1 className="text-h1 text-ink m-0 flex items-baseline gap-[10px]">
            <span>Tasks</span>
            <span className="text-ink-3 font-light tabular-nums">
              {formatCount(openCount, 'open task')}
            </span>
          </h1>
        </div>

        <div
          className="flex flex-wrap items-center gap-[8px]"
          role="group"
          aria-label="Task filter"
        >
          {(
            [
              { id: 'all', label: 'All tasks' },
              { id: 'sla', label: '15m Website SLA' },
              { id: 'trial', label: '3-Day Free Trial check-ins' },
            ] as const
          ).map((tab) => (
            <Button
              key={tab.id}
              size="sm"
              variant={filterType === tab.id ? 'navy' : 'secondary'}
              onClick={() => setFilterType(tab.id)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      </div>

      <Panel className="p-[16px]">
        <form onSubmit={handleAddTask} className="flex flex-col sm:flex-row gap-[10px]">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="Add follow-up or trial check-in task…"
            aria-label="New task title"
            className="h-[36px] flex-1 rounded-[8px] border border-line-field bg-surface px-[12px] text-[14px] text-ink"
          />
          <Button type="submit" variant="primary" size="md">
            <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
            <span>Add task</span>
          </Button>
        </form>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="divide-y divide-line">
          {filteredTasks.map((task) => (
            <div
              key={task.id}
              className="p-[16px] flex flex-col sm:flex-row sm:items-center justify-between gap-[12px] hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-start gap-[12px] min-w-0">
                <input
                  type="checkbox"
                  checked={task.completed}
                  onChange={() => toggleComplete(task.id)}
                  aria-label={`Complete task ${task.title}`}
                  className="mt-[3px] w-[16px] h-[16px] accent-primary cursor-pointer shrink-0"
                />
                <div className="min-w-0">
                  <div
                    className={`text-[14px] font-[550] ${
                      task.completed ? 'line-through text-ink-3' : 'text-ink'
                    }`}
                  >
                    {task.title}
                  </div>
                  <div className="text-[12.5px] text-ink-2 mt-[2px] flex flex-wrap items-center gap-[8px]">
                    <span>
                      {task.contactName} · {task.firmName}
                    </span>
                    <StatusBadge tone="neutral">{task.market}</StatusBadge>
                    <span>Assignee: {task.assignee}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-[8px] shrink-0">
                {task.slaCountdown && !task.completed && (
                  <StatusBadge tone="warning">
                    <Clock size={12} className="inline mr-[4px]" aria-hidden="true" />
                    {task.slaCountdown}
                  </StatusBadge>
                )}
                {task.taskType === 'trial_checkin' && (
                  <StatusBadge tone="brand">Free trial check-in</StatusBadge>
                )}
                {task.completed ? (
                  <StatusBadge tone="success">
                    <CheckCircle2 size={12} className="inline mr-[4px]" aria-hidden="true" />
                    Completed
                  </StatusBadge>
                ) : (
                  <span className="text-[12.5px] text-ink-3 tabular-nums inline-flex items-center gap-[4px]">
                    <Calendar size={13} aria-hidden="true" />
                    {task.dueLabel}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
