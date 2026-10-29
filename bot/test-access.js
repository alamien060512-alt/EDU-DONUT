// Offline test for the website access rules: local-only mode, password login, view-only, rate limit.
const assert = require('assert'), http = require('http');
const { Access } = require('./access');

function serve(access) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (await access.gate(req, res, u)) return;
      res.writeHead(200); res.end('OK');
    }).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const call = (port, opts = {}) => new Promise((resolve, reject) => {
  const body = opts.body, r = http.request({ port, host: '127.0.0.1', path: opts.path || '/', method: opts.method || 'GET', headers: { host: '127.0.0.1:' + port, ...(opts.headers || {}) } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});
const form = (pw) => ({ method: 'POST', path: '/login', body: 'password=' + encodeURIComponent(pw), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

(async () => {
  const logs = [];
  // config
  assert.strictEqual(new Access({ BOT_HOST: '0.0.0.0' }, (m) => logs.push(m)).host, '127.0.0.1');   // no password: refuse to open up
  assert.ok(logs.some((m) => /needs a BOT_PASSWORD/.test(m)));
  assert.strictEqual(new Access({ BOT_HOST: '0.0.0.0', BOT_PASSWORD: 'long-enough-pw' }).host, '0.0.0.0');
  assert.strictEqual(new Access({ BOT_PASSWORD: 'short' }).passwordMode, false);

  // local-only mode
  let a = new Access({}), s = await serve(a);
  assert.strictEqual((await call(s.port)).status, 200);
  assert.strictEqual((await call(s.port, { headers: { host: 'evil.example' } })).status, 403);                // DNS rebinding
  assert.strictEqual((await call(s.port, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 403);      // came through a tunnel
  assert.strictEqual(a.canControl(), true); s.srv.close();

  // password mode, view only
  a = new Access({ BOT_PASSWORD: 'correct horse battery' }); s = await serve(a);
  const r1 = await call(s.port, { headers: { accept: 'text/html' } });
  assert.strictEqual(r1.status, 302); assert.strictEqual(r1.headers.location, '/login');
  assert.strictEqual((await call(s.port, { path: '/market', headers: { accept: 'application/json' } })).status, 401);
  assert.strictEqual((await call(s.port, form('wrong'))).status, 401);
  const ok = await call(s.port, form('correct horse battery'));
  assert.strictEqual(ok.status, 302);
  const sc = ok.headers['set-cookie'][0]; assert.ok(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc));
  const cookie = sc.split(';')[0];
  assert.strictEqual((await call(s.port, { headers: { cookie } })).status, 200);                      // logged in
  assert.strictEqual(a.canControl(), false);                                                          // view only by default
  assert.strictEqual(a.sameOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:1' } }), false);
  assert.strictEqual(a.sameOrigin({ headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' } }), true);
  await call(s.port, { path: '/logout', headers: { cookie } });
  assert.strictEqual((await call(s.port, { path: '/x', headers: { cookie, accept: 'application/json' } })).status, 401); // logged out
  // rate limit: 5 wrong passwords in a row, then locked even for the right one
  for (let i = 0; i < 4; i++) await call(s.port, form('nope' + i));
  assert.strictEqual((await call(s.port, form('correct horse battery'))).status, 429);
  s.srv.close();

  assert.strictEqual(new Access({ BOT_PASSWORD: 'correct horse battery', BOT_REMOTE_CONTROL: '1' }).canControl(), true);
  console.log('access ok');
})().catch((e) => { console.error(e); process.exit(1); });
