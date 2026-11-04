import { describe, expect, it } from 'vitest';
import { SEED_SQL } from '../seed.js';

describe('synthetic seed data (AGENTS.md §5)', () => {
  it('uses only reserved example domains for every email address', () => {
    const emails = SEED_SQL.join('\n').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
    expect(emails.length).toBeGreaterThan(5);
    for (const email of emails) {
      expect(email.toLowerCase()).toMatch(/@([\w-]+\.)*example\.(com|ca)$/);
    }
  });
});
