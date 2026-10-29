// Drives the auction house over Bedrock. DonutSMP runs Geyser, so the Java chest menus show up here as
// containers: the server sends container_open and inventory_content, and to click something we send an
// item_stack_request that quotes the item's stack id.
const { clean } = require('./strategy');

class AhDriver {
  constructor(client, log) {
    this.c = client; this.log = log;
    this.win = null;          // the window we have open: { id, type, slots }
    this.reqId = -1;          // request ids go negative and count down, that's what the protocol wants
    this.waiters = [];
    this.events = [];         // last few window events, printed by inspectbuy and when a window times out
    const ev = (e, extra) => { this.events.push(`${new Date().toISOString().slice(14, 23)} ${e} ${extra || ''}`.trim()); this.events = this.events.slice(-25); };
    this.sentClose = new Map(); // when we last sent a close for each window, so we don't answer our own echo
    this.other = new Map();   // windows the server opened on us (like the confirm menu), we never asked for these
    this.pkts = {};
    this.timeline = [];       // short log of the interesting packets, handy when a step fails
    const noisyName = /chunk|entity|time|latency|attributes|level_|sound|move_|block|biome|score|player_list|add_player|animate|actor|tick|particle|event|camera|health|mob_|network_stack|update_soft_enum|available_commands|commands/;
    client.on('packet', (d) => {
      const n = d && d.data && d.data.name; if (!n) return;
      this.lastPacketAt = Date.now();
      this.pkts[n] = (this.pkts[n] || 0) + 1;
      const pr = d.data.params || {};
      if (n === 'set_title' && !String(pr.text || '').trim()) return;    // empty title packets are just noise
      if (noisyName.test(n)) return;
      let brief = '';
      if (n === 'text') brief = String(pr.message || '').replace(/§./g, '').slice(0, 100);
      else if (n === 'command_output') brief = JSON.stringify((pr.output || []).map((o) => o.message_id + ' ' + (o.parameters || []).join(','))).slice(0, 140);
      else if (n === 'disconnect') brief = String(pr.message || pr.reason || '').slice(0, 140);
      else if (n === 'container_open' || n === 'container_close') brief = 'id=' + pr.window_id;
      else if (n === 'set_title') brief = String(pr.text || '').replace(/§./g, '').slice(0, 100);
      else if (n === 'toast_request') brief = String(pr.title || '') + ' ' + String(pr.message || '');
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
    this.selected = 0;        // which hotbar slot is in hand (new players start on slot 0)
    client.on('player_hotbar', (p) => { if (p.select_slot !== false && typeof p.selected_slot === 'number') this.selected = p.selected_slot; });
    this.inv = new Map();     // our own inventory, slot -> item. Slots 0-8 are the hotbar
    client.on('inventory_content', (p) => { if (p.window_id === 'inventory') { this.inv.clear(); (p.input || []).forEach((it, i) => { if (it && it.network_id) this.inv.set(i, it); }); } });
    client.on('inventory_slot', (p) => { if (p.window_id === 'inventory') { if (p.item && p.item.network_id) this.inv.set(p.slot, p.item); else this.inv.delete(p.slot); } });
    this.responses = [];      // item_stack_response statuses, just for debugging
    client.on('item_stack_response', (p) => { ev('item_stack_response', (p.responses || []).map((r) => r.status).join(',')); for (const r of p.responses || []) this.responses.push({ status: r.status, id: r.request_id }); });
    client.on('container_open', (p) => {
      ev('container_open', `id=${p.window_id} type=${p.window_type}`);
      this.win = { id: p.window_id, type: p.window_type, slots: new Map() };
      this._wake();
    });
    client.on('container_close', (p) => {
      // A real client answers when the server closes a window. If we don't, the server can think the menu is still open.
      const mine = this.sentClose.get(p.window_id);
      if (!(mine && Date.now() - mine < 3000)) {           // skip it if this is just the echo of a close we sent
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
      this.closeAll();            // make sure the server has nothing of ours left open
      if (i > 1) this.closeRecent();   // a retry: be thorough and close every window we have seen lately
      this.win = null; this.events.push('-- open ' + cmd + (i > 1 ? ' (retry ' + i + ')' : ''));
      const mark = this.timeline.length;
      await new Promise((r) => setTimeout(r, i === 1 ? 400 : 2000 * i));
      this.say(cmd);
      try { await this._until(() => this.win && this.win.slots.size > 0, 6000); return this.win; }
      catch { last = this.timeline.slice(mark).filter((l) => !/inventory_|container_close/.test(l)).slice(-6).join(' | ') || '(server sent nothing)'; }
    }
    throw new Error('timeout waiting for the window after ' + tries + ' tries. Server said: ' + last + ' (last packet from the server ' + Math.round((Date.now() - (this.lastPacketAt || 0)) / 1000) + 's ago)');
  }
  nameOf(it) { return clean(it && (it.network_id ? it.__name || it.name : '') || ''); }
  // Click an item in a chest-style window. A Java left click is a "take into cursor" on Bedrock.
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
  // After you click a listing the server opens a confirm menu. This finds it and returns the Confirm and Cancel
  // buttons plus the item it shows: { id, confirm:{slot,item}, cancel:{slot,item}, shown:{slot,item} }.
  confirmMenu() {
    // check our own window ("first") and any extra windows
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
  // The item's NBT as a plain object ({ display: { Name, Lore }, ench }), or {} if it has none.
  plain(it) {
    try {
      const nbt = it && (it.extra && it.extra.nbt || it.nbt);
      if (!nbt) return {};
      return require('prismarine-nbt').simplify(nbt.nbt || nbt) || {};
    } catch { return {}; }
  }
  // The item's display name without colour codes ('' if it has no name).
  nameOf(it) {
    const d = this.plain(it).display || {};
    return String(d.Name || '').replace(/§./g, '').trim();
  }
  enchanted(it) { const p = this.plain(it); return !!((p.ench && p.ench.length) || (p.Enchantments && p.Enchantments.length)); }
  // Name plus lore lines as plain text.
  textOf(it) {
    const d = this.plain(it).display || {};
    const lore = Array.isArray(d.Lore) ? d.Lore : (d.Lore ? [d.Lore] : []);
    return [d.Name, ...lore].filter(Boolean).map((x) => String(x).replace(/§./g, '').trim());
  }
  // Reads the price off the item: the first lore line that mentions "price" (or has a $ amount) with a number in it.
  priceOf(it) {
    const lines = this.textOf(it);
    const line = lines.find((l) => /price/i.test(l) && /\d/.test(l)) || lines.find((l) => /\$\s*[\d]/.test(l));
    if (!line) return NaN;
    const m = /\$?\s*([\d][\d,]*(?:\.\d+)?)\s*([kmbKMB]?)/.exec(line.replace(/^.*?price\s*:?/i, ''));
    if (!m) return NaN;
    return parseFloat(m[1].replace(/,/g, '')) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()];
  }
  // Quick summary of the open window: id, type and every filled slot.
  describe() {
    if (!this.win) return { window: null };
    const items = [...this.win.slots].filter(([, it]) => it && it.network_id)
      .map(([slot, it]) => ({ slot, name: this.nameOf(it), count: it.count, text: this.textOf(it).join(' | ').slice(0, 160) }));
    return { window: { id: this.win.id, type: this.win.type, slots: this.win.slots.size }, items };
  }
  // Turns the inventory into slot -> "id x count". Compare two of these to see where a bought item went.
  snapshot() { return new Map([...this.inv].map(([sl, it]) => [sl, `${it.network_id}x${it.count}`])); }
  newSlot(before) {
    for (const [sl, v] of this.snapshot()) if (before.get(sl) !== v) return sl;
    return null;
  }
  // Put a hotbar item in hand. Only hotbar slots work, anything else throws.
  select(slot) {
    const it = this.inv.get(slot);
    if (!it) throw new Error('nothing in inventory slot ' + slot);
    if (slot > 8) throw new Error('item is in main-inventory slot ' + slot + ', not the hotbar (0-8)');
    if (slot === this.selected) return;   // already in hand, nothing to send
    this.c.queue('mob_equipment', { runtime_entity_id: this.c.entityId, item: it, slot, selected_slot: slot, window_id: 'inventory' });
    this.selected = slot;
  }
  // What's in the extra windows we've seen, with slot numbers.
  describeOthers() {
    const out = {};
    for (const [id, slots] of this.other) {
      out['window ' + id] = [...slots].filter(([, it]) => it && it.network_id)
        .map(([slot, it]) => ({ slot, name: this.nameOf(it), count: it.count, text: this.textOf(it).join(' | ').slice(0, 160) }));
    }
    return out;
  }
  // Packet counts since the last reset, leaving out the noisy world and entity ones.
  interestingPackets() {
    const noisy = /chunk|entity|time|latency|attributes|level_|sound|move_|block|biome|score|player_list|add_player|animate|actor|tick|particle|event|camera|health|mob_/;
    return Object.fromEntries(Object.entries(this.pkts).filter(([n]) => !noisy.test(n)));
  }
  // Close every window id we have seen lately, in case the server still thinks one is open. Unknown ids are ignored by the server.
  closeRecent() {
    const ids = new Set([...this.other.keys()]);
    for (const l of this.timeline.slice(-120)) { const m = /(?:container_open|inventory_content) id=(\S+)/.exec(l); if (m) ids.add(isNaN(m[1]) ? m[1] : +m[1]); }
    for (const id of ids) if (!['inventory', 'offhand', 'armor', 'ui', 'hotbar', 'fixed_inventory', 'creative', 'none'].includes(String(id))) this.closeWindow(id);
  }
  // Close one window by id (a confirm menu, say). Harmless if the server already closed it.
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
