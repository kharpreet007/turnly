# Email alerts

Every new lead, and every finished or stuck lead chat, is emailed to ALERT_EMAIL (comma-separate several).

1. resend.com: sign up with the address that should get the alerts. API Keys > Create API Key (sending access). Copy it.
2. Railway Variables: RESEND_API_KEY = the key, ALERT_EMAIL = your email. Deploy.
3. The status page shows "Email alerts: on, to x•••@...". Submit a test lead; the email arrives within a minute.

The default sender onboarding@resend.dev can only deliver to the email you signed up to Resend with.
To send to other addresses, verify your own domain in Resend and set EMAIL_FROM.
