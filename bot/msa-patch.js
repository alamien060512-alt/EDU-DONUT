// Replaces prismarine-auth's Microsoft device-code polling with a tolerant one.
// The stock loop aborts on the first "invalid_grant / user could not be authenticated"
// reply, and its retry wrapper then starts overlapping sign-ins with a used code.
// Here: one sign-in at a time, keep polling through that reply until the code expires.
const LiveTokenManager = require('prismarine-auth/src/TokenManagers/LiveTokenManager');
const { Endpoints } = require('prismarine-auth/src/common/Constants');

let inflight = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function authDeviceCode(deviceCodeCallback) {
  if (inflight) return inflight;
  inflight = (async () => {
    const form = (o) => ({ method: 'post', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
    const r = await fetch(Endpoints.live.deviceCodeRequest, form({ scope: this.scopes, client_id: this.clientId, response_type: 'device_code' }));
    if (r.status !== 200) throw new Error('Failed to request live.com device code: ' + r.status + ' ' + (await r.text()));
    const res = await r.json();
    res.message = `To sign in, open https://www.microsoft.com/link and enter the code ${res.user_code}`;
    deviceCodeCallback(res);
    const expires = Date.now() + res.expires_in * 1000 - 1000;
    let last = '';
    while (Date.now() < expires) {
      await sleep(Math.max(res.interval || 5, 5) * 1000);
      const j = await fetch(Endpoints.live.tokenRequest,
        form({ client_id: this.clientId, device_code: res.device_code, grant_type: 'device_code' /* same as MinecraftAuth (RaphiMC) */ })).then((x) => x.json()).catch((e) => ({ error: 'network', error_description: e.message }));
      if (!j.error) { await this.updateCache(j); return { accessToken: j.access_token }; }
      if (j.error !== last) { console.log(`[msa] waiting (${j.error}) ${String(j.error_description || '').split('\r')[0].slice(0, 120)}`); last = j.error; }
      if (['expired_token', 'access_denied', 'authorization_declined'].includes(j.error)) throw new Error('Sign-in failed: ' + j.error);
    }
    throw new Error('Sign-in code expired; run again');
  })().finally(() => { inflight = null; });
  return inflight;
}

LiveTokenManager.prototype.authDeviceCode = authDeviceCode;
