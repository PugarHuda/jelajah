import { defineConfig, devices } from '@playwright/test';

// UI tests run against the production build. `npm run test:ui` = Chromium; `npm run test:browsers` adds an iPhone
// (WebKit, Safari's engine) and Firefox for the same pages. The wallet end-to-end suite runs in Chromium only.
// BASE_URL=https://jelajah-bch.vercel.app/ runs them against the live site instead.
const live = process.env.BASE_URL;
export default defineConfig({
  testDir: 'test/ui',
  timeout: 30_000,
  use: { baseURL: live ?? 'http://localhost:4173/' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', use: { ...devices['iPhone 14'] }, testIgnore: /wallet\.spec/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /wallet\.spec/ },
  ],
  webServer: live ? undefined : { command: 'npm run build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173/', reuseExistingServer: true, timeout: 120_000 },
});
