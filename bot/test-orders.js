// Offline test for the order-house reader: a fake /orders screen with a sort button and a next-page arrow.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'orders-')));
const { parseTile, scanOrders, applyScan, OrderBoard, nonIncreasing } = require('./orders');

// ---- parsing ----
assert.deepStrictEqual(parseTile(['Elytra', '$ 700M each', '3/10 delivered']), { unit: 7e8, delivered: 3, total: 10, remaining: 7 });
assert.strictEqual(parseTile(['Diamond', '$ 12,500 each']).unit, 12500);
assert.strictEqual(parseTile(['Next Page', 'Click to go forward']), null);
assert.strictEqual(parseTile(['Sort', 'Most Per Item', 'Recently Listed']), null);
assert.ok(nonIncreasing([9, 5, 5, 1])); assert.ok(!nonIncreasing([1, 5, 9])); assert.ok(!nonIncreasing([9, 5]));

// ---- a fake order house: elytra bids fill the first pages when sorted by price, like the real one ----
const ORDERS = [];       // [item, price each, delivered, total]
for (let i = 0; i < 12; i++) ORDERS.push(['Elytra', 700e6 - i * 1e6, i % 4, 10]);
ORDERS.push(['Spawner', 120e6, 0, 3], ['Spawner', 100e6, 1, 3], ['Gilded Blackstone', 4e6, 0, 64], ['Gilded Blackstone', 3.5e6, 10, 64], ['Gilded Blackstone', 3e6, 0, 64],
  ['Trident', 1.1e6, 0, 2], ['Beacon', 900000, 0, 3], ['Netherite Ingot', 450000, 2, 100], ['Totem of Undying', 55000, 0, 5],
  ['Diamond', 12000, 0, 64], ['Diamond', 11000, 0, 10], ['Diamond', 10000, 5, 10], ['Coal', 100, 0, 999], ['Coal', 90, 0, 50]);
const PER_PAGE = 4;
class FakeAh {
  constructor() { this.sort = 'Recently Listed'; this.page = 0; this.clicks = []; this.closed = false; this.win = null; this.build(); }
  item(name, lore) { return { network_id: 1, count: 1, __name: name, __lore: lore }; }
  build() {
    const rows = this.sort === 'Most Per Item' ? [...ORDERS].sort((a, b) => b[1] - a[1]) : [...ORDERS].reverse();
    const pageRows = rows.slice(this.page * PER_PAGE, this.page * PER_PAGE + PER_PAGE), slots = new Map();
    pageRows.forEach((r, i) => slots.set(i, this.item(r[0], [`$ ${r[1] >= 1e6 ? r[1] / 1e6 + 'M' : r[1]} each`, `${r[2]}/${r[3]} delivered`])));
    slots.set(45, this.item('Sort', ['Click to change', 'Recently Listed', 'Most Per Item']));
    if ((this.page + 1) * PER_PAGE < rows.length) slots.set(53, this.item('Next Page', ['Click to go forward']));
    this.win = { id: 'first', slots };
  }
  async open(cmd) { assert.strictEqual(cmd, '/orders'); this.build(); return this.win; }
  nameOf(it) { return it.__name; }
  textOf(it) { return it.__lore; }
  clickItem(it) {
    this.clicks.push(it.__name);
    if (it.__name === 'Sort') this.sort = this.sort === 'Recently Listed' ? 'Most Per Item' : 'Recently Listed';
    else if (it.__name === 'Next Page') this.page++;
    else throw new Error('clicked something that is not navigation: ' + it.__name);   // must never click an order
    this.build();
  }
  closeAll() { this.closed = true; }
}
const fast = { wait: 4, pollMs: 2 };
const names = [...new Set(ORDERS.map((o) => o[0]))];
const topOf = (n) => Math.max(...ORDERS.filter((o) => o[0] === n).map((o) => o[1]));

