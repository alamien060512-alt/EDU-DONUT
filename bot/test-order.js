// Offline test for the ordering fix: out-of-order frames, a small packet in the middle of a split one, and a duplicate.
require('./raknet-patch');
const assert = require('assert');
const { Connection } = require('jsp-raknet/js/Connection');
const E = require('jsp-raknet/js/protocol/EncapsulatedPacket').default;
const c = Object.create(Connection.prototype);
c.splitPackets = new Map(); c.state = 1; c.inLog = () => {};
const got = [];
c.listener = { emit: (n, p) => got.push(p.buffer.toString()) };
const mk = (msg, ord, buf, o = {}) => Object.assign(new E(), { reliability: 3, messageIndex: msg, orderIndex: ord, orderChannel: 0, buffer: Buffer.from(buf) }, o);
c.recievePacket(mk(0, 0, '\xfe0'));
c.recievePacket(mk(4, 2, '\xfeB'));                                  // small packet sent between A's pieces
c.recievePacket(mk(5, 1, '\xfeA1', { split: true, splitCount: 2, splitID: 7, splitIndex: 0 }));
c.recievePacket(mk(5, 1, '\xfeA1', { split: true, splitCount: 2, splitID: 7, splitIndex: 0 })); // duplicate
c.recievePacket(mk(6, 1, 'A2', { split: true, splitCount: 2, splitID: 7, splitIndex: 1 }));
c.recievePacket(mk(7, 3, '\xfeC'));
assert.deepStrictEqual(got.map((x) => x.slice(1)), ['0', 'A1A2', 'B', 'C']);
console.log('ordering ok:', got.map((x) => x.slice(1)).join(' '));
