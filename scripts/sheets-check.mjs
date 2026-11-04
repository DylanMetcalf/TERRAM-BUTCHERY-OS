import { chromium } from 'playwright-core';
const base = 'http://localhost:8092';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let problems = 0;
const check = async (p, label) => {
  const r = await p.evaluate(() => {
    const out = [];
    const w = innerWidth;
    if (document.documentElement.scrollWidth > w) out.push('page scrollWidth ' + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll('[role=dialog] *')) { const s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollWidth > el.clientWidth + 1) out.push(`sheet body overflows sideways: ${el.scrollWidth} > ${el.clientWidth}`); if (el.scrollLeft > 0) out.push('scrolled left by ' + el.scrollLeft); }
    return out;
  });
  if (r.length) { problems++; console.log('✗', label, r.join('; ')); } else console.log('✓', label);
};
for (const w of [360, 390]) {
  // public, signed out
  const pc = await b.newContext({ viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true });
  const pp = await pc.newPage();
  for (const path of ['/', '/order', '/about', '/faq', '/account']) { await pp.goto(base + path); await pp.waitForTimeout(800); await check(pp, `${w}px public ${path}`); }
  await pp.goto(base + '/'); await pp.getByRole('button', { name: 'Open menu' }).click(); await check(pp, `${w}px public menu open`);
  await pc.close();
  // staff
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(base + '/login'); await p.fill('#email', 'dylan@terram.test'); await p.fill('#password', 'butchery123'); await p.click('button[type=submit]'); await p.waitForTimeout(1000);
  // make a packed order with a weighed item
  const id = await p.evaluate(async () => {
    const h = { 'content-type': 'application/json', 'x-terram': '1' };
    const prods = (await (await fetch('/api/products')).json()).products;
    const brisket = prods.find((x) => /brisket/i.test(x.canonical_name) && x.price_unit === 'kg');
    const rump = prods.find((x) => x.canonical_name === 'Rump');
    const o = (await (await fetch('/api/orders', { method: 'POST', headers: h, body: JSON.stringify({ customer: { name: 'Layout Check With A Very Long Customer Name' }, status: 'confirmed', fulfilment_type: 'collection', items: [{ product_id: brisket.id, qty: { kind: 'weight', weight_g: 2000 } }, { product_id: rump.id, qty: { kind: 'count', count: 4 } }] }) })).json()).order;
    await fetch(`/api/orders/${o.id}/transition`, { method: 'POST', headers: h, body: JSON.stringify({ to: 'cutting' }) });
    return o.id;
  });
  await p.goto(base + `/orders/${id}`); await p.waitForTimeout(800);
  await check(p, `${w}px order page (cutting)`);
  await p.getByRole('button', { name: 'Enter final weight' }).first().click(); await p.waitForTimeout(400);
  await p.getByRole('dialog').getByLabel('Actual weight (kg)').fill('2,15'); await check(p, `${w}px weight sheet (cutting stage)`);
  await p.getByRole('button', { name: 'Save weight' }).click(); await p.waitForTimeout(600);
  const st = await p.evaluate(async (id) => (await (await fetch(`/api/orders/${id}`)).json()).order.status, id);
  if (st !== 'cutting') { problems++; console.log('✗ weight entry moved the order to', st); } else console.log('✓ weight entry kept the order in cutting');
  // move to packed and open final weighing
  await p.evaluate(async (id) => { const h = { 'content-type': 'application/json', 'x-terram': '1' }; await fetch(`/api/orders/${id}/transition`, { method: 'POST', headers: h, body: '{"to":"cut"}' }); const d = await (await fetch(`/api/orders/${id}`)).json(); for (const i of d.items) await fetch(`/api/items/${i.id}/packed`, { method: 'POST', headers: h, body: '{"packed":true}' }); await fetch(`/api/orders/${id}/packed`, { method: 'POST', headers: h, body: '{}' }); }, id);
  await p.goto(base + `/orders/${id}`); await p.waitForTimeout(800);
  await p.getByRole('button', { name: 'Final weighing' }).click(); await p.waitForTimeout(500);
  const inputs = p.getByRole('dialog').getByLabel(/^Packed weight of/);
  for (let i = 0; i < await inputs.count(); i++) { await inputs.nth(i).tap(); await inputs.nth(i).fill('1,8'); await p.waitForTimeout(150); await check(p, `${w}px final weighing, input ${i + 1} focused`); }
  await p.screenshot({ path: `${process.env.S}/weigh-${w}.png` });
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: 'Change' }).first().click().catch(() => undefined); await p.waitForTimeout(300); await check(p, `${w}px delivery sheet`); await p.keyboard.press('Escape');
  await p.getByRole('button', { name: 'WhatsApp message…' }).click(); await p.waitForTimeout(400); await check(p, `${w}px WhatsApp sheet`); await p.keyboard.press('Escape');
  await ctx.close();
}
console.log(problems ? `${problems} problems` : 'All sheets OK');
await b.close();
