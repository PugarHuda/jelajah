// Accessibility of every page with axe-core (the engine Lighthouse uses), in light and dark mode, at phone width.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROUTES = ['', '#/stats', '#/till/1', '#/story', '#/stall/1', '#/rallies', '#/organize', '#/gift', '#/device/1', '#/identity',
  '#/solidcash', '#/reclaim', '#/sponsor', '#/u/bitcoincash:qqd2thqn52yy8j85fdk782gffdns9yqelulnlj6s3q'];

for (const scheme of ['light', 'dark'] as const) test.describe(`${scheme} mode`, () => {
  test.use({ colorScheme: scheme, viewport: { width: 390, height: 844 } });
  for (const r of ROUTES) test(`${r || 'home'} has no WCAG A/AA violations`, async ({ page }) => {
    await page.goto(`/?net=chipnet&lang=en${r}`);
    await page.reload();
    await expect(page.locator('h1').first()).toBeVisible();
    await page.waitForTimeout(2500); // chain data rendered
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
});
