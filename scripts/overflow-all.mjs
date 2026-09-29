// Checks every screen at phone, tablet and desktop widths for anything running off the right edge.
import { chromium } from 'playwright-core';
const base = 'http://localhost:8092';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const widths = (process.env.WIDTHS ?? '390,768,1024,1280,1440').split(',').map(Number);
const login = async (p) => { await p.goto(base + '/login'); await p.fill('#email', 'dylan@terram.test'); await p.fill('#password', 'butchery123'); await p.click('button[type=submit]'); await p.waitForTimeout(1000); };
let paths = ['/', '/orders', '/cutting', '/packing', '/fulfilment', '/customers', '/products', '/stock', '/stock?tab=plan', '/stock?tab=items', '/stock?tab=purchases', '/stock?tab=suppliers', '/exceptions', '/intelligence', '/reports', '/settings', '/devices', '/orders/new', '/import'];
let problems = 0;
for (const w of widths) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, isMobile: w < 500 });
  const p = await ctx.newPage();
  await login(p);
  // add a customer page and an order page
  const extra = await p.evaluate(async () => {
    const c = await (await fetch('/api/customers?limit=5')).json();
    const o = await (await fetch('/api/orders?limit=3')).json();
    return [...c.customers.slice(0, 2).map((x) => `/customers/${x.id}`), ...(o.orders ?? []).slice(0, 2).map((x) => `/orders/${x.id}`)];
  });
  for (const path of [...paths, ...extra]) {
    await p.goto(base + path); await p.waitForTimeout(700);
    const r = await p.evaluate((w) => {
      const out = [];
      for (const el of document.querySelectorAll('main *, aside *')) {
        const bx = el.getBoundingClientRect();
        if (bx.width === 0) continue;
        // ignore things inside horizontal scrollers
        let s = el.parentElement, scrolled = false;
        while (s) { const cs = getComputedStyle(s); if (/(auto|scroll)/.test(cs.overflowX) && s.scrollWidth > s.clientWidth - 1) { scrolled = true; break; } s = s.parentElement; }
        if (!scrolled && bx.right > w + 1) out.push(`${el.tagName}.${(el.className?.toString?.() ?? '').slice(0, 60)} right=${Math.round(bx.right)}`);
      }
      return { sw: document.documentElement.scrollWidth, out: out.slice(0, 4) };
    }, w);
    if (r.sw > w || r.out.length) { problems++; console.log(`✗ ${w}px ${path} scrollWidth=${r.sw}\n  ${r.out.join('\n  ')}`); }
  }
  await ctx.close();
}
console.log(problems ? `${problems} problems` : 'No overflow at any width');
await b.close();
