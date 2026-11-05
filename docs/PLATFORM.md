# Terram customer ordering platform — setup and operations

This covers the customer ordering platform: catalogue rules, the order form, confirmation, the customer order page, order history, payments (EFT and PayFast), invoice requests, suggested changes, emails, reminders and feedback. It sits on the same order system as the rest of Terram. There is one catalogue, one order record and one status per order.

## The order journey

1. **Customer orders** at `/order`. They see sizes (e.g. 500 g / 1 kg mince packs), variations (rib-eye on/off the bone) and any surcharges (dry-aged +25%). On "Check & send", the server prices the basket again with today's catalogue. If anything changed, the customer sees it before sending.
2. **Order received**: the customer gets the "received" email and a link to their order page. Staff get an alert. The order is **not** confirmed yet.
3. **Staff confirm**: on the order page, **Confirm order** asks for the expected timeframe (and collection/delivery if not set). Confirming is blocked while there are problems (no items, unpriced lines, open questions, unanswered changes, missing address). Confirming twice does nothing.
4. **Suggested changes**: if something can't be supplied, use **Suggest a change**. The customer accepts or declines on their order page. Nothing changes until they accept.
5. **Cutting and packing**: the cutting list and packing bench work as before, with fresh/frozen shown on every order. No weights are entered here. Marking an order **Packed** moves it to **final weighing**. It is not released for delivery yet.
6. **Final weighing → finalize**: on the Packing screen (Final weighing section) or the order page, enter the actual packed weight of each weighed item and tick that the fixed packs (e.g. mince) are right. Then **Finalize & request payment**.
   - The lines, weights, rates and total are saved as a locked version.
   - That amount is what the customer pays, and what the docket shows.
   - To change a finalized order, a manager uses **Reopen for changes** with a reason. The old version is kept, any open payment request is withdrawn, and the customer is told if they had already been asked to pay.
   - Reopening isn't possible once a payment has been verified or an invoice issued.
7. **Payment request**: the preview shows the customer, amount, email address, the secure payment-page link and the exact message.
   - **Send by email** sends it. Sending again needs an explicit "email it again".
   - **Open in WhatsApp** opens the prepared message on your own phone to send by hand. WhatsApp isn't connected for automatic sending, so this is recorded as "sent by hand", never as delivered.
   - The send history (status, tries, errors) is on the order.
8. **Payment (EFT)**: the customer's secure payment page (`/pay/…`) shows the finalized lines with weights and rates, the amount, your banking details, their payment reference (the order number) and copy buttons.
   - There's no bank-app integration: customers copy the details into their own banking app.
   - They can tap **I've made payment** and/or upload proof. Either one sets the order to **awaiting verification**, never **paid**.
   - A manager checks the bank, then confirms (**Check & verify** on a proof, or **Check & confirm** on an "I've paid"), or asks for more information.
   - Paid in full → the order is automatically released as **ready**, and the customer gets one "payment received — ready" email with a receipt link.
9. **Release**: unpaid orders can't be marked ready. If the business wants exceptions (e.g. cash on collection), switch on *Settings → Payments → Let managers release an unpaid order*. A manager then gives a reason, which is recorded.
10. **Invoice** (only if requested): staff prepare it by hand in the accounting software, then **Mark issued** or **Mark sent** with the real invoice number and date, optionally attaching the PDF. There is no automatic invoice generation and no Xero link.
11. **Completed**: the customer can leave optional feedback and **Reorder**. Reorder loads a new draft basket at today's prices; the customer reviews and sends it. Nothing is ordered automatically.
12. **Reorder reminders** (optional): sent only to customers who ticked the reminder box, about 14 days after completion (configurable). Each customer gets one per order, and none if they've ordered again since. Every reminder has an unsubscribe link.

## Customer details at checkout

Required: **full name**, a **valid mobile number** (stored as +27…; other countries need +country code), a **valid email**, and for deliveries a **delivery address** and **delivery instructions** (directions, gate code). There are no customer passwords.

## Delivery fee (flat R150)

