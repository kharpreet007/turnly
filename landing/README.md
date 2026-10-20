# Landing page

`index.html` was not available when the backend was built. To wire it:

1. Copy the page here as `landing/index.html`.
2. Include `lead-client.js` and call `TurnlyLead.submit(...)` where the page currently builds the `wa.me` link.
3. Send the fields the form already has: `business_type`, `name`, `country_code`, `phone`, `consent`,
   plus `consent_text` (the exact label text next to the checkbox), `wants`, `est_monthly_loss`.
4. Keep the existing result screen as the `fallback` path.
5. Add the privacy policy and terms pages before ads go live (PRD section 7.5).

The honeypot field is `website`; add a visually hidden `<input name="website" tabindex="-1" autocomplete="off">`
and pass its value through (the client sends an empty string by default).
