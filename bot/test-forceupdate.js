// Offline test for "market scan": forcing a price update of one item, several items, or the whole watchlist.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'force-')));
process.env.BOT_API_PORT = '8266'; process.env.MARKET_MS = '5'; process.env.MARKET = '1'; delete process.env.DONUTSMP_API_KEY;
const { AhDriver } = require('./ah');
const { run, state, _test } = require('./index');

// a fake auction house: /ah <name> shows listings of that item (cheapest first) in a window
const LISTINGS = { diamond: [[12500, 1], [13000, 1], [26000, 2]], elytra: [[3000000, 1], [3200000, 1]], coal: [[250, 1]] };
const fake = Object.create(AhDriver.prototype);
fake.opened = [];
fake.plain = (it) => ({ display: { Name: it.__name, Lore: it.__lore } });
fake.open = async (cmd) => {
  const name = cmd.replace('/ah ', ''), key = name.replace(/ /g, '_'), slots = new Map();
  (LISTINGS[key] || []).forEach(([price, count], i) => slots.set(i, { network_id: 1, count, __name: name.replace(/\b\w/g, (c) => c.toUpperCase()), __lore: ['$ ' + price + '', 'Seller: x'] }));
  fake.opened.push(key); return { id: 'first', slots };
};
fake.close = () => {}; fake.closeAll = () => {}; fake.closeRecent = () => {};

(async () => {
  assert.strictEqual(await run('market scan diamond'), 'not connected yet');           // needs the bot in game
  _test.setAh(fake);

  // one item: waits and returns its lowest price per item
  const one = await run('market scan diamond');
  assert.deepStrictEqual(one, { diamond: 12500 });
  assert.strictEqual(_test.market.items.diamond.low, 12500);
  assert.strictEqual(_test.market.items.diamond.n, 3);

  // several items, and an item with nothing listed
  const many = await run('market scan Elytra coal ender_pearl');
  assert.strictEqual(many.elytra, 3000000); assert.strictEqual(many.coal, 250); assert.strictEqual(many.ender_pearl, 'no plain listing found');

  // whole watchlist: runs in the background, only one at a time
  _test.watch.items = ['diamond', 'elytra', 'coal'];
  fake.opened.length = 0;
  const started = await run('market scan');
  assert.strictEqual(started.started, 3);
  assert.ok(/already running/.test(await run('market scan')));
  for (let i = 0; i < 100 && fake.opened.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(fake.opened, ['diamond', 'elytra', 'coal']);
  assert.ok(state.log.some((l) => /market update finished: 3 of 3/.test(l)));
  assert.ok(!/already running/.test(await run('market scan diamond') + ''));          // finished, so a new one is allowed

  console.log('force update ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
