# Director Tricks Vault

Telegram Mini App for @directorstricks (stage 1: front end with sample data, hosted on GitHub Pages).

## Setup
1. Settings → Pages → Deploy from a branch → `main` / root.
2. @BotFather → your bot → Bot Settings → Configure Mini App → paste `https://nedieoner.github.io/directorstricks-app/`. Same URL for Menu Button.
3. Admin for testing: put your Telegram user id into `ADMIN_IDS` in `index.html`.

## Security
- Never commit the bot token. It lives only as a server secret (stage 2).
- The browser-side admin check is for testing. Stage 2 (Cloudflare Workers) validates Telegram `initData` on the server and keeps the admin id list there.
- Data here is sample data stored in the viewer's browser.
