// Probe: can one RWS session GRANT another session's RMMP request headlessly,
// i.e. WITHOUT the physical FlexPendant approval?  (RWS 2.0 / OmniCore only)
//
// Hypothesis: POST /users/rmmp/grant {uid, privilege} (RWS2_Full_Reference.md:65) —
// never probed, unimplemented in the client — may let a second authorised session
// approve the first session's "request remote modify", bootstrapping remote control
// in AUTO without anyone touching the pendant. This is the single most decisive test
// for "programmatic vs FlexPendant-only" remote control.
//
// Two INDEPENDENT sessions (separate cookie jars):
//   A = the "requester"  (asks for RMMP modify)
//   B = the "approver"   (tries to grant A's request)
// Two different users make it a realistic test (default A=Default User, B=Admin).
// This probe never commands motion — it only requests/cancels RMMP and attempts a grant.
//
// Run:  node scripts/probe-rmmp-grant.js
// Env:  HOST PORT  A_USER A_PASS  B_USER B_PASS  A_UID (override if auto-resolve fails)

const https = require('https');

const HOST = process.env.HOST || '127.0.0.1';
const A_USER = process.env.A_USER || 'Default User';
const A_PASS = process.env.A_PASS || 'robotics';
const B_USER = process.env.B_USER || 'Admin';
const B_PASS = process.env.B_PASS || 'robotics';
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let port = Number(process.env.PORT) || 0;

function makeSession(user, pass) {
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  let cookie = null;
  function req(method, path, body) {
    return new Promise(resolve => {
      const headers = { Authorization: auth, Accept: 'application/xhtml+xml;v=2.0' };
      if (cookie) { headers.Cookie = cookie; }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded;v=2.0';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const r = https.request({
        host: HOST, port, path, method, headers, agent: httpsAgent, rejectUnauthorized: false,
      }, res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          if (sc) {
            const ct = sc.find(c => /^(-http-session-|ABBCX|http-session)=/.test(c));
            if (ct) { cookie = ct.split(';')[0]; }
          }
          resolve({ status: res.statusCode, body: d });
        });
      });
      r.on('error', e => resolve({ status: 0, body: '', error: e.message }));
      if (body !== undefined) { r.write(body); }
      r.end();
    });
  }
  return { user, req };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = xml => (xml || '')
  .replace(/<\?xml.*?\?>/, '').replace(/<!DOCTYPE.*?>/, '')
  .replace(/<html[^>]*>|<head>[\s\S]*?<\/head>|<\/?body[^>]*>|<\/html>/g, '')
  .replace(/></g, '>\n<').trim();
