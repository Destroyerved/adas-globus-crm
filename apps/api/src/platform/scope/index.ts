import type { Scope, SessionUser, UserRoleName } from '@adas/shared';
import { ForbiddenScopeError } from '../errors/index.js';

export type CapabilityScopeValue = Scope | 'none';

/**
 * PRD §3.2 & §3.3 — Default capability matrix by role.
 * Q14 default: Managers see their teams; BDR/SDR and AE see their own;
 * Admin sees all; Read-Only Analyst reads all but cannot mutate.
 */
export const ROLE_CAPABILITY_MATRIX: Record<UserRoleName, Record<string, CapabilityScopeValue>> = {
  Admin: {
    'leads.read': 'all',
    'leads.write': 'all',
    'leads.convert': 'all',
    'companies.read': 'all',
    'companies.write': 'all',
    'contacts.read': 'all',
    'contacts.write': 'all',
    'deals.read': 'all',
    'deals.write': 'all',
    'tasks.read': 'all',
    'tasks.write': 'all',
    'inbox.read': 'all',
    'inbox.send': 'all',
    'sequences.read': 'all',
    'sequences.write': 'all',
    'sequences.enroll': 'all',
    'sequences.approve': 'all',
    'campaigns.read': 'all',
    'campaigns.write': 'all',
    'campaigns.approve': 'all',
    'imports.run': 'all',
    'exports.run': 'all',
    'duplicates.merge': 'all',
    'compliance.manage': 'all',
    'reports.read': 'all',
    'settings.manage': 'all',
    'users.manage': 'all',
    'audit.read': 'all',
  },
  'Sales Manager': {
    'leads.read': 'team',
    'leads.write': 'team',
    'leads.convert': 'team',
    'companies.read': 'team',
    'companies.write': 'team',
    'contacts.read': 'team',
    'contacts.write': 'team',
    'deals.read': 'team',
    'deals.write': 'team',
    'tasks.read': 'team',
    'tasks.write': 'team',
    'inbox.read': 'team',
    'inbox.send': 'own',
    'sequences.read': 'team',
    'sequences.write': 'team',
    'sequences.enroll': 'team',
    'sequences.approve': 'team',
    'campaigns.read': 'all',
    'campaigns.write': 'none',
    'campaigns.approve': 'none',
    'imports.run': 'team',
    'exports.run': 'team',
    'duplicates.merge': 'team',
    'compliance.manage': 'team',
    'reports.read': 'team',
    'settings.manage': 'none',
    'users.manage': 'none',
    'audit.read': 'team',
  },
  'BDR / SDR': {
    'leads.read': 'own',
    'leads.write': 'own',
    'leads.convert': 'own',
    'companies.read': 'own',
    'companies.write': 'own',
    'contacts.read': 'own',
    'contacts.write': 'own',
    'deals.read': 'own',
    'deals.write': 'own',
    'tasks.read': 'own',
    'tasks.write': 'own',
    'inbox.read': 'own',
    'inbox.send': 'own',
    'sequences.read': 'team',
    'sequences.write': 'own',
    'sequences.enroll': 'own',
    'sequences.approve': 'none',
    'campaigns.read': 'none',
    'campaigns.write': 'none',
    'campaigns.approve': 'none',
    'imports.run': 'none',
    'exports.run': 'none',
    'duplicates.merge': 'none',
    'compliance.manage': 'none',
    'reports.read': 'own',
    'settings.manage': 'none',
    'users.manage': 'none',
    'audit.read': 'none',
  },
  'Account Executive': {
    'leads.read': 'own',
    'leads.write': 'own',
    'leads.convert': 'own',
    'companies.read': 'own',
    'companies.write': 'own',
    'contacts.read': 'own',
    'contacts.write': 'own',
    'deals.read': 'own',
    'deals.write': 'own',
    'tasks.read': 'own',
    'tasks.write': 'own',
    'inbox.read': 'own',
    'inbox.send': 'own',
    'sequences.read': 'team',
    'sequences.write': 'own',
    'sequences.enroll': 'own',
    'sequences.approve': 'none',
    'campaigns.read': 'none',
    'campaigns.write': 'none',
    'campaigns.approve': 'none',
    'imports.run': 'none',
    'exports.run': 'none',
    'duplicates.merge': 'none',
    'compliance.manage': 'none',
    'reports.read': 'own',
    'settings.manage': 'none',
    'users.manage': 'none',
    'audit.read': 'none',
  },
  'Marketing Manager': {
    'leads.read': 'all',
    'leads.write': 'all',
    'leads.convert': 'none',
    'companies.read': 'all',
    'companies.write': 'all',
    'contacts.read': 'all',
    'contacts.write': 'all',
    'deals.read': 'all',
    'deals.write': 'none',
    'tasks.read': 'own',
    'tasks.write': 'own',
    'inbox.read': 'own',
    'inbox.send': 'own',
    'sequences.read': 'all',
    'sequences.write': 'all',
    'sequences.enroll': 'all',
    'sequences.approve': 'all',
    'campaigns.read': 'all',
    'campaigns.write': 'all',
    'campaigns.approve': 'all',
    'imports.run': 'all',
    'exports.run': 'all',
    'duplicates.merge': 'all',
    'compliance.manage': 'all',
    'reports.read': 'all',
    'settings.manage': 'none',
    'users.manage': 'none',
    'audit.read': 'none',
  },
  'Read-Only / Analyst': {
    'leads.read': 'all',
    'leads.write': 'none',
    'leads.convert': 'none',
    'companies.read': 'all',
    'companies.write': 'none',
    'contacts.read': 'all',
    'contacts.write': 'none',
    'deals.read': 'all',
    'deals.write': 'none',
    'tasks.read': 'all',
    'tasks.write': 'none',
    'inbox.read': 'none',
    'inbox.send': 'none',
    'sequences.read': 'all',
    'sequences.write': 'none',
    'sequences.enroll': 'none',
    'sequences.approve': 'none',
    'campaigns.read': 'all',
    'campaigns.write': 'none',
    'campaigns.approve': 'none',
    'imports.run': 'none',
    'exports.run': 'none',
    'duplicates.merge': 'none',
    'compliance.manage': 'none',
    'reports.read': 'all',
    'settings.manage': 'none',
    'users.manage': 'none',
    'audit.read': 'none',
  },
};

