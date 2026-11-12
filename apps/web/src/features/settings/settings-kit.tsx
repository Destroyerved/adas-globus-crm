import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type Market, type StatusTone } from '@adas/shared';
import { Select } from '@/components/ui/select.js';
import { api, type ScopeValue } from '@/lib/api.js';

/** Labels and small helpers shared by the settings tabs (PRD 4.17, DESIGN 10). */

export const MARKET_LABEL: Record<Market, string> = {
  US: 'United States',
  CA: 'Canada',
  OTHER: 'Other',
};

export const USER_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invited', tone: 'info' },
  disabled: { label: 'Deactivated', tone: 'neutral' },
};

export const SCOPE_LABEL: Record<ScopeValue, string> = {
  none: 'No access',
  own: 'Own records',
  team: 'Their team',
  all: 'Everyone',
};

/** Plain-English names for each capability the API enforces (PRD 2.2). */
export const CAPABILITY_LABEL: Record<string, string> = {
  'leads.read': 'See leads',
  'leads.write': 'Edit leads',
  'leads.convert': 'Convert leads to deals',
  'leads.assign': 'Assign leads to others',
  'records.delete': 'Delete records',
  'companies.read': 'See companies',
  'companies.write': 'Edit companies',
  'contacts.read': 'See contacts',
  'contacts.write': 'Edit contacts',
  'deals.read': 'See deals',
  'deals.write': 'Edit and move deals',
  'tasks.read': 'See tasks',
  'tasks.write': 'Create and edit tasks',
  'inbox.read': 'Read inbox email',
  'inbox.send': 'Send email from the CRM',
  'sequences.read': 'See sequences',
  'sequences.write': 'Edit sequences',
  'sequences.enroll': 'Enrol contacts in sequences',
  'sequences.approve': 'Approve team sequences',
  'campaigns.read': 'See campaigns',
  'campaigns.write': 'Edit campaigns',
  'campaigns.approve': 'Approve campaigns',
  'imports.run': 'Import data',
  'exports.run': 'Export data',
  'duplicates.merge': 'Merge duplicates',
  'compliance.manage': 'Manage suppressions and consent',
  'privacy.manage': 'Lift suppressions, export personal data and erase contacts',
  'reports.read': 'See reports and dashboards',
  'settings.manage': 'Change settings',
  'users.manage': 'Manage people and roles',
  'audit.read': 'Read the audit log',
};

export function capabilityLabel(key: string): string {
  return CAPABILITY_LABEL[key] ?? key;
}

/** "user.role_changed" reads as "User role changed". */
export function actionLabel(action: string): string {
  const text = action.replace(/[._]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const COMMON_ZONES = [
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Winnipeg',
  'America/Edmonton',
  'America/Vancouver',
  'America/Halifax',
  'UTC',
];

function allZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) return zones;
  } catch {
    // older browsers: the common list is enough
  }
  return COMMON_ZONES;
}

export function TimeZoneSelect({
  id,
  value,
  onChange,
  invalid,
}: {
  id?: string;
  value: string;
  onChange: (zone: string) => void;
  invalid?: boolean;
}) {
  const others = allZones().filter((z) => !COMMON_ZONES.includes(z));
  return (
    <Select id={id} value={value} invalid={invalid} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">Choose a time zone</option>}
      <optgroup label="Common">
        {COMMON_ZONES.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </optgroup>
      <optgroup label="All time zones">
        {others.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </optgroup>
    </Select>
  );
}

export function useAdminTeams(enabled = true) {
  return useQuery({ queryKey: ['admin', 'teams'], queryFn: api.adminTeams, enabled });
}

export function useAdminRoles(enabled = true) {
  return useQuery({ queryKey: ['admin', 'roles'], queryFn: api.adminRoles, enabled });
}

/** A labelled control for drawers: label above, error below (DESIGN 6.2). */
export function FormRow({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-[6px]">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="m-0 text-[13px] text-ink-3">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="m-0 text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