const spanList = xml => ((xml || '').match(/<span[^>]*>[^<]*<\/span>/g) || []);
const getSpan = (xml, cls) => { const m = (xml || '').match(new RegExp(`<span class="${cls}">([^<]*)</span>`)); return m ? m[1] : null; };
function findUid(body) {
  for (const cls of ['uid', 'user-id', 'userid', 'id', 'user']) {
    const v = getSpan(body, cls);
    if (v) { return v; }
  }
  const m = body.match(/uid["'>:\s]+([0-9a-fA-F-]{4,})/);
  return m ? m[1] : null;
}

async function main() {
  const A = makeSession(A_USER, A_PASS);
  const B = makeSession(B_USER, B_PASS);

  if (!port) {
    // Verify a real RWS 2.0 (HTTPS) controller answers — a bare TCP check matches
    // unrelated services (e.g. Windows HTTP.sys on :80), so issue an actual request.
    for (const p of [9403, 5466, 443, 11811]) {
      port = p;
      const t = await A.req('GET', '/rw/system/robottype');
      if (t.status && t.status >= 100) { break; }
      port = 0;
    }
    if (!port) {
      console.error('No RWS 2.0 controller answered on ' + HOST + ' (tried 9403, 5466, 443, 11811).');
      console.error('Start the OmniCore VC in RobotStudio, or pass HOST=… PORT=… explicitly.');
      process.exit(1);
    }
  }
  console.log(`\n=== RMMP headless-grant probe — ${HOST}:${port} ===`);
  console.log(`  A (requester) = ${A_USER}`);
  console.log(`  B (approver)  = ${B_USER}\n`);

  // 0. Establish both sessions + resolve A's uid (needed for the grant call)
  console.log('── A login-info ──');
  const aLogin = await A.req('GET', '/users/login-info'); await sleep(80);
  console.log('  status', aLogin.status);
  console.log('  body:', clean(aLogin.body).slice(0, 400) || '(empty)');
  let aUid = process.env.A_UID || findUid(aLogin.body);
  if (!aUid) {
    const us = await A.req('GET', '/users'); await sleep(80);
    console.log('  GET /users →', us.status);
    console.log('  ', clean(us.body).slice(0, 600) || '(empty)');
    aUid = findUid(us.body);
  }
  console.log('  → A uid =', aUid || '(UNRESOLVED — inspect bodies above, then set A_UID=… and re-run)');

  const bLogin = await B.req('GET', '/users/login-info'); await sleep(80);
  console.log('── B login-info ──', 'status', bLogin.status, ' uid=', findUid(bLogin.body) || '?');

  // 1. A requests RMMP modify
  console.log('\n── A requests RMMP modify ──');
  const a0 = await A.req('GET', '/users/rmmp'); await sleep(80);
  console.log('  A /users/rmmp (before) →', a0.status, ' ', spanList(a0.body).slice(0, 6).join('  '));
  const aReq = await A.req('POST', '/users/rmmp', 'privilege=modify'); await sleep(80);
  console.log('  A POST /users/rmmp privilege=modify →', aReq.status, ' ', clean(aReq.body).slice(0, 200));
  const aPoll1 = await A.req('GET', '/users/rmmp/poll'); await sleep(80);
  console.log('  A /users/rmmp/poll (pending?) →', aPoll1.status, ' ', spanList(aPoll1.body).slice(0, 6).join('  '));

  // 2. B tries to GRANT A's request — THE KEY TEST
  console.log('\n── B tries to grant A headlessly (THE KEY TEST) ──');
  if (!aUid) { console.log('  ⚠ A uid unresolved; trying grant with privilege only (likely 400).'); }
  const grantBody = (aUid ? `uid=${encodeURIComponent(aUid)}&` : '') + 'privilege=modify';
  const bGrant = await B.req('POST', '/users/rmmp/grant', grantBody); await sleep(80);
  console.log(`  B POST /users/rmmp/grant (${grantBody}) → ${bGrant.status}`);
  console.log('  body:', clean(bGrant.body).slice(0, 300) || '(empty)');

  // 3. Did A's privilege change with no FlexPendant interaction?
  console.log('\n── A re-checks: did the grant land headlessly? ──');
  const aPoll2 = await A.req('GET', '/users/rmmp/poll'); await sleep(80);
  console.log('  A /users/rmmp/poll (after grant) →', aPoll2.status, ' ', spanList(aPoll2.body).slice(0, 6).join('  '));
  const aAfter = await A.req('GET', '/users/rmmp'); await sleep(80);
  console.log('  A /users/rmmp (after) →', aAfter.status, ' ', spanList(aAfter.body).slice(0, 6).join('  '));

  // verdict
  console.log('\n── VERDICT ──');
  const v = bGrant.status >= 200 && bGrant.status < 300
    ? '✓ controller ACCEPTED the grant — headless approval may be POSSIBLE (confirm A now holds modify above)'
    : bGrant.status === 403 ? '✗ 403 — granting is itself privilege/UAS-gated (supports FlexPendant-only)'
    : bGrant.status === 400 ? '? 400 — VC may stub this endpoint, or the uid/param shape is wrong'
    : bGrant.status === 404 ? '? 404 — endpoint not present on this firmware'
    : `? unexpected status ${bGrant.status}`;
  console.log('  B grant status', bGrant.status, '—', v);

  // teardown
  console.log('\n── teardown ──');
  await A.req('POST', '/users/rmmp/cancel', ''); await sleep(80);
  await A.req('GET', '/logout');
  await B.req('GET', '/logout');
  console.log('Done.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
