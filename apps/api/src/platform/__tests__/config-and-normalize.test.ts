import { describe, expect, it } from 'vitest';
import { isDevLoginEnabled, validateEnv } from '../config/index.js';
import { isFreeMailDomain, normalizeCompanyDomain, normalizeEmail } from '../normalize/index.js';

describe('Platform config and guardrails', () => {
  it('parses defaults cleanly for development', () => {
    const env = validateEnv({ NODE_ENV: 'development' });
    expect(env.PORT).toBe(3000);
    expect(env.WEB_PORT).toBe(5174);
    expect(env.MAIL_LIVE).toBe(false);
    expect(isDevLoginEnabled(env)).toBe(true);
  });

  it('disables dev login in production builds (AGENTS.md §6)', () => {
    const env = validateEnv({ NODE_ENV: 'production', MAIL_LIVE: 'false' });
    expect(isDevLoginEnabled(env)).toBe(false);
  });

  it('forbids MAIL_LIVE=true outside production (AGENTS.md §5)', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        MAIL_LIVE: 'true',
      }),
    ).toThrow(/MAIL_LIVE=true is strictly forbidden/);
  });
});

describe('Email and domain normalisation (PRD §4.3)', () => {
  it('normalises emails and domains and blocks free-mail domains from creating company domains', () => {
    expect(normalizeEmail('  Jane.Patel@AcmeCPA.com ')).toBe('jane.patel@acmecpa.com');
    expect(normalizeCompanyDomain('https://www.AcmeCPA.com/about:443')).toBe('acmecpa.com');
    expect(normalizeCompanyDomain('jane@gmail.com')).toBeNull();
    expect(normalizeCompanyDomain('outlook.com')).toBeNull();
    expect(isFreeMailDomain('yahoo.ca')).toBe(true);
    expect(isFreeMailDomain('acmecpa.com')).toBe(false);
  });
});
