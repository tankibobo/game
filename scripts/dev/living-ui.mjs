// Browser playtest of the living-company features. Usage: node scripts/dev/living-ui.mjs <outDir>  (server on BASE)
import { chromium } from 'playwright';
const base = process.env.BASE ?? 'http://localhost:8791';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n, full = true) => page.screenshot({ path: `${out}/${n}.png`, fullPage: full });
const wait = (ms) => page.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);
const nav = async (label) => {
  await page.locator('nav.sidebar .nav-item', { has: page.getByText(label, { exact: true }) }).click();
  await wait(900);
};
const approve = async () => {
  const b = page.getByRole('button', { name: /Approve & execute|Submit to the board/ });
  await b.first().click();
  await wait(1000);
  const close = page.getByRole('button', { name: /Close|Continue/ });
  if (await close.count()) await close.first().click().catch(() => {});
  await wait(300);
};

await page.goto(base);
await wait(800);
await page.getByRole('button', { name: 'Start new game' }).first().click();
await wait(2500);

// Every page.
for (const [label, name] of [['Executive dashboard', 'dashboard'], ['Decisions', 'decisions'], ['Inbox & meetings', 'inbox'], ['People & divisions', 'company'], ['Products & marketing', 'products'], ['Projects', 'projects'], ['Operations', 'operations'], ['Finance', 'finance'], ['News', 'news'], ['Markets & world', 'world'], ['History', 'history']]) {
  await nav(label);
  await shot(`p-${name}`);
}

// Divisions.
await nav('People & divisions');
await page.getByRole('tab', { name: 'Divisions & workforce' }).click();
await wait(2000);
await shot('divisions');
log('division cards:', await page.locator('[id^="dept-"]').count());

// Quick question to the CFO.
await page.getByRole('button', { name: 'Ask someone' }).click();
await wait(500);
await page.getByLabel('Who to ask').selectOption('CHR-HOLM');
await page.getByLabel('Your question').fill('Why are we losing money? Send me the P&L.');
await page.getByRole('button', { name: 'Ask', exact: true }).click();
await wait(2500);
await shot('ask-holm', false);
log('ask attachments:', await page.locator('.ask .attachment').count());
await page.getByRole('button', { name: 'Close' }).first().click();
await wait(300);

// The Coach.
await page.getByRole('button', { name: '? Coach' }).click();
await wait(1500);
await shot('coach-open', false);
await page.locator('.guide-input input').fill('Why am I losing money?');
await page.locator('.guide-input').getByRole('button', { name: 'Ask' }).click();
await wait(1500);
await shot('coach-answer', false);
log('coach answer:', (await page.locator('.guide-a').last().innerText()).slice(0, 300).replace(/\n/g, ' | '));
await page.getByRole('button', { name: 'Close coach' }).click();

// Campaign.
await nav('Decisions');
await page.getByRole('tab', { name: 'Products & pricing' }).click();
await wait(400);
const camp = page.locator('.decision', { hasText: 'Launch a marketing campaign' });
await camp.getByPlaceholder('e.g. 8').fill('6');
await camp.getByRole('button', { name: 'Preview…' }).click();
await wait(1000);
await shot('campaign-review', false);
await approve();

// Own project.
await page.getByRole('tab', { name: 'Projects & issues' }).click();
await wait(500);
await shot('decisions-projects');
const own = page.locator('.decision', { hasText: 'Design your own project' });
await own.locator('select').first().selectOption('plant_efficiency');
await wait(200);
await own.getByRole('button', { name: 'Preview…' }).click();
await wait(1000);
await shot('own-project-review', false);
await approve();

// Fleet deal.
await page.getByRole('tab', { name: 'Deals & contracts' }).click();
await wait(500);
await shot('decisions-deals');
const fleet = page.locator('.list-item', { hasText: /Kora fleet/i }).first();
if (await fleet.count()) {
  await fleet.getByRole('button', { name: /Open talks/ }).click();
  await wait(900);
  await approve();
}

// Share a document with several reports.
await nav('People & divisions');
await page.getByRole('tab', { name: 'Share a document' }).click();
await wait(600);
await shot('share-form');

// Advance three months and read the paper and inbox.
for (let i = 0; i < 3; i++) {
  await page.getByRole('button', { name: '+1 month' }).click();
  await wait(4500);
  const cont = page.getByRole('button', { name: 'Continue' });
  if (await cont.count()) await cont.first().click();
  await wait(400);
}
await nav('Inbox & meetings');
await shot('inbox-after');
await nav('News');
await shot('news-after');
await nav('Products & marketing');
await shot('products-after');
await nav('Finance');
await shot('finance-after');
await nav('Decisions');
await page.getByRole('tab', { name: /Your drafts/ }).click();
await wait(500);
await shot('drafts-after');
log('drafts by initiative:', await page.getByText(/Prepared on their own initiative/).count());

// Mobile: no horizontal scroll on any page.
const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
m.on('pageerror', (e) => errors.push(String(e)));
await m.goto(base);
await m.waitForTimeout(1500);
for (const p of ['dashboard', 'decisions', 'inbox', 'news', 'company', 'products', 'projects', 'operations', 'finance', 'world']) {
  await m.goto(`${base}/#/${p}`);
  await m.waitForTimeout(1200);
  const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 2) log(`mobile overflow on ${p}: ${over}px`);
  await m.screenshot({ path: `${out}/m-${p}.png`, fullPage: false });
}
log('errors:', errors.length ? errors : 'none');
await browser.close();
