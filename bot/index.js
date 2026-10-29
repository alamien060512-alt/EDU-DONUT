// DonutSMP headless Bedrock trader.
//   node bot/index.js            dry run, spends nothing
//   LIVE=1 node bot/index.js     really buys and sells
// Type "help" at the bot> prompt to see the commands. Website + API: http://127.0.0.1:8080
const http = require('http');
const readline = require('readline');
const { Rules, parseBuy, parsePrice, clean } = require('./strategy');
const { Ledger } = require('./ledger');
const { Market, Watchlist, pretty } = require('./market');
const { Access } = require('./access');
const { OrderBoard, scanOrders, applyScan, parseTile } = require('./orders');
const fs = require('fs');
const path = require('path');

const KEY = process.env.DONUTSMP_API_KEY;
const BASE = process.env.DONUTSMP_BASE || 'https://api.donutsmp.net/v1';
const HOST = process.env.SERVER_HOST || 'donutsmp.net';
const PORT = +process.env.SERVER_PORT || 19132;
const API_PORT = +process.env.BOT_API_PORT || 8080;
const SCAN_MS = +process.env.SCAN_MS || 15000;
const state = { recentChat: [], maxListings: +process.env.MAX_LISTINGS || 0, listed: 0, paused: null, live: process.env.LIVE === '1', connected: false, spent: 0, log: [], holdings: [], prices: {} };
const rules = new Rules();
// A dead connection can still throw a late error. Don't let that take the whole bot down.
process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.message)));
process.on('unhandledRejection', (e) => log('unhandled: ' + (e && e.message)));
let ah = null, client = null;

const log = (m) => { const l = `${new Date().toISOString().slice(11, 19)} ${m}`; state.log.push(l); state.log = state.log.slice(-200); state.logSeq = (state.logSeq || 0) + 1; console.log(l); };

const ledger = new Ledger(log);
const market = new Market(log);
const access = new Access(process.env, log);
const orderBoard = new OrderBoard(log);
const ORDERS_MS = +process.env.ORDERS_MS || 300000;      // time between full order-house reads (ms, 5 min)

// Where the item pictures are. Normally data/icons, but a zip extracted by Windows often ends up one folder deeper,
// so look a few levels down for a folder that has diamond.webp in it.
let iconDir = null, iconChecked = 0;
function findIconDir() {
  const root = process.cwd(), has = (d) => { try { return fs.existsSync(path.join(d, 'diamond.webp')); } catch { return false; } };
  for (const d of [path.join(root, 'data', 'icons'), path.join(root, 'icons'), path.join(root, '..', 'data', 'icons')]) if (has(d)) return d;
  const skip = new Set(['node_modules', '.git']), queue = [[root, 0]];
  while (queue.length) {
    const [d, depth] = queue.shift();
    if (has(d)) return d;
    if (depth >= 4) continue;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch {}
    for (const e of ents) if (e.isDirectory() && !skip.has(e.name)) queue.push([path.join(d, e.name), depth + 1]);
  }
  return null;
}
function getIconDir() {
  if (iconDir && fs.existsSync(iconDir)) return iconDir;
  if (Date.now() - iconChecked > 10000) { iconChecked = Date.now(); iconDir = findIconDir(); if (iconDir) log('item pictures found in ' + iconDir); }
  return iconDir;
}
const watch = new Watchlist();
const MARKET_MS = +process.env.MARKET_MS || 7000;     // pause between in-game price searches (ms)
// Only one auction-house job at a time. Trading, manual commands and the price scanner all share the same window.
let ahChain = Promise.resolve();
let ahPending = 0;                      // jobs running or waiting; a long job can check this to give way
function withAh(fn) { ahPending++; const run = ahChain.then(fn, fn); ahChain = run.catch(() => {}).then(() => { ahPending--; }); return run; }

