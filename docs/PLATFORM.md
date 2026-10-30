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

## Instagram, Google reviews and past orders

- *Settings → Business*: paste your **Instagram profile link** and your **Google review link** (Google Business Profile → "Ask for reviews" → copy link). If either is left blank, it isn't shown.
- **Instagram** is offered to every customer: on the thank-you screen, the order page and in emails.
- **Google review** is offered only to customers who have actually had an order completed. That means the thank-you screen for a returning customer, the order page once completed, and the "order complete" email. Everyone who qualifies is asked, whatever their rating. Google's rules don't allow inviting only happy customers.
- **Past orders**:
  - Each device remembers the orders placed or opened on it ("Orders from this device").
  - Customer emails include a "See all your orders" link that signs them in for 30 days.
  - Customers can also get a 6-digit code at `/account`.
  - Orders are never shown just because someone typed a name or phone number. Anyone could type those.

## Fresh or frozen

Customers must choose **fresh** or **frozen** (there's no default).
- Fresh on a delivery: the form explains that journeys over about 2 hours (*Settings → Orders & fulfilment → Fresh deliveries*) can't be guaranteed, recommends frozen, and offers WhatsApp.
- Staff get a "Check delivery time" item on fresh delivery orders.
- There's no route-time service, so nothing is calculated from distance: staff judge the journey.
- The choice shows on the order, cutting list, packing bench, fulfilment board, docket, customer order page and payment page. Staff can change it on the order.

## Vacuum packing and mince packs

Everything is vacuum-packed. The old "Packing" options (e.g. individually packed) are switched off for customers and staff. They're kept in the database so past orders still read correctly. Mince is sold only in the pack sizes set on the product (500 g first and preferred; 1 kg where offered). The form shows the pack count and total ("4 × 500 g packs = 2 kg"), and the server refuses any other size.

## Help & FAQ

`/help` shows the questions from *Settings → Help & FAQ*, plus a WhatsApp button (from the business phone number). Edit the answers there; only state what's true for the farm. `{{leadTime}}` and `{{freshMaxHours}}` are filled in automatically.

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

- `npm test` runs the API/unit tests. Email goes to an in-memory outbox and PayFast is mocked; nothing real is sent or charged.
- `npm run build && bash scripts/qa-server.sh` starts a throwaway server on :8092 with sample data (not your live database). Then:
  - `node scripts/journey.mjs` runs the whole customer journey in a browser:
    - phone search, fresh/frozen choice, received
    - confirm, suggested change
    - packed, final weighing, finalize
    - payment request preview and send, printed docket total
    - payment page and copy-all, "I've made payment", proof upload
    - manager verification, paid → ready
    - receipt, invoice, completed, feedback, reorder, review prompt
  - `node scripts/e2e.mjs` covers staff import, cutting, packing, final weighing and fulfilment.
  - `node scripts/overflow-all.mjs` checks every screen at phone, tablet and desktop widths.

### Trying it yourself on the live site (with a test order)
1. Place a small order at `/order` with your own email, and choose fresh or frozen.
2. Confirm it in Terram, then move it through cutting and packing and tick the items packed.
3. Packing → **Final weighing** → enter the weights, tick the packs, then **Finalize & request payment** → **Send by email**.
4. Open the payment page from the email. Check the amount, details and reference, then tap **I've made payment** or upload a screenshot. Don't actually pay.
5. As a manager, use **Check & confirm** / **Check & verify**. For a test, record it and then **Reverse** it, or delete the test order afterwards.
6. The order shows **Ready**. Mark it collected/delivered.

## Known limitations

- **Opening the banking app**: there's no bank payment-link integration, so the page can't open a customer's banking app or start a transfer. It gives copy buttons (per field and "copy all") and clear steps instead.
- **PayFast** stays switched off unless its server variables are set; the payment page is EFT-only.

- **WhatsApp/SMS** notifications are not connected. The notification service has the channel slots, but only email sends.
- **PayFast** is tested against PayFast's documented signature rules and a mocked ITN, not against a live PayFast account. Do a sandbox payment before going live.
- **Refunds** are recorded by hand: "Reverse" on a payment. PayFast refunds are made in the PayFast dashboard.
- **Invoices** are prepared manually. Terram tracks the request and stores the file.
- Order history sign-in uses a 6-digit email code, so it needs working email.
