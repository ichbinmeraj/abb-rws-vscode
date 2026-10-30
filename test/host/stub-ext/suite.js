// Runs inside the VS Code extension host (loaded through --extensionTestsPath).
// Drives the installed RAPID Live extension's commands against one controller,
// with the extension's own window.show* calls answered by a script, and reads
// the controller back through the client package between steps.
//
// Inputs come from the environment (set by ../run-commands.test.js):
//   HOSTTEST_OUT       where to write the JSON result
//   HOSTTEST_BASE_URL  e.g. https://127.0.0.1:80
//   HOSTTEST_USER / HOSTTEST_PASS
//   HOSTTEST_PIN       the test PIN step A locks with, default 4711
//   HOSTTEST_CLIENT    file URL of the client package's dist/index.js
//   HOSTTEST_ROBOT_ID  the id of the first robot entry written to settings
//   HOSTTEST_ROBOT_ID_2  the id of the second entry for the same controller (step I)
//   HOSTTEST_ROBOT_NAME / HOSTTEST_ROBOT_NAME_2  their names as saved
//   HOSTTEST_ONLY      optional: run only these steps, letters A-I (e.g. "E")
//   HOSTTEST_ALLOW_START  "1" lets step E2 start RAPID. E2 sets itself up and tears
//                      itself down: it loads test/host/ZZ_PROBE.mod, points the program
//                      pointer at ZZ_PROBE_LOOP and switches the motors on (RobotWare 6/7;
//                      on RobotWare 8 that is a pendant action, so it asks and waits for
//                      HOSTTEST_MOTORS_WAIT_S seconds, default 180, then skips E2). After
//                      E2/E3 it always stops RAPID, switches the motors off, unloads the
//                      module and deletes the file, and reads the start state back.
//   HOSTTEST_DO        the digital output step F toggles, default ZZ_PROBE_DO1 (the
//                      VCs' probe output is ZZ_PROBE_DO1; ZZ_PROBE_DO does not exist)
//   HOSTTEST_CFG_DOMAIN  the CFG domain step I edits an instance of, default SYS
//   HOSTTEST_CFG_TYPE  its type; default the first type of the domain that lists an instance

'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const EXT_ID = 'merajsafari.abb-rws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { getSystem, getResource, getLockState, spanText } = require('./probe.js');
const acceptance = require('./acceptance.js');
const u4 = require('./u4.js');
const w1 = require('./w1.js');
const l1 = require('./l1.js');

// Test constants for step A: the PIN the lock sets, and a wrong one tried first.
const PIN = process.env.HOSTTEST_PIN || '4711';
const WRONG_PIN = PIN === '9999' ? '9998' : '9999';

exports.run = async function run() {
  const result = { started: new Date().toISOString(), steps: [], ui: [], readbacks: [], cleanup: [] };
  try {
    await main(result);
  } catch (e) {
    result.fatal = e && e.stack ? e.stack : String(e);
  }
  result.finished = new Date().toISOString();
  fs.writeFileSync(process.env.HOSTTEST_OUT, JSON.stringify(result, null, 2));
};

