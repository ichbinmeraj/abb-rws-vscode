// One GET /rw/system: does the controller still answer? Used after each host
// test step and after the host exits. RobotWare 7/8 answer 401 without
// credentials, so on a 401 the request is sent once more with Basic (RWS 2.0)
// or Digest (RWS 1.0) credentials, and the session that opens is logged out.
// getSystem resolves to the HTTP status of the GET, or a short error text;
// getResource reads any one resource the same way (the operation-mode lock
// state, the system name and version).

'use strict';
const crypto = require('node:crypto');

function send(base, method, p, headers) {
  const u = new URL(base);
  const mod = require(u.protocol === 'https:' ? 'node:https' : 'node:http');
  return new Promise(resolve => {
    const req = mod.request(`${u.origin}${p}`, { method, rejectUnauthorized: false, timeout: 15000, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'no answer in 15 s' }); });
    req.on('error', e => resolve({ status: e.code || e.message }));
    req.end();
  });
}

function digestHeader(challenge, user, pass, method, uri) {
  const f = {};
  for (const m of challenge.matchAll(/(\w+)="?([^",]*)"?/g)) { f[m[1]] = m[2]; }
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${user}:${f.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = f.qop ? md5(`${ha1}:${f.nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${f.nonce}:${ha2}`);
  return `Digest username="${user}", realm="${f.realm}", nonce="${f.nonce}", uri="${uri}", response="${response}"`
    + (f.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : '') + (f.opaque ? `, opaque="${f.opaque}"` : '');
}

/** GET one resource; on a 401 once more with credentials, then log out. Resolves to { status, body }. */
async function getResource(base, user, pass, p) {
  const accept = { Accept: 'application/xhtml+xml;v=2.0' };
  const first = await send(base, 'GET', p, accept);
  if (first.status !== 401) { return { status: first.status, body: first.body || '' }; }
  const challenge = String(first.headers['www-authenticate'] || '');
  const auth = /^Digest/i.test(challenge)
    ? digestHeader(challenge, user, pass, 'GET', p)
    : `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const accept2 = /^Digest/i.test(challenge) ? { Accept: 'application/xhtml+xml;v=1.0' } : accept;
  const second = await send(base, 'GET', p, { ...accept2, Authorization: auth });
  const cookies = [].concat(second.headers && second.headers['set-cookie'] || []).map(c => c.split(';')[0]);
  if (cookies.length) { await send(base, 'GET', '/logout', { ...accept2, Cookie: cookies.join('; ') }); }
  return { status: second.status, body: second.body || '' };
}

async function getSystem(base, user, pass) {
  return (await getResource(base, user, pass, '/rw/system')).status;
}

/** The text of the first element with this class in an XHTML answer. */
function spanText(body, cls) {
  const m = new RegExp(`class="${cls}"[^>]*>([^<]*)<`).exec(body || '');
  return m ? m[1].trim() : undefined;
}

/** GET /rw/panel/opmode/lock-state (RWS 2.0): { status, lockstate }, lockstate e.g. unlocked or permlocked. */
async function getLockState(base, user, pass) {
  const r = await getResource(base, user, pass, '/rw/panel/opmode/lock-state');
  const lockstate = spanText(r.body, 'lockstate');
  return lockstate ? { status: r.status, lockstate } : { status: r.status, body: String(r.body).slice(0, 300) };
}

module.exports = { getSystem, getResource, getLockState, spanText };
