// Visual QA: signs in, loads sample data and screenshots each screen at desktop + phone widths.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.env.BASE ?? 'http://localhost:8092';
const out = process.env.OUT ?? 'screenshots';
fs.mkdirSync(out, { recursive: true });
const pages = (process.env.PAGES ?? '/,/orders,/import,/cutting,/packing,/fulfilment,/exceptions,/customers,/products,/intelligence,/reports,/settings,/orders/new,/order').split(',');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
for (const [label, vp, mobile] of [['desktop', { width: 1440, height: 1000 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, colorScheme: process.env.SCHEME ?? 'light', deviceScaleFactor: mobile ? 2 : 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label} ${p.url()}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${label} ${p.url()} console: ${m.text()}`));
  await p.goto(base + '/');
  await p.fill('#email', 'dylan@terram.test');
  await p.fill('#password', 'butchery123');
  await p.click('button[type=submit]');
  await p.waitForTimeout(1200);
  for (const path of pages) {
    await p.goto(base + path);
    await p.waitForTimeout(900);
    const name = `${label}${path.replace(/[/?=&]/g, '_') || '_home'}.png`;
    await p.screenshot({ path: `${out}/${name}`, fullPage: true });
  }
  if (process.env.EXTRA) await (await import(process.env.EXTRA)).default(p, label, out);
  await ctx.close();
}
await b.close();
console.log(errors.length ? errors.join('\n') : 'no page errors');
