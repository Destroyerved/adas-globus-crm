import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './app-shell.js';
import { LoginScreen } from '@/features/auth/login-screen.js';
import { CommandPalette, type AppScreenId } from '@/features/command-palette/command-palette.js';
import { LeadsScreen, type ScreenDataState } from '@/features/leads/leads-screen.js';
import { CompanyProfileScreen } from '@/features/companies/company-profile-screen.js';
import { DealsKanbanScreen } from '@/features/deals/deals-kanban-screen.js';
import { EmptyShowcaseScreen } from '@/features/empty/empty-screen.js';
import { TasksScreen } from '@/features/tasks/tasks-screen.js';
import { InboxScreen } from '@/features/inbox/inbox-screen.js';
import { OutreachScreen } from '@/features/outreach/outreach-screen.js';
import { ImportsDuplicatesScreen } from '@/features/data-quality/imports-duplicates-screen.js';
import { ReportsIntelligenceScreen } from '@/features/reports/reports-intelligence-screen.js';
import { DEFAULT_DEV_USER, type DevUser } from '@/lib/api-client.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const VALID_SCREENS: ReadonlySet<AppScreenId> = new Set<AppScreenId>([
  'login',
  'leads',
  'company',
  'deals',
  'tasks',
  'inbox',
  'outreach',
  'imports',
  'reports',
  'empty',
]);

function readUrlState(): {
  screen: AppScreenId;
  palette: boolean;
  dataState: ScreenDataState;
} {
  const params = new URLSearchParams(window.location.search);
  const rawScreen = params.get('screen') as AppScreenId | null;
  const screen: AppScreenId = rawScreen && VALID_SCREENS.has(rawScreen) ? rawScreen : 'leads';
  const palette = params.get('palette') === '1';
  const rawState = params.get('state');
  const dataState: ScreenDataState =
    rawState === 'empty' || rawState === 'loading' || rawState === 'error' ? rawState : 'loaded';

  return { screen, palette, dataState };
}

export function App() {
  const initial = readUrlState();
  const [activeScreen, setActiveScreen] = useState<AppScreenId>(initial.screen);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(initial.palette);
  const [leadsInitialState] = useState<ScreenDataState>(initial.dataState);
  const [currentUser, setCurrentUser] = useState<DevUser>(DEFAULT_DEV_USER);

  const navigateScreen = (nextScreen: AppScreenId) => {
    setActiveScreen(nextScreen);
    const url = new URL(window.location.href);
    url.searchParams.set('screen', nextScreen);
    url.searchParams.delete('palette');
    window.history.pushState({}, '', url);
  };

  useEffect(() => {
    const onPopState = () => {
      const state = readUrlState();
      setActiveScreen(state.screen);
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
        activeScreen={activeScreen}
        onNavigate={navigateScreen}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        currentUser={currentUser}
      >
        {activeScreen === 'leads' && (
          <LeadsScreen
            initialState={leadsInitialState}
            onOpenCompany={() => navigateScreen('company')}
          />
        )}
        {activeScreen === 'company' && (
          <CompanyProfileScreen onOpenDeals={() => navigateScreen('deals')} />
        )}
        {activeScreen === 'deals' && (
          <DealsKanbanScreen onOpenCompany={() => navigateScreen('company')} />
        )}
        {activeScreen === 'tasks' && <TasksScreen />}
        {activeScreen === 'inbox' && <InboxScreen />}
        {activeScreen === 'outreach' && <OutreachScreen />}
        {activeScreen === 'imports' && <ImportsDuplicatesScreen />}
        {activeScreen === 'reports' && <ReportsIntelligenceScreen />}
        {activeScreen === 'empty' && (
          <EmptyShowcaseScreen onGoToLeads={() => navigateScreen('leads')} />
        )}
      </AppShell>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectScreen={navigateScreen}
      />
    </QueryClientProvider>
  );
}
