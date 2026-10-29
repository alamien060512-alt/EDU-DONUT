// The order house (/orders): what buyers are offering to pay for each item.
// Each order tile says "$ 700M each" and "3/10 delivered" in its tooltip. We open /orders, switch the sort to
// "Most Per Item" so the best offers come first, read a few pages, and keep the best price per item.
// Read-only: the only things clicked are the sort button and the next-page arrow, never an order.
// One full read goes through every page (a minute or two), then the board keeps the best price per item.
const fs = require('fs');
const path = require('path');
const { parsePrice, clean } = require('./strategy');

const DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'orders.json');
const DAY = 86400000;

const PRICE = /\$\s*([0-9][0-9.,]*)\s*([kmb]?)\s+each/i;
const DELIVERED = /([0-9][0-9.,]*\s*[kmb]?)\s*\/\s*([0-9][0-9.,]*\s*[kmb]?)\s+delivered/i;
const num = (s) => parsePrice(String(s).replace(/[,\s]/g, ''));

// One tile's tooltip -> { unit, delivered, total, remaining }, or null if it is not an order (a button, filler...).
function parseTile(lines) {
  const text = lines.join(' | ');
  const p = PRICE.exec(text);
  if (!p) return null;
  const unit = num(p[1] + p[2]);
  if (!(unit > 0)) return null;
  const d = DELIVERED.exec(text);
  const delivered = d ? num(d[1]) : 0, total = d ? num(d[2]) : 0;
  return { unit, delivered: delivered || 0, total: total || 0, remaining: Math.max(0, (total || 0) - (delivered || 0)) };
}
const nonIncreasing = (a) => a.length >= 3 && a.every((v, i) => i === 0 || v <= a[i - 1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the board: best order per item, with history ----
class OrderBoard {
  constructor(log = () => {}) {
    this.log = log; this.items = {}; this.on = process.env.ORDERS !== '0'; this.last = null; this.lastSave = 0;
    this.scans = 0; this.note = 'not scanned yet'; this.sorted = null; this.progress = null;
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); this.items = j.items || {}; this.last = j.last || null; } catch {}
  }
  record(key, name, { top, n, demand }) {
    const now = Date.now(), it = this.items[key] || (this.items[key] = { name, history: [] });
    it.name = name || it.name; it.top = top; it.n = n; it.demand = demand; it.updated = now;
    const h = it.history, prev = h[h.length - 1];
    if (!prev || prev[1] !== top || now - prev[0] >= 300000) h.push([now, top]);
    if (h.length > 1500) h.splice(0, h.length - 1500);
    this.last = now;
  }
  save() {
    this.lastSave = Date.now();
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify({ items: this.items, last: this.last })); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { this.log('orders save failed: ' + e.message); }
  }
  change(it) {
    const h = it.history; if (h.length < 2) return null;
    const cutoff = Date.now() - DAY; let ref = h[0];
    for (const p of h) { if (p[0] <= cutoff) ref = p; else break; }
    if (Date.now() - ref[0] < 3600000 || !(ref[1] > 0)) return null;
    return (it.top - ref[1]) / ref[1];
  }
  list() {
    return Object.entries(this.items).map(([k, it]) => ({ item: k, name: it.name, top: it.top, n: it.n, demand: it.demand, updated: it.updated, change24h: this.change(it), spark: it.history.slice(-40).map((p) => p[1]) }))
      .sort((a, b) => b.top - a.top);
  }
  status() { return { scanning: this.on, tracked: Object.keys(this.items).length, lastUpdate: this.last, scans: this.scans, sortedByPrice: this.sorted, note: this.note, progress: this.progress }; }
}

