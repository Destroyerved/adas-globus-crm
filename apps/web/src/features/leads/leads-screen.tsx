import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { formatRelative, type Market, type StatusTone } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { FilterChip } from '@/components/ui/chip.js';
import { Input } from '@/components/ui/input.js';
import { api, type LeadRow } from '@/lib/api.js';
import {
  CreateForm,
  DataPanel,
  Field,
  PageHeader,
  SearchBox,
  errorMessage,
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

export type ScreenDataState = 'loaded' | 'empty' | 'loading' | 'error';

const STATUS_TONE: Record<string, StatusTone> = {
  New: 'info',
  Researching: 'neutral',
  Contacted: 'neutral',
  Engaged: 'brand',
  Qualified: 'success',
  Disqualified: 'neutral',
  Converted: 'success',
};

type MarketFilter = 'all' | 'US' | 'CA';
type StatusFilter = 'open' | 'all';

export function LeadsScreen({ onOpenCompany }: { onOpenCompany: (companyId: string) => void }) {
  const queryClient = useQueryClient();
  const ownerName = useUserNames();
  const leads = useQuery({ queryKey: ['leads'], queryFn: api.listLeads });
  const [search, setSearch] = useState('');
  const [market, setMarket] = useState<MarketFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      (leads.data ?? []).filter(
        (l: LeadRow) =>
          (market === 'all' || l.market === market) &&
          (status === 'all' || l.status_category !== 'closed') &&
          matches(search, l.full_name, l.email, l.firm_name, l.source),
      ),
    [leads.data, market, status, search],
  );

  const refreshRecords = () =>
    Promise.all(
      ['leads', 'deals', 'companies', 'contacts', 'tasks'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );

  const createLead = useMutation({
    mutationFn: api.createLead,
    onSuccess: async (lead) => {
      setFormOpen(false);
      setNotice(`Added ${lead.full_name} as a new lead.`);
      await refreshRecords();
    },
  });

  const convertLead = useMutation({
    mutationFn: (lead: LeadRow) => api.convertLead({ leadId: lead.id }),
    onSuccess: async (_result, lead) => {
      setNotice(`Converted ${lead.full_name}. A deal was created in New business.`);
      await refreshRecords();
    },
    onError: (err) => setNotice(errorMessage(err)),
  });

  const filtered = search !== '' || market !== 'all' || status !== 'open';

  return (
    <div className="space-y-[16px]" data-testid="leads-screen">
      <PageHeader
        kicker="Qualification pipeline"
        title="Leads"
        count={leads.data ? visible.length : undefined}
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>New lead</span>
          </Button>
        }
      />

      {notice && (
        <div
          role="status"
          className="rounded-[10px] border border-line bg-tint px-[16px] py-[10px] text-[13.5px] text-primary-ink flex items-center justify-between gap-[12px]"
        >
          <span>{notice}</span>
          <Button variant="link" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {formOpen && (
        <CreateForm
          title="New lead"
          submitLabel="Save lead"
          pending={createLead.isPending}
          error={createLead.error}
          onClose={() => setFormOpen(false)}
          onSubmit={(data) => {
            const [firstName = '', ...rest] = str(data, 'name').split(/\s+/);
            createLead.mutate({
              firstName,
              lastName: rest.join(' '),
              email: str(data, 'email'),
              firmName: str(data, 'firm') || undefined,
              title: str(data, 'title') || undefined,
              market: str(data, 'market') as Market,
            });
          }}
        >
          <Field label="Full name" error={fieldError(createLead.error, 'firstName')}>
            <Input name="name" required autoComplete="off" />
          </Field>
          <Field label="Work email" error={fieldError(createLead.error, 'email')}>
            <Input name="email" type="email" required autoComplete="off" />
          </Field>
          <Field label="Firm" optional>
            <Input name="firm" autoComplete="off" />
          </Field>
          <Field label="Job title" optional>
            <Input name="title" autoComplete="off" />
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

      <div className="flex flex-col lg:flex-row lg:items-center gap-[8px]">
        <SearchBox value={search} onChange={setSearch} label="Search name, email, firm or source" />
        <div className="flex flex-wrap gap-[8px]">
          {(['all', 'US', 'CA'] as const).map((m) => (
            <FilterChip
              key={m}
              label={m === 'all' ? 'All markets' : m === 'US' ? 'United States' : 'Canada'}
              active={market === m}
              onClick={() => setMarket(m)}
            />
          ))}
          <FilterChip
            label={status === 'open' ? 'Open leads' : 'All statuses'}
            active={status === 'open'}
            onClick={() => setStatus(status === 'open' ? 'all' : 'open')}
          />
        </div>
      </div>

      <DataPanel
        query={leads}
        isEmpty={visible.length === 0}
        emptyTitle={filtered ? 'No leads match these filters' : 'No leads yet'}
        emptyDescription={
          filtered
            ? 'Clear the search or filters to see every lead.'
            : 'Leads from the website forms appear here automatically, or add one by hand.'
        }
        emptyActionLabel={filtered ? 'Clear filters' : 'New lead'}
        onEmptyAction={() => {
          if (filtered) {
            setSearch('');
            setMarket('all');
            setStatus('open');
          } else {
            setFormOpen(true);
          }
        }}
      >
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th scope="col" className={`${thClass} pl-[16px]`}>
                Name · Firm
              </th>
              <th scope="col" className={thClass}>
                Market
              </th>
              <th scope="col" className={thClass}>
                Status
              </th>
              <th scope="col" className={thClass}>
                Source
              </th>
              <th scope="col" className={thClass}>
                Owner
              </th>
              <th scope="col" className={thClass}>
                Added
              </th>
              <th scope="col" className={thClass}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((lead) => (
              <tr key={lead.id} className={rowClass}>
                <td className={`${tdClass} pl-[16px] min-w-[240px]`}>
                  {lead.company_id ? (
                    <button
                      type="button"
                      onClick={() => onOpenCompany(lead.company_id as string)}
                      className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                    >
                      {lead.full_name}
                      {lead.firm_name ? ` · ${lead.firm_name}` : ''}
                    </button>
                  ) : (
                    <span className="font-semibold text-ink">
                      {lead.full_name}
                      {lead.firm_name ? ` · ${lead.firm_name}` : ''}
                    </span>
                  )}
                  <div className="text-[13px] text-ink-3">{lead.email}</div>
                </td>
                <td className={tdClass}>
                  <MarketBadge market={lead.market} />
                </td>
                <td className={tdClass}>
                  <StatusBadge tone={STATUS_TONE[lead.status] ?? 'neutral'}>
                    {lead.status}
                  </StatusBadge>
                </td>
                <td className={`${tdClass} text-ink-2`}>{lead.source}</td>
                <td className={`${tdClass} text-ink-2`}>{ownerName(lead.owner_user_id)}</td>
                <td className={`${tdClass} text-ink-3 whitespace-nowrap`}>
                  {formatRelative(lead.created_at)}
                </td>
                <td className={`${tdClass} text-right pr-[16px]`}>
                  {lead.status_category !== 'closed' && lead.status !== 'Converted' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={convertLead.isPending}
                      onClick={() => convertLead.mutate(lead)}
                      aria-label={`Convert ${lead.full_name} to a deal`}
                    >
                      Convert
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
    </div>
  );
}
