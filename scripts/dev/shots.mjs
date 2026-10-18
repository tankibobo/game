import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:8790';
const out = process.argv[3];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/00-setup.png` });
if (await page.getByText('Start new game').count()) {
  await page.getByText('Start new game').first().click();
  await page.waitForTimeout(2500);
}
for (const p of ['dashboard', 'inbox', 'company', 'products', 'projects', 'operations', 'finance', 'world', 'history', 'saves']) {
  await page.goto(`${base}/#/${p}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${p}.png`, fullPage: true });
}
console.log('errors', errors);
await browser.close();
