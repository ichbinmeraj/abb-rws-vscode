// Host test: the owner's hand test of RAPID Live, run in a real VS Code.
//
//   npm run test:host        (node --test test/host/run-commands.test.js)
//
// Without RWS_TEST_HOST it prints "no VC: skipped" and passes; RWS_TEST_ONLY=U1
// needs no controller and runs anyway. CI (.github/workflows/ci.yml, the host
// job) runs both on every push, U1 in VS Code for Linux under xvfb. With a
// controller, it installs the local .vsix into an empty
// --extensions-dir, starts VS Code with an empty --user-data-dir and
// --extensionTestsPath, and inside that host connects to one controller and
// runs the steps below with the dialogs answered by a script
// (stub-ext/suite.js). Writes test/host/last-run.md (gitignored), with every
// request and every dialog text per step, and prints a summary table.
//
//   A  Lock + Unlock Operation Mode (a refused PIN first), each behind its confirmation
//   B  Show / Control Virtual Time, 10x and back to 1x
//   C  Create Backup + List Backups, the backup deleted afterwards
//   D  Call Service Routine
//   E  Start RAPID: E1 types a wrong robot name, then an empty one (the dialog
//      names the robot, no start goes out for either); E2 types the right one
//      and E3 stops again, only with
//      HOSTTEST_ALLOW_START=1; E2 loads ZZ_PROBE, switches the motors on (a pendant
//      action on RobotWare 8: it prints an instruction and waits) and cleans up after
//   F  Toggle a probe digital output: cancelled, then accepted with a read-back,
//      then accepted again to put it back
//   G  Load CFG File, cancelled at its confirmation (no request)
//   I  Two robot entries for the one controller: a CFG instance opened from the
//      first is saved (Ctrl+S) while the second is active; the confirmation and
//      the notification name the first robot
//
// Read-only acceptance steps, never mixed with A-I (RWS_TEST_ONLY=U1, U2 or U3):
//   U1  language features on a small .mod and the command registry (no controller:
//       works without RWS_TEST_HOST)
//   U2  the robot list: Add Robot from the scan list, Discover Controllers, Manage
//       Saved Addresses, Set as Active Robot, Configure (cancelled), Remove Robot,
//       and the settings JSON (no password); adds and removes one entry
//   U4  (the one U step that writes, always alone): the extension's write
//       commands in AUTO on ZZ_ACC names, each put back afterwards; RobotWare 8 only with
//       Remote Access on.
//   U3  the extension's read commands on the one controller, Refresh, Disconnect,
//       then fresh credentials and a check that no session of the extension is left.
//       Use RWS_TEST_USER='Default User' on an RWS 1.0 controller (http://127.0.0.1:<port>).
//   L1  (writes, always alone) the 1.5.0 live checks (stub-ext/l1.js): the lock state around
//       a watch-only connect and the connect's requests, a write refused in Watch only, the
//       probe module ZZ_L1 pushed with the confirmation naming the robot and the task, the
//       base check with Push anyway after a change through a second session, Restore Module,
//       a forced load failure with the restore offer, a Latin-1 and a UTF-16 file refused, and
//       on RobotWare 8 Motors On refused without Allow Motion Control, then allowed, on, off
//       and withdrawn. Everything is put back and read back; the lock state is read at the end.
//       Writes test/host/last-run-l1-<port>.json with every read-back.
//
// Before a run: close all VS Code windows. A pending VS Code update blocks the test
// instance with "Code is currently being updated" (exit 1) until every window is closed.
//
// Environment:
//   RWS_TEST_HOST  the controller: an http(s) URL (its scheme, host and port), or a
//                  bare host (127.0.0.1, localhost, ::1); unset or blank = skipped.
//                  A RobotStudio VC on this PC: https://127.0.0.1:80. The client's
//                  live suites read the same variable and take both forms (only the
//                  host of a URL); both refuse a host with a port and no scheme
//                  (127.0.0.1:80). See test/host/target.js.
//   RWS_TEST_SCHEME  with a bare host: https (the default) or http
//   RWS_TEST_PORT  with a bare host: the port, default the scheme's own (443 or 80)
//   RWS_TEST_USER  default Admin          RWS_TEST_PASS  default robotics
//   RWS_TEST_PIN   the test PIN step A locks the operation mode with, default
//                  4711 (on RWS 2.0 the lock sets the PIN, so none is needed
//                  from a person); a PIN the lock was not set with, 9999, is tried once first
//   HOSTTEST_ROUTINE  the service routine step D picks, default SkipTaskExec
//   HOSTTEST_ALLOW_START  "1" lets step E2 start RAPID (ZZ_PROBE only). The harness does
//                  the setup itself: it loads test/host/ZZ_PROBE.mod into T_ROB1, puts the
//                  program pointer at ZZ_PROBE_LOOP and switches the motors on (RobotWare 6/7;
//                  on RobotWare 8 switch them on at the pendant when asked: HOSTTEST_MOTORS_WAIT_S,
//                  default 180, is how long it waits before E2 is skipped). Teardown always
//                  runs: stop, motors off, unload, delete the file; the start state is read back.
//   HOSTTEST_DO    the digital output step F toggles, default ZZ_PROBE_DO1 (the VCs' probe
//                  output; there is no ZZ_PROBE_DO)
//   HOSTTEST_CFG_DOMAIN  the CFG domain step I edits an instance of, default SYS
//   VSCODE_EXE     VS Code executable, default the per-user Windows install (`code`
//                  elsewhere); in the Linux archive, VSCode-linux-x64/code
//   VSCODE_CLI     the VS Code CLI that installs the .vsix, default bin/code.cmd
//                  (Windows) or bin/code beside VSCODE_EXE, else `code`
//   RWS_TEST_VSCODE_ARGS  more arguments for the test instance, split on spaces;
//                  CI on Linux: --no-sandbox --disable-gpu --password-store=basic
//   RWS_TEST_STUB  real | none | virtual: start the stub controller (test/host/stub-rws.js)
//                  and run against it, no controller needed. Runs step W1 unless RWS_TEST_ONLY
//                  says otherwise: every write command with every dialog answered, on a
//                  robot RAPID Live treats as watch-only (real, or one that does not say);
//                  the run fails on any POST, PUT or DELETE the stub saw.
//   RWS_TEST_ONLY  run only these steps, letters A-I (also `--only E` when the
//                  file is run with plain `node test/host/run-commands.test.js --only E`)
//   RWS_TEST_VSIX  the .vsix to install, default abb-rws-<version>.vsix in the repo
//   RWS_TEST_CLIENT  the client package folder for read-backs, default
//                  node_modules/abb-rws-client in the repo
//
// Before the steps the operating mode is read and printed; the test never
// changes it. After each step and again after the host exits, a GET /rw/system
// (resent with credentials on a 401, that session then logged out) checks
// that the controller still answers 200.
//
// Changes it makes and undoes: step A runs only on a controller whose
// /ctrl/identity says virtual and whose selector starts unlocked; it locks the
// operation mode selector permanently with the test PIN, tries a PIN it was not set with,
// unlocks with the right one (once more if that fails) and reports the
// lock-state after each request and after each step. Virtual time is set to
// 10x and back to 1x (the command offers no pause or resume). It creates one backup named
// ZZ_HOSTTEST_<timestamp> and deletes that directory afterwards through the
// client's file service (DELETE /fileservice/BACKUP/<name>), then checks it is
// gone from the listing. In manual mode with write access, Call Service Routine
// moves the program pointer to the routine picked; the run puts the pointer
// back where it read it before the step, if it read one. Step E2 starts the
// ZZ_PROBE loop and stops it (through the client too, if the command's stop
// did not take). Step F sets the probe output twice, so it ends as it began.
// Step I writes one CFG instance back with the values it was read with.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getResource, spanText } = require('./stub-ext/probe.js');
const { ROBOT_ID, ROBOT_NAME, ROBOT_ID_2, ROBOT_NAME_2, dialogsIn, requestsIn, allRequestsIn, verdicts, placeGuardRows, report } = require('./verdicts.js');
const { targetFrom } = require('./target.js');
const { startStub } = require('./stub-rws.js');

