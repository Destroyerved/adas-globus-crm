import { useEffect, useState } from 'react';
import { QueryCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AppShell } from './app-shell.js';
import { LoginScreen } from '@/features/auth/login-screen.js';
import { CommandPalette, type AppScreenId } from '@/features/command-palette/command-palette.js';
import { LeadsScreen } from '@/features/leads/leads-screen.js';
import { CompaniesScreen } from '@/features/companies/companies-screen.js';
import { CompanyProfileScreen } from '@/features/companies/company-profile-screen.js';
import { ContactsScreen } from '@/features/contacts/contacts-screen.js';
import { DealsKanbanScreen } from '@/features/deals/deals-kanban-screen.js';
import { TasksScreen } from '@/features/tasks/tasks-screen.js';
import { LeadProfileScreen } from '@/features/leads/lead-profile-screen.js';
import { ContactProfileScreen } from '@/features/contacts/contact-profile-screen.js';
import { DealProfileScreen } from '@/features/deals/deal-profile-screen.js';
import { DashboardScreen } from '@/features/dashboard/dashboard-screen.js';
import { ReportsScreen } from '@/features/reports/reports-screen.js';
import { SettingsScreen } from '@/features/settings/settings-screen.js';
import { ImportsScreen } from '@/features/imports/imports-screen.js';
import { DuplicatesScreen } from '@/features/duplicates/duplicates-screen.js';
import { ToastProvider } from '@/components/ui/toast.js';
import { ErrorState } from '@/components/ui/state-views.js';
import { ApiError, api } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';

const queryClient: QueryClient = new QueryClient({
  // A 401 from any screen means the session ended: re-check who is signed in, which
  // shows the sign-in screen (the "me" query itself is excluded to avoid a loop).
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== 'me') {
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

// Only screens that work on live data. Inbox and Outreach come back when their real connectors
// exist (docs/PROGRESS.md, "Make it real").
const VALID_SCREENS: ReadonlySet<AppScreenId> = new Set<AppScreenId>([
  'dashboard',
  'reports',
  'settings',
  'leads',
  'lead',
  'contacts',
  'contact',
  'companies',
  'company',
  'deals',
  'deal',
  'tasks',
  'imports',
  'duplicates',
]);

/** Which sidebar item is highlighted for a record page. */
const PARENT_SCREEN: Partial<Record<AppScreenId, AppScreenId>> = {
  lead: 'leads',
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
};

function readUrlState(): { screen: AppScreenId; palette: boolean; recordId: string | null } {
  const params = new URLSearchParams(window.location.search);
  const rawScreen = params.get('screen') as AppScreenId | null;
  const screen: AppScreenId = rawScreen && VALID_SCREENS.has(rawScreen) ? rawScreen : 'dashboard';
  return { screen, palette: params.get('palette') === '1', recordId: params.get('id') };
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SignedInGate />
      </ToastProvider>
    </QueryClientProvider>
  );
}

function SignedInGate() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 300_000 });
  const config = useQuery({ queryKey: ['auth-config'], queryFn: api.authConfig });

  if (me.isPending) {
    return <div className="min-h-screen grid place-items-center text-ink-3">Loading…</div>;
  }
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return (
        <LoginScreen
          microsoftSignIn={config.data?.microsoftSignIn ?? false}
          devSignIn={config.data?.devSignIn ?? false}
          adminSignIn={config.data?.adminSignIn ?? false}
          onSignedIn={() => {
            // A fresh load: nothing cached from before sign-in survives. (Clearing the cache
            // and then invalidating `me` refetched nothing, so the sign-in page stayed.)
            window.location.replace('/?screen=dashboard');
          }}
        />
      );
    }
    return (
      <div className="min-h-screen grid place-items-center p-[24px]">
        <div className="w-full max-w-[480px] bg-surface border border-line rounded-[10px]">
          <ErrorState message={errorMessage(me.error)} onRetry={() => void me.refetch()} />
        </div>
      </div>
    );
  }

  return (
    <Workspace
      user={{
        displayName: me.data.name,
        initials: initialsOf(me.data.name),
        role: me.data.role,
      }}
    />
  );
}

