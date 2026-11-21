// Record the live app (headless Chromium) into short clips for the video: public/clips/<name>.webm
//   node capture.mjs [name ...]   (no names: all clips)
import { createRequire } from 'node:module';
import { mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('../node_modules/playwright');

const SITE = 'https://jelajah-bch.vercel.app/';
const OUT = fileURLToPath(new URL('./public/clips/', import.meta.url));
const TMP = fileURLToPath(new URL('./.capture-tmp/', import.meta.url));
const W = 1440, H = 900;
const pause = (page, ms) => page.waitForTimeout(ms);
// smooth scroll by `px` over `ms`
const glide = (page, px, ms = 1600) => page.evaluate(([px, ms]) => new Promise((done) => {
  const y0 = scrollY, t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); scrollTo(0, y0 + px * (0.5 - Math.cos(Math.PI * k) / 2)); k < 1 ? requestAnimationFrame(step) : done(); };
  requestAnimationFrame(step);
}), [px, ms]);

const clips = {
  // the rally page: hero, the four stalls, the claim box
  async home(page) {
    await page.goto(SITE + '?lang=en', { waitUntil: 'networkidle' });
    await pause(page, 2500);
    await glide(page, 560, 2200); await pause(page, 1800);
    for (const id of [1, 2, 3, 4]) { await page.hover(`#stall-${id}`); await pause(page, 450); }
    await glide(page, 520, 1800); await pause(page, 2200);
  },
  // the six-panel story
  async story(page) {
    await page.goto(SITE + '?lang=en#/story', { waitUntil: 'networkidle' });
    await pause(page, 2000);
    for (let i = 0; i < 4; i++) { await glide(page, 420, 1700); await pause(page, 1500); }
  },
  // the stall's till
  async till(page) {
    await page.goto(SITE + '?lang=en#/till/1', { waitUntil: 'networkidle' });
    await pause(page, 4500);
  },
  // the till while a real stamp is bought (run scripts/buy-one.mjs during this): waits for the bell, up to 3 min
  async tillLive(page) {
    await page.goto(SITE + '?lang=en#/till/1', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /sale bell/i }).click().catch(() => {});
    await page.getByText(/since this screen opened/).waitFor({ timeout: 180000 });
    await pause(page, 4000);
  },
  // stall dashboard and all seasons, recomputed from the chain
  async stats(page) {
    await page.goto(SITE + '?lang=en#/stats', { waitUntil: 'networkidle' });
    await page.getByText('Total').waitFor({ timeout: 30000 }).catch(() => {});
    await pause(page, 1500);
    await glide(page, 450, 1500);
    await page.getByRole('button', { name: /all-season/i }).click().catch(() => {});
    await page.getByText(/Seasons/).first().waitFor({ timeout: 45000 }).catch(() => {});
    await glide(page, 500, 1500); await pause(page, 2500);
  },
  // an organizer opens a levy rally: the contract rules are checked before any wallet prompt
  async organize(page) {
    await page.goto(SITE + '?lang=en#/organize', { waitUntil: 'networkidle' });
    await pause(page, 1200);
    await page.getByLabel('Rally name').pressSequentially('Jelajah Malioboro', { delay: 70 });
    await page.getByLabel('Reward per set (sats)').fill('');
    await page.getByLabel('Reward per set (sats)').pressSequentially('3000', { delay: 120 });
    await page.getByLabel('Levy per stamp (sats, optional)').pressSequentially('2500', { delay: 120 });
    await pause(page, 600);
    await page.locator('.hint, .error').first().scrollIntoViewIfNeeded();
    await glide(page, -120, 600); await pause(page, 3000);
  },
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(clips)) {
  rmSync(TMP, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: TMP, size: { width: W, height: H } }, colorScheme: 'light' });
  const page = await ctx.newPage();
  try { await clips[name](page); } catch (e) { console.log(name, 'failed:', e.message.split('\n')[0]); }
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  const dest = OUT + `${name}.webm`;
  if (existsSync(dest)) rmSync(dest);
  renameSync(path, dest);
  console.log('clip', name);
}
await browser.close();
rmSync(TMP, { recursive: true, force: true });
