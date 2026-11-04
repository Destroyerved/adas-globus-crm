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

// Only screens that work on live data. Inbox, Outreach, Imports and Reports come back when
// their real connectors and data exist (docs/PROGRESS.md, "Make it real").
const VALID_SCREENS: ReadonlySet<AppScreenId> = new Set<AppScreenId>([
  'leads',
  'contacts',
  'companies',
  'company',
  'deals',
  'tasks',
]);

function readUrlState(): { screen: AppScreenId; palette: boolean; companyId: string | null } {
  const params = new URLSearchParams(window.location.search);
  const rawScreen = params.get('screen') as AppScreenId | null;
  const screen: AppScreenId = rawScreen && VALID_SCREENS.has(rawScreen) ? rawScreen : 'leads';
  return { screen, palette: params.get('palette') === '1', companyId: params.get('id') };
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
      <SignedInGate />
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
          onSignedIn={() => {
            queryClient.clear();
            window.history.replaceState({}, '', '/?screen=leads');
            void queryClient.invalidateQueries({ queryKey: ['me'] });
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
  const [companyId, setCompanyId] = useState<string | null>(initial.companyId);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(initial.palette);

  const navigateScreen = (nextScreen: AppScreenId, id: string | null = null) => {
    setActiveScreen(nextScreen);
    setCompanyId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('screen', nextScreen);
    if (id) url.searchParams.set('id', id);
    else url.searchParams.delete('id');
    url.searchParams.delete('palette');
    url.searchParams.delete('error');
    window.history.pushState({}, '', url);
  };
  const openCompany = (id: string) => navigateScreen('company', id);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    window.location.assign('/');
  };

  useEffect(() => {
    const onPopState = () => {
      const state = readUrlState();
      setActiveScreen(state.screen);
      setCompanyId(state.companyId);
      setPaletteOpen(state.palette);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <>
      <AppShell
        activeScreen={activeScreen === 'company' ? 'companies' : activeScreen}
        onNavigate={(screen) => navigateScreen(screen)}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        currentUser={user}
        onSignOut={() => void signOut()}
      >
        {activeScreen === 'leads' && <LeadsScreen onOpenCompany={openCompany} />}
        {activeScreen === 'contacts' && <ContactsScreen onOpenCompany={openCompany} />}
        {activeScreen === 'companies' && <CompaniesScreen onOpenCompany={openCompany} />}
        {activeScreen === 'company' && (
          <CompanyProfileScreen
            companyId={companyId}
            onBack={() => navigateScreen('companies')}
            onOpenDeals={() => navigateScreen('deals')}
          />
        )}
        {activeScreen === 'deals' && <DealsKanbanScreen onOpenCompany={openCompany} />}
        {activeScreen === 'tasks' && <TasksScreen />}
      </AppShell>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectScreen={(screen, id) => navigateScreen(screen, id ?? null)}
      />
    </>
  );
}
