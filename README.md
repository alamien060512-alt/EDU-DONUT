# EDU-DONUT

An educational attempt to make a bot that works on a **Minecraft Bedrock** account: it signs in with a
Microsoft/Xbox account, joins a server, runs commands from your console, performs automatic actions, and
writes an XLSX trade log.

> ## I DO NOT SUPPORT BOTTING
> This code is my attempt to learn and see how bots work with Bedrock accounts: running commands from the
> console and automatic actions. Automated play can break a server's rules and get an account banned.
> Do not use it where bots are not allowed. You use it entirely at your own risk.

## What works

- [x] Bot signs in with a Microsoft account
- [x] Bot joins the server
- [x] Bot runs commands from the console
- [x] Bot performs automatic actions (finds a listing, buys it, relists it)
- [x] Bot creates an XLSX file (trade log with profit vs cost, rebuilt after every trade)
- [x] Local price website (prices, history charts, rules) with a built-in terminal for bot commands and the live log
- [x] Item pictures next to every name, rendered with [RenderChest](https://github.com/aternosorg/renderchest)
- [x] Top orders tab: the highest buy-order price per item from the order house
- [x] Personal portfolio on the website (items, how many you own, profit/loss, price alerts), saved separately in each browser
- [x] Safe remote access (team password login, optional public price pages, view-only by default, works over Tailscale (optionally with a DuckDNS name for it), a Cloudflare Tunnel, or a public DuckDNS address with automatic https through Caddy)

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer and [Git](https://git-scm.com).

```
git clone https://github.com/alamien060512-alt/EDU-DONUT
cd EDU-DONUT
npm install
npm run bot
```

On the first run the bot prints a `microsoft.com/link` code; open the link and sign in. The login is saved
in `data/`. The bot starts in **dry run** (it logs what it would do and spends nothing).

**Full instructions, every command and troubleshooting: [HOW-TO-USE.md](HOW-TO-USE.md).**

## What it does

| Part | File | What it does |
|---|---|---|
| Login and connection | `bot/index.js`, `bot/*-patch.js` | Microsoft/Xbox sign-in and a Bedrock connection built on [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol), with fixes for a modern server |
| Console | `bot/index.js` | Type commands at the `bot>` prompt, e.g. `cmd /bal` or `buy diamond 12k sell 15k` |
| Auction house | `bot/ah.js`, `bot/strategy.js` | Reads listings from the in-game GUI, clicks, confirms, relists |
| Trade log | `bot/ledger.js` | Writes `data/profit-vs-cost.xlsx`, `data/trades.csv`, `data/trades.json` |
| Price website | `bot/market.js`, `web/index.html` | Local site at http://127.0.0.1:8080 showing prices and history |

Run the offline tests with `npm test`. They check the logic (ordering, encryption, inventory, ledger, market)
without connecting to any server.

## Privacy and safety

- The `data/` folder holds your **Xbox login tokens**. Never share it, and never commit it. It is already in `.gitignore`.
- The website and API only listen on your own computer (127.0.0.1) unless you set a password to use them remotely
  (see [HOW-TO-USE.md](HOW-TO-USE.md), section 9). Remote use is view-only by default, and sending commands to the API
  requires a header that other websites cannot add.
- Live trading spends real in-game money. Start with small limits.

## Credits and licence

- Idea inspired by [cody-raves/Gonuts](https://github.com/cody-raves/Gonuts) (MIT), a Java-edition mod. No code was copied.
- Item pictures are rendered with [RenderChest](https://github.com/aternosorg/renderchest) (MIT) from Minecraft's assets; they are Mojang's artwork and stay on your computer.
- Built on [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol), [prismarine-auth](https://github.com/PrismarineJS/prismarine-auth) and [ExcelJS](https://github.com/exceljs/exceljs).
- Not affiliated with Mojang, Microsoft or any server.
- Released under the [MIT License](LICENSE).
