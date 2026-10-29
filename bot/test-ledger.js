// Offline check of the ledger: seed history, new buy -> listed -> sold, spreadsheet written with correct numbers.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); process.chdir(tmp);
const { Ledger } = require('./ledger');
(async () => {
  const L = new Ledger(console.log);
  assert.strictEqual(L.d.trades.length, 3);                       // seeded history
  L.balance(1471001);
  const id = L.addPurchase({ item: 'diamond', qty: 1, cost: 9000, balanceBefore: 1471001 });
  assert.strictEqual(L.d.trades.at(-1).status, 'Bought');
  L.setListed(id, 15000); assert.strictEqual(L.d.trades.at(-1).status, 'Listed');
  assert.strictEqual(L.markSold('Diamonds', 15000), true);        // matches the oldest-closest Listed diamond (id 3 is 30K, so id 4)
  assert.strictEqual(L.d.trades.at(-1).status, 'Sold');
  assert.strictEqual(L.markSold('Diamond', 15000), false);        // nothing else at ~15K
  L.balance(1471001 + 15000 - 9000);
  await L.flush(); await new Promise((r) => setTimeout(r, 500));
  const S = L.summary();
  assert.strictEqual(S.spent, 11099 + 10000 + 16000 + 9000);
  assert.strictEqual(S.realized, (15000 - 11099) + (15000 - 10000) + (15000 - 9000));
  assert.ok(fs.existsSync('data/profit-vs-cost.xlsx') && fs.existsSync('data/trades.csv'));
  console.log('ledger ok; realized', S.realized, 'xlsx at', path.join(tmp, 'data/profit-vs-cost.xlsx'));
})().catch((e) => { console.error(e); process.exit(1); });
