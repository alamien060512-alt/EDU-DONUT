// Auction-house driver over Bedrock (Geyser). The Java chest GUI shows up as a
// container: container_open -> inventory_content/slot, and clicks are
// item_stack_request actions that must quote the server's stack ids.
// UNTESTED against the live server: run with `dry` on first and watch `log`.
const { clean } = require('./strategy');

class AhDriver {
  constructor(client, log) {
    this.c = client; this.log = log;
    this.win = null;          // { id, type, slots: Map<slot,item> }
    this.reqId = -1;          // item_stack_request ids are negative and decrease
    this.waiters = [];
    this.events = [];         // recent window events, shown by inspectbuy / on timeout
    const ev = (e, extra) => { this.events.push(`${new Date().toISOString().slice(14, 23)} ${e} ${extra || ''}`.trim()); this.events = this.events.slice(-25); };
    this.sentClose = new Map(); // window id -> when we last sent a close, to avoid close ping-pong
    this.other = new Map();   // contents of windows we did not open ourselves (e.g. a confirm menu)
    this.pkts = {};
    this.timeline = [];       // every non-noisy packet with a short summary, for diagnosing a failed step
    const noisyName = /chunk|entity|time|latency|attributes|level_|sound|move_|block|biome|score|player_list|add_player|animate|actor|tick|particle|event|camera|health|mob_|network_stack|set_title|update_soft_enum|available_commands|commands/;
    client.on('packet', (d) => {
      const n = d && d.data && d.data.name; if (!n) return;
      this.pkts[n] = (this.pkts[n] || 0) + 1;
      if (noisyName.test(n)) return;
      const pr = d.data.params || {};
      let brief = '';
      if (n === 'text') brief = String(pr.message || '').replace(/§./g, '').slice(0, 100);
      else if (n === 'command_output') brief = JSON.stringify((pr.output || []).map((o) => o.message_id + ' ' + (o.parameters || []).join(','))).slice(0, 140);
      else if (n === 'disconnect') brief = String(pr.message || pr.reason || '').slice(0, 140);
      else if (n === 'container_open' || n === 'container_close') brief = 'id=' + pr.window_id;
      else if (n === 'modal_form_request') brief = String(pr.data || '').slice(0, 100);
      else if (n === 'inventory_content' || n === 'inventory_slot') brief = 'id=' + pr.window_id;
      this.timeline.push(`${new Date().toISOString().slice(17, 23)} ${n} ${brief}`.trim());
      if (this.timeline.length > 200) this.timeline.shift();
    });
    const noteOther = (id, slot, it) => {
      if (['inventory', 'offhand', 'armor', 'ui', 'hotbar', 'fixed_inventory', 'creative', 'first', 'none'].includes(String(id))) return;
      if (!this.other.has(id)) this.other.set(id, new Map());
      this.other.get(id).set(slot, it);
    };
    this.selected = 0;        // hotbar slot in hand (a new Bedrock player starts on slot 0)
    client.on('player_hotbar', (p) => { if (p.select_slot !== false && typeof p.selected_slot === 'number') this.selected = p.selected_slot; });
    this.inv = new Map();     // our own inventory: slot -> item (slots 0-8 are the hotbar)
    client.on('inventory_content', (p) => { if (p.window_id === 'inventory') { this.inv.clear(); (p.input || []).forEach((it, i) => { if (it && it.network_id) this.inv.set(i, it); }); } });
    client.on('inventory_slot', (p) => { if (p.window_id === 'inventory') { if (p.item && p.item.network_id) this.inv.set(p.slot, p.item); else this.inv.delete(p.slot); } });
    this.responses = [];      // item_stack_response statuses, for inspection
    client.on('item_stack_response', (p) => { ev('item_stack_response', (p.responses || []).map((r) => r.status).join(',')); for (const r of p.responses || []) this.responses.push({ status: r.status, id: r.request_id }); });
    client.on('container_open', (p) => {
      ev('container_open', `id=${p.window_id} type=${p.window_type}`);
      this.win = { id: p.window_id, type: p.window_type, slots: new Map() };
      this._wake();
    });
    client.on('container_close', (p) => {
      // A real client answers a server-side close; otherwise the server may think a menu is still open.
      const mine = this.sentClose.get(p.window_id);
      if (!(mine && Date.now() - mine < 3000)) {           // don't answer the echo of a close we just sent
        try { client.queue('container_close', { window_id: p.window_id, window_type: p.window_type, server: false }); this.sentClose.set(p.window_id, Date.now()); } catch {}
      }
      this.other.delete(p.window_id);
      this.container_close_inner(p);
    });
    this.container_close_inner = (p) => { ev('container_close', `id=${p.window_id} (ours=${this.win && this.win.id})`); if (this.win && p.window_id === this.win.id) this.win = null; };
    client.on('inventory_content', (p) => {
      (p.input || []).forEach((it, i) => noteOther(p.window_id, i, it));
      ev('inventory_content', `id=${p.window_id} items=${(p.input || []).filter((x) => x && x.network_id).length}/${(p.input || []).length}`);
      if (!this.win || p.window_id !== this.win.id) return;
      p.input.forEach((it, i) => this.win.slots.set(i, it));
      this._wake();
    });
    client.on('inventory_slot', (p) => {
      noteOther(p.window_id, p.slot, p.item);
      if (this.win && p.window_id === this.win.id) { this.win.slots.set(p.slot, p.item); this._wake(); }
    });
  }
  _wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  _until(pred, ms = 8000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), ms);
      const check = () => { if (pred()) { clearTimeout(t); res(); } else this.waiters.push(check); };
      check();
    });
  }
  say(cmd) {
    this.c.queue('command_request', {
      command: cmd.startsWith('/') ? cmd : '/' + cmd,
      origin: { type: 'player', uuid: '00000000-0000-0000-0000-000000000000', request_id: '', player_entity_id: 0n }, internal: false, version: '52',
    });
  }
  async open(cmd = '/ah', tries = 3) {
    let last = '';
    for (let i = 1; i <= tries; i++) {
      this.closeAll();            // tell the server to drop any window we may still hold
      this.win = null; this.events.push('-- open ' + cmd + (i > 1 ? ' (retry ' + i + ')' : ''));
      const mark = this.timeline.length;
      await new Promise((r) => setTimeout(r, i === 1 ? 400 : 2000 * i));
      this.say(cmd);
      try { await this._until(() => this.win && this.win.slots.size > 0, 6000); return this.win; }
      catch { last = this.timeline.slice(mark).filter((l) => !/inventory_|container_close/.test(l)).slice(-6).join(' | ') || '(server sent nothing)'; }
    }
    throw new Error('timeout waiting for the window after ' + tries + ' tries. Server said: ' + last);
  }
  nameOf(it) { return clean(it && (it.network_id ? it.__name || it.name : '') || ''); }
  // Click an item in a chest-style window (Java left-click = Bedrock "take" into the cursor).
  clickItem(it, slot, count) {
    const id = this.reqId; this.reqId -= 2;
    this.c.queue('item_stack_request', { requests: [{
      request_id: id,
      actions: [{ type_id: 'take', count: count || it.count || 1,
        source: { slot_type: { container_id: 'container' }, slot, stack_id: it.stack_id || 0 },
        destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 } }],
      custom_names: [], cause: -1,
    }] });
  }
  click(slot, count) { this.clickItem(this.win.slots.get(slot), slot, count); }
  // The confirm menu the server opens after a listing click: { id, confirm:{slot,item}, cancel:{slot,item}, shown:{slot,item} }.
  confirmMenu() {
    // Look in our own window ("first") as well as any extra windows.
    const wins = [];
    if (this.win) wins.push([this.win.id, this.win.slots]);
    for (const [id, slots] of this.other) wins.push([id, slots]);
    for (const [id, slots] of wins) {
      const find = (name) => [...slots].find(([, it]) => it && it.network_id && this.nameOf(it).toLowerCase() === name);
      const ok = find('confirm'), no = find('cancel');
      if (ok && no) {
        const shown = [...slots].find(([sl, it]) => it && it.network_id && sl !== ok[0] && sl !== no[0]);
        return { id, confirm: { slot: ok[0], item: ok[1] }, cancel: { slot: no[0], item: no[1] }, shown: shown && { slot: shown[0], item: shown[1] } };
      }
    }
    return null;
  }
  // Item NBT as a plain object: { display: { Name, Lore: [...] }, ench: [...] }, or {}.
  plain(it) {
    try {
      const nbt = it && (it.extra && it.extra.nbt || it.nbt);
      if (!nbt) return {};
      return require('prismarine-nbt').simplify(nbt.nbt || nbt) || {};
    } catch { return {}; }
  }
  // Display name, colour codes removed ('' when the item has none).
  nameOf(it) {
    const d = this.plain(it).display || {};
    return String(d.Name || '').replace(/§./g, '').trim();
  }
  enchanted(it) { const p = this.plain(it); return !!((p.ench && p.ench.length) || (p.Enchantments && p.Enchantments.length)); }
  // Name + lore lines as text, colour codes removed.
  textOf(it) {
    const d = this.plain(it).display || {};
    const lore = Array.isArray(d.Lore) ? d.Lore : (d.Lore ? [d.Lore] : []);
    return [d.Name, ...lore].filter(Boolean).map((x) => String(x).replace(/§./g, '').trim());
  }
  // Price per listing: the first lore line that mentions "price" (or a $ amount) and has a number.
  priceOf(it) {
    const lines = this.textOf(it);
    const line = lines.find((l) => /price/i.test(l) && /\d/.test(l)) || lines.find((l) => /\$\s*[\d]/.test(l));
    if (!line) return NaN;
    const m = /\$?\s*([\d][\d,]*(?:\.\d+)?)\s*([kmbKMB]?)/.exec(line.replace(/^.*?price\s*:?/i, ''));
    if (!m) return NaN;
    return parseFloat(m[1].replace(/,/g, '')) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()];
  }
  // Describe the open window: id, type and every non-empty slot (name, count, text).
  describe() {
    if (!this.win) return { window: null };
    const items = [...this.win.slots].filter(([, it]) => it && it.network_id)
      .map(([slot, it]) => ({ slot, name: this.nameOf(it), count: it.count, text: this.textOf(it).join(' | ').slice(0, 160) }));
    return { window: { id: this.win.id, type: this.win.type, slots: this.win.slots.size }, items };
  }
  // slot -> "network_id x count": compare two snapshots to find where a bought item landed.
  snapshot() { return new Map([...this.inv].map(([sl, it]) => [sl, `${it.network_id}x${it.count}`])); }
  newSlot(before) {
    for (const [sl, v] of this.snapshot()) if (before.get(sl) !== v) return sl;
    return null;
  }
  // Put a hotbar item in hand (Bedrock mob_equipment). Items outside the hotbar can't be selected.
  select(slot) {
    const it = this.inv.get(slot);
    if (!it) throw new Error('nothing in inventory slot ' + slot);
    if (slot > 8) throw new Error('item is in main-inventory slot ' + slot + ', not the hotbar (0-8)');
    if (slot === this.selected) return;   // already in hand; send nothing
    this.c.queue('mob_equipment', { runtime_entity_id: this.c.entityId, item: it, slot, selected_slot: slot, window_id: 'inventory' });
    this.selected = slot;
  }
  // Items of every extra window seen, with their slot numbers.
  describeOthers() {
    const out = {};
    for (const [id, slots] of this.other) {
      out['window ' + id] = [...slots].filter(([, it]) => it && it.network_id)
        .map(([slot, it]) => ({ slot, name: this.nameOf(it), count: it.count, text: this.textOf(it).join(' | ').slice(0, 160) }));
    }
    return out;
  }
  // Packet counts since the last reset, without the noisy world/entity ones.
  interestingPackets() {
    const noisy = /chunk|entity|time|latency|attributes|level_|sound|move_|block|biome|score|player_list|add_player|animate|actor|tick|particle|event|camera|health|mob_/;
    return Object.fromEntries(Object.entries(this.pkts).filter(([n]) => !noisy.test(n)));
  }
  // Close one window by id (e.g. a confirm menu); safe to call for an id the server already closed.
  closeWindow(id) {
    try { this.c.queue('container_close', { window_id: id, window_type: 'container', server: false }); this.sentClose.set(id, Date.now()); } catch {}
    this.other.delete(id);
    if (this.win && this.win.id === id) this.win = null;
  }
  closeAll() { for (const id of [...this.other.keys()]) this.closeWindow(id); this.close(); }
  close() {
    if (this.win) this.c.queue('container_close', { window_id: this.win.id, window_type: this.win.type, server: false });
    this.win = null;
  }
}
module.exports = { AhDriver };
