// Offline test for inventory tracking, spotting where a bought item landed, and picking a hotbar slot.
const assert = require('assert'), { EventEmitter } = require('events');
const { AhDriver } = require('./ah');
const c = new EventEmitter(); const sent = [];
c.queue = (n, p) => sent.push([n, p]); c.entityId = 7n;
const ah = new AhDriver(c, () => {});
const it = (id, n) => ({ network_id: id, count: n, metadata: 0, has_stack_id: true, stack_id: 1, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } });
c.emit('inventory_content', { window_id: 'inventory', input: [it(5, 3), null, null, null, null, null, null, null, null, it(9, 1)] });
assert.strictEqual(ah.inv.size, 2);
const before = ah.snapshot();
c.emit('inventory_slot', { window_id: 'inventory', slot: 1, item: it(264, 1) });          // the bought diamond lands in slot 1
assert.strictEqual(ah.newSlot(before), 1);
ah.select(0); assert.strictEqual(sent.length, 0);                                     // slot 0 is already in hand, so nothing should be sent
ah.select(1);
assert.strictEqual(sent[0][0], 'mob_equipment'); assert.strictEqual(sent[0][1].selected_slot, 1); assert.strictEqual(sent[0][1].runtime_entity_id, 7n);
assert.throws(() => ah.select(9), /main-inventory/); assert.throws(() => ah.select(4), /nothing in/);
c.emit('inventory_slot', { window_id: 'inventory', slot: 1, item: { network_id: 0, count: 0 } });
assert.strictEqual(ah.inv.has(1), false);
console.log('inventory ok');

// When the server closes a window we answer it, and closeAll closes any leftovers.
const c2 = new EventEmitter(); const out = []; c2.queue = (n, p) => out.push([n, p]); c2.entityId = 1n;
const ah2 = new AhDriver(c2, () => {});
c2.emit('inventory_content', { window_id: 2, input: [it(7, 1)] });
assert.ok(ah2.other.has(2));
c2.emit('container_close', { window_id: 2, window_type: 'container' });
assert.deepStrictEqual(out[0], ['container_close', { window_id: 2, window_type: 'container', server: false }]);
assert.ok(!ah2.other.has(2));
c2.emit('inventory_content', { window_id: 6, input: [it(8, 1)] });
ah2.closeAll();
assert.ok(out.some(([n, p]) => n === 'container_close' && p.window_id === 6));
console.log('window closing ok');

// No close ping-pong: once we close a window ourselves, the server's echo gets no second reply.
const c3 = new EventEmitter(); const o3 = []; c3.queue = (n, p) => o3.push([n, p]); c3.entityId = 1n;
const ah3 = new AhDriver(c3, () => {});
c3.emit('inventory_content', { window_id: 5, input: [it(7, 1)] });
ah3.closeWindow(5); assert.strictEqual(o3.length, 1);
c3.emit('container_close', { window_id: 5, window_type: 'container' });   // the server echoes our close
assert.strictEqual(o3.length, 1);
console.log('no close ping-pong ok');
