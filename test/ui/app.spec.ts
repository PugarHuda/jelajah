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
