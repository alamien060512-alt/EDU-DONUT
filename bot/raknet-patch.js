// Fixes for jsp-raknet (the pure-JS RakNet) so it can talk to a current Bedrock server:
//  - RakNet protocol 10 -> 11. The server quietly ignores 10.
//  - MTU probing. It only steps down 1400 -> 1000 and then gives up, but DonutSMP's path drops big
//    packets. Now it steps down by 200 all the way to 576 and tries a bit longer.
const fs = require('fs');
const f = require.resolve('jsp-raknet/js/Client.js');
let src = fs.readFileSync(f, 'utf8');
const before = src;
src = src.replace('const RAKNET_PROTOCOL = 10;', 'const RAKNET_PROTOCOL = 11;')
  .replace('const MAX_CONNECTION_TRIES = 5;', 'const MAX_CONNECTION_TRIES = 8;')
  .replace('this.mtuSize -= 100;', 'this.mtuSize = Math.max(576, this.mtuSize - 200);')
  .replace('await sleep(1500);', 'await sleep(1200);');
if (src !== before) fs.writeFileSync(f, src);

// The server's OpenConnectionReply1 is 32 bytes because "security" is on: it carries a 4-byte cookie that
// has to be echoed back (plus a challenge byte) in OpenConnectionRequest2. jsp-raknet ignores the cookie,
// so the server never answered step 2.
function patchFile(rel, pairs) {
  const file = require.resolve('jsp-raknet/js/' + rel);
  let s = fs.readFileSync(file, 'utf8'), o = s;
  for (const [a, b] of pairs) if (s.includes(a)) s = s.replace(a, b);
  if (s !== o) fs.writeFileSync(file, s);
}
patchFile('protocol/OpenConnectionReply1.js', [[
  'this.readByte(); // Secure\n        this.mtuSize = this.readShort();',
  'const secure = this.readByte(); // Secure\n        if (secure) this.cookie = this.read(4);\n        this.mtuSize = this.readShort();']]);
patchFile('protocol/OpenConnectionRequest2.js', [[
  'this.writeMagic();\n        this.writeAddress(this.serverAddress);',
  'this.writeMagic();\n        if (this.cookie) { this.append(this.cookie); this.writeByte(0); }\n        this.writeAddress(this.serverAddress);']]);
patchFile('Client.js', [[
  'packet.clientGUID = this.id;\n        packet.serverAddress',
  'packet.clientGUID = this.id;\n        packet.cookie = decodedPacket.cookie;\n        packet.serverAddress']]);

// Right after spawn the server sends a huge burst of chunks and overflows jsp-raknet's 256-slot windows.
// Packets past the window were thrown away but still ACKed, so the server never resent them and the
// encryption counter fell out of sync ("Checksum mismatch"). Bigger windows now, and we only ACK what we kept.
patchFile('Connection.js', [
  ['this.receiveWindow = new SlidingReceiveWindow(256);', 'this.receiveWindow = new SlidingReceiveWindow(16384);'],
  ['this.reliableReceiveWindow = new SlidingOrderedWindow(256);', 'this.reliableReceiveWindow = new SlidingOrderedWindow(16384);'],
  ['this.ackQueue.push(dataPacket.sequenceNumber);\n        this.receiveWindow.set(', 'if (dataPacket.sequenceNumber <= this.receiveWindow.windowEnd) this.ackQueue.push(dataPacket.sequenceNumber);\n        this.receiveWindow.set('],
]);

// RakNet says ReliableOrdered frames are delivered by orderIndex (per channel), after split packets are put
// back together. jsp-raknet used the reliable messageIndex instead, so a small packet sent between the pieces
// of a big one got processed first and broke the encrypted stream ("Checksum mismatch"). messageIndex is now
// only used to drop duplicates.
(function patchOrdering() {
  const file = require.resolve('jsp-raknet/js/Connection.js');
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('handleOrdered(')) return;
  const a = s.indexOf('    recievePacket(packet) {');
  const b = s.indexOf('    handleSplit(packet) {');
  if (a < 0 || b < 0) return;
  const recv = `    recievePacket(packet) {
        if (packet.isReliable()) {
            const seen = this._seenReliable || (this._seenReliable = new Set());
            if (seen.has(packet.messageIndex)) return;
            seen.add(packet.messageIndex);
            if (seen.size > 40000) { let n = 0; for (const k of seen) { seen.delete(k); if (++n > 20000) break; } }
        }
        this.handlePacket(packet);
    }
    handleOrdered(pk) {
        const ch = pk.orderChannel || 0;
        const next = this._nextOrder || (this._nextOrder = new Map());
        const bufs = this._orderBuf || (this._orderBuf = new Map());
        let st = next.get(ch) || 0;
        if (pk.orderIndex < st) return;
        let buf = bufs.get(ch);
        if (!buf) bufs.set(ch, buf = new Map());
        buf.set(pk.orderIndex, pk);
        while (buf.has(st)) { const n = buf.get(st); buf.delete(st); st++; n.__ord = true; this.handlePacket(n); }
        next.set(ch, st);
    }
`;
  s = s.slice(0, a) + recv + s.slice(b);
  s = s.replace('this.splitPackets.delete(packet.splitID);\n            this.handlePacket(encapsulated);',
    'this.splitPackets.delete(packet.splitID);\n            encapsulated.reliability = packet.reliability; encapsulated.orderIndex = packet.orderIndex; encapsulated.orderChannel = packet.orderChannel; encapsulated.messageIndex = packet.messageIndex;\n            this.handlePacket(encapsulated);');
  s = s.replace("            this.handleSplit(packet);\n            return;\n        }\n        const id = packet.buffer.readUInt8();",
    "            this.handleSplit(packet);\n            return;\n        }\n        if (!packet.__ord && (packet.reliability === 3 || packet.reliability === 7)) { this.handleOrdered(packet); return; }\n        const id = packet.buffer.readUInt8();");
  fs.writeFileSync(file, s);
})();
