# Launching Terram Butchery OS — step by step

This guide gets the app online so that your Mac, your parents' Windows computers and everyone's iPhones all show the same orders. Plan on about an hour, most of it waiting for things to finish.

**How it works:** the app runs on one small server in the cloud. Every device opens it like a website and installs it to the Home Screen or Dock, so there's nothing to download from an app store. Mac and Windows make no difference; Safari, Chrome and Edge all work.

---

## 1. Accounts you need (15 minutes)

| What | Why | Cost (check current prices when you sign up) |
|---|---|---|
| **GitHub** (you already have one) | Where the code lives | Free |
| **Render** — render.com, "Sign in with GitHub" | Runs the server and keeps the database on a disk | Starter web service (about $7/month) plus a 1 GB disk (cents per month). The free plan can't be used because it has no permanent disk. |
| **Anthropic** — console.anthropic.com *(optional, can be added later)* | The assistant that reads messy messages | Pay per use. The rules engine handles clear orders for free and only messy messages use the assistant, so a small butchery should spend a few dollars a month. **Set a monthly spend limit in the console.** |

## 2. Get the code ready (2 minutes)

The code is on the branch `claude/terram-farm-butchery-os-n3ng2e`. Either merge it into `main` on GitHub (ask Claude to open a pull request, then click **Merge**), or pick that branch in Render in the next step.

## 3. Create the server on Render (10 minutes, then about 5 minutes waiting)

1. In Render: **New → Blueprint**, choose the `terram-butchery-os` repository (and the branch from step 2).
2. Render reads `render.yaml` and asks for four values:
   - `INITIAL_ADMIN_NAME`: your name (e.g. *Dylan*)
   - `INITIAL_ADMIN_EMAIL`: your email
   - `INITIAL_ADMIN_PASSWORD`: a strong password (8+ characters). Keep it in your password manager.
   - `ANTHROPIC_API_KEY`: paste the key from console.anthropic.com, or leave it empty for now.
3. Click **Apply**. The first build takes a few minutes. When the status turns **Live**, Render shows an address like `https://terram-butchery.onrender.com`. That address is your app.

> **The API key goes here, once, on the server.** Never put it on phones or laptops, and never send it around by message. Every device uses it through the server automatically. To change it later: Render → your service → **Environment**.

*Optional:* a nicer address such as `orders.terramfarm.co.za` can be added in Render → Settings → Custom Domains. It needs a DNS record at whoever manages your domain.

## 4. Set it up on your Mac (20 minutes)

1. Open the Render address in Safari or Chrome and sign in with the email and password from step 3.
2. **Settings → Business**: check the name, phone (+27 79 889 5569 is filled in), email, address and time zone (Africa/Johannesburg).
   Your **brand kit is already built in**: the Terram Farm logo, Terram green (#446041), charcoal and white, and a bold heading font close to Garet. The Home Screen icon is the white logo on charcoal, like your price lists. You only need **Settings → Branding** if you want to change them.
3. **Settings → Orders & fulfilment**: tick your collection days and delivery days and set collection hours.
4. **Products** already holds your Beef and Lamb price lists (June 2026) plus trays of eggs: 43 products at your prices, grouped like the printed lists. When prices change, use **Products → Update prices**: paste the new list in any format (e.g. `Rump R195`). You'll see old → new for every product; tick and confirm.
   Words that could mean two products ("mince", "biltong", "chops", "ribs", "shoulder") are left for a person to choose, so the app never guesses. After the family picks the same answer a couple of times, Intelligence suggests making it automatic. You can also add words yourself on a product ("Also called").
5. **Settings → Team**:
   - **Set a family code**, e.g. a short phrase like *red barn mince*. Write it down; it isn't shown again.
   - **Add person** for Mom, Dad and anyone else. Give them a name and role (Manager for your parents, Staff for helpers) and leave "Can sign in with the family code" on. No email is needed.
6. Try it: **Settings → Test mode → Load sample data**. Paste some real WhatsApp orders into **Paste orders**, walk an order through Cutting → Packing → Fulfilment, and print a cutting sheet. When you're happy, **Remove sample data**. Your real orders are untouched.

## 5. Put it on everyone's devices (5 minutes each)

Open **Add a device** (the phone icon next to your name, or Menu → *Add Terram to another phone or computer*). It shows a QR code and instructions for each type of device.

- **iPhone:** scan the QR code with the camera (or open the link in **Safari**), tap **Share → Add to Home Screen**, open Terram from the new icon, type the family code and tap your name.
- **Windows (your parents):** open the link in **Edge**, then **… → Apps → Install this site as an app**, and tick *Pin to taskbar*. Then family code, then name.
- **Mac:** Safari **File → Add to Dock**, or the Chrome install icon in the address bar.

Each device stays signed in for about six months. If a phone is lost: **Settings → Team → Sign out other devices**.

## 6. Everyday use (show the family)

- **An order comes in on WhatsApp:** press and hold the message → **Copy** → Terram → **+** → **Paste orders** → **Read messages** → check → **Confirm**.
  - *A customer messages you directly* ("please can I have…", no name): choose the customer under **From** before tapping Read messages.
  - *Your group chat* (the order with the customer's name at the bottom): copy one or many posts and paste them. The app takes the name from the bottom of each post, not from whoever posted it. A phone number next to the name is saved too.
- **Phone call / walk-in:** **+** → **Type an order**.
- **Needs attention** (red badge): questions the system won't guess, such as unknown products, "which steak?" or possible duplicates. One tap each.
- **Cutting**: what to cut, added up by product, with "who needs what" underneath. Tap **Done** per line. **Print sheet** for the block.
- **Packing**: tick each item, then **Packed**. Print packing slips or order dockets if you like paper.
- **Fulfilment**: **Tell customer** (opens WhatsApp with a ready message), then **Collected** or **Delivered**.
- Customers can also order themselves from `your-address/order` (Settings → Customer form has the link).

### Replacing the old order form

The old form (dylanmetcalf.github.io/terramfarm-order-form) opens the customer's email app, because a web page on its own can't send email. The app's form at `your-address/order` has the same products, prices, sections and order terms, and **Send order** puts the order straight into Terram as a "To review" order, with no email step. Once the app is live, point customers to the new link. You can also ask Claude to make the old address forward to it automatically, so links you've already shared keep working.

## 7. Keeping it safe

- The server makes a **backup every night** and keeps the last 14 (shown under Settings → Data & backup and in Intelligence → System health).
- Once a week, click **Download full backup** (Settings → Data & backup) and keep the file on your Mac or in iCloud or Google Drive. That's your copy if the server ever disappears.
- Render redeploys automatically when the code changes on the branch. Your data lives on the disk and isn't touched by redeploys.

## If something goes wrong

- **"Can't reach Terram"**: check the internet connection, then the service status in the Render dashboard.
- **Forgot the admin password**: in Render → your service → **Shell**, run `npm run create-admin -- "Dylan" you@example.com 'new-password'`, then click **Restart service**.
- **Anything odd**: Intelligence → System health lists technical problems in plain language.
