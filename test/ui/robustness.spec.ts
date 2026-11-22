// Robustness on a phone: every route at 360 px wide, broken and hostile URLs, and the chain server being unreachable.
import { test, expect, type Page } from '@playwright/test';

const ROUTES = ['', '#/stats', '#/till/1', '#/story', '#/stall/1', '#/rallies', '#/organize', '#/gift', '#/device/1', '#/identity',
  '#/solidcash', '#/reclaim', '#/sponsor', '#/u/bitcoincash:qqd2thqn52yy8j85fdk782gffdns9yqelulnlj6s3q', '#/art'];

function watch(page: Page) {
  const errors: string[] = [];
  // WebKit also reports a blocked cross-origin fetch (e.g. a rate-limited price API) here, though the app catches it
  page.on('pageerror', (e) => { if (!/due to access control checks/.test(e.message)) errors.push(`pageerror: ${e.message}`); });
  return errors;
}
// content wider than the screen = sideways scrolling on a phone
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('on a 360 px phone', () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  for (const net of ['', 'net=chipnet&']) for (const r of ROUTES) {
    test(`${net ? 'chipnet ' : ''}${r || 'home'} fits the screen and runs without a script error`, async ({ page }) => {
      const errors = watch(page);
      await page.goto(`/?${net}lang=en${r}`);
      await page.reload(); // the router reads the hash on load
      await expect(page.locator(r === '#/art' ? 'svg' : 'h1').first()).toBeVisible(); // #/art is the press image: stamps only
      await page.waitForTimeout(1500); // let chain reads land and re-render
      expect(await overflow(page), 'horizontal overflow in px').toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
});

test('broken and hostile URLs show a message, never a blank page', async ({ page }) => {
  const errors = watch(page);
  for (const u of ['/?lang=en#/till/999', '/?lang=en#/stall/0', '/?lang=en#/u/garbage', '/?lang=en#/u/npub1zzzz', '/?lang=en#/gift/notawif',
    '/?lang=en&r=%%%garbage', '/?lang=en&r=eyJ4IjoxfQ', '/?lang=en&net=moon', '/?lang=en#/device/abc', '/?lang=en#/passport',
    '/?lang=en#/<script>alert(1)</script>']) {
    await page.goto(u);
    await page.reload();
    await expect(page.locator('body')).not.toHaveText(/^\s*$/);
    await expect(page.locator('main, h1').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('with the chain server unreachable, the rally still renders and says why numbers are missing', async ({ page }) => {
  const errors = watch(page);
  await page.routeWebSocket(/.*/, (ws) => ws.close()); // every Electrum socket refused
  await page.goto('/?lang=en');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
  await page.goto('/?lang=en#/stats');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Stall dashboard' })).toBeVisible();
  await page.waitForTimeout(8000);
  expect(errors).toEqual([]);
  // the dashboard must not sit on a spinner forever without telling the visitor
  await expect(page.locator('main')).toContainText(/couldn.t reach|unreachable|offline|try again|error/i);
});

for (const [net, first] of [['', 'bch.imaginary.cash'], ['net=chipnet&', 'chipnet.bch.ninja']]) {
  test(`with ${first} down, the app fails over to the next Fulcrum server and still reads the chain`, async ({ page }) => {
    const refused: string[] = [];
    await page.routeWebSocket((u) => u.hostname === first, (ws) => { refused.push(ws.url()); ws.close(); });
    await page.goto(`/?${net}lang=en#/stats`);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Stall dashboard' })).toBeVisible();
    await expect(page.getByText(/Sets completed: \d/)).toBeVisible({ timeout: 90_000 }); // numbers read from another server
    expect(refused.length).toBeGreaterThan(0); // the first server really was tried and refused
  });
}

test('once visited, the app opens offline (service worker), and says the chain is out of reach', async ({ page, context }) => {
  await page.goto('/?lang=en');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the worker, which caches the page and its assets
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
  await page.getByRole('link', { name: '☕ Kopi Joss' }).click(); // other pages of the app work offline too
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kopi Joss');
  await context.setOffline(false);
});

test.describe('on a phone, connecting a wallet that lives on the same phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('the pairing dialog says to copy the link into the wallet, and offers the copy button', async ({ page }) => {
    await page.goto('/?lang=en');
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await expect(page.getByText(/On this phone\? Tap copy under the code/)).toBeVisible();
    await expect(page.getByText(/^wiz:\/\//)).toBeVisible();
  });
});
