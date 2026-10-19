// Browser playtest of the main journeys. Usage: node scripts/dev/playtest.mjs <outDir>  (server on BASE)
import { chromium } from 'playwright';
const base = process.env.BASE ?? 'http://localhost:8791';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n, full = false) => page.screenshot({ path: `${out}/${n}.png`, fullPage: full });
const wait = (ms) => page.waitForTimeout(ms);
const log = (...a) => console.log('•', ...a);

await page.goto(base);
await wait(800);
await page.getByRole('button', { name: 'Start new game' }).first().click();
await wait(2500);
await shot('01-dashboard', true);

// Decisions page, every area
await page.getByRole('button', { name: 'Decisions', exact: true }).first().click();
await wait(1200);
for (const area of ['People & communication', 'Products & pricing', 'Production', 'Projects & issues', 'Money', 'Deals & contracts', 'Board']) {
  await page.getByRole('tab', { name: area }).click();
  await wait(400);
  await shot(`02-decisions-${area.split(' ')[0].toLowerCase()}`, true);
}

// Vela hybrid refresh via the board
await page.getByRole('tab', { name: 'Projects & issues' }).click();
await wait(300);
const vela = page.locator('.list-item', { hasText: 'Vela mild-hybrid refresh' });
await vela.getByRole('button', { name: 'Preview…' }).click();
await wait(1000);
await shot('03-vela-review', true);
log('vela review next step:', await page.locator('.callout.info').first().innerText());
await page.getByPlaceholder(/Why this is right for Asterion/).fill('Euro 7 becomes mandatory on 29 Nov 2027; the hybrid refresh certifies the Vela, cuts CO2 to 109 g/km and revives demand for 2–3 years. It replaces the plain compliance project.');
await page.getByRole('button', { name: 'Submit to the board' }).click();
await wait(1200);

// Hire 300 at Brno (within authority)
await page.getByRole('tab', { name: 'People & communication' }).click();
await wait(300);
const hireCard = page.locator('.decision', { hasText: 'Hire staff' });
await hireCard.locator('select').selectOption('DEP-BRNO');
await hireCard.getByPlaceholder('e.g. 300').fill('300');
await hireCard.getByRole('button', { name: 'Preview…' }).click();
await wait(900);
await shot('04-hire-review');
await page.getByRole('button', { name: 'Approve & execute' }).click();
await wait(1200);

// Draft two decisions and bundle them into a board plan
await page.getByRole('tab', { name: 'Projects & issues' }).click();
await wait(300);
await page.locator('.list-item', { hasText: 'Lyon automation & cost-down' }).getByRole('button', { name: 'Preview…' }).click();
await wait(900);
await page.getByRole('button', { name: 'Keep as draft' }).click();
await wait(500);
await page.getByRole('tab', { name: 'People & communication' }).click();
await wait(300);
await hireCard.locator('select').selectOption('DEP-BRNO');
await hireCard.getByPlaceholder('e.g. 300').fill('600');
await hireCard.getByRole('button', { name: 'Preview…' }).click();
await wait(900);
await page.getByRole('button', { name: 'Keep as draft' }).click();
await wait(500);
await page.getByRole('tab', { name: /Your drafts/ }).click();
await wait(600);
await shot('05-drafts');
for (const cb of await page.locator('.list-item input[type=checkbox]').all()) await cb.check();
await page.getByRole('button', { name: /Put the selected drafts to the board/ }).click();
await wait(600);
await page.getByPlaceholder('e.g. Turnaround plan 2027').fill('Brno crew and Lyon cost-down');
await page.getByPlaceholder(/What it achieves/).fill('Crew Brno for the Eon ramp-up and automate Lyon to cut fixed cost; both pay back within three years.');
await shot('06-plan-form', true);
await page.locator('.decision', { hasText: 'Put a plan to the board' }).getByRole('button', { name: 'Preview…' }).click();
await wait(1000);
await shot('07-plan-review', true);
await page.getByRole('button', { name: 'Put to the board' }).click();
await wait(1200);
await page.getByRole('tab', { name: /In progress/ }).click();
await wait(800);
await shot('08-in-progress', true);

// Meeting: share a document and talk
await page.goto(`${base}/#/company`);
await wait(1000);
await page.getByRole('row', { name: /Margarethe Holm/ }).getByRole('button', { name: 'Meet' }).click();
await wait(1200);
await page.locator('.card', { hasText: 'Share a document' }).getByRole('button', { name: 'Send' }).click();
await wait(1200);
await page.getByLabel('Your message').fill('I sent you the forecast. How much runway do we have, and should we refinance now?');
await page.getByRole('button', { name: 'Send', exact: true }).first().click();
await wait(2500);
await shot('09-meeting', true);

// Guide
await page.getByRole('button', { name: '? Guide' }).click();
await wait(500);
await shot('10-guide-coach');
await page.getByRole('tab', { name: /Ask/ }).click();
await wait(300);
await page.getByLabel('Your question').fill('How do I hire more people?');
await page.getByRole('button', { name: 'Ask', exact: true }).click();
await wait(1500);
await shot('11-guide-answer');
await page.getByLabel('Your question').fill('The board approved the Vela revamp but nothing happened');
await page.getByRole('button', { name: 'Ask' }).click();
await wait(1500);
await shot('12-guide-answer2');
await page.getByRole('button', { name: 'Close guide' }).click();

// Advance past the board meeting
await page.getByRole('button', { name: '+1 month' }).click();
await wait(7000);
await shot('13-briefing');
await page.getByRole('button', { name: 'Continue' }).click();
await wait(500);
await page.goto(`${base}/#/inbox/board`);
await wait(1200);
await shot('14-inbox-board', true);
await page.goto(`${base}/#/decisions/recent`);
await wait(1200);
await shot('15-recent', true);
await page.goto(`${base}/#/projects`);
await wait(1200);
await shot('16-projects', true);
await page.goto(`${base}/#/inbox`);
await wait(1200);
await shot('17-inbox', true);
console.log('errors', errors);
await browser.close();