const REPO = path.resolve(__dirname, '..', '..');
// U1 (language features) needs no controller; every other run does, and without one it skips itself.
// The stub controller to run against (real | none | virtual), or '' for a controller RWS_TEST_HOST names.
const STUB = String(process.env.RWS_TEST_STUB || '').toLowerCase();
const ONLY = onlySteps() || (STUB ? 'W1' : '');
const NO_CONTROLLER_RUN = ONLY === 'U1';
// The controller RWS_TEST_HOST names, or null (target.js); a value of neither form stops the file here.
const TARGET = targetFrom(process.env);
const NO_VC = TARGET || NO_CONTROLLER_RUN || STUB ? false : 'no VC: skipped (set RWS_TEST_HOST, e.g. https://127.0.0.1:80 for a RobotStudio VC on this PC)';

function baseUrl() {
  // A run without a controller (U1) still needs an address to write into the settings; nothing is sent to it.
  return TARGET || targetFrom({ RWS_TEST_HOST: 'https://127.0.0.1:1' });
}

function vscodePaths() {
  if (process.env.VSCODE_EXE) {
    const exe = process.env.VSCODE_EXE;
    // The CLI beside the executable: bin/code.cmd in the Windows install, bin/code in the Linux archive.
    const beside = path.join(path.dirname(exe), 'bin', process.platform === 'win32' ? 'code.cmd' : 'code');
    return { exe, cli: process.env.VSCODE_CLI || (process.platform === 'win32' || fs.existsSync(beside) ? beside : 'code') };
  }
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code');
    return { exe: path.join(dir, 'Code.exe'), cli: path.join(dir, 'bin', 'code.cmd') };
  }
  return { exe: 'code', cli: 'code' };
}

