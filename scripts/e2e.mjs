// Browser end-to-end: customer form → staff import → exception → cutting → packing → fulfilment.
import { chromium } from 'playwright-core';
const base = process.env.BASE ?? 'http://localhost:8092';
const shots = process.env.OUT ?? '/tmp/terram-e2e';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
const step = (m) => console.log('✓', m);

// 1. Customer orders on a phone
const cust = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
cust.on('pageerror', (e) => errors.push('customer: ' + e.message));
await cust.goto(base + '/order');
await cust.getByRole('button', { name: /^Lean Mince/ }).first().click();
await cust.getByRole('button', { name: 'Add to order', exact: false }).click();
await cust.getByRole('button', { name: /^Rump\b/ }).first().click();
await cust.getByRole('button', { name: /More quantity/ }).first().click();
await cust.getByRole('button', { name: 'Thick cut' }).click();
await cust.getByRole('button', { name: /Add to order/ }).click();
// Search, add something by mistake, then remove it in the cart
await cust.getByLabel('Search products').fill('droewors');
await cust.getByRole('button', { name: /^Droewors/ }).first().click();
await cust.getByRole('button', { name: /Add to order/ }).click();
await cust.getByLabel('Search products').fill('');
await cust.getByRole('button', { name: /View order/ }).click();
await cust.getByRole('button', { name: 'Remove Droewors' }).click();
if (await cust.getByRole('dialog').getByText('Droewors').count()) errors.push('removing from the cart did not work');
await cust.getByRole('button', { name: 'Checkout' }).click();
await cust.fill('#n', 'Naledi Zulu');
await cust.fill('#p', '071 555 3380');
await cust.getByRole('button', { name: 'Continue' }).click();
await cust.locator('button:has-text("Sat"), button:has-text("Tomorrow"), button:has-text("Fri")').first().click();
// Address-only mode (the default): the family arranges collection or delivery
if (await cust.getByText('Your address').count()) await cust.locator('textarea').first().fill('12 Kerk Street, Pretoria East');
await cust.getByRole('button', { name: 'Continue' }).click();
await cust.getByRole('checkbox').check();
await cust.screenshot({ path: `${shots}/1-customer-review.png`, fullPage: true });
await cust.getByRole('button', { name: 'Send order' }).click();
await cust.getByText('Order received').waitFor();
step('customer placed an order on the public form');

// 2. Staff on a phone
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push('staff: ' + e.message));
await p.goto(base + '/login');
await p.fill('#email', 'dylan@terram.test');
await p.fill('#password', 'butchery123');
await p.click('button[type=submit]');
await p.getByText(/Good (morning|afternoon|evening)/).waitFor();
step('staff signed in');

// The form order waits for review — confirm it
await p.goto(base + '/orders?view=review');
await p.getByText('Naledi Zulu').first().click();
await p.getByRole('button', { name: 'Confirm order' }).click();
await p.getByText('Order confirmed').waitFor();
step('form order reviewed and confirmed');

// 3. Paste messy WhatsApp messages
await p.goto(base + '/import');
await p.getByLabel('Messages to import').fill('Thabo:\n2kg lean mince\n4 rumps\nCollect tomorrow\n\nThabo: actually make the mince 3kg\n\nLeila: 3 picanha steaks and 1kg wors, collect tomorrow\n\nThabo: thanks!');
await p.getByRole('button', { name: /Read messages/ }).click();
await p.getByText('Check what we understood').waitFor();
await p.screenshot({ path: `${shots}/2-import-review.png`, fullPage: true });
if (!(await p.getByText('Amended: 2kg → 3kg').isVisible())) errors.push('amendment not shown in review');
await p.getByRole('button', { name: /Confirm/ }).last().click();
await p.getByText(/order(s)? created/).waitFor();
step('import confirmed: amendment folded in, unknown product sent to exceptions');

// 4. Resolve the exception: picanha (not on the price list) → rump
await p.goto(base + '/exceptions');
await p.getByText(/Unknown product: “picanha/).first().waitFor();
await p.getByRole('button', { name: 'Choose product' }).first().click();
const sheet = p.getByRole('dialog');
await sheet.getByLabel('Search products').fill('rump');
await sheet.getByRole('button', { name: /^Rump R/ }).click();
await sheet.getByRole('button', { name: 'Thick cut' }).click();
await sheet.getByRole('button', { name: 'Save' }).click();
await sheet.waitFor({ state: 'detached' });
await p.getByText('Everything is under control').waitFor({ timeout: 5000 }).catch(() => undefined);
step('exception resolved by a person');

// 5. Cutting: mark every line done
await p.goto(base + '/cutting');
await p.getByRole('tab', { name: 'Everything' }).click();
await p.waitForTimeout(500);
await p.screenshot({ path: `${shots}/3-cutting.png`, fullPage: true });
for (let i = 0; i < 40; i++) {
  const btn = p.getByRole('button', { name: /^Mark .* cut$/ }).first();
  if (!(await btn.count())) break;
  await btn.click();
  await p.waitForTimeout(250);
}
step('blockman marked all cutting done');

// 6. Packing: tick every item, then Packed
await p.goto(base + '/packing');
await p.waitForTimeout(500);
for (let i = 0; i < 60; i++) {
  const box = p.locator('button[role=checkbox][aria-checked=false]').first();
  if (!(await box.count())) break;
  await box.click();
  await p.waitForTimeout(150);
}
await p.screenshot({ path: `${shots}/4-packing.png`, fullPage: true });
for (let i = 0; i < 20; i++) {
  const btn = p.getByRole('button', { name: 'Packed', exact: true }).first();
  if (!(await btn.count())) break;
  await btn.click();
  await p.waitForTimeout(400);
}
await p.getByText('No packing').waitFor();
step('packing bench: all orders packed');

// 7. Fulfilment: hand everything over
await p.goto(base + '/fulfilment');
await p.waitForTimeout(500);
for (const tab of ['Collections', 'Deliveries']) {
  await p.getByRole('tab', { name: new RegExp(tab) }).click();
  for (let i = 0; i < 30; i++) {
    const btn = p.getByRole('button', { name: /^(Collected|Delivered|Out for delivery)$/ }).first();
    if (!(await btn.count())) break;
    await btn.click();
    await p.waitForTimeout(350);
  }
}
step('fulfilment: collected / delivered');

const counts = await p.evaluate(() => fetch('/api/production/dashboard').then((r) => r.json()));
console.log('dashboard counts', JSON.stringify({ to_cut: counts.counts.to_cut, to_pack: counts.counts.to_pack, ready: counts.counts.ready, completed_today: counts.counts.completed_today, exceptions: counts.exceptions.total }));
await b.close();
if (errors.length) {
  console.log('ERRORS\n' + errors.join('\n'));
  process.exit(1);
}
