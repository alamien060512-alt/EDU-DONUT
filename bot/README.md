# Headless Bedrock trader

Inspired by [cody-raves/Gonuts](https://github.com/cody-raves/Gonuts) (MIT), but it
logs in as a **Bedrock (Xbox) account** with `bedrock-protocol` instead of running inside a Java client.

    npm install
    npm run bot   # no API key needed (it reads /ah in game); add DONUTSMP_API_KEY=xxx to use the API instead
    LIVE=1 DONUTSMP_API_KEY=xxx npm run bot # spends real money

First run prints a microsoft.com/link code; the token is cached in `data/auth`.
Server defaults to `donutsmp.net:19132` (override `SERVER_HOST`/`SERVER_PORT`).

Console (the `bot>` prompt): `buy diamond 1.5k` (buy at or under 1.5k each, relist at 2x),
`buy diamond 1.5k 3` (relist at 3x), `rules`, `drop diamond`, `cmd /balance`, `scan`, `live on|off`, `status`.

Website + API on `http://127.0.0.1:8080` (open it in a browser): `GET /` price website, `/market`, `/market/<item>`, `/trades`, `/status`, `/rules`, `/log`, `/holdings`, `/prices`, and `POST /command {"command":"..."}` which needs the header `X-Bot: 1` (blocks other websites from sending commands).

Caveats: the auction GUI driver (`ah.js`) is untested against the live server.
Slot choices and the confirm click are guesses until you try them in dry/live runs.
Running a trading bot may break DonutSMP's rules; use at your own risk.

## Buy / sell rules
    buy diamond 5k sell 5.1k    buy at <= 5k each, relist at a fixed 5.1k each
    buy diamond 5k 1.02         relist at 1.02x what you paid
    buy diamond 5k              relist at 2x (default)
    limit 20                    stop buying once 20 listings are active (0 = no limit)
    pause | resume              stop / continue buying; `listed <n>` corrects the listing count

Buying also pauses by itself when the server says the auction house is full.

## Automatic trade log and spreadsheet
Every purchase, relist and sale is recorded in `data/trades.json` and `data/trades.csv`, and
`data/profit-vs-cost.xlsx` (Summary + Trades sheets with live formulas) is rebuilt after each change.
Close the .xlsx in Excel if the bot reports it cannot update it. Console: `trades` (totals), `fee <percent>`.
First run seeds the ledger from `bot/seed-trades.json`.

## Price website
Open http://127.0.0.1:8080 while the bot runs. The bot walks through a watchlist (`data/watchlist.json`, ~70 items by default)
and searches each one in `/ah`, one every 7 seconds (`MARKET_MS`), recording the cheapest plain listings and a price history.
Console: `market on|off`, `watch` (list), `watch add <item>`, `watch remove <item>`.
With `DONUTSMP_API_KEY` set (get one with `/api` in game) it reads many pages of the official listings instead (`PAGES`, default 10),
which covers far more items at once.
