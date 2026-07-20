/* RWS endpoint coverage test - runs against live VCs, reuses one session.
 * Usage: node test-coverage.js
 * Env: RWS2_URL RWS1_URL RWS_USER RWS_PASS HOST (see scripts/lib/probe-common.mjs)
 * Without RWS2_URL/RWS1_URL it auto-discovers a controller (5466/9403/443/etc.)
 */
import { HOST, RWS1_URL, makeSession, tcpPing } from './scripts/lib/probe-common.mjs';

const results = [];
let session = null;
const req = (method, _port, path, body) => session.req(method, path, body);

async function findBase() {
  const candidates = [];
  if (process.env.RWS2_URL) { candidates.push(process.env.RWS2_URL); }
  if (RWS1_URL) { candidates.push(RWS1_URL); }
  if (candidates.length === 0) {
    // Standard + a few common observed ports; 443/5466/9403 are HTTPS
    for (const p of [5466, 9403, 443, 11811, 16146, 28447, 80]) {
      const scheme = (p === 443 || p === 5466 || p === 9403) ? 'https' : 'http';
      candidates.push(`${scheme}://${HOST}:${p}`);
    }
  }
  for (const cand of candidates) {
    const url = new URL(cand);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    if (!(await tcpPing(port, url.hostname))) { continue; }
    const probe = makeSession(url, { timeoutMs: 5000 });
    const r = await probe.req('GET', '/rw/system');
    if (r.status === 200 || r.status === 401 || r.status === 503) {
      return { url, port, https: url.protocol === 'https:', session: probe };
    }
  }
  return null;
}

async function test(label, fn) {
  try {
    const r = await fn();
    const ok = r.status >= 200 && r.status < 400;
    results.push({ label, status: r.status, ok, hint: r.body ? r.body.slice(0, 80) : '' });
    process.stdout.write(ok ? '.' : 'F');
  } catch (e) {
    results.push({ label, status: 0, ok: false, hint: String(e).slice(0, 80) });
    process.stdout.write('!');
  }
}

