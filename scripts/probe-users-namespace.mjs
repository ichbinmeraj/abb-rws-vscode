// Walk /users namespace to discover what user/grant management is available.
// We're hunting for: a grant or setting that lets a remote user change op-mode
// without the FlexPendant confirmation popup.

// Env: RWS2_URL RWS_USER RWS_PASS HOST PORT (see scripts/lib/probe-common.mjs)
import { HOST, makeSession, tcpPing, sleep } from './lib/probe-common.mjs';

const USER = process.env.RWS_USER || 'Admin';

let session = null;
const req = (method, path, body) => session.req(method, path, body);

async function resolveBase() {
  if (process.env.RWS2_URL) { return new URL(process.env.RWS2_URL); }
  if (process.env.PORT) { return new URL(`https://${HOST}:${process.env.PORT}`); }
  for (const p of [5466, 9403, 443, 80, 11811]) {
    if (await tcpPing(p, HOST, 1000)) { return new URL(`https://${HOST}:${p}`); }
  }
  return null;
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
  const base = await resolveBase();
  if (!base) { console.error('No RWS port reachable'); process.exit(1); }
  session = makeSession(base, { user: USER });
  console.log(`Connected to ${base.host} as ${USER}\n`);

  // Discover the /users namespace - print FULL body so we see real hrefs
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

  await session.logout();
}

main().catch(e => { console.error(e); process.exit(1); });
