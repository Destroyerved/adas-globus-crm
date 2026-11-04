import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './app-shell.js';
import { LoginScreen } from '@/features/auth/login-screen.js';
import { CommandPalette, type AppScreenId } from '@/features/command-palette/command-palette.js';
import { LeadsScreen } from '@/features/leads/leads-screen.js';
import { CompaniesScreen } from '@/features/companies/companies-screen.js';
import { CompanyProfileScreen } from '@/features/companies/company-profile-screen.js';
import { ContactsScreen } from '@/features/contacts/contacts-screen.js';
import { DealsKanbanScreen } from '@/features/deals/deals-kanban-screen.js';
import { TasksScreen } from '@/features/tasks/tasks-screen.js';
import { DEFAULT_DEV_USER, type DevUser } from '@/lib/api-client.js';
import { setDevUserId } from '@/lib/api.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// Only screens that work on live data. Inbox, Outreach, Imports and Reports come back when
// their real connectors and data exist (docs/PROGRESS.md, "Make it real").
const VALID_SCREENS: ReadonlySet<AppScreenId> = new Set<AppScreenId>([
  'login',
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

export function App() {
  const initial = readUrlState();
  const [activeScreen, setActiveScreen] = useState<AppScreenId>(initial.screen);
  const [companyId, setCompanyId] = useState<string | null>(initial.companyId);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(initial.palette);
  const [currentUser, setCurrentUser] = useState<DevUser>(DEFAULT_DEV_USER);

  const navigateScreen = (nextScreen: AppScreenId, id: string | null = null) => {
    setActiveScreen(nextScreen);
    setCompanyId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('screen', nextScreen);
    if (id) url.searchParams.set('id', id);
    else url.searchParams.delete('id');
    url.searchParams.delete('palette');
    window.history.pushState({}, '', url);
  };
  const openCompany = (id: string) => navigateScreen('company', id);

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

  if (activeScreen === 'login') {
    return (
      <QueryClientProvider client={queryClient}>
        <LoginScreen
          onSignIn={(user) => {
            setDevUserId(user.id);
            queryClient.clear();
            setCurrentUser(user);
            navigateScreen('leads');
          }}
        />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell
        activeScreen={activeScreen === 'company' ? 'companies' : activeScreen}
        onNavigate={(screen) => navigateScreen(screen)}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        currentUser={currentUser}
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
    </QueryClientProvider>
  );
}
