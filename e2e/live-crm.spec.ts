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
  // Twelve full axe scans (six tabs at two widths) need more than the default 30 seconds.
  test.setTimeout(120_000);
  await signInAs(page, 'usr_admin_1');
  const tabs: [string, (p: Page) => Locator][] = [
    ['teams', (p) => p.getByRole('button', { name: 'New team' })],
    ['roles', (p) => p.getByRole('columnheader', { name: 'Which records' })],
    ['pipelines', (p) => p.getByText('Free Trial (3-Day)').first()],
    ['lists', (p) => p.getByRole('heading', { name: 'Lead sources' })],
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
