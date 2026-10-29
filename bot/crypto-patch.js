// bedrock-protocol decrypts through a Node stream and assumes every write comes back out as exactly one
// 'data' event. If the runtime splits or merges chunks on big packets, the checksum gets read from the
// wrong spot and the connection dies with "Checksum mismatch". So here each packet is decrypted with a
// single cipher.update() call, which can't get split.
const crypto = require('crypto');
const Zlib = require('zlib');
const enc = require('bedrock-protocol/src/transforms/encryption');

function computeCheckSum(plain, counter, key) {
  const c = Buffer.alloc(8); c.writeBigInt64LE(counter, 0);
  return crypto.createHash('sha256').update(c).update(plain).update(key).digest().slice(0, 8);
}

enc.createDecryptor = function (client, iv) {
  client.decipher = client.versionLessThan('1.16.220')
    ? enc.createDecipher(client.secretKeyBytes, iv, 'aes-256-cfb8')
    : enc.createDecipher(client.secretKeyBytes, iv.slice(0, 12), 'aes-256-gcm');
  client.receiveCounter = client.receiveCounter || 0n;
  return (blob) => {
    const chunk = client.decipher.update(blob);
    const packet = chunk.slice(0, chunk.length - 8), checksum = chunk.slice(chunk.length - 8);
    const want = computeCheckSum(packet, client.receiveCounter, client.secretKeyBytes);
    client.receiveCounter++;
    if (!checksum.equals(want)) {
      client.emit('error', Error(`Checksum mismatch ${checksum.toString('hex')} != ${want.toString('hex')} (packet ${blob.length}B, #${client.receiveCounter - 1n})`));
      client.disconnect('disconnectionScreen.badPacket');
      return;
    }
    let buffer;
    if (client.features.compressorInHeader) {
      if (packet[0] === 0) buffer = Zlib.inflateRawSync(packet.slice(1), { chunkSize: 512000 });
      else if (packet[0] === 255) buffer = packet.slice(1);
      else { client.emit('error', Error('Unsupported compressor: ' + packet[0])); return; }
    } else buffer = Zlib.inflateRawSync(packet, { chunkSize: 512000 });
    client.onDecryptedPacket(buffer);
  };
};
