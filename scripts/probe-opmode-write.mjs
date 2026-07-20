// Live-probe RWS 2.0 setOperationMode - finds the working endpoint+body shape
// by trying every plausible variant against the running VC.
//
// Run:  node probe-opmode-write.js
// Optional env: RWS2_URL, HOST, PORT, RWS_USER, RWS_PASS (see scripts/lib/probe-common.mjs)

import { HOST, makeSession, tcpPing } from './lib/probe-common.mjs';

const USER = process.env.RWS_USER || 'Admin';

let session = null;
const req = (method, _port, path, body) => session.req(method, path, body);

async function resolveBase() {
  if (process.env.RWS2_URL) { return new URL(process.env.RWS2_URL); }
  if (process.env.PORT) { return new URL(`https://${HOST}:${process.env.PORT}`); }
  for (const p of [5466, 9403, 443, 80, 11811]) {
    if (await tcpPing(p, HOST, 1000)) { return new URL(`https://${HOST}:${p}`); }
  }
  return null;
}

async function main() {
  const base = await resolveBase();
  if (!base) { console.error('No RWS port reachable on', HOST); process.exit(1); }
  session = makeSession(base, { user: USER });
  const port = Number(base.port);
  console.log(`Using ${base.host} as ${USER}\n`);

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
  await session.logout();
}

main().catch(e => { console.error(e); process.exit(1); });
