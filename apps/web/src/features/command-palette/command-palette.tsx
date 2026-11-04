import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight,
  Building2,
  Handshake,
  Phone,
  Search,
  Sparkles,
  UserPlus,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';

interface CommandPaletteItem {
  id: string;
  group: 'RECORDS' | 'ACTIONS' | 'NAVIGATION';
  label: string;
  meta: string;
  shortcut?: string;
  targetScreen?: AppScreenId;
  targetId?: string;
}

const NAVIGATION_ITEMS: CommandPaletteItem[] = [
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
];

export type AppScreenId =
  | 'leads'
  | 'companies'
  | 'contacts'
  | 'company'
  | 'deals'
  | 'tasks'
  | 'inbox'
  | 'outreach'
  | 'imports'
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
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: api.listCompanies,
    enabled: open,
  });
  const leads = useQuery({ queryKey: ['leads'], queryFn: api.listLeads, enabled: open });

  const allItems = useMemo<CommandPaletteItem[]>(
    () => [
      ...(companies.data ?? []).map((c) => ({
        id: `cmp_${c.id}`,
        group: 'RECORDS' as const,
        label: c.name,
        meta: `Company · ${c.market}${c.city ? ` · ${c.city}` : ''}`,
        targetScreen: 'company' as const,
        targetId: c.id,
      })),
      ...(leads.data ?? []).map((l) => ({
        id: `lead_${l.id}`,
        group: 'RECORDS' as const,
        label: l.firm_name ? `${l.full_name} · ${l.firm_name}` : l.full_name,
        meta: `Lead · ${l.status} · ${l.market}`,
        targetScreen: (l.company_id ? 'company' : 'leads') as AppScreenId,
        targetId: l.company_id ?? undefined,
      })),
      ...NAVIGATION_ITEMS,
    ],
    [companies.data, leads.data],
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // With no query, show navigation plus a few recent records.
      return [...allItems.filter((i) => i.group === 'RECORDS').slice(0, 5), ...NAVIGATION_ITEMS];
    }
    return allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.meta.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q),
    );
  }, [query, allItems]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 10);
      return () => clearTimeout(timer);
    }
    return undefined;
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
    if (
      item.id.includes('comp') ||
      item.label.includes('LLP') ||
      item.label.includes('Accountants')
    ) {
      return <Building2 size={16} strokeWidth={1.6} aria-hidden="true" />;
    }
    if (item.label.toLowerCase().includes('deal')) {
      return <Handshake size={16} strokeWidth={1.6} aria-hidden="true" />;
    }
    if (item.label.toLowerCase().includes('call')) {
      return <Phone size={16} strokeWidth={1.6} aria-hidden="true" />;
    }
    if (item.group === 'ACTIONS') {
      return <Sparkles size={16} strokeWidth={1.6} aria-hidden="true" />;
    }
    return <UserPlus size={16} strokeWidth={1.6} aria-hidden="true" />;
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
              No matching records or commands. Try searching for &ldquo;Acme&rdquo; or &ldquo;New
              deal&rdquo;.
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
