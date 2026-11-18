import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { AccountStatusSchema, formatNumber, formatRelative, type Market } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { api } from '@/lib/api.js';
import { ExportButton } from '@/features/exports/export-button.js';
import {
  CreateForm,
  DataPanel,
  Field,
  PageHeader,
  SearchBox,
  fieldError,
  str,
  tableClass,
  thClass,
  theadRowClass,
  useUserNames,
} from '@/features/shared/live-kit.js';
import {
  ListFooter,
  OwnerFilter,
  SortHeader,
  Toolbar,
  allOf,
  can,
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

export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  prospect: 'Prospect',
  client: 'Active client',
  former_client: 'Former client',
  partner: 'Partner',
  do_not_contact: 'Do not contact',
};

export function accountStatusTone(status: string) {
  return status === 'client' ? 'success' : status === 'do_not_contact' ? 'danger' : 'neutral';
}

const DEFAULTS = { q: '', sort: '-updatedAt', market: '', status: '', owner: '' };

export function CompaniesScreen({ onOpenCompany }: { onOpenCompany: (id: string) => void }) {
  const queryClient = useQueryClient();
  const me = useMe();
  const ownerName = useUserNames();
  const [state, setState] = useUrlState(DEFAULTS);
  const [search, setSearch] = useSearchText(state.q, (q) => setState({ q }));
  const [density, setDensity] = useTableDensity('company');
  const [formOpen, setFormOpen] = useState(false);

  const filter = allOf([
    state.market !== '' && { field: 'market', op: 'eq', value: state.market },
    state.status !== '' && { field: 'accountStatus', op: 'eq', value: state.status },
    state.owner !== '' && { field: 'ownerId', op: 'eq', value: state.owner },
  ]);
  const { query, items, total } = usePagedList(
    ['companies', { q: state.q, sort: state.sort, filter }],
    (cursor) => api.listCompanies({ q: state.q, sort: state.sort, filter, cursor, limit: 50 }),
  );
  const canBulk = canUseBulkActions(me, 'company');
  const selection = useBulkSelection(items, JSON.stringify({ q: state.q, filter }));
  const cellClass = densityTdClass(density);

  const createCompany = useMutation({
    mutationFn: api.createCompany,
    onSuccess: async (result) => {
      setFormOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      onOpenCompany(result.company.id);
    },
  });

  const filtered =
    state.q !== '' || state.market !== '' || state.status !== '' || state.owner !== '';
  const clearFilters = () => {
    setSearch('');
    setState({ q: '', market: '', status: '', owner: '' });
  };
  const canCreate = can(me, 'companies.write');

  return (
    <div className="space-y-[16px]" data-testid="companies-screen">
      <PageHeader
        kicker="Accounts"
        title="Companies"
        count={total}
        actions={
          <>
            <ExportButton
              entity="company"
              q={state.q}
              sort={state.sort}
              filter={filter}
              total={total}
            />
            {canCreate && (
              <Button variant="primary" onClick={() => setFormOpen(true)}>
                <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
                <span>New company</span>
              </Button>
            )}
          </>
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
          <Field
            label="Website"
            optional
            error={fieldError(createCompany.error, 'websiteOrDomain')}
          >
            <Input name="website" placeholder="firm.com" autoComplete="off" />
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
        entity="company"
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
        <SearchBox value={search} onChange={setSearch} label="Search name or domain" />
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
            aria-label="Account status"
            value={state.status}
            onChange={(e) => setState({ status: e.target.value })}
            className="sm:w-[170px]"
          >
            <option value="">Any status</option>
            {AccountStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {ACCOUNT_STATUS_LABEL[s] ?? s}
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

      <DataPanel
        query={{ ...query, isFetching: query.isFetching && !query.isFetchingNextPage }}
        isEmpty={items.length === 0}
        emptyTitle={filtered ? 'No companies match these filters' : 'No companies yet'}
        emptyDescription={
          filtered
            ? 'Try the firm’s domain, or clear the filters.'
            : 'Companies are created from website inquiries, converted leads, or by hand.'
        }
        emptyActionLabel={filtered ? 'Clear filters' : canCreate ? 'New company' : undefined}
        onEmptyAction={filtered ? clearFilters : () => setFormOpen(true)}
        footer={
          <ListFooter
            noun="companies"
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
            noun="companies"
          />
        )}
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              {canBulk && <BulkSelectHeaderCell selection={selection} noun="companies" />}
              <SortHeader
                label="Company"
                field="name"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                className={canBulk ? '' : 'pl-[16px]'}
              />
              <th scope="col" className={thClass}>
                Market
              </th>
              <th scope="col" className={thClass}>
                Location
              </th>
              <th scope="col" className={thClass}>
                Status
              </th>
              <th scope="col" className={`${thClass} text-right`}>
                Contacts
              </th>
              <th scope="col" className={`${thClass} text-right`}>
                Open deals
              </th>
              <th scope="col" className={thClass}>
                Owner
              </th>
              <SortHeader
                label="Updated"
                field="updatedAt"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                descFirst
              />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => {
              const selected = canBulk && selection.isSelected(c.id);
              return (
                <tr key={c.id} className={densityRowClass(density, selected)}>
                  {canBulk && (
                    <BulkSelectRowCell
                      id={c.id}
                      label={c.name}
                      selection={selection}
                      density={density}
                    />
                  )}
                  <td className={`${cellClass} ${canBulk ? '' : 'pl-[16px]'} min-w-[220px]`}>
                    <button
                      type="button"
                      onClick={() => onOpenCompany(c.id)}
                      className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                    >
                      {c.name}
                    </button>
                    <div className="text-[13px] text-ink-3">{c.domain ?? 'No website'}</div>
                    {c.tags && c.tags.length > 0 && (
                      <div className="flex flex-wrap gap-[4px] mt-[2px]">
                        {c.tags.slice(0, 3).map((tag) => (
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
                    <MarketBadge market={c.market} />
                  </td>
                  <td className={`${cellClass} text-ink-2`}>
                    {[c.city, c.state_province].filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className={cellClass}>
                    <StatusBadge tone={accountStatusTone(c.account_status)}>
                      {ACCOUNT_STATUS_LABEL[c.account_status] ?? c.account_status}
                    </StatusBadge>
                  </td>
                  <td className={`${cellClass} text-right tabular-nums text-ink-2`}>
                    {formatNumber(c.contact_count ?? 0)}
                  </td>
                  <td className={`${cellClass} text-right tabular-nums text-ink-2`}>
                    {formatNumber(c.open_deal_count ?? 0)}
                  </td>
                  <td className={`${cellClass} text-ink-2 whitespace-nowrap`}>
                    {ownerName(c.owner_user_id)}
                  </td>
                  <td className={`${cellClass} text-ink-3 whitespace-nowrap`}>
                    {formatRelative(c.updated_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>

      {canBulk && (
        <BulkActionBar
          entity="company"
          selection={selection}
          total={total}
          q={state.q}
          filter={filter}
        />
      )}
    </div>
  );
}
