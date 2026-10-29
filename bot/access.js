// Who is allowed to talk to the bot's website and API.
//
// Default: only this computer can (127.0.0.1), no password needed.
// Away from home: set BOT_PASSWORD (the team password). Then every page needs a login, with three kinds of visitor:
//   public  not signed in. Only item prices and item details, and only if BOT_PUBLIC=1.
//   viewer  signed in with BOT_VIEW_PASSWORD (optional). Can see the bot's data, can't send commands.
//   team    signed in with BOT_PASSWORD. Can see the bot's data and, if BOT_REMOTE_CONTROL=1, send commands.
// The bot can spend money, so it refuses to listen on a network address without a password.
const crypto = require('crypto');

const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip'];
const isLoopback = (h) => /^(127\.|localhost$|::1$|\[::1\]$)/i.test(String(h || '').replace(/^::ffff:/i, ''));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

class Access {
  constructor(env = process.env, log = () => {}) {
    this.log = log;
    let host = env.BOT_HOST || '127.0.0.1', password = env.BOT_PASSWORD || '', view = env.BOT_VIEW_PASSWORD || '';
    if (password && password.length < 8) { log('BOT_PASSWORD is shorter than 8 characters, ignoring it'); password = ''; }
    if (view && view.length < 8) { log('BOT_VIEW_PASSWORD is shorter than 8 characters, ignoring it'); view = ''; }
    if (view && view === password) view = '';
    if (!isLoopback(host) && !password) {
      log(`BOT_HOST=${host} needs a BOT_PASSWORD (8+ characters). Refusing to open the bot to the network, staying on 127.0.0.1.`);
      host = '127.0.0.1';
    }
    this.host = host;
    this.password = password;
    this.viewPassword = view;
    this.passwordMode = !!password;
    if (env.BOT_PUBLIC === '1' && !this.passwordMode) log('BOT_PUBLIC=1 needs a BOT_PASSWORD too, ignoring it');
    this.publicMode = env.BOT_PUBLIC === '1' && this.passwordMode;
    this.remoteControl = env.BOT_REMOTE_CONTROL === '1';
    this.secureCookie = env.BOT_COOKIE_SECURE === '1';
    this.sessions = new Map();     // token -> { exp, role }
    this.failures = new Map();     // ip -> timestamps of recent wrong passwords
    this.hits = new Map();         // ip -> timestamps of recent public requests
  }

  // ---- helpers ----
  // The visitor's address. Behind a tunnel on this computer the real address is in a header; we only trust
  // that header when the connection itself comes from this computer.
  clientIp(req) {
    const remote = req.socket.remoteAddress || '?';
    if (isLoopback(remote)) {
      const f = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (f) return f;
    }
    return remote;
  }
  cookie(req) {
    const m = /(?:^|;\s*)bot_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    return m && m[1];
  }
  roleOf(req) {
    const t = this.cookie(req), s = t && this.sessions.get(t);
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(t); return null; }
    return s.role;
  }
  // Pages and data a not-signed-in visitor may see when BOT_PUBLIC=1: item prices only.
  isPublicPath(p) {
    return p === '/' || p === '/index.html' || p === '/session' || p === '/market' || p.startsWith('/market/');
  }
  // Commands (which can spend money) need the team login AND the remote-control switch.
  canControl(req) {
    if (!this.passwordMode) return true;
    return !!req && req.role === 'team' && this.remoteControl;
  }
  // The page may only post commands from its own address.
  sameOrigin(req) {
    const o = req.headers.origin;
    if (!o) return true;                                   // curl and same-origin GETs send no Origin
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  }
  tooManyFailures(ip) {
    const now = Date.now(), list = (this.failures.get(ip) || []).filter((t) => now - t < 10 * 60000);
    this.failures.set(ip, list);
    return list.length >= 5;
  }
  rateLimited(ip, max = 240) {                              // public visitors: 240 requests a minute
    const now = Date.now(), list = (this.hits.get(ip) || []).filter((t) => now - t < 60000);
    list.push(now); this.hits.set(ip, list);
    if (this.hits.size > 5000) this.hits.clear();
    return list.length > max;
  }
  // Which login does this password match? 'team', 'viewer' or null.
  roleForPassword(given) {
    if (same(given, this.password)) return 'team';
    if (this.viewPassword && same(given, this.viewPassword)) return 'viewer';
    return null;
  }

  async readForm(req) {
    let b = '';
    for await (const d of req) { b += d; if (b.length > 2000) break; }
    return new URLSearchParams(b);
  }
  page(res, status, msg = '') {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot login</title>
<style>:root{color-scheme:light dark}body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:Canvas;color:CanvasText}
form{width:min(340px,90vw);display:grid;gap:12px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #8886}button{background:#c2255c;color:#fff;border-color:#c2255c;font-weight:600;cursor:pointer}
p{margin:0;color:#c92a2a;min-height:1.3em}</style></head><body><form method="post" action="/login"><h1 style="margin:0">DonutSMP bot</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus aria-label="Password"><button type="submit">Log in</button><p role="alert">${msg}</p>${this.publicMode ? '<a href="/">Back to the public prices</a>' : ''}</form></body></html>`);
  }

  // Runs before every request. Returns true when it already answered (login page, redirect, refusal).
  // Otherwise it sets req.role to 'team', 'viewer' or 'public' for the handler to use.
  async gate(req, res, u) {
    const ip = this.clientIp(req);
    if (!this.passwordMode) {
      // Local-only mode. Refuse odd Host headers (DNS rebinding) and anything that came through a proxy or tunnel.
      const hostOk = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
      const proxied = FORWARD_HEADERS.some((h) => req.headers[h]);
      if (!hostOk || proxied) { res.writeHead(403); res.end(proxied ? 'forbidden: this bot has no password, so it only answers on this computer (set BOT_PASSWORD to use it remotely)' : 'forbidden host'); return true; }
      req.role = 'team';
      return false;
    }
    if (u.pathname === '/login') {
      if (req.method !== 'POST') { this.page(res, 200); return true; }
      if (this.tooManyFailures(ip)) { this.page(res, 429, 'Too many wrong passwords. Wait 10 minutes.'); return true; }
      const pw = (await this.readForm(req)).get('password') || '';
      const role = this.roleForPassword(pw);
      if (!role) {
        this.failures.get(ip).push(Date.now());
        await new Promise((r) => setTimeout(r, 600));       // slows down guessing
        this.page(res, 401, 'Wrong password.'); return true;
      }
      const token = crypto.randomBytes(32).toString('hex');
      this.sessions.set(token, { exp: Date.now() + 7 * 86400000, role });
      const secure = this.secureCookie || req.headers['x-forwarded-proto'] === 'https';
      res.writeHead(302, { location: '/', 'set-cookie': `bot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}` });
      res.end(); return true;
    }
    if (u.pathname === '/logout') {
      const t = this.cookie(req); if (t) this.sessions.delete(t);
      res.writeHead(302, { location: this.publicMode ? '/' : '/login', 'set-cookie': 'bot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); res.end(); return true;
    }
    const role = this.roleOf(req);
    if (role) { req.role = role; return false; }
    if (this.publicMode && this.isPublicPath(u.pathname)) {
      if (this.rateLimited(ip)) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'slow down' })); return true; }
      req.role = 'public'; return false;
    }
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) { res.writeHead(302, { location: '/login' }); res.end(); return true; }
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'login required' })); return true;
  }
}

module.exports = { Access, isLoopback };
