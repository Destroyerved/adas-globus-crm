import { type SystemRoleName } from '@adas/shared';

export interface DevUser {
  id: string;
  displayName: string;
  email: string;
  initials: string;
  role: SystemRoleName;
  timeZone: string;
}

export const DEFAULT_DEV_USER: DevUser = {
  id: 'usr_01',
  displayName: 'Ved Shah',
  email: 'ved.shah@adasglobuspro.example.com',
  initials: 'VS',
  role: 'Super Admin',
  timeZone: 'Asia/Kolkata',
};

export const SYNTHETIC_DEV_USERS: readonly DevUser[] = [
  DEFAULT_DEV_USER,
  {
    id: 'usr_02',
    displayName: 'Arjun Mehta',
    email: 'arjun.mehta@adasglobuspro.example.com',
    initials: 'AM',
    role: 'Sales Executive',
    timeZone: 'Asia/Kolkata',
  },
  {
    id: 'usr_03',
    displayName: 'Priya Nair',
    email: 'priya.nair@adasglobuspro.example.com',
    initials: 'PN',
    role: 'Sales Manager',
    timeZone: 'Asia/Kolkata',
  },
];

/**
 * Dev login is compiled out of production builds (AGENTS.md §6).
 */
export function canUseDevLogin(isProdBuild: boolean = import.meta.env.PROD): boolean {
  return !isProdBuild;
}