/** Environment for a child VS Code: nothing that ties it to a running instance. */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_') || k === 'ELECTRON_NO_ATTACH_CONSOLE') { delete env[k]; }
  }
  return env;
}

function onlySteps() {
  const i = process.argv.indexOf('--only');
  const raw = i >= 0 ? process.argv[i + 1] : process.env.RWS_TEST_ONLY;
  // Letters A-I are the write steps; U1-U3 the read-only acceptance steps (which never run with them); W1 the stub run.
  return (String(raw || '').toUpperCase().match(/U[1-4]|W1|L1|[A-I]/g) || []).join('');
}

async function systemLine(target, user, pass) {
  const r = await getResource(target.url, user, pass, '/rw/system');
  const name = spanText(r.body, 'name');
  return `GET /rw/system -> ${r.status}${name ? ` (${name}, RobotWare ${spanText(r.body, 'rwversion')})` : ''}`;
}

function findVsix() {
  if (process.env.RWS_TEST_VSIX) {
    if (!fs.existsSync(process.env.RWS_TEST_VSIX)) { throw new Error(`${process.env.RWS_TEST_VSIX} not found`); }
    return process.env.RWS_TEST_VSIX;
  }
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const vsix = path.join(REPO, `abb-rws-${version}.vsix`);
  if (!fs.existsSync(vsix)) { throw new Error(`${vsix} not found: run npm run package first`); }
  return vsix;
}

function readLogLines(sinceIso, untilIso) {
  const dir = path.join(os.homedir(), '.abb-rws-extension', 'logs');
  if (!fs.existsSync(dir)) { return []; }
  const since = Date.parse(sinceIso);
  const lines = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ndjson'))) {
    const full = path.join(dir, f);
    if (fs.statSync(full).mtimeMs < since) { continue; }
    for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const o = JSON.parse(line);
        if (o.ts >= sinceIso && o.ts <= untilIso) { lines.push(o); }
      } catch { /* a torn last line */ }
    }
  }
  return lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
if (NO_VC) { console.log(NO_VC); }

