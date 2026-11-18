import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { LeadSystemStatusSchema, formatRelative, type Market, type StatusTone } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api, type LeadRow } from '@/lib/api.js';
import {
  CreateForm,
  DataPanel,
  Field,
  PageHeader,
  SearchBox,
  errorMessage,
  fieldError,
  str,
  tableClass,
  thClass,
  theadRowClass,
  useUserNames,
} from '@/features/shared/live-kit.js';
import {
  FilterChips,
  ListFooter,
  OwnerFilter,
  SortHeader,
  Toolbar,
  allOf,
  can,
  rangeLabel,
  rangeParam,
  useMe,
  usePagedList,
  useSearchText,
  useUrlState,
} from '@/features/shared/list-kit.js';
import {
  SavedViewsBar,
  densityRowClass,
  densityTdClass,
  useTableDensity,
} from '@/features/shared/saved-views-bar.js';
import {
  BulkActionBar,
  BulkSelectAllBanner,
  BulkSelectHeaderCell,
  BulkSelectRowCell,
  canUseBulkActions,
  useBulkSelection,
} from '@/features/shared/bulk-action-bar.js';
import { viewerTimeZone } from '@/features/records/timeline.js';
import { ExportButton } from '@/features/exports/export-button.js';

export type ScreenDataState = 'loaded' | 'empty' | 'loading' | 'error';

export const LEAD_STATUS_TONE: Record<string, StatusTone> = {
  New: 'info',
  Researching: 'neutral',
  Contacted: 'neutral',
  Engaged: 'brand',
  Qualified: 'success',
  Disqualified: 'neutral',
  Converted: 'success',
};

const DEFAULTS = {
  q: '',
  sort: '-updatedAt',
  market: '',
  status: 'open',
  owner: '',
  source: '',
  created: '',
};

