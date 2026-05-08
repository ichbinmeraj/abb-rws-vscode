// Live-probe RWS 2.0 setOperationMode — finds the working endpoint+body shape
// by trying every plausible variant against the running VC.
//
// Run:  node probe-opmode-write.js
// Optional env: HOST, PORT, RWS_USER, RWS_PASS

const https = require('https');
const http = require('http');
const net = require('net');

const HOST = process.env.HOST || '127.0.0.1';
const USER = process.env.RWS_USER || 'Admin';
const PASS = process.env.RWS_PASS || 'robotics';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let sessionCookie = null;
let port = Number(process.env.PORT) || 0;

function req(method, p, path, body) {
  return new Promise(resolve => {
    const headers = {
      Authorization: AUTH,
      Accept: 'application/xhtml+xml;v=2.0',
    };
    if (sessionCookie) { headers.Cookie = sessionCookie; }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;v=2.0';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request({
      host: HOST, port: p, path, method, headers, agent: httpsAgent,
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          // OmniCore uses '-http-session-=' (with leading dash) and 'ABBCX='
          const ct = setCookie.find(c => /^(-http-session-|ABBCX|http-session)=/.test(c));
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

async function probePort(p) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: HOST, port: p, timeout: 1000 });
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function main() {
  // Find an open port if not specified
  if (!port) {
    for (const p of [5466, 9403, 443, 80, 11811]) {
      if (await probePort(p)) { port = p; break; }
    }
    if (!port) { console.error('No RWS port reachable on', HOST); process.exit(1); }
  }
  console.log(`Using ${HOST}:${port} as ${USER}\n`);

  // Read current opmode
  const get1 = await req('GET', port, '/rw/panel/opmode');
  console.log(`[GET /rw/panel/opmode] status=${get1.status}`);
  const m = get1.body.match(/<span class="opmode">([^<]+)<\/span>/);
  const original = m ? m[1] : '?';
  console.log(`  current opmode = ${original}\n`);

  // Probe ALL three target modes from the current state, with multiple value
  // spellings each. We've confirmed the path and param name; now we want
  // the working spelling for every target (especially MANF, untested).
  const targets = ['AUTO', 'MANR', 'MANF'].filter(t => t !== original);
  console.log(`Probing transitions from ${original} to: ${targets.join(', ')}\n`);

  // Try acquiring 'edit' mastership first
  const mst = await req('POST', port, '/rw/mastership/edit/request', '');
  console.log(`[mastership edit request] status=${mst.status}\n`);

  for (const t of targets) {
    console.log(`── target ${t} ──`);
    const candidates = [
      t.toLowerCase(),
      t,
      t === 'AUTO' ? 'auto' : t === 'MANR' ? 'man' : 'manfs',
      t === 'AUTO' ? 'auto' : t === 'MANR' ? 'manr' : 'manf',
      t === 'AUTO' ? 'auto' : t === 'MANR' ? 'manualr' : 'manualf',
      t === 'AUTO' ? 'auto' : t === 'MANR' ? 'manual' : 'manual_fs',
      t === 'AUTO' ? 'auto' : t === 'MANR' ? 'man_r' : 'man_f',
    ];
    for (const v of [...new Set(candidates)]) {
      const r = await req('POST', port, '/rw/panel/opmode', `opmode=${v}`);
      let detail = '';
      if (r.body) {
        const m1 = r.body.match(/code:(-?\d+)\s+icode:(-?\d+)/);
        const m2 = r.body.match(/<span class="msg">([^<]+)<\/span>/);
        detail = (m2 ? m2[1] : '') + (m1 ? ` [code=${m1[1]} icode=${m1[2]}]` : '');
      }
      const verdict = r.status >= 200 && r.status < 300 ? '  ✓ OK' : `  ✗ ${r.status}`;
      console.log(`${verdict}  opmode=${v}${detail ? ' → ' + detail.slice(0, 100) : ''}`);
      if (r.status >= 200 && r.status < 300) {
        const post = await req('GET', port, '/rw/panel/opmode');
        const m3 = post.body.match(/<span class="opmode">([^<]+)<\/span>/);
        console.log(`      verified opmode now = ${m3 ? m3[1] : '?'}`);
        break;
      }
    }
    console.log();
  }

  // Restore original
  const restoreBody = original === 'AUTO' ? 'opmode=auto' : original === 'MANR' ? 'opmode=man' : 'opmode=manfs';
  await req('POST', port, '/rw/panel/opmode', restoreBody);

  await req('POST', port, '/rw/mastership/edit/release', '');
  await req('GET', port, '/logout');
}

main().catch(e => { console.error(e); process.exit(1); });
