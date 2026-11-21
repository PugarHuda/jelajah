// End to end with a paired wallet: a buyer clicks Connect, "scans" the QR (the test wallet reads the wiz:// URI under it),
// buys at 3 stalls and claims the set. Every transaction is signed over WizardConnect and broadcast to chipnet.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { TestWallet } from './wizard-wallet';

const read = (f: string) => JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));
const demo = read('claims/.demo.chipnet.json');
// chipnet coins to top the wallet up from (the stalls pay the organizer, so most of it flows back)
const FUNDERS = [demo.demo1, demo.demo2, read('scripts/.buyer.chipnet.json').key, read('scripts/.organizer.chipnet.json').wif];

// click Connect, "scan" the QR (the wallet reads the wiz:// URI under it), wait until the page shows it is paired
async function pair(page: Page, w: TestWallet, connect: RegExp, paired: ReturnType<Page['locator']>) {
  await page.getByRole('button', { name: connect }).click();
  w.connect(await page.getByText(/^wiz:\/\//).innerText());
  await expect(paired).toBeVisible({ timeout: 90_000 });
}

// the app either logs the transaction or shows why it failed; fail with the app's own message
async function done(page: Page, logLine: string) {
  const alert = page.getByRole('alert');
  await expect(alert.or(page.locator('.log', { hasText: logLine }))).toBeVisible({ timeout: 120_000 });
  if (await alert.count()) throw new Error(`app error: ${await alert.innerText()}`);
}

// spends chipnet coins on every run: opt in with `npm run test:wallet`
test.skip(process.env.npm_lifecycle_event !== 'test:wallet' && !process.env.CHIPNET_E2E, 'npm run test:wallet (or CHIPNET_E2E=1) spends chipnet coins');

test('a buyer pairs a wallet, buys at 3 stalls and claims the set (chipnet, real transactions)', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const w = new TestWallet();
  await w.fundFrom(FUNDERS, 19_500n);
  await page.goto('/?net=chipnet&lang=en');
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
  await pair(page, w, /^Connect wallet$/, page.getByRole('button', { name: /Jelajah test wallet/ }));
  await expect(page.getByRole('button', { name: /Jelajah test wallet · [1-9]/ })).toBeVisible({ timeout: 60_000 }); // coins loaded
  // buy at stalls the wallet has no stamp from yet (a rerun keeps the stamps of an earlier run) until the set is complete
  while (!(await page.locator('.progress').innerText()).startsWith('3/3')) {
    const stall = page.locator('article.stall:not(.have)').first();
    const name = await stall.locator('h3').innerText();
    await stall.getByRole('button', { name: /^Buy/ }).click();
    await done(page, `Stamped at ${name}`);
    await expect(page.locator('article.stall', { hasText: name })).toHaveClass(/have/, { timeout: 60_000 });
  }
  const claim = page.getByRole('button', { name: /^Claim/ });
  await expect(claim).toBeEnabled({ timeout: 60_000 });
  await claim.click();
  await done(page, 'Set claimed');
  await expect(page.getByRole('heading', { name: 'Trophy shelf' })).toBeVisible({ timeout: 60_000 });
  w.close();
});

test('a friend funds a gift link, the receiver opens it, connects and takes it (chipnet)', async ({ page, browser }) => {
  test.setTimeout(5 * 60_000);
  const w = new TestWallet();
  await page.goto('/?net=chipnet&lang=en#/gift');
  await page.getByText('Make a gift').click();
  const addr = page.getByText(/^bchtest:q[a-z0-9]{41}$/).first();
  await expect(addr).toBeVisible();
  const giftAddress = await addr.innerText();
  const giftLink = page.url(); // the app has put the gift key in the #fragment by now
  await w.pay(giftAddress, 1000n); // the friend scans the gift QR with their wallet and sends 1,000 sats
  // the receiver opens the link on their own phone
  const receiver = await (await browser.newContext()).newPage();
  await receiver.goto(giftLink);
  await expect(receiver.getByRole('heading', { level: 1 })).toContainText('1,000 sats', { timeout: 60_000 });
  await pair(receiver, w, /Connect wallet to take it/, receiver.getByRole('button', { name: /^Take 1,000 sats/ }));
  await receiver.getByRole('button', { name: /^Take 1,000 sats/ }).click();
  await expect(receiver.getByText('In your wallet')).toBeVisible({ timeout: 60_000 });
  await expect(receiver.getByRole('alert')).toHaveCount(0);
  w.close();
});

test('a collector links their BCH address to a Nostr key and anyone can verify it (chipnet)', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const w = new TestWallet();
  await page.goto('/?net=chipnet&lang=en#/identity');
  const link = page.getByRole('button', { name: 'Link my BCH address and Nostr key' });
  await pair(page, w, /^Connect wallet$/, link);
  await link.click();
  await expect(page.getByText(/Linked: .*published to [1-9] relays/)).toBeVisible({ timeout: 120_000 });
  expect(w.signed.at(-1)).toContain('Jelajah ID');
  // a stranger checks it: type the address, click Verify
  await page.getByPlaceholder('npub1… / bitcoincash:q…').fill(w.address());
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: '✅ Verified' })).toBeVisible({ timeout: 90_000 });
  w.close();
});
