import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { formatRelative, type Market } from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { useToast } from '@/components/ui/toast.js';
import { api } from '@/lib/api.js';
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
import { CompanyPicker, type PickedCompany } from '@/features/shared/company-picker.js';
import { ExportButton } from '@/features/exports/export-button.js';

export const VERIFICATION_TONE = { valid: 'success', risky: 'warning', invalid: 'danger' } as const;

const DEFAULTS = { q: '', sort: '-updatedAt', market: '', owner: '', dnc: '' };

export function ContactsScreen({
  onOpenContact,
  onOpenCompany,
}: {
  onOpenContact: (id: string) => void;
  onOpenCompany: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const ownerName = useUserNames();
  const [state, setState] = useUrlState(DEFAULTS);
  const [search, setSearch] = useSearchText(state.q, (q) => setState({ q }));
  const [density, setDensity] = useTableDensity('contact');
  const [formOpen, setFormOpen] = useState(false);
  const [company, setCompany] = useState<PickedCompany | null>(null);

  const filter = allOf([
    state.market !== '' && { field: 'market', op: 'eq', value: state.market },
    state.owner !== '' && { field: 'ownerId', op: 'eq', value: state.owner },
    state.dnc === 'yes' && { field: 'doNotContact', op: 'eq', value: true },
    state.dnc === 'no' && { field: 'doNotContact', op: 'eq', value: false },
  ]);
  const { query, items, total } = usePagedList(
    ['contacts', { q: state.q, sort: state.sort, filter }],
    (cursor) => api.listContacts({ q: state.q, sort: state.sort, filter, cursor, limit: 50 }),
  );
  const canBulk = canUseBulkActions(me, 'contact');
  const selection = useBulkSelection(items, JSON.stringify({ q: state.q, filter }));
  const cellClass = densityTdClass(density);

  const createContact = useMutation({
    mutationFn: api.createContact,
    onSuccess: async (contact) => {
      setFormOpen(false);
      setCompany(null);
      toast(`Added ${contact.full_name}.`);
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
  });

  const filtered = state.q !== '' || state.market !== '' || state.owner !== '' || state.dnc !== '';
  const clearFilters = () => {
    setSearch('');
    setState({ q: '', market: '', owner: '', dnc: '' });
  };
  const canCreate = can(me, 'contacts.write');

  return (
    <div className="space-y-[16px]" data-testid="contacts-screen">
      <PageHeader
        kicker="People"
        title="Contacts"
        count={total}
        actions={
          <>
            <ExportButton
              entity="contact"
              q={state.q}
              sort={state.sort}
              filter={filter}
              total={total}
            />
            {canCreate && (
              <Button variant="primary" onClick={() => setFormOpen(true)}>
                <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
                <span>New contact</span>
              </Button>
            )}
          </>
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
              companyId: company?.id ?? null,
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
          <div className="grid gap-[6px] text-label text-ink">
            <span>
              Company <em className="not-italic font-normal text-ink-3">(optional)</em>
            </span>
            <CompanyPicker value={company} onChange={setCompany} />
          </div>
          <Field label="Market">
            <Select name="market" defaultValue="US">
              <option value="US">United States</option>
              <option value="CA">Canada</option>
            </Select>
          </Field>
        </CreateForm>
      )}

      <SavedViewsBar
        entity="contact"
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
        <SearchBox value={search} onChange={setSearch} label="Search name, email or company" />
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
            aria-label="Do not contact"
            value={state.dnc}
            onChange={(e) => setState({ dnc: e.target.value })}
            className="sm:w-[180px]"
          >
            <option value="">Anyone</option>
            <option value="no">Contactable</option>
            <option value="yes">Do not contact</option>
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
        emptyTitle={filtered ? 'No contacts match these filters' : 'No contacts yet'}
        emptyDescription={
          filtered
            ? 'Clear the search or filters to see everyone.'
            : 'Contacts are created from website inquiries, converted leads, or by hand.'
        }
        emptyActionLabel={filtered ? 'Clear filters' : canCreate ? 'New contact' : undefined}
        onEmptyAction={filtered ? clearFilters : () => setFormOpen(true)}
        footer={
          <ListFooter
            noun="contacts"
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
            noun="contacts"
          />
        )}
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              {canBulk && <BulkSelectHeaderCell selection={selection} noun="contacts" />}
              <SortHeader
                label="Name"
                field="name"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
                className={canBulk ? '' : 'pl-[16px]'}
              />
              <SortHeader
                label="Company"
                field="company"
                sort={state.sort}
                onSort={(sort) => setState({ sort })}
              />
              <th scope="col" className={thClass}>
                Market
              </th>
              <th scope="col" className={thClass}>
                Email
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
                      label={c.full_name}
                      selection={selection}
                      density={density}
                    />
                  )}
                  <td className={`${cellClass} ${canBulk ? '' : 'pl-[16px]'} min-w-[220px]`}>
                    <button
                      type="button"
                      onClick={() => onOpenContact(c.id)}
                      className="bg-transparent border-0 p-0 text-left font-semibold text-ink hover:underline cursor-pointer"
                    >
                      {c.full_name}
                    </button>
                    <div className="text-[13px] text-ink-3">{c.title ?? ''}</div>
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
                  <td className={`${cellClass} text-ink-2`}>
                    {c.company_id && c.company_name ? (
                      <button
                        type="button"
                        onClick={() => onOpenCompany(c.company_id as string)}
                        className="bg-transparent border-0 p-0 text-left text-ink-2 hover:underline cursor-pointer"
                      >
                        {c.company_name}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={cellClass}>
                    <MarketBadge market={c.market} />
                  </td>
                  <td className={cellClass}>
                    <div className="flex flex-wrap items-center gap-[6px]">
                      <span className="text-ink-2">{c.primary_email}</span>
                      {c.do_not_contact ? (
                        <StatusBadge tone="danger">Do not contact</StatusBadge>
                      ) : c.email_verification_status in VERIFICATION_TONE ? (
                        <StatusBadge
                          tone={
                            VERIFICATION_TONE[
                              c.email_verification_status as keyof typeof VERIFICATION_TONE
                            ]
                          }
                        >
                          {c.email_verification_status}
                        </StatusBadge>
                      ) : null}
                    </div>
                  </td>
                  <td className={`${cellClass} text-ink-2 whitespace-nowrap`}>
                    {ownerName(c.owner_user_id)}
                  </td>
                  <td className={`${cellClass} text-ink-3 whitespace-nowrap`}>
                    {c.last_contacted_at ? formatRelative(c.last_contacted_at) : 'Never'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>

      {canBulk && (
        <BulkActionBar
          entity="contact"
          selection={selection}
          total={total}
          q={state.q}
          filter={filter}
        />
      )}
    </div>
  );
}
