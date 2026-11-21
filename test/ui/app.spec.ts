import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

// a real chipnet rally (with presence stalls), shared the way the organizer page shares it
const presence = JSON.parse(readFileSync(new URL('../../scripts/rally.presence.chipnet.json', import.meta.url), 'utf8'));
const short = (r: object) => deflateRawSync(JSON.stringify(r)).toString('base64url');

test('organizer form enforces anti-farming, anti-collusion and valid addresses before any wallet', async ({ page }) => {
  await page.goto('/?lang=en#/organize');
  await expect(page.locator('.hint')).toContainText('Your wallet will lock about');
  await page.getByLabel('Reward per set (sats)').fill('20000');
  await expect(page.locator('.error')).toContainText('anti-farming');
  await page.getByLabel('Reward per set (sats)').fill('4000');
  await page.getByLabel('Levy per stamp (sats, optional)').fill('1000');
  await expect(page.locator('.error')).toContainText('anti-collusion');
  await page.getByLabel('Levy per stamp (sats, optional)').fill('');
  await page.locator('.stall-row').first().getByLabel("Stall's BCH address (empty = yours)").fill('bitcoincash:nonsense');
  await expect(page.locator('.error')).toContainText('Not a valid address');
});

test('a shared rally link loads with a third-party warning naming every payout address', async ({ page }) => {
  await page.goto(`/?lang=en&r=${short(presence)}`);
  await expect(page.locator('.warn')).toContainText('Community rally from a link');
  await expect(page.locator('.warn li')).toHaveCount(presence.merchants.length);
  await expect(page.locator('.pill')).toHaveText('chipnet (test)');
});

for (const [name, tamper] of [
  ['reward that allows farming', (r: any) => ({ ...r, reward: 999999 })],
  ['non-standard payout script', (r: any) => ({ ...r, merchants: r.merchants.map((m: any) => ({ ...m, lock: '6a' })) })],
  ['member price above price', (r: any) => ({ ...r, merchants: r.merchants.map((m: any) => ({ ...m, memberPrice: m.price + 1 })) })],
] as const) {
  test(`a tampered link is ignored: ${name}`, async ({ page }) => {
    await page.goto(`/?lang=en&r=${short(tamper(presence))}`);
    await expect(page.locator('.pill')).toHaveText('BCH mainnet'); // fell back to the official rally
    await expect(page.locator('.warn')).toHaveCount(0);
  });
}

test("the stall device signs a buyer code, and a key from the backup takes over", async ({ page }) => {
  await page.goto(`/?lang=en&r=${short(presence)}#/device/1`);
  await page.locator('details summary').click();
  await page.locator('details input.code').fill('11'.repeat(32));
  const buyer = page.getByPlaceholder("buyer's code");
  await buyer.fill('not a code');
  await expect(page.locator('.error').last()).toContainText("isn't a Jelajah buyer code");
  await buyer.fill(`${'ab'.repeat(20)}:${'cd'.repeat(32)}:1`);
  await expect(page.locator('code.wrap.small')).toHaveText(/^[0-9a-f]{128}$/);
  await expect(page.locator('img.qr')).toBeVisible();
});

test('a stall poster keeps the rally link in its QR target', async ({ page }) => {
  await page.goto(`/?lang=en&r=${short(presence)}#/stall/1`);
  await expect(page.locator('.poster .muted.small')).toContainText(`r=${short(presence)}#stall-1`);
});

test('the language switch flips the UI to Indonesian and back', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.locator('h1')).toContainText('Eat at 3 stalls');
  await page.getByRole('button', { name: 'ID' }).click();
  await expect(page.locator('h1')).toContainText('Jajan di 3 warung');
});

for (const net of ['mainnet', 'chipnet']) {
  test(`the SolidCash page lists every step of the recorded ${net} run`, async ({ page }) => {
    const run = JSON.parse(readFileSync(new URL(`../../solidcash/deployments/${net}.json`, import.meta.url), 'utf8'));
    await page.goto('/?lang=en#/solidcash');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('SolidCash');
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: net, exact: true }) });
    await expect(section.locator('ol li')).toHaveCount(Object.keys(run.txs).length);
    await expect(section.locator(`a[href$="${run.txs.redeem}"]`)).toBeVisible();
  });
}

test('Jelajah ID refuses to search an empty query and shows a Nostr key before any wallet', async ({ page }) => {
  await page.goto('/?lang=en#/identity');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bitcoin Cash and Nostr');
  await expect(page.getByRole('button', { name: 'Verify' })).toBeDisabled();
  await expect(page.locator('code').first()).toContainText('npub1');
});

