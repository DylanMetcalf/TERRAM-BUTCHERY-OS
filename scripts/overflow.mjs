import { chromium } from 'playwright-core';
const base = 'http://localhost:8092';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
await p.goto(base + '/login'); await p.fill('#email', 'dylan@terram.test'); await p.fill('#password', 'butchery123'); await p.click('button[type=submit]'); await p.waitForTimeout(1000);
for (const path of (process.argv[2] ?? '/').split(',')) {
  await p.goto(base + path); await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.right > 391 && b.width > 0 && !el.closest('header')) out.push(`${el.tagName}.${(el.className?.toString?.() ?? '').slice(0, 70)} right=${Math.round(b.right)} w=${Math.round(b.width)}`);
    }
    return { sw: document.documentElement.scrollWidth, out: out.slice(0, 6) };
  });
  console.log(path, r.sw, r.out.join('\n  '));
}
await b.close();
