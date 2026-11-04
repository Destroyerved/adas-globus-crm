import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * End-to-end tests of the live CRM screens against the e2e test API (a throw-away database).
 * Records created here go through the real API and must still be there after a reload.
 * The production build sends no dev-user header, so the API acts as the seeded U.S. Sales
 * Manager (team scope): Canadian records are correctly hidden from these tests.
 */

const SCREENS_DIR = resolve(process.cwd(), 'docs/screens');
test.describe.configure({ mode: 'serial' });

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const SCREENS = [
  { name: '01-login', query: '?screen=login', ready: 'Sign in to ADAS CRM' },
  { name: '02-leads', query: '?screen=leads', ready: 'Jane Patel' },
  { name: '03-contacts', query: '?screen=contacts', ready: 'Jane Patel' },
  { name: '04-companies', query: '?screen=companies', ready: 'Ridgeway CPA Group' },
  { name: '05-company-profile', query: '?screen=company&id=cmp_acme', ready: 'Timeline' },
  { name: '06-deals', query: '?screen=deals', ready: 'Acme Tax & Advisory LLP' },
  { name: '07-tasks', query: '?screen=tasks', ready: 'Free Trial check-in' },
];

test.beforeAll(() => mkdirSync(SCREENS_DIR, { recursive: true }));

test.beforeEach(async ({ page }) => {
  const res = await page.request.post('/api/v1/auth/dev-login', { data: { userId: 'usr_mgr_1' } });
  expect(res.ok()).toBe(true);
});

for (const screen of SCREENS) {
  test(`${screen.name} loads live data, passes axe and fits 1440px and 375px`, async ({ page }) => {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      if (screen.name === '01-login') await page.context().clearCookies();
      await page.goto(`/${screen.query}`);
      await expect(page.getByText(screen.ready, { exact: false }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: resolve(SCREENS_DIR, `${screen.name}-${width}w.png`),
        fullPage: true,
      });
    }
  });
}

test('a new lead is saved, survives a reload, converts to a deal and moves through the pipeline', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=leads');

  // Create
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill('Quinn Tester');
  await page.getByLabel('Work email').fill('quinn@e2etest.example.com');
  await page.getByLabel(/^Firm/).fill('E2E Test CPA');
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('status')).toContainText('Added Quinn Tester');

  // Saved on the server, not just in the page
  await page.reload();
  await expect(page.getByText('Quinn Tester · E2E Test CPA')).toBeVisible();

  // Duplicate email is refused with a clear message
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill('Quinn Again');
  await page.getByLabel('Work email').fill('quinn@e2etest.example.com');
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByText('This email already has an open lead.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Convert
  await page.getByRole('button', { name: 'Convert Quinn Tester to a deal' }).click();
  await expect(page.getByRole('status')).toContainText('Converted Quinn Tester');

  // The deal appears on the board and moves to Free trial with its required detail
  await page.goto('/?screen=deals');
  const card = page.locator('li', { hasText: 'E2E Test CPA' });
  await expect(card).toBeVisible();
  await card.getByRole('combobox').selectOption('Free Trial (3-Day)');
  await card.getByLabel('Trial role').fill('Senior tax preparer');
  await card.getByRole('button', { name: 'Move to Free Trial (3-Day)' }).click();
  await expect(
    page
      .getByRole('region', { name: /^Free Trial \(3-Day\)/ })
      .getByText('E2E Test CPA')
      .first(),
  ).toBeVisible();

  // Company profile shows the contact and the moved deal; add a task there
  await card.getByRole('button', { name: 'Open company' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Test CPA' })).toBeVisible();
  await expect(page.getByText('Quinn Tester')).toBeVisible();
  await expect(page.getByText('Free Trial (3-Day)').first()).toBeVisible();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('New task title').fill('Send trial checklist');
  await page.getByLabel('Due date').fill(tomorrow);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Send trial checklist')).toBeVisible();

  // The task is on the Tasks screen and can be completed
  await page.goto('/?screen=tasks');
  await expect(page.getByText('Send trial checklist')).toBeVisible();
  await page.getByRole('button', { name: 'Mark "Send trial checklist" done' }).click();
  await expect(page.getByText('Send trial checklist')).toHaveCount(0);
});

test('the command palette finds a real company', async ({ page }) => {
  await page.goto('/?screen=leads&palette=1');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('Ridgeway');
  await expect(palette.getByText('Ridgeway CPA Group', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Ridgeway CPA Group' })).toBeVisible();
});

test('screens show an error with a retry when the API is unreachable', async ({ page }) => {
  await page.route('**/api/v1/leads', (route) => route.abort());
  await page.goto('/?screen=leads');
  await expect(page.getByText("Can't reach the CRM server")).toBeVisible();
  await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
});

test('without a session the app shows sign-in, and Microsoft sign-in says it is not set up yet', async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto('/?screen=deals');
  await expect(page.getByRole('heading', { name: 'Sign in to ADAS CRM' })).toBeVisible();
  await expect(page.getByTestId('microsoft-signin-btn')).toBeDisabled();
  await expect(page.getByText('Not available yet')).toBeVisible();
  // Production builds never offer the development sign-in
  await expect(page.locator('#dev-user-select')).toHaveCount(0);

  // The API refuses data without a session
  const res = await page.request.get('/api/v1/leads');
  expect(res.status()).toBe(401);
});

test('signing out ends the session', async ({ page }) => {
  await page.goto('/?screen=leads');
  await expect(page.getByText('Jane Patel').first()).toBeVisible();
  await page
    .getByRole('button', { name: /^Sign out/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Sign in to ADAS CRM' })).toBeVisible();
  const res = await page.request.get('/api/v1/auth/me');
  expect(res.status()).toBe(401);
});
