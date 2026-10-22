# Terram customer ordering platform — setup and operations

This covers the customer ordering platform: catalogue rules, the order form, confirmation, the customer order page, order history, payments (EFT and PayFast), invoice requests, suggested changes, emails, reminders and feedback. It sits on the same order system as the rest of Terram. There is one catalogue, one order record and one status per order.

## The order journey

1. **Customer orders** at `/order`. They see sizes (e.g. 500 g / 1 kg mince packs), variations (rib-eye on/off the bone) and any surcharges (dry-aged +25%). On "Check & send", the server prices the basket again with today's catalogue. If anything changed, the customer sees it before sending.
2. **Order received**: the customer gets the "received" email and a link to their order page. Staff get an alert. The order is **not** confirmed yet.
3. **Staff confirm**: on the order page, **Confirm order** asks for the expected timeframe (and collection/delivery if not set). Confirming is blocked while there are problems (no items, unpriced lines, open questions, unanswered changes, missing address). Confirming twice does nothing.
4. **Suggested changes**: if something can't be supplied, use **Suggest a change**. The customer accepts or declines on their order page. Nothing changes until they accept.
5. **Preparation → packed**: enter the packed weight of weighed items (the scale button on each line). That sets the final price.
6. **Ready → payment request**: with *Payments → "When ready"*, marking the order ready emails the customer a payment request. This only happens once the final amount is known, nothing is waiting on the customer, and a payment method is available. Otherwise the order shows why.
7. **Payment**:
   - **EFT**: the customer sees the banking details and uploads proof. **Proof does not mark the order paid.** Staff check the bank, then **Check & verify** (or reject with a reason the customer sees).
   - **PayFast**: the order is marked paid only when PayFast's server notice (ITN) passes all checks: signature, merchant, amount, source IP and server-to-server validation. The browser coming back from PayFast never marks anything paid.
   - Cash, card machine or other payments can be recorded by a manager ("Record a payment received").
   - Receipts are on the customer's order page.
8. **Invoice** (only if requested): staff prepare it by hand in the accounting software, then **Mark issued** or **Mark sent** with the real invoice number and date, optionally attaching the PDF. There is no automatic invoice generation and no Xero link.
9. **Completed**: the customer can leave optional feedback and **Reorder**. Reorder loads a new draft basket at today's prices; the customer reviews and sends it. Nothing is ordered automatically.
10. **Reorder reminders** (optional): sent only to customers who ticked the reminder box, about 14 days after completion (configurable). Each customer gets one per order, and none if they've ordered again since. Every reminder has an unsubscribe link.

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

## Banking details (EFT)

*Settings → Payments & banking* (admins only). Fill in the account holder, bank, account number and branch code, then switch on **Accept EFT**. Notes:

- EFT can't be switched on while a required field is blank.
- No banking details are built in or invented.
- Managers see only the last 4 digits of the account number, and the audit log stores it masked.
- Customers see the banking details only on their own order page, and only once a payment is requested.
- The payment reference is always the order number.

## PayFast setup

1. Create a sandbox account at sandbox.payfast.co.za. Copy the sandbox merchant ID and key, and set a passphrase.
2. Set `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY` and `PAYFAST_PASSPHRASE` on Render; leave `PAYFAST_MODE` unset (sandbox). Redeploy.
3. In *Settings → Payments & banking*, switch on **Accept online payment** (it only works once the server variables are present).
4. The notify (ITN) URL is sent with each payment automatically: `https://www.terramfarm.co.za/api/integrations/payfast/notify`. The site must be reachable over https for PayFast to call it.
5. Test with a small sandbox payment and check the order shows **Paid** with a receipt. Then switch to live: the live merchant ID, key and passphrase, plus `PAYFAST_MODE=live`.

## How to test

- `npm test` runs the API/unit tests. Email goes to an in-memory outbox and PayFast is mocked, including a real signature vector from PayFast's own SDK.
- `npm run build && bash scripts/qa-server.sh` starts a throwaway server on :8092 with sample data. Then:
  - `node scripts/journey.mjs` runs the whole customer journey in a browser: phone ordering and search, received, confirm with a timeframe, a change the customer accepts, weighing, ready, payment request, EFT proof, staff verification, receipt, invoice, completion, feedback, reorder.
  - `node scripts/e2e.mjs` covers staff import, cutting, packing and fulfilment.
  - `node scripts/overflow-all.mjs` checks every screen at phone, tablet and desktop widths.

## Known limitations

- **WhatsApp/SMS** notifications are not connected. The notification service has the channel slots, but only email sends.
- **PayFast** is tested against PayFast's documented signature rules and a mocked ITN, not against a live PayFast account. Do a sandbox payment before going live.
- **Refunds** are recorded by hand: "Reverse" on a payment. PayFast refunds are made in the PayFast dashboard.
- **Invoices** are prepared manually. Terram tracks the request and stores the file.
- Order history sign-in uses a 6-digit email code, so it needs working email.
