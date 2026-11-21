// node docs/stall-guide.cjs -> public/stall-guide.pdf (headless Chromium, one A4 page)
const { chromium } = require('playwright');
const path = require('node:path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + path.resolve(__dirname, 'stall-guide.html'));
  await p.pdf({ path: path.resolve(__dirname, '../public/stall-guide.pdf'), format: 'A4', printBackground: true });
  await b.close();
})();
