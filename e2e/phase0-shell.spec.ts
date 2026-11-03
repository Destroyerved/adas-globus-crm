import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SCREENS_DIR = resolve(process.cwd(), 'docs/screens');

async function assertNoHorizontalOverflow(page: Page) {
  const details = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const winWidth = window.innerWidth;
    if (docWidth <= winWidth) {
      return null;
    }
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.right > winWidth + 1) {
        offenders.push(
          `${el.tagName.toLowerCase()}.${el.className} (right=${Math.round(rect.right)}, win=${winWidth})`,
        );
      }
    }
    return { docWidth, winWidth, offenders: offenders.slice(0, 8) };
  });
  expect(details).toBeNull();
}

async function assertNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('Phase 0 static shell, accessibility (axe), responsiveness and screenshots', () => {
  test.beforeAll(() => {
    mkdirSync(SCREENS_DIR, { recursive: true });
  });

  const screens: Array<{
    name: string;
    query: string;
    testId: string;
  }> = [
    { name: '01-login', query: '?screen=login', testId: 'login-screen' },
    { name: '02-leads-list', query: '?screen=leads', testId: 'leads-screen' },
    { name: '03-company-profile', query: '?screen=company', testId: 'company-profile-screen' },
    { name: '04-deals-kanban', query: '?screen=deals', testId: 'deals-kanban-screen' },
    { name: '05-empty-state', query: '?screen=empty', testId: 'empty-showcase-screen' },
    { name: '06-command-palette', query: '?screen=leads&palette=1', testId: 'command-palette' },
  ];

  for (const screen of screens) {
    test(`${screen.name}: renders at 1440px and 375px, passes axe, has no horizontal scroll, and saves screenshots`, async ({
      page,
    }) => {
      // 1. Desktop 1440x900
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/${screen.query}`);
      await expect(page.getByTestId(screen.testId)).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await assertNoAxeViolations(page);

      await page.screenshot({
        path: resolve(SCREENS_DIR, `${screen.name}-1440w.png`),
        fullPage: false,
      });

      // 2. Mobile 375x812
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/${screen.query}`);
      await expect(page.getByTestId(screen.testId)).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await assertNoAxeViolations(page);

      await page.screenshot({
        path: resolve(SCREENS_DIR, `${screen.name}-375w.png`),
        fullPage: false,
      });
    });
  }

  test('keyboard shortcuts: Ctrl+K opens command palette and Escape closes it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?screen=leads');
    await expect(page.getByTestId('leads-screen')).toBeVisible();

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toBeHidden();
  });
});