- *Settings → Orders & fulfilment → Collection & delivery*: pricing method (flat fee per order), the **standard delivery fee** (R150 to start), the **delivery area** and **policy** texts shown to customers.
- The fee is written onto each order when it's placed. Changing the setting **never changes existing orders**.
- Checkout says: "We deliver within our regular local delivery area. Other locations can be arranged separately. We will contact you to confirm the delivery arrangements." The fee shows on checkout, the received email, the order page, the payment page and the docket.
- On an order (*Delivery fee → Change*): standard fee, **custom fee** (managers only, e.g. outside the area), **arranged separately** (no fee on the order) or collection. Totals are recalculated; a finalized order gets a new version, and an open payment request is updated.
- The old per-km fields are no longer used for new orders.

## Products: how customers order them

*Products → (product) → How customers order it*:
- **Fixed-weight packs**: e.g. mince in 500 g packets ("4 × 500 g packets = 2 kg estimated total").
- **Counted, priced on weight**: e.g. steaks. Customers choose how many and a **preferred weight each** (300–400 g, 400–500 g, 500–600 g, or Other / special request, which needs a note). Weight choices are set per product.
- **Individual items**, **by weight**, **whole / sized pieces**, or **custom** (ask under Special requests).
- **Variations**: a main product (e.g. Brisket) with its own variations (Whole / Smoked BBQ / Smoked Honey Mustard), each with its own price, description, availability and rules. Use **Add variation**. Switch on "Only a heading for its variations" if the main product can't be ordered itself.
- The upgrade set mince to 500 g packets (only where it still had the old 500 g + 1 kg setup) and added the three steak weight choices to priced steak products. These are marked **Check set-up** until someone opens and saves them (*Dashboard → Attention → Product set-ups to check*). No prices or weights were invented.
- **Everything is frozen** now: customers aren't asked fresh or frozen. Older orders keep "fresh" where it was chosen.

## Final weights at any stage

Weighed items can get a final weight while **cutting, packing, packed or ready** (*order → item → Enter final weight*), without moving the order. Each change is in the history with who and when. Totals follow; a finalized order gets a new version and an open payment request is updated. A weight far from the estimate is flagged for a second look.

## Payments

- States: not requested, payment requested, **awaiting verification** (the customer tapped "Already paid?" or sent proof), part paid, paid, **payment not received** (checked, not found), waived. Payment never decides where an order is in production or delivery.
- The customer taps **Already paid?** on their **payment page** (never from the email), optionally adds a proof, and sees a **thank-you page** once. The payment page stays the permanent place to come back to.
- Each new "I've paid" or proof sends **"Payment Verification Required — Terram Farm — #N"** to the payment reviewers (*Settings → Emails & reminders → Who checks the bank*, default Sharonm@Imagine.co.za). Repeat taps while one is pending don't create another alert. Nothing is sent to the customer except a short "thanks, we'll check" acknowledgement, and **no payment request is re-sent**.
- On the order, the next step is **Check payment** (it also appears on the dashboard under **Payments to check**):
  - **Confirm payment**: enter the amount that arrived, the date and bank reference. One payment is recorded with your name, the balance updates and the task disappears.
  - **Payment not received**: add an internal note (staff only). The balance stays owed, the history is kept, and the customer is **only emailed if you tick it and write the message**. To ask again, use **Send payment request** separately: it shows the recipient and amount first and needs "Send again".
- Managers can also record full or part payments with date and reference, or waive a payment with a reason.
- **Unpaid release**: a manager can send an unpaid order out (*More → Send out for delivery unpaid…*) after a warning, a confirmation and a reason. Their name, the time and the reason are recorded. The payment stays owed and shows in Out for Delivery, and after delivery in *Fulfilment → History → Not paid* and *Attention → Delivered · not paid*.

## Dashboard

