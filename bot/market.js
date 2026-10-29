// The price board: lowest price per item plus its history. Filled by the in-game auction scanner, or by the
// official API if DONUTSMP_API_KEY is set. Saved to data/market.json.
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'market.json');
const WATCH_FILE = path.join(DIR, 'watchlist.json');
const DAY = 86400000;

const DEFAULT_WATCH = ['diamond', 'diamond_block', 'netherite_ingot', 'netherite_scrap', 'ancient_debris', 'emerald', 'emerald_block', 'gold_ingot', 'gold_block',
  'iron_ingot', 'iron_block', 'copper_ingot', 'coal', 'redstone', 'lapis_lazuli', 'quartz', 'amethyst_shard', 'ender_pearl', 'eye_of_ender', 'blaze_rod',
  'ghast_tear', 'nether_star', 'elytra', 'totem_of_undying', 'enchanted_golden_apple', 'golden_apple', 'shulker_shell', 'shulker_box', 'beacon', 'dragon_egg',
  'trident', 'heart_of_the_sea', 'nautilus_shell', 'spawner', 'experience_bottle', 'obsidian', 'crying_obsidian', 'tnt', 'end_crystal', 'gunpowder', 'slime_ball',
  'ender_chest', 'anvil', 'enchanting_table', 'netherite_sword', 'diamond_sword', 'netherite_pickaxe', 'diamond_pickaxe', 'netherite_axe', 'netherite_helmet',
  'netherite_chestplate', 'netherite_leggings', 'netherite_boots', 'mace', 'wind_charge', 'breeze_rod', 'trial_key', 'name_tag', 'saddle', 'wither_skeleton_skull',
  'dragon_head', 'golden_carrot', 'cooked_beef', 'oak_log', 'cobblestone', 'sand', 'glass', 'bone', 'string', 'arrow'];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pretty = (k) => k.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

class Watchlist {
  constructor() {
    this.items = DEFAULT_WATCH.slice();
    try { const j = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')); if (Array.isArray(j) && j.length) this.items = j; } catch {}
  }
  save() { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(WATCH_FILE, JSON.stringify(this.items)); } catch {} }
  add(k) { k = String(k).toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_'); if (k && !this.items.includes(k)) { this.items.push(k); this.save(); return true; } return false; }
  remove(k) { k = String(k).toLowerCase().replace(/\s+/g, '_'); const n = this.items.length; this.items = this.items.filter((x) => x !== k); this.save(); return this.items.length < n; }
}

class Market {
  constructor(log = () => {}) {
    this.log = log; this.items = {}; this.on = process.env.MARKET !== '0'; this.last = null; this.lastSave = 0; this.passes = 0; this.current = null;
    try { this.items = JSON.parse(fs.readFileSync(FILE, 'utf8')).items || {}; } catch {}
  }
  // units = per-item prices of the plain (not enchanted) listings we saw for this item.
  record(key, name, units, source) {
    units = units.filter((u) => u > 0).sort((a, b) => a - b);
    if (!units.length) return;
    const now = Date.now();
    const it = this.items[key] || (this.items[key] = { name: name || pretty(key), history: [] });
    it.name = name || it.name;
    it.low = units[0]; it.avg5 = mean(units.slice(0, 5)); it.n = units.length; it.updated = now; it.source = source;
    const h = it.history, prev = h[h.length - 1];
    if (!prev || prev[1] !== it.low || now - prev[0] >= 300000) h.push([now, it.low]);
    if (h.length > 1500) h.splice(0, h.length - 1500);
    this.last = now;
    if (now - this.lastSave > 30000) this.save();
  }
  save() {
    this.lastSave = Date.now();
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify({ items: this.items })); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { this.log('market save failed: ' + e.message); }
  }
  change(it) {          // % change since about 24h ago (or the oldest point we have). Needs at least an hour of history, else null.
    const h = it.history; if (h.length < 2) return null;
    const cutoff = Date.now() - DAY; let ref = h[0];
    for (const p of h) { if (p[0] <= cutoff) ref = p; else break; }
    if (Date.now() - ref[0] < 3600000 || !(ref[1] > 0)) return null;
    return (it.low - ref[1]) / ref[1];
  }
  list() {
    return Object.entries(this.items).map(([k, it]) => ({ item: k, name: it.name, low: it.low, avg5: it.avg5, n: it.n, updated: it.updated, change24h: this.change(it), spark: it.history.slice(-40).map((p) => p[1]) }));
  }
  get(k) { const it = this.items[k]; return it ? { item: k, name: it.name, low: it.low, avg5: it.avg5, n: it.n, updated: it.updated, change24h: this.change(it), source: it.source, history: it.history } : null; }
  status(watch) { return { scanning: this.on, tracked: Object.keys(this.items).length, watchlist: watch.items.length, lastUpdate: this.last, passes: this.passes, current: this.current }; }
}

module.exports = { Market, Watchlist, pretty, DEFAULT_WATCH };