function Workspace({ user }: { user: { displayName: string; initials: string; role: string } }) {
  const initial = readUrlState();
  const [activeScreen, setActiveScreen] = useState<AppScreenId>(initial.screen);
  const [recordId, setRecordId] = useState<string | null>(initial.recordId);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(initial.palette);

  // Each screen starts with a clean URL; list screens add their own filters to it. Filters
  // passed here (from a dashboard number) are written first, so the list opens filtered.
  const navigateScreen = (
    nextScreen: AppScreenId,
    id: string | null = null,
    params: Record<string, string> = {},
  ) => {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('screen', nextScreen);
    if (id) url.searchParams.set('id', id);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    window.history.pushState({}, '', url);
    setActiveScreen(nextScreen);
    setRecordId(id);
    window.scrollTo({ top: 0 });
  };
  const openCompany = (id: string) => navigateScreen('company', id);
  const openContact = (id: string) => navigateScreen('contact', id);
  const openLead = (id: string) => navigateScreen('lead', id);
  const openDeal = (id: string) => navigateScreen('deal', id);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    window.location.assign('/');
  };

  useEffect(() => {
    const onPopState = () => {
      const state = readUrlState();
      setActiveScreen(state.screen);
      setRecordId(state.recordId);
      setPaletteOpen(state.palette);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <>
      <AppShell
        activeScreen={PARENT_SCREEN[activeScreen] ?? activeScreen}
        onNavigate={(screen) => navigateScreen(screen)}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenRecord={(screen, id) => navigateScreen(screen, id)}
        currentUser={user}
        onSignOut={() => void signOut()}
      >
        {activeScreen === 'dashboard' && (
          <DashboardScreen
            role={user.role}
            go={(screen, { id, ...params } = {}) => navigateScreen(screen, id ?? null, params)}
          />
        )}
        {activeScreen === 'reports' && <ReportsScreen />}
        {activeScreen === 'settings' && <SettingsScreen onOpenLead={openLead} />}
        {activeScreen === 'imports' && (
          <ImportsScreen
            importId={recordId}
            onOpen={(id) => navigateScreen('imports', id)}
            onBack={() => navigateScreen('imports')}
          />
        )}
        {activeScreen === 'duplicates' && (
          <DuplicatesScreen
            pairId={recordId}
            onOpenPair={(id) => navigateScreen('duplicates', id)}
            onBack={() => navigateScreen('duplicates')}
            onOpenRecord={(entity, id) =>
              entity === 'contact' ? openContact(id) : openCompany(id)
            }
          />
        )}
        {activeScreen === 'leads' && <LeadsScreen onOpenLead={openLead} />}
        {activeScreen === 'lead' && (
          <LeadProfileScreen
            key={recordId}
            leadId={recordId}
            onBack={() => navigateScreen('leads')}
            onOpenCompany={openCompany}
            onOpenContact={openContact}
            onOpenDeal={openDeal}
          />
        )}
        {activeScreen === 'contacts' && (
          <ContactsScreen onOpenContact={openContact} onOpenCompany={openCompany} />
        )}
        {activeScreen === 'contact' && (
          <ContactProfileScreen
            key={recordId}
            contactId={recordId}
            onBack={() => navigateScreen('contacts')}
            onOpenCompany={openCompany}
            onOpenDeal={openDeal}
            onOpenLead={openLead}
            onOpenContact={openContact}
          />
        )}
        {activeScreen === 'companies' && <CompaniesScreen onOpenCompany={openCompany} />}
        {activeScreen === 'company' && (
          <CompanyProfileScreen
            key={recordId}
            companyId={recordId}
            onBack={() => navigateScreen('companies')}
            onOpenDeals={() => navigateScreen('deals')}
            onOpenContact={openContact}
            onOpenDeal={openDeal}
            onOpenLead={openLead}
            onOpenCompany={openCompany}
          />
        )}
        {activeScreen === 'deals' && (
          <DealsKanbanScreen onOpenCompany={openCompany} onOpenDeal={openDeal} />
        )}
        {activeScreen === 'deal' && (
          <DealProfileScreen
            key={recordId}
            dealId={recordId}
            onBack={() => navigateScreen('deals')}
            onOpenCompany={openCompany}
            onOpenContact={openContact}
          />
        )}
        {activeScreen === 'tasks' && (
          <TasksScreen onOpenRecord={(screen, id) => navigateScreen(screen, id)} />
        )}
      </AppShell>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectScreen={(screen, id) => navigateScreen(screen, id ?? null)}
      />
    </>
  );
}
