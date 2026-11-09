import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Building2, Contact, Handshake, Search, UserPlus, X } from 'lucide-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useDebounced } from '@/features/shared/list-kit.js';
import { api } from '@/lib/api.js';

interface CommandPaletteItem {
  id: string;
  group: 'RECORDS' | 'ACTIONS' | 'NAVIGATION';
  kind?: 'company' | 'contact' | 'lead' | 'deal';
  label: string;
  meta: string;
  shortcut?: string;
  targetScreen?: AppScreenId;
  targetId?: string;
}

const NAVIGATION_ITEMS: CommandPaletteItem[] = [
  {
    id: 'nav_dashboard',
    group: 'NAVIGATION',
    label: 'Dashboard',
    meta: 'Go to your dashboard',
    shortcut: 'G H',
    targetScreen: 'dashboard',
  },
  {
    id: 'nav_leads',
    group: 'NAVIGATION',
    label: 'Leads',
    meta: 'Go to leads',
    shortcut: 'G L',
    targetScreen: 'leads',
  },
  {
    id: 'nav_contacts',
    group: 'NAVIGATION',
    label: 'Contacts',
    meta: 'Go to contacts',
    shortcut: 'G C',
    targetScreen: 'contacts',
  },
  {
    id: 'nav_companies',
    group: 'NAVIGATION',
    label: 'Companies',
    meta: 'Go to companies',
    shortcut: 'G O',
    targetScreen: 'companies',
  },
  {
    id: 'nav_deals',
    group: 'NAVIGATION',
    label: 'Deals',
    meta: 'Go to the deals board',
    shortcut: 'G D',
    targetScreen: 'deals',
  },
  {
    id: 'nav_tasks',
    group: 'NAVIGATION',
    label: 'Tasks',
    meta: 'Go to tasks',
    shortcut: 'G T',
    targetScreen: 'tasks',
  },
  {
    id: 'nav_settings',
    group: 'NAVIGATION',
    label: 'Settings',
    meta: 'People, roles, pipelines, lists and your time zone',
    targetScreen: 'settings',
  },
];

export type AppScreenId =
  | 'dashboard'
  | 'settings'
  | 'leads'
  | 'lead'
  | 'companies'
  | 'contacts'
  | 'contact'
  | 'company'
  | 'deal'
  | 'deals'
  | 'tasks'
  | 'inbox'
  | 'outreach'
  | 'imports'
  | 'duplicates'
  | 'reports'
  | 'empty'
  | 'login';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelectScreen: (screen: AppScreenId, id?: string) => void;
}

const GROUP_ORDER: Array<CommandPaletteItem['group']> = ['RECORDS', 'ACTIONS', 'NAVIGATION'];

