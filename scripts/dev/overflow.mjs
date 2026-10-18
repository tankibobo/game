import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
for (const p of ['dashboard', 'projects', 'finance', 'inbox', 'company', 'operations']) {
  await page.goto(`http://localhost:8791/#/${p}`);
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.right > window.innerWidth + 1 && !el.closest('.table-wrap, .card-body, .sidebar, .tabs')) out.push(`${el.tagName}.${el.className}`.slice(0, 60) + ' ' + Math.round(b.right));
    }
    return [document.documentElement.scrollWidth - window.innerWidth, out.slice(0, 5)];
  });
  console.log(p, JSON.stringify(r));
}
await browser.close();
