// Probe: can we save a loaded RAPID module to a file via RWS 2.0?
// Fix path for GitHub issue #3 (openModuleSource 404 when module not on disk):
//   POST /rw/rapid/tasks/{task}/modules/{module}/save  body: name=<file>&path=TEMP:
// (live-verified 2026-07-08: the controller wants name+path, appends .modx itself;
//  TEMP:, HOME: etc. as path; DELETE needs a versioned Accept header)
// Then read it back via /fileservice and clean up.
import https from 'node:https';

const HOST = '127.0.0.1';
const PORTS = [5466, 9403, 443, 11811, 15120, 16146, 28447];
const USER = process.env.RWS_USER || 'Default User';
const PASS = process.env.RWS_PASS || 'robotics';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
let cookie = null;

function req(port, method, path, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const headers = {
      Authorization: AUTH,
      Accept: 'application/xhtml+xml;v=2.0',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;v=2.0';
      headers['Content-Length'] = String(body ? Buffer.byteLength(body) : 0);
    }
    const r = https.request({ hostname: HOST, port, path, method, headers, rejectUnauthorized: false, timeout: 4000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length && !cookie) cookie = sc.map(c => c.split(';')[0]).join('; ');
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    r.on('error', e => resolve({ status: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}

// 1) find the VC port
let port = null;
for (const p of PORTS) {
  const r = await req(p, 'GET', '/rw/system');
  if (r.status === 200 || r.status === 401) { port = p; console.log(`✓ controller on :${p} (status ${r.status})`); break; }
}
if (!port) { console.log('✗ no RWS 2.0 VC found on common ports — RobotStudio may have reassigned; rerun with a scan'); process.exit(1); }

// 2) list modules in T_ROB1
const mods = await req(port, 'GET', '/rw/rapid/tasks/T_ROB1/modules');
const names = [...mods.body.matchAll(/class="name">([^<]+)</g)].map(m => m[1]);
console.log(`modules (${mods.status}):`, names.join(', ') || '(none parsed)');
const mod = names.find(n => !['BASE', 'user', 'DPUSER', 'DPBASE'].includes(n)) ?? names[0];
if (!mod) { console.log('✗ no module to test with'); process.exit(1); }
console.log(`→ testing with module: ${mod}`);

// 3) try save action — live-verified form first (name without extension; the
//    controller appends .modx), legacy guesses kept as fallbacks
const tmpName = `probe_saved_${mod}`;
const dest = `${tmpName}.modx`;
for (const body of [
  `name=${encodeURIComponent(tmpName)}&path=${encodeURIComponent('HOME:')}`,
  `name=${encodeURIComponent(tmpName)}&path=${encodeURIComponent('TEMP:')}`,
]) {
  const r = await req(port, 'POST', `/rw/rapid/tasks/T_ROB1/modules/${encodeURIComponent(mod)}/save`, body);
  console.log(`POST .../modules/${mod}/save  body="${body}" → ${r.status} ${r.status >= 400 ? r.body.slice(0, 180).replace(/\s+/g, ' ') : ''}`);
  if (r.status === 200 || r.status === 201 || r.status === 204) {
    // 4) read it back
    const read = await req(port, 'GET', `/fileservice/HOME/${dest}`);
    console.log(`GET /fileservice/HOME/${dest} → ${read.status}, ${read.body.length} bytes, starts: ${read.body.slice(0, 60).replace(/\s+/g, ' ')}`);
    // 5) clean up
    const del = await req(port, 'DELETE', `/fileservice/HOME/${dest}`);
    console.log(`DELETE /fileservice/HOME/${dest} → ${del.status}`);
    break;
  }
}
console.log('done.');