export function CommandPalette({ open, onClose, onSelectScreen }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounced = useDebounced(query.trim(), 200);
  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.search(debounced),
    enabled: open && debounced.length >= 2,
    placeholderData: keepPreviousData,
  });

  const recordItems = useMemo<CommandPaletteItem[]>(() => {
    const r = search.data;
    if (!r || debounced.length < 2) return [];
    return [
      ...r.companies.map((c) => ({
        id: `cmp_${c.id}`,
        group: 'RECORDS' as const,
        kind: 'company' as const,
        label: c.name,
        meta: `Company · ${c.market}${c.domain ? ` · ${c.domain}` : ''}`,
        targetScreen: 'company' as const,
        targetId: c.id,
      })),
      ...r.contacts.map((c) => ({
        id: `cnt_${c.id}`,
        group: 'RECORDS' as const,
        kind: 'contact' as const,
        label: c.full_name,
        meta: `Contact · ${[c.title, c.primary_email].filter(Boolean).join(' · ')}`,
        targetScreen: 'contact' as const,
        targetId: c.id,
      })),
      ...r.leads.map((l) => ({
        id: `lead_${l.id}`,
        group: 'RECORDS' as const,
        kind: 'lead' as const,
        label: l.firm_name ? `${l.full_name} · ${l.firm_name}` : l.full_name,
        meta: `Lead · ${l.status}`,
        targetScreen: 'lead' as const,
        targetId: l.id,
      })),
      ...r.deals.map((d) => ({
        id: `deal_${d.id}`,
        group: 'RECORDS' as const,
        kind: 'deal' as const,
        label: d.name,
        meta: `Deal · ${d.stage_name}`,
        targetScreen: 'deal' as const,
        targetId: d.id,
      })),
    ];
  }, [search.data, debounced]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nav = q
      ? NAVIGATION_ITEMS.filter(
          (item) => item.label.toLowerCase().includes(q) || item.meta.toLowerCase().includes(q),
        )
      : NAVIGATION_ITEMS;
    return [...recordItems, ...nav];
  }, [query, recordItems]);

  // Reset and focus before the browser paints, so keys typed straight after opening land in
  // the search box instead of the page (or being cleared by a later reset).
  useLayoutEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const handleSelect = (item: CommandPaletteItem) => {
    if (item.targetScreen) {
      onSelectScreen(item.targetScreen, item.targetId);
    }
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (filteredItems.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % filteredItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const currentItem = filteredItems[activeIndex];
      const currentGroupIdx = currentItem ? GROUP_ORDER.indexOf(currentItem.group) : 0;
      const nextGroup = GROUP_ORDER[(currentGroupIdx + 1) % GROUP_ORDER.length];
      const nextIdx = filteredItems.findIndex((it) => it.group === nextGroup);
      if (nextIdx >= 0) {
        setActiveIndex(nextIdx);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const current = filteredItems[activeIndex];
      if (current) {
        handleSelect(current);
      }
    }
  };

  const getItemIcon = (item: CommandPaletteItem) => {
    if (item.kind === 'company')
      return <Building2 size={16} strokeWidth={1.6} aria-hidden="true" />;
    if (item.kind === 'deal') return <Handshake size={16} strokeWidth={1.6} aria-hidden="true" />;
    if (item.kind === 'contact') return <Contact size={16} strokeWidth={1.6} aria-hidden="true" />;
    if (item.kind === 'lead') return <UserPlus size={16} strokeWidth={1.6} aria-hidden="true" />;
    return <ArrowRight size={16} strokeWidth={1.6} aria-hidden="true" />;
  };

  let runningIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-[16px]"
      style={{ backgroundColor: 'var(--scrim)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-testid="command-palette"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-[640px] bg-surface border border-line rounded-[14px] overflow-hidden"
        style={{ boxShadow: 'var(--shadow-dialog)' }}
      >
        <div className="flex items-center gap-[10px] px-[16px] py-[12px] border-b border-line">
          <Search size={18} strokeWidth={1.6} className="text-ink-3 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder="Search companies, contacts, deals or type a command…"
            aria-label="Search records or commands"
            className="w-full bg-transparent border-0 text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close command palette"
            className="inline-flex items-center justify-center h-[28px] w-[28px] rounded-pill text-ink-3 hover:bg-bg-alt hover:text-ink cursor-pointer border-0 bg-transparent"
          >
            <X size={16} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>

        <div
          className="max-h-[380px] overflow-y-auto p-[8px]"
          role="listbox"
          aria-label="Command results"
        >
          {filteredItems.length === 0 ? (
            <div className="py-[32px] px-[16px] text-center text-ink-2 text-[14px]">
              {query.trim().length < 2
                ? 'Type at least two letters to search records.'
                : search.isFetching
                  ? 'Searching…'
                  : search.isError
                    ? "Search isn't available right now. Try again."
                    : 'No matching records. Try a firm name, a person or an email.'}
            </div>
          ) : (
            GROUP_ORDER.map((group) => {
              const itemsInGroup = filteredItems.filter((item) => item.group === group);
              if (itemsInGroup.length === 0) {
                return null;
              }
              return (
                <div key={group} className="mb-[8px] last:mb-0">
                  <div className="px-[10px] py-[6px] text-eyebrow text-ink-3">{group}</div>
                  {itemsInGroup.map((item) => {
                    runningIndex += 1;
                    const itemIndex = runningIndex;
                    const isSelected = itemIndex === activeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onMouseEnter={() => setActiveIndex(itemIndex)}
                        onClick={() => handleSelect(item)}
                        className={`w-full flex items-center justify-between gap-[12px] px-[12px] py-[8px] rounded-[8px] text-left cursor-pointer border-0 transition-colors duration-120 ${
                          isSelected
                            ? 'bg-tint text-ink'
                            : 'bg-transparent text-ink hover:bg-bg-alt'
                        }`}
                      >
                        <div className="flex items-center gap-[10px] min-w-0">
                          <span className={isSelected ? 'text-primary-ink' : 'text-ink-2'}>
                            {getItemIcon(item)}
                          </span>
                          <div className="min-w-0">
                            <div className="text-[14px] font-semibold text-ink truncate">
                              {item.label}
                            </div>
                            <div
                              className={`text-[12.5px] ${
                                isSelected ? 'text-ink-2' : 'text-ink-3'
                              } truncate`}
                            >
                              {item.meta}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-[8px] shrink-0">
                          {item.shortcut && (
                            <kbd className="px-[7px] py-[2px] rounded-[6px] bg-bg-alt border border-line text-mono text-[11.5px] text-ink-2">
                              {item.shortcut}
                            </kbd>
                          )}
                          <ArrowRight
                            size={14}
                            strokeWidth={1.6}
                            className={isSelected ? 'text-primary-ink' : 'text-ink-3'}
                            aria-hidden="true"
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-[12px] px-[16px] py-[8px] bg-bg-alt border-t border-line text-[12px] text-ink-3">
          <span>
            <strong className="font-semibold text-ink-2">↑↓</strong> to navigate ·{' '}
            <strong className="font-semibold text-ink-2">Tab</strong> to switch group ·{' '}
            <strong className="font-semibold text-ink-2">Enter</strong> to open
          </span>
          <span>
            <strong className="font-semibold text-ink-2">Esc</strong> to close
          </span>
        </div>
      </div>
    </div>
  );
}
