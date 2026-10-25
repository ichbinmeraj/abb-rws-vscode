// The host harness's verdicts and report: pure functions over the result the
// suite wrote (stub-ext/suite.js) and the extension's log lines, so a unit test
// (test/hostVerdicts.test.ts) can check them without a controller.

'use strict';

// Two entries for the one controller (step I); the first is the one every other step drives.
const ROBOT_ID = 'hosttest';
const ROBOT_NAME = 'Host test';
const ROBOT_ID_2 = 'hosttest-2';
const ROBOT_NAME_2 = 'Host test 2';
const WRITE_ACCESS_REFUSED = 0xC004AB20 | 0; // -1073435872

/** The dialog texts shown in a step, one line each, for the report table. */
function dialogsIn(result, name) {
  const lines = [];
  for (const u of result.ui.filter(u => u.step === name)) {
    if (['info', 'warning', 'error'].includes(u.kind)) {
      lines.push(`${u.modal ? 'modal ' : ''}${u.kind}: ${u.text}${u.detail ? ` / ${u.detail}` : ''}${u.buttons && u.buttons.length ? ` [${u.buttons.join(' / ')}]` : ''}`);
    } else if (u.kind === 'inputBox') {
      lines.push(`input: ${u.title || ''}${u.prompt ? ` / ${u.prompt}` : ''}`);
    } else if (u.kind === 'answer') {
      lines.push(`answer(${u.to}): ${JSON.stringify(u.value)}${u.refusedBy ? ` (refused: ${u.refusedBy})` : ''}`);
    }
  }
  return lines.map(l => l.replace(/\n/g, ' ').replace(/\|/g, '\\|'));
}

/**
 * Whether step D was refused for the operating mode (the client's hold on RobotWare 8 in
 * Auto, `WRONG_MODE`, or the controller's own). Judged on what is stable, never on one
 * sentence of the client's:
 *   1. an `error.shown` line of the step whose `rwsCode` is WRONG_MODE or whose
 *      `refusalKind` is wrong-mode (logged when the extension shows an error dialog);
 *   2. otherwise the dialog text. The extension shows a mode refusal as a plain warning
 *      carrying the client's sentence and logs no error line (src/extension.ts,
 *      abbRobot.callServiceRoutine), and that dialog does not name the robot, so the
 *      harness can only see words. Every wording so far ("service routines are called in
 *      manual mode in AUTO"; "not sent on RobotWare 8 in Auto ... MANR or MANF") says
 *      "manual mode", "MANR ... MANF" or "not sent on RobotWare N in <mode>"; none
 *      starts with "Program pointer set to". Add a fragment here if a wording drops all three.
 * Returns { viaLog, text } or undefined.
 */
function modeRefusalIn(shownLogs, dTexts) {
  const byKind = shownLogs.map(l => l.data || {})
    .find(x => x.rwsCode === 'WRONG_MODE' || x.refusalKind === 'wrong-mode');
  if (byKind) { return { viaLog: true, text: String(byKind.friendly || byKind.raw || byKind.rwsCode || byKind.refusalKind) }; }
  const text = dTexts.find(t => !/^Program pointer set to/.test(t)
    && (/\bmanual mode\b/i.test(t) || /\bMANR\b.*\bMANF\b/.test(t) || /\bnot sent on RobotWare \d+ in \w+/i.test(t)));
  return text ? { viaLog: false, text } : undefined;
}

/** GET /rw/system with the system name and version, for the report before and after the run. */

function requestsIn(step, log, pollPaths) {
  const inStep = log.filter(l => l.ts >= step.start && l.ts <= step.end);
  const out = [];
  // Which answers are taken is kept here, not on the log lines: steps are read more than once.
  const used = new Set();
  for (const l of inStep) {
    if (l.category !== 'http.req' || / retrying /.test(l.msg)) { continue; }
    const d = l.data || {};
    if (d.method === 'GET' && pollPaths.has(d.path)) { continue; }
    const res = inStep.find(r => (r.category === 'http.res' || r.category === 'http.err') && r.ts >= l.ts
      && r.data && r.data.method === d.method && r.data.path === d.path && !used.has(r));
    if (res) { used.add(res); }
    out.push({ method: d.method, path: d.path, body: d.bodyPreview,
      status: res ? (res.data.status ?? res.data.httpStatus ?? (res.category === 'http.err' ? 'err' : '?')) : '?' });
  }
  return out;
}

/** Every request in a step, the extension's polling included, in order. */
function allRequestsIn(step, log) {
  return requestsIn(step, log, new Set());
}

