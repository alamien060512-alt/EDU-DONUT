// Offline check: library encryptor -> our decryptor, incl. very large batches.
require('./crypto-patch');
const assert = require('assert'), crypto = require('crypto');
const enc = require('bedrock-protocol/src/transforms/encryption');
const key = crypto.randomBytes(32), iv = crypto.randomBytes(16);
const mk = () => ({ versionLessThan: () => false, secretKeyBytes: key, features: { compressorInHeader: true }, compressionLevel: 7, emit(n, e) { throw e; }, disconnect() {} });
const tx = mk(), rx = mk(), blobs = [], out = [];
tx.onEncryptedPacket = (b) => blobs.push(b);
const send = enc.createEncryptor(tx, iv);
rx.onDecryptedPacket = (b) => out.push(b);
const recv = enc.createDecryptor(rx, iv);
const sizes = [10, 5000, 70000, 400000, 3000000, 20, 900000];
const plain = sizes.map((n) => crypto.randomBytes(n));
plain.forEach(send);
setImmediate(() => {
  assert.strictEqual(blobs.length, plain.length);
  blobs.forEach(recv);
  assert.strictEqual(out.length, plain.length);
  out.forEach((o, i) => assert(o.equals(plain[i])));
  console.log('crypto ok:', sizes.join(','));
});
