// Probe: does /rw/motionsystem/moveinauto/token unlock motion authority in AUTO
// WITHOUT the FlexPendant?  (RWS 2.0 / OmniCore only)
//
// Hypothesis: the documented-but-never-probed "Move in auto certificate key"
// (GET /rw/motionsystem/moveinauto/token, RWS2_Full_Reference.md:428 — referenced
// NOWHERE in the client) may be the layer above RMMP+mastership that authorises
// jogging/positioning while opmode=AUTO. If so, it overturns the project's
// "AUTO control is FlexPendant-only by design" conclusion.
//
// PASS 1 is pure reconnaissance (all reads): does the endpoint even exist, what
// does it return, and what are the current opmode / mastership / RMMP / enable states.
// PASS 2 acquires edit+motion mastership + RMMP and re-reads the token.
// PASS 3 (the actual jog) is GATED behind ATTEMPT_MOTION (default off) and only runs
// in AUTO. RUN AGAINST A VIRTUAL CONTROLLER — PASS 3 can command simulated motion.
//
// Run:  node scripts/probe-moveinauto-token.js
//       ATTEMPT_MOTION=1 node scripts/probe-moveinauto-token.js   (also tries a jog)
// Env:  RWS2_URL HOST PORT RWS_USER RWS_PASS (see scripts/lib/probe-common.mjs)

import { HOST, RWS_USER, makeSession } from './lib/probe-common.mjs';

const USER = RWS_USER;
const ATTEMPT_MOTION = /^(1|true|yes)$/i.test(process.env.ATTEMPT_MOTION || '');

let session = null;
const req = (method, path, body, extraHeaders) =>
  session.req(method, path, body, extraHeaders ? { headers: extraHeaders } : undefined);

