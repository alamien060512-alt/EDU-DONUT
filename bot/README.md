# bot/

The bot's source. For installing, commands and troubleshooting read the top-level [HOW-TO-USE.md](../HOW-TO-USE.md).

| File | Purpose |
|---|---|
| `index.js` | entry point: connection, console commands, trading loop, price scanner, website/API server |
| `ah.js` | auction-house windows, clicks (item stack requests), inventory tracking |
| `strategy.js` | buy rules, price parsing (`12k`, `1.5m`), sell price calculation |
| `ledger.js` | trade log: `data/trades.json`, `data/trades.csv`, `data/profit-vs-cost.xlsx` |
| `market.js` | price board, price history and the watchlist |
| `access.js` | who may reach the website/API: local-only mode, team/viewer logins, optional public prices, view-only, lockout, rate limit |
| `msa-patch.js` | tolerant Microsoft device-code sign-in (polls until the code is entered) |
| `raknet-patch.js` | fixes for the pure-JavaScript RakNet fallback (protocol 11, MTU, security cookie, ordering) |
| `crypto-patch.js` | decrypts each packet with one direct call instead of a stream |
| `pinghandshake.js`, `rakdebug.js` | connection diagnostics (`npm run pinghandshake`, `npm run rakdebug`) |
| `test*.js` | offline tests, run all with `npm test` |

## API (http://127.0.0.1:8080, this computer only)

`GET /` price website · `/market` · `/market/<item>` · `/trades` · `/status` · `/rules` · `/log` · `/holdings` · `/prices`
`POST /command {"command":"..."}` needs the header `X-Bot: 1` (blocks other websites from sending commands).
Without a password only `/market` and `/prices` allow other origins to read them. With `BOT_PASSWORD` set every route needs a login, except
`/`, `/session`, `/market` and `/market/<item>` when `BOT_PUBLIC=1`. Commands need the team login plus `BOT_REMOTE_CONTROL=1`
(see HOW-TO-USE.md, section 9).

## Notes

- The bot starts in dry run. `live on` (or `LIVE=1`) makes it spend real in-game money.
- Displayed prices are rounded; a listing shown as `11K` can cost a little more.
- The trade ledger starts empty on a new install; it only records what your bot does.
- Educational project. Automated play may break a server's rules; use at your own risk.
