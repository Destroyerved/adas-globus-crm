import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { formatDate, formatMoney, formatRelative } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { api } from '@/lib/api.js';
import { errorMessage, useUserNames } from '@/features/shared/live-kit.js';

/** Company profile on live data (PRD 4.3, DESIGN 6.9 and 6.10). */
export function CompanyProfileScreen({
  companyId,
  onBack,
  onOpenDeals,
}: {
  companyId: string | null;
  onBack: () => void;
  onOpenDeals: () => void;
}) {
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const profile = useQuery({
    queryKey: ['company', companyId],
    queryFn: () => api.getCompanyProfile(companyId as string),
    enabled: companyId !== null,
  });
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');

  const addTask = useMutation({
    mutationFn: () =>
      api.createTask({
        title: taskTitle.trim(),
        dueAt: new Date(`${taskDue}T09:00:00`).toISOString(),
        companyId,
      }),
    onSuccess: async () => {
      setTaskTitle('');
      setTaskDue('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['company', companyId] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]);
    },
  });

  const back = (
    <Button variant="link" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={1.6} aria-hidden="true" />
      <span>All companies</span>
    </Button>
  );

  if (companyId === null) {
    return (
      <div className="space-y-[16px]">
        {back}
        <p className="text-ink-2">Choose a company from the list.</p>
      </div>
    );
  }
  if (profile.isPending) {
    return (
      <div className="space-y-[16px]">
        {back}
        <div className="bg-surface border border-line rounded-[10px]">
          <LoadingState rows={6} />
        </div>
      </div>
    );
  }
  if (profile.isError) {
    return (
      <div className="space-y-[16px]">
        {back}
        <div className="bg-surface border border-line rounded-[10px]">
          <ErrorState
            message={errorMessage(profile.error)}
            onRetry={() => void profile.refetch()}
          />
        </div>
      </div>
    );
  }

  const { company, contacts, deals, tasks, activities } = profile.data;
  const location = [company.city, company.state_province].filter(Boolean).join(', ');

  return (
    <div className="space-y-[16px]" data-testid="company-profile-screen">
      {back}
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
        <div>
          <div className="text-eyebrow text-ink-3 mb-[4px]">COMPANY</div>
          <h1 className="text-title-lg text-ink m-0">{company.name}</h1>
          <div className="mt-[6px] flex flex-wrap items-center gap-[8px] text-[14px] text-ink-2">
            <MarketBadge market={company.market} />
            {location && <span>{location}</span>}
            <span>· {company.firm_type}</span>
            <span>· Owner {ownerName(company.owner_user_id)}</span>
            {company.domain && (
              <a
                href={`https://${company.domain}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary-ink font-semibold"
              >
                · {company.domain}
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="grid gap-[16px] lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-[16px] min-w-0">
          <Panel title={`Contacts (${contacts.length})`} padded>
            {contacts.length === 0 ? (
              <p className="m-0 text-ink-2">No contacts at this company yet.</p>
            ) : (
              <ul className="divide-y divide-line m-0 p-0 list-none">
                {contacts.map((c) => (
                  <li key={c.id} className="py-[10px] flex flex-wrap justify-between gap-[8px]">
                    <div>
                      <div className="font-semibold text-ink">{c.full_name}</div>
                      <div className="text-[13px] text-ink-3">
                        {[c.title, c.primary_email].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {c.do_not_contact && <StatusBadge tone="danger">Do not contact</StatusBadge>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Timeline" padded>
            {activities.length === 0 ? (
              <p className="m-0 text-ink-2">Nothing has happened here yet.</p>
            ) : (
              <ol className="m-0 p-0 list-none border-l border-line ml-[4px]">
                {activities.map((a) => (
                  <li key={a.id} className="relative pl-[20px] pb-[16px]">
                    <span
                      aria-hidden="true"
                      className="absolute left-[-5px] top-[6px] h-[9px] w-[9px] rounded-full bg-primary"
                    />
                    <div className="flex justify-between gap-[8px]">
                      <span className="font-semibold text-ink">{a.title}</span>
                      <span className="text-[13px] text-ink-3 whitespace-nowrap">
                        {formatRelative(a.occurred_at)}
                      </span>
                    </div>
                    <p className="m-0 mt-[2px] text-[13.5px] text-ink-2 whitespace-pre-line">
                      {a.detail}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <aside className="space-y-[16px]">
          <Panel
            title={`Deals (${deals.length})`}
            padded
            actions={
              deals.length > 0 ? (
                <Button variant="link" onClick={onOpenDeals}>
                  Open board
                </Button>
              ) : undefined
            }
          >
            {deals.length === 0 ? (
              <p className="m-0 text-ink-2">No deals yet. Convert a lead to start one.</p>
            ) : (
              <ul className="m-0 p-0 list-none space-y-[10px]">
                {deals.map((d) => (
                  <li key={d.id}>
                    <div className="font-semibold text-ink">{d.name}</div>
                    <div className="text-[13px] text-ink-2 flex flex-wrap gap-[6px] items-center">
                      <StatusBadge
                        tone={
                          d.stage_category === 'won'
                            ? 'success'
                            : d.stage_category === 'lost'
                              ? 'danger'
                              : 'brand'
                        }
                      >
                        {d.stage_name}
                      </StatusBadge>
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

          <Panel title={`Open tasks (${tasks.length})`} padded>
            <ul className="m-0 p-0 list-none space-y-[8px]">
              {tasks.map((t) => (
                <li key={t.id} className="text-[14px]">
                  <div className="text-ink">{t.title}</div>
                  <div className="text-[13px] text-ink-3">
                    Due {formatDate(t.due_at)} · {ownerName(t.assignee_user_id)}
                  </div>
                </li>
              ))}
            </ul>
            <form
              className="mt-[12px] grid gap-[8px]"
              onSubmit={(e) => {
                e.preventDefault();
                if (taskTitle.trim() && taskDue) addTask.mutate();
              }}
            >
              <Input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="New task"
                aria-label="New task title"
                required
              />
              <Input
                type="date"
                value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)}
                aria-label="Due date"
                required
              />
              {addTask.isError && (
                <p role="alert" className="m-0 text-[13px] text-danger">
                  {errorMessage(addTask.error)}
                </p>
              )}
              <Button type="submit" variant="outline" size="sm" disabled={addTask.isPending}>
                {addTask.isPending ? 'Adding…' : 'Add task'}
              </Button>
            </form>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
