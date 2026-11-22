// Real-user journeys: every step is a click, a keystroke or a download, on the production build, reading BCH mainnet.
// Signing needs a phone wallet (WizardConnect), so the journeys go up to the wallet prompt and no further.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.describe.configure({ timeout: 120_000 });
const OWN_STAMP = '8718bc42'; // the first mainnet levy stamp (Kopi Joss)

test('a visitor switches language, opens the wallet prompt and closes it', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
  await page.getByRole('button', { name: 'ID', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Jajan di 3 warung');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
  // without a wallet nothing can be bought or claimed
  for (const b of await page.getByRole('button', { name: /^Buy/ }).all()) await expect(b).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Claim/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByText('Scan with Selene or Paytaca')).toBeVisible();
  await expect(page.getByText(/^wiz:\/\//)).toBeVisible(); // the WizardConnect pairing URI under the QR
  await page.locator('button[aria-label*="lose" i], button:has-text("×")').first().click();
  await expect(page.getByText('Scan with Selene or Paytaca')).toBeHidden();
});

test('home → stall dashboard → collector page → back, all by clicking', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: 'Sales per stall, from the chain' }).click();
  await expect(page.getByRole('heading', { name: 'Stall dashboard' })).toBeVisible();
  const kopi = page.getByRole('row', { name: /Kopi Joss/ });
  await expect(kopi).toContainText('1,500 sats', { timeout: 60_000 });
  await expect(page.getByText(/Sets completed: \d/)).toBeVisible();
  await page.getByRole('link', { name: /bitcoincash:qqd2th/ }).first().click();
  await expect(page.getByText(/stalls in hand/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: '← Back to the rally' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
});

test('the all-season leaderboard loads on click, with its streak column', async ({ page }) => {
  await page.goto('/?lang=en#/stats');
  await page.getByRole('button', { name: 'Load the all-season leaderboard' }).click();
  const table = page.locator('table').last();
  await expect(table.getByRole('columnheader', { name: 'Seasons' })).toBeVisible({ timeout: 90_000 });
  await expect(table.getByRole('columnheader', { name: '🔥' })).toBeVisible();
  await expect(table.getByRole('row')).not.toHaveCount(1);
});

test('a stall owner opens the till, turns the bell on and downloads the sales CSV', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: '🔔 Kopi Joss' }).click();
  await expect(page.getByRole('heading', { name: /Kopi Joss/ })).toBeVisible();
  await page.getByRole('button', { name: '🔔 Turn on the sale bell' }).click();
  await expect(page.getByRole('button', { name: '🔔 Turn on the sale bell' })).toBeHidden();
  await expect(page.getByRole('link', { name: new RegExp(OWN_STAMP) })).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download sales/ }).click()]);
  expect(download.suggestedFilename()).toBe('Kopi Joss-sales.csv');
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.split('\n')[0]).toBe('txid,buyer,paid_sats,confirmed');
  expect(csv).toContain(OWN_STAMP);
  expect(csv).toMatch(/bitcoincash:q[a-z0-9]+,1500,true/);
});

test('a stall owner prints the poster, reveals the till QR and opens the guide', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: '☕ Kopi Joss' }).click(); // a plain link: the router follows hashchange
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kopi Joss');
  await page.evaluate(() => { (window as any).printed = 0; window.print = () => { (window as any).printed++; }; });
  await page.getByRole('button', { name: /Print this poster/ }).click();
  expect(await page.evaluate(() => (window as any).printed)).toBe(1);
  await page.getByText(/Till QR for the stall/).click();
  await expect(page.getByRole('img', { name: /till/i })).toBeVisible();
  const guideLink = page.getByRole('link', { name: /guide for stall owners/ });
  const res = await page.request.get(await guideLink.getAttribute('href') as string);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('pdf');
  await page.getByRole('link', { name: /open the till/ }).click();
  await expect(page.getByRole('button', { name: '🔔 Turn on the sale bell' })).toBeVisible();
});

test('a newcomer reads the story and starts the rally from its last panel', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: /A day of roaming Jogja/ }).click();
  await expect(page.getByRole('heading', { name: 'A day of roaming Jogja' })).toBeVisible();
  await page.getByRole('link', { name: 'Start the rally →' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
});

test('community rallies list the official seasons and lead to the organizer', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: /Community rallies on Nostr/ }).click();
  await expect(page.getByRole('link', { name: /Jelajah Jogja · live/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /e0ed3240/ })).toBeVisible();
  await page.getByRole('link', { name: 'Open one →' }).click();
  await expect(page.getByRole('heading', { name: 'Open your own rally' })).toBeVisible();
});

test('an organizer adds and removes stalls, hits every rule, then reaches the wallet prompt', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: 'Open your own rally →' }).click();
  await expect(page.locator('.stall-row')).toHaveCount(3);
  await page.getByRole('button', { name: '+ Add a stall' }).click();
  await expect(page.locator('.stall-row')).toHaveCount(4);
  await page.getByRole('button', { name: '− Remove the last' }).click();
  await expect(page.locator('.stall-row')).toHaveCount(3);
  await page.getByPlaceholder('Jelajah Malioboro').pressSequentially('Jelajah QA');
  await page.getByLabel('Reward per set (sats)').fill('999999');
  await expect(page.locator('.error')).toContainText('anti-farming');
  await page.getByLabel('Reward per set (sats)').fill('2000');
  await page.getByLabel('Levy per stamp (sats, optional)').fill('2500');
  await page.getByLabel('🔥 Streak: days in a row (optional, needs a levy)').fill('3');
  await page.getByLabel('Streak reward (sats)').fill('50000');
  await expect(page.locator('.error')).toContainText('streak');
  await page.getByLabel('Streak reward (sats)').fill('3000');
  await expect(page.locator('.error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByText('Scan with Selene or Paytaca')).toBeVisible();
});

