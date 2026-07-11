// Probe what RWS endpoints can clear/reset guardstop on a VC.
//   - /rw/panel/enable  (virtual deadman?)
//   - /rw/panel/ctrl-state with various actions
//   - /rw/safety/...
//   - /rw/iosystem/signals on safety signals (ES1, AS1, etc.)

// Env: RWS2_URL RWS_USER RWS_PASS (see scripts/lib/probe-common.mjs)
import { RWS2_URL, makeSession, sleep } from './lib/probe-common.mjs';

const session = makeSession(RWS2_URL);
const req = session.req;

async function tryEP(method, path, body) {
  const r = await req(method, path, body);
  await sleep(150);
  let detail = '';
  if (r.body) {
    const m = r.body.match(/<span class="(?:msg|code)">[^<]+<\/span>/g);
    if (m) detail = m.join(' ').slice(0, 120);
  }
  console.log(`  ${r.status >= 200 && r.status < 300 ? '✓' : '✗'} ${method.padEnd(4)} ${path.padEnd(45)}${body !== undefined ? ` body=${body.slice(0,30)}` : ''} → ${r.status}`);
  if (detail) console.log(`         ${detail}`);
}

(async () => {
  // 1. Read current state
  const cs = await req('GET', '/rw/panel/ctrl-state');
  await sleep(150);
  const m = cs.body.match(/<span class="ctrlstate">([^<]+)<\/span>/);
  console.log(`Current ctrl-state: ${m ? m[1] : '?'}`);

  console.log('\n## Probe enable / deadman endpoints');
  await tryEP('GET', '/rw/panel/enable');
  await tryEP('POST', '/rw/panel/enable', 'enable=1');
  await tryEP('POST', '/rw/panel/enable', 'state=on');
  await tryEP('GET', '/rw/panel/safety');
  await tryEP('POST', '/rw/panel/safety/reset');
  await tryEP('GET', '/rw/panel/operatorpanel');
  await tryEP('GET', '/rw/panel');

  console.log('\n## Probe ctrl-state action variants');
  await tryEP('POST', '/rw/panel/ctrl-state', 'ctrl-state=motoron');
  await tryEP('POST', '/rw/panel/ctrl-state', 'ctrlstate=motoron');
  await tryEP('POST', '/rw/panel/ctrl-state/reset');
  await tryEP('POST', '/rw/panel/ctrl-state/clearestop');

  console.log('\n## Probe safety endpoints');
  await tryEP('GET', '/rw/safety');
  await tryEP('GET', '/ctrl/safety');
  await tryEP('GET', '/rw/iosystem/signals/AS1');
  await tryEP('GET', '/rw/iosystem/signals/ES1');

  console.log('\n## Probe simulated-input endpoints');
  // Some VCs expose a "simulated I/O" namespace
  await tryEP('GET', '/rw/iosystem/devices');

  // 2. Final state check
  console.log();
  const cs2 = await req('GET', '/rw/panel/ctrl-state');
  const m2 = cs2.body.match(/<span class="ctrlstate">([^<]+)<\/span>/);
  console.log(`Final ctrl-state: ${m2 ? m2[1] : '?'}`);

  await session.logout();
})();