(async () => {
  const found = await findBase();
  if (!found) { console.log('No controller reachable.'); process.exit(1); }
  session = found.session;
  const PORT = found.port;
  console.log(`Testing ${found.url.hostname}…`);
  console.log(`Found controller on port ${PORT} (${found.https ? 'HTTPS' : 'HTTP'})`);

  // Establish session
  await req('GET', PORT, '/rw/system');
  console.log(`Session cookie acquired: ${session.cookie ? 'yes' : 'no'}`);
  console.log('Running tests...\n');

  // === Wave 1: System / Panel / Motion / RAPID detail ===
  await test('W1 /rw/system/license',           () => req('GET', PORT, '/rw/system/license'));
  await test('W1 /rw/system/products',          () => req('GET', PORT, '/rw/system/products'));
  await test('W1 /rw/system/robottype',         () => req('GET', PORT, '/rw/system/robottype'));
  await test('W1 /rw/system/energy',            () => req('GET', PORT, '/rw/system/energy'));
  await test('W1 /rw/system/options',           () => req('GET', PORT, '/rw/system/options'));
  // retcode without filter (lists all known codes - works without a specific code)
  await test('W1 /rw/retcode (list)',            () => req('GET', PORT, '/rw/retcode'));
  await test('W1 /ctrl/options',                () => req('GET', PORT, '/ctrl/options'));
  await test('W1 /ctrl/features',               () => req('GET', PORT, '/ctrl/features'));
  await test('W1 /rw/motionsystem (change-count)', () => req('GET', PORT, '/rw/motionsystem?resource=change-count'));
  await test('W1 /rw/motionsystem/errorstate',  () => req('GET', PORT, '/rw/motionsystem/errorstate'));
  await test('W1 /rw/motionsystem/nonmotionexecution', () => req('GET', PORT, '/rw/motionsystem/nonmotionexecution'));
  await test('W1 /rw/motionsystem/collisionprediction', () => req('GET', PORT, '/rw/motionsystem/collisionprediction'));
  await test('W1 /rw/panel/enreq',              () => req('GET', PORT, '/rw/panel/enreq'));
  await test('W1 /rw/rapid/aliasio',            () => req('GET', PORT, '/rw/rapid/aliasio'));
  await test('W1 /rw/rapid/taskselection',      () => req('GET', PORT, '/rw/rapid/taskselection'));
  await test('W1 /rw/rapid/tasks/T_ROB1/pcp',   () => req('GET', PORT, '/rw/rapid/tasks/T_ROB1/pcp'));
  await test('W1 /rw/rapid/tasks/T_ROB1/syncstate/motion-pointer', () => req('GET', PORT, '/rw/rapid/tasks/T_ROB1/syncstate/motion-pointer'));

  // === Wave 2: CFG / Backup / Tool/WObj / DIPC ===
  await test('W2 /rw/cfg',                      () => req('GET', PORT, '/rw/cfg'));
  await test('W2 /rw/cfg/EIO',                  () => req('GET', PORT, '/rw/cfg/EIO'));
  await test('W2 /rw/cfg/MOC',                  () => req('GET', PORT, '/rw/cfg/MOC'));
  await test('W2 /rw/cfg/MOC/ARM',              () => req('GET', PORT, '/rw/cfg/MOC/ARM'));
  await test('W2 /rw/cfg/SYS',                  () => req('GET', PORT, '/rw/cfg/SYS'));
  await test('W2 /rw/cfg/PROC',                 () => req('GET', PORT, '/rw/cfg/PROC'));
  await test('W2 /rw/cfg/SIO',                  () => req('GET', PORT, '/rw/cfg/SIO'));
  await test('W2 /rw/cfg/MMC',                  () => req('GET', PORT, '/rw/cfg/MMC'));
  await test('W2 /ctrl/backup',                 () => req('GET', PORT, '/ctrl/backup'));
  await test('W2 /fileservice/BACKUP',          () => req('GET', PORT, '/fileservice/BACKUP'));
  await test('W2 /rw/motionsystem/mechunits/ROB_1 (tool/wobj)', () => req('GET', PORT, '/rw/motionsystem/mechunits/ROB_1'));
  await test('W2 /rw/dipc',                     () => req('GET', PORT, '/rw/dipc'));

  // === Wave 3: Vision / Safety / Virtual time / Certs / Registry ===
  await test('W3 /rw/vision',                   () => req('GET', PORT, '/rw/vision'));
  await test('W3 /ctrl/safety',                 () => req('GET', PORT, '/ctrl/safety'));
  await test('W3 /ctrl/virtualtime',            () => req('GET', PORT, '/ctrl/virtualtime'));
  await test('W3 /ctrl/certstore',              () => req('GET', PORT, '/ctrl/certstore'));
  await test('W3 /ctrl/registry',               () => req('GET', PORT, '/ctrl/registry'));
  await test('W3 /fileservice (volumes)',       () => req('GET', PORT, '/fileservice'));
  await test('W3 /fileservice/HOME',            () => req('GET', PORT, '/fileservice/HOME'));
  await test('W3 /fileservice/DATA',            () => req('GET', PORT, '/fileservice/DATA'));
  await test('W3 /fileservice/ADDINDATA',       () => req('GET', PORT, '/fileservice/ADDINDATA'));
  await test('W3 /fileservice/PRODUCTS',        () => req('GET', PORT, '/fileservice/PRODUCTS'));
  await test('W3 /fileservice/RAMDISK',         () => req('GET', PORT, '/fileservice/RAMDISK'));
  await test('W3 /fileservice/TEMP',            () => req('GET', PORT, '/fileservice/TEMP'));

  // === Wave 4: PP control / Breakpoints / Mechunit details ===
  await test('W4 /rw/rapid/tasks/T_ROB1/program/breakpoints', () => req('GET', PORT, '/rw/rapid/tasks/T_ROB1/program/breakpoints'));
  await test('W4 /rw/rapid/tasks/T_ROB1/structural-changecount', () => req('GET', PORT, '/rw/rapid/tasks/T_ROB1/structural-changecount'));
  await test('W4 /rw/rapid/tasks/T_ROB1/motion',  () => req('GET', PORT, '/rw/rapid/tasks/T_ROB1/motion'));
  await test('W4 /rw/rapid/tasks/T_ROB1/activation-record', () => req('GET', PORT, '/rw/rapid/tasks/T_ROB1/activation-record'));
  await test('W4 /rw/motionsystem/mechunits/ROB_1/baseframe', () => req('GET', PORT, '/rw/motionsystem/mechunits/ROB_1/baseframe'));
  await test('W4 /rw/motionsystem/mechunits/ROB_1/axes',   () => req('GET', PORT, '/rw/motionsystem/mechunits/ROB_1/axes'));
  await test('W4 /rw/motionsystem/mechunits/ROB_1/pjoints', () => req('GET', PORT, '/rw/motionsystem/mechunits/ROB_1/pjoints'));

  // === Existing endpoints (sanity) ===
  await test('OK /rw/system',                   () => req('GET', PORT, '/rw/system'));
  await test('OK /rw/panel/ctrl-state',         () => req('GET', PORT, '/rw/panel/ctrl-state'));
  await test('OK /rw/rapid/execution',          () => req('GET', PORT, '/rw/rapid/execution'));
  await test('OK /rw/rapid/tasks',              () => req('GET', PORT, '/rw/rapid/tasks'));
  await test('OK /rw/iosystem/signals',         () => req('GET', PORT, '/rw/iosystem/signals?start=0&limit=10'));
  await test('OK /users/rmmp',                  () => req('GET', PORT, '/users/rmmp'));

  console.log('\n\n=== Results ===\n');

  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  console.log(`Passed: ${ok.length} / ${results.length}`);
  console.log(`Failed: ${fail.length}\n`);

  console.log('--- Detailed ---');
  for (const r of results) {
    const tag = r.ok ? '✓' : '✗';
    console.log(`${tag} [${r.status}] ${r.label}`);
    if (!r.ok) {
      // Extract ABB error message if present
      const err = r.hint.match(/<span class="msg">([^<]+)/);
      if (err) { console.log(`     ${err[1].slice(0, 100)}`); }
    }
  }

  console.log('\n--- Summary by status code ---');
  const byCode = {};
  for (const r of results) {
    byCode[r.status] = (byCode[r.status] || 0) + 1;
  }
  for (const [code, n] of Object.entries(byCode).sort()) {
    console.log(`HTTP ${code}: ${n} endpoint(s)`);
  }

  await session.logout();
})();
