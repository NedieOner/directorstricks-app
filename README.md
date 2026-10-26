# Director Tricks Vault

Telegram Mini App + bot server for @directortricks_bot.

- `index.html`, `img/`: the Mini App (GitHub Pages). With `API` empty it shows demo data; with `API` set and opened from the bot it uses live data.
- `worker/`: the bot server (Cloudflare Workers + D1 database).

## What the server does
- Checks every Mini App request with the Telegram `initData` signature. Admins are the Telegram ids in `ADMIN_IDS` (worker/wrangler.toml).
- `/start ref_<username>` counts referrals; statuses Viewer 0, Insider 1, Crew 3, Director 5 friends.
- Sends files to users through the bot (files stay in Telegram).
- Telegram Stars payments (Pro 30 / 365 days, −15% for users in their first 3 days).
- Payment screenshots sent to the bot go to admins with Approve / Reject buttons.
- Messages from users are forwarded to admins; admins answer from Admin → Users.
- Reads new posts in source channels where the bot is admin (preview, caption, tags `#luts #f3 #pro`). A channel where the bot became admin before launch: forward any of its posts to the bot, or paste its @username in Admin → Sources.
- Editable tabs and filters, schedule (cron every 10 min publishes due drops), broadcasts.

## Deploy (Cloudflare dashboard, no command line)
1. Create a free account at cloudflare.com.
2. Storage & Databases → D1 → Create → name `directortricks`. Put its Database ID into `worker/wrangler.toml`.
3. Workers & Pages → Create → Import a repository → this repo → Root directory `worker` → Deploy.
4. Worker → Settings → Variables and Secrets → add as **Secret**: `BOT_TOKEN` (from @BotFather), `WEBHOOK_SECRET` (random text), `SETUP_KEY` (random text).
5. Open `https://<worker address>/setup?key=<SETUP_KEY>` once. It registers the webhook and the menu button.
6. Put the worker address into `const API=""` in `index.html`.

## Security
- Never commit the bot token or the secrets above.
- Admin rights are checked on the server only; the browser list in `index.html` just shows or hides the tab.
