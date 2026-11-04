import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Bell,
  Building2,
  CheckSquare,
  Handshake,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  Settings,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { StatusBadge } from '@/components/ui/badge.js';
import { type AppScreenId } from '@/features/command-palette/command-palette.js';
import { type DevUser } from '@/lib/api-client.js';

export interface AppShellProps {
  activeScreen: AppScreenId;
  onNavigate: (screen: AppScreenId) => void;
  onOpenCommandPalette: () => void;
  currentUser: DevUser;
  children: ReactNode;
}

interface NavItem {
  id: AppScreenId;
  label: string;
  icon: typeof UserPlus;
  count?: string;
}

const WORK_ITEMS: NavItem[] = [
  {
    id: 'tasks',
    label: 'Tasks & SLA',
    icon: CheckSquare,
    count: '5',
  },
  {
    id: 'inbox',
    label: 'Inbox (M365)',
    icon: Inbox,
    count: '2',
  },
  {
    id: 'empty',
    label: 'Empty state',
    icon: LayoutDashboard,
  },
];

const RECORD_ITEMS: NavItem[] = [
  {
    id: 'leads',
    label: 'Leads',
    icon: UserPlus,
    count: '12,480',
  },
  {
    id: 'company',
    label: 'Companies',
    icon: Building2,
  },
  {
    id: 'deals',
    label: 'Deals',
    icon: Handshake,
    count: '8',
  },
  {
    id: 'outreach',
    label: 'Outreach & CASL',
    icon: Send,
  },
  {
    id: 'imports',
    label: 'Imports & Merge',
    icon: Upload,
  },
  {
    id: 'reports',
    label: 'Reports & Audit',
    icon: BarChart3,
  },
];

