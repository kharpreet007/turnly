# Live Google Sheet: every new lead becomes a row

You need: a Google account. Everything here is free.

## Part A. Make the sheet
1. Go to sheets.google.com. Click **Blank spreadsheet**.
2. Name it `Turnly Leads` (top left).
3. At the bottom, rename the tab from `Sheet1` to `Leads` (double-click the tab name). Spelling and capital L matter.
4. Look at the address bar. It looks like `https://docs.google.com/spreadsheets/d/LONG-TEXT-HERE/edit`.
   Write down LONG-TEXT-HERE: that is `GOOGLE_SHEET_ID`.

## Part B. Make a robot account that is allowed to write to the sheet
1. Go to console.cloud.google.com and log in. Accept the terms if asked.
2. Top left, click the project dropdown, then **New project**. Name `turnly`. Click **Create**. Make sure `turnly` is selected at the top.
3. Search bar at the top: type `Google Sheets API`, click it, click **Enable**.
4. Left menu: **IAM & Admin**, then **Service accounts**. Click **Create service account**.
5. Name `turnly-sheets`. Click **Create and continue**, then **Done** (no roles needed).
6. Click the new account in the list. Open the **Keys** tab. Click **Add key**, then **Create new key**, choose **JSON**, click **Create**. A file downloads. Keep it private.
7. On the same page, copy the account's email. It looks like `turnly-sheets@turnly-123456.iam.gserviceaccount.com`.

## Part C. Let the robot into your sheet
1. Open your `Turnly Leads` sheet. Click **Share** (top right).
2. Paste the robot email. Set it to **Editor**. Untick "Notify". Click **Share**.

## Part D. Give the settings to Railway
Open the downloaded JSON file in a text editor (Notepad, TextEdit). Select everything and copy.
In Railway, open your service, **Variables**, and add:

| Name | Value |
|---|---|
| GOOGLE_SERVICE_ACCOUNT_JSON | paste the whole file text |
| GOOGLE_SHEET_ID | the long text from Part A |
| GOOGLE_SHEET_TAB | Leads |

Railway redeploys by itself.

## Test
Submit the form on your website. Within a few seconds a new row appears in the sheet.
The first row gets column titles automatically.
Use the **Status** and **Notes** columns to track your follow-up. We never overwrite them.

## If no row appears
- Share the sheet with the robot email as **Editor** (Part C).
- Tab name must be exactly `Leads` (or change GOOGLE_SHEET_TAB to match).
- In Railway, open **Deployments**, then **View logs**, and look for a line mentioning `Google Sheets`. A 403 means the sheet is not shared with the robot. A 404 means the sheet ID is wrong.
- If the variable will not save, ask Claude for the one-line base64 version of the file.