function verdicts(result, log) {
  const ui = name => result.ui.filter(u => u.step === name);
  const rb = label => (result.readbacks.find(r => r.label === label) || {}).value;
  const texts = name => ui(name).filter(u => ['info', 'warning', 'error'].includes(u.kind)).map(u => u.text);
  const v = {};

  v['connect'] = texts('connect').some(t => /failed/i.test(t)) ? 'FAIL: connect refused' : 'PASS';

  // Step A: lock with the test PIN, a mismatched PIN refused, the right PIN unlocks.
  const sA = result.stepA || {};
  if (sA.refused) { v['A guard'] = `skipped: ${sA.refused}`; }
  const lockAfter = label => (result.lockStates || []).find(l => l.label === label)?.value;
  const errorsOf = name => ui(name).filter(u => u.kind === 'error').map(u => u.text);
  const prompted = name => ui(name).filter(u => u.kind === 'answer' && u.refusedBy).map(u => u.refusedBy);
  // The confirmation before a write (src/confirm.ts): a modal naming the robot
  // as "<name> (<host>:<port>)", with the button that names it.
  const modals = name => ui(name).filter(u => u.kind === 'warning' && u.modal);
  const robotLabel = `${ROBOT_NAME} (`;
  const confirmed = (name, button) => {
    const m = modals(name).find(x => (x.buttons || []).includes(button));
    if (!m) { return `no confirmation with the button "${button}" (modals: ${modals(name).map(x => x.text).join(' | ') || 'none'})`; }
    if (!m.text.includes(robotLabel)) { return `the confirmation does not name ${ROBOT_NAME}: ${m.text}`; }
    const answered = ui(name).some(u => u.kind === 'answer' && u.to === 'warning' && u.value === button);
    return answered ? undefined : `the button "${button}" was not pressed`;
  };
  const a1 = texts('A1 lockOpMode');
  const a1Confirm = confirmed('A1 lockOpMode', `Continue on ${ROBOT_NAME}`);
  v['A1 lockOpMode'] = prompted('A1 lockOpMode').length ? `FAIL: the prompt refused the PIN: ${prompted('A1 lockOpMode')}`
    : a1Confirm ? `FAIL: ${a1Confirm}`
    : a1.includes('Operation mode locked.') && lockAfter('lock state after lock') === 'permlocked'
      ? `PASS (confirmation names ${ROBOT_NAME}; notification "Operation mode locked."; lock-state permlocked)`
      : `FAIL: ${a1.join(' | ') || 'no notification'}; lock-state ${lockAfter('lock state after lock')}`;
  const a2 = errorsOf('A2 unlockOpMode refused PIN');
  const a2State = lockAfter('lock state after the refused PIN');
  const a2Info = texts('A2 unlockOpMode refused PIN');
  v['A2 unlockOpMode refused PIN'] = a2.length && a2State === 'permlocked'
    ? `PASS (refused; ${a2.some(t => /PIN is invalid/i.test(t)) ? 'names "PIN is invalid"' : 'does NOT name "PIN is invalid"'}; still permlocked): ${a2.join(' | ')}`
    : !a2.length
      ? `FAIL: no refusal shown (lock-state ${a2State}): ${a2Info.join(' | ') || 'no notification'}`
      : `FAIL: refused but lock-state ${a2State}`;
  const unlockedEarly = a2State === 'unlocked';
  for (const [name, label] of [['A3 unlockOpMode', 'lock state after unlock'], ['A4 unlockOpMode retry', 'lock state after the retry']]) {
    if (!result.steps.some(s => s.name === name)) { continue; }
    const t = texts(name);
    const c = confirmed(name, `Continue on ${ROBOT_NAME}`);
    v[name] = c ? `FAIL: ${c}`
      : t.includes('Operation mode unlocked.') && lockAfter(label) === 'unlocked'
      ? `PASS (confirmation names ${ROBOT_NAME}; notification "Operation mode unlocked."; lock-state unlocked${unlockedEarly ? '; the selector was already unlocked at this step' : ''})`
      : `FAIL: ${t.join(' | ') || 'no notification'}; lock-state ${lockAfter(label)}`;
  }

  const vt = (label, test, want) => {
    const r = rb(label);
    return r && test(r) ? `PASS (read ${r.state}, ${r.speed}x)` : `FAIL: want ${want}, read ${r ? `${r.state}, ${r.speed}x` : 'nothing'}`;
  };
  const offered = (result.vtButtons || []).join(', ');
  const noPause = (result.vtButtons || []).every(b => /^Set scale (1|10)x$/.test(b));
  v['B1 virtualTime 10x'] = noPause ? `${vt('virtual time after 10x', r => r.speed === 10, '10x')}; buttons ${offered}`
    : `FAIL: the notification offers ${offered}`;
  v['B2 virtualTime 1x'] = vt('virtual time after 1x', r => r.speed === 1, '1x');

  const name = result.backupName;
  v['C1 createBackup'] = texts('C1 createBackup').some(t => t === `✓ Backup "${name}" created.`)
    ? 'PASS' : `FAIL: ${texts('C1 createBackup').join(' | ') || 'no created notification'}`;
  const listed = ui('C2 listBackups').find(u => u.kind === 'quickPick');
  v['C2 listBackups'] = !(listed && listed.items.some(i => i.label === name)) ? `FAIL: ${name} not in the list`
    : result.backupGone ? `PASS (${listed.items.length} listed; deleted afterwards, gone from the listing)`
      : `FAIL (clean-up): ${name} was listed but is still listed after the delete`;

  const d = 'D callServiceRoutine';
  const dTexts = texts(d);
  const step = result.steps.find(s => s.name === d) || {};
  const shown = log.filter(l => l.category === 'error.shown' && step.start && l.ts >= step.start && l.ts <= step.end);
  const refused = shown.some(l => {
    const x = l.data || {};
    return x.controllerCode === WRITE_ACCESS_REFUSED || /C004AB20/i.test(`${x.raw} ${x.rwsDetail}`)
      || String(x.raw || '').includes(String(WRITE_ACCESS_REFUSED)) || String(x.rwsDetail || '').includes(String(WRITE_ACCESS_REFUSED));
  });
  const pick = ui(d).find(u => u.kind === 'answer' && u.to === 'quickPick');
  // Outside manual mode the client reads the mode and refuses before sending
  // the pointer move or asking for write access.
  const all = step.start ? allRequestsIn(step, log) : [];
  const forbidden = all.filter(q => (q.method === 'POST' && /\/pcp\/routine/.test(q.path)) || /writeaccess|mastership|rmmp/i.test(q.path));
  const wrongMode = modeRefusalIn(shown, dTexts);
  if (wrongMode) {
    const mode = String(result.mode || '').toUpperCase();
    // The refusal names the mode it was refused in, in the client's own case ("in Auto", "in AUTO").
    const named = !mode || wrongMode.viaLog || new RegExp(`\\bin ${mode}\\b`, 'i').test(wrongMode.text);
    v[d] = forbidden.length ? `FAIL: refused for the mode but sent ${forbidden.map(q => `${q.method} ${q.path}`).join(', ')}`
      : named ? `PASS (refused in ${mode}; nothing written; matched on ${wrongMode.viaLog ? 'the error kind' : 'the dialog text'})`
        : `FAIL: refusal does not name ${mode || 'the mode'}: ${wrongMode.text}`;
  } else if (refused) {
    const friendly = dTexts.find(t => /Messages button/.test(t));
    v[d] = friendly ? 'PASS (refused 0xC004AB20; message names the Messages button)'
      : `FAIL: refused 0xC004AB20 but the message does not name the Messages button: ${dTexts.join(' | ')}`;
  } else if (dTexts.some(t => /^Program pointer set to/.test(t))) {
    const before = rb('program pointer before') || {};
    const after = rb('program pointer after') || {};
    const want = result.routineWanted;
    const started = dTexts.filter(t => /\bstarted\b/i.test(t));
    const sent = all.filter(q => q.method === 'POST' && /\/execution\/start|\/rapid\/execution\?action=start/.test(q.path));
    const moved = pick && pick.value === want && after.routine === want
      && (want !== 'SkipTaskExec' || after.module === 'BASEFUN');
    v[d] = started.length || sent.length ? `FAIL: the routine was started: ${[...started, ...sent.map(q => `${q.method} ${q.path}`)].join(' | ')}`
      : moved ? `PASS (picked ${want} from ${(ui(d).find(u => u.kind === 'quickPick') || { items: [] }).items.length} listed; PP ${before.module}/${before.routine} -> ${after.module}/${after.routine}; not started)`
        : `FAIL: picked ${pick ? pick.value : 'nothing'}, notification says set, read back ${after.module}/${after.routine}`;
  } else if (!pick) {
    const listedD = ui(d).find(u => u.kind === 'quickPick');
    v[d] = `FAIL: ${result.routineWanted} not in the quick pick (${listedD ? listedD.items.map(i => i.label || i).join(', ') : 'no quick pick shown'})`;
  } else {
    v[d] = `FAIL: ${dTexts.join(' | ') || 'no notification'}`;
  }
  // Requests of a step, polling included, that are writes (anything but GET).
  const stepOf = name => result.steps.find(s => s.name === name);
  const writesIn = name => { const s = stepOf(name); return s && s.start ? allRequestsIn(s, log).filter(q => q.method !== 'GET') : []; };
  const list = qs => qs.map(q => `${q.method} ${q.path} -> ${q.status}`).join(', ');
  const START = /rapid\/execution(\/start|\?action=start)/;
  const SET = /iosystem\/signals\/.*(set-value|action=set)/;
  const CFG_LOAD = /\/rw\/cfg(\/load|\?action=load)/;

  // Step E1: the motion confirmation names the robot; a wrong name, and then an empty
  // one, are refused; nothing is sent for either.
  // `what` names the case in the verdict ("the wrong name", "the empty name"); `typed` is
  // what the harness answered the name box with; `after` is the execution-state read-back.
  const e1 = (name, what, typed, after) => {
    const m = modals(name).find(x => /^Start RAPID on /.test(x.text));
    const input = ui(name).find(u => u.kind === 'inputBox');
    const answered = ui(name).some(u => u.kind === 'answer' && u.to === 'inputBox' && u.value === typed);
    const refusedText = texts(name).find(t => t === `Start RAPID not sent to ${ROBOT_NAME}: "${typed}" is not its name.`);
    const sent = writesIn(name);
    return !m ? 'FAIL: no modal "Start RAPID on …"'
      : !m.text.includes(robotLabel) ? `FAIL: the modal does not name ${ROBOT_NAME}: ${m.text}`
      : !(m.detail || '').includes('This can move the robot.') ? `FAIL: the modal does not say the robot can move: ${m.detail}`
      : !input || input.title !== `Start RAPID on ${ROBOT_NAME}` ? `FAIL: no name box titled "Start RAPID on ${ROBOT_NAME}" (${input ? input.title : 'none'})`
      : !refusedText ? `FAIL: no refusal of ${what} "${typed}": ${texts(name).join(' | ') || 'no notification'}`
      : sent.length ? `FAIL: ${what} was refused but something was sent: ${list(sent)}`
      : rb(after.label) === 'running' ? `FAIL: RAPID reads running after ${after.step}`
      : !answered ? `FAIL: the name box was not answered with "${typed}"`
      : `PASS (modal names ${m.text.slice('Start RAPID on '.length)}; "${typed}" refused; nothing sent)`;
  };
  if (stepOf('E1 startRapid wrong name')) {
    v['E1 startRapid wrong name'] = e1('E1 startRapid wrong name', 'the wrong name', (result.stepE || {}).wrongName,
      { label: 'execution state after E1', step: 'E1' });
  }
  if (stepOf('E1 startRapid empty name')) {
    v['E1 startRapid empty name'] = e1('E1 startRapid empty name', 'the empty name', '',
      { label: 'execution state after the empty name', step: 'the empty name' });
  }
  if (result.stepE && result.stepE.e2 && result.stepE.e2 !== 'run') { v['E2 guard'] = result.stepE.e2; }
  if (stepOf('E2 startRapid')) {
    const sent = writesIn('E2 startRapid').filter(q => START.test(q.path));
    const c = confirmed('E2 startRapid', 'Continue');
    const typed = ui('E2 startRapid').some(u => u.kind === 'answer' && u.to === 'inputBox' && u.value === ROBOT_NAME);
    // The controller's own refusal (a guard stop, the access level) is its decision: with a dialog that names the robot, it passes.
    const refusedDialog = ui('E2 startRapid').find(u => u.kind === 'error' && String(u.text).includes(robotLabel));
    const refusedByController = sent.length > 0 && sent.every(q => String(q.status) === '403') && refusedDialog;
    v['E2 startRapid'] = c ? `FAIL: ${c}` : !typed ? 'FAIL: the robot name was not typed'
      : refusedByController ? `PASS (name typed; the controller refused: ${list(sent)}; the dialog names ${ROBOT_NAME}: ${refusedDialog.text})`
      : !sent.length ? `FAIL: no start request (${list(writesIn('E2 startRapid')) || 'nothing sent'})`
      : rb('execution state after E2 start') !== 'running' ? `FAIL: start answered ${sent.map(q => q.status).join(',')} but RAPID reads ${rb('execution state after E2 start')}`
      : `PASS (name typed; ${list(sent)}; reads running)`;
    const stop = writesIn('E3 stopRapid');
    const asked = modals('E3 stopRapid').length;
    v['E3 stopRapid'] = asked ? 'FAIL: Stop RAPID asked for a confirmation'
      : !stop.length ? 'FAIL: no stop request'
      : rb('execution state after E3 stop') !== 'stopped' ? `FAIL: RAPID reads ${rb('execution state after E3 stop')} after the stop`
      : `PASS (no confirmation; ${list(stop)}; reads stopped)`;
  }

  // Step F: the change acknowledgement names the robot and the signal; a cancel sends nothing.
  const f = result.stepF || {};
  if (f.refused) { v['F guard'] = `skipped: ${f.refused}`; }
  if (stepOf('F1 toggleSignal cancel')) {
    const m = modals('F1 toggleSignal cancel')[0];
    const sent = writesIn('F1 toggleSignal cancel');
    const after1 = (rb(`signal ${f.signal} after F1`) || {}).lvalue;
    v['F1 toggleSignal cancel'] = !m ? 'FAIL: no confirmation shown'
      : !m.text.includes(robotLabel) || !m.text.includes(`Toggle ${f.signal}`) ? `FAIL: the confirmation does not name the robot and the signal: ${m.text}`
      : !(m.buttons || []).includes(`Write to ${ROBOT_NAME}`) ? `FAIL: buttons ${(m.buttons || []).join(' / ')}`
      : sent.length ? `FAIL: cancelled but sent ${list(sent)}`
      : after1 !== f.before ? `FAIL: ${f.signal} reads ${after1} after the cancel (was ${f.before})`
      : `PASS (confirmation "${m.text}" [${m.buttons.join(' / ')}]; cancelled; nothing sent; ${f.signal} still ${f.before})`;
    const flipped = f.before === '1' ? '0' : '1';
    const s2 = writesIn('F2 toggleSignal accept').filter(q => SET.test(q.path));
    const c2 = confirmed('F2 toggleSignal accept', `Write to ${ROBOT_NAME}`);
    const refused2 = ui('F2 toggleSignal accept').find(u => u.kind === 'error' && String(u.text).includes(robotLabel));
    const refusedByController2 = s2.length > 0 && s2.every(q => String(q.status) === '403') && refused2 && f.after2 === f.before;
    v['F2 toggleSignal accept'] = c2 ? `FAIL: ${c2}`
      : refusedByController2 ? `PASS (the controller refused: ${list(s2)}; the dialog names ${ROBOT_NAME}: ${refused2.text}; ${f.signal} still ${f.before})`
      : !s2.length ? `FAIL: no set-value request (${list(writesIn('F2 toggleSignal accept')) || 'nothing sent'})`
      : f.after2 !== flipped ? `FAIL: ${list(s2)}; ${f.signal} reads ${f.after2}, want ${flipped}`
      : `PASS (${list(s2)}; ${f.signal} ${f.before} -> ${f.after2})`;
    const s3 = writesIn('F3 toggleSignal restore').filter(q => SET.test(q.path));
    const c3 = confirmed('F3 toggleSignal restore', `Write to ${ROBOT_NAME}`);
    v['F3 toggleSignal restore'] = c3 ? `FAIL: ${c3}`
      : !s3.length ? 'FAIL: no set-value request'
      : f.after3 !== f.before ? `FAIL: ${f.signal} reads ${f.after3} after the restore, was ${f.before}`
      : `PASS (${list(s3)}; ${f.signal} back to ${f.before})`;
  }

  // Step G: the disruptive confirmation names the robot; cancelled, so no load request.
  if (stepOf('G loadCfgFile cancel')) {
    const m = modals('G loadCfgFile cancel')[0];
    const sent = writesIn('G loadCfgFile cancel');
    v['G loadCfgFile cancel'] = !m ? 'FAIL: no confirmation shown'
      : !m.text.includes(robotLabel) || !/^Load CFG file on /.test(m.text) ? `FAIL: the confirmation does not name ${ROBOT_NAME}: ${m.text}`
      : !(m.buttons || []).includes(`Continue on ${ROBOT_NAME}`) ? `FAIL: buttons ${(m.buttons || []).join(' / ')}`
      : !(m.detail || '').includes('ZZ_HOSTTEST.cfg') ? `FAIL: the side effects do not name the file: ${m.detail}`
      : sent.length ? `FAIL: cancelled but sent ${list(sent)}`
      : sent.some(q => CFG_LOAD.test(q.path)) ? `FAIL: a load went out: ${list(sent)}`
      : `PASS (confirmation "${m.text}" [${m.buttons.join(' / ')}]; cancelled; nothing sent)`;
  }

  // Step I: the write-back and its dialogs name the robot the instance was opened from.
  const i = result.stepI || {};
  if (i.refused) { v['I guard'] = `skipped: ${i.refused}`; }
  if (stepOf('I5 save on non-active')) {
    const name = 'I5 save on non-active';
    const m = modals(name)[0];
    const shown = texts(name).filter(t => !modals(name).some(x => x.text === t));
    const logged = log.filter(l => l.category === 'error.shown' && l.ts >= stepOf(name).start && l.ts <= stepOf(name).end);
    // The success notification quotes the name; an error dialog starts with the robot label. The visible text decides.
    const namesFirst = shown.some(t => t.includes(`"${ROBOT_NAME}"`) || t.includes(robotLabel));
    const namesSecond = shown.some(t => t.includes(ROBOT_NAME_2)) || (m && m.text.includes(ROBOT_NAME_2));
    const wrongRobot = logged.filter(l => l.data && l.data.robot && l.data.robot !== ROBOT_NAME);
    v[name] = !m ? `FAIL: no confirmation shown (${shown.join(' | ') || 'no notification'})`
      : !m.text.includes(robotLabel) ? `FAIL: the confirmation does not name ${ROBOT_NAME}: ${m.text}`
      : namesSecond ? `FAIL: a dialog names ${ROBOT_NAME_2}: ${[m.text, ...shown].join(' | ')}`
      : wrongRobot.length ? `FAIL: an error was shown for ${wrongRobot.map(l => l.data.robot).join(', ')}`
      : !namesFirst ? `FAIL: no notification names ${ROBOT_NAME}: ${shown.join(' | ') || 'none'}`
      : `PASS (confirmation "${m.text}"; ${logged.length ? `error names ${ROBOT_NAME}: ${logged.map(l => l.data.friendly).join(' | ')}` : `wrote back: ${shown.join(' | ')}`})`;
  }

  Object.assign(v, uatVerdicts(result, log));

  v['disconnect'] = texts('disconnect').includes('Disconnected.') ? 'PASS' : 'FAIL';
  return v;
}

