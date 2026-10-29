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
const form2 = (pw) => ({ method: 'POST', path: '/login', body: 'password=' + encodeURIComponent(pw), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
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

  assert.strictEqual(new Access({ BOT_PASSWORD: 'correct horse battery', BOT_REMOTE_CONTROL: '1' }).canControl({ role: 'team' }), true);
  assert.strictEqual(new Access({ BOT_PASSWORD: 'correct horse battery', BOT_REMOTE_CONTROL: '1' }).canControl({ role: 'viewer' }), false);   // viewers never send commands
  assert.strictEqual(new Access({ BOT_PASSWORD: 'correct horse battery' }).canControl({ role: 'team' }), false);                              // team needs the switch too

  // public prices + team + viewer
  const logs2 = [];
  assert.strictEqual(new Access({ BOT_PUBLIC: '1' }, (m) => logs2.push(m)).publicMode, false);       // needs a password
  a = new Access({ BOT_PASSWORD: 'team password here', BOT_VIEW_PASSWORD: 'viewer password here', BOT_PUBLIC: '1', BOT_REMOTE_CONTROL: '1' });
  const seen = []; const srv2 = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (await a.gate(req, res, u)) return; seen.push(req.role); res.writeHead(200); res.end(req.role); });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r)); const port2 = srv2.address().port;
  assert.strictEqual((await call(port2, { path: '/market' })).body, 'public');                          // prices need no login
  assert.strictEqual((await call(port2, { path: '/market/diamond' })).body, 'public');
  assert.strictEqual((await call(port2, { path: '/session' })).body, 'public');
  assert.strictEqual((await call(port2, { path: '/trades', headers: { accept: 'application/json' } })).status, 401);   // bot data does not
  for (const path of ['/rules', '/log', '/holdings', '/status', '/prices']) assert.strictEqual((await call(port2, { path, headers: { accept: 'application/json' } })).status, 401, path);
  assert.strictEqual((await call(port2, { path: '/command', method: 'POST', headers: { accept: 'application/json' } })).status, 401);
  const team = await call(port2, form2('team password here')); const tc = team.headers['set-cookie'][0].split(';')[0];
  assert.strictEqual((await call(port2, { path: '/trades', headers: { cookie: tc } })).body, 'team');
  const viewer = await call(port2, form2('viewer password here')); const vc = viewer.headers['set-cookie'][0].split(';')[0];
  assert.strictEqual((await call(port2, { path: '/trades', headers: { cookie: vc } })).body, 'viewer');
  assert.strictEqual(a.canControl({ role: 'viewer' }), false); assert.strictEqual(a.canControl({ role: 'team' }), true);
  // public visitors are rate limited per address; a tunnel's real address comes from the header
  const fake = (h) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: h });
  assert.strictEqual(a.clientIp(fake({ 'cf-connecting-ip': '9.9.9.9' })), '9.9.9.9');
  assert.strictEqual(a.clientIp({ socket: { remoteAddress: '8.8.8.8' }, headers: { 'cf-connecting-ip': '9.9.9.9' } }), '8.8.8.8'); // header ignored when not from this computer
  assert.strictEqual(a.clientIp(fake({ 'x-forwarded-for': '5.6.7.8, 127.0.0.1' })), '5.6.7.8');       // a proxy such as Caddy on this computer
  assert.strictEqual(a.clientIp({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '5.6.7.8' } }), '5.6.7.8');
  assert.strictEqual(a.clientIp({ socket: { remoteAddress: '8.8.8.8' }, headers: { 'x-forwarded-for': '5.6.7.8' } }), '8.8.8.8');   // spoofed header from outside is ignored
  let limited = 0; for (let i = 0; i < 260; i++) if (a.rateLimited('1.1.1.1')) limited++;
  assert.ok(limited >= 15);
  srv2.close();

  console.log('access ok');
})().catch((e) => { console.error(e); process.exit(1); });
