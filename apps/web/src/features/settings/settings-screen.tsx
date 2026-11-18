import { PageHeader } from '@/features/shared/live-kit.js';
import { can, useMe, useUrlState } from '@/features/shared/list-kit.js';
import { AuditTab } from './audit-tab.js';
import { CurrenciesTab } from './currencies-tab.js';
import { CustomFieldsTab } from './custom-fields-tab.js';
import { IntegrationsTab } from './integrations-tab.js';
import { ListsTab } from './lists-tab.js';
import { PipelinesTab } from './pipelines-tab.js';
import { PreferencesTab } from './preferences-tab.js';
import { RolesTab } from './roles-tab.js';
import { RoutingTab } from './routing-tab.js';
import { ScoringTab } from './scoring-tab.js';
import { SuppressionsTab } from './suppressions-tab.js';
import { SystemHealthTab } from './system-health-tab.js';
import { TeamsTab } from './teams-tab.js';
import { UsersTab } from './users-tab.js';
import { WebhooksTab } from './webhooks-tab.js';

type TabId =
  | 'preferences'
  | 'people'
  | 'teams'
  | 'roles'
  | 'pipelines'
  | 'routing'
  | 'custom-fields'
  | 'scoring'
  | 'currencies'
  | 'lists'
  | 'integrations'
  | 'webhooks'
  | 'system-health'
  | 'suppressions'
  | 'audit';

const TABS: { id: TabId; label: string; capability: string | null }[] = [
  { id: 'people', label: 'People', capability: 'users.manage' },
  { id: 'teams', label: 'Teams', capability: 'users.manage' },
  { id: 'roles', label: 'Roles', capability: 'users.manage' },
  { id: 'pipelines', label: 'Pipelines', capability: 'settings.manage' },
  { id: 'routing', label: 'Routing', capability: 'settings.manage' },
  { id: 'custom-fields', label: 'Custom fields', capability: 'settings.manage' },
  { id: 'scoring', label: 'Scoring', capability: 'settings.manage' },
  { id: 'currencies', label: 'Currencies', capability: 'settings.manage' },
  { id: 'lists', label: 'Lists', capability: 'settings.manage' },
  { id: 'integrations', label: 'Integrations', capability: 'settings.manage' },
  { id: 'webhooks', label: 'Webhooks', capability: 'settings.manage' },
  { id: 'system-health', label: 'System health', capability: 'settings.manage' },
  { id: 'suppressions', label: 'Suppressions', capability: 'compliance.manage' },
  { id: 'audit', label: 'Audit log', capability: 'audit.read' },
  { id: 'preferences', label: 'Your preferences', capability: null },
];

/**
 * Settings (PRD 4.17). Each tab shows only for people whose role allows it; the API checks
 * the same capability on every request.
 */
export function SettingsScreen({ onOpenLead }: { onOpenLead?: (leadId: string) => void } = {}) {
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
        {active?.id === 'routing' && <RoutingTab onOpenLead={onOpenLead} />}
        {active?.id === 'custom-fields' && <CustomFieldsTab />}
        {active?.id === 'scoring' && <ScoringTab />}
        {active?.id === 'currencies' && <CurrenciesTab />}
        {active?.id === 'lists' && <ListsTab />}
        {active?.id === 'integrations' && <IntegrationsTab />}
        {active?.id === 'webhooks' && <WebhooksTab />}
        {active?.id === 'system-health' && <SystemHealthTab />}
        {active?.id === 'suppressions' && <SuppressionsTab />}
        {active?.id === 'audit' && <AuditTab />}
        {active?.id === 'preferences' && <PreferencesTab />}
      </div>
    </div>
  );
}
