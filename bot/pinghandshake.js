// Usage: npm run pinghandshake [host] [port]   -> asks the server for its Bedrock status.
const dgram = require('dgram');
const host = process.argv[2] || process.env.SERVER_HOST || 'donutsmp.net';
const port = +(process.argv[3] || process.env.SERVER_PORT || 19132);
const s = dgram.createSocket('udp4');
const magic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const ping = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(8), magic, Buffer.alloc(8)]);
let tries = 0;
const send = () => { s.send(ping, port, host, (e) => e && console.log('send error:', e.message)); };
s.on('message', (m) => { global.__pong = true;
  const f = m.slice(35).toString().split(';');
  console.log(`ONLINE ${host}:${port}\n  name: ${f[1]}\n  game version: ${f[3]} (protocol ${f[2]})\n  players: ${f[4]}/${f[5]}\n  server's udp port: ${f[10] || '?'}`);
  clearInterval(t);
});
send();
var t = setInterval(() => {
  if (++tries >= 4) { if (global.__pong) return clearInterval(t); console.log(`No reply from ${host}:${port}. Wrong address/port, or your network blocks UDP.`); process.exit(1); }
  send();
}, 2000);

// ---- handshake probe: same first packet the bot sends, at several MTU sizes ----
const probe = dgram.createSocket('udp4');
const names = { 0x06: 'OpenConnectionReply1 (OK)', 0x19: 'IncompatibleProtocolVersion', 0x14: 'NoFreeIncomingConnections', 0x17: 'ConnectionBanned' };
const seen = {}; let curMtu = 0;
probe.on('message', (m) => { const k = names[m[0]] || '0x' + m[0].toString(16); seen[k] = (seen[k] || 0) + 1; if (m[0] === 0x06) (seen.workingMtu ||= []).push(curMtu); if (m[0] === 0x19) seen.serverProtocol = m[16]; });
const protoVersion = +process.env.RAK_PROTOCOL || 11;
setTimeout(() => {
  [1492, 1400, 1200, 1000, 800, 600, 576].forEach((mtu, i) => setTimeout(() => {
    curMtu = mtu;
    const b = Buffer.alloc(mtu - 28); b[0] = 0x05; magic.copy(b, 1); b[17] = protoVersion;
    probe.send(b, port, host);
  }, i * 500));
  setTimeout(() => { console.log('handshake probe (RakNet protocol ' + protoVersion + '):', Object.keys(seen).length ? JSON.stringify(seen) : 'NO REPLY to connection request'); process.exit(0); }, 4200);
}, 100);
