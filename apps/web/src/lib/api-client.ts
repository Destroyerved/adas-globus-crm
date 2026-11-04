/**
 * Development sign-in only. These are the synthetic users from the seed data
 * (apps/api/src/platform/db/seed.ts). Production builds never show them.
 */

export interface DevSignInUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

export const DEV_SIGN_IN_USERS: readonly DevSignInUser[] = [
  {
    id: 'usr_mgr_1',
    displayName: 'Arjun Mehta',
    email: 'arjun@adasglobuspro.example.com',
    role: 'Sales Manager (U.S.)',
  },
  {
    id: 'usr_admin_1',
    displayName: 'Ved Shah',
    email: 'ved@adasglobuspro.example.com',
    role: 'Admin',
  },
  {
    id: 'usr_bdr_1',
    displayName: 'Priya Nair',
    email: 'priya@adasglobuspro.example.com',
    role: 'BDR / SDR (Canada)',
  },
  {
    id: 'usr_ae_1',
    displayName: 'Rohan Desai',
    email: 'rohan@adasglobuspro.example.com',
    role: 'Account Executive',
  },
  {
    id: 'usr_mkt_1',
    displayName: 'Ananya Iyer',
    email: 'ananya@adasglobuspro.example.com',
    role: 'Marketing Manager',
  },
  {
    id: 'usr_ro_1',
    displayName: 'Devika Joshi',
    email: 'dev@adasglobuspro.example.com',
    role: 'Read-only analyst',
  },
];

/** Development sign-in is compiled out of production builds (AGENTS.md §6). */
export function canUseDevLogin(isProdBuild: boolean = import.meta.env.PROD): boolean {
  return !isProdBuild;
}
