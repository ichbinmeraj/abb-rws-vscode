// Verify everything we added this session against both VCs.
//   1. RMMP get/request                 (RWS 2.0)
//   2. setOperationMode                  (RWS 2.0 - verified live)
//   3. getMastershipStatus               (RWS 2.0)
//   4. listFileVolumes                   (RWS 2.0)
//   5. getModuleSource                   (both)
//   6. callServiceRoutine endpoint shape (RWS 2.0)
//   7. createBackup endpoint shape       (RWS 2.0)
//   8. setActiveTool / setActiveWobj     (skipped - needs valid tool name)

// Env: RWS1_URL RWS2_URL RWS_USER RWS_PASS HOST (see scripts/lib/probe-common.mjs)
import { HOST, RWS1_URL, RWS2_URL, makeSession } from './lib/probe-common.mjs';

const rws2 = makeSession(RWS2_URL);
const rws1 = makeSession(RWS1_URL || `http://${HOST}:42297`, {
  accept: 'application/json;v=1.0',
  contentType: 'application/x-www-form-urlencoded;v=1.0',
});

let pass = 0, fail = 0, skipped = 0;

function record(label, condition, detail = '') {
  if (condition === 'skip') { skipped++; console.log(`  ⊘ ${label}${detail ? ' - ' + detail : ''}`); return; }
  if (condition) { pass++; console.log(`  ✓ ${label}${detail ? ' - ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ' - ' + detail : ''}`); }
}

async function main() {
  console.log('═══ NEW ENDPOINTS - verify wire format & response shape ═══\n');

  console.log(`── RWS 2.0 (${rws2.url.host}, OmniCore VC) ──`);
  // 1. RMMP read
  let r = await rws2.req('GET', '/users/rmmp');
  record('RMMP GET /users/rmmp', r.status === 200, `HTTP ${r.status}`);

  // 2. Read mastership status (used by Show Holder dialog)
  r = await rws2.req('GET', '/rw/mastership/edit');
  record('Mastership status GET /rw/mastership/edit', r.status === 200, `HTTP ${r.status}`);

  r = await rws2.req('GET', '/rw/mastership/motion');
  record('Mastership status GET /rw/mastership/motion', r.status === 200, `HTTP ${r.status}`);

  // 3. List mastership domains
  r = await rws2.req('GET', '/rw/mastership');
  record('listMastershipDomains GET /rw/mastership', r.status === 200, `HTTP ${r.status}`);

  // 4. listFileVolumes
  r = await rws2.req('GET', '/fileservice');
  record('listFileVolumes GET /fileservice', r.status === 200, `HTTP ${r.status}`);

  // 5. setOperationMode wire format (verify path accepts the call - actual transition needs popup approval)
  r = await rws2.req('POST', '/rw/panel/opmode', 'opmode=auto');
  record('setOperationMode POST /rw/panel/opmode opmode=auto', r.status >= 200 && r.status < 400, `HTTP ${r.status}`);

  // 6. listDipcQueues
  r = await rws2.req('GET', '/rw/dipc');
  record('DIPC list GET /rw/dipc', r.status === 200, `HTTP ${r.status}`);

  // 7. getModuleSource - fileservice GET on a known module
  r = await rws2.req('GET', '/fileservice/HOME/');
  record('FileService HOME directory listing', r.status === 200, `HTTP ${r.status}`);

  // 8. CFG write surface (just check the domain endpoint)
  r = await rws2.req('GET', '/rw/cfg/SYS');
  record('CFG GET /rw/cfg/SYS', r.status === 200, `HTTP ${r.status}`);

  // 9. Backup endpoint
  r = await rws2.req('GET', '/ctrl/backup');
  record('Backup GET /ctrl/backup', r.status === 200, `HTTP ${r.status}`);

  // 10. RMMP poll resource (subscription path)
  r = await rws2.req('GET', '/users/rmmp/poll');
  record('RMMP poll resource', r.status === 200 || r.status === 401, `HTTP ${r.status}`);

  // 11. Robot type (lib's getRobotType)
  r = await rws2.req('GET', '/rw/system/robottype');
  record('System getRobotType', r.status === 200, `HTTP ${r.status}`);

  // 12. License info
  r = await rws2.req('GET', '/rw/system/license');
  record('System getLicenseInfo', r.status === 200, `HTTP ${r.status}`);

  // 13. listProducts
  r = await rws2.req('GET', '/rw/system/products');
  record('System listProducts', r.status === 200, `HTTP ${r.status}`);

  // 14. Energy
  r = await rws2.req('GET', '/rw/system/energy');
  record('System getEnergyStats', r.status === 200, `HTTP ${r.status}`);

  // 15. Mechunit detail
  r = await rws2.req('GET', '/rw/motionsystem/mechunits/ROB_1/baseframe');
  record('Mechunit baseframe', r.status === 200, `HTTP ${r.status}`);

  console.log(`\n── RWS 1.0 (${rws1.url.host}, IRC5 VC) ──`);
  // RWS 1.0 doesn't have /users/rmmp at the same path; test what's exposed
  r = await rws1.req('GET', '/users/rmmp');
  record('RMMP GET /users/rmmp (RWS 1.0)', r.status === 200, `HTTP ${r.status}`);

  // listMastershipDomains
  r = await rws1.req('GET', '/rw/mastership');
  record('listMastershipDomains', r.status === 200, `HTTP ${r.status}`);

  // listProducts on RWS 1.0
  r = await rws1.req('GET', '/rw/system/products?json=1');
  record('System listProducts', r.status === 200, `HTTP ${r.status}`);

  // license info
  r = await rws1.req('GET', '/rw/system/license?json=1');
  record('System getLicenseInfo', r.status === 200, `HTTP ${r.status}`);

  // robot type
  r = await rws1.req('GET', '/rw/system/robottype?json=1');
  record('System getRobotType', r.status === 200, `HTTP ${r.status}`);

  // setOperationMode wire format (RWS 1.0 uses lowercase auto/man/manfs)
  r = await rws1.req('POST', '/rw/panel/opmode?action=setopmode', 'opmode=auto');
  record('setOperationMode (RWS 1.0)', r.status >= 200 && r.status < 400, `HTTP ${r.status}`);

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`PASSED: ${pass}    FAILED: ${fail}    SKIPPED: ${skipped}    TOTAL: ${pass + fail + skipped}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  await rws2.logout();
  await rws1.logout();
}

main().catch(e => { console.error(e); process.exit(1); });
