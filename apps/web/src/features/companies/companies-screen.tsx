import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { formatRelative, type Market } from '@adas/shared';
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

const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  prospect: 'Prospect',
  client: 'Active client',
  former_client: 'Former client',
  partner: 'Partner',
  do_not_contact: 'Do not contact',
};

export function CompaniesScreen({ onOpenCompany }: { onOpenCompany: (id: string) => void }) {
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const companies = useQuery({ queryKey: ['companies'], queryFn: api.listCompanies });
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const visible = useMemo(
    () =>
      (companies.data ?? []).filter((c) =>
        matches(search, c.name, c.domain, c.city, c.state_province, c.firm_type),
      ),
    [companies.data, search],
  );

  const createCompany = useMutation({
    mutationFn: api.createCompany,
    onSuccess: async (result) => {
      setFormOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      onOpenCompany(result.company.id);
    },
  });

  return (
    <div className="space-y-[16px]" data-testid="companies-screen">
      <PageHeader
        kicker="Accounts"
        title="Companies"
        count={companies.data ? visible.length : undefined}
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>New company</span>
          </Button>
        }
      />

      {formOpen && (
        <CreateForm
          title="New company"
          submitLabel="Save company"
          pending={createCompany.isPending}
          error={createCompany.error}
          onClose={() => setFormOpen(false)}
          onSubmit={(data) =>
            createCompany.mutate({
              name: str(data, 'name'),
              websiteOrDomain: str(data, 'website') || undefined,
              market: str(data, 'market') as Market,
            })
          }
        >
          <Field label="Company name" error={fieldError(createCompany.error, 'name')}>
            <Input name="name" required autoComplete="off" />
          </Field>
          <Field label="Website" optional>
            <Input name="website" placeholder="firm.com" autoComplete="off" />
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

      <SearchBox value={search} onChange={setSearch} label="Search name, domain or city" />

      <DataPanel
        query={companies}
        isEmpty={visible.length === 0}
        emptyTitle={search ? 'No companies match this search' : 'No companies yet'}
        emptyDescription={
          search
            ? 'Try the firm’s domain, or clear the search.'
            : 'Companies are created from website inquiries, converted leads, or by hand.'
        }
        emptyActionLabel={search ? 'Clear search' : 'New company'}
        onEmptyAction={() => (search ? setSearch('') : setFormOpen(true))}
      >
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th scope="col" className={`${thClass} pl-[16px]`}>
                Company
              </th>
              <th scope="col" className={thClass}>
                Market
              </th>
              <th scope="col" className={thClass}>
                Location
              </th>
              <th scope="col" className={thClass}>
                Status
              </th>
              <th scope="col" className={thClass}>
                Owner
              </th>
              <th scope="col" className={thClass}>
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className={rowClass}>
                <td className={`${tdClass} pl-[16px] min-w-[220px]`}>
                  <button
                    type="button"
                    onClick={() => onOpenCompany(c.id)}
                    className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                  >
                    {c.name}
                  </button>
                  <div className="text-[13px] text-ink-3">{c.domain ?? 'No website'}</div>
                </td>
                <td className={tdClass}>
                  <MarketBadge market={c.market} />
                </td>
                <td className={`${tdClass} text-ink-2`}>
                  {[c.city, c.state_province].filter(Boolean).join(', ') || '—'}
                </td>
                <td className={tdClass}>
                  <StatusBadge
                    tone={
                      c.account_status === 'client'
                        ? 'success'
                        : c.account_status === 'do_not_contact'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {ACCOUNT_STATUS_LABEL[c.account_status] ?? c.account_status}
                  </StatusBadge>
                </td>
                <td className={`${tdClass} text-ink-2`}>{ownerName(c.owner_user_id)}</td>
                <td className={`${tdClass} text-ink-3 whitespace-nowrap`}>
                  {formatRelative(c.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
    </div>
  );
}
