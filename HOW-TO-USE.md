# DonutSMP Bedrock Auction Bot: how to use

An educational headless bot that logs in with your Microsoft/Xbox (Bedrock) account, watches the DonutSMP auction house,
buys items under your price, relists them for more, records every trade in a spreadsheet, and serves a
price website.

> **Risk notice.** The bot spends real in-game money when it is in LIVE mode. Automated trading may break
> DonutSMP's rules. Start with small limits and use it at your own risk.

---

## 1. Install (once)

You need a computer (Windows, Mac or Linux). A phone/Termux is not recommended.

1. Install **Node.js LTS** (20 or newer) from <https://nodejs.org> and **Git** from <https://git-scm.com>.
2. Open Command Prompt (Windows) or a terminal and run:

```
git clone -b main https://github.com/alamien060512-alt/EDU-DONUT
cd EDU-DONUT
npm install
```

## 2. Update (every time there is a new version)

Run this inside the bot folder:

```
git pull
```

- If it says local changes to `package-lock.json` block it, run `git checkout package-lock.json` and pull again.
- If the update notes say so, also run `npm install` (needed when a new library was added).
- Your login and trades live in the `data` folder, which git never touches, so updating does not log you out.

## 3. Start the bot

```
npm run bot
```

- First run: it prints a `microsoft.com/link` code. Open the link, enter the code and sign in with your
  Bedrock/Xbox Microsoft account. The login is saved in `data/auth`, so you only do this once.
- Wait for these lines: `authenticated with Xbox`, `sent login`, `joined server`, `spawned`.
- You now see a `bot>` prompt. Type commands there.
- Stop the bot with `Ctrl+C` (press `Y` if Windows asks "Terminate batch job").

The bot starts in **DRY RUN**: it only logs what it would buy and spends nothing.

---

## 4. Set what to buy and sell

At the `bot>` prompt (prices are **per item**; `k` = thousand, `m` = million, `b` = billion):

```
buy diamond 12k sell 15k
```

Meaning: buy plain `diamond` listings at **12k or less each**, then relist each one for **15k each**.

Other forms:

| Command | Meaning |
|---|---|
| `buy diamond 12k sell 15k` | buy at 12k or less, relist at a fixed 15k each |
| `buy diamond 12k 1.3` | relist at 1.3x what you paid |
| `buy diamond 12k` | relist at 2x what you paid (default) |
| `rules` | show your active rules |
| `drop diamond` | remove the rule for diamond |

Item names are Minecraft names in lowercase with underscores: `diamond`, `netherite_ingot`,
`totem_of_undying`, `ender_pearl`, `elytra`.

**Rules that keep you safe**

- Only plain, un-enchanted items are bought.
- The item name must match exactly (`diamond` will not buy a Diamond Pickaxe).
- Displayed prices are rounded: a listing shown as `11K` really cost 11,099. Keep a margin
  between your buy limit and your sell price.
- Check the price table (section 8) first, so your sell price is one the item really sells at.

## 5. Go live

```
limit 5          stop buying once 5 listings are active
listed 2         tell the bot how many listings you already have (it forgets on restart)
live on          start really buying and relisting
live off         back to dry run
```

What happens on each buy (automatic):

1. It reads your balance, opens `/ah <item>`, picks the cheapest matching listing under your price.
2. Clicks the listing, checks the confirm menu shows the right item and price, then clicks **Confirm**.
3. Reads your balance again to verify how much was spent.
4. Puts the item in hand and runs `/ah sell <price>`, then clicks Confirm in the sell menu.
5. Records the trade in the spreadsheet. When chat says `<name> bought your <item> for $...`, the trade
   is marked sold.

Buying pauses by itself when `limit` is reached, or when the server says the auction house is full.
Type `resume` to continue, `pause` to stop buying.

If the log says `no listing at or under ... (gone, or sold to someone else)`, another player was faster.
Nothing was charged; this is normal for popular items.

## 6. All commands