test('a friend makes a gift link, and a reload keeps the same gift address', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: /Give a friend sats/ }).click();
  await page.getByText('Make a gift').click();
  const addr = page.getByText(/^bitcoincash:q[a-z0-9]{41}$/).first();
  await expect(addr).toBeVisible();
  const before = await addr.innerText();
  expect(page.url()).toMatch(/#\/gift.+/); // the key lives in the fragment, never sent to a server
  await page.reload();
  await expect(page.getByText(before).first()).toBeVisible();
});

test('a stall device refuses a garbage buyer code and offers a key backup', async ({ page }) => {
  await page.goto('/?lang=en#/device/1');
  await page.reload();
  await page.getByPlaceholder("buyer's code").fill('not-a-code');
  await expect(page.locator('.error').last()).toBeVisible();
  await page.getByText('Back up or move this key').click();
  await expect(page.getByPlaceholder('…')).toBeVisible();
  await page.getByRole('link', { name: /Open this stall’s till/ }).click();
  await expect(page.getByRole('button', { name: '🔔 Turn on the sale bell' })).toBeVisible();
});

test('Jelajah ID: typing a bad key and verifying shows an error, not a crash', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: /Link your BCH address with Nostr/ }).click();
  const verify = page.getByRole('button', { name: 'Verify' });
  await expect(verify).toBeDisabled();
  await page.getByPlaceholder('npub1… / bitcoincash:q…').fill('npub1nonsense');
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect(page.locator('.error, .hint').last()).toBeVisible({ timeout: 30_000 });
});

test('reclaim stays locked for a bad key and before the rally ends', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByRole('link', { name: 'reclaim after the end' }).click();
  await page.getByPlaceholder('K… / L… / c…').fill('Kxnotawif');
  await page.getByPlaceholder('bitcoincash:z…').fill('bitcoincash:qqd2thqn52yy8j85fdk782gffdns9yqelulnlj6s3q');
  await expect(page.getByRole('button', { name: 'Reclaim the pool' })).toBeDisabled();
});

test('a stall location opens the map in a new tab', async ({ page, context }) => {
  await page.goto('/?lang=en');
  const [map] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: /Jl. Wongsodirjan/ }).first().click()]);
  expect(map.url()).toContain('openstreetmap.org');
});

test('every stall poster link and the browser back button work like a normal site', async ({ page }) => {
  await page.goto('/?lang=en');
  for (const [link, name] of [['☕ Kopi Joss', 'Kopi Joss'], ['🍜 Bakmi Jawa', 'Bakmi Jawa'], ['🍢 Sate Klathak', 'Sate Klathak'], ['🥥 Es Dawet', 'Es Dawet']]) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByRole('button', { name: /Print this poster/ })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
  }
  await page.getByRole('link', { name: '🔔 Bakmi Jawa' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bakmi Jawa');
  await page.goBack();
  await page.goForward();
  await expect(page.getByRole('button', { name: '🔔 Turn on the sale bell' })).toBeVisible();
});

test('switching language on an inner page keeps the page and flips the text', async ({ page }) => {
  await page.goto('/?lang=en#/stall/1');
  await expect(page.getByRole('button', { name: /Print this poster/ })).toBeVisible();
  await page.goto('/?lang=en#/story');
  await page.getByRole('button', { name: 'ID', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Mulai rally →' })).toBeVisible();
  await page.getByRole('link', { name: 'Mulai rally →' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Jajan di 3 warung');
});

test('a judge opens the 3-transaction proof of the levy cycle on the home page', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByText('How the pool pays for itself').click();
  const cycle = page.locator('details.cycle');
  await expect(cycle.getByRole('link')).toHaveCount(5);
  await expect(cycle.getByRole('link', { name: /🏆 e411c9b9/ })).toHaveAttribute('href', /blockchair\.com\/bitcoin-cash\/transaction\/e411c9b9/);
});

test('a sponsor finds the voucher page from the rally and is asked for a wallet (chipnet)', async ({ page }) => {
  await page.goto('/?net=chipnet&lang=en');
  await page.getByRole('link', { name: 'Sponsors: hand out vouchers →' }).click();
  await expect(page.getByRole('heading', { name: '🎟 Hand out vouchers' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect the sponsor wallet' }).click();
  await expect(page.getByText('Scan with Selene or Paytaca')).toBeVisible();
});

test.describe('an Indonesian browser', () => {
  test.use({ locale: 'id-ID' });
  test('still opens in English by default, and remembers ID once chosen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Eat at 3 stalls');
    await page.getByRole('button', { name: 'ID', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Jajan di 3 warung');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Jajan di 3 warung');
  });
});