test('a new gift link keeps its key in the #fragment, so a reload shows the same gift address', async ({ page }) => {
  await page.goto('/?lang=en#/gift');
  await expect(page).toHaveURL(/#\/gift\/[KL5][1-9A-HJ-NP-Za-km-z]{50,51}$/);
  const url = page.url();
  const address = await page.locator('details code.wrap').first().textContent();
  expect(address).toMatch(/^bitcoincash:q/);
  await page.reload();
  expect(page.url()).toBe(url);
  await expect(page.locator('details code.wrap').first()).toHaveText(address!);
});

test('a collector page rejects something that is neither an address nor a key', async ({ page }) => {
  await page.goto('/?lang=en#/u/bitcoincash:nonsense');
  await expect(page.locator('.error')).toContainText('Not a BCH address or npub');
});

test('the organizer form only takes an https .json metadata URL', async ({ page }) => {
  await page.goto('/?lang=en#/organize');
  const url = page.getByLabel(/Wallet metadata URL/);
  await url.fill('http://example.com/bcmr.json');
  await expect(page.locator('.error')).toContainText('https://');
  await url.fill('https://example.com/rally/bcmr.json');
  await expect(page.locator('.hint')).toContainText('Your wallet will lock about');
});

// ---- streak season (StampMinter4 + RewardVault3), the real chipnet streak rally
const streakRally = JSON.parse(readFileSync(new URL('../../scripts/rally.streak.chipnet.json', import.meta.url), 'utf8'));

test('a streak rally link shows the streak claim button with its reward', async ({ page }) => {
  await page.goto(`/?lang=en&r=${short(streakRally)}`);
  await expect(page.locator('.pill')).toHaveText('chipnet (test)');
  await expect(page.getByRole('button', { name: /3-day streak: 500 sats/ })).toBeVisible();
});

for (const [name, tamper] of [
  ['streak of one day', (r: any) => ({ ...r, streakDays: 1 })],
  ['streak without a reward', (r: any) => ({ ...r, streakReward: undefined })],
  ['streak rally without a levy', (r: any) => ({ ...r, levy: undefined })],
] as const) {
  test(`a tampered streak link is ignored: ${name}`, async ({ page }) => {
    await page.goto(`/?lang=en&r=${short(tamper(streakRally))}`);
    await expect(page.locator('.pill')).toHaveText('BCH mainnet');
  });
}

test('the official levy rally shows no streak button', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.getByRole('button', { name: /claim/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /streak/ })).toHaveCount(0);
});

test('organizer form refuses a streak reward its levies cannot cover', async ({ page }) => {
  await page.goto('/?lang=en#/organize');
  await page.getByLabel('Levy per stamp (sats, optional)').fill('3000');
  await page.getByLabel('🔥 Streak: days in a row (optional, needs a levy)').fill('3');
  await page.getByLabel('Streak reward (sats)').fill('9000');
  await expect(page.locator('.error')).toContainText('anti-collusion');
  await expect(page.locator('.error')).toContainText('streak');
  await page.getByLabel('Streak reward (sats)').fill('3000');
  await expect(page.locator('.error')).toHaveCount(0);
  await page.getByLabel('Levy per stamp (sats, optional)').fill('');
  await expect(page.locator('.error')).toContainText('needs a levy');
});

test('the rupiah rate survives a CoinGecko failure through its cache', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jelajah.idr', JSON.stringify({ idr: 5_000_000, at: Date.now() - 3_600_000 })));
  await page.route('**/api.coingecko.com/**', (r) => r.fulfill({ status: 429, body: '' }));
  await page.goto('/?lang=en');
  await expect(page.locator('body')).toContainText('≈ Rp');
});

test('every page renders without a script error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const hash of ['', '#/stats', '#/till/1', '#/story', '#/stall/1', '#/rallies', '#/organize', '#/gift', '#/device/1', '#/identity', '#/solidcash', '#/reclaim', '#/u/bitcoincash:qqd2thqn52yy8j85fdk782gffdns9yqelulnlj6s3q', '#/nope']) {
    await page.goto(`/?lang=en${hash}`);
    await page.reload(); // a hash-only goto keeps the document; the router reads the hash on load
    await expect(page.locator('h1').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('a streak link whose levies cannot cover the streak reward is ignored', async ({ page }) => {
  await page.goto(`/?lang=en&r=${short({ ...streakRally, streakReward: 999999 })}`);
  await expect(page.locator('.pill')).toHaveText('BCH mainnet');
});
