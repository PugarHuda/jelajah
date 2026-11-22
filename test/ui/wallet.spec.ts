// End to end with a paired wallet: a buyer clicks Connect, "scans" the QR (the test wallet reads the wiz:// URI under it),
// buys at 3 stalls and claims the set. Every transaction is signed over WizardConnect and broadcast to chipnet.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TestWallet, provider } from './wizard-wallet';
import { SignatureTemplate, TransactionBuilder } from 'cashscript';
import { decodePrivateKeyWif, encodeLockingBytecodeP2pkh, hash160, lockingBytecodeToCashAddress, secp256k1 } from '@bitauth/libauth';

// full Chromium in new headless mode: the old headless shell always denies notifications
test.use({ channel: 'chromium' });

const RECLAIM_FILE = new URL('./.reclaim.chipnet.json', import.meta.url); // gitignored
const read = (f: string) => JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));
const demo = read('claims/.demo.chipnet.json');
// chipnet coins to top the wallet up from (the stalls pay the organizer, so most of it flows back)
const FUNDERS = [demo.demo1, demo.demo2, read('scripts/.buyer.chipnet.json').key, read('scripts/.organizer.chipnet.json').wif];

// click Connect, "scan" the QR (the wallet reads the wiz:// URI under it), wait until the page shows it is paired
async function pair(page: Page, w: TestWallet, connect: RegExp, paired: ReturnType<Page['locator']>) {
  const button = page.getByRole('button', { name: connect });
  // an app page that kept its WizardConnect session (opened from another page) reconnects by itself: give it a moment
  // (the Connect button can flash before the restored session takes over)
  if (await paired.waitFor({ timeout: 20_000 }).then(() => true, () => false)) return;
  for (let attempt = 1; ; attempt++) { // public relays drop a socket now and then: like a person, scan again once
    await button.click();
    w.connect(await page.getByText(/^wiz:\/\//).innerText());
    try { await expect(paired).toBeVisible({ timeout: 60_000 }); return; } catch (e) {
      if (attempt === 2) throw e;
      w.close();
      await page.reload();
    }
  }
}

// the app either logs the transaction or shows why it failed; fail with the app's own message
async function done(page: Page, success: string | ReturnType<Page['locator']>) {
  const alert = page.getByRole('alert');
  await expect(alert.or(typeof success === 'string' ? page.locator('.log', { hasText: success }) : success)).toBeVisible({ timeout: 120_000 });
  if (await alert.count()) throw new Error(`app error: ${await alert.innerText()}`);
}

// spends chipnet coins on every run: opt in with `npm run test:wallet`
test.skip(process.env.npm_lifecycle_event !== 'test:wallet' && !process.env.CHIPNET_E2E, 'npm run test:wallet (or CHIPNET_E2E=1) spends chipnet coins');

test('a buyer pairs a wallet, buys at 3 stalls and claims the set (chipnet, real transactions)', async ({ page, browser }) => {
  test.setTimeout(10 * 60_000);
  const w = new TestWallet();
  await w.fundFrom(FUNDERS, 19_500n);
  await page.goto('/?net=chipnet&lang=en');
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
  await pair(page, w, /^Connect wallet$/, page.getByRole('button', { name: /Jelajah test wallet/ }));
  await expect(page.getByRole('button', { name: /Jelajah test wallet · [1-9]/ })).toBeVisible({ timeout: 60_000 }); // coins loaded
  // the Kopi Joss stall's phone: till open in the background with notifications allowed; every system notification is recorded
  const tillCtx = await browser.newContext({ permissions: ['notifications'] });
  await tillCtx.addInitScript(() => {
    Object.defineProperty(document, 'hidden', { get: () => true });
    (window as unknown as { notes: string[] }).notes = [];
    const show = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts) { (window as unknown as { notes: string[] }).notes.push(title); return show.call(this, title, opts); };
  });
  const till = await tillCtx.newPage();
  await till.goto('/?net=chipnet&lang=en#/till/1');
  await till.getByRole('button', { name: '🔔 Turn on the sale bell' }).click();
  await expect(till.getByText(/With the till in the background/)).toBeVisible();
  const boughtKopi = !(await page.locator('article.stall', { hasText: 'Kopi Joss' }).getAttribute('class'))!.includes('have');
  // the buyer changes their mind once: Reject in the wallet -> a plain message, nothing sent, the stall can be bought again
  w.rejectNext = true;
  await page.locator('article.stall:not(.have)').first().getByRole('button', { name: /^Buy/ }).click();
  await expect(page.getByRole('alert')).toContainText('You declined in the wallet. Nothing was sent.', { timeout: 120_000 });
  // buy at stalls the wallet has no stamp from yet (a rerun keeps the stamps of an earlier run) until the set is complete
  while (!(await page.locator('.progress').innerText()).startsWith('3/3')) {
    const stall = page.locator('article.stall:not(.have)').first();
    const name = await stall.locator('h3').innerText();
    await stall.getByRole('button', { name: /^Buy/ }).click();
    await done(page, `Stamped at ${name}`);
    await expect(page.locator('article.stall', { hasText: name })).toHaveClass(/have/, { timeout: 60_000 });
    if (!(await page.locator('.progress').innerText()).startsWith('3/3')) {
      await expect(page.getByText(/more stalls? to go\. Next stop:/)).toBeVisible();
      const route = await page.getByRole('link', { name: /walk them all/ }).getAttribute('href');
      expect(route).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&travelmode=walking&destination=/);
    }
  }
  if (boughtKopi) await expect.poll(() => till.evaluate(() => (window as unknown as { notes: string[] }).notes.join(' | ')), { timeout: 60_000 }).toContain('Kopi Joss: +');
  await tillCtx.close();
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
  // the proof spends a plain coin from receive/0 (the app says so if there is none): make sure there is one, as a user would
  if (!(await provider.getUtxos(w.address('receive', 0))).some((u) => !u.token)) await w.pay(w.address('receive', 0), 2000n);
  await page.goto('/?net=chipnet&lang=en#/identity');
  const link = page.getByRole('button', { name: 'Link my BCH address and Nostr key' });
  await pair(page, w, /^Connect wallet$/, link);
  await link.click();
  await done(page, page.getByText(/Linked: .*published to [1-9] relays/));
  expect(w.signed.at(-1)).toContain('Jelajah ID');
  // a stranger checks it: type the address, click Verify
  await page.getByPlaceholder('npub1… / bitcoincash:q…').fill(w.address());
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: '✅ Verified' })).toBeVisible({ timeout: 90_000 });
  w.close();
});

