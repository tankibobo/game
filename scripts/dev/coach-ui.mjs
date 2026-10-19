// Browser check of scenario selection, the Coach and the mandate. Usage: node scripts/dev/coach-ui.mjs <outDir> (server on BASE)
import { chromium } from 'playwright';
const base = process.env.BASE ?? 'http://localhost:8791';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const errors = [];
const run = async (viewport, tag) => {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => m.type() === 'error' && errors.push(`${tag}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
  const shot = (n, full = false) => page.screenshot({ path: `${out}/${tag}-${n}.png`, fullPage: full });
  const wait = (ms) => page.waitForTimeout(ms);
  await page.goto(base);
  await wait(1000);
  await shot('01-setup', true);
  if (tag === 'desktop') {
    await page.getByRole('radio', { name: /Cash Crunch/ }).click();
    await page.getByRole('radio', { name: /Relaxed/ }).click();
    await page.getByText(/Read the full briefing/).click();
    await wait(300);
    await shot('02-picker', true);
    await page.getByRole('button', { name: 'Random seed' }).click();
    const seed = await page.getByLabel('Random seed').inputValue();
    console.log('• random seed', seed);
    await page.getByRole('button', { name: 'Start new game' }).click();
    await wait(2500);
    const st = await (await page.request.get(`${base}/api/status`)).json();
    console.log('• started', st.game.scenario_key, st.game.difficulty, st.game.seed, String(st.game.seed) === seed);
  } else {
    await page.goto(`${base}/#/dashboard`);
    await wait(1500);
  }
  await shot('03-dashboard', true);
  const mandate = page.locator('.card', { hasText: 'Your mandate' });
  console.log(`• ${tag} mandate card:`, (await mandate.innerText()).split('\n').slice(0, 6).join(' | '));
  await mandate.getByRole('button', { name: 'Coach' }).click();
  await wait(1200);
  await shot('04-coach');
  console.log(`• ${tag} coach headline:`, await page.locator('.coach .callout').first().innerText());
  const first = page.locator('.coach-card').first();
  console.log(`• ${tag} first advice:`, (await first.innerText()).split('\n').slice(0, 3).join(' | '));
  await page.locator('.coach-card').first().getByRole('button', { name: 'Show me how' }).click().catch(() => {});
  await wait(300);
  const preview = page.locator('.coach-card .btn.primary').first();
  if (await preview.count()) {
    await preview.click();
    await wait(1200);
    await shot('05-preview');
    const dlg = page.locator('[role=dialog]').last();
    console.log(`• ${tag} preview dialog:`, (await dlg.innerText()).split('\n').slice(0, 4).join(' | '));
    await page.keyboard.press('Escape');
    await wait(400);
  }
  // Ask tab: advice question
  await page.getByRole('button', { name: '? Coach' }).click().catch(() => {});
  await wait(500);
    await wait(300);
  await page.getByLabel('Your question').fill('What should I do? The board keeps firing me');
  await page.locator('.guide-input').getByRole('button', { name: 'Ask' }).click();
  await wait(1500);
  await shot('06-ask');
  console.log(`• ${tag} ask answer:`, (await page.locator('.guide-a').last().innerText()).slice(0, 300).replace(/\n/g, ' | '));
  console.log(`• ${tag} preview buttons in answer:`, await page.locator('.guide-a .btn.primary').count());
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`• ${tag} horizontal overflow px:`, overflow);
  await page.close();
};
await run({ width: 1440, height: 900 }, 'desktop');
await run({ width: 390, height: 844 }, 'mobile');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
