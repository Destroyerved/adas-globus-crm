import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateTeamInputSchema, formatNumber, type Market } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type TeamRow } from '@/lib/api.js';
import {
  DataPanel,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import {
  EditDrawer,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
} from '@/features/records/record-form.js';
import { FormRow, MARKET_LABEL, useAdminTeams } from './settings-kit.js';

/** Teams decide what "team" scope covers for managers (PRD 2.1, 2.2). */
export function TeamsTab() {
  const teams = useAdminTeams();
  const [editing, setEditing] = useState<TeamRow | 'new' | null>(null);
  const rows = teams.data ?? [];
  return (
    <div className="space-y-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <p className="m-0 text-ink-2 text-[14px]">
          Managers see their team&apos;s records. Records follow their owner&apos;s team.
        </p>
        <Button variant="primary" onClick={() => setEditing('new')}>
          New team
        </Button>
      </div>
      <DataPanel
        query={teams}
        isEmpty={rows.length === 0}
        emptyTitle="No teams yet"
        emptyDescription="Teams group people so managers can see their team's work."
        emptyActionLabel="New team"
        onEmptyAction={() => setEditing('new')}
      >
        <table className={tableClass}>
          <caption className="sr-only">Teams</caption>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}>Team</th>
              <th className={thClass}>Market</th>
              <th className={`${thClass} text-right`}>People</th>
              <th className={thClass}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={rowClass}>
                <td className={`${tdClass} font-semibold text-ink`}>{t.name}</td>
                <td className={tdClass}>
                  <MarketBadge market={t.market} />
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>
                  {formatNumber(t.member_count)}
                </td>
                <td className={`${tdClass} text-right`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => setEditing(t)}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
      {editing && (
        <TeamDrawer team={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function TeamDrawer({ team, onClose }: { team: TeamRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { values, set } = useDraft({
    name: team?.name ?? '',
    market: (team?.market ?? 'US') as Market,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      team ? api.updateTeam(team.id, { version: team.version, ...values }) : api.createTeam(values),
    onSuccess: async (saved) => {
      toast(team ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });
  const submit = () => {
    const issues = issuesOf(CreateTeamInputSchema, values);
    setErrors(issues);
    if (Object.keys(issues).length === 0) save.mutate();
  };
  return (
    <EditDrawer
      title={team ? `Edit ${team.name}` : 'New team'}
      formId="team-form"
      pending={save.isPending}
      error={save.isError && Object.keys(errors).length === 0 ? formError(save.error) : null}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={team ? 'Save changes' : 'Add team'}
    >
      <FormRow id="team-name" label="Team name" error={errors['name']}>
        <Input
          id="team-name"
          value={values.name}
          invalid={Boolean(errors['name'])}
          onChange={(e) => set('name', e.target.value)}
        />
      </FormRow>
      <FormRow id="team-market" label="Market" error={errors['market']}>
        <Select
          id="team-market"
          value={values.market}
          onChange={(e) => set('market', e.target.value as Market)}
        >
          {(Object.keys(MARKET_LABEL) as Market[]).map((m) => (
            <option key={m} value={m}>
              {MARKET_LABEL[m]}
            </option>
          ))}
        </Select>
      </FormRow>
    </EditDrawer>
  );
}