// ---- reading the order house ----
// `ah` is the auction-house driver (open, win, nameOf, textOf, clickItem, closeAll).
// The best offers come first when sorted by Most Per Item, but the first pages are mostly the same few pricey items
// (elytra...), so to know the top order of EVERY item we read the whole order house, page after page, and keep the
// highest price seen per item. onPage(best, pageNumber) is called as we go so the board can fill in while it runs.
async function scanOrders(ah, { maxPages = 250, maxSeconds = 420, wait = 1500, pollMs = 120, onPage = () => {} } = {}) {
  const started = Date.now();
  const tiles = () => (ah.win ? [...ah.win.slots].filter(([, it]) => it && it.network_id) : []);
  const info = (it) => ({ name: ah.nameOf(it), lines: ah.textOf(it) });
  const orders = () => tiles().map(([slot, it]) => ({ slot, it, ...info(it) })).map((t) => ({ ...t, o: parseTile(t.lines) })).filter((t) => t.o);
  const fingerprint = () => orders().map((t) => t.slot + ':' + t.name + ':' + t.o.unit).join(',');
  // wait until the page contents change (or give up after a few seconds)
  const waitChange = async (before, ms = 3500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { await sleep(pollMs); const now = fingerprint(); if (now && now !== before) { await sleep(pollMs); return true; } }
    return false;
  };
  await ah.open('/orders', 2);
  await sleep(wait / 2);
  let note = '', sorted = false;

  // 1) make sure the best offers come first: click the sort button until prices only go down
  for (let tries = 0; tries < 5; tries++) {
    const prices = orders().map((t) => t.o.unit);
    if (nonIncreasing(prices)) { sorted = true; break; }
    const btn = tiles().find(([, it]) => { const i = info(it); return !parseTile(i.lines) && /most per item/i.test(i.lines.join(' ')); });
    if (!btn) { note = 'no sort button found; reading the page as it is'; break; }
    const before = fingerprint();
    ah.clickItem(btn[1], btn[0]);
    await waitChange(before, wait * 2);
  }
  if (!sorted && !note) note = 'could not switch to "Most Per Item"';

  // 2) read every page
  const best = new Map();           // item key -> { name, units: [], demand }
  let read = 0, ended = 'last page reached';
  for (let p = 0; p < maxPages; p++) {
    const page = orders();
    if (!page.length) { ended = 'a page had no orders'; break; }
    read++;
    for (const t of page) {
      const key = clean(t.name); if (!key) continue;
      const e = best.get(key) || { name: t.name, units: [], demand: 0 };
      e.units.push(t.o.unit); e.demand += t.o.remaining; best.set(key, e);
    }
    onPage(best, read);
    if ((Date.now() - started) / 1000 > maxSeconds) { ended = 'stopped after ' + maxSeconds + 's, will continue next time'; break; }
    const next = tiles().find(([, it]) => { const i = info(it); return !parseTile(i.lines) && /^(next|next page|>|→)$/i.test(i.name.trim()); })
      || tiles().find(([, it]) => { const i = info(it); return !parseTile(i.lines) && /next page/i.test(i.lines.join(' ')); });
    if (!next) break;
    const before = fingerprint();
    ah.clickItem(next[1], next[0]);
    if (!(await waitChange(before))) break;       // the page did not change: that was the last one
  }
  ah.closeAll();
  return { items: best, pages: read, sorted, note: [note, read >= maxPages ? 'page limit reached' : ended].filter(Boolean).join('; ') };
}

// Record what a scan found. `partial` = still running, don't count it as a finished scan.
function applyScan(board, scan, partial = false) {
  for (const [key, e] of scan.items) board.record(key, e.name, { top: Math.max(...e.units), n: e.units.length, demand: e.demand });
  if (partial) return;
  board.scans++; board.sorted = scan.sorted;
  board.note = scan.items.size ? `read ${scan.pages} page${scan.pages === 1 ? '' : 's'}, ${scan.items.size} items (${scan.note})` : (scan.note || 'no orders found on the page');
  board.progress = null;
  board.save();
}

module.exports = { OrderBoard, parseTile, scanOrders, applyScan, nonIncreasing, PRICE, DELIVERED };
