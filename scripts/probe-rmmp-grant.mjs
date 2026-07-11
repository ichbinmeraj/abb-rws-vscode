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
// Env:  RWS2_URL HOST PORT  A_USER A_PASS  B_USER B_PASS  A_UID (override if auto-resolve fails)

import { HOST, makeSession as makeBaseSession } from './lib/probe-common.mjs';

const A_USER = process.env.A_USER || 'Default User';
const A_PASS = process.env.A_PASS || 'robotics';
const B_USER = process.env.B_USER || 'Admin';
const B_PASS = process.env.B_PASS || 'robotics';

async function resolveBase() {
  if (process.env.RWS2_URL) { return new URL(process.env.RWS2_URL); }
  if (process.env.PORT) { return new URL(`https://${HOST}:${process.env.PORT}`); }
  // A bare TCP check matches unrelated services — issue an actual request.
  for (const p of [9403, 5466, 443, 11811]) {
    const probe = makeBaseSession(`https://${HOST}:${p}`, { user: A_USER, pass: A_PASS });
    const t = await probe.req('GET', '/rw/system/robottype');
    if (t.status && t.status >= 100) { return probe.url; }
  }
  return null;
}

function makeUserSession(base, user, pass) {
  const s = makeBaseSession(base, { user, pass });
  return { user, req: s.req, logout: s.logout };
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
  const base = await resolveBase();
  if (!base) {
    console.error('No RWS 2.0 controller answered on ' + HOST + ' (tried 9403, 5466, 443, 11811).');
    console.error('Start the OmniCore VC in RobotStudio, or pass RWS2_URL=… explicitly.');
    process.exit(1);
  }
  const A = makeUserSession(base, A_USER, A_PASS);
  const B = makeUserSession(base, B_USER, B_PASS);

  console.log(`\n=== RMMP headless-grant probe — ${base.host} ===`);
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
  await A.logout();
  await B.logout();
  console.log('Done.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