export function LeadsScreen({ onOpenLead }: { onOpenLead: (leadId: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const ownerName = useUserNames();
  const [state, setState] = useUrlState(DEFAULTS);
  const [search, setSearch] = useSearchText(state.q, (q) => setState({ q }));
  const [density, setDensity] = useTableDensity('lead');
  const [formOpen, setFormOpen] = useState(false);
  const created = rangeParam(state.created);

  const filter = allOf([
    state.market !== '' && { field: 'market', op: 'eq', value: state.market },
    state.status === 'open' && { field: 'statusCategory', op: 'neq', value: 'closed' },
    state.status !== 'open' &&
      state.status !== 'all' && { field: 'status', op: 'eq', value: state.status },
    state.owner !== '' && { field: 'ownerId', op: 'eq', value: state.owner },
    state.source !== '' && { field: 'source', op: 'eq', value: state.source },
    created !== null && { field: 'createdAt', op: 'between', value: created },
  ]);
  const { query, items, total } = usePagedList(
    ['leads', { q: state.q, sort: state.sort, filter }],
    (cursor) => api.listLeads({ q: state.q, sort: state.sort, filter, cursor, limit: 50 }),
  );
  const canBulk = canUseBulkActions(me, 'lead');
  const selection = useBulkSelection(items, JSON.stringify({ q: state.q, filter }));
  const cellClass = densityTdClass(density);

  const refreshRecords = () =>
    Promise.all(
      ['leads', 'deals', 'companies', 'contacts', 'tasks', 'board'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );

  const createLead = useMutation({
    mutationFn: api.createLead,
    onSuccess: async (lead) => {
      setFormOpen(false);
      toast(`Added ${lead.full_name} as a new lead.`);
      await refreshRecords();
    },
  });

  const convertLead = useMutation({
    mutationFn: (lead: LeadRow) => api.convertLead({ leadId: lead.id }),
    onSuccess: async (_result, lead) => {
      toast(`Converted ${lead.full_name}. A deal was created in New business.`);
      await refreshRecords();
    },
    onError: (err) => toast(errorMessage(err), 'danger'),
  });

  const filtered =
    state.q !== '' ||
    state.market !== '' ||
    state.status !== 'open' ||
    state.owner !== '' ||
    state.source !== '' ||
    created !== null;
  const clearFilters = () => {
    setSearch('');
    setState({ q: '', market: '', status: 'open', owner: '', source: '', created: '' });
  };
  const canCreate = can(me, 'leads.write');

  return (
    <div className="space-y-[16px]" data-testid="leads-screen">
      <PageHeader
        kicker="Qualification pipeline"
        title="Leads"
        count={total}
        actions={
          <>
            <ExportButton
              entity="lead"
              q={state.q}
              sort={state.sort}
              filter={filter}
              total={total}
            />
            {canCreate && (
              <Button variant="primary" onClick={() => setFormOpen(true)}>
                <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
                <span>New lead</span>
              </Button>
            )}
          </>
        }
      />

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
            <Select name="market" defaultValue="US">
              <option value="US">United States</option>
              <option value="CA">Canada</option>
            </Select>
          </Field>
        </CreateForm>
      )}

      <SavedViewsBar
        entity="lead"
        state={state}
        defaults={DEFAULTS}
        filter={filter}
        sort={state.sort}
        density={density}
        onChangeDensity={setDensity}
        onApplyView={({ params, sort }) => {
          setSearch(params['q'] ?? '');
          setState({ ...params, sort });
        }}
      />

      <Toolbar>
        <SearchBox value={search} onChange={setSearch} label="Search name, email or firm" />
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-[8px]">
          <Select
            aria-label="Market"
            value={state.market}
            onChange={(e) => setState({ market: e.target.value })}
            className="sm:w-[160px]"
          >
            <option value="">All markets</option>
            <option value="US">United States</option>
            <option value="CA">Canada</option>
          </Select>
          <Select
            aria-label="Status"
            value={state.status}
            onChange={(e) => setState({ status: e.target.value })}
            className="sm:w-[160px]"
          >
            <option value="open">Open leads</option>
            <option value="all">All statuses</option>
            {LeadSystemStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <OwnerFilter value={state.owner} onChange={(owner) => setState({ owner })} />
          {filtered && (
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      </Toolbar>
      <FilterChips
        chips={[
          ...(state.source
            ? [
                {
                  key: 'source',
                  label: `Source: ${state.source}`,
                  onRemove: () => setState({ source: '' }),
                },
              ]
            : []),
          ...(created
            ? [
                {
                  key: 'created',
                  label: `Added ${rangeLabel(created, viewerTimeZone())}`,
                  onRemove: () => setState({ created: '' }),
                },
              ]
            : []),
        ]}
      />

      <DataPanel
        query={{ ...query, isFetching: query.isFetching && !query.isFetchingNextPage }}
        isEmpty={items.length === 0}
        emptyTitle={filtered ? 'No leads match these filters' : 'No leads yet'}
        emptyDescription={
          filtered
            ? 'Clear the search or filters to see every lead.'
            : 'Leads from the website forms appear here automatically, or add one by hand.'
        }
        emptyActionLabel={filtered ? 'Clear filters' : canCreate ? 'New lead' : undefined}
        onEmptyAction={filtered ? clearFilters : () => setFormOpen(true)}
        footer={
          <ListFooter
            noun="leads"
            shown={items.length}
            total={total}
            hasMore={query.hasNextPage}
            loading={query.isFetchingNextPage}
            onMore={() => void query.fetchNextPage()}
          />
        }
      >
        {canBulk && (
          <BulkSelectAllBanner
            selection={selection}
            loadedCount={items.length}
            total={total}
            noun="leads"
          />
        )}
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              {canBulk && <BulkSelectHeaderCell selection={selection} noun="leads" />}
              <SortHeader
                label="Name · Firm"
                field="name"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                className={canBulk ? '' : 'pl-[16px]'}
              />
              <th scope="col" className={thClass}>
                Market
              </th>
              <SortHeader
                label="Status"
                field="status"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
              />
              <th scope="col" className={thClass}>
                Source
              </th>
              <th scope="col" className={thClass}>
                Owner
              </th>
              <SortHeader
                label="Last contacted"
                field="lastContactedAt"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                descFirst
              />
              <SortHeader
                label="Added"
                field="createdAt"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                descFirst
              />
              <th scope="col" className={thClass}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((lead) => {
              const selected = canBulk && selection.isSelected(lead.id);
              return (
                <tr key={lead.id} className={densityRowClass(density, selected)}>
                  {canBulk && (
                    <BulkSelectRowCell
                      id={lead.id}
                      label={lead.full_name}
                      selection={selection}
                      density={density}
                    />
                  )}
                  <td className={`${cellClass} ${canBulk ? '' : 'pl-[16px]'} min-w-[240px]`}>
                    <button
                      type="button"
                      onClick={() => onOpenLead(lead.id)}
                      className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                    >
                      {lead.full_name}
                      {lead.firm_name ? ` · ${lead.firm_name}` : ''}
                    </button>
                    <div className="text-[13px] text-ink-3">{lead.email}</div>
                    {lead.tags && lead.tags.length > 0 && (
                      <div className="flex flex-wrap gap-[4px] mt-[2px]">
                        {lead.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="inline-block px-[6px] py-[1px] rounded-pill bg-bg-alt text-[11.5px] text-ink-2"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={cellClass}>
                    <MarketBadge market={lead.market} />
                  </td>
                  <td className={cellClass}>
                    <StatusBadge tone={LEAD_STATUS_TONE[lead.status] ?? 'neutral'}>
                      {lead.status}
                    </StatusBadge>
                  </td>
                  <td className={`${cellClass} text-ink-2`}>{lead.source}</td>
                  <td className={`${cellClass} text-ink-2 whitespace-nowrap`}>
                    {ownerName(lead.owner_user_id)}
                  </td>
                  <td className={`${cellClass} text-ink-3 whitespace-nowrap`}>
                    {lead.last_contacted_at ? formatRelative(lead.last_contacted_at) : 'Never'}
                  </td>
                  <td className={`${cellClass} text-ink-3 whitespace-nowrap`}>
                    {formatRelative(lead.created_at)}
                  </td>
                  <td className={`${cellClass} text-right pr-[16px]`}>
                    {lead.status_category !== 'closed' &&
                      lead.status !== 'Converted' &&
                      can(me, 'leads.write') && (
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
              );
            })}
          </tbody>
        </table>
      </DataPanel>

      {canBulk && (
        <BulkActionBar
          entity="lead"
          selection={selection}
          total={total}
          q={state.q}
          filter={filter}
        />
      )}
    </div>
  );
}