export function getCapabilityScope(user: SessionUser, capability: string): CapabilityScopeValue {
  const explicit = user.capabilities[capability];
  if (explicit) {
    return explicit;
  }
  const roleDefaults = ROLE_CAPABILITY_MATRIX[user.role];
  return roleDefaults[capability] ?? 'none';
}

export function requireCapability(user: SessionUser, capability: string): Scope {
  const scope = getCapabilityScope(user, capability);
  if (scope === 'none') {
    throw new ForbiddenScopeError(capability);
  }
  return scope;
}

export interface ScopeWhereOptions {
  alias?: string;
  ownerColumn?: string;
  teamColumn?: string;
  startParamIndex?: number;
}

export interface SqlWhereFragment {
  scope: Scope;
  sql: string;
  params: unknown[];
}

/**
 * PRD §3.3 & AGENTS.md §7 — Every query for a scoped entity applies the user's scope in SQL.
 */
export function scopeWhere(
  user: SessionUser,
  capability: string,
  options: ScopeWhereOptions = {},
): SqlWhereFragment {
  const scope = requireCapability(user, capability);
  const prefix = options.alias ? `${options.alias}.` : '';
  const ownerCol = `${prefix}${options.ownerColumn ?? 'owner_user_id'}`;
  const teamCol = `${prefix}${options.teamColumn ?? 'team_id'}`;
  const pIdx = options.startParamIndex ?? 1;

  if (scope === 'all') {
    return {
      scope: 'all',
      sql: '1 = 1',
      params: [],
    };
  }

  if (scope === 'team') {
    if (user.teamId) {
      return {
        scope: 'team',
        sql: `(${teamCol} = $${pIdx} OR ${ownerCol} = $${pIdx + 1})`,
        params: [user.teamId, user.id],
      };
    }
    return {
      scope: 'team',
      sql: `${ownerCol} = $${pIdx}`,
      params: [user.id],
    };
  }

  return {
    scope: 'own',
    sql: `${ownerCol} = $${pIdx}`,
    params: [user.id],
  };
}