/** What the extension's command trace says each `abbRobot.connectRobot` in a step was given. */
function connectedIds(step, log) {
  return log.filter(l => l.category === 'command' && l.msg === '→ abbRobot.connectRobot' && step.start && l.ts >= step.start && l.ts <= step.end)
    .map(l => (l.data && l.data.args && l.data.args[0]) || null);
}

/**
 * Verdicts of the read-only acceptance steps U1-U3 (test/host/stub-ext/acceptance.js). Each
 * is PASS, FAIL or SKIPPED with the reason; nothing here writes to a controller.
 */
function uatVerdicts(result, log) {
  const fs = require('node:fs');
  const v = {};
  const step = name => result.steps.find(s => s.name === name);
  const ui = name => result.ui.filter(u => u.step === name);
  const errorsOf = name => ui(name).filter(u => u.kind === 'error').map(u => u.text);
  const shortList = (xs, n = 3) => xs.slice(0, n).map(t => String(t).replace(/\s+/g, ' ').slice(0, 160)).join(' | ');

  // ── U1: language features and registered commands ──
  if (result.u1) {
    const bad = result.u1.checks.filter(c => !c.ok);
    v['U1 language'] = bad.length
      ? `FAIL: ${bad.map(c => `${c.id} (${c.detail})`).join('; ')}`
      : `PASS (${result.u1.checks.map(c => `${c.id}: ${c.detail}`).join('; ')})`;
  }

  // ── U2: the robot list ──
  const u2 = result.u2;
  if (u2) {
    const asked = ui('U2 addRobot');
    const row = (u2.scanList || []).find(i => new RegExp(`:${u2.port}$`).test(i.label));
    const added = asked.find(u => u.kind === 'info' && /^✓ Added "Acceptance \d+"/.test(u.text));
    v['U2 addRobot'] = errorsOf('U2 addRobot').length ? `FAIL: ${shortList(errorsOf('U2 addRobot'))}`
      : !row ? `FAIL: the VC on port ${u2.port} is not in the scan list (${(u2.scanList || []).length} rows)`
      : !added || !u2.added ? `FAIL: no "Added" notification or no new entry in the settings: ${shortList(asked.filter(u => u.kind === 'info').map(u => u.text))}`
      : u2.added.hasPassword ? 'FAIL: the saved entry carries a password in the settings'
      : `PASS (scan list ${(u2.scanList || []).length} rows; row "${row.label}" / ${row.description} / ${row.detail}; user pre-filled "${u2.userPrefill}", password ${u2.passwordPrefilled ? 'pre-filled' : 'empty'}; suggested name "${u2.suggestedName}"; added ${u2.added.username}@${u2.added.host}:${u2.added.port})`;

    const dc = ui('U2 discoverControllers');
    const none = dc.find(u => u.kind === 'info' && /No controllers announced themselves via mDNS/.test(u.text));
    const list = dc.find(u => u.kind === 'quickPick' && /Discovered controllers - \d+ found/.test(u.title || ''));
    v['U2 discoverControllers'] = errorsOf('U2 discoverControllers').length ? `FAIL: ${shortList(errorsOf('U2 discoverControllers'))}`
      : none ? `PASS (none found, the valid result: "${none.text.slice(0, 80)}…")`
      : list ? `PASS (${list.title}; items ${JSON.stringify((list.items || []).map(i => i.label))})`
      : `FAIL: neither a "none announced" message nor a list: ${shortList(dc.map(u => `${u.kind}: ${u.text || u.title}`))}`;

    const ms = ui('U2 manageSavedAddresses');
    v['U2 manageSavedAddresses'] = errorsOf('U2 manageSavedAddresses').length ? `FAIL: ${shortList(errorsOf('U2 manageSavedAddresses'))}`
      : ms.length ? `PASS (opened and cancelled: ${shortList(ms.map(u => `${u.kind}: ${u.title || u.text || u.placeHolder || ''}`))})`
      : 'FAIL: the command showed nothing';

    for (const [name, which] of [['U2 connect active (second)', 'second'], ['U2 connect active (first)', 'first']]) {
      const s = step(name);
      if (!s) { continue; }
      const ids = connectedIds(s, log);
      const want = (u2.ids || {})[which];
      v[name] = ids.length && ids.every(id => id === want) ? `PASS (Connect (active) connected the ${which} entry ${want})`
        : `FAIL: Connect (active) connected ${JSON.stringify(ids)}, want ${want}`;
    }
    const cfg = ui('U2 configure cancel').filter(u => u.kind === 'inputBox');
    v['U2 configure cancel'] = cfg.length === 1 && /Configure Robot \(1\/3\)/.test(cfg[0].title || '') && u2.configureUnchanged
      ? 'PASS (one box, "Configure Robot (1/3)", cancelled; the robot list in the settings is unchanged)'
      : `FAIL: ${cfg.length} input box(es) (${shortList(cfg.map(u => u.title))}); settings unchanged ${u2.configureUnchanged}`;
    if (step('U2 removeRobot')) {
      const m = ui('U2 removeRobot').find(u => u.kind === 'warning' && u.modal);
      v['U2 removeRobot'] = !m ? 'FAIL: no confirmation'
        : !u2.removed ? 'FAIL: the entry is still in the settings'
        : `PASS (confirmation "${m.text}" / ${String(m.detail || '').slice(0, 140)}; entry gone from the settings)`;
    } else {
      v['U2 removeRobot'] = `FAIL: not run (${u2.removeSkipped || 'no throwaway entry'})`;
    }
    v['U2 settings S1'] = Array.isArray(u2.passwordsInSettings) && u2.passwordsInSettings.length === 0
      ? `PASS (abbRobot.robots: ${(u2.after || []).length} entr${(u2.after || []).length === 1 ? 'y' : 'ies'}, none with a password; keys ${[...new Set((u2.after || []).flatMap(r => Object.keys(r)))].join(', ')})`
      : `FAIL: entries with a password in the settings: ${JSON.stringify(u2.passwordsInSettings)}`;
  }

  // ── U3: the reads ──
  const u3 = result.u3;
  if (u3) {
    for (const [name, e] of Object.entries(u3.expect || {})) {
      const rows = (e.rows || []).join(' ');
      const s = step(name);
      if (e.skipped) { v[name] = `SKIPPED (${rows}): ${e.skipped}`; continue; }
      if (!s) { v[name] = `FAIL (${rows}): not run`; continue; }
      const uis = ui(name);
      const errs = uis.filter(u => u.kind === 'error').map(u => u.text);
      const texts = uis.filter(u => ['info', 'warning'].includes(u.kind)).map(u => u.text);
      const docs = uis.filter(u => u.kind === 'document');
      const picks = uis.filter(u => u.kind === 'quickPick').map(u => `${u.title || ''} ${u.placeHolder || ''}`);
      const cmds = uis.filter(u => u.kind === 'command').map(u => u.id);
      // A refresh sends its read a moment after the command returns, so the window runs on a little.
      const settle = e.settle !== undefined ? e.settle : 2500;
      const reqs = requestsIn({ start: s.start, end: new Date(Date.parse(s.end) + settle).toISOString() }, log, new Set());
      if (s.ok === false) { v[name] = `FAIL (${rows}): the command threw: ${s.thrown}`; continue; }
      if (errs.length && e.expectedError && errs.every(t => new RegExp(e.expectedError).test(t))) {
        v[name] = `EXPECTED (${rows}): the controller answered the way it must here (${e.reason}): ${shortList(errs, 1)}`;
        continue;
      }
      if (errs.length) { v[name] = `FAIL (${rows}): ${shortList(errs, 2)}`; continue; }
      if (e.partial) { v[name] = `PARTIAL (${rows}): the command ran without an error; ${e.partial}`; continue; }
      const got = [];
      const test = (what, ok, shown) => got.push({ what, ok: !!ok, shown });
      if (e.dialog) { const m = texts.find(t => new RegExp(e.dialog).test(t)); test('dialog', m, m && m.slice(0, 120)); }
      if (e.document) { const d = docs.find(x => new RegExp(e.document).test(`${x.text || ''} ${x.file || ''}`)); test('document', d, d && `${d.languageId || ''} ${String(d.text || d.file || '').split('\n')[0].slice(0, 90)}`); }
      if (e.quickPick) { const p = picks.find(t => new RegExp(e.quickPick).test(t)); test('list', p, p && p.trim()); }
      if (e.file) { const ok = fs.existsSync(e.file) && fs.statSync(e.file).size > 0; test('file', ok, ok && `${require('node:path').basename(e.file)} ${fs.statSync(e.file).size} bytes`); }
      if (e.fileText) { const ok = fs.existsSync(e.file) && new RegExp(e.fileText).test(fs.readFileSync(e.file, 'utf8')); test('file text', ok, ok && `matches /${e.fileText}/`); }
      if (e.dir) { const n = fs.existsSync(e.dir) ? fs.readdirSync(e.dir).length : 0; test('files', fs.existsSync(e.dir), `${n} file(s) in the folder`); }
      if (e.request) { const q = reqs.find(x => new RegExp(e.request).test(`${x.method} ${x.path}`) && /^2/.test(String(x.status))); test('request', q, q && `${q.method} ${q.path} -> ${q.status}`); }
      if (e.command) { test('command', cmds.includes(e.command), e.command); }
      const ok = e.any ? got.some(g => g.ok) : got.every(g => g.ok);
      const seen = got.filter(g => g.ok).map(g => `${g.what}: ${g.shown}`).join('; ');
      v[name] = ok ? `PASS (${rows}; ${seen || 'no error'})`
        : `FAIL (${rows}): expected ${got.filter(g => !g.ok).map(g => g.what).join(' + ')}; saw ${shortList([...texts, ...docs.map(d => `document ${d.languageId || ''}`)], 3) || 'nothing'}`;
    }

    // Status and Live Cell data: the extension's own polling or subscription answered.
    const connect = step('connect');
    const idle = step('idle');
    if (connect && idle) {
      const window = log.filter(l => l.ts >= connect.start && l.ts <= idle.end);
      const reqs = window.filter(l => l.category === 'http.req');
      const posts = reqs.filter(l => l.data && l.data.method === 'POST' && /\/subscription/.test(l.data.path || ''));
      const ws = window.filter(l => /^ws|websocket|subscri/i.test(`${l.category} ${l.msg}`) && l.category !== 'http.req');
      const idleGets = log.filter(l => l.category === 'http.req' && l.ts >= idle.start && l.ts <= idle.end && l.data && l.data.method === 'GET'
        && !/\/subscription/.test(l.data.path || ''));
      const counts = {};
      for (const l of idleGets) { counts[l.data.path] = (counts[l.data.path] || 0) + 1; }
      const repeated = Object.entries(counts).filter(([, n]) => n >= 2).map(([p, n]) => `${p} x${n}`);
      const answered = log.filter(l => (l.category === 'http.res') && l.ts >= connect.start && l.ts <= idle.end && /^2/.test(String((l.data || {}).status)));
      const how = posts.length || ws.length ? `subscription (${posts.length} subscribe request(s), ${ws.length} websocket line(s))` : 'no subscription seen';
      v['U3 transport'] = `${how}; ${idleGets.length} GET(s) in the ${Math.round((Date.parse(idle.end) - Date.parse(idle.start)) / 1000)} s quiet window${repeated.length ? `, repeated: ${repeated.slice(0, 4).join(', ')}` : ', none repeated'}`
        + (posts.length || ws.length ? (repeated.length ? ' -> subscription plus polling' : ' -> updates by subscription') : (repeated.length ? ' -> updates by polling' : ' -> quiet'));
      v['U3 status polls'] = answered.length ? `PASS (${answered.length} request(s) answered 2xx between connect and the end of the quiet window)` : 'FAIL: no 2xx answer after connect';
    }
    const sel = u3.selections || {};
    v['U3 selections'] = `INFO (${sel.generation || '?'}; task ${sel.task}; program module ${sel.programModule || 'none'}; module read ${sel.moduleForSource || 'none'}; symbol ${sel.symbol ? `${sel.symbol.module}/${sel.symbol.name}` : 'none'}; DO prefix ${sel.signalPrefix || 'none'} of ${sel.signalCount}; device prefix ${sel.devicePrefix || 'none'}; file ${sel.file ? sel.file.path : 'none'}; CFG ${sel.cfgDomain || '-'}/${sel.cfgType || '-'}/${sel.cfgInstance || '-'}; backups ${sel.backups}${(u3.errors || []).length ? `; selection reads failed: ${u3.errors.join(' | ')}` : ''})`;
  }
  // ── U4: the write commands in AUTO ──
  const u4 = result.u4;
  if (u4) {
    if (u4.waiting) { v['U4 waiting'] = `WAITING: ${u4.waiting}`; }
    if (u4.abort) { v['U4 aborted'] = `FAIL: ${u4.abort}`; }
    for (const r of u4.rows || []) {
      const errs = errorsOf(r.name);
      const refusalRe = r.expectRefusal ? new RegExp(r.expectRefusal, 'i') : null;
      if (r.skipped) { v[r.name] = `SKIPPED (${r.row}): ${r.skipped}`; continue; }
      if (r.threw) { v[r.name] = `FAIL (${r.row}): the command threw: ${r.threw}`; continue; }
      if (errs.length) {
        v[r.name] = refusalRe && errs.every(t => refusalRe.test(t)) && r.ok
          ? `REFUSED (${r.row}): as expected (${r.why}); ${r.detail}; dialog: ${shortList(errs, 1)}`
          : `FAIL (${r.row}): ${shortList(errs, 2)}; ${r.detail}`;
        continue;
      }
      if (refusalRe && !r.ok) { v[r.name] = `FAIL (${r.row}): neither refused nor done: ${r.detail}`; continue; }
      const infos = ui(r.name).filter(u => ['info'].includes(u.kind)).map(u => u.text);
      v[r.name] = r.ok ? `PASS (${r.row}; ${r.detail}${infos.length ? `; ${shortList(infos, 1)}` : ''})` : `FAIL (${r.row}): ${r.detail}`;
    }
    if (u4.final && u4.original && (u4.final.ctrlstate !== undefined)) {
      const o = u4.original, f = u4.final;
      const diffs = [];
      for (const k of ['speedRatio', 'execCycle', 'ctrlstate', 'opmode', 'execstate']) { if (`${o[k]}` !== `${f[k]}`) { diffs.push(`${k} ${o[k]} -> ${f[k]}`); } }
      if (JSON.stringify(o.modules) !== JSON.stringify(f.modules)) { diffs.push(`modules ${o.modules} -> ${f.modules}`); }
      if (o.signal && f.signal && o.signal.lvalue !== f.signal.lvalue) { diffs.push(`${o.signal.name} ${o.signal.lvalue} -> ${f.signal.lvalue}`); }
      if (f.backups && f.backups.length) { diffs.push(`backups left: ${f.backups.join(',')}`); }
      v['U4 restored'] = diffs.length ? `FAIL: not back as found: ${diffs.join('; ')}` : `PASS (speed ${f.speedRatio}, cycle ${f.execCycle}, state ${f.ctrlstate}, execution ${f.execstate}, modules ${(f.modules || []).join(',')}, ${f.signal ? `${f.signal.name} ${f.signal.lvalue}, ` : ''}program pointer ${f.programPointer}; no ZZ_ACC backup left; cleanup: ${(u4.cleanup || []).join('; ') || 'nothing to undo'})`;
    }
  }

  const after = result.u3after;
  if (after) {
    const ok200 = after.systemStatus === 200;
    let session;
    if (after.error) { session = `could not check: ${after.error}`; }
    else if (after.generation === 'rw8') {
      const w = after.writeAccess || {};
      session = w.held === true && w.heldByName === 'abb-rws-client' ? `FAIL: write access is still held by "${w.heldByName}"`
        : `ok: write access held ${w.held}${w.heldByName ? ` by "${w.heldByName}"` : ''}`;
    } else {
      const m = after.mastership || {};
      session = m.mastership && m.mastership !== 'nomaster' ? `FAIL: RAPID mastership is "${m.mastership}"${m.application ? ` (${m.application})` : ''}` : `ok: RAPID mastership ${m.mastership || 'not reported'}`;
    }
    v['U3 after disconnect'] = !ok200 ? `FAIL: GET /rw/system answered ${after.systemStatus} with fresh credentials`
      : /^FAIL|could not/.test(session) ? (/^FAIL/.test(session) ? session : `FAIL: ${session}`)
      : `PASS (GET /rw/system -> 200 with fresh credentials; ${session})`;
  }
  return v;
}