test('a stall device makes its key, an organizer opens a rally with it, a buyer buys with the device code (chipnet)', async ({ page, browser }) => {
  test.setTimeout(10 * 60_000);
  const w = new TestWallet();
  // 1. the stall's phone: open #/device, read the presence key it made
  const device = await (await browser.newContext()).newPage();
  await device.goto('/?net=chipnet&lang=en#/device');
  const presenceKey = await device.getByText(/^0[23][0-9a-f]{64}$/).innerText();
  // 2. the organizer: one stall with that key, a set of 1, a levy that pays the reward
  await page.goto('/?net=chipnet&lang=en#/organize');
  await page.getByRole('button', { name: '− Remove the last' }).click();
  await page.getByRole('button', { name: '− Remove the last' }).click();
  await page.getByPlaceholder('Jelajah Malioboro').fill('QA rally');
  await page.getByLabel('Stamps for a set').fill('1');
  await page.getByLabel('Reward per set (sats)').fill('600');
  await page.getByLabel('Rewards to fund now').fill('1');
  await page.getByLabel('Days open').fill('1');
  await page.getByLabel('Levy per stamp (sats, optional)').fill('2600');
  await page.getByLabel('Name', { exact: true }).fill('QA Warung');
  await page.getByLabel('Price', { exact: true }).fill('700');
  await page.getByLabel('Member price').fill('700');
  await page.getByLabel(/Proof of presence/).fill(presenceKey);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const openBtn = page.getByRole('button', { name: 'Open the rally' });
  await pair(page, w, /^Connect wallet$/, openBtn);
  await openBtn.click();
  await expect(page.getByRole('heading', { name: /Your rally is live/ })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('Back up your reclaim key.')).toBeVisible();
  await page.getByRole('button', { name: /List it on Nostr/ }).click();
  await expect(page.getByText(/Listed on [1-9] relays/)).toBeVisible({ timeout: 60_000 });
  const link = await page.locator('.claim a').first().getAttribute('href') as string;
  // keep the reclaim key: the reclaim test below takes the pool back once this 1-day rally has ended
  const reclaimWif = await page.locator('.warn code').innerText();
  writeFileSync(RECLAIM_FILE, JSON.stringify({ link, reclaimWif, opensAt: Math.floor(Date.now() / 1000) + 86_400 + 3_600 + 600 }));
  w.close();
  // 3. the buyer opens the shared link, connects, taps Buy: the stall asks for proof of presence
  const buyer = await (await browser.newContext()).newPage();
  await buyer.goto(link);
  await expect(buyer.getByRole('heading', { name: 'QA Warung' })).toBeVisible({ timeout: 60_000 });
  const w2 = new TestWallet();
  await pair(buyer, w2, /^Connect wallet$/, buyer.getByRole('button', { name: /Jelajah test wallet · [1-9]/ }));
  await buyer.locator('article.stall', { hasText: 'QA Warung' }).getByRole('button', { name: /^Buy/ }).click();
  const panel = buyer.getByRole('dialog', { name: 'Proof of presence' });
  const buyerCode = await panel.locator('code').innerText();
  // 4. the stall device reads the buyer's code and shows its signed reply
  await device.goto(`${link}#/device/1`);
  await device.reload();
  await device.getByPlaceholder("buyer's code").fill(buyerCode);
  const reply = await device.locator('code.small').last().innerText();
  // 5. the buyer types the reply and buys
  await panel.getByPlaceholder("stall's code").fill(reply);
  await panel.getByRole('button', { name: 'Buy with the stall’s code' }).click();
  await done(buyer, 'Stamped at QA Warung');
  await expect(buyer.getByRole('button', { name: /^Claim/ })).toBeEnabled({ timeout: 60_000 });
  await buyer.getByRole('button', { name: /^Claim/ }).click();
  await done(buyer, 'Set claimed');
  w2.close();
});

