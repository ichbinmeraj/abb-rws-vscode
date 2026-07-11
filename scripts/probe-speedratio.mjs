// Find the working body shape for RWS 2.0 setSpeedRatio.
// Env: RWS2_URL RWS_USER RWS_PASS (see scripts/lib/probe-common.mjs)
import { RWS2_URL, makeSession, sleep } from './lib/probe-common.mjs';

const session = makeSession(RWS2_URL);
const req = session.req;

(async () => {
  const r0 = await req('GET', '/rw/panel/speedratio');
  await sleep(150);
  const cur = r0.body.match(/<span class="speedratio">([^<]+)<\/span>/);
  console.log(`Current speed ratio: ${cur ? cur[1] : '?'}`);

  // Try with edit mastership held first (setSpeedRatio commonly requires it)
  const m1 = await req('POST', '/rw/mastership/edit/request');
  console.log(`mastership edit: ${m1.status}`);
  await sleep(150);

  const candidates = [
    { path: '/rw/panel/speedratio', body: 'speedratio=50' },
    { path: '/rw/panel/speedratio', body: 'speed-ratio=50' },
    { path: '/rw/panel/speedratio/set', body: 'speedratio=50' },
    { path: '/rw/panel/speedratio/set', body: 'speed-ratio=50' },
    { path: '/rw/panel/speedratio?action=setspeedratio', body: 'speed-ratio=50' },
    { path: '/rw/panel/speedratio', body: 'speed-ratio=50.0' },
    { path: '/rw/panel/speedratio?ratio=50', body: '' },
    { path: '/rw/panel/speedratio', body: 'pnl-speedratio=50' },
  ];
  for (const { path, body } of candidates) {
    const r = await req('POST', path, body);
    await sleep(150);
    let detail = '';
    if (r.body) {
      const msg = r.body.match(/<span class="msg">([^<]+)<\/span>/);
      if (msg) detail = msg[1].slice(0, 80);
    }
    const ok = r.status >= 200 && r.status < 300 ? '✓' : '✗';
    console.log(`  ${ok} ${path.padEnd(50)} body="${body}" → ${r.status}${detail ? '  ' + detail : ''}`);
    if (r.status >= 200 && r.status < 300) {
      const v = await req('GET', '/rw/panel/speedratio');
      const m = v.body.match(/<span class="speedratio">([^<]+)<\/span>/);
      console.log(`         verified speed ratio = ${m ? m[1] : '?'}`);
    }
  }

  // Restore original
  if (cur) { await req('POST', '/rw/panel/speedratio', `speedratio=${cur[1]}`); }
  await req('POST', '/rw/mastership/edit/release');
  await session.logout();
})();
