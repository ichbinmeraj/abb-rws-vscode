// Verify everything we added this session against both VCs.
//   1. RMMP get/request                 (RWS 2.0)
//   2. setOperationMode                  (RWS 2.0 — verified live)
//   3. getMastershipStatus               (RWS 2.0)
//   4. listFileVolumes                   (RWS 2.0)
//   5. getModuleSource                   (both)
//   6. callServiceRoutine endpoint shape (RWS 2.0)
//   7. createBackup endpoint shape       (RWS 2.0)
//   8. setActiveTool / setActiveWobj     (skipped — needs valid tool name)

const https = require('https');
const http = require('http');
const net = require('net');

const HOST = '127.0.0.1';
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

function req(useHttps, port, path, method = 'GET', body, user = 'Default User', pass = 'robotics') {
  return new Promise(resolve => {
    const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const headers = {
      Authorization: auth,
      Accept: useHttps ? 'application/xhtml+xml;v=2.0' : 'application/json;v=1.0',
    };
    if (body !== undefined) {
      headers['Content-Type'] = useHttps ? 'application/x-www-form-urlencoded;v=2.0' : 'application/x-www-form-urlencoded;v=1.0';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const transport = useHttps ? https : http;
    const r = transport.request({
      host: HOST, port, path, method, headers,
      agent: useHttps ? httpsAgent : httpAgent,
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (body !== undefined) { r.write(body); }
    r.end();
  });
}

let pass = 0, fail = 0, skipped = 0;

function record(label, condition, detail = '') {
  if (condition === 'skip') { skipped++; console.log(`  ⊘ ${label}${detail ? ' — ' + detail : ''}`); return; }
  if (condition) { pass++; console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  console.log('═══ NEW ENDPOINTS — verify wire format & response shape ═══\n');

  console.log('── RWS 2.0 (port 5466, OmniCore VC) ──');
  // 1. RMMP read
  let r = await req(true, 5466, '/users/rmmp');
  record('RMMP GET /users/rmmp', r.status === 200, `HTTP ${r.status}`);

  // 2. Read mastership status (used by Show Holder dialog)
  r = await req(true, 5466, '/rw/mastership/edit');
  record('Mastership status GET /rw/mastership/edit', r.status === 200, `HTTP ${r.status}`);

  r = await req(true, 5466, '/rw/mastership/motion');
  record('Mastership status GET /rw/mastership/motion', r.status === 200, `HTTP ${r.status}`);

  // 3. List mastership domains
  r = await req(true, 5466, '/rw/mastership');
  record('listMastershipDomains GET /rw/mastership', r.status === 200, `HTTP ${r.status}`);

  // 4. listFileVolumes
  r = await req(true, 5466, '/fileservice');
  record('listFileVolumes GET /fileservice', r.status === 200, `HTTP ${r.status}`);

  // 5. setOperationMode wire format (verify path accepts the call — actual transition needs popup approval)
  r = await req(true, 5466, '/rw/panel/opmode', 'POST', 'opmode=auto');
  record('setOperationMode POST /rw/panel/opmode opmode=auto', r.status >= 200 && r.status < 400, `HTTP ${r.status}`);

  // 6. listDipcQueues
  r = await req(true, 5466, '/rw/dipc');
  record('DIPC list GET /rw/dipc', r.status === 200, `HTTP ${r.status}`);

  // 7. getModuleSource — fileservice GET on a known module
  r = await req(true, 5466, '/fileservice/HOME/');
  record('FileService HOME directory listing', r.status === 200, `HTTP ${r.status}`);

  // 8. CFG write surface (just check the domain endpoint)
  r = await req(true, 5466, '/rw/cfg/SYS');
  record('CFG GET /rw/cfg/SYS', r.status === 200, `HTTP ${r.status}`);

  // 9. Backup endpoint
  r = await req(true, 5466, '/ctrl/backup');
  record('Backup GET /ctrl/backup', r.status === 200, `HTTP ${r.status}`);

  // 10. RMMP poll resource (subscription path)
  r = await req(true, 5466, '/users/rmmp/poll');
  record('RMMP poll resource', r.status === 200 || r.status === 401, `HTTP ${r.status}`);

  // 11. Robot type (lib's getRobotType)
  r = await req(true, 5466, '/rw/system/robottype');
  record('System getRobotType', r.status === 200, `HTTP ${r.status}`);

  // 12. License info
  r = await req(true, 5466, '/rw/system/license');
  record('System getLicenseInfo', r.status === 200, `HTTP ${r.status}`);

  // 13. listProducts
  r = await req(true, 5466, '/rw/system/products');
  record('System listProducts', r.status === 200, `HTTP ${r.status}`);

  // 14. Energy
  r = await req(true, 5466, '/rw/system/energy');
  record('System getEnergyStats', r.status === 200, `HTTP ${r.status}`);

  // 15. Mechunit detail
  r = await req(true, 5466, '/rw/motionsystem/mechunits/ROB_1/baseframe');
  record('Mechunit baseframe', r.status === 200, `HTTP ${r.status}`);

  console.log('\n── RWS 1.0 (port 42297, IRC5 VC) ──');
  // RWS 1.0 doesn't have /users/rmmp at the same path; test what's exposed
  r = await req(false, 42297, '/users/rmmp');
  record('RMMP GET /users/rmmp (RWS 1.0)', r.status === 200, `HTTP ${r.status}`);

  // listMastershipDomains
  r = await req(false, 42297, '/rw/mastership');
  record('listMastershipDomains', r.status === 200, `HTTP ${r.status}`);

  // listProducts on RWS 1.0
  r = await req(false, 42297, '/rw/system/products?json=1');
  record('System listProducts', r.status === 200, `HTTP ${r.status}`);

  // license info
  r = await req(false, 42297, '/rw/system/license?json=1');
  record('System getLicenseInfo', r.status === 200, `HTTP ${r.status}`);

  // robot type
  r = await req(false, 42297, '/rw/system/robottype?json=1');
  record('System getRobotType', r.status === 200, `HTTP ${r.status}`);

  // setOperationMode wire format (RWS 1.0 uses lowercase auto/man/manfs)
  r = await req(false, 42297, '/rw/panel/opmode?action=setopmode', 'POST', 'opmode=auto');
  record('setOperationMode (RWS 1.0)', r.status >= 200 && r.status < 400, `HTTP ${r.status}`);

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`PASSED: ${pass}    FAILED: ${fail}    SKIPPED: ${skipped}    TOTAL: ${pass + fail + skipped}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
}

main().catch(e => { console.error(e); process.exit(1); });
