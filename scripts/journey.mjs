// The whole customer journey in a real browser (spec §33): order on a phone → received →
// staff confirm with a timeframe → a suggested change the customer accepts → weighing → ready →
// payment request → EFT proof → staff verify → receipt → invoice → completed → feedback → reorder.
// Runs against the throwaway QA server (scripts/qa-server.sh). Email is not configured there, so
// messages are recorded as "Not sent" — that is checked too. Nothing real is paid.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.env.BASE ?? 'http://localhost:8092';
const out = process.env.OUT ?? '/tmp/terram-journey';
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
const step = (m) => console.log('✓', m);
const fail = (m) => { errors.push(m); console.log('✗', m); };
const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const api = (p, method, url, body) => p.evaluate(async ([method, url, body]) => {
  const r = await fetch(url, { method, headers: { 'x-terram': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

// ── 1. Customer on a phone ──────────────────────────────────
const cctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const c = await cctx.newPage();
c.on('pageerror', (e) => fail('customer page error: ' + e.message));
await c.goto(base + '/order');
await c.getByRole('heading', { name: 'What would you like?' }).waitFor();

// Mobile search: a full-screen panel with the box at the top and results under it, above the keyboard
const panel = c.getByRole('dialog', { name: 'Search products' });
const openSearch = () => c.getByRole('button', { name: /^Search products/ }).tap();
const pick = async (term, name) => {
  await openSearch();
  await panel.getByRole('searchbox').fill(term);
  await panel.getByRole('button', { name }).first().tap();
  await c.getByRole('dialog').getByRole('button', { name: /Add to order/ }).waitFor();
};
await openSearch();
await c.setViewportSize({ width: 390, height: 420 }); // the keyboard takes the bottom half
await panel.getByRole('searchbox').pressSequentially('mince', { delay: 30 });
await c.waitForTimeout(400);
const s = await c.evaluate(() => {
  const dlg = document.querySelector('[role=dialog][aria-label="Search products"]');
  const i = dlg.querySelector('input').getBoundingClientRect();
  const first = [...dlg.querySelectorAll('li button')].find((x) => /Mince/.test(x.textContent))?.getBoundingClientRect();
  return { input: [i.top, i.bottom], first: first ? [first.top, first.bottom] : null, h: innerHeight, value: dlg.querySelector('input').value, focused: document.activeElement === dlg.querySelector('input') };
});
if (s.value !== 'mince') fail(`search box shows "${s.value}"`);
if (!s.focused) fail('search box did not get the keyboard focus from the tap');
if (s.input[0] < 0 || s.input[1] > s.h) fail(`search box off screen: ${JSON.stringify(s)}`);
if (!s.first || s.first[1] > s.h) fail(`first result not visible above the keyboard: ${JSON.stringify(s)}`);
await shot(c, '01-mobile-search-keyboard');
step(`mobile search panel: box at ${Math.round(s.input[0])}–${Math.round(s.input[1])}, first result ends at ${Math.round(s.first?.[1])}, visible height ${s.h}`);
await c.setViewportSize({ width: 390, height: 844 });

// Lean mince (picked straight from the search panel): a size must be chosen; 2 × 1kg packs, exact price
await panel.getByRole('button', { name: /^Lean Mince/ }).first().tap();
await c.getByRole('dialog').getByRole('button', { name: /^1 kg pack/ }).click();
await c.getByRole('dialog').getByRole('button', { name: 'More' }).click();
const addLabel = await c.getByRole('dialog').getByRole('button', { name: /Add to order/ }).textContent();
if (!/R\s?250/.test(addLabel.replace(/\u00a0/g, ' '))) fail(`mince 2 × 1kg price on button: ${addLabel}`);
await c.getByRole('dialog').getByRole('button', { name: /Add to order/ }).click();
// Rib-eye on the bone is an option inside the rib-eye card
await pick('rib eye', /^Rib-Eye/);
await c.getByRole('dialog').getByRole('button', { name: /On the bone/ }).click();
await c.getByRole('dialog').getByRole('button', { name: 'More quantity' }).first().click().catch(() => undefined);
await c.getByRole('dialog').getByRole('button', { name: /Add to order/ }).click();
// Dry-aged rump: surcharge shown
await pick('rump', /^Rump/);
await c.getByRole('dialog').getByRole('button', { name: /Dry-aged/ }).click();
if (!(await c.getByText(/instead of/).count())) fail('dry-aged surcharge price not shown');
await c.getByRole('dialog').getByRole('button', { name: 'More quantity' }).first().click().catch(() => undefined);
await c.getByRole('dialog').getByRole('button', { name: /Add to order/ }).click();
await c.getByRole('button', { name: 'Clear search' }).first().tap().catch(() => undefined);
if (await c.getByText('Packing', { exact: true }).count()) fail('packaging is still offered as a customer choice');
await shot(c, '02-catalogue');
await c.getByRole('button', { name: /View order/ }).click();
await c.getByRole('button', { name: 'Checkout' }).click();
await c.getByLabel('Name', { exact: true }).fill('Thandi Journey-Test');
await c.getByLabel('Mobile number').fill('082 444 9917');
await c.getByLabel(/^Email/).fill('thandi.journey@example.com');
await c.getByText('Yes, please provide an invoice').click();
await c.getByLabel('Company · optional').fill('Zulu Catering');
await c.getByText(/occasional reminder/).click();
await shot(c, '03-details-invoice');
await c.getByRole('button', { name: 'Continue' }).click();
await c.locator('textarea').first().fill('12 Kerk Street, Pretoria East');
await c.getByRole('button', { name: 'Continue' }).click();
await c.getByText(/Checking today’s prices/).waitFor({ state: 'detached' }).catch(() => undefined);
await c.waitForTimeout(400);
const terms = c.getByRole('checkbox');
if (await terms.count()) await terms.check();
await shot(c, '04-review');
await c.getByRole('button', { name: 'Send order' }).click();
await c.getByRole('heading', { name: 'Order received' }).waitFor();
if (await c.getByText(/order (is|has been) confirmed/i).count()) fail('success screen says confirmed');
await shot(c, '05-received');
step('order sent from a phone: "Order received", not confirmed');
await c.getByRole('link', { name: 'Track my order' }).click();
await c.getByText('What’s happening').waitFor();
const orderUrl = c.url();
await shot(c, '06-order-page-received');
step('customer order page opens from the link: ' + orderUrl.replace(base, ''));

// ── 2. Staff ─────────────────────────────────────────────────
const sctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await sctx.newPage();
p.on('pageerror', (e) => fail('staff page error: ' + e.message));
await p.goto(base + '/login');
await p.fill('#email', 'dylan@terram.test');
await p.fill('#password', 'butchery123');
await p.click('button[type=submit]');
await p.getByText(/Good (morning|afternoon|evening)/).waitFor();

// Banking details (admin) so EFT can be offered
await p.goto(base + '/settings?tab=payments');
await p.getByRole('textbox', { name: 'Account holder' }).fill('Terram Farm (Pty) Ltd');
await p.getByRole('textbox', { name: 'Bank', exact: true }).fill('Test Bank');
await p.getByRole('textbox', { name: 'Account number' }).fill('62000000001');
await p.getByRole('textbox', { name: 'Branch code' }).fill('250655');
await p.getByRole('switch', { name: 'Accept EFT (bank transfer)' }).click();
await p.getByRole('button', { name: 'Save' }).first().click();
await p.getByText('Settings saved').first().waitFor();
await shot(p, '07-settings-banking');
step('admin entered banking details and switched EFT on');
const links = await api(p, 'PUT', '/api/admin/settings/business', { instagramUrl: 'https://www.instagram.com/terramfarm_example', googleReviewUrl: 'https://g.page/r/terram-example/review' });
if (links.status !== 200) fail('saving social links: ' + JSON.stringify(links.body));

const list = await api(p, 'GET', '/api/orders?view=review');
const order = list.body.orders.find((o) => o.customer_name === 'Thandi Journey-Test');
if (!order) throw new Error('order not in review list');
await p.goto(base + `/orders/${order.id}`);
await p.getByRole('button', { name: /Confirm order/ }).first().click();
if (await p.getByRole('dialog').getByRole('button', { name: 'Delivery', exact: true }).count()) {
  await p.getByRole('dialog').getByRole('button', { name: 'Delivery', exact: true }).click();
  await p.getByText('Choose collection or delivery.').waitFor({ state: 'detached' });
}
await p.getByRole('button', { name: '1–2 weeks' }).click();
await shot(p, '08-confirm-sheet');
await p.getByRole('dialog').getByRole('button', { name: 'Confirm order' }).click();
await p.getByText(/Order confirmed/).first().waitFor();
const again = await api(p, 'POST', `/api/orders/${order.id}/confirm`, { expected_from: '2030-01-01' });
if (!again.body?.already) fail('second confirm was not idempotent: ' + JSON.stringify(again.body));
step('staff confirmed with a 1–2 week timeframe (repeat confirm is a no-op)');

// Suggest a change: not enough rib-eye on the bone → remove it
await p.getByRole('button', { name: 'Suggest a change' }).click();
await p.getByLabel('What change?').selectOption('remove_item');
const opts = await p.getByLabel('Item').locator('option').allTextContents();
const rib = opts.findIndex((t) => /Rib-Eye/i.test(t));
if (rib >= 0) await p.getByLabel('Item').selectOption({ index: rib });
await p.getByLabel(/^Reason/).fill('We have no rib-eye on the bone this week');
await p.getByRole('button', { name: 'Send to the customer' }).click();
await p.getByText('Sent to the customer').first().waitFor();
step('staff suggested a change');

await c.reload();
await c.getByText('We’ve suggested a change').first().waitFor();
await shot(c, '09-customer-amendment');
await c.getByRole('button', { name: 'Accept change' }).click();
await c.getByText(/You accepted a change/).waitFor();
step('customer accepted the change on their order page');

// Production: cut, pack, weigh, ready
for (const to of ['cutting', 'cut', 'packing']) {
  const r = await api(p, 'POST', `/api/orders/${order.id}/transition`, { to });
  if (r.status !== 200) fail(`transition ${to}: ${JSON.stringify(r.body)}`);
}
await p.reload();
await p.getByRole('button', { name: 'Enter weight' }).first().waitFor();
const weigh = p.getByRole('button', { name: 'Enter weight' });
const nWeigh = await weigh.count();
for (let i = 0; i < nWeigh; i++) {
  await p.getByRole('button', { name: 'Enter weight' }).first().click();
  await p.getByLabel('Packed weight (kg)').fill(i === 0 ? '2.135' : '1.05');
  await p.getByRole('button', { name: 'Save weight' }).click();
  await p.getByText('Weight saved').first().waitFor();
  await p.waitForTimeout(300);
}
step(`entered ${nWeigh} packed weight(s) in the order page`);
for (const to of ['packed', 'ready']) {
  const r = await api(p, 'POST', `/api/orders/${order.id}/transition`, { to });
  if (r.status !== 200 && !(to === 'ready' && r.status === 409)) fail(`transition ${to}: ${JSON.stringify(r.body)}`);
}
const det = await api(p, 'GET', `/api/orders/${order.id}`);
if (det.body.order.status !== 'ready') fail('order not ready: ' + det.body.order.status);
if (!det.body.payment.request) fail('no payment request after ready: ' + JSON.stringify(det.body.payment.blocker));
step(`ready → payment requested for R${(det.body.payment.request?.amount_cents ?? 0) / 100}`);

// Customer pays by EFT and uploads proof
await c.reload();
await c.getByText('Pay for your order').waitFor();
if (!(await c.getByText('62000000001').count())) fail('EFT account number not shown to the customer');
await shot(c, '10-customer-pay');
const pdf = `${out}/proof.pdf`;
fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
await c.getByRole('button', { name: 'Upload proof of payment' }).click();
await c.locator('input[type=file]').setInputFiles(pdf);
await c.getByRole('button', { name: 'Send proof' }).click();
await c.getByText(/Thanks for your proof of payment/).waitFor();
const st = await api(c, 'GET', `/api/public${new URL(orderUrl).pathname}`);
if (st.body.order.payment.state === 'paid') fail('proof upload marked the order paid');
step('customer uploaded EFT proof; order is NOT marked paid yet');

// Staff verify against the bank
await p.reload();
await p.getByRole('button', { name: 'Check & verify…' }).click();
await p.getByText(/I’ve checked the bank/).click();
await p.getByRole('button', { name: 'Verify payment' }).click();
await p.getByText(/Payment verified/).first().waitFor();
step('staff verified the payment');

await c.reload();
await c.getByRole('button', { name: 'Receipt' }).first().click();
await c.getByText(/^R\d+$/).first().waitFor();
await shot(c, '11-receipt');
await c.keyboard.press('Escape');
step('customer sees the receipt');

// Invoice: issued by hand with a real reference and file
await p.reload();
await p.getByRole('button', { name: /Mark issued/ }).click();
await p.getByLabel('Invoice number / reference').fill('INV-0042');
await p.locator('input[type=file]').setInputFiles(pdf);
await p.getByRole('button', { name: 'Mark sent' }).click();
await p.getByText('Invoice marked as sent').first().waitFor();
step('staff attached and sent the invoice');

const done = await api(p, 'POST', `/api/orders/${order.id}/transition`, { to: 'completed' });
if (done.status !== 200) fail('complete: ' + JSON.stringify(done.body));
await p.reload();
await shot(p, '12-staff-order');

await c.reload();
await c.getByText('How was your order?').waitFor();
if (!(await c.getByRole('link', { name: 'Download' }).count())) fail('invoice download not offered');
await c.getByRole('radio', { name: '5 stars' }).click();
await c.getByPlaceholder(/Anything you’d like/).fill('Lovely meat, thank you');
await c.getByRole('button', { name: 'Send feedback' }).click();
await c.getByText('Thank you for your feedback.').waitFor();
await shot(c, '13-customer-completed');
step('completed; customer left feedback and can download the invoice');

await c.getByRole('button', { name: 'Reorder' }).click();
await c.waitForURL(/\/order$/);
await c.getByText(/copied order #/).waitFor();
await shot(c, '14-reorder-draft');
const drafts = await api(p, 'GET', '/api/orders?view=review');
if (drafts.body.orders.some((o) => o.customer_name === 'Thandi Journey-Test')) fail('reorder created an order by itself');
step('reorder loaded a draft basket (nothing sent)');

// Send the reorder: a returning customer is invited to review on Google and follow on Instagram
await c.getByRole('button', { name: 'Checkout' }).click();
await c.getByRole('button', { name: 'Continue' }).click();
await c.getByRole('button', { name: 'Continue' }).click();
await c.getByText(/Checking today’s prices/).waitFor({ state: 'detached' }).catch(() => undefined);
if (await c.getByRole('checkbox').count()) await c.getByRole('checkbox').check();
await c.getByRole('button', { name: 'Send order' }).click();
await c.getByRole('heading', { name: 'Order received' }).waitFor();
if (!(await c.getByRole('link', { name: /Leave a Google review/ }).count())) fail('returning customer not invited to review');
if (!(await c.getByRole('link', { name: /Instagram/ }).count())) fail('Instagram link missing');
if (!(await c.getByText('Orders from this device').count())) fail('device orders not listed');
await shot(c, '16-returning-done');
step('returning customer: Google review + Instagram + past orders on the thank-you screen');

// Messages were recorded honestly (email isn't configured on the QA server)
const notes = (await api(p, 'GET', `/api/orders/${order.id}`)).body.notifications;
if (notes.some((n) => n.status === 'sent')) fail('a message was marked sent although email is not configured');
if (!notes.length) fail('no messages were recorded for the order');
step(`${notes.length} messages recorded for the order, none falsely marked sent`);

// Dashboard queues
await p.goto(base + '/');
await shot(p, '15-dashboard');
await b.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n- ${errors.join('\n- ')}` : '\nJourney passed');
process.exit(errors.length ? 1 : 0);
