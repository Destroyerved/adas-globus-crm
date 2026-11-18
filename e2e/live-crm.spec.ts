import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { totpCode, totpStep } from '../apps/api/src/platform/crypto/totp.js';

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
  { name: '08-lead-profile', query: '?screen=lead&id=lead_elena', ready: 'Timeline' },
  { name: '09-contact-profile', query: '?screen=contact&id=cnt_jane', ready: 'Timeline' },
  { name: '10-deal-profile', query: '?screen=deal&id=deal_acme_tax', ready: 'Deal terms' },
  { name: '11-dashboard', query: '?screen=dashboard', ready: 'Open pipeline' },
  {
    name: '12-settings',
    query: '?screen=settings&tab=people',
    ready: 'Invite person',
    user: 'usr_admin_1',
  },
];

async function signInAs(page: Page, userId: string) {
  const res = await page.request.post('/api/v1/auth/dev-login', { data: { userId } });
  expect(res.ok()).toBe(true);
}

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
      if ('user' in screen && screen.user) await signInAs(page, screen.user);
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
  await expect(page.getByText('Added Quinn Tester as a new lead.')).toBeVisible();

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
  await expect(page.getByText('Converted Quinn Tester.')).toBeVisible();

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
  await expect(page.getByRole('button', { name: 'Quinn Tester' })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Send trial checklist' })).toHaveCount(0);

  // It is listed under Done
  await page.getByRole('tab', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Send trial checklist' })).toBeVisible();
});

test('a lead is edited in the drawer, logged against, tagged, and keeps the changes after a reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=lead&id=lead_elena');
  await expect(page.getByRole('heading', { name: 'Elena Rostova' })).toBeVisible();

  // Edit: a disqualification needs a reason before it is sent
  await page.getByRole('button', { name: 'Edit lead' }).click();
  const drawer = page.getByRole('dialog', { name: 'Edit Elena Rostova' });
  await drawer.getByLabel('Job title').fill('Audit Partner');
  await drawer.getByLabel(/^Status/).selectOption('Disqualified');
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(drawer.getByText('Choose why this lead is disqualified.')).toBeVisible();
  await drawer.getByLabel(/^Status/).selectOption('Engaged');
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Lead saved.')).toBeVisible();
  await expect(drawer).toHaveCount(0);

  // Log a call on the timeline
  await page.getByRole('radio', { name: 'Call' }).click();
  await page.getByLabel('What was said, and what happens next?').fill('Walked through the trial.');
  await page.getByLabel('Call outcome').selectOption('Connected');
  await page.getByRole('button', { name: 'Log call' }).click();
  await expect(page.getByText('Walked through the trial.')).toBeVisible();

  // Tag it
  await page.getByRole('button', { name: 'Edit tags' }).click();
  await page.getByLabel('Add a tag').fill('audit-season');
  await page.getByRole('button', { name: 'Save tags' }).click();
  await expect(page.getByText('Tags saved.')).toBeVisible();

  // Everything is still there after a reload
  await page.reload();
  await expect(page.getByText('Audit Partner')).toBeVisible();
  await expect(page.getByText('Engaged').first()).toBeVisible();
  await expect(page.getByText('Walked through the trial.')).toBeVisible();
  await expect(page.getByText('audit-season')).toBeVisible();
  await expectNoAxeViolations(page);

  // The list finds it by search, and the search lives in the URL
  await page.goto('/?screen=leads&q=Rostova');
  await expect(page.getByRole('button', { name: /^Elena Rostova · / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Jane Patel · / })).toHaveCount(0);
});

test('reassigning a lead notifies the new owner', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=lead&id=lead_elena');
  await page.getByRole('button', { name: 'Edit lead' }).click();
  const drawer = page.getByRole('dialog', { name: 'Edit Elena Rostova' });
  await drawer.getByLabel(/^Owner/).selectOption({ label: 'Rohan Desai · U.S. CPA Growth Team' });
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Lead saved.')).toBeVisible();

  const res = await page.request.post('/api/v1/auth/dev-login', { data: { userId: 'usr_ae_1' } });
  expect(res.ok()).toBe(true);
  await page.goto('/?screen=leads');
  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect(panel.getByText(/Elena Rostova/).first()).toBeVisible();
  await panel
    .getByText(/Elena Rostova/)
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Elena Rostova' })).toBeVisible();
});

test('the command palette finds a real company', async ({ page }) => {
  await page.goto('/?screen=leads&palette=1');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await expect(palette.getByLabel('Search records or commands')).toBeFocused();
  await page.keyboard.type('Ridgeway');
  await expect(palette.getByText('Ridgeway CPA Group', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Ridgeway CPA Group' })).toBeVisible();
});

test('screens show an error with a retry when the API is unreachable', async ({ page }) => {
  await page.route(/\/api\/v1\/leads(\?|$)/, (route) => route.abort());
  await page.goto('/?screen=leads');
  await expect(page.getByText("Can't reach the CRM server")).toBeVisible();
  await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
});

test('without a session the app shows sign-in with both Microsoft and Google options', async ({
  page,
}) => {
  await page.context().clearCookies();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?screen=deals');
    await expect(page.getByRole('heading', { name: 'Sign in to ADAS CRM' })).toBeVisible();
    await expect(page.getByTestId('microsoft-signin-btn')).toBeDisabled();
    await expect(page.getByTestId('google-signin-btn')).toBeDisabled();
    await expect(page.getByText('Not available yet')).toBeVisible();
    // Production builds never offer the development sign-in
    await expect(page.locator('#dev-user-select')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `01-login-${width}w.png`),
      fullPage: true,
    });
  }

  // The API refuses data without a session
  const res = await page.request.get('/api/v1/leads');
  expect(res.status()).toBe(401);
});

test('an emergency admin signs in with a password and an authenticator code', async ({ page }) => {
  test.setTimeout(90_000);
  const password = process.env['E2E_ADMIN_PASSWORD'] ?? '';
  const secret = process.env['E2E_ADMIN_TOTP_SECRET'] ?? '';
  expect(password).not.toBe('');
  await page.context().clearCookies();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?screen=login');
    await page.getByRole('button', { name: 'Admin sign-in' }).click();
    const form = page.getByRole('form', { name: 'Admin sign-in' });
    await expect(form.getByLabel('Email')).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `13-admin-sign-in-${width}w.png`),
      fullPage: true,
    });
  }

  // Fields are checked before anything is sent.
  const form = page.getByRole('form', { name: 'Admin sign-in' });
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(form.getByText('Enter the 6-digit code from your authenticator app')).toBeVisible();
  await expect(form.getByLabel('Email')).toBeFocused();

  // A wrong detail gets the same answer whichever part was wrong.
  await form.getByLabel('Email').fill('emergency.admin@adasglobuspro.example.com');
  await form.getByLabel('Password').fill('not-the-password');
  await form.getByLabel('Code from your authenticator app').fill('000000');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(form.getByRole('alert')).toHaveText(/The email, password or code is wrong/);

  // Back returns focus to the link.
  await form.getByRole('button', { name: 'Back to Microsoft sign-in' }).click();
  await expect(page.getByRole('button', { name: 'Admin sign-in' })).toBeFocused();
  await page.getByRole('button', { name: 'Admin sign-in' }).click();

  await form.getByLabel('Email').fill('emergency.admin@adasglobuspro.example.com');
  await form.getByLabel('Password').fill(password);
  await form
    .getByLabel('Code from your authenticator app')
    .fill(totpCode(secret, totpStep(Date.now())));
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Open pipeline').first()).toBeVisible();

  // Every admin is told; the emergency admin sees it in their own bell too.
  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Notifications' }).getByText('Emergency admin sign-in used'),
  ).toBeVisible();
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

