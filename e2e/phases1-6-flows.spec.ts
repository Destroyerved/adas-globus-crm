import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SCREENS_DIR = resolve(process.cwd(), 'docs/screens');

const PHASE_SCREENS = [
  {
    name: '07-tasks-sla',
    query: '?screen=tasks',
    selector: '[data-testid="tasks-screen"]',
    label: 'Tasks & SLA Center',
  },
  {
    name: '08-inbox-m365',
    query: '?screen=inbox',
    selector: '[data-testid="inbox-screen"]',
    label: 'Connected M365 Inbox',
  },
  {
    name: '09-outreach-compliance',
    query: '?screen=outreach',
    selector: '[data-testid="outreach-screen"]',
    label: 'Sequences, Campaigns & checkSendable Gate',
  },
  {
    name: '10-imports-duplicates',
    query: '?screen=imports',
    selector: '[data-testid="imports-duplicates-screen"]',
    label: 'CSV Import Dry-Run, Duplicate Merge & Bigin Cutover',
  },
  {
    name: '11-reports-intelligence',
    query: '?screen=reports',
    selector: '[data-testid="reports-intelligence-screen"]',
    label: 'Multi-Currency FX Reports, Lead Scoring & Audit Log',
  },
] as const;

test.describe('Phases 1–6 E2E Flows, WCAG 2.2 AA (axe), and Responsive Verification', () => {
  test.beforeAll(() => {
    mkdirSync(SCREENS_DIR, { recursive: true });
  });

  for (const screen of PHASE_SCREENS) {
    test(`${screen.label} (${screen.query}): renders at 1440, 1280, 768, and 375px, passes axe, has no horizontal overflow, and saves screenshots`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/${screen.query}`);
      await page.waitForSelector(screen.selector);

      // Verify DESIGN.md computed tokens at 1440px
      const computedMetrics = await page.evaluate(() => {
        const rootStyle = getComputedStyle(document.documentElement);
        const bodyStyle = getComputedStyle(document.body);
        const sidebar = document.querySelector('aside[aria-label="Primary navigation"]');
        const topbar = document.querySelector('header');
        return {
          bgToken: rootStyle.getPropertyValue('--bg').trim(),
          navyToken: rootStyle.getPropertyValue('--navy').trim(),
          primaryToken: rootStyle.getPropertyValue('--primary').trim(),
          fontFamily: bodyStyle.fontFamily,
          sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
          topbarHeight: topbar ? Math.round(topbar.getBoundingClientRect().height) : 0,
        };
      });
      expect(computedMetrics.bgToken).toBe('#fbfcfb');
      expect(computedMetrics.navyToken).toBe('#041c3e');
      expect(computedMetrics.primaryToken).toBe('#00778a');
      expect(computedMetrics.fontFamily.toLowerCase()).toContain('hanken grotesk');
      expect(computedMetrics.sidebarWidth).toBe(248);
      expect(computedMetrics.topbarHeight).toBe(56);

      const desktopOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(desktopOverflow).toBe(false);

      const desktopAxe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(desktopAxe.violations).toEqual([]);

      await page.screenshot({
        path: resolve(SCREENS_DIR, `${screen.name}-1440w.png`),
        fullPage: false,
      });

      // Check 1280px and 768px breakpoints (AGENTS.md §9)
      for (const width of [1280, 768]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(overflow).toBe(false);
      }

      // Check 375px mobile breakpoint
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(100);

      const mobileOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(mobileOverflow).toBe(false);

      const mobileAxe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(mobileAxe.violations).toEqual([]);

      await page.screenshot({
        path: resolve(SCREENS_DIR, `${screen.name}-375w.png`),
        fullPage: false,
      });
    });
  }

  test('interactive flows across Tasks, Inbox, Outreach Compliance Simulator, Imports & Multi-Currency Reports', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1. Tasks screen: add a new task and filter by 15m Website SLA
    await page.goto('/?screen=tasks');
    await page.fill(
      'input[aria-label="New task title"]',
      'Verify Citrix UltraTax login for Acme trial',
    );
    await page.click('button:has-text("Add task")');
    await expect(page.locator('text=Verify Citrix UltraTax login for Acme trial')).toBeVisible();

    // 2. Inbox screen: send a reply via Mailpit sandbox
    await page.goto('/?screen=inbox');
    await page.fill(
      '#inbox-reply-textarea',
      'Confirmed — our Senior Tax Preparer will join the 9:00 am CT onboarding call.',
    );
    await page.click('button:has-text("Send reply")');
    await expect(
      page.locator('text=Reply passed checkSendable() and was delivered to Mailpit sandbox.'),
    ).toBeVisible();

    // 3. Outreach screen: test checkSendable() reason codes & one-click unsubscribe
    await page.goto('/?screen=outreach');
    await page.click('button:has-text("Canada Cold Prospect (No CASL Consent)")');
    await expect(page.locator('text=Reason Code: NO_LAWFUL_BASIS')).toBeVisible();

    await page.click('button:has-text("Simulate >3% Bounce Auto-Pause (A20)")');
    await expect(page.locator('text=Auto-Paused (>3% bounce)')).toBeVisible();

    await page.click('button:has-text("Confirm one-click unsubscribe")');
    await expect(
      page.locator('text=Unsubscribed immediately · All active sequences & campaigns stopped'),
    ).toBeVisible();

    // Test Phase 6 n8n Marketing & Email Automation Pipeline (PRD §4.14)
    await page.click('button:has-text("Trigger n8n Lead Sequence Pipeline")');
    await expect(page.getByTestId('n8n-run-receipt')).toBeVisible();
    await expect(page.getByTestId('n8n-run-receipt')).toContainText('wf_01_lead_sequence_enroll');
    await expect(page.getByTestId('n8n-run-receipt')).toContainText('X-ADAS-Signature: sha256=');

    await page.click('button:has-text("Trigger n8n Campaign Dispatch")');
    await expect(page.getByTestId('n8n-run-receipt')).toContainText(
      'wf_02_marketing_campaign_dispatch',
    );

    await page.click('button:has-text("Mint n8n Scoped API Token")');
    await expect(page.getByTestId('n8n-pipeline-panel')).toContainText('Token: adas_pat_');

    // 4. Imports & Duplicates screen: execute import, rollback, merge, and undo merge
    await page.goto('/?screen=imports');
    await page.click('button:has-text("Execute Verified Import")');
    await expect(page.locator('text=Import Completed')).toBeVisible();
    await page.click('button:has-text("Rollback Import Job")');
    await expect(page.locator('text=Rolled Back')).toBeVisible();

    await page.click('button:has-text("Merge into Survivor")');
    await expect(page.locator('text=Merged (Snapshot Saved)')).toBeVisible();
    await page.click('button:has-text("Undo Merge from Snapshot")');
    await expect(page.locator('text=Merge Undone')).toBeVisible();

    // 5. Reports & Intelligence screen: toggle USD / CAD multi-currency rollup
    await page.goto('/?screen=reports');
    await expect(page.locator('text=US$18,588/mo')).toBeVisible();
    await page.click('button:has-text("Report in CAD (FX 1.3514)")');
    await expect(page.locator('text=CA$25,119/mo')).toBeVisible();
  });

  test('full end-to-end interactive user journey across Login, Topbar, Leads, Conversion, Bulk Actions, Company 360 Tabs & Deals Kanban', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1. Login Screen: test break-glass validation & dev persona login
    await page.goto('/?screen=login');
    await page.click('button:has-text("Admin sign-in (break-glass)")');
    await page.click('button:has-text("Sign in with break-glass account")');
    await expect(
      page.locator(
        'text=Enter your break-glass admin email, password and 6-digit authenticator code.',
      ),
    ).toBeVisible();

    // Prove dev login persona selector is compiled out of production builds (AGENTS.md §6)
    await expect(page.locator('#dev-user-select')).toHaveCount(0);
    await page.click('[data-testid="microsoft-signin-btn"]');
    await expect(page.getByTestId('leads-screen')).toBeVisible();

    // 2. Top Bar Notifications popover & Sidebar collapse/expand
    await page.click('button[aria-label="Notifications (2 unread)"]');
    await expect(page.locator('div[role="dialog"][aria-label="Notifications"]')).toBeVisible();
    await page.click('button:has-text("Mark all read")');
    await expect(page.locator('text=Notifications (0 unread)')).toBeVisible();
    await page.click('button[aria-label="Notifications (0 unread)"]');

    await page.click('button[aria-label="Collapse sidebar"]');
    await expect(page.locator('button[aria-label="Expand sidebar"]')).toBeVisible();
    await page.click('button[aria-label="Expand sidebar"]');
    await expect(page.locator('button[aria-label="Collapse sidebar"]')).toBeVisible();

    // 3. Leads Screen: create a new lead, convert a lead, sort, and run bulk actions
    await page.click('button:has-text("New lead")');
    await page.fill('input[aria-label="Contact full name"]', 'Nadia Kowalski');
    await page.fill(
      'input[aria-label="CPA firm name"]',
      'Maple Leaf Chartered Professional Accountants',
    );
    await page.fill('input[aria-label="Work email"]', 'n.kowalski@mapleleafcpa.example.ca');
    await page.selectOption('select[aria-label="Lead market"]', 'CA');
    await page.click('button:has-text("Save lead")');
    await expect(
      page.locator('text=Nadia Kowalski · Maple Leaf Chartered Professional Accountants'),
    ).toBeVisible();

    // Convert the newly created lead into Company + Contact + Deal + 3-Day Free Trial tasks
    await page.locator('button:has-text("Convert")').first().click();
    await expect(
      page.locator('text=Created Company, Contact, Deal & 3-day free trial check-in tasks'),
    ).toBeVisible();

    // Bulk action bar: Assign, Change status, Add tag, Export
    await page.locator('[data-testid="bulk-action-bar"] button:has-text("Assign")').click();
    await expect(page.locator('text=Assigned 2 selected leads to Priya Nair.')).toBeVisible();

    await page.locator('[data-testid="bulk-action-bar"] button:has-text("Change status")').click();
    await expect(
      page.locator('text=Updated status to Qualified for 2 selected leads.'),
    ).toBeVisible();

    await page.locator('[data-testid="bulk-action-bar"] button:has-text("Export")').click();
    await expect(
      page.locator('text=Exported 2 selected leads to CSV (audit log entry recorded).'),
    ).toBeVisible();

    // 4. Company 360 Profile: inline edit, all 6 tabs, and quick-log call composer
    await page.goto('/?screen=company');
    const desktopRail = page.locator('aside[aria-label="About company"]');
    await desktopRail.locator('button[aria-label^="Edit staff size:"]').click();
    await desktopRail.locator('input[aria-label="Edit staff size"]').fill('51–100');
    await desktopRail.locator('input[aria-label="Edit staff size"]').press('Enter');
    await expect(
      desktopRail.locator('button[aria-label="Edit staff size: 51–100 staff"]'),
    ).toBeVisible();

    // Switch through Overview, Contacts, Deals, Notes, History tabs
    await page.click('button[role="tab"]:has-text("Overview")');
    await expect(page.locator('text=Firmographic & compliance overview')).toBeVisible();

    await page.click('button[role="tab"]:has-text("Contacts (3)")');
    await expect(page.locator('text=Associated contacts (3)')).toBeVisible();

    await page.click('button[role="tab"]:has-text("Deals (2)")');
    await expect(page.locator('text=Firm recurring deals (2)')).toBeVisible();

    await page.click('button[role="tab"]:has-text("Notes (3)")');
    await expect(page.locator('text=Pinned partner notes (3)')).toBeVisible();

    await page.click('button[role="tab"]:has-text("History")');
    await expect(page.locator('text=Field-level record history (PRD 7.3)')).toBeVisible();

    // Log call via header button + quick-log composer
    await page.click('button:has-text("Log call")');
    await page.fill(
      'input[aria-label="Log a call"]',
      'Reviewed Suralink workpaper indexing with Jane Patel',
    );
    await page.click('button:has-text("Save call")');
    await expect(
      page.locator('text=Reviewed Suralink workpaper indexing with Jane Patel'),
    ).toBeVisible();

    // 5. Deals Kanban Board: create new CAD deal & move card via keyboard
    await page.goto('/?screen=deals');
    await page.click('button:has-text("New deal")');
    await page.fill('input[aria-label="Deal CPA firm name"]', 'Boreal Tax LLP');
    await page.fill('input[aria-label="Deal pod name"]', 'T2 Corporate Tax Pod (2 FTE)');
    await page.fill('input[aria-label="Monthly recurring value"]', '7500');
    await page.selectOption('select[aria-label="Deal currency"]', 'CAD');
    await page.click('button:has-text("Save deal")');
    await expect(page.getByRole('button', { name: 'Boreal Tax LLP' })).toBeVisible();
    await expect(page.locator('text=CA$7.5k/mo')).toBeVisible();

    // 6. Full-stack live API verification via Vite /api proxy -> @adas/api -> PostgreSQL 17
    const healthRes = await page.request.get('/api/v1/health');
    expect(healthRes.ok()).toBe(true);
    const healthJson = (await healthRes.json()) as { status: string; service: string };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.service).toBe('adas-crm-api');

    const intakeRes = await page.request.post('/api/v1/public/inquiries', {
      data: {
        name: 'Claire Fontaine',
        email: 'c.fontaine@fontainecpa.example.ca',
        firm: 'Fontaine & Associés CPA',
        country: 'CA',
        services: ['Canadian T1/T2 Tax'],
        software: ['TaxCycle'],
        sourcePage: '/ca/offshore-tax-staffing',
      },
    });
    expect(intakeRes.ok()).toBe(true);
    const intakeJson = (await intakeRes.json()) as { accepted: boolean; leadId: string };
    expect(intakeJson.accepted).toBe(true);
    expect(intakeJson.leadId).toBeTruthy();

    const rollupRes = await page.request.get('/api/v1/reports/pipeline-rollup?currency=USD', {
      headers: { 'x-dev-user-id': 'usr_admin_1' },
    });
    expect(rollupRes.ok()).toBe(true);
  });
});