Top to bottom: **New orders · needs review** (most prominent, with the reason), **Payments to check**, **Confirmed**, **Processing** (cutting and packing), **Packed & Ready**, **Out for Delivery** (address, instructions, phone, unpaid marked), then **Waiting on us** (only staff tasks not already shown above) and **Attention** (open problems). Delivered orders are in **Fulfilment → History**, searchable by name, number, phone, email or product, with a "Not paid" filter. "Cutting" is now shown as **Processing** everywhere; the cutting list page is under *Processing* in the menu.

## Invoices

Upload the PDF on the order at any time (*Invoice → Upload invoice*). **Save invoice only** (customer not emailed) or **Save and notify customer**. You can view, download, replace or remove it, and send the notification again later (with a preview). The customer downloads it securely from their order page and payment page.

## Communications on the order

*Communications* lists everything sent to the customer, with honest statuses: **Sent** means our mail server accepted it (we can't see inbox delivery, so "Delivered" is never shown), plus Queued / Failed / Not sent. The panel has separate actions: send (or resend) the order confirmation, the payment request, the invoice notification (all with previews), an **editable WhatsApp message** (opened on your phone, recorded as a hand-off, never changes payment), and **copy portal link**. In *History* you can add an **internal note** or an **update for the customer** (shown on their order page).

## Website pages

- Home page sections: hero, intro, products, ordering info, how ordering works, delivery, about, **View my orders**, reviews and social, FAQ preview, Order now. All pages share the same header (Home, About Us, Order Now, FAQs, Contact) and footer.
- **About Us** (`/about`): edit in *Settings → About page*. It says "farm-raised"; don't add claims you can't back up.
- **FAQs** (`/faq`, `/help` still works): grouped by topic, edited in *Settings → FAQs*. `{{leadTime}}`, `{{deliveryArea}}` and `{{deliveryFee}}` are filled in.
- Instagram, Facebook and Google review links appear only if set in *Settings → Business*. The home page says "Ordered from us? Leave us a Google review"; the thank-you pages also offer it.

## View my orders (no passwords)

The customer enters their **mobile number** (or email). **There is no SMS service connected**, so the one-time code is **emailed** to the address(es) on that number's orders. The reply is the same whether or not the number is known. After the code, they see only their own orders: products, totals, delivery fee, payment and production status, outstanding amount, and invoice availability.

## Unfinished orders

The order form saves the basket on the device, and also privately on the server for 14 days (tied to a cookie on that device, not to a name or number). If the browser loses it, the form offers **Continue that order / Start a new order**. It's deleted when the order is sent.

## Vegetables and new sections

In *Products → Add product*, type a new category such as **Vegetables** (or "Vegetables – Leafy greens"). The part before the dash becomes a tab on the order form. Use "each" pricing with a piece name like *bunch* or *head*, or price per kg.

## Server environment variables (Render → Environment)

Secrets live only here, never in the app or on devices.

| Variable | Needed for | Notes |
|---|---|---|
| `APP_SECRET` | Order links, unsubscribe links | Recommended: a long random string. If not set, one is generated and stored in the database. Changing it invalidates every customer order link already emailed. |
| `APP_URL` | Links in emails | Optional. Otherwise *Settings → Business → Public web address* is used (default `https://www.terramfarm.co.za`). Never a localhost address. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | Sending email | Without these, emails are recorded as **Not sent** (never as sent). They show in *Settings → Emails & reminders → Message log* and can be retried. |
| `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY` | Online payment | From the PayFast dashboard (sandbox or live). |
| `PAYFAST_PASSPHRASE` | Online payment | Must match the passphrase set in the PayFast dashboard exactly (or leave both empty). |
| `PAYFAST_MODE` | Online payment | `live` for real payments; anything else (or unset) uses the **sandbox**. |
| `PAYFAST_SKIP_IP_CHECK` | Testing only | `1` skips the PayFast source-IP check. Never set it in production. |

## Banking details (EFT) — e.g. FNB

*Settings → Payments & banking* (admins only):
1. Fill in your details exactly as your bank shows them:
   - **Account holder**: the business name on the account
   - **Bank**: e.g. "FNB" or "First National Bank"
   - **Account type**: e.g. "Cheque" or "Business current", optional
   - **Account number**
   - **Branch code**: FNB's universal branch code is printed on your FNB statement/app; copy it from there rather than from memory
   - **SWIFT/BIC**: only for payments from abroad
2. Check the "What the customer sees" preview, switch on **Accept EFT (bank transfer)** and save. EFT can't be switched on while a required field is blank.

How the details are protected:
- Nothing is built in.
- Managers see only the last 4 digits; the audit log stores it masked and records who changed it.
- Customers see the details only on their own payment page, and only while a payment is open.

## PayFast setup

1. Create a sandbox account at sandbox.payfast.co.za. Copy the sandbox merchant ID and key, and set a passphrase.
2. Set `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY` and `PAYFAST_PASSPHRASE` on Render; leave `PAYFAST_MODE` unset (sandbox). Redeploy.
3. In *Settings → Payments & banking*, switch on **Accept online payment** (it only works once the server variables are present).
4. The notify (ITN) URL is sent with each payment automatically: `https://www.terramfarm.co.za/api/integrations/payfast/notify`. The site must be reachable over https for PayFast to call it.
5. Test with a small sandbox payment and check the order shows **Paid** with a receipt. Then switch to live: the live merchant ID, key and passphrase, plus `PAYFAST_MODE=live`.

## How to test

- `npm test` runs the API/unit tests (`tests/master.test.ts` covers this upgrade). Email goes to an in-memory outbox and PayFast is mocked; nothing real is sent or charged.
- `npm run build && bash scripts/qa-server.sh` starts a throwaway server on :8092 with sample data (not your live database). Then:
  - `node scripts/journey.mjs`: the whole customer journey in a phone browser (search, packets, steak weights, delivery fee and instructions, confirm, change, final weighing, payment request, "Already paid?", thank-you, proof, verification, invoice upload and notify, communications, completion, reorder, home page, View my orders, About, FAQ, dashboard).
  - `node scripts/e2e.mjs`: staff import, cutting, packing, final weighing and fulfilment.
  - `node scripts/overflow-all.mjs`: every staff screen at phone, tablet and desktop widths.
  - `node scripts/sheets-check.mjs`: public pages signed out, and the weighing, delivery and WhatsApp sheets at 360/390 px (no sideways overflow or scroll, even with an input focused).

### Trying it yourself on the live site (with a test order)
1. Place a small order at `/order` with your own email and mobile number.
2. Confirm it in Terram, then move it through cutting and packing and tick the items packed.
3. Packing → **Final weighing** → enter the weights, tick the packs, then **Finalize & request payment** → **Send by email**.
4. Open the payment page from the email. Check the amount, details and reference, then tap **Already paid?** (or upload a screenshot). Don't actually pay. The reviewer address gets "Payment Verification Required".
5. As a manager, use **Check & confirm** / **Check & verify**. For a test, record it and then **Reverse** it, or delete the test order afterwards.
6. The order shows **Ready**. Mark it collected/delivered.

## Known limitations

- **Opening the banking app**: there's no bank payment-link integration, so the page can't open a customer's banking app or start a transfer. It gives copy buttons (per field and "copy all") and clear steps instead.
- **PayFast** stays switched off unless its server variables are set; the payment page is EFT-only.

- **WhatsApp/SMS** sending is not connected. WhatsApp messages are opened on a staff phone and recorded as hand-offs. The View-my-orders code goes by email because there is no SMS provider.
- **Email delivery** can't be confirmed (SMTP only reports acceptance), so statuses stop at "Sent". Bounces aren't tracked.
- **PayFast** is tested against PayFast's documented signature rules and a mocked ITN, not against a live PayFast account. Do a sandbox payment before going live.
- **Refunds** are recorded by hand: "Reverse" on a payment. PayFast refunds are made in the PayFast dashboard.
- **Invoices** are prepared in your accounting software. Terram stores the uploaded file and sends the notification.
- Order history sign-in uses a 6-digit email code, so it needs working email.