/**
 * A row for each step that did not run, saying why, in its place in the report table:
 * before its letter's rows, or after the last E1 row for E2 (E1 has a row per name typed).
 * Changes `rows` and returns it.
 */
function placeGuardRows(rows, v) {
  for (const guard of ['A guard', 'E2 guard', 'F guard', 'I guard']) {
    if (!v[guard]) { continue; }
    const row = { step: guard, command: '(none)', dialogs: [], requests: [], verdict: v[guard] };
    const lastE1 = rows.reduce((at, r, i) => (r.step.startsWith('E1 ') ? i : at), -1);
    const at = guard === 'E2 guard' && lastE1 >= 0 ? lastE1 + 1 : rows.findIndex(r => r.step.startsWith(guard[0]) && r.step !== 'disconnect');
    rows.splice(at < 0 ? rows.length - 1 : at, 0, row);
  }
  return rows;
}

function report(target, result, log, rows) {
  const md = [];
  md.push(`# RAPID Live host test, ${result.started}`, '');
  md.push(`Controller ${target.url}; extension ${result.extension ? result.extension.version : '?'}; operation mode at start ${result.mode ?? 'not read'}${result.only ? `; steps ${result.only}` : ''}.`, '');
  md.push(`Before the run: ${result.before}.`, '');
  for (const p of result.probes || []) { md.push(`After step ${p.after}: GET /rw/system -> ${p.status}; lock-state ${p.lockstate} (${p.ts}).`, ''); }
  md.push(`After the run: ${result.after}.`, '');
  if (result.stepA) { md.push(`Step A: ${JSON.stringify(result.stepA)}; lock-state reads ${JSON.stringify(result.lockStates || [])}.`, ''); }
  if (result.u2) {
    md.push('### Add Robot scan list (U2)', '');
    md.push(`Picker title: ${result.u2.pickerTitle || '-'}; user pre-filled: ${result.u2.userPrefill || '-'}; password pre-filled: ${result.u2.passwordPrefilled ? 'yes' : 'no'}.`, '');
    md.push('| Row | Description | Detail |', '|---|---|---|');
    for (const r of result.u2.scanList || []) { md.push(`| ${r.label} | ${r.description || ''} | ${r.detail || ''} |`); }
    md.push('');
  }
  if (result.u3) {
    md.push('### Selections (U3)', '', '```', JSON.stringify(result.u3.selections, null, 2), '```', '');
    if ((result.u3.errors || []).length) { md.push('Selection reads that failed: ' + result.u3.errors.join(' | '), ''); }
  }
  if (result.u4) {
    md.push('### Step 4 setup and clean-up (U4)', '', '```', JSON.stringify({
      generation: result.u4.generation, guardStop: result.u4.guard, writeAccess: result.u4.writeAccess, setup: result.u4.setup,
      original: result.u4.original, final: result.u4.final, notes: result.u4.notes, cleanup: result.u4.cleanup,
      waiting: result.u4.waiting, abort: result.u4.abort,
    }, null, 2), '```', '');
  }
  if (result.u3after) { md.push('### After Disconnect (U3)', '', '```', JSON.stringify(result.u3after, null, 2), '```', ''); }
  if (result.fatal) { md.push('**Stopped early:**', '', '```', result.fatal, '```', ''); }
  md.push('| Step | Command | Dialogs | Requests sent | Status | Verdict |', '|---|---|---|---|---|---|');
  for (const r of rows) {
    // A request body with line breaks (a module's text) must not break the table.
    const flat = t => String(t).replace(/\r?\n/g, ' ⏎ ').replace(/\|/g, '\\|');
    const reqs = r.requests.map(q => `${q.method} ${q.path}${q.body ? ` \`${flat(q.body)}\`` : ''}`).join('<br>') || '(none)';
    const dialogs = (r.dialogs || []).join('<br>') || '(none)';
    md.push(`| ${r.step} | ${r.command} | ${dialogs} | ${reqs} | ${r.requests.map(q => q.status).join(', ') || '-'} | ${r.verdict} |`);
  }
  md.push('', '## Read-backs (client)', '');
  for (const b of result.readbacks) { md.push(`- ${b.ts} ${b.label}: ${JSON.stringify(b.value ?? { error: b.error })}`); }
  md.push('', '## Clean-up', '', ...result.cleanup.map(c => `- ${c}`));
  md.push('', '## Notifications and dialogs', '');
  for (const u of result.ui) {
    const what = u.text ?? u.title ?? u.prompt ?? u.placeHolder ?? '';
    const extra = u.buttons && u.buttons.length ? ` [${u.buttons.join(' / ')}]` : u.items ? ` items=${JSON.stringify(u.items)}` : u.value !== undefined ? ` -> ${JSON.stringify(u.value)}` : '';
    md.push(`- ${u.ts} [${u.step}] ${u.kind}${u.to ? `(${u.to})` : ''}: ${String(what).replace(/\n/g, ' ')}${extra}${u.refusedBy ? ` (refused: ${u.refusedBy})` : ''}`);
  }
  md.push('', `## Extension log (${log.length} lines)`, '', '```');
  for (const l of log) { md.push(JSON.stringify(l)); }
  md.push('```', '');
  return md.join('\n');
}

module.exports = { ROBOT_ID, ROBOT_NAME, ROBOT_ID_2, ROBOT_NAME_2, dialogsIn, requestsIn, allRequestsIn, modeRefusalIn, verdicts, placeGuardRows, report };
