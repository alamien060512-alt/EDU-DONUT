// Pure trading logic, no network. A rule says: buy `item` at or below `maxPrice`
// (per unit), then relist at maxPrice-paid * sellMultiple (default 2x).
const clean = (s) => String(s || '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');

// "1.5k" "2m" "3b" "250" -> number
function parsePrice(s) {
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) return NaN;
  return +m[1] * { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
}

class Rules {
  constructor() { this.rules = new Map(); }
  add(item, maxPrice, sellMultiple = 2, sellUnit = null) {
    const key = clean(item);
    if (!key || !(maxPrice > 0)) throw new Error('need an item and a positive price');
    const r = { item: key, maxPrice, sellMultiple, sellUnit };
    this.rules.set(key, r);
    return r;
  }
  remove(item) { return this.rules.delete(clean(item)); }
  list() { return [...this.rules.values()]; }
  // listing: { item, price (total), count }
  matches(listing) {
    const r = this.rules.get(clean(listing.item));
    if (!r || !(listing.count > 0)) return null;
    const unit = listing.price / listing.count;
    return unit <= r.maxPrice ? { rule: r, unit } : null;
  }
  sellPrice(item, paidUnit, count) {
    const r = this.rules.get(clean(item));
    if (r && r.sellUnit) return Math.floor(r.sellUnit * count); // fixed per-item sell price
    const mult = r ? r.sellMultiple : 2;
    return Math.floor(paidUnit * mult * count);
  }
}

// buy <item> <maxPrice> [sell <unitPrice> | <multiple>]
function parseBuy(args) {
  const [item, max, a, b] = args;
  const maxPrice = parsePrice(max);
  if (!item || !(maxPrice > 0)) throw new Error('usage: buy <item> <maxPrice> [sell <price> | <multiple>]');
  if (a === 'sell') {
    const sellUnit = parsePrice(b);
    if (!(sellUnit > 0)) throw new Error('usage: buy <item> <maxPrice> sell <price>');
    return { item, maxPrice, sellMultiple: 2, sellUnit };
  }
  const sellMultiple = a === undefined ? 2 : parseFloat(a);
  if (!(sellMultiple > 0)) throw new Error('multiple must be a positive number, e.g. 1.02');
  return { item, maxPrice, sellMultiple, sellUnit: null };
}

module.exports = { Rules, parsePrice, parseBuy, clean };
