# Get your own WhatsApp alert: step by step

Goal: someone fills the form on your website, and your phone gets a WhatsApp message
saying "New Turnly demo request: Asha (salon), +91..., Source: ...".

You need 4 free accounts: **GitHub**, **Neon** (database), **Meta** (WhatsApp), **Render** (puts it online).
Render costs about $7 a month (Starter plan). Everything else is free for this test.

Keep a notepad open. You will copy 8 values into it. They are marked with a pencil.

---
## Part 1. Put the code on GitHub
1. Go to github.com and log in.
2. Click **+** (top right), then **New repository**.
3. Name it `turnly`. Choose **Private**. Click **Create repository**.
4. Tell Claude: "My GitHub repo is YOUR-NAME/turnly". Claude uploads the code for you.

## Part 2. Make the database (Neon)
1. Go to neon.tech. Click **Sign up**. Use Google or GitHub.
2. Click **Create project**. Name: `turnly`. Region: **Asia Pacific (Singapore)**. Click **Create**.
3. You see a box called **Connection string**.
4. Find the switch **Connection pooling** and turn it **OFF**. (Important. The string must NOT have "-pooler" in it.)
5. Click **Copy snippet**.
   ✏️ Write down: `DATABASE_URL` = that long text starting with `postgresql://`

## Part 3. Make the WhatsApp test number (Meta)
1. Go to developers.facebook.com and log in with Facebook.
2. Click **My Apps**, then **Create App**.
3. Choose **Other**, then **Business**. Name it `Turnly`. Click **Create app**.
4. On the dashboard find **WhatsApp** and click **Set up**.
5. Left menu: **WhatsApp**, then **API Setup**.
6. You will see these. Write them down:
   ✏️ `PHONE_NUMBER_ID` = the number under "Phone number ID"
   ✏️ `WABA_ID` = the number under "WhatsApp Business Account ID"
   ✏️ `META_SYSTEM_USER_TOKEN` = click **Generate access token**, then copy it. (This one stops working after 24 hours. That is fine for the first test.)
7. In the **To** box click **Manage phone number list**, add YOUR phone number (with country code), and type the code Meta sends you on WhatsApp.
   ✏️ `OPERATOR_ALERT_PHONE` = your number like `+919876543210` (plus sign, country code, no spaces)
8. Top left menu: **App settings**, then **Basic**. Next to **App secret** click **Show**.
   ✏️ `META_APP_SECRET` = that text
9. Make up two passwords. Any words you like:
   ✏️ `META_VERIFY_TOKEN` = for example `turnly-verify-8472`
   ✏️ `ADMIN_TOKEN` = for example `my-admin-pass-2951`

## Part 4. Put it online (Render)
1. Go to render.com. Click **Get Started**. Log in with GitHub.
2. Click **New +**, then **Web Service**.
3. Pick your `turnly` repo. Click **Connect**.
4. Fill in:
   - **Name**: `turnly`
   - **Region**: Singapore
   - **Language / Runtime**: Docker
   - **Instance type**: Starter
5. Scroll to **Environment Variables**. Click **Add Environment Variable** for each line below, copying from your notepad:

| Name | Value |
|---|---|
| RUN_WORKER | 1 |
| DATABASE_URL | (from Part 2) |
| META_APP_SECRET | (from Part 3) |
| META_VERIFY_TOKEN | (your made-up word) |
| ADMIN_TOKEN | (your made-up password) |
| META_SYSTEM_USER_TOKEN | (from Part 3) |
| WABA_ID | (from Part 3) |
| PHONE_NUMBER_ID | (from Part 3) |
| OPERATOR_ALERT_PHONE | (your number with +) |

6. Click **Create Web Service**. Wait 3 to 5 minutes until it says **Live**.
7. At the top you see your address, like `https://turnly-ab12.onrender.com`.
   ✏️ Write it down. Open `YOUR-ADDRESS/healthz` in your browser. It should show `{"ok":true}`.
8. Open `YOUR-ADDRESS` itself. That is your real website with the real form.

## Part 5. Connect WhatsApp to your website (Meta again)
1. Back at developers.facebook.com, left menu: **WhatsApp**, then **Configuration**.
2. Under **Webhook** click **Edit**.
3. **Callback URL**: `YOUR-ADDRESS/webhook` (for example `https://turnly-ab12.onrender.com/webhook`).
4. **Verify token**: the same made-up word as META_VERIFY_TOKEN.
5. Click **Verify and save**. (If it fails, check step 4 and that Render says Live.)
6. Under **Webhook fields** click **Manage**. Find **messages** and click **Subscribe**.

## Part 6. Open the door, then test
WhatsApp only lets the test number message you if YOU messaged it in the last 24 hours.
1. On your phone open WhatsApp. Message the Meta test number (shown on the API Setup page) with: `hi`
2. Open `YOUR-ADDRESS` in your browser.
3. Fill the form. Use any name. Use any real-looking number (yours is fine). Tick the box. Click **Send me the demo**.
4. Within about 10 seconds your WhatsApp shows: **New Turnly demo request: ...** 🎉
5. See all leads: open `YOUR-ADDRESS/admin/leads?format=html&token=YOUR-ADMIN-TOKEN`

## If it does not work
- **No WhatsApp message**: do Part 6 step 1 again (send `hi`). The 24-hour door closes.
- **Verify and save fails**: the verify word does not match, or Render is not Live yet.
- **Render build fails**: tell Claude and paste the red error.
- **Token expired** (after 24 hours): Meta API Setup, **Generate access token**, paste it into Render under Environment as META_SYSTEM_USER_TOKEN, click **Save**.
- The welcome message to the person who filled the form will show "refused" for now. It needs Meta to approve our message template first. That is the next step after this test works.