async function main(result) {
  const env = process.env;
  const robotId = env.HOSTTEST_ROBOT_ID;
  const robotId2 = env.HOSTTEST_ROBOT_ID_2;
  const robotName = env.HOSTTEST_ROBOT_NAME || 'Host test';
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) { throw new Error(`${EXT_ID} is not installed in this host`); }
  result.extension = { version: ext.packageJSON.version, path: ext.extensionPath };
  result.robots = { first: { id: robotId, name: robotName }, second: { id: robotId2, name: env.HOSTTEST_ROBOT_NAME_2 || 'Host test 2' } };

  // The extension host hands every extension its own `vscode` object, keyed on
  // the requiring file's path. Requiring 'vscode' from a file inside the
  // installed extension returns the object the extension itself uses, so the
  // stubs below are the ones its commands call.
  const extVscode = createRequire(path.join(ext.extensionPath, 'dist', 'extension.js'))('vscode');
  const win = extVscode.window;

  let step = 'activate';
  // The responder for the running step: (kind, payload, step) => answer.
  // kind is info | warning | error (payload {text, buttons, modal, detail}),
  // inputBox (payload = the options: title, prompt, placeHolder, value) or
  // quickPick (payload {items, opts}).
  let respond = () => undefined;
  const record = (kind, payload) => {
    result.ui.push({ ts: new Date().toISOString(), step, kind, ...payload });
  };
  const msgStub = kind => (text, ...rest) => {
    const buttons = rest
      .filter(x => typeof x === 'string' || (x && typeof x === 'object' && 'title' in x))
      .map(x => (typeof x === 'string' ? x : x.title));
    const opts = rest.find(x => x && typeof x === 'object' && !('title' in x));
    const payload = { text, buttons, modal: !!(opts && opts.modal), detail: opts && opts.detail };
    record(kind, payload);
    const answer = respond(kind, payload, step);
    if (answer !== undefined) { record('answer', { to: kind, value: answer }); }
    return Promise.resolve(answer);
  };
  win.showInformationMessage = msgStub('info');
  win.showWarningMessage = msgStub('warning');
  win.showErrorMessage = msgStub('error');
  win.showInputBox = async (opts = {}) => {
    // A password box is recorded without its text, the pre-filled value and the answer alike.
    const shown = v => (opts.password && v !== undefined && v !== '' ? '***' : v);
    record('inputBox', { title: opts.title, prompt: opts.prompt, placeHolder: opts.placeHolder, value: shown(opts.value) });
    let answer = respond('inputBox', opts, step);
    if (answer !== undefined && typeof opts.validateInput === 'function') {
      const problem = await opts.validateInput(answer);
      if (problem) { record('answer', { to: 'inputBox', value: shown(answer), refusedBy: problem }); return undefined; }
    }
    if (answer !== undefined) { record('answer', { to: 'inputBox', value: shown(answer) }); }
    return answer;
  };
  win.showQuickPick = async (items, opts = {}) => {
    const list = await items;
    record('quickPick', {
      title: opts.title, placeHolder: opts.placeHolder,
      items: list.map(i => (typeof i === 'string' ? i : { label: i.label, description: i.description })),
    });
    const answer = respond('quickPick', { items: list, opts }, step);
    if (answer !== undefined) { record('answer', { to: 'quickPick', value: typeof answer === 'string' ? answer : answer.label }); }
    return answer;
  };
  const realProgress = win.withProgress.bind(win);
  win.withProgress = (opts, task) => {
    record('progress', { title: opts.title });
    return realProgress(opts, task);
  };
  win.setStatusBarMessage = text => { record('statusBar', { text }); return { dispose() {} }; };

  // The Add Robot picker is a QuickPick created with createQuickPick: a
  // scripted one that shows its title and rows to the responder, which answers
  // with the row to accept (or nothing, which hides it).
  win.createQuickPick = () => {
    const on = { accept: [], hide: [], trigger: [] };
    const handle = list => f => { list.push(f); return { dispose() {} }; };
    const qp = {
      items: [], title: undefined, placeholder: undefined, value: '', busy: false, enabled: true,
      canSelectMany: false, matchOnDescription: false, matchOnDetail: false, keepScrollPosition: false,
      selectedItems: [], activeItems: [], buttons: [],
      onDidAccept: handle(on.accept),
      onDidHide: handle(on.hide),
      onDidTriggerItemButton: handle(on.trigger),
      onDidChangeSelection: () => ({ dispose() {} }),
      onDidChangeActive: () => ({ dispose() {} }),
      onDidChangeValue: () => ({ dispose() {} }),
      onDidTriggerButton: () => ({ dispose() {} }),
      show() {
        record('quickPickView', {
          title: qp.title, placeHolder: qp.placeholder,
          items: qp.items.filter(i => i.label).map(i => ({ label: i.label, description: i.description, detail: i.detail, separator: i.kind === -1 })),
        });
        setTimeout(() => {
          const answer = respond('createQuickPick', { title: qp.title, placeHolder: qp.placeholder, items: qp.items }, step);
          if (answer) {
            record('answer', { to: 'createQuickPick', value: answer.label });
            qp.selectedItems = [answer];
            for (const f of on.accept) { f(); }
          } else {
            for (const f of on.hide) { f(); }
          }
        }, 50);
      },
      hide() { for (const f of on.hide) { f(); } },
      dispose() {},
    };
    return qp;
  };
  // File dialogs: the responder answers with a path (or nothing to cancel).
  win.showSaveDialog = async (opts = {}) => {
    record('saveDialog', { defaultFile: opts.defaultUri && opts.defaultUri.fsPath });
    const answer = respond('saveDialog', opts, step);
    if (!answer) { return undefined; }
    record('answer', { to: 'saveDialog', value: answer });
    return extVscode.Uri.file(answer);
  };
  win.showOpenDialog = async (opts = {}) => {
    record('openDialog', { openLabel: opts.openLabel });
    const answer = respond('openDialog', opts, step);
    if (!answer) { return undefined; }
    record('answer', { to: 'openDialog', value: answer });
    return [extVscode.Uri.file(answer)];
  };
  // Documents the extension shows: what a person would see in the editor.
  const realShowTextDocument = win.showTextDocument.bind(win);
  win.showTextDocument = (a, ...rest) => {
    try {
      if (a && typeof a.getText === 'function') {
        record('document', { languageId: a.languageId, file: a.fileName, scheme: a.uri && a.uri.scheme, lines: a.lineCount, text: a.getText().slice(0, 600) });
      } else if (a && (a.fsPath || a.uri)) {
        record('document', { file: a.fsPath || (a.uri && a.uri.fsPath), scheme: a.scheme || (a.uri && a.uri.scheme) });
      }
    } catch { /* recording must never break the command */ }
    return realShowTextDocument(a, ...rest);
  };
  // Commands the extension runs on VS Code (vscode.diff, revealFileInOS) are recorded;
  // the harness itself runs commands through `exec`, which does not record.
  const realExec = extVscode.commands.executeCommand.bind(extVscode.commands);
  try {
    extVscode.commands.executeCommand = (id, ...args) => {
      if (/^vscode\./.test(String(id)) || id === 'revealFileInOS') {
        record('command', { id, args: args.map(a => (a && a.fsPath) || (a && a.toString && typeof a === 'object' ? String(a).slice(0, 120) : a)) });
      }
      return realExec(id, ...args);
    };
  } catch (e) { result.warnings = [...(result.warnings || []), `could not wrap executeCommand: ${e.message}`]; }
  const exec = async (id, ...args) => (id === '__getCommands' ? extVscode.commands.getCommands(true) : realExec(id, ...args));

  await ext.activate();

  // Read-back client: its own session, its own requests, never in parallel
  // with a command (each call below runs between commands).
  const { RwsClient2 } = await import(env.HOSTTEST_CLIENT);
  const rc = new RwsClient2(env.HOSTTEST_BASE_URL, env.HOSTTEST_USER, env.HOSTTEST_PASS, { rejectUnauthorized: false });
  const readback = async (label, fn) => {
    try {
      const value = await fn();
      result.readbacks.push({ ts: new Date().toISOString(), step, label, value });
      return value;
    } catch (e) {
      result.readbacks.push({ ts: new Date().toISOString(), step, label, error: e && e.message ? e.message : String(e) });
      return undefined;
    }
  };

  const run = async (name, command, responder, args = []) => {
    step = name;
    respond = responder || (() => undefined);
    const s = { name, command, start: new Date().toISOString() };
    result.steps.push(s);
    try {
      await extVscode.commands.executeCommand(command, ...args);
      s.ok = true;
    } catch (e) {
      s.ok = false;
      s.thrown = e && e.message ? e.message : String(e);
    }
    await sleep(300);
    s.end = new Date().toISOString();
    respond = () => undefined;
    return s;
  };
  const uiOf = name => result.ui.filter(u => u.step === name);
  // One GET /rw/system after a step: does the controller still answer?
  result.probes = [];
  const probe = async letter => {
    const status = await getSystem(env.HOSTTEST_BASE_URL, env.HOSTTEST_USER, env.HOSTTEST_PASS);
    // RWS 2.0 also reports the selector's lock state (RW 6.16 has no such resource).
    const lock = await getLockState(env.HOSTTEST_BASE_URL, env.HOSTTEST_USER, env.HOSTTEST_PASS);
    result.probes.push({ ts: new Date().toISOString(), after: letter, status, lockstate: lock.lockstate || `HTTP ${lock.status}` });
    return status;
  };

  // The confirmation dialogs (src/confirm.ts): a modal warning with one
  // "Continue on <name>" / "Write to <name>" button (disruptive and change
  // tiers), or a "Continue" button followed by an input box for the robot's
  // name (motion tier). These answer them for the first robot.
  const confirmButton = p => (p.buttons || []).find(b => b === `Continue on ${robotName}` || b === `Write to ${robotName}` || b === 'Continue');
  const accept = (kind, p) => (kind === 'warning' && p.modal ? confirmButton(p) : undefined);
  const acceptTyped = typed => (kind, p) => (kind === 'warning' && p.modal ? confirmButton(p)
    : kind === 'inputBox' && /^Type the robot's name/.test(p.prompt || '') ? typed : undefined);
  const cancelConfirm = () => undefined;

  // Which steps: A-I write to the controller (the default); U1-U3 only read and never mix with them.
  // W1 (the stub controller run) is read-only too: every write is refused before it is sent.
  const tokens = (env.HOSTTEST_ONLY || '').toUpperCase().match(/U[1-4]|W1|L1|[A-I]/g) || [];
  const uOnly = tokens.length > 0 && tokens.every(t => t[0] === 'U' || t === 'W1' || t === 'L1');
  if (tokens.some(t => t[0] === 'U' || t === 'W1' || t === 'L1') && !uOnly) { throw new Error('the read-only U steps never run together with the write steps A-I'); }
  if (tokens.includes('U4') && tokens.length > 1) { throw new Error('U4 writes to the controller and runs alone'); }
  if (tokens.includes('L1') && tokens.length > 1) { throw new Error('L1 writes to the controller and runs alone'); }
  result.only = tokens.join('') || undefined;
  const wanted = t => (tokens.length ? tokens.includes(t) : /^[A-I]$/.test(t));

  // The read-only steps (test/host/stub-ext/acceptance.js) work through this.
  const readerFor = async () => {
    const { MultiRobotManager } = await import(env.HOSTTEST_CLIENT);
    const u = new URL(env.HOSTTEST_BASE_URL);
    const config = {
      id: 'acceptance-reader', name: 'acceptance-reader', host: u.hostname, port: Number(u.port),
      useHttps: u.protocol === 'https:', username: env.HOSTTEST_USER, password: env.HOSTTEST_PASS,
    };
    const multi = MultiRobotManager.fromConfigs([config], { refreshIntervalMs: 60000, strictTls: false });
    await multi.connectRobot(config.id);
    return {
      manager: multi.entries[0].manager,
      close: async () => { try { await multi.disconnectRobot(config.id); } catch { /* closed with the host anyway */ } },
    };
  };
  const uctx = {
    vscode: extVscode, env, result, run, exec, ext, sleep, readerFor, getSystem,
    setStep: name => { step = name; },
    // Runs `fn` as a step of its own with the dialogs answered by `responder` (for what a command does later, e.g. a save).
    withResponder: async (name, responder, fn) => {
      step = name; respond = responder;
      const s = { name, command: '(save the document)', start: new Date().toISOString() };
      result.steps.push(s);
      try { await fn(); s.ok = true; } catch (e) { s.ok = false; s.thrown = e && e.message ? e.message : String(e); }
      await sleep(300);
      s.end = new Date().toISOString();
      respond = () => undefined;
      return s;
    },
  };

  // W1 connects to the stub controller itself (it answers the mode question at the connect).
  if (uOnly && tokens.length === 1 && tokens[0] === 'W1') { await w1.stepW1(uctx); return; }
  // L1 (the 1.5.0 live checks) sets Watch only first and connects itself: the connect is its first check.
  if (uOnly && tokens.length === 1 && tokens[0] === 'L1') { await l1.stepL1(uctx); return; }
  // U1 needs no controller at all: no connect.
  if (uOnly && tokens.length === 1 && tokens[0] === 'U1') { await acceptance.stepU1(uctx); return; }
  // U2 adds and removes entries and connects the active one itself.
  if (uOnly && tokens.length === 1 && tokens[0] === 'U2') { await acceptance.stepU2(uctx); return; }

  // ── connect ──
  await run('connect', 'abbRobot.connectRobot', null, [robotId]);
  // A quiet window: the GETs the extension sends here are its status polling,
  // which the report leaves out of each command's request list. The U runs
  // watch it longer, to tell a subscription from polling.
  step = 'idle';
  const idle = { name: 'idle', command: '(polling baseline)', start: new Date().toISOString() };
  result.steps.push(idle);
  await sleep(uOnly ? 9000 : 5000);
  idle.end = new Date().toISOString();
  const connectFailed = uiOf('connect').some(u => u.kind === 'error');
  if (connectFailed) { result.fatal = 'connect failed; see notifications'; return; }

  if (!uOnly) {
    // Pre-step: the operating mode, read and reported, never changed here.
    step = 'mode';
    result.mode = await readback('operation mode at start', () => rc.getOperationMode());
  }

  if (wanted('A')) { await stepA(); await probe('A'); }
  if (wanted('B')) { await stepB(); await probe('B'); }
  if (wanted('C')) { await stepC(); await probe('C'); }
  if (wanted('D')) { await stepD(); await probe('D'); }
  if (wanted('E')) { await stepE(); await probe('E'); }
  if (wanted('F')) { await stepF(); await probe('F'); }
  if (wanted('G')) { await stepG(); await probe('G'); }
  if (wanted('I')) { await stepI(); await probe('I'); }
  if (wanted('U3')) { await acceptance.stepU3(uctx); }
  if (wanted('U4')) { await u4.stepU4(uctx); }

  // ── disconnect ──
  await run('disconnect', 'abbRobot.disconnectRobot', null, [robotId]);
  if (wanted('U3')) { await acceptance.stepU3After(uctx); }
  step = 'end';
  try { await rc.disconnect(); } catch { /* the session ends with the host anyway */ }

  async function stepA() {
  // ── (A) lock, then unlock, the operation mode selector ──
  // RWS 2.0: the lock sets the PIN (POST /rw/panel/opmode/lock pin=<p>&permanent=1)
  // and the unlock must present it, so no human PIN is needed. A PIN the lock was not set with is
  // tried once first. Runs on a virtual controller only, and only when the
  // selector starts unlocked; whatever lock it sets it takes off again. Both
  // commands ask first (disruptive tier): the "Continue on <name>" button is pressed.
  const lockState = async label => {
    const r = await getLockState(env.HOSTTEST_BASE_URL, env.HOSTTEST_USER, env.HOSTTEST_PASS);
    const value = r.lockstate || `HTTP ${r.status}${r.body ? `: ${r.body}` : ''}`;
    result.readbacks.push({ ts: new Date().toISOString(), step, label, value });
    (result.lockStates = result.lockStates || []).push({ label, value });
    return r.lockstate;
  };
  step = 'A guard';
  const id = await getResource(env.HOSTTEST_BASE_URL, env.HOSTTEST_USER, env.HOSTTEST_PASS, '/ctrl/identity');
  const ctrlType = spanText(id.body, 'ctrl-type');
  const ctrlName = spanText(id.body, 'ctrl-name');
  result.readbacks.push({ ts: new Date().toISOString(), step, label: 'controller identity', value: { status: id.status, name: ctrlName, type: ctrlType } });
  if (!/virtual/i.test(ctrlType || '')) {
    result.stepA = { refused: `not a virtual controller (GET /ctrl/identity ${id.status}, type ${ctrlType || 'not read'}); nothing sent` };
    return;
  }
  const start = await lockState('lock state before');
  if (start !== 'unlocked') {
    result.stepA = { refused: `the selector is not unlocked at the start (${start || 'not read'}); its PIN is unknown, nothing sent` };
    return;
  }
  const pin = PIN, wrong = WRONG_PIN;
  result.stepA = { pin, wrong };
  // The PIN prompt gets the test PIN; the lock-type pick gets Permanent; the confirmation its button.
  await run('A1 lockOpMode', 'abbRobot.lockOpMode', (kind, p) =>
    (kind === 'inputBox' ? pin : kind === 'quickPick' ? p.items.find(i => i.label === 'Permanent') : accept(kind, p)));
  const locked = await lockState('lock state after lock');
  await run('A2 unlockOpMode refused PIN', 'abbRobot.unlockOpMode', (kind, p) => (kind === 'inputBox' ? wrong : accept(kind, p)));
  const afterWrong = await lockState('lock state after the refused PIN');
  if (locked === 'unlocked' && afterWrong === 'unlocked') {
    result.stepA.note = 'the lock did not take; the right-PIN unlock is sent anyway';
  }
  await run('A3 unlockOpMode', 'abbRobot.unlockOpMode', (kind, p) => (kind === 'inputBox' ? pin : accept(kind, p)));
  let end = await lockState('lock state after unlock');
  if (end !== 'unlocked') {
    await run('A4 unlockOpMode retry', 'abbRobot.unlockOpMode', (kind, p) => (kind === 'inputBox' ? pin : accept(kind, p)));
    end = await lockState('lock state after the retry');
    result.cleanup.push(end === 'unlocked' ? 'the unlock was retried once; the selector is unlocked'
      : `the unlock was retried once; the selector is still ${end || 'not read'} (PIN ${pin})`);
  }
  result.stepA.final = end;
  }

  async function stepB() {
  // ── (B) virtual time: the notification shows time, speed and state and
  // offers the speed actions only (the client has no pause or resume). ──
  step = 'B vt baseline';
  const vt0 = await readback('virtual time before', () => rc.getVirtualTime());
  const vtAction = button => (kind, p) => {
    // The speed change now asks first (disruptive, naming the robot): press its button.
    if (kind === 'warning' && p.modal) { return confirmButton(p); }
    if (kind !== 'info' || !/^Virtual time:/.test(p.text)) { return undefined; }
    result.vtButtons = p.buttons;
    return p.buttons.includes(button) ? button : undefined;
  };
  await run('B1 virtualTime 10x', 'abbRobot.showVirtualTime', vtAction('Set scale 10x'));
  await readback('virtual time after 10x', () => rc.getVirtualTime());
  await run('B2 virtualTime 1x', 'abbRobot.showVirtualTime', vtAction('Set scale 1x'));
  const vt4 = await readback('virtual time after 1x', () => rc.getVirtualTime());
  // Restore speed 1. The state is only reported: there is no pause or resume over RWS; use RobotStudio's Simulation tab.
  step = 'B restore';
  if (vt4 && vt4.state !== 'VTFREERUN') {
    result.cleanup.push(`virtual time state is ${vt4.state} after the step; left alone (RobotStudio's Simulation tab controls it)`);
  }
  if (!vt4 || vt4.speed !== 1) {
    try { await rc.setVirtualTimeScale(1); result.cleanup.push('virtual time speed set back to 1'); }
    catch (e) { result.cleanup.push(`could not set speed 1: ${e.message}`); }
  }
  await readback('virtual time final', () => rc.getVirtualTime());
  result.vtBefore = vt0;
  }

  async function stepC() {
  // ── (C) backup ──
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const backupName = `ZZ_HOSTTEST_${stamp}`;
  result.backupName = backupName;
  await run('C1 createBackup', 'abbRobot.createBackup', (kind, opts) =>
    (kind === 'inputBox' && /backup name/i.test(opts.prompt || '') ? backupName : undefined));
  await run('C2 listBackups', 'abbRobot.listBackups', null);
  await readback('backups listed by the client', async () => (await rc.listBackups()).map(b => b.name));
  // Clean-up through the client's file service: DELETE /fileservice/BACKUP/<name>.
  // If the controller refuses a directory that still has content, empty it
  // depth first (one request at a time) and delete it again.
  step = 'C cleanup';
  const dir = `BACKUP/${backupName}`;
  const listed = (await rc.listBackups()).map(b => b.name);
  if (!listed.includes(backupName)) {
    result.cleanup.push(`backup ${backupName} not listed by the client; nothing deleted`);
  } else {
    let sent = 0;
    const emptyDir = async p => {
      for (const e of await rc.listDirectory(p)) {
        const child = `${p}/${e.name}`;
        if (e.type === 'dir') { await emptyDir(child); }
        await rc.deleteFile(child); sent++;
      }
    };
    try {
      await rc.deleteFile(dir); sent++;
      result.cleanup.push(`backup ${backupName} deleted with deleteFile(${dir}) in one request`);
    } catch (first) {
      try {
        await emptyDir(dir);
        await rc.deleteFile(dir); sent++;
        result.cleanup.push(`backup ${backupName}: deleteFile(${dir}) refused (${first.message}); emptied and deleted, ${sent} DELETE requests`);
      } catch (e) {
        result.cleanup.push(`backup ${backupName} could not be deleted: ${e.message}`);
      }
    }
  }
  const after = await readback('backups listed after delete', async () => (await rc.listBackups()).map(b => b.name));
  result.backupGone = Array.isArray(after) && !after.includes(backupName);
  }

  async function stepD() {
  // ── (D) service routine ──
  step = 'D baseline';
  const task = env.HOSTTEST_TASK || 'T_ROB1';
  await readback('operation mode', () => rc.getOperationMode());
  const pp0 = await readback('program pointer before', () => rc.getProgramPointer(task));
  // The routine named by HOSTTEST_ROUTINE (default SkipTaskExec); if it is not
  // listed the pick is cancelled. The "program is running, stop it?" offer is declined.
  const want = env.HOSTTEST_ROUTINE || 'SkipTaskExec';
  result.routineWanted = want;
  await run('D callServiceRoutine', 'abbRobot.callServiceRoutine', (kind, p) =>
    (kind === 'quickPick' ? p.items.find(i => (typeof i === 'string' ? i : i.label) === want) : undefined));
  const pp1 = await readback('program pointer after', () => rc.getProgramPointer(task));
  // Put the program pointer back where it was (same routine and row), if it moved.
  step = 'D restore';
  if (pp0 && pp0.routine && pp1 && (pp1.routine !== pp0.routine || pp1.module !== pp0.module)) {
    try {
      await rc.setProgramPointer(task, { module: pp0.module, routine: pp0.routine, ...(pp0.row ? { row: pp0.row, col: pp0.col || 1 } : {}) });
      result.cleanup.push(`program pointer set back to ${pp0.module}/${pp0.routine}${pp0.row ? ` row ${pp0.row}` : ''}`);
    } catch (e) {
      result.cleanup.push(`could not set the program pointer back to ${pp0.module}/${pp0.routine}: ${e.message}`);
    }
    await readback('program pointer restored', () => rc.getProgramPointer(task));
  } else if (pp1 && pp0 && !pp0.routine) {
    result.cleanup.push('program pointer had no routine before the step; not restored');
  }
  }

  async function stepE() {
  // ── (E) Start RAPID behind the typed-name confirmation ──
  // E1: the dialog names the robot; a wrong name is typed, then nothing (Enter on an
  // empty name box answers ''); neither sends a start.
  const wrongName = `${robotName.slice(0, -1)}${robotName.slice(-1) === 't' ? 's' : 't'}`;
  result.stepE = { wrongName };
  await run('E1 startRapid wrong name', 'abbRobot.startRapid', acceptTyped(wrongName));
  await readback('execution state after E1', () => rc.getRapidExecutionState());
  await run('E1 startRapid empty name', 'abbRobot.startRapid', acceptTyped(''));
  await readback('execution state after the empty name', () => rc.getRapidExecutionState());
  // E2: the right name, opt-in; then Stop RAPID, which never asks. The harness
  // sets E2 up itself (ZZ_PROBE loaded, pointer in its loop, motors on) and
  // always tears that down again, reading the start state back.
  step = 'E2 guard';
  const task = env.HOSTTEST_TASK || 'T_ROB1';
  if (env.HOSTTEST_ALLOW_START !== '1') {
    await readback('program pointer before E2', () => rc.getProgramPointer(task));
    result.stepE.e2 = 'skipped: HOSTTEST_ALLOW_START is not 1';
    return;
  }
  const MOD = 'ZZ_PROBE';
  const FILE = '$HOME/ZZ_PROBE.mod';
  const start = {};
  const did = { uploaded: false, loaded: false };
  const snapshot = async label => {
    const snap = {};
    snap.ctrlstate = await readback(`${label}: controller state`, () => rc.getControllerState());
    snap.opmode = await readback(`${label}: operation mode`, () => rc.getOperationMode());
    snap.execution = await readback(`${label}: execution state`, () => rc.getRapidExecutionState());
    snap.modules = await readback(`${label}: modules`, async () => (await rc.listModules(task)).map(m => m.name || m));
    return snap;
  };
  const sys = await getResource(env.HOSTTEST_BASE_URL, env.HOSTTEST_USER, env.HOSTTEST_PASS, '/rw/system');
  const rwVersion = spanText(sys.body, 'rwversion') || '';
  const rw8 = /^8\./.test(rwVersion);
  result.stepE.rwVersion = rwVersion;
  try {
    step = 'E2 setup';
    Object.assign(start, await snapshot('E2 start state'));
    result.stepE.e2Start = start;
    if (start.modules && start.modules.includes(MOD)) {
      result.stepE.e2 = `skipped: ${MOD} is already loaded on the controller; the harness does not take over a module it did not load`;
      return;
    }
    await rc.uploadFile(FILE, fs.readFileSync(path.join(__dirname, '..', 'ZZ_PROBE.mod'), 'utf8'));
    did.uploaded = true;
    await rc.loadModule(task, FILE, true);
    did.loaded = true;
    await rc.setProgramPointer(task, { module: MOD, routine: 'ZZ_PROBE_LOOP' });
    const pp = await readback('program pointer before E2', () => rc.getProgramPointer(task));
    if (!pp || pp.module !== MOD) {
      result.stepE.e2 = `skipped: the program pointer is in ${pp ? `${pp.module}/${pp.routine}` : 'no routine'}, not in ${MOD}`;
      return;
    }
    let motors = await readback('controller state before motors on', () => rc.getControllerState());
    if (motors !== 'motoron') {
      if (rw8) {
        // RobotWare 8: motors on is a pendant action, not an RWS one.
        const wait = Number(env.HOSTTEST_MOTORS_WAIT_S || 180);
        const msg = `E2 on RobotWare ${rwVersion}: switch the motors ON at the FlexPendant now (Remote Access on, controller in Auto). Waiting up to ${wait} s.`;
        process.stderr.write(`\n*** ${msg}\n`);
        result.stepE.e2Instruction = msg;
        for (let t = 0; t < wait && motors !== 'motoron'; t += 2) {
          await sleep(2000);
          motors = await readback('controller state (waiting for the pendant)', () => rc.getControllerState());
        }
      } else {
        await rc.setControllerState('motoron');
        await sleep(1000);
        motors = await readback('controller state after motors on', () => rc.getControllerState());
      }
    }
    if (motors !== 'motoron') {
      result.stepE.e2 = `skipped: the motors did not come on (controller state ${motors}); ${rw8 ? 'on RobotWare 8 they are switched on at the pendant' : 'RWS refused or did not switch them on'}`;
      return;
    }
    result.stepE.e2 = 'run';
    await run('E2 startRapid', 'abbRobot.startRapid', acceptTyped(robotName));
    await sleep(1500);
    await readback('execution state after E2 start', () => rc.getRapidExecutionState());
    await run('E3 stopRapid', 'abbRobot.stopRapid', null);
    await sleep(1500);
    await readback('execution state after E3 stop', () => rc.getRapidExecutionState());
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    result.stepE.e2 = result.stepE.e2 === 'run' ? 'run' : `skipped: setup failed: ${msg}`;
    result.stepE.e2Error = msg;
  } finally {
    // Teardown always runs, whatever happened above, and undoes only what was done.
    step = 'E2 teardown';
    const td = async (label, fn) => {
      try { const v = await fn(); result.cleanup.push(`E2 teardown: ${label}: ok${v === undefined ? '' : ` (${v})`}`); }
      catch (e) { result.cleanup.push(`E2 teardown: ${label} FAILED: ${e && e.message ? e.message : e}`); }
    };
    if (did.uploaded || did.loaded) {
      await td('stop RAPID if running', async () => {
        if ((await rc.getRapidExecutionState()) !== 'running') { return 'already stopped'; }
        await rc.stopRapid();
        return 'stopped';
      });
    }
    const motorsNow = await readback('controller state before teardown', () => rc.getControllerState());
    if (motorsNow === 'motoron' && start.ctrlstate && start.ctrlstate !== 'motoron') {
      await td('motors off', async () => { await rc.setControllerState('motoroff'); });
      const again = await readback('controller state after motors off', () => rc.getControllerState());
      if (again === 'motoron') { result.cleanup.push('E2 teardown: the motors are still ON; switch them off at the pendant'); }
    }
    if (did.loaded) { await td(`unload ${MOD}`, () => rc.unloadModule(task, MOD)); }
    if (did.uploaded) { await td(`delete ${FILE}`, () => rc.deleteFile(FILE)); }
    if (start.ctrlstate !== undefined) {
      const end = await snapshot('E2 end state');
      result.stepE.e2End = end;
      const same = ['ctrlstate', 'opmode', 'execution'].every(k => end[k] === start[k])
        && JSON.stringify(end.modules) === JSON.stringify(start.modules);
      result.cleanup.push(same ? 'E2 teardown: the controller reads its start state again'
        : `E2 teardown: the controller does NOT read its start state: start ${JSON.stringify(start)}, end ${JSON.stringify(end)}`);
    }
  }
  }

  async function stepF() {
  // ── (F) toggle a probe digital output behind the change-tier acknowledgement ──
  // F1 cancels (no request), F2 accepts and reads the signal back, F3 accepts
  // again to put it back.
  step = 'F baseline';
  const name = env.HOSTTEST_DO || 'ZZ_PROBE_DO1';
  const find = async () => (await rc.searchSignals({ name, type: 'DO' })).find(s => s.name === name && s.type === 'DO');
  const before = await readback(`signal ${name} before`, find);
  result.stepF = { signal: name };
  if (!before) {
    result.stepF.refused = `no DO named ${name} on the controller (set HOSTTEST_DO); nothing sent`;
    return;
  }
  result.stepF.before = before.lvalue;
  const arg = () => ({ name: before.name, type: 'DO', value: before.value, lvalue: before.lvalue });
  await run('F1 toggleSignal cancel', 'abbRobot.toggleSignal', cancelConfirm, [arg()]);
  await readback(`signal ${name} after F1`, find);
  const s1 = arg();
  await run('F2 toggleSignal accept', 'abbRobot.toggleSignal', accept, [s1]);
  const after2 = await readback(`signal ${name} after F2`, find);
  const s2 = { name: before.name, type: 'DO', value: after2 ? after2.value : s1.lvalue, lvalue: after2 ? after2.lvalue : s1.lvalue };
  await run('F3 toggleSignal restore', 'abbRobot.toggleSignal', accept, [s2]);
  const after3 = await readback(`signal ${name} after F3`, find);
  result.stepF.after2 = after2 ? after2.lvalue : undefined;
  result.stepF.after3 = after3 ? after3.lvalue : undefined;
  if (after3 && after3.lvalue !== before.lvalue) {
    result.cleanup.push(`signal ${name} reads ${after3.lvalue} after F3; it was ${before.lvalue} before the step`);
  }
  }

  async function stepG() {
  // ── (G) Load CFG file, cancelled at the disruptive confirmation: no request ──
  await run('G loadCfgFile cancel', 'abbRobot.loadCfgFile', (kind, p) =>
    (kind === 'inputBox' ? '$HOME/ZZ_HOSTTEST.cfg'
      : kind === 'quickPick' ? p.items.find(i => i.label === 'add')
      : cancelConfirm(kind, p)));
  }

  async function stepI() {
  // ── (I) two entries for one controller; a CFG instance opened from the
  // first robot is written back while the second one is active: the
  // confirmation and the notification name the first robot. ──
  if (!robotId2) { result.stepI = { refused: 'no second robot entry (HOSTTEST_ROBOT_ID_2)' }; return; }
  const domain = env.HOSTTEST_CFG_DOMAIN || 'SYS';
  result.stepI = { domain };
  await run('I1 connect second entry', 'abbRobot.connectRobot', null, [robotId2]);
  if (uiOf('I1 connect second entry').some(u => u.kind === 'error')) {
    result.stepI.refused = 'the second entry did not connect; see notifications';
    return;
  }
  await run('I2 activate first entry', 'abbRobot.setActiveRobot', null, [robotId]);
  // The domain, then a type that has an instance (HOSTTEST_CFG_TYPE, else the
  // first type of the domain that lists one), then its first instance.
  step = 'I2b find a CFG type';
  let cfgType = env.HOSTTEST_CFG_TYPE;
  if (!cfgType) {
    const types = await readback(`CFG types of ${domain}`, () => rc.listCfgTypes(domain)) || [];
    for (const t of types) {
      const name = typeof t === 'string' ? t : t.name;
      const instances = await readback(`instances of ${domain}/${name}`, () => rc.listCfgInstances(domain, name));
      if (Array.isArray(instances) && instances.length) { cfgType = name; break; }
    }
  }
  result.stepI.type = cfgType;
  if (!cfgType) { result.stepI.refused = `no type of CFG domain ${domain} lists an instance; nothing opened`; return; }
  const opened = await run('I3 editCfgInstance on first', 'abbRobot.editCfgInstance', (kind, p) => {
    if (kind !== 'quickPick') { return undefined; }
    const label = i => (typeof i === 'string' ? i : i.label);
    if (/domain/i.test(p.opts.placeHolder || '')) { return p.items.find(i => label(i) === domain); }
    if (/type/i.test(p.opts.placeHolder || '')) { return p.items.find(i => label(i) === cfgType); }
    return p.items[0];
  });
  const doc = extVscode.workspace.textDocuments.find(d => /\.cfg\.jsonc$/.test(d.fileName));
  if (!opened.ok || !doc) {
    result.stepI.refused = `no CFG document was opened (${opened.thrown || 'see notifications'})`;
    return;
  }
  result.stepI.document = path.basename(doc.fileName);
  await run('I4 activate second entry', 'abbRobot.setActiveRobot', null, [robotId2]);
  // Save the document unchanged in content: a space on the first comment line
  // is appended so the editor has something to save; the comment is stripped
  // before the write, so the instance is written with the values it was read with.
  step = 'I5 save on non-active';
  respond = accept;
  const s = { name: step, command: '(Ctrl+S on the CFG document)', start: new Date().toISOString() };
  result.steps.push(s);
  try {
    const edit = new extVscode.WorkspaceEdit();
    edit.insert(doc.uri, new extVscode.Position(0, doc.lineAt(0).text.length), ' ');
    await extVscode.workspace.applyEdit(edit);
    s.ok = await doc.save();
    // The write-back runs in the save listener; wait for its notification.
    for (let i = 0; i < 40 && !uiOf(step).some(u => ['info', 'error', 'warning'].includes(u.kind) && !u.modal); i++) { await sleep(250); }
  } catch (e) {
    s.ok = false;
    s.thrown = e && e.message ? e.message : String(e);
  }
  s.end = new Date().toISOString();
  respond = () => undefined;
  await run('I6 disconnect second entry', 'abbRobot.disconnectRobot', null, [robotId2]);
  }
}
