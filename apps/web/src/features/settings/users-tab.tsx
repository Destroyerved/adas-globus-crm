import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  InviteUserInputSchema,
  UpdateUserInputSchema,
  formatRelative,
  type Market,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type AdminUserRow } from '@/lib/api.js';
import {
  DataPanel,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { useMe } from '@/features/shared/list-kit.js';
import {
  EditDrawer,
  changedFields,
  formError,
  issuesOf,
  serverFieldErrors,
  useDraft,
} from '@/features/records/record-form.js';
import {
  FormRow,
  MARKET_LABEL,
  TimeZoneSelect,
  USER_STATUS,
  useAdminRoles,
  useAdminTeams,
} from './settings-kit.js';

/** People: invite, change role or team, deactivate (PRD 2.1, 4.17, 6.6). */
export function UsersTab() {
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.adminUsers });
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const rows = users.data ?? [];

  return (
    <div className="space-y-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <p className="m-0 text-ink-2 text-[14px]">
          People sign in with their Microsoft work account. Only invited emails can get in.
        </p>
        <Button variant="primary" onClick={() => setInviting(true)}>
          Invite person
        </Button>
      </div>
      <DataPanel
        query={users}
        isEmpty={rows.length === 0}
        emptyTitle="No one has been invited yet"
        emptyDescription="Invite the people who will use the CRM."
      >
        <table className={tableClass}>
          <caption className="sr-only">People with access to the CRM</caption>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}>Name</th>
              <th className={`${thClass} hidden sm:table-cell`}>Role</th>
              <th className={`${thClass} hidden md:table-cell`}>Team</th>
              <th className={`${thClass} hidden lg:table-cell`}>Market</th>
              <th className={thClass}>Status</th>
              <th className={`${thClass} hidden lg:table-cell`}>Last sign-in</th>
              <th className={thClass}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const status = USER_STATUS[u.status] ?? USER_STATUS['active'];
              return (
                <tr key={u.id} className={rowClass}>
                  <td className={`${tdClass} max-w-[180px] sm:max-w-none`}>
                    <div className="font-semibold text-ink truncate">{u.name}</div>
                    <div className="text-[12.5px] text-ink-3 truncate" title={u.email}>
                      {u.email}
                    </div>
                    <div className="sm:hidden text-[12.5px] text-ink-2">{u.role_name}</div>
                  </td>
                  <td className={`${tdClass} hidden sm:table-cell`}>{u.role_name}</td>
                  <td className={`${tdClass} hidden md:table-cell`}>{u.team_name ?? '—'}</td>
                  <td className={`${tdClass} hidden lg:table-cell`}>
                    <MarketBadge market={u.market_focus} />
                  </td>
                  <td className={tdClass}>
                    {status && <StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
                  </td>
                  <td className={`${tdClass} hidden lg:table-cell text-ink-2`}>
                    {u.last_sign_in_at ? formatRelative(u.last_sign_in_at) : 'Never'}
                  </td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${u.name}`}
                      onClick={() => setEditing(u)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>
      {inviting && <InviteDrawer onClose={() => setInviting(false)} />}
      {editing && <UserDrawer user={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoleAndTeamFields({
  values,
  set,
  errors,
  prefix,
}: {
  values: { roleId: string; teamId: string; marketFocus: Market; timezone: string };
  set: (key: 'roleId' | 'teamId' | 'marketFocus' | 'timezone', value: string) => void;
  errors: Record<string, string>;
  prefix: string;
}) {
  const roles = useAdminRoles();
  const teams = useAdminTeams();
  return (
    <>
      <FormRow id={`${prefix}-role`} label="Role" error={errors['roleId']}>
        <Select
          id={`${prefix}-role`}
          value={values.roleId}
          invalid={Boolean(errors['roleId'])}
          onChange={(e) => set('roleId', e.target.value)}
        >
          {!values.roleId && <option value="">Choose a role</option>}
          {(roles.data?.items ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow id={`${prefix}-team`} label="Team" error={errors['teamId']}>
        <Select
          id={`${prefix}-team`}
          value={values.teamId}
          onChange={(e) => set('teamId', e.target.value)}
        >
          <option value="">No team</option>
          {(teams.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow id={`${prefix}-market`} label="Market" error={errors['marketFocus']}>
        <Select
          id={`${prefix}-market`}
          value={values.marketFocus}
          onChange={(e) => set('marketFocus', e.target.value)}
        >
          {(Object.keys(MARKET_LABEL) as Market[]).map((m) => (
            <option key={m} value={m}>
              {MARKET_LABEL[m]}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow
        id={`${prefix}-tz`}
        label="Time zone"
        hint="Used for their task due dates and dashboard periods."
        error={errors['timezone']}
      >
        <TimeZoneSelect
          id={`${prefix}-tz`}
          value={values.timezone}
          invalid={Boolean(errors['timezone'])}
          onChange={(z) => set('timezone', z)}
        />
      </FormRow>
    </>
  );
}

function InviteDrawer({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { values, set } = useDraft({
    email: '',
    name: '',
    roleId: '',
    teamId: '',
    marketFocus: 'US' as Market,
    timezone: 'Asia/Kolkata',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const payload = { ...values, teamId: values.teamId || null };
  const save = useMutation({
    mutationFn: () => api.inviteUser(payload),
    onSuccess: async (user) => {
      toast(`Invited ${user.name}.`);
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });
  const submit = () => {
    const issues = issuesOf(InviteUserInputSchema, payload);
    setErrors(issues);
    if (Object.keys(issues).length === 0) save.mutate();
  };
  return (
    <EditDrawer
      title="Invite a person"
      description="They sign in with their Microsoft work account using this email. The CRM doesn't send an invitation email, so let them know."
      formId="invite-user"
      pending={save.isPending}
      error={save.isError && Object.keys(errors).length === 0 ? formError(save.error) : null}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Invite person"
    >
      <FormRow id="invite-email" label="Work email" error={errors['email']}>
        <Input
          id="invite-email"
          type="email"
          autoComplete="off"
          value={values.email}
          invalid={Boolean(errors['email'])}
          onChange={(e) => set('email', e.target.value)}
        />
      </FormRow>
      <FormRow id="invite-name" label="Full name" error={errors['name']}>
        <Input
          id="invite-name"
          value={values.name}
          invalid={Boolean(errors['name'])}
          onChange={(e) => set('name', e.target.value)}
        />
      </FormRow>
      <RoleAndTeamFields
        prefix="invite"
        values={values}
        errors={errors}
        set={(key, value) => set(key, value as never)}
      />
    </EditDrawer>
  );
}

function UserDrawer({ user, onClose }: { user: AdminUserRow; onClose: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const toast = useToast();
  const self = me?.id === user.id;
  const initial = {
    name: user.name,
    roleId: user.role_id,
    teamId: user.team_id ?? '',
    marketFocus: user.market_focus,
    timezone: user.timezone,
    dailySendCap: user.daily_send_cap,
    status: user.status === 'disabled' ? 'disabled' : 'active',
  };
  const { values, set } = useDraft(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const changes = changedFields(initial, values);
  if ('teamId' in changes) changes['teamId'] = values.teamId || null;
  const payload = { version: user.version, ...changes };
  const save = useMutation({
    mutationFn: () => api.updateUser(user.id, payload),
    onSuccess: async (saved) => {
      toast(`Saved ${saved.name}.`);
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => setErrors(serverFieldErrors(err)),
  });
  const submit = () => {
    if (Object.keys(changes).length === 0) return onClose();
    const issues = issuesOf(UpdateUserInputSchema, payload);
    setErrors(issues);
    if (Object.keys(issues).length === 0) save.mutate();
  };
  return (
    <EditDrawer
      title={`Edit ${user.name}`}
      description={user.email}
      formId="edit-user"
      pending={save.isPending}
      error={save.isError && Object.keys(errors).length === 0 ? formError(save.error) : null}
      onClose={onClose}
      onSubmit={submit}
    >
      <FormRow id="user-name" label="Full name" error={errors['name']}>
        <Input
          id="user-name"
          value={values.name}
          invalid={Boolean(errors['name'])}
          onChange={(e) => set('name', e.target.value)}
        />
      </FormRow>
      <RoleAndTeamFields
        prefix="user"
        values={values}
        errors={errors}
        set={(key, value) => set(key, value as never)}
      />
      {'teamId' in changes && (
        <p className="m-0 text-[13px] text-ink-2">
          Their leads, contacts, companies, deals and tasks move to the new team.
        </p>
      )}
      <FormRow
        id="user-cap"
        label="Daily email limit"
        hint="Personal outreach emails they can send in a day."
        error={errors['dailySendCap']}
      >
        <Input
          id="user-cap"
          type="number"
          min={0}
          max={500}
          value={String(values.dailySendCap)}
          invalid={Boolean(errors['dailySendCap'])}
          onChange={(e) => set('dailySendCap', Number(e.target.value))}
        />
      </FormRow>
      <FormRow
        id="user-status"
        label="Access"
        hint={
          self
            ? "You can't deactivate yourself."
            : 'Deactivating signs them out everywhere straight away.'
        }
        error={errors['status']}
      >
        <Select
          id="user-status"
          value={values.status}
          disabled={self}
          onChange={(e) => set('status', e.target.value)}
        >
          <option value="active">{user.status === 'invited' ? 'Invited' : 'Active'}</option>
          <option value="disabled">Deactivated</option>
        </Select>
      </FormRow>
    </EditDrawer>
  );
}
