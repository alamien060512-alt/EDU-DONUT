// Offline test for the ledger: old history, a new buy -> listed -> sold, and a spreadsheet with the right numbers.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); process.chdir(tmp);
const { Ledger } = require('./ledger');
// history already on disk, like a bot that's been trading for a while
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/trades.json', JSON.stringify({ fee: 0, startBalance: 1478100, lastBalance: 1471001, nextId: 4, trades: [
  { id: 1, time: '2026-10-28T08:20:39.000Z', item: 'diamond', qty: 1, cost: 11099, listPrice: 15000, status: 'Sold' },
  { id: 2, time: '2026-10-28T09:21:35.000Z', item: 'diamond', qty: 1, cost: 10000, listPrice: 15000, status: 'Sold' },
  { id: 3, time: '2026-10-28T09:24:24.000Z', item: 'diamond', qty: 2, cost: 16000, listPrice: 30000, status: 'Listed' }] }));
(async () => {
  const L = new Ledger(console.log);
  assert.strictEqual(L.d.trades.length, 3);                       // loaded from disk
  L.balance(1471001);
  const id = L.addPurchase({ item: 'diamond', qty: 1, cost: 9000, balanceBefore: 1471001 });
  assert.strictEqual(L.d.trades.at(-1).status, 'Bought');
  L.setListed(id, 15000); assert.strictEqual(L.d.trades.at(-1).status, 'Listed');
  assert.strictEqual(L.markSold('Diamonds', 15000), true);        // the closest listing to 15K is id 4 (id 3 is the 30K stack)
  assert.strictEqual(L.d.trades.at(-1).status, 'Sold');
  assert.strictEqual(L.markSold('Diamond', 15000), false);        // nothing else is anywhere near 15K
  L.balance(1471001 + 15000 - 9000);
  await L.flush(); await new Promise((r) => setTimeout(r, 500));
  const S = L.summary();
  assert.strictEqual(S.spent, 11099 + 10000 + 16000 + 9000);
  assert.strictEqual(S.realized, (15000 - 11099) + (15000 - 10000) + (15000 - 9000));
  assert.ok(fs.existsSync('data/profit-vs-cost.xlsx') && fs.existsSync('data/trades.csv'));
  console.log('ledger ok; realized', S.realized, 'xlsx at', path.join(tmp, 'data/profit-vs-cost.xlsx'));
  // a brand-new install starts empty, nobody else's trades
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-new-')));
  delete require.cache[require.resolve('./ledger')];
  const fresh = new (require('./ledger').Ledger)(console.log);
  assert.strictEqual(fresh.d.trades.length, 0); assert.strictEqual(fresh.d.startBalance, null);
  console.log('fresh ledger ok');
})().catch((e) => { console.error(e); process.exit(1); });

