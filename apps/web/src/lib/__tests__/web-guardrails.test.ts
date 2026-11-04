import { describe, expect, it } from 'vitest';
import { canUseDevLogin, DEV_SIGN_IN_USERS } from '../api-client.js';

describe('Web guardrails', () => {
  it('compiles out dev login in production builds (AGENTS.md §6)', () => {
    expect(canUseDevLogin(true)).toBe(false);
    expect(canUseDevLogin(false)).toBe(true);
  });

  it('uses only synthetic example domains for dev personas (AGENTS.md §5)', () => {
    for (const user of DEV_SIGN_IN_USERS) {
      expect(user.email).toContain('.example.');
    }
  });
});
