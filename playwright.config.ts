import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { generateTotpSecret } from './apps/api/src/platform/crypto/totp.js';

// Throw-away credentials for the synthetic emergency admin on the e2e test database. New on
// every run; the test workers and the e2e API inherit them through the environment.
process.env['E2E_ADMIN_PASSWORD'] ??= `e2e-${randomBytes(12).toString('base64url')}`;
process.env['E2E_ADMIN_TOTP_SECRET'] ??= generateTotpSecret();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @adas/api start:e2e',
      url: 'http://localhost:3000/api/v1/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @adas/web preview --port 5174',
      url: 'http://localhost:5174',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
