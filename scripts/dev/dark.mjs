import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await page.goto('http://localhost:8791/#/dashboard');
await page.waitForTimeout(1500);
await page.screenshot({ path: process.argv[2] });
await browser.close();
