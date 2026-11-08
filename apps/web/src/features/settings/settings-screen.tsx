import { PageHeader } from '@/features/shared/live-kit.js';
import { can, useMe, useUrlState } from '@/features/shared/list-kit.js';
import { AuditTab } from './audit-tab.js';
import { ListsTab } from './lists-tab.js';
import { PipelinesTab } from './pipelines-tab.js';
import { PreferencesTab } from './preferences-tab.js';
import { RolesTab } from './roles-tab.js';
import { TeamsTab } from './teams-tab.js';
import { UsersTab } from './users-tab.js';

type TabId = 'preferences' | 'people' | 'teams' | 'roles' | 'pipelines' | 'lists' | 'audit';

const TABS: { id: TabId; label: string; capability: string | null }[] = [
  { id: 'people', label: 'People', capability: 'users.manage' },
  { id: 'teams', label: 'Teams', capability: 'users.manage' },
  { id: 'roles', label: 'Roles', capability: 'users.manage' },
  { id: 'pipelines', label: 'Pipelines', capability: 'settings.manage' },
  { id: 'lists', label: 'Lists', capability: 'settings.manage' },
  { id: 'audit', label: 'Audit log', capability: 'audit.read' },
  { id: 'preferences', label: 'Your preferences', capability: null },
];

/**
 * Settings (PRD 4.17). Each tab shows only for people whose role allows it; the API checks
 * the same capability on every request.
 */
export function SettingsScreen() {
  const me = useMe();
  const tabs = TABS.filter((t) => t.capability === null || can(me, t.capability));
  const [state, setState] = useUrlState({ tab: '' });
  const active = tabs.find((t) => t.id === state.tab) ?? tabs[0];

  return (
    <div className="space-y-[16px]" data-testid="settings-screen">
      <PageHeader kicker="Administration" title="Settings" />
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex gap-[20px] border-b border-line overflow-x-auto"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={t.id === active?.id}
            aria-controls="settings-panel"
            className="view-tab whitespace-nowrap"
            onClick={() => setState({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={active ? `settings-tab-${active.id}` : undefined}
      >
        {active?.id === 'people' && <UsersTab />}
        {active?.id === 'teams' && <TeamsTab />}
        {active?.id === 'roles' && <RolesTab />}
        {active?.id === 'pipelines' && <PipelinesTab />}
        {active?.id === 'lists' && <ListsTab />}
        {active?.id === 'audit' && <AuditTab />}
        {active?.id === 'preferences' && <PreferencesTab />}
      </div>
    </div>
  );
}
