import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SCREENS_DIR = resolve(process.cwd(), 'docs/screens');
const DESKTOP_PREVIEW_URL = 'http://127.0.0.1:5185';

test.describe('Milestone 12 & 13: Desktop Server Management Console UI & Accessibility', () => {
  test('connects to local server agent, navigates telemetry/services/logs/backups/config/security, passes axe, and has zero horizontal scroll at 1440px and 375px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(DESKTOP_PREVIEW_URL);

    await expect(page.getByRole('heading', { name: 'No server connected yet' })).toBeVisible();

    // Connect local server (starts loopback @adas/server-agent & pairs with one-time code)
    await page.getByRole('button', { name: 'Connect local server' }).first().click();

    await expect(page.getByText('Memory usage')).toBeVisible();
    await expect(page.getByText('Application, worker, and tunnel health')).toBeVisible();

    // Check axe & horizontal scroll at 1440px on Overview
    const axe1440 = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe1440.violations).toEqual([]);
    const overflow1440 = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow1440).toBe(false);

    await page.screenshot({
      path: resolve(SCREENS_DIR, '34-desktop-server-console-1440w.png'),
      fullPage: true,
    });

    // Navigate across all remaining management tabs
    await page.getByRole('tab', { name: 'Services & releases' }).click();
    await expect(page.getByRole('heading', { name: 'Container lifecycle controls' })).toBeVisible();

    await page.getByRole('tab', { name: 'Logs & diagnostics' }).click();
    await expect(
      page.getByRole('heading', { name: 'Redacted service logs & diagnostics' }),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Backups & recovery' }).click();
    await expect(
      page.getByRole('heading', { name: 'Encrypted backups & verified restore drills' }),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Configuration & secrets' }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Vault secret slots (values are never transmitted to console)',
      }),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Security & audit' }).click();
    await expect(
      page.getByRole('heading', { name: 'Tamper-evident admin action audit log' }),
    ).toBeVisible();
    await expect(page.getByText(/Hash chain verified/)).toBeVisible();

    // Responsive 375px check + axe + screenshot
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('tab', { name: 'Overview & health' }).click();
    await expect(page.getByText('Memory usage')).toBeVisible();

    const axe375 = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe375.violations).toEqual([]);
    const overflow375 = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow375).toBe(false);

    await page.screenshot({
      path: resolve(SCREENS_DIR, '34-desktop-server-console-375w.png'),
      fullPage: true,
    });
  });
});