| Command | What it does |
|---|---|
| `help` | list commands |
| `status` | connected, live or dry run, money spent, listings, paused |
| `buy <item> <max> [sell <price> \| <multiple>]` | add or change a buy rule |
| `rules` / `drop <item>` | show / remove rules |
| `limit <n>` | max active listings (0 = no limit) |
| `listed <n>` | set the current listing count |
| `pause` / `resume` | stop / continue buying |
| `live on` / `live off` | real trading / dry run |
| `scan` | check the auction house now (it also scans every 15 s) |
| `buynow <item> <max> yes` | really buy the cheapest plain listing once |
| `sellnow <hotbarSlot> <price> yes` | list the item in that hotbar slot (see `inv`) |
| `inv` | show the bot's inventory slots |
| `peek <item>` | print the first listings of `/ah <item>` with parsed prices |
| `cmd /bal` | send any in-game command (replies show in the log) |
| `trades` | totals and where the spreadsheet is |
| `fee <percent>` | set a sale fee for the spreadsheet (default 0) |
| `market scan [item]` | update prices right now: one item (waits for the answer) or the whole watchlist (background) |
| `market on\|off` | start / stop the price scanner |
| `orders` / `orders scan` / `orders on\|off` | status / read the whole order house now (in the background) / start or stop the order reader |
| `icons` | where the bot found the item pictures, and how many |
| `peekorders` | print every tile of the `/orders` screen and how the bot read it (read-only) |
| `watch`, `watch add <item>`, `watch remove <item>` | the list of items the price scanner tracks |
| `quit` | exit |

`buynow` and `sellnow` need the word `yes` because they act immediately.
`inspectbuy <item> yes` clicks the cheapest listing and shows what opens; with confirmations off it buys.

---

## 7. Spreadsheet (automatic)

Every buy, relist and sale is written to the `data` folder inside the bot folder:

- `data/profit-vs-cost.xlsx`: Summary and Trades sheets with formulas, rebuilt after every change
- `data/trades.csv` and `data/trades.json`: plain copies

The Summary shows total spent, realized profit, money tied up in listings, expected profit if they sell,
and a balance check against your real `/bal` readings. Close the `.xlsx` in Excel if the bot says it cannot
update it. Use `fee 5` if you find the server takes a 5% sale fee.

## 8. Price website

While the bot runs, open **<http://127.0.0.1:8080>** in your browser.

- Table of tracked items: lowest price, average of the 5 cheapest, listings seen, 24h change, trend, updated.
- Click an item for a price history chart, and to set or remove a bot rule with a form.
- Cards show realized profit, money in listings and bot status.
- "Add" tracks another item. "Pause scanning" stops the price checks.

The bot searches each watched item in `/ah` (about 70 by default, one every 7 seconds). With
`DONUTSMP_API_KEY` set (get one in game with `/api`) it reads many pages of the official listings instead,
which covers more items. The site only works while the bot runs. By default only your own computer can open it; to use it from your phone away
from home see section 9.