async function api(p) {
  const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${p}`);
  return r.json();
}
const rowsOf = (b) => b.result || b.data || [];
const toListing = (r) => ({
  item: clean((r.item && (r.item.id || r.item.name)) || ''), price: +r.price,
  count: (r.item && +r.item.count) || 1, seller: r.seller && r.seller.name,
});

// AUTH_TITLE=android|ios|playstation|switch picks which Minecraft app we sign in as.
function authOptions() {
  const T = require('prismarine-auth').Titles;
  const t = { android: ['MinecraftAndroid', 'Android'], ios: ['MinecraftIOS', 'iOS'], playstation: ['MinecraftPlaystation', 'PlayStation'], switch: ['MinecraftNintendoSwitch', 'Nintendo'] }[process.env.AUTH_TITLE];
  const [title, deviceType] = t || ['MinecraftAndroid', 'Android']; // Android + Sisu is how MinecraftAuth signs in to Bedrock too
  return { flow: process.env.AUTH_FLOW || 'sisu', authTitle: T[title], deviceType };
}

// ---- bot connection (first run prints a microsoft.com/link code for the Xbox login) ----
let stubbed = false;
async function connect() {
  // Phones (Termux) can't build raknet-native, so fall back to the pure-JS RakNet.
  let backend = process.env.RAKNET || 'raknet-native';
  try { if (stubbed) throw 0; require('raknet-native'); } catch {
    stubbed = true;
    backend = 'jsp-raknet';
    require('./raknet-patch');
    if (!global.__rakStub) {
      global.__rakStub = true;
      const Module = require('module'), load = Module._load;
      Module._load = function (req, ...r) { return req === 'raknet-native' ? {} : load.call(this, req, ...r); };
    }
  }
  require('./msa-patch');
  require('./crypto-patch');
  // jsp-raknet sends a broken handshake packet if you give it a hostname, so look up the IP first.
  const ip = (await require('dns').promises.lookup(HOST, { family: 4 })).address;
  log(`server ${HOST} -> ${ip}:${PORT}`);
  const bedrock = require('bedrock-protocol'); // loaded here so the console and website still work if it's missing
  client = bedrock.createClient({
    host: ip, port: PORT, username: process.env.XBOX_ACCOUNT || 'bot',
    profilesFolder: './data/auth', offline: false, raknetBackend: backend, skipPing: backend === 'jsp-raknet', version: process.env.BEDROCK_VERSION || require('bedrock-protocol/src/options').CURRENT_VERSION, // the server is newer than the library, but it accepts the newest version the library knows
    ...authOptions(),
    connectTimeout: 20000,
    conLog: (m) => log('net: ' + m),
  });
  const { AhDriver } = require('./ah');
  ah = new AhDriver(client, log);
  client.on('join', () => { state.connected = true; log('joined server'); });
  client.on('spawn', () => log('spawned'));
  client.on('close', () => { state.connected = false; log('disconnected; retry in 30s'); setTimeout(() => connect().catch((e) => log('connect failed: ' + e.message)), 30000); });
  client.on('kick', (p) => log('KICKED by server: ' + (p.message || JSON.stringify(p))));
  client.on('loggingIn', () => log('sent login'));
  client.on('session', () => log('authenticated with Xbox'));
  client.on('error', (e) => { log('client error: ' + e.message); try { client.close(); } catch {} });
  const clean = (t) => String(t).replace(/§./g, '').slice(0, 200);
  client.on('text', (p) => { if (p.message) watchChat(clean(p.message)); if (p.message) log(`chat[${p.type}]: ${clean(p.message)}${p.parameters && p.parameters.length ? ' ' + JSON.stringify(p.parameters) : ''}`); });
  client.on('command_output', (p) => (p.output || []).forEach((o) => log(`cmd result (${o.success ? 'ok' : 'fail'}): ${clean(o.message_id)} ${JSON.stringify(o.parameters || [])}`)));
  client.on('toast_request', (p) => log(`toast: ${clean(p.title)} ${clean(p.message)}`));
  client.on('set_title', (p) => { if (p.text) log(`${p.type}: ${clean(p.text)}`); });
  client.on('modal_form_request', (p) => log('form opened: ' + clean(p.data)));
}

// ---- trading ----
let busy = false;
function pause(why) { if (!state.paused) { state.paused = why; log('BUYING PAUSED: ' + why + ' (type resume to continue)'); } }
// Chat hints: a "full" message pauses buying, a sale frees up a slot.
function watchChat(msg) {
  state.recentChat.push({ t: Date.now(), msg }); state.recentChat = state.recentChat.slice(-50);
  const sale = /bought your (.+?) for \$\s*([\d,\.]+\s*[kmb]?)\b/i.exec(msg);
  if (sale && ledger.markSold(sale[1].replace(/^\d+\s*/, ''), parsePrice(sale[2].replace(/[,\s]/g, '')))) log('ledger: sale recorded (' + sale[1] + ' for ' + sale[2] + ')');
  if (/(auction|listing|ah).*(full|limit|maximum|max)|(too many|cannot|can't|unable to).*(list|auction)|reached.*(limit|maximum)/i.test(msg)) pause('auction house full: ' + msg.slice(0, 80));
  else if (/\bsold\b|purchased your|bought your/i.test(msg) && state.listed > 0) {
    state.listed--;
    if (state.paused && state.paused.startsWith('listing limit') && state.listed < state.maxListings) { state.paused = null; log('slot freed, buying resumed'); }
  }
}

async function scan() {
  if (busy || state.paused || !rules.list().length) return [];
  busy = true;
  try {
    const hits = [];
    if (!KEY) { // no API key, so read the auction house in game
      if (!state.connected) return [];
      for (const r of rules.list()) {
        const win = await ah.open('/ah ' + r.item.replace(/_/g, ' '));
        for (const [slot, it] of win.slots) {
          if (!it || !it.network_id) continue;
          if (clean(ah.nameOf(it)) !== r.item || ah.enchanted(it)) continue; // only the exact item, not enchanted
          const price = ah.priceOf(it), count = it.count || 1;
          const l = { item: r.item, price, count }, m = price > 0 && rules.matches(l);
          if (m) hits.push({ ...l, unit: m.unit, rule: r, slot });
          if (price > 0) (state.prices[r.item] ||= { low: Infinity }).low = Math.min(state.prices[r.item].low, price / count);
        }
        ah.close();
      }
      hits.sort((a, b) => a.unit - b.unit);
      if (hits[0]) await buy(hits[0]);
      return hits;
    }
    for (const page of [1, 2, 3]) {
      for (const r of rowsOf(await api('/auction/list/' + page))) {
        const l = toListing(r), m = rules.matches(l);
        const s = (state.prices[l.item] ||= { low: Infinity });
        s.low = Math.min(s.low, l.price / l.count); s.t = Date.now();
        if (m) hits.push({ ...l, unit: m.unit, rule: m.rule });
      }
    }
    hits.sort((a, b) => a.unit - b.unit);
    if (hits[0]) await buy(hits[0]);
    return hits;
  } catch (e) { log('scan failed: ' + e.message); return []; } finally { busy = false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(100); } return null; }

// Gets the balance by running /bal and reading "You have $ 1,478,100".
async function balance(ms = 4000) {
  const since = Date.now();
  ah.say('/bal');
  const m = await waitFor(() => state.recentChat.find((c) => c.t >= since && /you have \$\s*([\d,\.]+)/i.test(c.msg)), ms);
  const v = m ? parseFloat(/you have \$\s*([\d,\.]+)/i.exec(m.msg)[1].replace(/,/g, '')) : NaN;
  if (v > 0) ledger.balance(v);
  return v;
}

// Buys the cheapest plain listing of `item` at or under maxUnit each. Two clicks: the listing, then Confirm.
async function purchase(item, maxUnit) {
  const balP = balance();              // ask for the balance while the AH opens, saves a couple of seconds
  const win = await ah.open('/ah ' + item.replace(/_/g, ' '));
  const cands = [...win.slots].filter(([, it]) => it && it.network_id && clean(ah.nameOf(it)) === item && !ah.enchanted(it))
    .map(([slot, it]) => ({ slot, it, price: ah.priceOf(it), count: it.count || 1 }))
    .filter((c) => c.price > 0 && c.price / c.count <= maxUnit)
    .sort((x, y) => x.price / x.count - y.price / y.count);
  if (!cands.length) { ah.close(); await balP; return { ok: false, why: 'no listing at or under ' + maxUnit + ' (gone, or sold to someone else)' } };
  const c = cands[0];
  const before = await balP;            // the reply has usually arrived by now
  const inv0 = ah.snapshot();
  ah.other.clear();
  log(`clicking listing: slot ${c.slot}, ${c.price} for ${c.count}`);
  ah.clickItem(c.it, c.slot);           // click the exact item we picked, don't look it up again
  const menu = await waitFor(() => ah.confirmMenu(), 4000);
  if (!menu) { ah.close(); return { ok: false, why: 'no confirm menu appeared', events: ah.events.slice(-8) }; }
  // before confirming, check the menu really shows the listing we meant to buy
  const shownPrice = menu.shown ? ah.priceOf(menu.shown.item) : NaN, shownName = menu.shown ? clean(ah.nameOf(menu.shown.item)) : '';
  if (shownName !== item || !(shownPrice > 0) || shownPrice / c.count > maxUnit * 1.001) {
    ah.clickItem(menu.cancel.item, menu.cancel.slot);
    ah.close();
    return { ok: false, why: `confirm menu shows ${shownName} @ ${shownPrice}, not what we expected; cancelled` };
  }
  const since = Date.now();
  log(`confirming: ${item} for ${shownPrice}`);
  ah.clickItem(menu.confirm.item, menu.confirm.slot);
  await sleep(2500);
  const chat = state.recentChat.filter((m) => m.t >= since).map((m) => m.msg);
  ah.closeWindow(menu.id);
  ah.close();
  const after = await balance();
  const spent = before - after;
  const ok = spent > 0;
  const tradeId = ok ? ledger.addPurchase({ item, qty: c.count, cost: spent, balanceBefore: before }) : undefined;
  return { ok, spent: isNaN(spent) ? 'unknown' : spent, price: shownPrice, tradeId, balanceBefore: before, balanceAfter: after, inventorySlot: ah.newSlot(inv0), chat };
}

// Holds the item from a hotbar slot and lists it with /ah sell <price>, clicking Confirm if the server asks.
async function relist(slot, price) {
  ah.select(slot);
  await sleep(600);
  ah.other.clear(); ah.win = null;
  const since = Date.now();
  ah.say('/ah sell ' + price);
  // the server answers with a sell menu, click Confirm once we find it
  const menu = await waitFor(() => ah.confirmMenu(), 4000);
  let confirmed = false, windowSeen = null;
  if (menu) { ah.clickItem(menu.confirm.item, menu.confirm.slot); confirmed = true; }
  else { await sleep(500); windowSeen = ah.describe(); }
  await sleep(2500);
  const chat = state.recentChat.filter((m) => m.t >= since).map((m) => m.msg);
  const stillOpen = ah.describe();
  if (menu) ah.closeWindow(menu.id);
  ah.closeAll();
  return { price, slot, menuShown: menu ? menu.shown && ah.textOf(menu.shown.item).join(' | ') : null, confirmed, stillConnected: state.connected, chat,
    windowIfNoConfirmFound: windowSeen, windowAfterClick: confirmed ? stillOpen.window : undefined,
    serverSaid: ah.timeline.filter((l) => l.slice(0, 6) >= new Date(since - 1000).toISOString().slice(17, 23)).slice(-25) };
}

async function buy(h) {
  log(`${state.live ? 'BUY' : 'DRY-BUY'} ${h.count}x ${h.item} @ ${h.unit.toFixed(2)}/ea (total ${h.price}) -> relist ${rules.sellPrice(h.item, h.unit, h.count)}`);
  if (!state.live || !state.connected) return;
  try {
    const r = await purchase(h.item, h.rule.maxPrice);
    log('purchase result: ' + JSON.stringify(r));
    if (!r.ok) return;
    state.spent += typeof r.spent === 'number' ? r.spent : h.price;
    state.listed++;
    if (state.maxListings && state.listed >= state.maxListings) pause('listing limit reached (' + state.listed + '/' + state.maxListings + ')');
    const slot = r.inventorySlot, held = slot != null ? ah.inv.get(slot) : null;
    const price = rules.sellPrice(h.item, r.price / h.count, held ? held.count : h.count); // /ah sell lists the whole stack in hand, so price by what we hold
    if (slot === null || slot === undefined) { log('bought, but could not find the item in the inventory; relist by hand'); return; }
    const rl = await relist(slot, price);
    log('relist result: ' + JSON.stringify(rl));
    if (rl.chat.some((m) => /you listed/i.test(m)) && r.tradeId) ledger.setListed(r.tradeId, price);
  } catch (e) { log('buy failed: ' + e.message); ah.close(); }
}

// ---- commands (console + API) ----
const LOCKED = new Set(['scan', 'buynow', 'sellnow', 'peek', 'inspectbuy', 'peekorders']);   // ('orders' takes the lock itself)
async function run(line) {
  const c = (line.trim().split(/\s+/)[0] || '').toLowerCase();
  return LOCKED.has(c) ? withAh(() => runInner(line)) : runInner(line);
}
async function runInner(line) {
  const [c, ...a] = line.trim().split(/\s+/);
  switch ((c || '').toLowerCase()) {
    case 'watch': { // watch | watch add <item...> | watch remove <item>
      if (a[0] === 'add') return { added: a.slice(1).map((x) => [x, watch.add(x)]), watchlist: watch.items.length };
      if (a[0] === 'remove') return { removed: watch.remove(a[1] || ''), watchlist: watch.items.length };
      return watch.items;
    }
    case 'icons': { // icons: where the bot looks for the item pictures and how many it found
      const dir = getIconDir(), count = dir ? fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).length : 0;
      return dir ? { folder: dir, pictures: count } : { folder: null, lookedIn: path.join(process.cwd(), 'data', 'icons'), how: 'Extract minecraft-icons-26.3.zip into the bot folder so that data\\icons\\diamond.webp exists, then refresh the page.' };
    }
    case 'orders': { // orders on | off | status | scan
      if (a[0] === 'on') orderBoard.on = true; else if (a[0] === 'off') { orderBoard.on = false; orderBoard.save(); }
      else if (a[0] === 'scan') {       // read the whole order house now, in the background (takes a minute or two)
        if (!state.connected) return 'not connected yet';
        if (ordersRunning) return 'a read is already running, watch the Top orders tab';
        ordersOnce(true);
        return { started: true, note: 'reading the whole order house now; the Top orders tab fills in as pages are read (a minute or two)' };
      }
      return orderBoard.status();
    }
    case 'peekorders': { // peekorders: open /orders and print every tile with what we parsed from it (read-only)
      if (!state.connected) return 'not connected yet';
      const win = await ah.open('/orders', 2);
      const rows = [...win.slots].filter(([, it]) => it && it.network_id).map(([slot, it]) => ({ slot, name: ah.nameOf(it), count: it.count, lore: ah.textOf(it).join(' | ').slice(0, 220), order: parseTile(ah.textOf(it)) }));
      ah.closeAll();
      return rows.length ? rows : 'the order window had no items';
    }
    case 'market': { // market on | off | status | scan [item ...]
      if (a[0] === 'on') market.on = true; else if (a[0] === 'off') { market.on = false; market.save(); }
      else if (a[0] === 'scan') {
        // update the price board right now. With 1-5 items it waits and returns their prices; with none it refreshes the whole watchlist in the background.
        if (KEY) { await marketApiPass(); return market.status(watch); }
        if (!state.connected) return 'not connected yet';
        const items = a.slice(1).map((x) => x.toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_'));
        if (items.length && items.length <= 5) {
          const out = {};
          for (const it of items) { try { const low = await marketSearch(it); out[it] = low == null ? 'no plain listing found' : low; } catch (e) { out[it] = 'failed: ' + String(e.message).slice(0, 120); } }
          return out;
        }
        if (forcedRunning) return 'an update is already running, watch the log';
        const list = items.length ? items : watch.items.slice();
        marketForce(list);
        return { started: list.length, takes: 'about ' + Math.max(1, Math.round(list.length * (MARKET_MS / 1000 + 2) / 60)) + ' minutes', note: 'running in the background; watch the log or the Market tab' };
      }
      return market.status(watch);
    }
    case 'help': return 'market scan [item] | market on|off | watch [add|remove <item>] | trades | status | rules | buy <item> <max> [sell <price> | <multiple>] | drop <item> | limit <n> | pause | resume | listed <n> | cmd </command> | scan | live on|off | quit';
    case 'status': return { connected: state.connected, live: state.live, spent: state.spent, rules: rules.list().length, listed: state.listed, maxListings: state.maxListings || 'none', paused: state.paused };
    case 'rules': return rules.list();
    case 'buy': { const b = parseBuy(a); return rules.add(b.item, b.maxPrice, b.sellMultiple, b.sellUnit); }
    case 'limit': state.maxListings = +a[0] || 0; return { maxListings: state.maxListings, listed: state.listed };
    case 'resume': state.paused = null; return 'buying resumed';
    case 'pause': pause('paused by you'); return 'paused';
    case 'listed': state.listed = +a[0] || 0; return { listed: state.listed };
    case 'drop': return rules.remove(a[0]);
    case 'cmd': if (!client || !state.connected) return 'not connected yet'; ah.say(a.join(' ')); return 'sent; watch the log for the reply';
    case 'scan': return scan();
    case 'trades': { const S = ledger.summary(); return { file: 'data/profit-vs-cost.xlsx', csv: 'data/trades.csv', trades: ledger.d.trades.length, spent: S.spent, realizedProfit: S.realized, sold: S.sold, listed: S.listed, fee: ledger.d.fee }; }
    case 'fee': ledger.d.fee = Math.max(0, (+a[0] || 0) / 100); ledger.save(); return { fee: ledger.d.fee };
    case 'inv': return [...ah.inv].map(([slot, it]) => ({ slot, network_id: it.network_id, count: it.count, name: ah.nameOf(it) }));
    case 'sellnow': { // sellnow <hotbarSlot> <price> yes: holds that slot's item and runs /ah sell <price>
      if (!state.connected) return 'not connected yet';
      if (a[a.length - 1] !== 'yes' || a.length < 3) return 'This LISTS an item for sale. Type: sellnow <hotbarSlot 0-8> <price> yes  (see slots with: inv)';
      return relist(+a[0], a[1]);
    }
    case 'buynow': { // buynow <item> <maxPrice> yes: really buys the cheapest plain listing at or under maxPrice each
      if (!state.connected) return 'not connected yet';
      if (a[a.length - 1] !== 'yes') return 'This REALLY buys. Type: buynow <item> <maxPrice> yes';
      const b = parseBuy(a.slice(0, 2));
      return purchase(clean(b.item), b.maxPrice);
    }
    case 'inspectbuy': { // inspectbuy <item> yes: clicks the cheapest listing. If "no confirmation" is on in your AH settings, this BUYS it.
      if (!state.connected) return 'not connected yet';
      if (a[a.length - 1] !== 'yes') return 'This clicks the cheapest listing, which BUYS it if "no confirmation" is on in your AH settings. Type: inspectbuy <item> yes';
      const item = clean(a.filter((x) => x !== 'yes').join(' ') || 'diamond');
      const win = await ah.open('/ah ' + item.replace(/_/g, ' '));
      const hit = [...win.slots].filter(([, it]) => it && it.network_id && clean(ah.nameOf(it)) === item && !ah.enchanted(it))
        .sort((x, y) => ah.priceOf(x[1]) - ah.priceOf(y[1]))[0];
      if (!hit) { ah.close(); return 'no plain ' + item + ' listing found'; }
      ah.responses.length = 0; ah.other.clear(); ah.pkts = {};
      const beforeId = win.id;
      ah.click(hit[0]);
      await new Promise((r) => setTimeout(r, 2500));
      const out = { clickedSlot: hit[0], clickedPrice: ah.priceOf(hit[1]), windowChanged: !!ah.win && ah.win.id !== beforeId, responses: ah.responses.slice(0, 5), events: ah.events.slice(-12), packets: ah.interestingPackets(), otherWindows: ah.describeOthers(), after: ah.describe() };
      ah.close();
      return out;
    }
    case 'peek': { // peek <item>: prints the first few listings with their parsed prices, good for checking the price reading
      if (!state.connected) return 'not connected yet';
      const win = await ah.open('/ah ' + (a.join(' ') || 'diamond'));
      const rows = [...win.slots].filter(([, it]) => it && it.network_id).slice(0, 12)
        .map(([slot, it]) => ({ slot, name: ah.nameOf(it), count: it.count, price: ah.priceOf(it), enchanted: ah.enchanted(it), text: ah.textOf(it).join(' | ').slice(0, 200) }));
      ah.close();
      return rows.length ? rows : 'no items found in the window (slots: ' + win.slots.size + ')';
    }
    case 'live': state.live = a[0] === 'on'; return { live: state.live };
    case 'quit': process.exit(0);
    default: return line.trim().startsWith('/') ? 'to send an in-game command, type: cmd ' + line.trim() : 'unknown command; try help';
  }
}

// ---- order house (top buy orders) ----
// Reads EVERY page of the order house (sorted by most per item) and keeps the best price per item.
// A full read takes a minute or two, so it gives way whenever trading or another job is waiting for the auction house
// (after 20 s of work) and carries on from the same page a few seconds later. `manual` reads never give way.
let sweep = null, ordersRunning = false;           // sweep = a full read in progress: { best, next }
async function ordersOnce(manual = false) {
  if (ordersRunning) return 'busy';
  ordersRunning = true;
  if (!sweep || manual) sweep = { best: new Map(), next: 0 };
  try {
    if (sweep.next === 0) log('orders: reading the whole order house' + (manual ? '' : ', pausing whenever trading needs the auction house'));
    const scan = await withAh(() => scanOrders(ah, {
      best: sweep.best, startPage: sweep.next, maxPages: +process.env.ORDERS_PAGES || 250, maxSeconds: +process.env.ORDERS_SECONDS || 420,
      wait: +process.env.ORDERS_WAIT_MS || 1500, yieldAfter: manual ? 1e9 : (process.env.ORDERS_YIELD_SECONDS !== undefined ? +process.env.ORDERS_YIELD_SECONDS : 20), shouldYield: () => ahPending > 1,
      onPage: (best, n) => { orderBoard.progress = { page: n, items: best.size }; if (n % 10 === 0) applyScan(orderBoard, { items: best }, true); if (n % 50 === 0) log(`orders: page ${n}, ${best.size} items so far`); },
    }));
    applyScan(orderBoard, scan);
    sweep.next = scan.next; if (!scan.next) sweep = null;
    log('orders: ' + orderBoard.note);
    return scan.next ? 'paused' : 'done';
  } catch (e) {
    sweep = null; orderBoard.progress = null; orderBoard.note = 'scan failed: ' + String(e.message).slice(0, 100); log('orders: ' + orderBoard.note);
    try { ah.closeAll(); } catch {}
    if (/timeout waiting for the window/.test(e.message)) recover('orders').catch(() => {});
    return 'failed';
  } finally { ordersRunning = false; }
}
async function ordersLoop() {
  await sleep(20000);
  for (;;) {
    let wait = 3000;
    if (orderBoard.on && state.connected && !scannersResting()) {
      const r = await ordersOnce();
      if (r === 'paused') wait = 4000;                                  // trading had its turn, carry on soon
      else if (r !== 'busy') { orderBoard.nextAt = Date.now() + ORDERS_MS; wait = ORDERS_MS; }
    }
    await sleep(wait);
  }
}

// After repeated window timeouts: ask /bal. A reply means the link is fine and the server just ignores /ah and /orders,
// so the scanners rest for a while. No reply means the link is dead, so drop it and let the reconnect take over.
let scannersPausedUntil = 0, recovering = false;
async function recover(why) {
  if (recovering) return 'busy';
  recovering = true;
  try {
    return await withAh(async () => {
      ah.closeAll(); ah.closeRecent();
      const v = await balance(+process.env.RECOVER_BAL_MS || 6000);
      if (v > 0) {
        scannersPausedUntil = Date.now() + (+process.env.RECOVER_PAUSE_MS || 300000);
        log(`recover (${why}): connection is alive (/bal answered) but the server ignores /ah and /orders; scanners rest ${Math.round((scannersPausedUntil - Date.now()) / 60000)} min`);
        return 'alive';
      }
      log(`recover (${why}): no answer to /bal, the connection looks dead; reconnecting`);
      state.connected = false; try { client.close(); } catch {}
      return 'dead';
    });
  } finally { recovering = false; }
}
const scannersResting = () => Date.now() < scannersPausedUntil;

// ---- price board scanners ----
// In game: search each watched item in /ah (cheapest first) and record the plain listings it shows.
// Search one item in /ah and record the plain listings the page shows. Returns that item's lowest price (or null).
async function marketSearch(item) {
  await withAh(async () => {
    const win = await ah.open('/ah ' + item.replace(/_/g, ' '), 2);
    const groups = new Map();
    for (const [, it] of win.slots) {
      if (!it || !it.network_id) continue;
      const name = ah.nameOf(it); if (!name || ah.enchanted(it)) continue;
      const price = ah.priceOf(it); if (!(price > 0)) continue;
      const k = clean(name), g = groups.get(k) || { name, units: [] };
      g.units.push(price / (it.count || 1)); groups.set(k, g);
    }
    for (const [k, g] of groups) market.record(k, g.name, g.units, 'ingame');
    ah.close();
  });
  const rec = market.items[clean(item)];
  return rec ? rec.low : null;
}

// The scanner, walking the whole watchlist over and over.
async function marketGuiLoop() {
  let fails = 0;                                              // searches that failed in a row
  for (;;) {
    if (!market.on || !state.connected || scannersResting()) { await sleep(2000); continue; }
    for (const item of watch.items.slice()) {
      if (!market.on || !state.connected) break;
      market.current = item;
      try { await marketSearch(item); fails = 0; }
      catch (e) {
        fails++;
        log(`market: ${item}: ${String(e.message).slice(0, 200)}`);
        if (fails >= 3) { log(`market: ${fails} failed searches in a row`); await recover('market'); fails = 0; }
      }
      await sleep(MARKET_MS);
    }
    market.passes++; market.current = null; market.save();
  }
}

// "market scan": update right now, without waiting for the loop. Runs in the background, one item after another.
let forcedRunning = false;
async function marketForce(items) {
  forcedRunning = true; let done = 0, failed = 0;
  try {
    for (const item of items) {
      market.current = item;
      try { await marketSearch(item); } catch (e) { failed++; log(`market: ${item}: ${String(e.message).slice(0, 200)}`); }
      done++; if (done % 10 === 0) log(`market update: ${done}/${items.length}`);
      await sleep(MARKET_MS);
    }
    market.passes++; market.save();
    log(`market update finished: ${done - failed} of ${items.length} items refreshed`);
  } finally { forcedRunning = false; market.current = null; }
}
// With an API key: read a bunch of pages from the official listings endpoint (a sample of the whole market).
async function marketApiPass() {
  const pages = +process.env.PAGES || 10, groups = new Map();
  for (let p = 1; p <= pages; p++) {
    let rows; try { rows = rowsOf(await api('/auction/list/' + p)); } catch (e) { log('market api: ' + e.message); break; }
    if (!rows.length) break;
    for (const r of rows) { const l = toListing(r); if (l.item && l.price > 0) (groups.get(l.item) || groups.set(l.item, []).get(l.item)).push(l.price / l.count); }
    await sleep(1400);
  }
  for (const [k, units] of groups) market.record(k, pretty(k), units, 'api');
  market.passes++; market.save();
}
async function marketApiLoop() {
  const every = +process.env.MARKET_API_MS || 60000;
  for (;;) { if (market.on) await marketApiPass(); await sleep(every); }
}

// ---- website + API ----
// Extra headers when the bot can be reached from outside (a password is set): no sniffing, no framing, no referrer leaks,
// and "use https only" when a proxy such as Caddy tells us the visitor came in over https.
function safeHeaders(req) {
  if (!access.passwordMode) return {};
  const h = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' };
  if (req.headers['x-forwarded-proto'] === 'https') h['strict-transport-security'] = 'max-age=604800';
  return h;
}
const PUBLIC_READ = /^\/(market|prices|orders)(\/|$)/;   // price data is read-only, so other websites may fetch it
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (await access.gate(req, res, u)) return;      // host checks, or the login when a password is set
  const base = safeHeaders(req);
  const send = (o, c = 200) => {
    const h = { ...base, 'content-type': 'application/json' };
    if (PUBLIC_READ.test(u.pathname) && !access.passwordMode) h['access-control-allow-origin'] = '*';
    res.writeHead(c, h); res.end(JSON.stringify(o));
  };
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { ...base, 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html')));
    }
    if (u.pathname.startsWith('/icons/')) {            // item pictures made by RenderChest (see HOW-TO-USE.md)
      const m = /^\/icons\/([a-z0-9_]+)\.webp$/.exec(u.pathname);
      const dir = getIconDir();
      let file = null; try { file = m && dir && fs.readFileSync(path.join(dir, m[1] + '.webp')); } catch {}
      if (!file) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { ...base, 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400' }); return res.end(file);
    }
    if (u.pathname === '/orders') return send({ status: orderBoard.status(), items: orderBoard.list() });
    if (u.pathname === '/session') return send({ auth: access.passwordMode, role: req.role, publicMode: access.publicMode, readOnly: !access.canControl(req) });
    if (u.pathname === '/status') return send({ connected: state.connected, live: state.live, spent: state.spent, listed: state.listed, maxListings: state.maxListings, paused: state.paused });
    if (u.pathname === '/rules') return send(rules.list());
    if (u.pathname === '/log') {
      const since = u.searchParams.get('since');            // the terminal asks for just the lines it has not seen yet
      if (since === null) return send(state.log);
      const seq = state.logSeq || 0, n = Math.min(Math.max(seq - (+since || 0), 0), state.log.length);
      return send({ seq, lines: n ? state.log.slice(-n) : [] });
    }
    if (u.pathname === '/holdings') return send(state.holdings);
    if (u.pathname === '/prices') return send(state.prices);
    if (u.pathname === '/market') {
      const st = market.status(watch);
      if (req.role === 'public') { delete st.current; delete st.passes; }       // visitors don't need to see what the bot is doing
      return send({ status: st, items: market.list() });
    }
    if (u.pathname.startsWith('/market/')) { const m = market.get(decodeURIComponent(u.pathname.slice(8))); return m ? send(m) : send({ error: 'unknown item' }, 404); }
    if (u.pathname === '/trades') {
      const S = ledger.summary();
      return send({ summary: { spent: S.spent, realizedProfit: S.realized, costListed: S.costListed, expectedRevenue: S.revListed, sold: S.sold, listed: S.listed, fee: ledger.d.fee }, trades: ledger.d.trades.slice(-100).reverse() });
    }
    if (u.pathname === '/command' && req.method === 'POST') {
      // Commands can spend money, so only the bot's own page (or curl) may send them, never some other website.
      if (!access.sameOrigin(req) || req.headers['x-bot'] !== '1') return send({ error: 'forbidden: commands only from the bot page (send header X-Bot: 1)' }, 403);
      if (!access.canControl(req)) return send({ error: 'view only: only the team login can send commands, and only when the bot was started with BOT_REMOTE_CONTROL=1' }, 403);
      let b = ''; for await (const d of req) b += d;
      const line = String(JSON.parse(b).command || '');
      if (/^\s*quit\b/i.test(line)) return send({ error: 'quit only works at the PC console, not from the website' }, 403);   // nobody should be able to stop the bot remotely
      return send({ result: await run(line) });
    }
    send({ error: 'not found', routes: ['/', '/session', '/market', '/orders', '/icons/<item>.webp', '/market/<item>', '/trades', '/status', '/rules', '/log', '/holdings', '/prices', 'POST /command (header X-Bot: 1)'] }, 404);
  } catch (e) { send({ error: e.message }, 400); }
}).listen(API_PORT, access.host, () => log(`Website + API on http://${access.host}:${API_PORT}` + (access.passwordMode ? ` (password protected${access.publicMode ? ', public prices ON' : ''}, ${access.remoteControl ? 'team can send commands' : 'view only'})` : '')));

if (require.main === module) {
  if (!KEY) console.log('No API key: reading the auction house in game instead.');
  log(state.live ? 'LIVE mode' : 'DRY RUN (set LIVE=1 to spend money)');
  if (process.env.NO_CONNECT !== '1') connect().catch((e) => log('connect failed: ' + e.message));
  setInterval(() => withAh(scan), SCAN_MS);
  if (KEY) marketApiLoop(); else marketGuiLoop();
  ordersLoop();
  if (!getIconDir()) log('item pictures are not installed (optional). Type  icons  or read HOW-TO-USE.md, "Item pictures".');
  setInterval(() => market.save(), 120000);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'bot> ' });
  rl.prompt();
  rl.on('line', async (l) => { try { const r = await run(l); console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1)); } catch (e) { console.log('error:', e.message); } rl.prompt(); });
}
module.exports = { run, rules, state, _test: { setAh: (x) => { ah = x; state.connected = true; }, market, watch, orderBoard, ordersOnce, withAh, recover, setClient: (c) => { client = c; }, scannersResting, rest: () => { scannersPausedUntil = 0; } } };
