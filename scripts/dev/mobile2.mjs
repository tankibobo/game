// Phone-width and dark-mode check of every page (incl. Decisions, meeting, guide). Usage: node scripts/dev/mobile2.mjs <outDir>
import { chromium } from 'playwright';
const base = process.env.BASE ?? 'http://localhost:8791';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const errors = [];
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  for (const p of ['dashboard', 'decisions', 'decisions/projects', 'decisions/board', 'decisions/progress', 'inbox', 'inbox/board', 'company', 'products', 'projects', 'operations', 'finance', 'world', 'history', 'saves']) {
    await page.goto(`${base}/#/${p}`);
    await page.waitForTimeout(1100);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(scheme, p, 'overflow', over);
    if (scheme === 'dark' || ['decisions', 'decisions/projects', 'decisions/board'].includes(p)) await page.screenshot({ path: `${out}/${scheme}-${p.replace('/', '-')}.png`, fullPage: true });
  }
  await page.goto(`${base}/#/dashboard`);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: '? Coach' }).click();
  await page.waitForTimeout(800);
  console.log(scheme, 'coach overflow', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
  await page.screenshot({ path: `${out}/${scheme}-coach.png` });
    await page.getByLabel('Your question').fill('How do I sign an agreement?');
  await page.locator('.guide-input').getByRole('button', { name: 'Ask' }).click();
  await page.waitForTimeout(1200);
  console.log(scheme, 'guide overflow', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
  await page.screenshot({ path: `${out}/${scheme}-guide.png` });
  await ctx.close();
}
console.log('errors', errors);
await browser.close();
