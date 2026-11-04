import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type Market } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { api } from '@/lib/api.js';
import {
  CreateForm,
  DataPanel,
  Field,
  PageHeader,
  SearchBox,
  fieldError,
  matches,
  rowClass,
  str,
  tableClass,
  tdClass,
  thClass,
  theadRowClass,
  useUserNames,
} from '@/features/shared/live-kit.js';

const VERIFICATION_TONE = { valid: 'success', risky: 'warning', invalid: 'danger' } as const;

export function ContactsScreen({ onOpenCompany }: { onOpenCompany: (id: string) => void }) {
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const contacts = useQuery({ queryKey: ['contacts'], queryFn: api.listContacts });
  const companies = useQuery({ queryKey: ['companies'], queryFn: api.listCompanies });
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const companyName = useMemo(() => {
    const byId = new Map((companies.data ?? []).map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (byId.get(id) ?? null) : null);
  }, [companies.data]);

  const visible = useMemo(
    () =>
      (contacts.data ?? []).filter((c) =>
        matches(search, c.full_name, c.primary_email, c.title, companyName(c.company_id)),
      ),
    [contacts.data, search, companyName],
  );

  const createContact = useMutation({
    mutationFn: api.createContact,
    onSuccess: async () => {
      setFormOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
  });

  return (
    <div className="space-y-[16px]" data-testid="contacts-screen">
      <PageHeader
        kicker="People"
        title="Contacts"
        count={contacts.data ? visible.length : undefined}
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>New contact</span>
          </Button>
        }
      />

      {formOpen && (
        <CreateForm
          title="New contact"
          submitLabel="Save contact"
          pending={createContact.isPending}
          error={createContact.error}
          onClose={() => setFormOpen(false)}
          onSubmit={(data) =>
            createContact.mutate({
              firstName: str(data, 'firstName'),
              lastName: str(data, 'lastName'),
              primaryEmail: str(data, 'email'),
              title: str(data, 'title') || undefined,
              companyId: str(data, 'companyId') || null,
              market: str(data, 'market') as Market,
            })
          }
        >
          <Field label="First name" error={fieldError(createContact.error, 'firstName')}>
            <Input name="firstName" required autoComplete="off" />
          </Field>
          <Field label="Last name" error={fieldError(createContact.error, 'lastName')}>
            <Input name="lastName" required autoComplete="off" />
          </Field>
          <Field label="Work email" error={fieldError(createContact.error, 'primaryEmail')}>
            <Input name="email" type="email" required autoComplete="off" />
          </Field>
          <Field label="Job title" optional>
            <Input name="title" autoComplete="off" />
          </Field>
          <Field label="Company" optional>
            <select
              name="companyId"
              defaultValue=""
              className="h-[36px] rounded-[8px] border border-input bg-surface px-[12px] text-[14px]"
            >
              <option value="">No company</option>
              {(companies.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Market">
            <select
              name="market"
              defaultValue="US"
              className="h-[36px] rounded-[8px] border border-input bg-surface px-[12px] text-[14px]"
            >
              <option value="US">United States</option>
              <option value="CA">Canada</option>
            </select>
          </Field>
        </CreateForm>
      )}

      <SearchBox value={search} onChange={setSearch} label="Search name, email, title or company" />

      <DataPanel
        query={contacts}
        isEmpty={visible.length === 0}
        emptyTitle={search ? 'No contacts match this search' : 'No contacts yet'}
        emptyDescription={
          search
            ? 'Clear the search to see everyone.'
            : 'Contacts are created from website inquiries, converted leads, or by hand.'
        }
        emptyActionLabel={search ? 'Clear search' : 'New contact'}
        onEmptyAction={() => (search ? setSearch('') : setFormOpen(true))}
      >
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th scope="col" className={`${thClass} pl-[16px]`}>
                Name
              </th>
              <th scope="col" className={thClass}>
                Company
              </th>
              <th scope="col" className={thClass}>
                Market
              </th>
              <th scope="col" className={thClass}>
                Email
              </th>
              <th scope="col" className={thClass}>
                Owner
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const company = companyName(c.company_id);
              const tone =
                VERIFICATION_TONE[c.email_verification_status as keyof typeof VERIFICATION_TONE];
              return (
                <tr key={c.id} className={rowClass}>
                  <td className={`${tdClass} pl-[16px] min-w-[200px]`}>
                    <div className="font-semibold text-ink">{c.full_name}</div>
                    <div className="text-[13px] text-ink-3">{c.title ?? ''}</div>
                  </td>
                  <td className={tdClass}>
                    {company && c.company_id ? (
                      <button
                        type="button"
                        onClick={() => onOpenCompany(c.company_id as string)}
                        className="bg-transparent border-0 p-0 text-left text-ink hover:underline cursor-pointer"
                      >
                        {company}
                      </button>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className={tdClass}>
                    <MarketBadge market={c.market} />
                  </td>
                  <td className={tdClass}>
                    <div className="flex flex-wrap items-center gap-[6px]">
                      <span className="text-ink-2">{c.primary_email}</span>
                      {c.do_not_contact ? (
                        <StatusBadge tone="danger">Do not contact</StatusBadge>
                      ) : tone ? (
                        <StatusBadge tone={tone}>{c.email_verification_status}</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">Unverified</StatusBadge>
                      )}
                    </div>
                  </td>
                  <td className={`${tdClass} text-ink-2`}>{ownerName(c.owner_user_id)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>
    </div>
  );
}
