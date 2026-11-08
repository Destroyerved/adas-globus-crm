import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatNumber } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type RoleRow, type ScopeValue } from '@/lib/api.js';
import {
  DataPanel,
  errorMessage,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
} from '@/features/shared/live-kit.js';
import { SCOPE_LABEL, capabilityLabel, useAdminRoles } from './settings-kit.js';

const SCOPES: ScopeValue[] = ['none', 'own', 'team', 'all'];

/**
 * Roles are editable bundles of capabilities, each with a scope (PRD 2.1, 2.2). The API
 * applies the change on the next request; the Admin role keeps user, settings and audit access.
 */
export function RolesTab() {
  const roles = useAdminRoles();
  const [roleId, setRoleId] = useState('');
  const items = roles.data?.items ?? [];
  const role = items.find((r) => r.id === roleId) ?? items[0];

  return (
    <div className="space-y-[12px]">
      <div className="flex flex-col sm:flex-row sm:items-end gap-[8px] justify-between">
        <label className="grid gap-[6px] text-label text-ink sm:w-[280px]">
          Role
          <Select value={role?.id ?? ''} onChange={(e) => setRoleId(e.target.value)}>
            {items.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({formatNumber(r.user_count)} {r.user_count === 1 ? 'person' : 'people'})
              </option>
            ))}
          </Select>
        </label>
        {role && <p className="m-0 text-[14px] text-ink-2 sm:text-right">{role.description}</p>}
      </div>
      <DataPanel
        query={roles}
        isEmpty={items.length === 0}
        emptyTitle="No roles"
        emptyDescription="Roles come with the CRM. Reload the page."
      >
        {role && (
          <RoleGrants key={role.id} role={role} capabilities={roles.data?.capabilities ?? []} />
        )}
      </DataPanel>
    </div>
  );
}

function RoleGrants({ role, capabilities }: { role: RoleRow; capabilities: string[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, ScopeValue>>(role.grants);
  const changes = Object.fromEntries(
    Object.entries(draft).filter(([cap, scope]) => role.grants[cap] !== scope),
  );
  const dirty = Object.keys(changes).length > 0;
  const save = useMutation({
    mutationFn: () => api.updateRoleCapabilities(role.id, changes),
    onSuccess: async () => {
      toast(`Saved the ${role.name} role. It applies from each person's next click.`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  return (
    <div>
      <table className={tableClass}>
        <caption className="sr-only">What the {role.name} role can do</caption>
        <thead>
          <tr className={theadRowClass}>
            <th className={thClass}>Can</th>
            <th className={`${thClass} w-[200px]`}>Which records</th>
          </tr>
        </thead>
        <tbody>
          {capabilities.map((cap) => {
            const locked = role.locked.includes(cap);
            const label = capabilityLabel(cap);
            return (
              <tr key={cap} className={rowClass}>
                <td className={tdClass}>
                  <span className="text-ink">{label}</span>{' '}
                  {role.changed.includes(cap) && <StatusBadge tone="info">Changed</StatusBadge>}
                  {locked && (
                    <span className="block text-[12.5px] text-ink-3">
                      Admins always keep this, so no one is locked out.
                    </span>
                  )}
                </td>
                <td className={tdClass}>
                  <Select
                    aria-label={`${label}: which records`}
                    value={draft[cap] ?? 'none'}
                    disabled={locked}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, [cap]: e.target.value as ScopeValue }))
                    }
                    className="h-[32px]"
                  >
                    {SCOPES.map((s) => (
                      <option key={s} value={s}>
                        {SCOPE_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center justify-end gap-[8px] px-[12px] py-[12px] border-t border-line">
        {save.isError && (
          <p role="alert" className="m-0 mr-auto text-[13px] text-danger">
            {errorMessage(save.error)}
          </p>
        )}
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(role.grants)}>
          Undo changes
        </Button>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : `Save ${role.name} role`}
        </Button>
      </div>
    </div>
  );
}
