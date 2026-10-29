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

// ---- a fake order house ----
const ORDERS = [  // [item, price each, delivered, total]
  ['Diamond', 12000, 0, 64], ['Elytra', 650e6, 1, 2], ['Gilded Blackstone', 4e6, 0, 64], ['Diamond', 11000, 0, 10], ['Elytra', 700e6, 3, 10],
  ['Totem of Undying', 55000, 0, 5], ['Gilded Blackstone', 3.5e6, 10, 64], ['Coal', 100, 0, 999], ['Beacon', 900000, 0, 3], ['Elytra', 600e6, 0, 1],
];
class FakeAh {
  constructor() { this.sort = 'Recently Listed'; this.page = 0; this.clicks = []; this.closed = false; this.win = null; this.build(); }
  item(name, lore) { return { network_id: 1, count: 1, __name: name, __lore: lore }; }
  build() {
    const rows = this.sort === 'Most Per Item' ? [...ORDERS].sort((a, b) => b[1] - a[1]) : [...ORDERS].reverse();
    const pageRows = rows.slice(this.page * 4, this.page * 4 + 4), slots = new Map();
    pageRows.forEach((r, i) => slots.set(i, this.item(r[0], [`$ ${r[1] >= 1e6 ? r[1] / 1e6 + 'M' : r[1]} each`, `${r[2]}/${r[3]} delivered`])));
    slots.set(45, this.item('Sort', ['Click to change', 'Recently Listed', 'Most Per Item']));
    if ((this.page + 1) * 4 < rows.length) slots.set(53, this.item('Next Page', ['Click to go forward']));
    this.win = { id: 'first', slots };
  }
  async open(cmd) { assert.strictEqual(cmd, '/orders'); this.build(); return this.win; }
  nameOf(it) { return it.__name; }
  textOf(it) { return it.__lore; }
  clickItem(it, slot) {
    this.clicks.push(it.__name);
    if (it.__name === 'Sort') this.sort = this.sort === 'Recently Listed' ? 'Most Per Item' : 'Recently Listed';
    else if (it.__name === 'Next Page') this.page++;
    else throw new Error('clicked something that is not navigation: ' + it.__name);   // must never click an order
    this.build();
  }
  closeAll() { this.closed = true; }
}

(async () => {
  const ah = new FakeAh();
  const scan = await scanOrders(ah, { pages: 3, wait: 5 });
  assert.strictEqual(scan.sorted, true);
  assert.ok(ah.clicks.includes('Sort') && ah.closed);
  assert.ok(ah.clicks.every((c) => c === 'Sort' || c === 'Next Page'));            // read-only: only navigation was clicked
  assert.strictEqual(scan.pages, 3);
  assert.strictEqual(Math.max(...scan.items.get('elytra').units), 700e6);           // best elytra order
  assert.strictEqual(Math.max(...scan.items.get('gilded_blackstone').units), 4e6);
  assert.strictEqual(scan.items.get('elytra').demand, 7 + 1 + 1);                  // remaining: (10-3) + (2-1) + 1

  const board = new OrderBoard();
  applyScan(board, scan);
  const top = board.list();
  assert.strictEqual(top[0].item, 'elytra'); assert.strictEqual(top[0].top, 700e6);
  assert.strictEqual(top[1].item, 'gilded_blackstone'); assert.strictEqual(top[1].top, 4e6);
  assert.ok(top.every((x, i) => i === 0 || x.top <= top[i - 1].top));              // best first
  assert.ok(fs.existsSync('data/orders.json'));
  assert.strictEqual(new OrderBoard().list()[0].item, 'elytra');                   // reloads from disk

  // already sorted: no sort click needed
  const ah2 = new FakeAh(); ah2.sort = 'Most Per Item'; ah2.build();
  const s2 = await scanOrders(ah2, { pages: 1, wait: 5 }); assert.ok(s2.sorted && !ah2.clicks.includes('Sort'));
  // no sort button: still reads what is there and says so
  const ah3 = new FakeAh(); ah3.build = function () { FakeAh.prototype.build.call(this); this.win.slots.delete(45); };
  const s3 = await scanOrders(ah3, { pages: 1, wait: 5 }); assert.ok(/no sort button/.test(s3.note) && s3.items.size > 0);
  console.log('orders ok');
})().catch((e) => { console.error(e); process.exit(1); });
