// Offline test for the price board: recording, history, 24h change and filtering.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'market-')));
const { Market, Watchlist, pretty } = require('./market');
const m = new Market(console.log);
m.record('diamond', 'Diamond', [12500, 11000, 30000, 0, 12700, 13000, 14000], 'ingame');
const it = m.items.diamond;
assert.strictEqual(it.low, 11000);                                   // cheapest wins, the 0 price is ignored
assert.strictEqual(it.n, 6);
assert.strictEqual(Math.round(it.avg5), Math.round((11000 + 12500 + 12700 + 13000 + 14000) / 5));
assert.strictEqual(it.history.length, 1);
m.record('diamond', 'Diamond', [11000], 'ingame');                   // same price within 5 min: no new history point
assert.strictEqual(it.history.length, 1);
m.record('diamond', 'Diamond', [10500], 'ingame');                   // price moved: new point
assert.strictEqual(it.history.length, 2);
assert.strictEqual(m.change(it), null);                              // under an hour of history: no 24h change yet
it.history = [[Date.now() - 25 * 3600000, 10000], [Date.now() - 3600000, 11000], [Date.now(), 12000]]; it.low = 12000;
assert.ok(Math.abs(m.change(it) - 0.2) < 1e-9);                     // +20% vs 25 hours ago
assert.strictEqual(m.list()[0].name, 'Diamond');
assert.strictEqual(m.get('nope'), null);
m.save(); assert.ok(fs.existsSync('data/market.json'));
assert.strictEqual(new Market().items.diamond.low, 12000);           // loads back from disk
assert.strictEqual(pretty('netherite_ingot'), 'Netherite Ingot');
const w = new Watchlist(); const n = w.items.length;
assert.ok(w.add('Ender Pearl') === false && w.add('minecraft:Wither Rose') === true && w.items.length === n + 1);
assert.ok(w.remove('wither_rose') && w.items.length === n);
console.log('market ok');