test('a sponsor turns a voucher into a link, a buyer takes it and pays less for a stamp (chipnet)', async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  const w = new TestWallet();
  await giveVoucher(read('scripts/.organizer.chipnet.json').wif, w.address('receive', 0, true)); // the sponsor's wallet gets its vouchers
  // the sponsor: #/sponsor, connect, one link
  await page.goto('/?net=chipnet&lang=en#/sponsor');
  await pair(page, w, /Connect the sponsor wallet/, page.getByText(/Your wallet holds [1-9]\d* voucher/));
  await page.getByLabel('Links to make (1–20)').fill('1');
  await page.getByRole('button', { name: 'Make 1 voucher link' }).click();
  await expect(page.getByRole('heading', { name: /1 voucher link/ })).toBeVisible({ timeout: 120_000 });
  const link = (await page.getByRole('textbox', { name: 'Voucher links' }).inputValue()).trim();
  writeFileSync(new URL('./.voucher-links.chipnet.txt', import.meta.url), `${link}\n`, { flag: 'a' }); // gitignored: a voucher is never lost to a failed run
  w.close();
  // the buyer: opens the link, takes the voucher, buys a stamp with it
  // the buyer's phone, recorded: the clip for the sponsor story (test-results/sponsor-clip/*.webm)
  const buyerCtx = await browser.newContext({ viewport: { width: 390, height: 780 }, recordVideo: { dir: 'test-results/sponsor-clip', size: { width: 390, height: 780 } } });
  const buyer = await buyerCtx.newPage();
  buyer.on('pageerror', (e) => console.log('[buyer pageerror]', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')));
  buyer.on('console', (m) => { if (m.type() === 'error') console.log('[buyer console]', m.text()); });
  await buyer.goto(link);
  await expect(buyer.getByRole('heading', { level: 1 })).toContainText('1 voucher', { timeout: 60_000 });
  const w2 = new TestWallet();
  await pair(buyer, w2, /Connect wallet to take it/, buyer.getByRole('button', { name: /^Take/ }));
  await buyer.getByRole('button', { name: /^Take/ }).click();
  await expect(buyer.getByText('In your wallet')).toBeVisible({ timeout: 60_000 });
  await buyer.getByRole('link', { name: /Now buy your first stamp/ }).click();  await pair(buyer, w2, /^Connect wallet$/, buyer.getByText('You hold a voucher.'));
  const buy = buyer.locator('article.stall', { hasText: 'Es Dawet' }).getByRole('button', { name: /🎟/ });
  await expect(buy).toBeVisible({ timeout: 60_000 }); // the price on the button already has the voucher taken off
  await buy.click();
  await done(buyer, 'Stamped at Es Dawet');
  await buyer.waitForTimeout(2500); // let the stamp land on camera
  await buyerCtx.close(); // writes the video
  w2.close();
});

// the sponsor (the chipnet organizer key) sends one voucher token to the buyer, like an airdrop after a sign-up
async function giveVoucher(wif: string, to: string) {
  const { sponsor } = JSON.parse(readFileSync(new URL('../../src/rally.chipnet.json', import.meta.url), 'utf8'));
  if ((await provider.getUtxos(to)).some((u) => u.token?.category === sponsor.category)) return; // already holds one (an earlier run)
  const priv = (decodePrivateKeyWif(wif) as { privateKey: Uint8Array }).privateKey;
  const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(priv) as Uint8Array));
  const from = (lockingBytecodeToCashAddress({ bytecode: lock, prefix: 'bchtest', tokenSupport: true }) as { address: string }).address;
  const utxos = await provider.getUtxos(from);
  const v = utxos.find((u) => u.token?.category === sponsor.category && !u.token.nft);
  if (!v) throw new Error('the sponsor has no vouchers left');
  const fund = utxos.filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  const sig = new SignatureTemplate(priv);
  const b = new TransactionBuilder({ provider }).addInput(v, sig.unlockP2PKH()).addInput(fund, sig.unlockP2PKH())
    .addOutput({ to, amount: 1000n, token: { category: sponsor.category, amount: 1n } });
  if (v.token!.amount > 1n) b.addOutput({ to: from, amount: 1000n, token: { category: sponsor.category, amount: v.token!.amount - 1n } });
  const rest = v.satoshis + fund.satoshis - 1000n - (v.token!.amount > 1n ? 1000n : 0n) - 600n;
  if (rest >= 546n) b.addOutput({ to: from, amount: rest });
  await b.send();
}

test('after the QA rally ends, its organizer takes the leftover pool back (chipnet)', async ({ page }) => {
  const saved = existsSync(RECLAIM_FILE) ? JSON.parse(readFileSync(RECLAIM_FILE, 'utf8')) : null;
  test.skip(!saved || Date.now() / 1000 < saved.opensAt, 'runs once the QA rally from the organizer test has ended (1 day)');
  await page.goto(`${saved.link}#/reclaim`);
  await page.getByPlaceholder('K… / L… / c…').fill(saved.reclaimWif);
  await page.getByPlaceholder('bchtest:z…').fill(new TestWallet().address('change', 0, true));
  await page.getByRole('button', { name: 'Reclaim the pool' }).click();
  await expect(page.getByText(/Reclaimed: /)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
