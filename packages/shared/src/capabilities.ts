import { z } from 'zod';
import { ScopeSchema, type Scope } from './enums.js';

export const CAPABILITY_KEYS = [
  'companies.read',
  'companies.create',
  'companies.update',
  'contacts.read',
  'contacts.create',
  'contacts.update',
  'leads.read',
  'leads.create',
  'leads.update',
  'leads.assign',
  'leads.convert',
  'deals.read',
  'deals.create',
  'deals.update',
  'tasks.read',
  'tasks.create',
  'tasks.update',
  'activities.read',
  'activities.create',
  'inbox.read',
  'inbox.read_team',
  'inbox.send',
  'sequences.read',
  'sequences.manage',
  'sequences.approve_team',
  'campaigns.read',
  'campaigns.manage',
  'campaigns.approve',
  'reports.read',
  'data.import',
  'data.export',
  'records.merge',
  'records.delete',
  'users.manage',
  'settings.manage',
  'integrations.manage',
  'audit.read',
  'privacy.manage',
] as const;

export const CapabilityKeySchema = z.enum(CAPABILITY_KEYS);
export type CapabilityKey = z.infer<typeof CapabilityKeySchema>;

export const CapabilityGrantSchema = z.object({
  capability: CapabilityKeySchema,
  scope: ScopeSchema,
});
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export const SYSTEM_ROLES = [
  'Super Admin',
  'Sales Manager',
  'Sales Executive',
  'Marketing Manager',
  'Marketing Executive',
  'Management',
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[number];

export interface RoleDefinition {
  name: SystemRoleName;
  description: string;
  defaultScope: Scope;
}

export const DEFAULT_ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    name: 'Super Admin',
    description: 'Configuration, users, integrations, full access',
    defaultScope: 'all',
  },
  {
    name: 'Sales Manager',
    description: 'Assign leads, manage team deals, approve sequences, see team reports',
    defaultScope: 'team',
  },
  {
    name: 'Sales Executive',
    description: 'Work assigned leads, contacts, deals and tasks',
    defaultScope: 'own',
  },
  {
    name: 'Marketing Manager',
    description: 'Segments, campaigns, templates, approvals, deliverability',
    defaultScope: 'all',
  },
  {
    name: 'Marketing Executive',
    description: 'Research, list building, campaign drafts',
    defaultScope: 'own',
  },
  {
    name: 'Management',
    description: 'Read-only dashboards and reports',
    defaultScope: 'all',
  },
];