export function AppShell({
  activeScreen,
  onNavigate,
  onOpenCommandPalette,
  currentUser,
  children,
}: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('adas_sidebar_collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState<number>(2);
  const [scrolled, setScrolled] = useState(false);
  const gChordRef = useRef<boolean>(false);

  const toggleCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('adas_sidebar_collapsed', next ? '1' : '0');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 4);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Global keyboard shortcuts (DESIGN.md §9.3)
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenCommandPalette();
        return;
      }

      const target = event.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (isInput) {
        return;
      }

      if (event.key.toLowerCase() === 'g') {
        gChordRef.current = true;
        setTimeout(() => {
          gChordRef.current = false;
        }, 900);
        return;
      }

      if (gChordRef.current) {
        gChordRef.current = false;
        const k = event.key.toLowerCase();
        if (k === 'l') {
          event.preventDefault();
          onNavigate('leads');
        } else if (k === 'o' || k === 'c') {
          event.preventDefault();
          onNavigate('company');
        } else if (k === 'd') {
          event.preventDefault();
          onNavigate('deals');
        } else if (k === 'h' || k === 'e') {
          event.preventDefault();
          onNavigate('empty');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onNavigate, onOpenCommandPalette]);

  const renderSidebarNavContent = (isCollapsedView: boolean) => (
    <div className="flex flex-col h-full justify-between p-[12px] text-sidebar-foreground select-none">
      <div className="space-y-[20px]">
        {/* Brand header (DESIGN.md §5.1) */}
        <div className="flex items-center justify-between gap-[8px] px-[6px] pt-[4px]">
          <button
            type="button"
            onClick={() => onNavigate('leads')}
            className="inline-flex items-center gap-[10px] bg-transparent border-0 p-0 cursor-pointer text-left"
            aria-label={isCollapsedView ? 'ADAS CRM home' : undefined}
          >
            <span
              className="inline-grid place-items-center w-[32px] h-[32px] rounded-[8px] bg-surface text-navy text-[12px] font-bold tracking-[0.04em] shrink-0"
              aria-hidden="true"
            >
              AGP
            </span>
            {!isCollapsedView && (
              <span className="text-[15px] font-[650] tracking-[-0.01em] text-primary-foreground truncate">
                ADAS CRM
              </span>
            )}
          </button>

          {!isCollapsedView && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              className="hidden md:inline-flex items-center justify-center h-[28px] w-[28px] rounded-[8px] bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground cursor-pointer border-0"
            >
              <PanelLeftClose size={16} strokeWidth={1.6} aria-hidden="true" />
            </button>
          )}
        </div>

        {isCollapsedView && (
          <div className="hidden md:flex justify-center">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Expand sidebar"
              className="inline-flex items-center justify-center h-[28px] w-[28px] rounded-[8px] bg-transparent hover:bg-navy-2 text-sidebar-foreground hover:text-primary-foreground cursor-pointer border-0"
            >
              <PanelLeftOpen size={16} strokeWidth={1.6} aria-hidden="true" />
            </button>
          </div>
        )}

        {/* RECORDS group (DESIGN.md §5.1, PRD §4.1) */}
        <div>
          {!isCollapsedView && (
            <div className="px-[10px] mb-[6px] text-eyebrow text-sidebar-foreground opacity-85">
              RECORDS
            </div>
          )}
          <ul className="m-0 p-0 list-none space-y-[2px]">
            {RECORD_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeScreen === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    title={isCollapsedView ? item.label : undefined}
                    onClick={() => {
                      onNavigate(item.id);
                      setMobileDrawerOpen(false);
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-full h-[36px] px-[10px] rounded-[8px] flex items-center justify-between gap-[10px] cursor-pointer border-0 transition-colors duration-120 ${
                      isActive
                        ? 'bg-navy-2 text-primary-foreground font-semibold shadow-[inset_2px_0_0_0_var(--cyan)]'
                        : 'bg-transparent text-sidebar-foreground font-medium hover:bg-navy-2 hover:text-primary-foreground'
                    }`}
                  >
                    <span className="inline-flex items-center gap-[10px] min-w-0">
                      <Icon size={18} strokeWidth={1.6} className="shrink-0" aria-hidden="true" />
                      {!isCollapsedView && (
                        <span className="text-[14px] truncate">{item.label}</span>
                      )}
                    </span>
                    {!isCollapsedView && item.count && (
                      <span className="inline-flex items-center h-[20px] px-[7px] rounded-pill bg-navy-2 text-cyan text-[11.5px] font-semibold tabular-nums">
                        {item.count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* WORK group (DESIGN.md §5) */}
        <div>
          {!isCollapsedView && (
            <div className="px-[10px] mb-[6px] text-eyebrow text-sidebar-foreground opacity-85">
              WORK
            </div>
          )}
          <ul className="m-0 p-0 list-none space-y-[2px]">
            {WORK_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeScreen === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    title={isCollapsedView ? item.label : undefined}
                    onClick={() => {
                      onNavigate(item.id);
                      setMobileDrawerOpen(false);
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-full h-[36px] px-[10px] rounded-[8px] flex items-center justify-between gap-[10px] cursor-pointer border-0 transition-colors duration-120 ${
                      isActive
                        ? 'bg-navy-2 text-primary-foreground font-semibold shadow-[inset_2px_0_0_0_var(--cyan)]'
                        : 'bg-transparent text-sidebar-foreground font-medium hover:bg-navy-2 hover:text-primary-foreground'
                    }`}
                  >
                    <span className="inline-flex items-center gap-[10px] min-w-0">
                      <Icon size={18} strokeWidth={1.6} className="shrink-0" aria-hidden="true" />
                      {!isCollapsedView && (
                        <span className="text-[14px] truncate">{item.label}</span>
                      )}
                    </span>
                    {!isCollapsedView && item.count && (
                      <span className="inline-flex items-center h-[20px] px-[7px] rounded-pill bg-navy-2 text-cyan text-[11.5px] font-semibold tabular-nums">
                        {item.count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Bottom utilities: Settings & Sign-in screen link */}
      <div className="pt-[12px] border-t border-navy-line space-y-[2px]">
        <button
          type="button"
          title={isCollapsedView ? 'Settings' : undefined}
          onClick={() => onOpenCommandPalette()}
          className="w-full h-[36px] px-[10px] rounded-[8px] flex items-center gap-[10px] bg-transparent text-sidebar-foreground font-medium hover:bg-navy-2 hover:text-primary-foreground cursor-pointer border-0 transition-colors duration-120"
        >
          <Settings size={18} strokeWidth={1.6} className="shrink-0" aria-hidden="true" />
          {!isCollapsedView && <span className="text-[14px]">Settings</span>}
        </button>
        <button
          type="button"
          title={isCollapsedView ? 'Sign-in screen' : undefined}
          onClick={() => {
            onNavigate('login');
            setMobileDrawerOpen(false);
          }}
          className="w-full h-[36px] px-[10px] rounded-[8px] flex items-center gap-[10px] bg-transparent text-sidebar-foreground font-medium hover:bg-navy-2 hover:text-primary-foreground cursor-pointer border-0 transition-colors duration-120"
        >
          <LogOut size={18} strokeWidth={1.6} className="shrink-0" aria-hidden="true" />
          {!isCollapsedView && <span className="text-[14px]">Sign-in screen</span>}
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden flex bg-bg text-ink">
      {/* Desktop Navy Sidebar (DESIGN.md §5.1) */}
      <aside
        aria-label="Primary navigation"
        style={{
          width: sidebarCollapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)',
        }}
        className="hidden md:block shrink-0 bg-navy sticky top-0 h-screen transition-[width] duration-200"
      >
        {renderSidebarNavContent(sidebarCollapsed)}
      </aside>

      {/* Mobile Drawer Sidebar (<768px, DESIGN.md §5) */}
      {mobileDrawerOpen && (
        <div
          className="fixed inset-0 z-50 md:hidden flex"
          style={{ backgroundColor: 'var(--scrim)' }}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setMobileDrawerOpen(false);
            }
          }}
        >
          <div className="w-[248px] max-w-[82vw] h-full bg-navy flex flex-col">
            <div className="flex justify-end px-[12px] pt-[10px]">
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="inline-flex items-center justify-center h-[32px] w-[32px] rounded-pill bg-transparent text-primary-foreground border-0 cursor-pointer"
              >
                <X size={18} strokeWidth={1.6} aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{renderSidebarNavContent(false)}</div>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar 56px (DESIGN.md §5.2) */}
        <header
          style={{
            height: 'var(--topbar-h)',
            backgroundColor: 'rgba(251, 252, 251, 0.94)',
            backdropFilter: 'blur(12px)',
            boxShadow: scrolled ? '0 6px 24px -18px rgba(15, 27, 42, 0.5)' : 'none',
          }}
          className="sticky top-0 z-30 border-b border-line px-[16px] md:px-[24px] flex items-center justify-between gap-[12px]"
        >
          <div className="flex items-center gap-[10px] min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(true)}
              aria-label="Open navigation menu"
              className="md:hidden inline-flex items-center justify-center h-[36px] w-[36px] rounded-pill bg-surface border border-line-strong text-ink cursor-pointer shrink-0"
            >
              <Menu size={18} strokeWidth={1.6} aria-hidden="true" />
            </button>

            {/* Search or jump to Ctrl K pill (DESIGN.md §5.2) */}
            <button
              type="button"
              onClick={onOpenCommandPalette}
              data-testid="topbar-search-trigger"
              className="h-[36px] min-w-0 flex-1 max-w-[340px] px-[14px] rounded-pill bg-surface border border-line-field hover:border-primary flex items-center justify-between gap-[8px] text-[13.5px] text-ink-3 cursor-pointer transition-colors duration-120 overflow-hidden"
            >
              <span className="inline-flex items-center gap-[8px] min-w-0 truncate">
                <Search size={15} strokeWidth={1.6} className="shrink-0" aria-hidden="true" />
                <span className="truncate">Search or jump to…</span>
              </span>
              <kbd className="hidden sm:inline-block px-[6px] py-[1px] rounded-[6px] bg-bg-alt border border-line text-mono text-[11px] text-ink-2 shrink-0">
                Ctrl K
              </kbd>
            </button>
          </div>

          <div className="flex items-center gap-[8px] shrink-0">
            {/* Mailpit sandbox notice banner/pill (PRD §8.7) */}
            <div className="hidden lg:block" title="Non-production mail routes to Mailpit">
              <StatusBadge tone="neutral">Sandbox · Live mail off</StatusBadge>
            </div>

            {/* + New menu button (DESIGN.md §5.2) */}
            <div className="relative">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setNewMenuOpen((prev) => !prev)}
                aria-expanded={newMenuOpen}
                aria-haspopup="menu"
              >
                <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>New</span>
              </Button>

              {newMenuOpen && (
                <div
                  role="menu"
                  aria-label="Create new record"
                  style={{ boxShadow: 'var(--shadow-pop)' }}
                  className="absolute right-0 mt-[6px] w-[180px] rounded-[8px] bg-surface border border-line p-[4px] z-40"
                >
                  {(
                    [
                      ['New lead', 'leads'],
                      ['New company', 'company'],
                      ['New deal', 'deals'],
                      ['New task', 'tasks'],
                    ] as const
                  ).map(([label, target]) => (
                    <button
                      key={label}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setNewMenuOpen(false);
                        onNavigate(target);
                      }}
                      className="w-full h-[32px] px-[10px] rounded-[6px] flex items-center justify-between text-[13.5px] text-ink bg-transparent hover:bg-bg-alt cursor-pointer border-0 text-left"
                    >
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setNotificationsOpen((prev) => !prev)}
                aria-expanded={notificationsOpen}
                aria-label={`Notifications (${unreadNotifications} unread)`}
                className="relative inline-flex items-center justify-center h-[32px] w-[32px] rounded-pill bg-transparent hover:bg-bg-alt text-ink-2 hover:text-ink cursor-pointer border-0"
              >
                <Bell size={18} strokeWidth={1.6} aria-hidden="true" />
                {unreadNotifications > 0 && (
                  <span
                    className="absolute top-[5px] right-[5px] h-[7px] w-[7px] rounded-pill bg-primary"
                    aria-hidden="true"
                  />
                )}
              </button>

              {notificationsOpen && (
                <div
                  role="dialog"
                  aria-label="Notifications"
                  style={{ boxShadow: 'var(--shadow-pop)' }}
                  className="absolute right-0 mt-[6px] w-[320px] rounded-[10px] bg-surface border border-line p-[12px] z-40 space-y-[10px]"
                >
                  <div className="flex items-center justify-between border-b border-line pb-[8px]">
                    <span className="text-[13px] font-semibold text-ink">
                      Notifications ({unreadNotifications} unread)
                    </span>
                    <button
                      type="button"
                      onClick={() => setUnreadNotifications(0)}
                      className="text-[12px] font-semibold text-primary-ink hover:underline bg-transparent border-0 p-0 cursor-pointer"
                    >
                      Mark all read
                    </button>
                  </div>
                  <div className="space-y-[8px] text-[13px]">
                    <button
                      type="button"
                      onClick={() => {
                        setNotificationsOpen(false);
                        onNavigate('tasks');
                      }}
                      className="w-full text-left p-[8px] rounded-[8px] bg-bg-alt hover:bg-tint border-0 cursor-pointer"
                    >
                      <div className="font-semibold text-ink">15m Website SLA: Jane Patel</div>
                      <div className="text-[12px] text-ink-2">
                        Acme Tax &amp; Advisory LLP · 11m remaining
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNotificationsOpen(false);
                        onNavigate('inbox');
                      }}
                      className="w-full text-left p-[8px] rounded-[8px] bg-bg-alt hover:bg-tint border-0 cursor-pointer"
                    >
                      <div className="font-semibold text-ink">Inbound reply received</div>
                      <div className="text-[12px] text-ink-2">
                        Jane Patel replied · Sequence auto-stopped
                      </div>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => onNavigate('login')}
              aria-label={`${currentUser.initials} — Signed in as ${currentUser.displayName}`}
              title={`${currentUser.displayName} · ${currentUser.role}`}
              className="inline-flex items-center justify-center h-[32px] w-[32px] rounded-pill bg-tint text-primary-ink text-[12px] font-semibold cursor-pointer border border-line"
            >
              {currentUser.initials}
            </button>
          </div>
        </header>

        {/* Page body (DESIGN.md §5: 24px desktop, 16px under 768px) */}
        <main className="flex-1 p-[16px] md:p-[24px] min-w-0 max-w-full overflow-x-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
