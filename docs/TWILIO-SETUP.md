# WhatsApp alerts with the Twilio sandbox

1. twilio.com: sign up (free trial), verify email and phone.
2. Console > Messaging > Try it out > Send a WhatsApp message. Note the sandbox number and join code.
3. From your phone, WhatsApp `join <your-code>` to the sandbox number.
4. Console home: copy Account SID and Auth Token (keep private).
5. Railway Variables:
   - delete WA_MODE
   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
   - TWILIO_WHATSAPP_FROM = whatsapp:+14155238886 (use the number your sandbox page shows)
   - PHONE_NUMBER_ID = TWILIO   (replaces MOCK_PNID)
   - PUBLIC_BASE_URL = https://turnly-production-21ee.up.railway.app   (no trailing slash)
   - TRUST_TEMPLATES = 1        (sandbox only)
   - OPERATOR_ALERT_PHONE = your number, e.g. +919876543210
6. Twilio sandbox settings:
   - When a message comes in: PUBLIC_BASE_URL/twilio/webhook  (POST)
   - Status callback URL: PUBLIC_BASE_URL/twilio/status       (POST)
7. Submit a lead on the website. Your WhatsApp gets "New Turnly demo request: ...".

Limits: only phones that sent the join code can be messaged; the join lapses after about 3 days;
business-started messages outside 24h of the person's last message need a Twilio Content template
(set TWILIO_CONTENT_SIDS) or a real, approved sender.

## If Twilio answers "21654: ContentSid Required"
The sandbox may refuse plain text. Set TWILIO_FALLBACK_CONTENT_SID to the sandbox's pre-approved template:
Console > Messaging > Try it out > Send a WhatsApp message > "API" tab > copy the value after ContentSid (starts with HX).
The alert text is then sent as the template's first variable.