(async () => {
  // a full read covers EVERY item, even though the first pages are all elytra
  const ah = new FakeAh(); const seenPages = [];
  const scan = await scanOrders(ah, { ...fast, onPage: (best, n) => seenPages.push([n, best.size]) });
  assert.strictEqual(scan.sorted, true);
  assert.ok(ah.clicks.every((c) => c === 'Sort' || c === 'Next Page'));            // read-only: only navigation was clicked
  assert.ok(ah.closed);
  assert.strictEqual(scan.pages, Math.ceil(ORDERS.length / PER_PAGE));             // it reached the last page
  assert.strictEqual(scan.items.size, names.length);                               // every item, not just elytra
  for (const n of names) assert.strictEqual(Math.max(...scan.items.get(n.toLowerCase().replace(/ /g, '_')).units), topOf(n), n);
  assert.strictEqual(seenPages.length, scan.pages);                                // progress reported page by page
  assert.ok(seenPages[0][1] === 1 && seenPages[seenPages.length - 1][1] === names.length);   // page 1 is only elytra, later pages add items
  assert.strictEqual(scan.items.get('elytra').units.length, 12);
  assert.strictEqual(scan.items.get('elytra').demand, ORDERS.filter((o) => o[0] === 'Elytra').reduce((a, o) => a + (o[3] - o[2]), 0));

  const board = new OrderBoard();
  applyScan(board, scan);
  const top = board.list();
  assert.strictEqual(top.length, names.length);
  assert.deepStrictEqual(top.slice(0, 3).map((x) => x.item), ['elytra', 'spawner', 'gilded_blackstone']);
  assert.strictEqual(top[1].top, 120e6); assert.strictEqual(top[2].top, 4e6);
  assert.ok(top.every((x, i) => i === 0 || x.top <= top[i - 1].top));              // best first
  assert.ok(fs.existsSync('data/orders.json'));
  assert.strictEqual(new OrderBoard().list().length, names.length);                // reloads from disk

  // limits: a page cap and a time cap stop early and say so
  const a2 = new FakeAh(); const s2 = await scanOrders(a2, { ...fast, maxPages: 2 });
  assert.strictEqual(s2.pages, 2); assert.ok(/page limit/.test(s2.note));
  const a3 = new FakeAh(); const s3 = await scanOrders(a3, { ...fast, maxSeconds: -1 });
  assert.strictEqual(s3.pages, 1); assert.ok(/time limit/.test(s3.note) && s3.next === 1);

  // pausing for another job and carrying on gives exactly the same result as one full read
  const acc = new Map(); let r = await scanOrders(new FakeAh(), { ...fast, best: acc, yieldAfter: -1, shouldYield: () => true });
  assert.strictEqual(r.next, 1); assert.strictEqual(r.pages, 1);                     // read one page, then gave way
  let chunks = 1;
  while (r.next > 0 && chunks < 60) { r = await scanOrders(new FakeAh(), { ...fast, best: acc, startPage: r.next, yieldAfter: -1, shouldYield: () => true }); chunks++; }
  assert.strictEqual(r.next, 0);                                                    // finally reached the last page
  assert.strictEqual(chunks, Math.ceil(ORDERS.length / PER_PAGE));                  // one page per piece, none skipped or repeated
  assert.strictEqual(acc.size, names.length);
  for (const n of names) assert.strictEqual(Math.max(...acc.get(n.toLowerCase().replace(/ /g, '_')).units), topOf(n), 'resumed ' + n);
  assert.strictEqual(acc.get('elytra').units.length, 12);                           // no order counted twice
  const board2 = new OrderBoard(); applyScan(board2, { items: acc, sorted: true, next: 3, pages: 1, page: 3, note: 'x' });
  assert.strictEqual(board2.cursor, 3); assert.strictEqual(board2.scans, 0);       // a paused piece is not a finished read
  applyScan(board2, { items: acc, sorted: true, next: 0, pages: 1, page: 9, note: 'x' });
  assert.strictEqual(board2.cursor, 0); assert.strictEqual(board2.scans, 1); assert.ok(board2.lastFull);
  // a manual read never gives way
  const s6 = await scanOrders(new FakeAh(), { ...fast, yieldAfter: 1e9, shouldYield: () => true });
  assert.strictEqual(s6.next, 0); assert.strictEqual(s6.pages, Math.ceil(ORDERS.length / PER_PAGE));

  // already sorted: no sort click needed
  const ah2 = new FakeAh(); ah2.sort = 'Most Per Item'; ah2.build();
  const s4 = await scanOrders(ah2, { ...fast, maxPages: 1 }); assert.ok(s4.sorted && !ah2.clicks.includes('Sort'));
  // no sort button: still reads what is there and says so
  const ah3 = new FakeAh(); ah3.build = function () { FakeAh.prototype.build.call(this); this.win.slots.delete(45); };
  const s5 = await scanOrders(ah3, { ...fast, maxPages: 1 }); assert.ok(/no sort button/.test(s5.note) && s5.items.size > 0);
  console.log('orders ok');
})().catch((e) => { console.error(e); process.exit(1); });
