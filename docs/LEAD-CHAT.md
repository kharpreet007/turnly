# Lead chat (Turnly's own funnel)

After the form, the lead gets the welcome (template `turnly_demo_welcome`), then answers numbered questions:

1. Packages or services?  ->  2a. Reply / Remind / Return   or   2b. Set up my WhatsApp / Support / Something else
3. What kind of business do you run? (8 options)
4. When should our team call you? Morning / Afternoon / Evening
5. Close: "Thanks, <name>. Our team will reach you in the <time>."

- Two unclear answers in a row hand the lead to a person ("needs a human"); the bot then stays quiet.
- Answers are saved on the lead (`leads.answers`), shown in the lead list "Chat" column, in the CSV, and in
  Google Sheet columns N to Q (Interest, Detail, Business (chat), Best time to call), updated within a minute.
- When a chat ends (or needs a human) the owner gets one WhatsApp alert.
- STOP ends everything immediately.
- Options are numbered text so it works on any provider. Real tappable buttons need an approved
  quick-reply template for the first message; later questions can use buttons once the real number is live.

Changing the wording: packages/core/src/leadFlow.ts (STEPS and welcomeText).
If the welcome template body changes after Meta approved it, submit it again under a new name.