async function resolveBase() {
  if (process.env.RWS2_URL) { return new URL(process.env.RWS2_URL); }
  if (process.env.PORT) { return new URL(`https://${HOST}:${process.env.PORT}`); }
  // Verify a real RWS 2.0 (HTTPS) controller answers — a bare TCP check matches
  // unrelated services (e.g. Windows HTTP.sys on :80), so issue an actual request.
  for (const p of [9403, 5466, 443, 11811]) {
    const probe = makeSession(`https://${HOST}:${p}`);
    const t = await probe.req('GET', '/rw/system/robottype');
    if (t.status && t.status >= 100) { return probe.url; }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = xml => (xml || '')
  .replace(/<\?xml.*?\?>/, '').replace(/<!DOCTYPE.*?>/, '')
  .replace(/<html[^>]*>|<head>[\s\S]*?<\/head>|<\/?body[^>]*>|<\/html>/g, '')
  .replace(/></g, '>\n<').trim();
const spanList = xml => ((xml || '').match(/<span[^>]*>[^<]*<\/span>/g) || []);
const getSpan = (xml, cls) => { const m = (xml || '').match(new RegExp(`<span class="${cls}">([^<]*)</span>`)); return m ? m[1] : null; };
const errDetail = body => {
  if (!body) { return ''; }
  const c = body.match(/code:(-?\d+)\s+icode:(-?\d+)/);
  const m = body.match(/<span class="msg">([^<]+)<\/span>/);
  return (m ? m[1] : '') + (c ? ` [code=${c[1]} icode=${c[2]}]` : '');
};
const show = (label, r) => {
  const ok = r.status >= 200 && r.status < 300;
  const d = errDetail(r.body);
  console.log(`  ${label}: ${r.status} ${ok ? '✓' : '✗'}${d ? '  ' + d.slice(0, 120) : ''}`);
};

async function main() {
  const base = await resolveBase();
  if (!base) {
    console.error('No RWS 2.0 controller answered on ' + HOST + ' (tried 9403, 5466, 443, 11811).');
    console.error('Start the OmniCore VC in RobotStudio, or pass RWS2_URL=… explicitly.');
    process.exit(1);
  }
  session = makeSession(base, { user: USER });
  console.log(`\n=== moveinauto/token probe — ${base.host} as ${USER} ===`);
  console.log(`ATTEMPT_MOTION=${ATTEMPT_MOTION}\n`);

  // ── PASS 1: reconnaissance (read-only) ──────────────────────────────────────
  console.log('── PASS 1: current state (read-only) ──');
  const op = await req('GET', '/rw/panel/opmode'); await sleep(80);
  const opmode = getSpan(op.body, 'opmode') || '?';
  console.log(`  opmode      = ${opmode}`);
  const ctrl = await req('GET', '/rw/panel/ctrl-state'); await sleep(80);
  console.log(`  ctrl-state  = ${getSpan(ctrl.body, 'ctrlstate') || getSpan(ctrl.body, 'ctrl-state') || '?'}`);
  for (const [lbl, p] of [
    ['enreq', '/rw/panel/enreq'],
    ['mastership/edit', '/rw/mastership/edit'],
    ['mastership/motion', '/rw/mastership/motion'],
    ['users/rmmp', '/users/rmmp'],
    ['users/login-info', '/users/login-info'],
  ]) {
    const r = await req('GET', p); await sleep(80);
    console.log(`  ${lbl.padEnd(18)} → ${r.status}  ${spanList(r.body).slice(0, 6).join('  ') || ''}`);
  }

  // ── THE KEY ENDPOINT (read-only, no mastership yet) ─────────────────────────
  console.log('\n── moveinauto/token — does it exist? (no mastership held) ──');
  const tok1 = await req('GET', '/rw/motionsystem/moveinauto/token'); await sleep(80);
  console.log(`  GET /rw/motionsystem/moveinauto/token → ${tok1.status}`);
  console.log('  body:', clean(tok1.body).slice(0, 500) || '(empty)');

  // ── PASS 2: acquire mastership + RMMP, re-read token ────────────────────────
  console.log('\n── PASS 2: acquire edit+motion mastership + RMMP, then re-read token ──');
  show('mastership/edit/request', await req('POST', '/rw/mastership/edit/request', '')); await sleep(80);
  show('mastership/motion/request', await req('POST', '/rw/mastership/motion/request', '')); await sleep(80);
  show('users/rmmp request modify', await req('POST', '/users/rmmp', 'privilege=modify')); await sleep(80);
  for (let i = 0; i < 3; i++) {
    const poll = await req('GET', '/users/rmmp/poll');
    console.log(`  rmmp/poll[${i}] → ${poll.status}  ${spanList(poll.body).slice(0, 4).join('  ') || ''}`);
    await sleep(300);
  }
  const rmmpNow = await req('GET', '/users/rmmp'); await sleep(80);
  console.log(`  users/rmmp now → ${rmmpNow.status}  ${spanList(rmmpNow.body).slice(0, 6).join('  ') || ''}`);

  let token = null;
  const tok2 = await req('GET', '/rw/motionsystem/moveinauto/token'); await sleep(80);
  console.log(`\n  GET moveinauto/token (with mastership+RMMP) → ${tok2.status}`);
  console.log('  body:', clean(tok2.body).slice(0, 500) || '(empty)');
  if (tok2.status >= 200 && tok2.status < 300) {
    token = getSpan(tok2.body, 'token') || getSpan(tok2.body, 'certificate') || getSpan(tok2.body, 'key')
      || (clean(tok2.body).match(/[A-Za-z0-9+/=_-]{16,}/) || [])[0] || null;
    console.log('  → token candidate:', token ? token.slice(0, 60) + '…' : '(could not parse — inspect body above)');
  }

  // ── PASS 3: motion authorisation test (GATED, AUTO only) ────────────────────
  if (!ATTEMPT_MOTION) {
    console.log('\n── PASS 3 skipped (ATTEMPT_MOTION not set). Re-run with ATTEMPT_MOTION=1 in AUTO to test the jog. ──');
  } else if (opmode !== 'AUTO') {
    console.log(`\n── PASS 3 skipped: opmode is ${opmode}, not AUTO (the whole point is AUTO). Switch the VC to AUTO and re-run. ──`);
  } else {
    console.log('\n── PASS 3: minimal jog in AUTO — reading the AUTHORISATION verdict (VC simulated motion) ──');
    const cc = (Date.now() % 90000) + 1000;
    const jogBody = `jogmode=Joint&mechunit=ROB_1&axis1=1&axis2=0&axis3=0&axis4=0&axis5=0&axis6=0&cjogspeed=5&ccount=${cc}`;
    const j1 = await req('POST', '/rw/motionsystem/jog', jogBody); await sleep(120);
    console.log(`  jog (no token)                 → ${j1.status}  ${errDetail(j1.body).slice(0, 160) || clean(j1.body).slice(0, 160)}`);
    if (token) {
      const j2 = await req(
        'POST', '/rw/motionsystem/jog',
        jogBody.replace(/ccount=\d+/, `ccount=${cc + 1}`) + `&moveinauto-token=${encodeURIComponent(token)}`,
        { 'moveinauto-token': token },
      );
      await sleep(120);
      console.log(`  jog (token in body+header, spec) → ${j2.status}  ${errDetail(j2.body).slice(0, 160) || clean(j2.body).slice(0, 160)}`);
    }
    console.log('  Interpretation:');
    console.log('    403 "opmode not allowed"  = still gated → FlexPendant-only theory HOLDS');
    console.log('    204 / 200                 = motion authorised programmatically in AUTO → BIG finding');
    console.log('    400 "missing param X"     = wire-format issue, not an auth block (iterate the body)');
  }

  // ── teardown (reverse everything we acquired) ───────────────────────────────
  console.log('\n── teardown ──');
  show('users/rmmp/cancel', await req('POST', '/users/rmmp/cancel', '')); await sleep(80);
  show('mastership/motion/release', await req('POST', '/rw/mastership/motion/release', '')); await sleep(80);
  show('mastership/edit/release', await req('POST', '/rw/mastership/edit/release', '')); await sleep(80);
  await session.logout();
  console.log('\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
