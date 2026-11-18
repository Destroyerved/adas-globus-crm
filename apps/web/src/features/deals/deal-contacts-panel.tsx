import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type DealContactView } from '@adas/shared';
import { StatusBadge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Panel } from '@/components/ui/panel.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';
import { useReferenceLists } from '@/features/shared/list-kit.js';

const DEFAULT_ROLES = ['Decision maker', 'Influencer', 'Reviewer', 'Day-to-day contact', 'Billing'];

/**
 * Deal stakeholder contacts panel (PRD 4.6): primary contact plus multi-contact stakeholder roles.
 */
export function DealContactsPanel({
  dealId,
  companyId,
  primaryContact,
  dealContacts,
  canWrite,
  onOpenContact,
  onChanged,
}: {
  dealId: string;
  companyId: string;
  primaryContact: { id: string; full_name: string; title: string | null } | null;
  dealContacts: DealContactView[];
  canWrite: boolean;
  onOpenContact: (contactId: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const refs = useReferenceLists();
  const roles =
    refs.data?.['deal_contact_roles'] && refs.data['deal_contact_roles'].length > 0
      ? refs.data['deal_contact_roles']
      : DEFAULT_ROLES;

  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedContactId, setSelectedContactId] = useState('');
  const [selectedRole, setSelectedRole] = useState(roles[0] ?? 'Decision maker');

  const candidatesQuery = useQuery({
    queryKey: ['deal-contact-candidates', companyId, search.trim()],
    queryFn: async () => {
      const page = await api.listContacts({
        q: search.trim() || undefined,
        filter: search.trim() ? null : { field: 'companyId', op: 'eq', value: companyId },
        limit: 25,
      });
      if (page.items.length > 0 || search.trim()) return page.items;
      const fallback = await api.listContacts({ limit: 25 });
      return fallback.items;
    },
    enabled: adding,
  });

  const existingIds = new Set([
    ...(primaryContact ? [primaryContact.id] : []),
    ...dealContacts.map((dc) => dc.contactId),
  ]);
  const availableContacts = (candidatesQuery.data ?? []).filter((c) => !existingIds.has(c.id));

  const addMutation = useMutation({
    mutationFn: () =>
      api.addDealContact(dealId, {
        contactId: selectedContactId,
        role: selectedRole,
      }),
    onSuccess: () => {
      toast('Added stakeholder to deal.');
      setAdding(false);
      setSelectedContactId('');
      setSearch('');
      onChanged();
    },
  });

  const updateRole = useMutation({
    mutationFn: ({ contactId, role }: { contactId: string; role: string }) =>
      api.updateDealContact(dealId, contactId, { role }),
    onSuccess: () => {
      toast('Updated stakeholder role.');
      onChanged();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (contactId: string) => api.removeDealContact(dealId, contactId),
    onSuccess: () => {
      toast('Removed stakeholder from deal.');
      onChanged();
    },
  });

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedContactId) return;
    addMutation.mutate();
  };

  return (
    <Panel
      title="Contacts & roles"
      padded
      actions={
        canWrite && !adding ? (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add person
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-[12px]" data-testid="deal-contacts-panel">
        <div className="space-y-[4px]">
          <div className="text-[12px] font-semibold text-ink-3 uppercase tracking-wider">
            Primary contact
          </div>
          {primaryContact ? (
            <div>
              <button
                type="button"
                onClick={() => onOpenContact(primaryContact.id)}
                className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
              >
                {primaryContact.full_name}
              </button>
              {primaryContact.title && (
                <div className="text-[13px] text-ink-3">{primaryContact.title}</div>
              )}
            </div>
          ) : (
            <p className="m-0 text-[13.5px] text-ink-2">No primary contact set.</p>
          )}
        </div>

        <div className="pt-[10px] border-t border-line space-y-[8px]">
          <div className="text-[12px] font-semibold text-ink-3 uppercase tracking-wider">
            Stakeholders ({dealContacts.length})
          </div>
          {dealContacts.length === 0 ? (
            <p className="m-0 text-[13.5px] text-ink-2">No additional stakeholders linked yet.</p>
          ) : (
            <ul className="m-0 p-0 list-none divide-y divide-line">
              {dealContacts.map((dc) => (
                <li key={dc.id} className="py-[8px] first:pt-0 last:pb-0 space-y-[4px]">
                  <div className="flex flex-wrap items-center justify-between gap-[6px]">
                    <button
                      type="button"
                      onClick={() => onOpenContact(dc.contactId)}
                      className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                    >
                      {dc.fullName}
                    </button>
                    {!canWrite && <StatusBadge tone="neutral">{dc.role}</StatusBadge>}
                  </div>
                  {dc.title && <div className="text-[12.5px] text-ink-3">{dc.title}</div>}
                  {canWrite && (
                    <div className="flex flex-wrap items-center gap-[6px] pt-[2px]">
                      <Select
                        aria-label={`Role for ${dc.fullName}`}
                        className="h-[30px] text-[12.5px] flex-1 min-w-[140px]"
                        value={dc.role}
                        disabled={updateRole.isPending}
                        onChange={(e) =>
                          updateRole.mutate({ contactId: dc.contactId, role: e.target.value })
                        }
                      >
                        {[...new Set([dc.role, ...roles])].map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={removeMutation.isPending}
                        aria-label={`Remove ${dc.fullName} from deal`}
                        onClick={() => removeMutation.mutate(dc.contactId)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {adding && canWrite && (
          <form
            onSubmit={submitAdd}
            className="pt-[10px] border-t border-line grid gap-[8px]"
            data-testid="deal-add-contact-form"
          >
            <div>
              <label htmlFor="deal-contact-search" className="block text-label text-ink mb-[4px]">
                Find contact
              </label>
              <Input
                id="deal-contact-search"
                type="search"
                value={search}
                placeholder="Filter by name or email…"
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="deal-contact-select" className="block text-label text-ink mb-[4px]">
                Person
              </label>
              <Select
                id="deal-contact-select"
                value={selectedContactId}
                onChange={(e) => setSelectedContactId(e.target.value)}
              >
                <option value="">Choose a contact…</option>
                {availableContacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name} ({c.primary_email})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="deal-contact-role" className="block text-label text-ink mb-[4px]">
                Role on this deal
              </label>
              <Select
                id="deal-contact-role"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            {addMutation.isError && (
              <p role="alert" className="m-0 text-[12.5px] text-danger">
                {errorMessage(addMutation.error)}
              </p>
            )}
            <div className="flex justify-end gap-[6px]">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!selectedContactId || addMutation.isPending}
              >
                {addMutation.isPending ? 'Adding…' : 'Add stakeholder'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
