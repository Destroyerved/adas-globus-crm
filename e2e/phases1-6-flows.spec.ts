import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PHASE_SCREENS = [
  { query: '?screen=tasks', selector: '[data-testid="tasks-screen"]', label: 'Tasks & SLA Center' },
  {
    query: '?screen=inbox',
    selector: '[data-testid="inbox-screen"]',
    label: 'Connected M365 Inbox',
  },
  {
    query: '?screen=outreach',
    selector: '[data-testid="outreach-screen"]',
    label: 'Sequences, Campaigns & checkSendable Gate',
  },
  {
    query: '?screen=imports',
    selector: '[data-testid="imports-duplicates-screen"]',
    label: 'CSV Import Dry-Run, Duplicate Merge & Bigin Cutover',
  },
  {
    query: '?screen=reports',
    selector: '[data-testid="reports-intelligence-screen"]',
    label: 'Multi-Currency FX Reports, Lead Scoring & Audit Log',
  },
] as const;

test.describe('Phases 1–6 E2E Flows, WCAG 2.2 AA (axe), and Responsive Verification', () => {
  for (const screen of PHASE_SCREENS) {
    test(`${screen.label} (${screen.query}): renders at 1440px and 375px, passes axe, and has no horizontal overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/${screen.query}`);
      await page.waitForSelector(screen.selector);

      const desktopOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(desktopOverflow).toBe(false);

      const desktopAxe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(desktopAxe.violations).toEqual([]);

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
});
