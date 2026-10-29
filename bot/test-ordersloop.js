// Offline test: the order read gives way to other auction-house jobs, carries on afterwards, and `orders scan` does not hang.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'ordersloop-')));
Object.assign(process.env, { BOT_API_PORT: '8267', ORDERS_WAIT_MS: '4', ORDERS_YIELD_SECONDS: '0', MARKET: '0' }); delete process.env.DONUTSMP_API_KEY;
const { run, _test } = require('./index');

const ORDERS = [];
for (let i = 0; i < 9; i++) ORDERS.push(['Elytra', 700e6 - i * 1e6, 0, 10]);
ORDERS.push(['Spawner', 120e6, 0, 3], ['Gilded Blackstone', 4e6, 0, 64], ['Trident', 1.1e6, 0, 2], ['Beacon', 900000, 0, 3], ['Diamond', 12000, 0, 64], ['Coal', 100, 0, 999]);
const PER = 3, pages = Math.ceil(ORDERS.length / PER);
class Fake {   // an order house with a sort button and a next arrow
  constructor() { this.sort = 'Recently Listed'; this.page = 0; this.opens = 0; this.win = null; this.build(); }
  it(name, lore) { return { network_id: 1, count: 1, __name: name, __lore: lore }; }
  build() {
    const rows = this.sort === 'Most Per Item' ? [...ORDERS].sort((a, b) => b[1] - a[1]) : [...ORDERS].reverse(), slots = new Map();
    rows.slice(this.page * PER, this.page * PER + PER).forEach((r, i) => slots.set(i, this.it(r[0], [`$ ${r[1]} each`, `${r[2]}/${r[3]} delivered`])));
    slots.set(45, this.it('Sort', ['Recently Listed', 'Most Per Item']));
    if ((this.page + 1) * PER < rows.length) slots.set(53, this.it('Next Page', ['go']));
    this.win = { id: 'first', slots };
  }
  async open() { this.opens++; this.sort = 'Recently Listed'; this.page = 0; this.build(); return this.win; }
  nameOf(it) { return it.__name; } textOf(it) { return it.__lore; }
  clickItem(it) { if (it.__name === 'Sort') this.sort = 'Most Per Item'; else if (it.__name === 'Next Page') this.page++; else throw new Error('clicked ' + it.__name); this.build(); }
  closeAll() {}
}
const names = [...new Set(ORDERS.map((o) => o[0]))];

(async () => {
  const fake = new Fake(); _test.setAh(fake);
  const board = _test.orderBoard;

  // 1) a trading job is waiting: the read gives way, the job runs, the read carries on and finishes with every item
  const reads = []; let tradeRan = 0, tradeAt = -1;
  const first = _test.ordersOnce(false);
  const trade = _test.withAh(async () => { tradeRan++; tradeAt = reads.length; return 'traded'; });
  reads.push(await first);
  assert.strictEqual(reads[0], 'paused');                          // gave way
  assert.strictEqual(await trade, 'traded'); assert.strictEqual(tradeRan, 1);   // the trade got its turn before the read carried on
  assert.ok(board.cursor > 0 && board.scans === 0);                // paused, not finished
  for (let i = 0; i < 40 && reads[reads.length - 1] === 'paused'; i++) reads.push(await _test.ordersOnce(false));
  assert.strictEqual(reads[reads.length - 1], 'done');
  assert.strictEqual(board.cursor, 0); assert.strictEqual(board.scans, 1);
  const top = board.list();
  assert.strictEqual(top.length, names.length);                    // every item
  assert.deepStrictEqual(top.slice(0, 3).map((x) => x.item), ['elytra', 'spawner', 'gilded_blackstone']);
  assert.strictEqual(top[0].n, 9);                                 // 9 elytra orders, none counted twice across the pauses
  assert.ok(fake.opens > 1);                                       // it re-opened /orders to continue

  // 2) `orders scan` (manual): returns at once, never gives way, and finishes
  const before = board.scans;
  const res = await run('orders scan');
  assert.ok(res.started);
  assert.ok(/already running/.test(await run('orders scan')));     // not twice at once
  for (let i = 0; i < 200 && board.scans === before; i++) await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(board.scans, before + 1);
  assert.ok(board.lastFull);

  console.log('orders loop ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
