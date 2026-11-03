import { useMemo, useRef, useState, useEffect } from 'react';
import {
  ArrowUpDown,
  ClockAlert,
  Download,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatPersonWithCompany,
  formatRelative,
  type Market,
} from '@adas/shared';
import { Button } from '@/components/ui/button.js';
import { MarketBadge, StatusBadge } from '@/components/ui/badge.js';
import { AddFilterChip, FilterChip } from '@/components/ui/chip.js';
import { Input } from '@/components/ui/input.js';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/state-views.js';
import { SYNTHETIC_LEADS, SYNTHETIC_LEADS_TOTAL } from '@/lib/synthetic-data.js';

export type ScreenDataState = 'loaded' | 'empty' | 'loading' | 'error';

export interface LeadsScreenProps {
  initialState?: ScreenDataState;
  initialSelectedIds?: string[];
  onOpenCompany: (companyId: string) => void;
}

const REFERENCE_NOW = '2026-11-04T14:30:00Z';

export function LeadsScreen({
  initialState = 'loaded',
  initialSelectedIds = ['lead_01', 'lead_02'],
  onOpenCompany,
}: LeadsScreenProps) {
  const [viewTab, setViewTab] = useState<'all' | 'mine' | 'website' | 'unassigned'>('all');
  const [dataState, setDataState] = useState<ScreenDataState>(initialState);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [marketFilter, setMarketFilter] = useState<Market | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDataState(initialState);
  }, [initialState]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (isInput) {
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const filteredLeads = useMemo(() => {
    if (dataState === 'empty') {
      return [];
    }
    return SYNTHETIC_LEADS.filter((lead) => {
      if (viewTab === 'mine' && lead.ownerName !== 'Arjun Mehta') {
        return false;
      }
      if (viewTab === 'website' && !lead.source.startsWith('Website')) {
        return false;
      }
      if (marketFilter && lead.market !== marketFilter) {
        return false;
      }
      if (statusFilter && lead.status !== statusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        return (
          lead.contactName.toLowerCase().includes(q) ||
          lead.companyName.toLowerCase().includes(q) ||
          lead.email.toLowerCase().includes(q) ||
          lead.source.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [dataState, viewTab, marketFilter, statusFilter, searchQuery]);

  const allVisibleSelected =
    filteredLeads.length > 0 && filteredLeads.every((row) => selectedIds.includes(row.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredLeads.map((row) => row.id));
    }
  };

  const toggleRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const rowHeightClass = density === 'compact' ? 'h-[36px]' : 'h-[44px]';

  return (
    <div className="space-y-[16px] pb-[64px]" data-testid="leads-screen">
      {/* Page header (DESIGN.md §5.3) */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-[12px]">
        <div>
          <div className="kicker mb-[4px]">Qualification pipeline</div>
          <h1 className="text-display text-ink m-0">
            <strong>Leads</strong>{' '}
            <span className="text-ink-3 font-light tabular-nums">
              {formatNumber(SYNTHETIC_LEADS_TOTAL)}
            </span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button variant="outline" onClick={() => setDataState('empty')}>
            <Upload size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>Import leads</span>
          </Button>
          <Button variant="primary">
            <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
            <span>New lead</span>
          </Button>
        </div>
      </div>

      {/* View tabs (DESIGN.md §5.3) */}
      <div
        className="flex items-center gap-[20px] border-b border-line overflow-x-auto"
        role="tablist"
        aria-label="Lead views"
      >
        <button
          type="button"
          role="tab"
          aria-selected={viewTab === 'all' && dataState === 'loaded'}
          onClick={() => {
            setViewTab('all');
            setDataState('loaded');
          }}
          className="view-tab"
        >
          <span>All leads</span>
          <span className="text-ink-3 text-[12.5px] tabular-nums">12,480</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewTab === 'mine' && dataState === 'loaded'}
          onClick={() => {
            setViewTab('mine');
            setDataState('loaded');
          }}
          className="view-tab"
        >
          <span>My open leads</span>
          <span className="text-ink-3 text-[12.5px] tabular-nums">142</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewTab === 'website' && dataState === 'loaded'}
          onClick={() => {
            setViewTab('website');
            setDataState('loaded');
          }}
          className="view-tab"
        >
          <span>Website inquiries</span>
          <span className="text-ink-3 text-[12.5px] tabular-nums">18</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={dataState === 'empty'}
          onClick={() => setDataState('empty')}
          className="view-tab"
        >
          <span>Empty state</span>
        </button>
      </div>

      {/* Filter chips, list search, density and state controls (DESIGN.md §5, §6.3) */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-[12px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <FilterChip
            label="Market"
            value={marketFilter ?? 'All (US & CA)'}
            active={marketFilter !== null}
            onClick={() =>
              setMarketFilter((prev) => (prev === null ? 'US' : prev === 'US' ? 'CA' : null))
            }
            onRemove={marketFilter ? () => setMarketFilter(null) : undefined}
          />
          <FilterChip
            label="Status"
            value={statusFilter ?? 'Open & Qualified'}
            active={statusFilter !== null}
            onClick={() =>
              setStatusFilter((prev) =>
                prev === null ? 'Qualified' : prev === 'Qualified' ? 'Engaged' : null,
              )
            }
            onRemove={statusFilter ? () => setStatusFilter(null) : undefined}
          />
          <AddFilterChip
            onClick={() => {
              setMarketFilter('US');
              setStatusFilter('Qualified');
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-[8px]">
          <div className="relative w-full sm:w-[240px]">
            <Search
              size={15}
              strokeWidth={1.6}
              className="absolute left-[11px] top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
              aria-hidden="true"
            />
            <Input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter list… (/)"
              aria-label="Filter leads list"
              className="pl-[32px]"
            />
          </div>

          <div
            className="inline-flex items-center rounded-pill border border-line-strong bg-surface p-[2px]"
            role="group"
            aria-label="Row density"
          >
            <button
              type="button"
              aria-pressed={density === 'comfortable'}
              onClick={() => setDensity('comfortable')}
              className={`h-[28px] px-[10px] rounded-pill text-[12.5px] font-semibold cursor-pointer border-0 ${
                density === 'comfortable'
                  ? 'bg-navy text-primary-foreground'
                  : 'bg-transparent text-ink-2'
              }`}
            >
              Comfortable
            </button>
            <button
              type="button"
              aria-pressed={density === 'compact'}
              onClick={() => setDensity('compact')}
              className={`h-[28px] px-[10px] rounded-pill text-[12.5px] font-semibold cursor-pointer border-0 ${
                density === 'compact'
                  ? 'bg-navy text-primary-foreground'
                  : 'bg-transparent text-ink-2'
              }`}
            >
              Compact
            </button>
          </div>

          <div
            className="inline-flex items-center rounded-pill border border-line bg-surface p-[2px]"
            role="group"
            aria-label="Screen state preview"
          >
            {(['loaded', 'empty', 'loading', 'error'] as const).map((st) => (
              <button
                key={st}
                type="button"
                aria-pressed={dataState === st}
                onClick={() => setDataState(st)}
                className={`h-[28px] px-[9px] rounded-pill text-[12px] font-medium capitalize cursor-pointer border-0 ${
                  dataState === st
                    ? 'bg-tint text-primary-ink font-semibold'
                    : 'bg-transparent text-ink-3'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* White panel with hairline table or state view (DESIGN.md §6.5, §6.13) */}
      <div className="bg-surface border border-line rounded-[10px] overflow-hidden">
        {dataState === 'loading' && <LoadingState rows={7} />}

        {dataState === 'error' && (
          <ErrorState
            message="Could not load leads from the server. Check your connection and try again."
            requestId="req_01jc9x8k2m4p7v"
            onRetry={() => setDataState('loaded')}
          />
        )}

        {(dataState === 'empty' || (dataState === 'loaded' && filteredLeads.length === 0)) && (
          <EmptyState
            title={
              searchQuery || marketFilter || statusFilter
                ? 'No leads match these filters'
                : 'No leads yet'
            }
            description={
              searchQuery || marketFilter || statusFilter
                ? 'Try clearing a filter chip or searching by company domain.'
                : 'Import a spreadsheet from Apollo or Bigin, or add a prospect by hand.'
            }
            actionLabel={
              searchQuery || marketFilter || statusFilter ? 'Clear filters' : 'Import leads'
            }
            actionVariant="primary"
            onAction={() => {
              setMarketFilter(null);
              setStatusFilter(null);
              setSearchQuery('');
              setDataState('loaded');
            }}
          />
        )}

        {dataState === 'loaded' && filteredLeads.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="h-[36px] border-b border-line bg-surface text-label text-ink-3">
                  <th scope="col" className="w-[40px] pl-[16px] pr-[8px]">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all visible leads"
                      className="h-[16px] w-[16px] rounded-[4px] accent-primary cursor-pointer"
                    />
                  </th>
                  <th scope="col" className="px-[12px] min-w-[240px]">
                    <span className="inline-flex items-center gap-[4px]">
                      <span>Name · Firm</span>
                      <ArrowUpDown size={13} strokeWidth={1.6} aria-hidden="true" />
                    </span>
                  </th>
                  <th scope="col" className="px-[12px] w-[80px]">
                    Market
                  </th>
                  <th scope="col" className="px-[12px] w-[130px]">
                    Status
                  </th>
                  <th scope="col" className="px-[12px] min-w-[160px]">
                    Source
                  </th>
                  <th scope="col" className="px-[12px] min-w-[140px]">
                    Owner
                  </th>
                  <th scope="col" className="px-[12px] min-w-[120px]">
                    Last contacted
                  </th>
                  <th scope="col" className="px-[12px] min-w-[140px]">
                    Next follow-up
                  </th>
                  <th scope="col" aria-label="Actions" className="w-[52px] pr-[16px] text-right" />
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map((lead) => {
                  const isSelected = selectedIds.includes(lead.id);
                  return (
                    <tr
                      key={lead.id}
                      className={`${rowHeightClass} border-b border-line last:border-b-0 transition-colors duration-120 ${
                        isSelected
                          ? 'bg-tint shadow-[inset_2px_0_0_0_var(--primary)]'
                          : 'hover:bg-bg-alt'
                      }`}
                    >
                      <td className="pl-[16px] pr-[8px]">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(lead.id)}
                          aria-label={`Select ${lead.contactName}`}
                          className="h-[16px] w-[16px] rounded-[4px] accent-primary cursor-pointer"
                        />
                      </td>
                      <td className="px-[12px]">
                        <div className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => onOpenCompany(lead.companyId)}
                            className="text-left font-semibold text-ink hover:underline cursor-pointer bg-transparent border-0 p-0 truncate max-w-[300px]"
                          >
                            {formatPersonWithCompany(lead.contactName, lead.companyName)}
                          </button>
                          <span
                            className={`text-body-sm ${
                              isSelected ? 'text-ink-2' : 'text-ink-3'
                            } truncate max-w-[300px]`}
                          >
                            {lead.contactTitle} · {lead.email}
                          </span>
                        </div>
                      </td>
                      <td className="px-[12px]">
                        <MarketBadge market={lead.market} />
                      </td>
                      <td className="px-[12px]">
                        <StatusBadge tone={lead.statusTone}>{lead.status}</StatusBadge>
                      </td>
                      <td className="px-[12px] text-ink-2 whitespace-nowrap">{lead.source}</td>
                      <td className="px-[12px] whitespace-nowrap">
                        <span className="inline-flex items-center gap-[8px]">
                          <span
                            className="inline-grid place-items-center h-[24px] w-[24px] rounded-pill bg-tint text-primary-ink text-[11px] font-semibold"
                            aria-hidden="true"
                          >
                            {lead.ownerInitials}
                          </span>
                          <span className="text-ink-2">{lead.ownerName}</span>
                        </span>
                      </td>
                      <td
                        className="px-[12px] text-ink-2 whitespace-nowrap"
                        title={
                          lead.lastContactedAt
                            ? formatDateTime(lead.lastContactedAt, 'Asia/Kolkata')
                            : undefined
                        }
                      >
                        {lead.lastContactedAt ? (
                          formatRelative(lead.lastContactedAt, REFERENCE_NOW)
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="px-[12px] whitespace-nowrap">
                        {lead.nextFollowUpAt ? (
                          lead.overdueFollowUp ? (
                            <StatusBadge
                              tone="danger"
                              icon={<ClockAlert size={13} strokeWidth={1.6} aria-hidden="true" />}
                            >
                              Overdue · Today
                            </StatusBadge>
                          ) : (
                            <span className="text-ink-2">
                              {formatDate(lead.nextFollowUpAt, 'UTC')}
                            </span>
                          )
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="pr-[16px] text-right">
                        <button
                          type="button"
                          onClick={() => onOpenCompany(lead.companyId)}
                          aria-label={`More actions for ${lead.contactName}`}
                          className="inline-flex items-center justify-center h-[32px] w-[32px] rounded-pill text-ink-2 hover:bg-bg-alt hover:text-ink cursor-pointer border-0 bg-transparent"
                        >
                          <MoreHorizontal size={16} strokeWidth={1.6} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Floating navy bulk-action bar on selection (DESIGN.md §6.5) */}
      {selectedIds.length > 0 && dataState === 'loaded' && (
        <div
          className="fixed bottom-[20px] left-1/2 -translate-x-1/2 z-30 flex items-center gap-[6px] sm:gap-[10px] px-[16px] py-[8px] rounded-pill bg-navy text-primary-foreground border border-navy-line max-w-[calc(100vw-24px)] overflow-x-auto"
          style={{ boxShadow: 'var(--shadow-pop)' }}
          role="region"
          aria-label="Bulk actions"
          data-testid="bulk-action-bar"
        >
          <span className="text-[13px] font-semibold whitespace-nowrap">
            <span className="text-cyan tabular-nums">{selectedIds.length}</span> selected
          </span>
          <span className="text-navy-line" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            className="h-[30px] px-[10px] rounded-pill bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground text-[13px] font-medium cursor-pointer border-0 whitespace-nowrap"
          >
            Assign
          </button>
          <button
            type="button"
            className="h-[30px] px-[10px] rounded-pill bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground text-[13px] font-medium cursor-pointer border-0 whitespace-nowrap"
          >
            Change status
          </button>
          <button
            type="button"
            className="hidden sm:inline-flex items-center h-[30px] px-[10px] rounded-pill bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground text-[13px] font-medium cursor-pointer border-0 whitespace-nowrap"
          >
            Add tag
          </button>
          <button
            type="button"
            className="hidden md:inline-flex items-center gap-[5px] h-[30px] px-[10px] rounded-pill bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground text-[13px] font-medium cursor-pointer border-0 whitespace-nowrap"
          >
            <Download size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>Export</span>
          </button>
          <button
            type="button"
            className="hidden sm:inline-flex items-center gap-[5px] h-[30px] px-[10px] rounded-pill bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground text-[13px] font-medium cursor-pointer border-0 whitespace-nowrap"
          >
            <SlidersHorizontal size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>More</span>
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            aria-label="Clear selection"
            className="inline-flex items-center justify-center h-[28px] w-[28px] rounded-pill bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground cursor-pointer border-0 shrink-0"
          >
            <X size={15} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