test('RAPID Live commands in a real VS Code host', { timeout: 20 * 60 * 1000, skip: NO_VC }, async () => {
  const user = process.env.RWS_TEST_USER || 'Admin';
  const pass = process.env.RWS_TEST_PASS || 'robotics';
  const { exe, cli } = vscodePaths();
  const vsix = findVsix();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-live-host-'));
  // The stub controller, when asked for: it answers like a RobotWare 7 controller of the given kind and records every request.
  const stubLog = path.join(work, 'stub-requests.jsonl');
  const stub = STUB ? await startStub({ ctrlType: STUB, logFile: stubLog }) : null;
  const target = stub ? targetFrom({ RWS_TEST_HOST: stub.url }) : baseUrl();
  const userData = path.join(work, 'user');
  const extDir = path.join(work, 'ext');
  const folder = path.join(work, 'ws');
  const out = path.join(work, 'result.json');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.mkdirSync(extDir); fs.mkdirSync(folder);

  try {
    const inst = spawnSync(`"${cli}"`, ['--extensions-dir', `"${extDir}"`, '--user-data-dir', `"${userData}"`, '--install-extension', `"${vsix}"`],
      { shell: true, env: childEnv(), encoding: 'utf8', timeout: 180000 });
    assert.strictEqual(inst.status, 0, `install failed: ${inst.stdout}${inst.stderr}`);

    // The extension's settings model: abbRobot.robots entries; a password found
    // there is moved to SecretStorage on activation.
    // Two entries for the one controller: step I saves a CFG instance opened
    // from the first while the second is active.
    const robot = (id, name) => ({ id, name, host: target.host, port: target.port, useHttps: target.https, username: user, password: pass });
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'abbRobot.robots': [robot(ROBOT_ID, ROBOT_NAME), robot(ROBOT_ID_2, ROBOT_NAME_2)],
      'abbRobot.strictTls': false,
      'abbRobot.refreshInterval': 2000,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
      'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false,
    }, null, 2));

    const before = NO_CONTROLLER_RUN && !TARGET ? 'no controller (U1)' : stub ? `stub controller (${STUB}) at ${stub.url}` : await systemLine(target, user, pass);
    const started = new Date().toISOString();
    const args = [folder,
      `--extensionDevelopmentPath=${path.join(__dirname, 'stub-ext')}`,
      `--extensionTestsPath=${path.join(__dirname, 'stub-ext', 'suite.js')}`,
      `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
      ...String(process.env.RWS_TEST_VSCODE_ARGS || '').split(/\s+/).filter(Boolean)];
    const env = childEnv({
      HOSTTEST_OUT: out, HOSTTEST_BASE_URL: target.url, HOSTTEST_USER: user, HOSTTEST_PASS: pass,
      HOSTTEST_PIN: process.env.RWS_TEST_PIN || '',
      HOSTTEST_ROBOT_ID: ROBOT_ID, HOSTTEST_ROBOT_NAME: ROBOT_NAME,
      HOSTTEST_ROBOT_ID_2: ROBOT_ID_2, HOSTTEST_ROBOT_NAME_2: ROBOT_NAME_2,
      HOSTTEST_ONLY: ONLY,
      HOSTTEST_STUB: STUB, HOSTTEST_STUB_LOG: stubLog,
      HOSTTEST_USER_DATA: userData, HOSTTEST_FOLDER: folder,
      HOSTTEST_CLIENT: pathToFileURL(path.join(process.env.RWS_TEST_CLIENT || path.join(REPO, 'node_modules', 'abb-rws-client'), 'dist', 'index.js')).href,
    });
    let hostOutput = '';
    const code = await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => { hostOutput += d; });
      child.stderr.on('data', d => { hostOutput += d; });
      child.on('error', reject);
      child.on('exit', c => resolve(c));
    });
    await new Promise(r => setTimeout(r, 1000)); // let the log stream flush
    assert.ok(fs.existsSync(out), `the host wrote no result (exit ${code}); its output ended:\n${hostOutput.slice(-3000)}`);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    const log = readLogLines(started, result.finished || new Date().toISOString());

    if (stub) { result.w1 = { ...(result.w1 || {}), writes: stub.writes().map(r => `${r.method} ${r.path}`), requests: stub.requests.length }; }
    const idle = result.steps.find(s => s.name === 'idle');
    const pollPaths = new Set(idle ? log.filter(l => l.category === 'http.req' && l.ts >= idle.start && l.ts <= idle.end).map(l => l.data && l.data.path) : []);
    const v = verdicts(result, log);
    const rows = result.steps.filter(s => s.name !== 'idle').map(s => ({
      // Step D lists every request, polling included, so the mode read shows.
      step: s.name, command: s.command, dialogs: dialogsIn(result, s.name),
      requests: /^D /.test(s.name) ? allRequestsIn(s, log) : requestsIn(s, log, pollPaths),
      verdict: v[s.name] || (s.ok ? 'ran' : `threw: ${s.thrown}`),
    }));

    for (const key of Object.keys(v)) {
      if (/^(U[1-4]|W1|L1) /.test(key) && !rows.some(r => r.step === key)) {
        rows.push({ step: key, command: '(derived)', dialogs: [], requests: [], verdict: v[key] });
      }
    }
    // A step that did not run says why, in its place (verdicts.js placeGuardRows).
    placeGuardRows(rows, v);
    result.before = before;
    result.after = NO_CONTROLLER_RUN && !TARGET ? 'no controller (U1)' : stub ? `stub controller: ${stub.requests.length} requests, ${stub.writes().length} writes` : await systemLine(target, user, pass);
    const md = report(target, result, log, rows);
    fs.writeFileSync(path.join(__dirname, 'last-run.md'), md);
    fs.writeFileSync(path.join(__dirname, `last-run-${target.port}.md`), md);
    if (result.l1) {
      // Every read-back of the 1.5.0 live checks, with the rows, the dialogs and the requests per step.
      const l1 = { controller: target.url, started: result.started, finished: result.finished, before: result.before, after: result.after, ...result.l1, rows: rows, readbacks: result.readbacks, notes: result.l1.notes };
      fs.writeFileSync(path.join(__dirname, `last-run-l1-${target.port}.json`), JSON.stringify(l1, null, 2));
    }

    console.log(`\nController ${target.url}; operation mode at start: ${result.mode ?? 'not read'}${result.only ? `; steps ${result.only}` : ''}`);
    console.table(rows.map(r => ({
      step: r.step,
      requests: r.requests.map(q => `${q.method} ${q.path}${q.body ? ` ${q.body}` : ''}`).join('; ') || '(none)',
      status: r.requests.map(q => q.status).join(',') || '-',
      verdict: r.verdict,
    })));
    if (result.cleanup.length) { console.log(result.cleanup.join('\n')); }
    console.log(`Before the run: ${result.before}`);
    for (const p of result.probes || []) { console.log(`After step ${p.after}: GET /rw/system -> ${p.status}; lock-state ${p.lockstate}`); }
    console.log(`After the run: ${result.after}`);

    assert.ok(!result.fatal, result.fatal);
    assert.deepStrictEqual((result.probes || []).filter(p => p.status !== 200).map(p => `after ${p.after}: ${p.status}`), []);
    const failed = rows.filter(r => /^FAIL/.test(r.verdict));
    assert.deepStrictEqual(failed.map(r => `${r.step}: ${r.verdict}`), []);
    if (stub) {
      // The stub run is the watch-only test: steps ran, and nothing that changes a controller left the extension.
      assert.ok(rows.some(r => /^W1 /.test(r.step)), 'the stub run ran no W1 step');
      assert.deepStrictEqual(stub.writes().map(r => `${r.method} ${r.path}`), [], 'a write reached the stub controller');
    }
  } finally {
    if (stub) { await stub.close(); }
    // The temp profile holds the test password in settings and secret storage. On Windows the host can
    // still hold a file for a moment after it exits: a profile that cannot be removed is named, not a failure.
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
    catch (e) { console.warn(`the temp profile ${work} could not be removed (${e && e.message ? e.message : String(e)}); remove it by hand`); }
  }
});