**Top orders.** The **Top orders** tab shows, for each item, the highest price a buyer is offering right now
(DonutSMP's order house, "buy orders"). For example `Elytra $700M`, `Gilded Blackstone $4M`. Everyone sees it, signed in or not.

- Columns: top order price each, how many orders were seen, how many items buyers still want, the 24h change and a trend line.
  Click a row to open that item's market details, which also show its top buy order.
- Every item that has an order gets a row. When sorted by price the first pages are almost all the same few pricey items
  (elytra...), so the bot reads **every page** of the order house and keeps the highest price it sees per item.
- How it is collected: shortly after the bot joins, then again 5 minutes after each full read, it opens `/orders`, switches the
  sort to **Most Per Item** and goes through all the pages (a minute or two; the tab shows "reading page N" while it works,
  and fills in as it goes, then "next read in N min"). It is **read-only**: it only clicks the sort button and the next-page
  arrow, never an order. It gives way to trading: whenever a buy or another job is waiting for the auction house, the read
  pauses after about 20 seconds, lets that job run, and carries on from the same page.
- **Update orders now** (team login) or `orders scan` reads the whole order house straight away, in the background.
- Rows not seen in the latest full read for 2 hours are dimmed, because that order may be gone.
- Commands: `orders scan` (read now), `orders on` / `orders off`, `orders` (status), and `peekorders` (prints every tile on
  the order screen and what the bot understood from it).
- **First time:** the order screen's layout was copied from how the Java client reads it, and I could not test it on the
  live Bedrock server. Start the bot, run `peekorders`, and check that orders show a `"order": { "unit": ... }` price. If
  they do not, send me the output and I will adjust. The tab says "No order data yet" until the first read works.
- Settings: `ORDERS=0` turns it off, `ORDERS_MS` (default 300000 = 5 min) is the time between full reads, `ORDERS_PAGES` (default 250) the most pages per read,
  `ORDERS_SECONDS` (default 420) the longest one read may take. Run `orders scan` to read it now.

**Item pictures.** The website can show a small picture next to every item name (Market, Top orders, portfolio, details). The
pictures are made with [RenderChest](https://github.com/aternosorg/renderchest) from Minecraft's own assets, so they are
Mojang's artwork: use them yourself, do not upload or share them (the `data` folder is git-ignored). There are two ways:

1. **Unzip a ready-made pack** into the bot folder so that the pictures end up in `data\icons` (the file is
   `minecraft-icons-26.3.zip`; right-click, Extract All, into the `EDU-DONUT` folder). Just refresh the page.
   The bot looks a few folders down, so it also finds them if Windows put them in a `minecraft-icons-26.3` sub-folder.
   Type `icons` in the terminal to see which folder it found. The website shows a hint until the pictures are found.
2. **Make them yourself** (any Minecraft version, or with a resource pack) with `tools/make-icons.sh`. It needs PHP 8.1+ with the
   imagick extension, composer, git, curl, unzip and node, so on Windows run it inside WSL. It downloads the Minecraft client
   from Mojang, renders every item (about a minute) and fills `data/icons`:
```
tools/make-icons.sh
MC_VERSION=1.21.4 tools/make-icons.sh
```

Without pictures the page works the same, just without them.

**My portfolio.** The **My portfolio** tab (next to **Market**) lets each person follow the items they care about:

1. Type an item (pick from the list), **how many** you own (0 = just watch it), and optionally what you **paid each**,
   and an **alert** price (at or above / at or below). Press **Add**.
2. The table shows each item's current lowest price, its value, your profit or loss and the 24h change. The cards at the top
   add it all up. Items with a price alert show a badge and pop up a message when the price crosses your target
   (**Enable alert notifications** also shows a browser notification while the page is open).
3. **Edit** and **Remove** change or delete an item. Clicking an item's name opens it in the Market tab.
4. **Export** saves your portfolio as a file and **Import** loads one, which is how you move it to another device.

The portfolio is saved **only in that browser on that device**. Your phone, your laptop and a teammate's computer each have
their own separate portfolio, nothing is sent to the bot, and people who are not signed in can use it too.
(A website cannot tell devices apart by their hardware, so "per device" means per browser. A private window or cleared
site data starts empty.) An item the bot is not tracking yet shows "no price yet"; add it to the bot's watchlist with
`watch add <item>`.

**Built-in terminal.** At the bottom of the page (or click **Terminal** at the top) is a terminal. Type any command from
section 6 and press Enter, exactly as you would at the `bot>` prompt in Command Prompt:

- `Up` / `Down` brings back earlier commands, `Tab` completes a command, `clear` clears the screen.
- The bot's live log scrolls by in the same window; untick "show bot log" to hide it.
- Risky commands (`live on`, `buynow`, `sellnow`, `inspectbuy`) ask "Run it?" first.
- `quit` does not work from the website, so nobody can stop the bot remotely. Stop it at the PC with `Ctrl+C`.
- It works from your own PC without a login. Remotely it needs the **team** login with `BOT_REMOTE_CONTROL=1`; a viewer login
  sees the log but cannot type, and visitors who are not signed in do not see the terminal at all.

Other pages: `/market`, `/market/<item>`, `/trades`, `/status`, `/rules`, `/log`, `/holdings`, `/prices`.
Sending commands to `POST /command` needs the header `X-Bot: 1`.

---

## 9. Use it away from home (phone, mobile data)

The bot and the website run on your PC, so the PC must stay on with the bot running. The bot's own connection to
the game does not care where **you** are; only the website needs a way to be reached from outside.
**Never port-forward the bot on your router.** The bot can spend money, so it must not be open to the whole internet.
Use one of these two safe ways:

**Option A: Tailscale (recommended, free and private)**

1. Install Tailscale on the PC and on your phone (<https://tailscale.com>) and sign in to the same account on both.
2. On the PC run `tailscale ip -4`. It prints an address like `100.64.1.2`.
3. Start the bot with a password and that address. Windows Command Prompt:

```
set BOT_HOST=100.64.1.2
set BOT_PASSWORD=choose-a-long-unique-password
npm run bot
```

4. On the phone (Tailscale switched on) open `http://100.64.1.2:8080` and log in.

Only devices on your own Tailscale account can even reach that address, and the traffic is encrypted.

**Option B: Cloudflare Tunnel (a normal https link)**

```
set BOT_PASSWORD=choose-a-long-unique-password
npm run bot
```

In a second Command Prompt window run `cloudflared tunnel --url http://127.0.0.1:8080` (install
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) first). It prints an
`https://something.trycloudflare.com` link; open it on your phone and log in. Anyone who has the link sees the login page,
so use a long unique password and close the tunnel when you are not using it.

**Option C: your own DuckDNS address, with no port in it**

DuckDNS only points a name at your home address; it cannot hide the port. To open `https://yourname.duckdns.org` with no
`:8080`, the site has to be on the standard web ports (443 for https, 80 for the certificate check). Do **not** just set
`BOT_API_PORT=80`: that is plain http, so your password would cross the internet unencrypted. Use **Caddy**, a small program
that sits in front of the bot, gets a free https certificate for your DuckDNS name by itself and renews it:

1. Keep your DuckDNS name updated (the DuckDNS updater you already use) so it points at your home address.
2. Install Caddy: in Command Prompt run `winget install CaddyServer.Caddy` (or download it from <https://caddyserver.com/download>).
3. In the bot folder copy `tools\Caddyfile.example` to a file named `Caddyfile` (no extension) and replace `YOURNAME` with your
   DuckDNS name. It only has three lines:
```
yourname.duckdns.org {
	reverse_proxy 127.0.0.1:8080
}
```
4. On your router forward **TCP 443 and TCP 80** to this PC. Allow Caddy through Windows Firewall when it asks.
5. Start the bot **with a password**, leaving the bot's own address alone (do not set `BOT_HOST`; Caddy talks to it locally):
```
set BOT_PASSWORD=long-team-password
set BOT_PUBLIC=1
set BOT_COOKIE_SECURE=1
npm run bot
```
6. In a second Command Prompt window, in the bot folder: `caddy run --config Caddyfile`. The first start takes a few seconds to
   get the certificate. Then open `https://yourname.duckdns.org` from anywhere. No port.

Notes: this opens your router to the internet, so keep the password long and unique, leave `BOT_REMOTE_CONTROL` off unless you
need it, and turn Caddy off when you do not need the site. The bot refuses to answer through a proxy unless a password is set.
If your internet provider shares one address between many customers (CGNAT), port forwarding cannot work: use Option A
(Tailscale) instead.

**Public prices for everyone, bot data only for your team**

You can let anyone open the price pages without signing in, while keeping the bot's own data and commands behind a login:

| Who | How they get in | What they see |
|---|---|---|
| Anyone with the link | no login (needs `BOT_PUBLIC=1`) | item prices, price history, item details, top orders and item pictures only |
| Your teammate | **Team sign in** with `BOT_PASSWORD` | everything: profit, trades, rules, log, bot status, and bot commands (if `BOT_REMOTE_CONTROL=1`) |
| Optional read-only teammate | **Team sign in** with `BOT_VIEW_PASSWORD` | the same bot data, but no commands |

Steps (Windows Command Prompt), using a Cloudflare Tunnel so the link works for people who are not on your Tailscale:

1. Start the bot:
```
set BOT_PASSWORD=long-team-password
set BOT_PUBLIC=1
set BOT_REMOTE_CONTROL=1
npm run bot
```
2. In a second Command Prompt window: `cloudflared tunnel --url http://127.0.0.1:8080`. It prints an `https://...trycloudflare.com` link.
3. Send that link to anyone. They see only item prices. Your teammate opens the same link, clicks **Team sign in** and enters
   the team password to see the bot data and use bot commands.
4. Want a teammate who can look but not touch? Also `set BOT_VIEW_PASSWORD=another-long-password` and give them that one.

Leave out `BOT_REMOTE_CONTROL=1` if the teammate should not be able to send commands. Public visitors are rate limited per address.
Tailscale (option A) is private, so use it when only your own devices need access; use the tunnel when the public should see prices.

**How it is protected**

- The bot **refuses to open beyond this computer without `BOT_PASSWORD`** (8 or more characters).
- With a password set, every page and API call needs a login. After 5 wrong passwords an address is locked out for 10 minutes.
- The login cookie is `HttpOnly` and `SameSite=Strict`. Sessions last 7 days and end when the bot restarts.
- **View only by default:** from the website you can look at prices, history and trades, but not send commands.
  Set `BOT_REMOTE_CONTROL=1` to let the **team** login set rules and scanning from the website. Leave it off unless you need it:
  with it on, anyone who learns the team password can change your rules or start trading. A viewer login can never send commands.
- Without a password the bot only answers on the PC and refuses anything that arrives through a tunnel or proxy.

**Running the bot while the PC is off:** run it on an always-on machine such as a small cloud server instead. The steps are the
same (install Node, `git clone`, `npm install`, set the variables, `npm run bot`), and keep the password long.

## 10. Settings (environment variables)

Set before `npm run bot`. Windows Command Prompt: `set NAME=value`. Mac/Linux: `NAME=value npm run bot`.

| Name | Default | Meaning |
|---|---|---|
| `LIVE=1` | off | start in live mode |
| `MAX_LISTINGS` | 0 | start with a listing limit |
| `SCAN_MS` | 15000 | how often the buy scan runs (ms) |
| `MARKET=0` | on | turn the price scanner off |
| `MARKET_MS` | 7000 | pause between price searches (ms) |
| `DONUTSMP_API_KEY` | none | use the official API for prices and scans |
| `PAGES` | 10 | API pages per price pass |
| `SERVER_HOST`, `SERVER_PORT` | donutsmp.net, 19132 | server address |
| `BOT_API_PORT` | 8080 | website/API port |
| `ORDERS=0` | on | turn the order-house reader off |
| `ORDERS_MS` | 300000 | time between full order-house reads (ms) |
| `ORDERS_PAGES` | 250 | most pages read per order-house read |
| `ORDERS_SECONDS` | 420 | longest one order-house read may take |
| `BOT_HOST` | 127.0.0.1 | address the website listens on (needs `BOT_PASSWORD` if it is not this computer) |
| `BOT_PASSWORD` | none | the team password (8+ characters); turns on the login, needed for remote use |
| `BOT_VIEW_PASSWORD` | none | optional second password: can see the bot data but never send commands |
| `BOT_PUBLIC=1` | off | anyone without a login can see item prices and details (needs `BOT_PASSWORD`) |
| `BOT_REMOTE_CONTROL=1` | off | let the team login send commands from the website (default is view only) |
| `BOT_COOKIE_SECURE=1` | off | mark the login cookie `Secure` (set it when the site is served over https, e.g. through Caddy) |

## 11. Troubleshooting

| You see | What to do |
|---|---|
| `Missing script` or old behavior | run the update command (section 2) |
| Microsoft sign-in fails | `rmdir /s data\auth` (Windows) or `rm -rf data/auth`, start again, enter the new code quickly |
| `Checksum mismatch` or connect timeout | use a computer, not a phone/Termux; try Wi-Fi |
| `scan failed ... timeout waiting for the window` | the server did not open `/ah`; the bot retries; if it keeps happening, `pause` for a minute |
| `no confirm menu appeared` | the listing was sold or the click was refused; the bot cancels safely |
| `spreadsheet not updated` | close `profit-vs-cost.xlsx` in Excel |
| `forbidden: this bot has no password` in the browser | you reached the bot through a tunnel or proxy; set `BOT_PASSWORD` first |
| "view only" badge, buttons greyed out | remote control is off; start the bot with `BOT_REMOTE_CONTROL=1` if you really want it |
| Website says "Cannot reach the bot" | the bot is not running, or open <http://127.0.0.1:8080> |
| `sendto failed ... length 1464` | harmless network warning |
| Listings count wrong after restart | run `listed <n>` with your real number |

## 12. Privacy

The `data` folder inside the bot folder holds your **Xbox login tokens** (`data/auth`), your trades and your
price history. Never share it or upload it (it is in `.gitignore`, so `git add .` skips it). To log out,
delete `data/auth`.

## 13. Files

| File | Purpose |
|---|---|
| `bot/index.js` | the bot: connection, commands, trading, website server |
| `bot/ah.js` | auction house windows, clicks, inventory |
| `bot/strategy.js` | buy rules and price parsing |
| `bot/ledger.js` | trade log and spreadsheet |
| `bot/market.js` | price board and watchlist |
| `bot/orders.js` | reads the order house (`/orders`) and keeps the top buy order per item |
| `tools/make-icons.sh` | makes the item pictures with RenderChest into `data/icons` |
| `tools/Caddyfile.example` | three-line Caddy config for `https://yourname.duckdns.org` without a port |
| `bot/access.js` | website login, view-only mode and the rules for who may reach the bot |
| `web/index.html` | the price website |
| `bot/*-patch.js` | fixes for login and network libraries |
| `npm test` | offline tests of the logic above |
| `.gitignore` | keeps `data/` (login tokens) and `node_modules/` out of git |
