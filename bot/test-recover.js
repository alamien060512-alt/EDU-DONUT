// Offline test: after repeated window timeouts the bot asks /bal. An answer means rest the scanners, no answer means reconnect.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-')));
Object.assign(process.env, { BOT_API_PORT: '8268', MARKET: '0', RECOVER_BAL_MS: '150', RECOVER_PAUSE_MS: '60000' }); delete process.env.DONUTSMP_API_KEY;
const { state, _test } = require('./index');

(async () => {
  const make = (answers) => ({ closed: 0, closeAll() {}, closeRecent() {}, close() {}, say(c) { if (answers && /bal/.test(c)) state.recentChat.push({ t: Date.now() + 1, msg: 'You have $ 1,478,100' }); } });
  let closed = 0;
  _test.setClient({ close: () => { closed++; } });

  _test.setAh(make(true));
  assert.strictEqual(await _test.recover('test'), 'alive');
  assert(_test.scannersResting(), 'scanners should rest when the server answers /bal');
  assert.strictEqual(closed, 0);

  _test.rest(); _test.setAh(make(false));
  assert.strictEqual(await _test.recover('test'), 'dead');
  assert(!_test.scannersResting());
  assert.strictEqual(closed, 1, 'a dead link must be closed so the reconnect starts');
  console.log('recover tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
