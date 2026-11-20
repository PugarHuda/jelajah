import { defineConfig } from '@playwright/test';

// UI tests run against the production build. They avoid the BCH network: rule checks, links, the stall device's
// signature, posters and the language switch are all decided in the browser.
export default defineConfig({
  testDir: 'test/ui',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:4173/' },
  webServer: { command: 'npm run build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173/', reuseExistingServer: true, timeout: 120_000 },
});