test('the dashboard shows live numbers, and a number opens the list behind it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('dashboard-screen')).toBeVisible();
  const pipeline = page.getByTestId('dashboard-widget').filter({ hasText: 'Open pipeline' });
  // The number on screen is the API's count of the team's open deals (an earlier test adds one).
  const kpi = pipeline.getByRole('button', { name: /Open deals/ });
  const api = await page.request.get('/api/v1/dashboard/widgets/pipeline_by_stage');
  const count = ((await api.json()) as { data: { count: number } }).data.count;
  expect(count).toBeGreaterThanOrEqual(2);
  await expect(kpi).toHaveAccessibleName(new RegExp(`^${count} Open deals`));
  await kpi.click();
  await expect(page).toHaveURL(/screen=deals/);
  await expect(page.getByText('Acme Tax & Advisory LLP').first()).toBeVisible();
  await expect(page.getByText('Ridgeway').first()).toBeVisible();

  await page.goto('/?screen=dashboard');
  await page.getByLabel('Period').selectOption('last_30_days');
  await expect(page).toHaveURL(/period=last_30_days/);
  await page.reload();
  await expect(page.getByLabel('Period')).toHaveValue('last_30_days');
  await expect(page.getByText('Open pipeline')).toBeVisible();
});

test('an admin invites a person and edits a reference list, and both survive a reload', async ({
  page,
}) => {
  await signInAs(page, 'usr_admin_1');
  await page.goto('/?screen=settings&tab=people');
  await page.getByRole('button', { name: 'Invite person' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Invite a person' });
  await drawer.getByLabel('Work email').fill('e2e.invitee@example.com');
  await drawer.getByLabel('Full name').fill('Esha Invitee');
  await drawer.getByLabel('Role').selectOption({ label: 'Account Executive' });
  await drawer.getByRole('button', { name: 'Invite person' }).click();
  await expect(drawer).toBeHidden();
  await page.reload();
  const row = page.getByRole('row', { name: /Esha Invitee/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('Invited')).toBeVisible();

  await page.getByRole('tab', { name: 'Lists' }).click();
  const sources = page.getByLabel('Add to lead sources');
  await sources.fill('Trade show');
  await sources.press('Enter');
  await page.getByRole('button', { name: 'Save lead sources' }).click();
  await expect(page.getByText('Saved lead sources.')).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Lead sources values' }).getByText('Trade show'),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Audit log' }).click();
  const audit = page.getByRole('table', { name: 'Audit log, newest first' });
  await expect(audit.getByRole('row', { name: /User invited/ }).first()).toBeVisible();
  await expect(audit.getByRole('row', { name: /Settings changed/ }).first()).toBeVisible();
});

test('people without admin rights see only their own preferences in settings', async ({ page }) => {
  await signInAs(page, 'usr_bdr_2');
  await page.goto('/?screen=settings&tab=people');
  await expect(page.getByRole('tab', { name: 'Your preferences' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'People' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Invite person' })).toHaveCount(0);
  const res = await page.request.get('/api/v1/admin/users');
  expect(res.status()).toBe(403);
});

test('every settings tab passes axe and fits 1440px and 375px', async ({ page }) => {
  // Fourteen full axe scans (seven tabs at two widths) need more than the default 30 seconds.
  test.setTimeout(150_000);
  await signInAs(page, 'usr_admin_1');
  const tabs: [string, (p: Page) => Locator][] = [
    ['teams', (p) => p.getByRole('button', { name: 'New team' })],
    ['roles', (p) => p.getByRole('columnheader', { name: 'Which records' })],
    ['pipelines', (p) => p.getByText('Free Trial (3-Day)').first()],
    ['routing', (p) => p.getByRole('heading', { name: 'Website inquiry routing' })],
    ['lists', (p) => p.getByRole('heading', { name: 'Lead sources' })],
    ['suppressions', (p) => p.getByRole('button', { name: 'Add suppression' })],
    ['audit', (p) => p.getByRole('table', { name: 'Audit log, newest first' })],
    ['preferences', (p) => p.getByLabel('Time zone')],
  ];
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [tab, ready] of tabs) {
      await page.goto(`/?screen=settings&tab=${tab}`);
      await expect(ready(page)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);
    }
  }
});

test('an admin adds a pipeline stage and removes it again', async ({ page }) => {
  await signInAs(page, 'usr_admin_1');
  await page.goto('/?screen=settings&tab=pipelines');
  await page.getByRole('button', { name: 'Add stage' }).click();
  const drawer = page.getByRole('dialog', { name: /Add a stage to/ });
  await drawer.getByLabel('Stage name').fill('Reference check');
  await drawer.getByLabel('Probability (%)').fill('60');
  await drawer.getByRole('button', { name: 'Add stage' }).click();
  await expect(drawer).toBeHidden();
  await page.reload();
  await expect(page.getByRole('row', { name: /Reference check/ })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Reference check' }).click();
  await page.getByRole('button', { name: 'Remove this stage' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Remove stage' }).click();
  await expect(confirm).toBeHidden();
  await page.reload();
  await expect(page.getByRole('row', { name: /Reference check/ })).toHaveCount(0);
});

test('a CSV of contacts is mapped, checked, imported, survives a reload and is undone', async ({
  page,
}) => {
  // Three steps, each checked with axe at two widths.
  test.setTimeout(180_000);
  const file = [
    'Email,First name,Last name,Company,Website',
    'e2e.one@lakeside-cpa.example.com,Lena,Hart,Lakeside CPA,lakeside-cpa.example.com',
    'e2e.two@lakeside-cpa.example.com,Owen,Park,Lakeside CPA,lakeside-cpa.example.com',
    'not-an-email,Bad,Row,,',
  ].join('\n');

  const checkStep = async (name: string) => {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: resolve(SCREENS_DIR, `${name}-${width}w.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=imports');
  await expect(page.getByRole('heading', { name: /Imports/ })).toBeVisible();
  await page.getByRole('button', { name: 'Import a file' }).first().click();
  await page.getByTestId('import-file-input').setInputFiles({
    name: 'e2e-contacts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(file),
  });

  // Mapping: the columns are matched from their names.
  await expect(page.getByRole('heading', { name: 'Match columns to CRM fields' })).toBeVisible();
  await expect(page.getByLabel('CRM field for Email')).toHaveValue('email');
  await expect(page.getByLabel('CRM field for Website')).toHaveValue('companyWebsite');
  await checkStep('14-import-mapping');

  // Dry run: nothing saved, the preview counts every row.
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByRole('heading', { name: 'What will happen' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Email is not a valid address.')).toBeVisible();
  await checkStep('15-import-check');

  // Real run in the background, then the result survives a reload.
  await page.getByRole('button', { name: 'Import 2 records' }).click();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible({
    timeout: 20_000,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await checkStep('16-import-result');

  const contacts = await page.request.get('/api/v1/contacts?q=Lakeside');
  expect(contacts.ok()).toBe(true);
  expect(JSON.stringify(await contacts.json())).toContain('e2e.one@lakeside-cpa.example.com');

  // Undo: confirmed in a dialog, then the records are gone.
  await page.getByRole('button', { name: 'Undo import' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByRole('heading', { name: 'Import undone' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Records removed')).toBeVisible();
});

test('two copies of a contact are found, reviewed, merged, survive a reload and are unmerged', async ({
  page,
}) => {
  // Four steps, each checked with axe at two widths.
  test.setTimeout(180_000);
  const checkStep = async (name: string) => {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: resolve(SCREENS_DIR, `${name}-${width}w.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };

  // Two synthetic copies of one person at the same firm, added through the API.
  const ids: string[] = [];
  for (const [email, title] of [
    ['robin.ashford@acmetax.example.com', 'Partner'],
    ['r.ashford@acmetax.example.com', 'Tax Manager'],
  ]) {
    const res = await page.request.post('/api/v1/contacts', {
      // The API takes changes only from the CRM web app's origin.
      headers: { Origin: 'http://localhost:5174' },
      data: {
        companyId: 'cmp_acme',
        firstName: 'Robin',
        lastName: 'Ashford',
        primaryEmail: email,
        title,
      },
    });
    expect(res.status()).toBe(201);
    ids.push(String(((await res.json()) as { id: string }).id));
  }

  // The regular check queues them as a pair.
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/v1/duplicates?entity=contact');
        const body = (await res.json()) as { items: { a: { id: string }; b: { id: string } }[] };
        return body.items.some((p) => ids.includes(p.a.id) && ids.includes(p.b.id));
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=duplicates');
  await expect(page.getByRole('heading', { name: 'Duplicates' })).toBeVisible();
  const review = page.getByRole('button', { name: 'Review Robin Ashford and Robin Ashford' });
  await expect(review).toBeVisible();
  await checkStep('17-duplicates');

  // Compare: keep the newer title, then merge after confirming.
  await review.click();
  await expect(page.getByRole('heading', { name: 'Choose what to keep' })).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Title' })
    .getByRole('radio', { name: /Tax Manager/ })
    .check();
  await checkStep('18-merge-review');
  await page.getByRole('button', { name: 'Merge contacts' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Merge contacts' }).click();
  await expect(page.getByRole('heading', { name: 'Merged into Robin Ashford' })).toBeVisible();
  await checkStep('19-merge-result');

  // Saved: one record keeps the chosen title, the other is gone.
  const merges = await page.request.get('/api/v1/merges?entity=contact');
  const { items } = (await merges.json()) as {
    items: { kept: { id: string }; merged: { id: string } }[];
  };
  const merge = items.find((m) => ids.includes(m.kept.id) && ids.includes(m.merged.id));
  expect(merge).toBeDefined();
  const kept = await page.request.get(`/api/v1/contacts/${merge?.kept.id}`);
  expect(JSON.stringify(await kept.json())).toContain('Tax Manager');
  expect((await page.request.get(`/api/v1/contacts/${merge?.merged.id}`)).status()).toBe(404);

  // After a reload the pair no longer waits, and the merge is listed.
  await page.reload();
  await expect(page.getByText('This pair is no longer waiting for review')).toBeVisible();
  await page.getByRole('button', { name: 'All duplicates' }).first().click();
  await page.getByRole('tab', { name: 'Recent merges' }).click();
  await page.reload();
  const row = page.getByRole('row', { name: /Robin Ashford/ }).first();
  await expect(row.getByRole('button', { name: 'Undo the merge of Robin Ashford' })).toBeVisible();

  // Undo: confirmed in a dialog; both records exist again, also after a reload.
  await row.getByRole('button', { name: 'Undo the merge of Robin Ashford' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Undo merge' }).click();
  await expect(row.getByText('Undone')).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('row', { name: /Robin Ashford/ })
      .first()
      .getByText('Undone'),
  ).toBeVisible();
  expect((await page.request.get(`/api/v1/contacts/${merge?.merged.id}`)).status()).toBe(200);
  await checkStep('20-recent-merges');
});

test('the contacts in view are exported as a CSV file', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=contacts&q=Patel');
  await expect(page.getByRole('heading', { name: /Contacts/ })).toBeVisible();
  await expect(page.getByText('Jane Patel').first()).toBeVisible();

  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Export 1 contact?' });
  await expect(dialog).toBeVisible();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `21-export-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The file downloads at once: the searched view only, with a header row.
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
  const file = readFileSync(await download.path(), 'utf8');
  expect(file.charCodeAt(0)).toBe(0xfeff);
  const csv = file.slice(1);
  const lines = csv.split('\r\n').filter(Boolean);
  expect(lines[0]).toMatch(/^Name,First name,Last name,Email/);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('Jane Patel');
  await expect(page.getByText('Exported 1 contact.')).toBeVisible();
  await expect(dialog).toBeHidden();
});

test('an admin adds and lifts a suppression, and blocks and removes a corporate domain', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInAs(page, 'usr_admin_1');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=settings&tab=suppressions');
  const supTab = page.getByTestId('suppressions-tab');
  await expect(supTab.getByRole('button', { name: 'Add suppression' })).toBeVisible();

  await supTab.getByRole('button', { name: 'Add suppression' }).click();
  const addForm = supTab.getByRole('form', { name: 'Suppress an email address' });
  await addForm.getByLabel(/Email address/).fill('optout.partner@pinecrest-cpa.example.com');
  await addForm.getByLabel(/Notes/).fill('Asked by phone to stop marketing emails');
  await addForm.getByRole('button', { name: 'Suppress address' }).click();
  await expect(supTab.getByText('optout.partner@pinecrest-cpa.example.com')).toBeVisible();

  await supTab.getByRole('button', { name: 'Block domain' }).click();
  const domForm = supTab.getByRole('form', { name: 'Block a corporate domain' });
  await domForm.getByLabel(/Domain/).fill('pinecrest-cpa.example.com');
  await domForm.getByLabel(/Reason/).fill('Managing partner requested firm-wide opt-out');
  await domForm.getByRole('button', { name: 'Block domain' }).click();
  await expect(
    supTab.getByRole('cell', { name: 'pinecrest-cpa.example.com', exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(supTab.getByText('optout.partner@pinecrest-cpa.example.com')).toBeVisible();
  await expect(
    supTab.getByRole('cell', { name: 'pinecrest-cpa.example.com', exact: true }),
  ).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `22-suppressions-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Lift the email suppression with a required reason and verify it moves to Lifted.
  await page
    .getByRole('button', {
      name: 'Lift suppression for optout.partner@pinecrest-cpa.example.com',
    })
    .click();
  const liftDialog = page.getByRole('alertdialog', { name: 'Lift email suppression' });
  await liftDialog
    .getByLabel('Reason for lifting')
    .fill('Partner wrote in asking to receive tax staffing updates again');
  await liftDialog.getByRole('button', { name: 'Lift suppression' }).click();
  await expect(liftDialog).toBeHidden();
  await expect(supTab.getByText('optout.partner@pinecrest-cpa.example.com')).toHaveCount(0);

  await supTab.getByLabel('Suppression status').selectOption('lifted');
  await expect(supTab.getByText('optout.partner@pinecrest-cpa.example.com')).toBeVisible();

  // Remove the domain block with a reason.
  await supTab.getByRole('button', { name: 'Remove block on pinecrest-cpa.example.com' }).click();
  const remDialog = page.getByRole('alertdialog', { name: 'Remove domain block' });
  await remDialog
    .getByLabel('Reason for removing')
    .fill('Signed engagement letter and requested onboarding updates');
  await remDialog.getByRole('button', { name: 'Remove domain block' }).click();
  await expect(remDialog).toBeHidden();
  await expect(
    supTab.getByRole('cell', { name: 'pinecrest-cpa.example.com', exact: true }),
  ).toHaveCount(0);
});

test('consent is recorded, personal data is exported and a privacy erasure leaves a permanent hashed block', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, 'usr_admin_1');
  const createRes = await page.request.post('/api/v1/contacts', {
    headers: { Origin: 'http://localhost:5174' },
    data: {
      firstName: 'Camille',
      lastName: 'Bouchard',
      primaryEmail: 'camille.bouchard@stlaurent-cpa.example.ca',
      title: 'Tax Partner',
      market: 'CA',
    },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as { id: string };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?screen=contact&id=${created.id}`);
  await expect(page.getByRole('heading', { name: 'Camille Bouchard' })).toBeVisible();
  await expect(page.getByTestId('contact-marketing-basis')).toContainText('None');

  // Record express consent and verify it persists after reload.
  await page.getByRole('button', { name: 'Record consent' }).click();
  const drawer = page.getByRole('dialog', { name: 'Record consent' });
  await drawer.getByLabel('Where consent came from').fill('Montreal CPA conference opt-in card');
  await drawer
    .getByLabel('Proof or notes (optional)')
    .fill('Checked box agreeing to receive offshore tax staffing updates');
  await drawer.getByRole('button', { name: 'Save consent' }).click();
  await expect(drawer).toBeHidden();

  await page.reload();
  await expect(page.getByTestId('contact-marketing-basis')).toContainText('Express');

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `23-contact-privacy-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Export JSON and CSV archives and verify contents.
  const jsonDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toMatch(/^privacy-export-.*\.json$/);
  const jsonContent = readFileSync(await jsonDownload.path(), 'utf8');
  expect(jsonContent).toContain('camille.bouchard@stlaurent-cpa.example.ca');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toMatch(/^privacy-export-.*\.csv$/);
  const csvContent = readFileSync(await csvDownload.path(), 'utf8');
  expect(csvContent.charCodeAt(0)).toBe(0xfeff);
  expect(csvContent).toContain('camille.bouchard@stlaurent-cpa.example.ca');

  // Execute privacy erasure and confirm permanent hashed suppression in Settings.
  await page.getByRole('button', { name: 'Erase personal data…' }).click();
  const eraseDialog = page.getByRole('alertdialog', {
    name: 'Erase personal data for Camille Bouchard',
  });
  await eraseDialog
    .getByLabel('Request reference or reason')
    .fill('Verified privacy erasure request received from partner');
  await eraseDialog.getByRole('button', { name: 'Erase personal data' }).click();
  await expect(eraseDialog).toBeHidden();

  expect((await page.request.get(`/api/v1/contacts/${created.id}`)).status()).toBe(404);

  await page.goto('/?screen=settings&tab=suppressions&sreason=privacy_erasure');
  const erasedRow = page.getByRole('row', { name: /Erased address/ }).first();
  await expect(erasedRow).toBeVisible();
  await expect(erasedRow).toContainText('Permanent');
});

test('website inquiry routing rules persist, route live inquiries, notify the owner and pass axe at 1440px and 375px', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, 'usr_admin_1');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=settings&tab=routing');

  const caCard = page.getByTestId('routing-card-CA');
  await expect(caCard).toBeVisible();

  // Route Canadian inquiries to Ved Shah (usr_admin_1) so we also verify the notification bell.
  await caCard.getByLabel('Assignment method').selectOption('named_owner');
  await caCard.getByLabel('Assigned owner').selectOption('usr_admin_1');
  await caCard.getByRole('button', { name: 'Save rule' }).click();
  await expect(caCard).toContainText('Assigned to Ved Shah');

  // Reload to verify PostgreSQL persistence.
  await page.reload();
  await expect(page.getByTestId('routing-card-CA')).toContainText('Assigned to Ved Shah');

  // Submit a live website trial inquiry via the public endpoint.
  const pubRes = await page.request.post('/api/v1/public/inquiries', {
    headers: { 'Cf-Connecting-Ip': '198.51.100.201' },
    data: {
      name: 'Mathieu Pelletier',
      email: 'mathieu.pelletier@pelletiercpa.example.ca',
      firm: 'Pelletier & Associés CPA',
      phone: '+1 514 555 0144',
      need: 'Tax preparation and review',
      country: 'Canada',
      software: 'TaxCycle, QuickBooks',
      message: 'Need two dedicated tax preparers before January',
    },
  });
  expect(pubRes.status()).toBe(202);
  expect(await pubRes.json()).toEqual({ status: 'received' });

  await page.reload();
  await expect(page.getByText('Pelletier & Associés CPA')).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `24-routing-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Open notification bell and verify the new website inquiry notification is there.
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Notifications' }).getByText(/Pelletier & Associés CPA/),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Click the lead in Recent website inquiries to open its Lead profile.
  await page.getByRole('button', { name: 'Mathieu Pelletier' }).click();
  await expect(page.getByRole('heading', { name: 'Mathieu Pelletier' })).toBeVisible();
  await expect(page.getByText('Reply to website inquiry: Mathieu Pelletier')).toBeVisible();
});

test('saved views, row density and the floating bulk-action bar persist across reloads and pass axe at 1440px and 375px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?screen=leads');

  // Create two dedicated US leads for bulk selection so previous serial tests do not collide.
  for (const [name, email, firm] of [
    ['Nora Vance', 'nora.vance@vancecpa.example.com', 'Vance Tax Partners'],
    ['Owen Mercer', 'owen.mercer@mercercpa.example.com', 'Mercer Advisory CPA'],
  ] as const) {
    await page.getByRole('button', { name: 'New lead' }).click();
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel(/^Firm/).fill(firm);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expect(page.getByText(`Added ${name} as a new lead.`)).toBeVisible();
  }

  // Toggle compact density and verify it survives a reload.
  await page.getByRole('button', { name: 'Compact' }).click();
  await expect(page.getByRole('button', { name: 'Compact' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Dismiss creation toasts so mobile screenshot shows the floating bulk bar unobstructed.
  while ((await page.getByRole('button', { name: 'Dismiss' }).count()) > 0) {
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
  }

  // Select both leads and verify the floating navy bulk-action bar appears.
  await page.getByRole('checkbox', { name: 'Select Nora Vance' }).check();
  await page.getByRole('checkbox', { name: 'Select Owen Mercer' }).check();
  const bulkBar = page.getByTestId('bulk-action-bar-lead');
  await expect(bulkBar).toContainText('2 selected');

  // Capture screenshots and run axe + overflow checks with rows selected and bulk bar visible!
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `25-saved-views-bulk-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Bulk add tag.
  await bulkBar.getByRole('button', { name: 'Add tag' }).click();
  const tagDialog = page.getByRole('dialog', { name: 'Add tag to 2 leads' });
  await tagDialog.getByLabel('Tag').fill('priority-q4');
  await tagDialog.getByRole('button', { name: 'Add tag' }).click();
  await expect(tagDialog).toHaveCount(0);
  await expect(page.getByText('priority-q4').first()).toBeVisible();

  // Bulk status update to Qualified.
  await page.getByRole('checkbox', { name: 'Select Nora Vance' }).check();
  await page.getByRole('checkbox', { name: 'Select Owen Mercer' }).check();
  await bulkBar.getByRole('button', { name: 'Change status' }).click();
  const statusDialog = page.getByRole('dialog', { name: 'Change status for 2 leads' });
  await statusDialog.getByLabel('Lead status').selectOption('Qualified');
  await statusDialog.getByRole('button', { name: 'Update status' }).click();
  await expect(statusDialog).toHaveCount(0);

  // Filter to Status = Qualified, save a team-shared view, reset to All, then re-apply the saved view.
  await page.getByLabel('Status', { exact: true }).selectOption('Qualified');
  await page.getByRole('button', { name: 'Save view' }).click();
  const saveDialog = page.getByRole('dialog', { name: 'Save current view' });
  await saveDialog.getByLabel('View name').fill('US Qualified');
  await saveDialog.getByLabel('Share this view with my team').check();
  await saveDialog.getByRole('button', { name: 'Save view' }).click();
  await expect(saveDialog).toHaveCount(0);
  await expect(page.getByText('Saved view "US Qualified".')).toBeVisible();

  await page
    .getByRole('toolbar', { name: 'Saved views' })
    .getByRole('button', { name: 'All' })
    .click();
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('open');

  await page
    .getByRole('toolbar', { name: 'Saved views' })
    .getByRole('button', { name: /^US Qualified/ })
    .click();
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('Qualified');
  await expect(page.getByText('Nora Vance · Vance Tax Partners')).toBeVisible();

  // Reload to verify both the saved view and bulk edits persisted in PostgreSQL.
  await page.reload();
  await expect(
    page
      .getByRole('toolbar', { name: 'Saved views' })
      .getByRole('button', { name: /^US Qualified/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('priority-q4').first()).toBeVisible();
});

test('custom fields, explainable scoring, interactive lead conversion drawer and contact channels persist end-to-end', async ({
  page,
}) => {
  await signInAs(page, 'usr_admin_1');

  // 1. Admin creates a custom field on Leads in Settings → Custom fields.
  await page.goto('/?screen=settings&tab=custom-fields');
  await expect(page.getByTestId('settings-custom-fields-tab')).toBeVisible();
  await page.getByRole('button', { name: 'Add custom field' }).first().click();
  const cfDialog = page.getByRole('dialog', { name: 'Add custom field' });
  await cfDialog.getByLabel('Label').fill('Tax season returns');
  await cfDialog.getByLabel('Field type').selectOption('number');
  await cfDialog.getByRole('button', { name: 'Create field' }).click();
  await expect(cfDialog).toHaveCount(0);
  await expect(page.getByText('custom.tax_season_returns')).toBeVisible();

  // 2. Check Settings → Scoring tab and recalculate scores.
  await page.getByRole('tab', { name: 'Scoring' }).click();
  await expect(page.getByTestId('settings-scoring-tab')).toBeVisible();
  await page.getByRole('button', { name: 'Recalculate all scores' }).click();
  await expect(page.getByText(/Recalculated .* leads/)).toBeVisible();

  // 3. Switch to synthetic Sales Manager (Maya Lin) so record screenshots show synthetic owners only.
  await signInAs(page, 'usr_mgr_1');
  await page.goto('/?screen=leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill('Clara Bennett');
  await page.getByLabel('Work email').fill('clara.bennett@bennettadvisory.example');
  await page.getByLabel(/^Firm/).fill('Bennett Advisory CPA');
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByText('Added Clara Bennett as a new lead.')).toBeVisible();

  await page.getByRole('button', { name: /Clara Bennett · Bennett Advisory CPA/ }).click();
  await expect(page.getByTestId('lead-profile-screen')).toBeVisible();
  await expect(page.getByTestId('record-score-panel')).toBeVisible();

  await page.getByRole('button', { name: 'Edit fields' }).click();
  await page.getByLabel('Tax season returns').fill('850');
  await page.getByRole('button', { name: 'Save fields' }).click();
  await expect(page.getByText('850')).toBeVisible();

  // Dismiss toasts before taking screenshots.
  while ((await page.getByRole('button', { name: 'Dismiss' }).count()) > 0) {
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
  }

  // Open the interactive Lead Conversion Drawer and check axe + overflow at 1440px and 375px!
  await page.getByRole('button', { name: 'Convert to deal' }).click();
  const convertDrawer = page.getByRole('dialog', { name: 'Convert Clara Bennett' });
  await expect(convertDrawer).toBeVisible();
  await convertDrawer.getByLabel('Monthly fee').fill('6400');
  await convertDrawer.getByLabel('Term (months)').fill('24');

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `26-lead-convert-custom-scoring-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await convertDrawer.getByRole('button', { name: 'Convert lead' }).click();
  await expect(page.getByTestId('deal-profile-screen')).toBeVisible();
  await expect(page.getByText('24 months')).toBeVisible();
  await expect(page.getByText('US$6,400/mo').first()).toBeVisible();

  // Reload to verify deal terms persisted.
  await page.reload();
  await expect(page.getByText('24 months')).toBeVisible();

  // Open the converted Contact profile and verify local time, Merge with…, and secondary email!
  await page.getByRole('button', { name: 'Clara Bennett' }).click();
  await expect(page.getByTestId('contact-profile-screen')).toBeVisible();
  await expect(page.getByTestId('contact-local-time')).toContainText('Local time');
  await expect(page.getByRole('button', { name: 'Merge with…' })).toBeVisible();

  await page.getByLabel('Add secondary email').fill('c.bennett@bennettadvisory.example');
  await page.getByRole('button', { name: 'Add email' }).click();
  await expect(
    page.getByTestId('contact-channels-panel').getByText('c.bennett@bennettadvisory.example'),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByTestId('contact-channels-panel').getByText('c.bennett@bennettadvisory.example'),
  ).toBeVisible();
});

test('currencies settings, keyboard Kanban drag-and-drop, deal stakeholders, recurring tasks and tasks calendar work end-to-end', async ({
  page,
}) => {
  await signInAs(page, 'usr_admin_1');

  // 1. Settings → Currencies: save a new effective exchange rate and verify reload persistence.
  await page.goto('/?screen=settings&tab=currencies');
  await expect(page.getByTestId('settings-currencies-tab')).toBeVisible();
  await page.getByLabel('Exchange rate').fill('0.7385');
  await page.getByLabel('Effective date').fill('2026-11-18');
  await page.getByRole('button', { name: 'Save exchange rate' }).click();
  await expect(page.getByText('1 CAD = 0.7385 USD')).toBeVisible();
  await page.reload();
  await expect(page.getByText('1 CAD = 0.7385 USD')).toBeVisible();

  // 2. Switch to synthetic Sales Manager (Maya Lin) so all screens and screenshots show synthetic users only.
  await signInAs(page, 'usr_mgr_1');

  // Create a US lead, convert it to a deal, and add a second stakeholder contact on the same firm.
  await page.goto('/?screen=leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill('Marcus Sterling');
  await page.getByLabel('Work email').fill('marcus@sterlingtax-e2e.example');
  await page.getByLabel(/^Firm/).fill('Sterling Tax Group CPA');
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByText('Added Marcus Sterling as a new lead.')).toBeVisible();

  await page.getByRole('button', { name: 'Convert Marcus Sterling to a deal' }).click();
  await expect(page.getByText('Converted Marcus Sterling.')).toBeVisible();

  // Add a second contact so we can link them as a stakeholder on the deal.
  await page.goto('/?screen=contacts');
  await page.getByRole('button', { name: 'New contact' }).click();
  await page.getByLabel('First name').fill('Rachel');
  await page.getByLabel('Last name').fill('Sterling');
  await page.getByLabel('Work email').fill('rachel@sterlingtax-e2e.example');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText('Added Rachel Sterling.')).toBeVisible();

  // 3. Deals Kanban: verify collapsed Won/Lost zones and move deal via keyboard drag-and-drop!
  await page.goto('/?screen=deals');
  await expect(page.getByTestId('deals-kanban-screen')).toBeVisible();
  await expect(page.getByRole('region', { name: /^Won,/ })).toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await expect(page.getByRole('region', { name: /^Lost,/ })).toHaveAttribute(
    'data-collapsed',
    'true',
  );

  const sterlingCard = page.locator('li', { hasText: 'Sterling Tax Group CPA' });
  await expect(sterlingCard).toBeVisible();
  const dragHandle = sterlingCard.getByRole('button', { name: /^Drag / });
  await dragHandle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('kanban-keyboard-banner')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');

  // If the next stage requires gate details, fill them; otherwise the quick move completes directly.
  const gateDialog = page.getByTestId('stage-gate-dialog');
  if ((await gateDialog.count()) > 0) {
    const trialInput = gateDialog.getByLabel('Trial candidate role');
    if ((await trialInput.count()) > 0) {
      await trialInput.fill('Audit senior');
    }
    await gateDialog.getByRole('button', { name: /^Move to / }).click();
  }
  await expect(page.getByText(/Moved .* to /)).toBeVisible();

  // Open the deal profile and add Rachel Sterling as a stakeholder contact.
  await page
    .locator('li', { hasText: 'Sterling Tax Group CPA' })
    .getByRole('button', { name: /^Sterling Tax Group CPA/ })
    .click();
  await expect(page.getByTestId('deal-profile-screen')).toBeVisible();
  await expect(page.getByTestId('deal-contacts-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.getByLabel('Find contact').fill('Rachel Sterling');
  await page
    .getByLabel('Person')
    .selectOption({ label: 'Rachel Sterling (rachel@sterlingtax-e2e.example)' });
  await page.getByLabel('Role on this deal').selectOption('Reviewer');
  await page.getByRole('button', { name: 'Add stakeholder' }).click();
  await expect(page.getByTestId('deal-contacts-panel').getByText('Rachel Sterling')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('deal-contacts-panel').getByText('Rachel Sterling')).toBeVisible();

  // 4. Tasks: create a recurring weekly task, inspect Team tasks & Calendar at 1440px and 375px, then complete!
  await page.goto('/?screen=tasks');
  await expect(page.getByTestId('tasks-screen')).toBeVisible();
  await page.getByRole('button', { name: 'New task' }).click();
  const nowLocal = new Date(Date.now() + 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dueLocalStr = `${nowLocal.getFullYear()}-${pad(nowLocal.getMonth() + 1)}-${pad(nowLocal.getDate())}T${pad(nowLocal.getHours())}:${pad(nowLocal.getMinutes())}`;
  await page.getByLabel('Task', { exact: true }).fill('Sterling weekly staffing sync');
  await page.getByLabel('Due', { exact: true }).fill(dueLocalStr);
  await page.getByLabel(/^Repeats/).selectOption('weekly');
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByText('Sterling weekly staffing sync')).toBeVisible();
  await expect(page.getByText('Every week').first()).toBeVisible();

  // Manager Team tasks tab
  await page.getByRole('tab', { name: 'Team tasks' }).click();
  await expect(page.getByTestId('team-tasks-summary')).toBeVisible();

  // Switch to Calendar display and run axe + overflow + screenshots at 1440px and 375px
  while ((await page.getByRole('button', { name: 'Dismiss' }).count()) > 0) {
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
  }
  await page
    .getByRole('group', { name: 'Tasks display' })
    .getByRole('button', { name: 'Calendar' })
    .click();
  await expect(page.getByTestId('tasks-calendar')).toBeVisible();
  await expect(
    page.getByTestId('tasks-calendar').getByText('Sterling weekly staffing sync').first(),
  ).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `27-deals-kanban-tasks-calendar-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Switch back to List, mark the recurring task done, and verify the next weekly occurrence is spawned!
  await page
    .getByRole('group', { name: 'Tasks display' })
    .getByRole('button', { name: 'List' })
    .click();
  await page.getByRole('tab', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Mark "Sterling weekly staffing sync" done' }).click();
  await expect(
    page.getByText('Marked "Sterling weekly staffing sync" done and scheduled the next task.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sterling weekly staffing sync', exact: true }),
  ).toBeVisible();
});

test('dashboard portfolio deltas and standalone standard reports with currency toggle, View as table and audited CSV export work end-to-end', async ({
  page,
}) => {
  // Sign in as synthetic Sales Manager (Maya Lin) so all screens and screenshots use synthetic names only.
  await signInAs(page, 'usr_mgr_1');

  await page.goto('/?screen=dashboard');
  await expect(page.getByTestId('dashboard-screen')).toBeVisible();
  await expect(page.getByTestId('dashboard-summary-strip')).toBeVisible();
  await expect(page.getByTestId('dashboard-summary-strip')).toContainText('Total companies');
  await expect(page.getByTestId('dashboard-summary-strip')).toContainText('Total contacts');
  await expect(page.getByTestId('dashboard-summary-strip')).toContainText('Lead conversion rate');
  await expect(page.getByTestId('kpi-delta').first()).toBeVisible();

  // Navigate to standalone Reports screen via "Open reports"
  await page.getByRole('button', { name: 'Open reports' }).click();
  await expect(page.getByTestId('reports-screen')).toBeVisible();

  // Switch to Pipeline report, reveal original currencies, and check View as table toggle
  await page.getByRole('tab', { name: 'Pipeline' }).click();
  await expect(page.getByText('Pipeline by stage & owner')).toBeVisible();
  await page.getByRole('button', { name: /Original currencies/ }).click();
  await expect(page.getByTestId('report-currency-breakdown')).toBeVisible();

  // Check axe + zero horizontal overflow + capture 1440px and 375px screenshots
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `28-reports-analytics-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Toggle "View as table" on the first chart and verify accessible table view
  await page
    .getByTestId('report-chart-by_stage')
    .getByRole('button', { name: 'View as table' })
    .click();
  await expect(
    page.getByTestId('report-chart-by_stage').getByRole('button', { name: 'View as chart' }),
  ).toBeVisible();

  // Switch through Won, lost & revenue and Activity & follow-ups tabs
  await page.getByRole('tab', { name: 'Won, lost & revenue' }).click();
  await expect(page.getByText('Won, lost & revenue').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Activity & follow-ups' }).click();
  await expect(page.getByText('Activity & follow-up completion')).toBeVisible();

  // Export CSV and verify file download
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('adas-report-employee_activity');
  await expect(page.getByText('Report exported as CSV.')).toBeVisible();
});

test('sending an email from a contact profile appears on the timeline, and Inbox threads support replies, deal linking and tasks from email', async ({
  page,
}) => {
  await signInAs(page, 'usr_mgr_1');

  // 1. Open Contact profile (Jane Patel) and send a 1:1 email using a template (A10)
  await page.goto('/?screen=contact&id=cnt_jane');
  await expect(page.getByTestId('contact-profile-screen')).toBeVisible();
  await page.getByRole('button', { name: 'Send email' }).click();

  await page.getByLabel('Template (optional)').selectOption('tpl_inbox_trial_intro');
  await page.getByLabel('Subject').fill('Kickoff checklist for {{company_name}}');
  await page
    .getByLabel('Message')
    .fill('Hi {{first_name}}, sharing our UltraTax kickoff steps for {{company_name}}.');
  await page.getByRole('button', { name: 'Send email' }).last().click();
  await expect(page.getByText('Email sent.')).toBeVisible();

  // Verify the rendered message immediately appears in the Contact timeline and survives a reload
  await expect(page.getByText('Kickoff checklist for Acme Tax & Advisory LLP')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Kickoff checklist for Acme Tax & Advisory LLP')).toBeVisible();

  // 2. Navigate to Inbox via sidebar and verify threads, axe & 1440px / 375px layout
  await page.getByRole('button', { name: 'Inbox' }).first().click();
  await expect(page.getByTestId('inbox-screen')).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: /Kickoff checklist for Acme Tax & Advisory LLP|Re: 3-day UltraTax CS trial candidate resumes/,
    }),
  ).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `29-inbox-threads-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 3. Create a follow-up task from an email message and reply in thread
  await page.getByRole('button', { name: 'Create task' }).first().click();
  await page.getByLabel('Task title').fill('Send candidate NDA before trial day 1');
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByText('Task created from email.')).toBeVisible();

  await page.getByLabel('Write a reply').fill('Confirmed — see you Tuesday morning at 9:30 am CT.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('Reply sent.')).toBeVisible();
  await expect(
    page.getByText('Confirmed — see you Tuesday morning at 9:30 am CT.').first(),
  ).toBeVisible();
});

test('sequences and campaigns support multi-step enrollment, contact outreach history, non-creator approval guard, test sends and reload persistence', async ({
  page,
}) => {
  await signInAs(page, 'usr_mgr_1');

  // 1. Open Sequences, create a multi-step sequence (email + task), and enroll Elena Rostova
  await page.goto('/?screen=sequences');
  await expect(page.getByTestId('sequences-screen')).toBeVisible();

  await page.getByRole('button', { name: 'New sequence' }).click();
  await page.getByLabel('Sequence name').fill('Busy Season UltraTax Pod Sequence');
  await page.getByRole('button', { name: 'Add task step' }).click();
  await page.getByRole('button', { name: 'Create sequence' }).click();
  await expect(page.getByText('Sequence created.')).toBeVisible();

  await page.getByRole('button', { name: 'Busy Season UltraTax Pod Sequence' }).click();
  await expect(page.getByTestId('sequence-detail-view')).toBeVisible();

  await page.getByRole('button', { name: 'Enroll contacts' }).first().click();
  await page.getByLabel('Find contacts').fill('Elena Rostova');
  await page.getByRole('checkbox', { name: /Elena Rostova/ }).check();
  await page.getByRole('button', { name: 'Enroll 1 contact' }).click();
  await expect(page.getByText('Enrolled 1 contact.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Elena Rostova' })).toBeVisible();

  // Verify persistence across reload, axe WCAG 2.2 AA & zero horizontal scroll at 1440px and 375px
  await page.reload();
  await expect(page.getByRole('button', { name: 'Elena Rostova' })).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `30-sequences-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Open Elena Rostova's contact profile from the sequence and verify the Outreach panel
  await page.getByRole('button', { name: 'Elena Rostova' }).click();
  await expect(page.getByTestId('contact-profile-screen')).toBeVisible();
  await expect(
    page.getByTestId('contact-outreach-panel').getByText('Busy Season UltraTax Pod Sequence'),
  ).toBeVisible();

  // 2. Sign in as Marketing Manager (usr_mkt_1), create a block-based Campaign draft, and submit for approval
  await signInAs(page, 'usr_mkt_1');
  await page.goto('/?screen=campaigns');
  await expect(page.getByTestId('campaigns-screen')).toBeVisible();

  await page.getByRole('button', { name: 'New campaign' }).click();
  await page.getByLabel('Campaign name').fill('January Tax Capacity Briefing');
  await page
    .getByLabel('Email subject')
    .fill('3-day UltraTax & CCH staffing pilot for {{company.name|your firm}}');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Campaign draft saved.')).toBeVisible();

  await page.getByRole('button', { name: 'January Tax Capacity Briefing' }).click();
  await expect(page.getByTestId('campaign-detail-view')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Campaign submitted for second-person approval.')).toBeVisible();

  // Non-creator approval guard: creator (Marketing Manager) cannot self-approve
  await expect(page.getByRole('button', { name: 'Approve campaign' })).toBeDisabled();
  await expect(
    page.getByText(
      'You created this campaign, so another Marketing Manager or Admin must review and approve it before sending.',
    ),
  ).toBeVisible();

  // 3. Sign in as Admin (usr_admin_1), approve the campaign, send internal test email, and trigger send
  const campaignDetailUrl = page.url();
  await signInAs(page, 'usr_admin_1');
  await page.goto(campaignDetailUrl);
  await expect(page.getByTestId('campaign-detail-view')).toBeVisible();

  await page.getByRole('button', { name: 'Approve campaign' }).click();
  await expect(page.getByText('Campaign approved.')).toBeVisible();

  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Test email sent.')).toBeVisible();

  await page.getByRole('button', { name: 'Send campaign' }).click();
  await expect(
    page.getByText('Campaign audience snapshotted and queued for throttled delivery.'),
  ).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `31-campaigns-${width}w.png`),
      fullPage: true,
    });
  }
});

test('settings integrations and webhooks manage Apollo credit caps, one-time scoped API tokens, encrypted outbound webhooks and delivery logs', async ({
  page,
}) => {
  await signInAs(page, 'usr_admin_1');

  // 1. Settings -> Integrations: update Apollo daily credit cap and create a scoped Service API token
  await page.goto('/?screen=settings&tab=integrations');
  await expect(page.getByTestId('settings-integrations-tab')).toBeVisible();

  await page.getByLabel('Daily credit limit').fill('350');
  await page.getByRole('button', { name: 'Save credit limit' }).click();
  await expect(page.getByText('Daily Apollo credit limit updated to 350.')).toBeVisible();

  await page.getByRole('button', { name: 'New API token' }).first().click();
  await page.getByLabel('Token name').fill('n8n Deal Won Sync');
  await page.getByLabel('Record scope').selectOption('all');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByTestId('revealed-api-token')).toContainText('adas_pat_');

  // Persist across reload; one-time secret is no longer shown after reload
  await page.reload();
  await expect(page.getByText('n8n Deal Won Sync')).toBeVisible();
  await expect(page.getByTestId('revealed-api-token')).toHaveCount(0);

  // 2. Settings -> Webhooks: add an encrypted outbound webhook, inspect secret & delivery log, check axe
  await page.getByRole('tab', { name: 'Webhooks' }).click();
  await expect(page.getByTestId('settings-webhooks-tab')).toBeVisible();

  await page.getByRole('button', { name: 'Add endpoint' }).first().click();
  await page.getByLabel('Endpoint name').fill('Partner Onboarding Hook');
  await page.getByLabel('Destination URL').fill('http://127.0.0.1:3000/healthz');
  await page.getByRole('button', { name: 'Create endpoint' }).click();
  await expect(page.getByText('Webhook endpoint created.')).toBeVisible();
  await expect(page.getByTestId('revealed-webhook-secret')).toContainText('whsec_');

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `32-integrations-webhooks-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const hookRow = page.locator('tr', { hasText: 'Partner Onboarding Hook' });
  await hookRow.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText(/Test webhook (delivered|failed)/)).toBeVisible();
  await hookRow.getByRole('button', { name: 'Deliveries' }).click();
  await expect(page.getByText('webhook.test')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByText('Partner Onboarding Hook')).toBeVisible();
});

test('settings system health shows live PostgreSQL, worker, outbox and backup telemetry and passes axe at 1440px and 375px', async ({
  page,
}) => {
  await signInAs(page, 'usr_admin_1');
  await page.goto('/?screen=settings&tab=system-health');
  await expect(page.getByTestId('settings-system-health-tab')).toBeVisible();
  await expect(page.getByText('Readiness & runtime telemetry')).toBeVisible();
  await expect(page.getByText('Connected')).toBeVisible();

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Worker processes')).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `33-system-health-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('inbox and integrations offer both Microsoft 365 and Google Workspace mailbox connections and pass axe at 1440px and 375px', async ({
  page,
}) => {
  await signInAs(page, 'usr_admin_1');
  await page.goto('/?screen=inbox');
  await expect(page.getByTestId('inbox-screen')).toBeVisible();
  await expect(page.getByTestId('connect-microsoft-mailbox-btn')).toBeVisible();
  await expect(page.getByTestId('connect-google-mailbox-btn')).toBeVisible();

  await page.getByTestId('connect-google-mailbox-btn').click();
  await expect(
    page.getByText('Google Workspace is not configured on this server yet.'),
  ).toBeVisible();

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: resolve(SCREENS_DIR, `35-inbox-dual-provider-${width}w.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/?screen=settings&tab=integrations');
  await expect(page.getByText('Google Workspace sign-in')).toBeVisible();
  await expect(page.getByText('Google Workspace Gmail sync')).toBeVisible();
});
