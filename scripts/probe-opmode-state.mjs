// Diagnose WHY setOperationMode is returning 500 instead of 200.
// 500 = "controller received it, validated wire format, but couldn't perform"
// Common causes: opmode locked, another client holds priority, pending dialog.

// Env: RWS2_URL RWS_USER RWS_PASS (see scripts/lib/probe-common.mjs)
import { RWS2_URL, makeSession, sleep } from './lib/probe-common.mjs';

const session = makeSession(RWS2_URL);
const req = session.req;

(async () => {
  // 1. Read the FULL opmode resource — includes lock/pending state
  const r1 = await req('GET', '/rw/panel/opmode');
  console.log('GET /rw/panel/opmode:');
  console.log(r1.body.replace(/<\?xml.*?\?>/, '').replace(/<!DOCTYPE.*?>/, '').replace(/<html[^>]*>|<head>[\s\S]*?<\/head>|<\/?body[^>]*>|<\/html>/g, '').replace(/></g, '>\n<').slice(0, 1500));
  await sleep(150);

  // 2. Read enable-request state (deadman / safety chain)
  console.log('\nGET /rw/panel/enable:');
  const r2 = await req('GET', '/rw/panel/enable');
  console.log('  status', r2.status);
  if (r2.body) console.log('  ', r2.body.match(/<span[^>]*>[^<]*<\/span>/g)?.slice(0, 6).join('  '));
  await sleep(150);

  // 3. Read RMMP state
  console.log('\nGET /users/rmmp:');
  const r3 = await req('GET', '/users/rmmp');
  console.log('  status', r3.status);
  if (r3.body) console.log('  ', r3.body.match(/<span[^>]*>[^<]*<\/span>/g)?.slice(0, 8).join('  '));
  await sleep(150);

  // 4. Read mastership state for edit + motion
  console.log('\nGET /rw/mastership/edit:');
  const r4 = await req('GET', '/rw/mastership/edit');
  if (r4.body) console.log('  ', r4.body.match(/<span[^>]*>[^<]*<\/span>/g)?.slice(0, 6).join('  '));
  await sleep(150);

  console.log('\nGET /rw/mastership/motion:');
  const r5 = await req('GET', '/rw/mastership/motion');
  if (r5.body) console.log('  ', r5.body.match(/<span[^>]*>[^<]*<\/span>/g)?.slice(0, 6).join('  '));
  await sleep(150);

  // 5. Read the lock-state — saw pnl-lockstate-li in the opmode response
  console.log('\nGET /rw/panel/opmode/lock-state:');
  const rLock = await req('GET', '/rw/panel/opmode/lock-state');
  console.log('  status', rLock.status);
  console.log('  body:', rLock.body.slice(0, 400));
  await sleep(150);

  // 6. Check pending dialogs (FlexPendant approval queue)
  console.log('\nGET /rw/panel/operatorpanel/dialog (pending dialogs?):');
  const rDlg = await req('GET', '/rw/panel/operatorpanel/dialog');
  console.log('  status', rDlg.status, '— body len', rDlg.body?.length);
  await sleep(150);

  // 7. Try the actual switch and see the FULL error body
  const m = r1.body.match(/<span class="opmode">([^<]+)<\/span>/);
  const current = m ? m[1] : '?';
  const target = current === 'AUTO' ? 'man' : 'auto';
  console.log(`\nPOST /rw/panel/opmode opmode=${target}  (current is ${current}):`);
  const r6 = await req('POST', '/rw/panel/opmode', `opmode=${target}`);
  console.log(`  status ${r6.status}`);
  console.log('  full body:', r6.body.slice(0, 800));

  // 8. Try with edit mastership held first
  console.log('\nWith edit mastership:');
  const m1 = await req('POST', '/rw/mastership/edit/request');
  console.log(`  request mastership: ${m1.status}`);
  await sleep(150);
  const r7 = await req('POST', '/rw/panel/opmode', `opmode=${target}`);
  console.log(`  POST /rw/panel/opmode opmode=${target}: ${r7.status}`);
  console.log('  body:', r7.body.slice(0, 300));
  await req('POST', '/rw/mastership/edit/release');

  await session.logout();
})();
