import { describe, expect, it } from 'vitest';
import { canUseDevLogin, SYNTHETIC_DEV_USERS } from '../api-client.js';
import {
  INITIAL_KANBAN_DEALS,
  SYNTHETIC_COMPANY_PROFILE,
  SYNTHETIC_LEADS,
} from '../synthetic-data.js';

describe('Web guardrails and synthetic fixtures', () => {
  it('compiles out dev login in production builds (AGENTS.md §6)', () => {
    expect(canUseDevLogin(true)).toBe(false);
    expect(canUseDevLogin(false)).toBe(true);
  });

  it('uses only synthetic example domains in dev personas and lead fixtures (AGENTS.md §5)', () => {
    for (const user of SYNTHETIC_DEV_USERS) {
      expect(user.email).toContain('.example.');
    }
    for (const lead of SYNTHETIC_LEADS) {
      expect(lead.email).toContain('.example.');
    }
    expect(SYNTHETIC_COMPANY_PROFILE.domain).toContain('.example.');
    expect(INITIAL_KANBAN_DEALS.length).toBeGreaterThanOrEqual(8);
  });
});
