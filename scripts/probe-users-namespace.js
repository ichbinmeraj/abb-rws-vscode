// Walk /users namespace to discover what user/grant management is available.
// We're hunting for: a grant or setting that lets a remote user change op-mode
// without the FlexPendant confirmation popup.

const https = require('https');
const net = require('net');

const HOST = process.env.HOST || '127.0.0.1';
const USER = process.env.RWS_USER || 'Admin';
const PASS = process.env.RWS_PASS || 'robotics';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let sessionCookie = null;
let port = Number(process.env.PORT) || 0;

function req(method, path, body) {
  return new Promise(resolve => {
    const headers = { Authorization: AUTH, Accept: 'application/xhtml+xml;v=2.0' };
    if (sessionCookie) { headers.Cookie = sessionCookie; }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;v=2.0';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request({ host: HOST, port, path, method, headers, agent: httpsAgent, rejectUnauthorized: false }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) {
          const ct = sc.find(c => /^(-http-session-|ABBCX|http-session)=/.test(c));
          if (ct) { sessionCookie = ct.split(';')[0]; }
        }
        resolve({ status: res.statusCode, body: data });
      });
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (body !== undefined) { r.write(body); }
    r.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function probePort(p) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: HOST, port: p, timeout: 1000 });
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

function snippet(body, max = 250) {
  return body
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/, '')
    .replace(/<html[^>]*>|<head>[\s\S]*?<\/head>|<\/?body[^>]*>|<\/html>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function tryEndpoint(method, path, body) {
  const r = await req(method, path, body);
  await sleep(200);
  const status = r.status;
  if (status === 0) {
    console.log(`  ${method.padEnd(4)} ${path.padEnd(40)} → conn err`);
    return;
  }
  const ok = status >= 200 && status < 300 ? '✓' : '✗';
  console.log(`  ${ok} ${method.padEnd(4)} ${path.padEnd(40)} → ${status}`);
  if (r.body && (status < 300 || (r.body.includes('<span') || r.body.includes('msg')))) {
    console.log(`        ${snippet(r.body, 200)}`);
  }
}

async function main() {
  if (!port) {
    for (const p of [5466, 9403, 443, 80, 11811]) {
      if (await probePort(p)) { port = p; break; }
    }
    if (!port) { console.error('No RWS port reachable'); process.exit(1); }
  }
  console.log(`Connected to ${HOST}:${port} as ${USER}\n`);

  // Discover the /users namespace — print FULL body so we see real hrefs
  console.log('## /users namespace discovery');
  const usersResp = await req('GET', '/users');
  await sleep(300);
  console.log(`  GET /users → ${usersResp.status}`);
  if (usersResp.status === 200) {
    const aHrefs = [...usersResp.body.matchAll(/<a[^>]+href="([^"]+)"/g)].map(m => m[1]);
    console.log(`  All hrefs found in body:`);
    for (const h of aHrefs) { console.log(`    href="${h}"`); }
    console.log();
  }
  // Probe what was discovered
  await tryEndpoint('GET', '/users/grant-exists');
  await tryEndpoint('GET', '/users/grant-exists?grantname=UAS_RAPID');
  await tryEndpoint('GET', '/users/grant-exists?grantname=UAS_BYPASS_CONFIRMATION');
  await tryEndpoint('GET', '/users/rmmp/poll');
  await tryEndpoint('GET', '/users/rmmp');
  await tryEndpoint('GET', '/users/loginget');
  await tryEndpoint('GET', '/users/login');
  await tryEndpoint('GET', '/users/logininfo');
  await tryEndpoint('GET', '/users/info');
  await tryEndpoint('GET', '/users/grants');
  await tryEndpoint('GET', '/users/userinfo');
  await tryEndpoint('GET', '/users/uaslog');
  await tryEndpoint('GET', '/users/whoami');
  await tryEndpoint('GET', '/users/current');
  await tryEndpoint('GET', `/users/${USER}`);
  await tryEndpoint('GET', `/users/${USER}/grants`);

  console.log('\n## Per-grant exploration');
  // Common grants we expect to exist
  const grants = [
    'UAS_RAPID_FULL', 'UAS_REMOTE_LOGIN', 'UAS_BYPASS_CONFIRMATION',
    'UAS_OPMODE_CHANGE', 'UAS_REMOTE_OPMODE', 'UAS_REMOTE_MODIFY',
    'UAS_OPERATING_MODE', 'remote_login', 'modify_current_value',
    'edit_rapid', 'execute_program', 'authorize_remote_actions',
    'auto_grant_remote', 'auto_grant_modify',
  ];
  for (const g of grants) {
    await tryEndpoint('GET', `/users/grants/${g}`);
  }

  console.log('\n## RMMP detail (for reference)');
  await tryEndpoint('GET', '/users/rmmp');
  await tryEndpoint('GET', '/users/rmmpemergency');
  await tryEndpoint('GET', '/users/remoteclient');

  // Also explore /ctrl which often has admin-level controls
  console.log('\n## /ctrl namespace (admin / controller-level)');
  await tryEndpoint('GET', '/ctrl');
  await tryEndpoint('GET', '/ctrl/safety');
  await tryEndpoint('GET', '/ctrl/safety/settings');
  await tryEndpoint('GET', '/ctrl/safety/settings/opmode');

  // RW7 has a /rw/system/uas type endpoint sometimes
  console.log('\n## /rw/system probes');
  await tryEndpoint('GET', '/rw/system');
  await tryEndpoint('GET', '/rw/system/uas');
  await tryEndpoint('GET', '/rw/system/users');

  await req('GET', '/logout');
}

main().catch(e => { console.error(e); process.exit(1); });
