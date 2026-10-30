// Every call to a client write method in src/ sits inside a send wrapper:
// `sendConfirmed` or `sendReducing` from src/confirm.ts, or one of the
// extension's adapters that forward the write they are given to one of them.
// So a write cannot leave RAPID Live without the dialog that names the robot
// (and the task, where one applies).
//
// The write-method list is checked against the vendored client's type
// declarations: a public method the client adds fails here until it is
// classified, so a new write (client 1.6.0's deployModule, say) cannot slip in
// unguarded. The sites not wrapped yet are listed in
// test/write-sites.baseline.json, keyed by file, enclosing command (or function)
// and method, never by line. The test fails on a site the baseline does not
// list (a new unwrapped write) and on a baseline entry whose site is gone (the
// list only shrinks). To print the sites the scan finds, as baseline entries:
//
//   node build.js --tests && WRITE_SITES_PRINT=1 node --test out/test/writeSites.test.js

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const srcDir = path.join(root, 'src');
const clientDist = path.join(root, 'node_modules', 'abb-rws-client', 'dist');
const baselinePath = path.join(root, 'test', 'write-sites.baseline.json');

// ─── Classification of the client's public methods ───────────────────────────

/** A read, by its verb. `(?=[A-Z]|$)` keeps `can` from matching `cancelRmmp`. */
const READ_PATTERN = /^(get|list|read|is|has|find|search|describe|validate|check|poll|can|supports|current|calc|refresh|on|dispose)(?=[A-Z]|$)/;
/** Reads whose name has no read verb. */
const READ_EXCEPTIONS = ['downloadModule'];
/** Reads by name that change the controller: a DIPC read takes the message off its queue (the client: consumed on read). Writes. */
const CONSUMING_READS = ['readDipcMessage'];
/** Session teardown and setup: accepted anywhere, never behind a dialog (the lock-state check is the proof, not a wrapper). */
const CONNECTION = ['connect', 'disconnect', 'connectRobot', 'disconnectRobot', 'disconnectAll'];
/** What the manager holds on this PC, no request to a controller (removeRobot also disconnects). */
const LOCAL = ['setExpectedSystemId', 'setControlStation', 'addRobot', 'removeRobot', 'setActive', 'updateConfig'];
/** A read that POSTs a save to the controller's TEMP volume and deletes it: allowed at the three read sites only. */
const TEMP_POST = ['getModuleSource'];
/** Every other public instance method of RobotManager and MultiRobotManager: a write. Hand-kept, checked against the .d.ts below. */
const WRITE_METHODS = [
  'activateAllRapidTasks', 'activateRapidTask', 'appealWriteAccessRelease', 'callServiceRoutine', 'cancelRmmp', 'changePassword',
  'clearAllEventLogs', 'clearCertificateStore', 'clearEventLog', 'compressPath', 'copyControllerFile', 'createBackup', 'createCfgInstance',
  'createDipcQueue', 'createDirectory', 'deactivateAllRapidTasks', 'deactivateRapidTask', 'decompressPath', 'deleteControllerFile',
  'holdToRun', 'impersonateUser', 'jog', 'loadCfgFile', 'loadCollisionAvoidanceConfig', 'loadProgram', 'lockOperationMode',
  'modifyPosition', 'ppNextInst', 'ppPrevInst', 'registerUser', 'releaseMastership', 'releaseMastershipAll', 'releaseMastershipWithId',
  'readDipcMessage', 'removeBreakpoint', 'removeCertificate', 'removeCfgInstance', 'removeDipcQueue', 'renameFile', 'requestMastership',
  'requestMastershipAll', 'requestMastershipWithId', 'requestRmmp', 'resetMastershipWatchdog', 'resetRapid', 'resetTaskProgramPointer',
  'restartController', 'restoreBackup', 'runCyclicBrakeCheck', 'saveCfgFile', 'saveCollisionAvoidanceSnapshot', 'saveDiagnostics',
  'saveEventLogRaw', 'saveSystemInfo', 'sendDipcMessage', 'setActiveTool', 'setActiveWobj', 'setAllowMotionControl', 'setBreakpoint',
  'setCfgInstance', 'setCollisionPredictionMode', 'setControllerClock', 'setControllerLanguage', 'setExecutionCycle',
  'setExternalEmergencyStop', 'setIoDeviceLState', 'setKeylessMotorOn', 'setMechunitBaseFrame', 'setMechunitForJogging', 'setModuleText',
  'setModuleTextRange', 'setMotorsOff', 'setMotorsOn', 'setNonMotionExecution', 'setOperationMode', 'setPPToCursor', 'setPPToRoutine',
  'setPPToServiceRoutine', 'setPanelLanguage', 'setRapidVariable', 'setSignalSimulated', 'setSpeedRatio', 'setTaskSelection',
  'setUiInstructionParam', 'setVirtualTimeRunning', 'setVirtualTimeScale', 'simAutoStop', 'simEmergencyStop', 'simEnableSwitch',
  'simGeneralStop', 'simResetEmergencyStop', 'startJob', 'startRapid', 'stepRapid', 'stopRapid', 'teleportMechunit', 'triggerVisionJob',
  'unblockSignals', 'unloadModule', 'unloadProgram', 'unlockOperationMode', 'unsubscribeResource', 'updateSubscriptionGroup',
  'uploadAndLoad', 'uploadCertificate', 'uploadFile', 'writeIoSignal',
];
/** The writes `sendReducing` may wrap: they only stop or give up. `setAllowMotionControl` only with `false`. */
const REDUCING = ['stopRapid', 'setMotorsOff', 'releaseMastershipAll', 'setAllowMotionControl'];
/** The write methods the 2026-10-30 write inventory names (the called ones, then the 52 uncalled): the oracle for the classification. */
const INVENTORY_WRITES = [
  'startRapid', 'setMotorsOn', 'jog', 'setMechunitForJogging', 'setUiInstructionParam', 'setPPToRoutine', 'setAllowMotionControl',
  'setOperationMode', 'lockOperationMode', 'unlockOperationMode', 'restartController', 'restoreBackup', 'loadCfgFile', 'removeCfgInstance',
  'clearEventLog', 'clearAllEventLogs', 'deleteControllerFile', 'simEmergencyStop', 'simResetEmergencyStop', 'simGeneralStop',
  'simAutoStop', 'simEnableSwitch', 'teleportMechunit', 'setVirtualTimeScale', 'createCfgInstance', 'resetRapid', 'loadProgram',
  'unloadModule', 'activateRapidTask', 'deactivateRapidTask', 'activateAllRapidTasks', 'deactivateAllRapidTasks', 'setControllerClock',
  'removeDipcQueue', 'setSpeedRatio', 'setRapidVariable', 'writeIoSignal', 'setCfgInstance', 'setPPToServiceRoutine', 'setExecutionCycle',
  'setActiveTool', 'setActiveWobj', 'createBackup', 'saveCfgFile', 'createDipcQueue', 'sendDipcMessage', 'compressPath', 'createDirectory',
  'renameFile', 'requestRmmp', 'stopRapid', 'setMotorsOff', 'releaseMastershipAll',
  'setNonMotionExecution', 'setCollisionPredictionMode', 'setTaskSelection', 'setSignalSimulated', 'unblockSignals', 'setIoDeviceLState',
  'uploadFile', 'copyControllerFile', 'uploadAndLoad', 'unloadProgram', 'startJob', 'setPanelLanguage', 'setControllerLanguage',
  'setExternalEmergencyStop', 'setKeylessMotorOn', 'setModuleText', 'setModuleTextRange', 'saveEventLogRaw', 'decompressPath',
  'saveDiagnostics', 'saveSystemInfo', 'registerUser', 'impersonateUser', 'changePassword', 'updateSubscriptionGroup',
  'unsubscribeResource', 'setPPToCursor', 'ppPrevInst', 'ppNextInst', 'stepRapid', 'holdToRun', 'setBreakpoint', 'removeBreakpoint',
  'triggerVisionJob', 'runCyclicBrakeCheck', 'setMechunitBaseFrame', 'uploadCertificate', 'clearCertificateStore', 'removeCertificate',
  'requestMastership', 'releaseMastership', 'requestMastershipAll', 'requestMastershipWithId', 'releaseMastershipWithId',
  'resetMastershipWatchdog', 'appealWriteAccessRelease', 'modifyPosition', 'resetTaskProgramPointer', 'saveCollisionAvoidanceSnapshot',
  'loadCollisionAvoidanceConfig', 'setVirtualTimeRunning',
];

const WRITE = new Set(WRITE_METHODS);

/** The public instance methods of the classes a .d.ts declares (statics are discovery helpers and the constructor; they hold no session). */
function publicInstanceMethods(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n)) {
      for (const m of n.members) {
        if (!ts.isMethodDeclaration(m) || !m.name || !ts.isIdentifier(m.name)) { continue; }
        const mods = ts.getModifiers(m) ?? [];
        const hidden = mods.some(x => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword || x.kind === ts.SyntaxKind.StaticKeyword);
        if (!hidden) { names.push(m.name.text); }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return [...new Set(names)];
}

type Classification = 'read' | 'write' | 'connection' | 'local' | 'temp-post';

function classify(name: string): Classification[] {
  const found: Classification[] = [];
  // The TEMP save reads like a get, and a consuming read reads like a read: neither counts as a plain read.
  if (!TEMP_POST.includes(name) && !CONSUMING_READS.includes(name) && (READ_PATTERN.test(name) || READ_EXCEPTIONS.includes(name))) { found.push('read'); }
  if (WRITE.has(name)) { found.push('write'); }
  if (CONNECTION.includes(name)) { found.push('connection'); }
  if (LOCAL.includes(name)) { found.push('local'); }
  if (TEMP_POST.includes(name)) { found.push('temp-post'); }
  return found;
}

// ─── The scan ────────────────────────────────────────────────────────────────

interface Wrapper { sendIndex: number; reducing: boolean }
interface Site { file: string; command: string; method: string; line: number; wrapper?: { name: string; reducing: boolean } }
interface Fault { file: string; line: number; text: string }
interface Scan { sites: Site[]; faults: Fault[]; wrappers: Record<string, string[]> }

const lineOf = (sf: ts.SourceFile, n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const contains = (outer: ts.Node, inner: ts.Node): boolean => outer.pos <= inner.pos && inner.end <= outer.end;

/** The parameter names of a function-like node, in order. */
function paramNames(fn: ts.SignatureDeclaration): string[] {
  return fn.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : ''));
}

/**
 * The wrappers a file may use: `sendConfirmed` and `sendReducing` when imported
 * from ./confirm, and every function of the file that forwards one of its own
 * parameters as the send of a wrapper (the extension's `sendTo(entry, request,
 * send)`, say), found until no new one appears.
 */
function wrappersOf(sf: ts.SourceFile): Map<string, Wrapper> {
  const wrappers = new Map<string, Wrapper>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !/^\.\/confirm$/.test(st.moduleSpecifier.text)) { continue; }
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) { continue; }
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 'sendConfirmed') { wrappers.set(el.name.text, { sendIndex: 3, reducing: false }); }
      if (imported === 'sendReducing') { wrappers.set(el.name.text, { sendIndex: 3, reducing: true }); }
    }
  }
  const functions: Array<{ name: string; fn: ts.SignatureDeclaration & { body?: ts.Node } }> = [];
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) { functions.push({ name: n.name.text, fn: n }); }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      functions.push({ name: n.name.text, fn: n.initializer });
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, fn } of functions) {
      if (wrappers.has(name) || !fn.body) { continue; }
      const params = paramNames(fn);
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && wrappers.has(n.expression.text)) {
          const inner = wrappers.get(n.expression.text)!;
          const arg = n.arguments[inner.sendIndex];
          if (arg && ts.isIdentifier(arg) && params.includes(arg.text)) {
            wrappers.set(name, { sendIndex: params.indexOf(arg.text), reducing: inner.reducing });
            grew = true;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(fn.body);
    }
  }
  return wrappers;
}

/** The nearest wrapper call whose send argument holds `node`. */
function wrapperOf(node: ts.Node, wrappers: Map<string, Wrapper>): { name: string; reducing: boolean } | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || !wrappers.has(n.expression.text)) { continue; }
    const w = wrappers.get(n.expression.text)!;
    const arg = n.arguments[w.sendIndex];
    if (arg && contains(arg, node)) { return { name: n.expression.text, reducing: w.reducing }; }
  }
  return undefined;
}

/** The command id a node is registered under (`tracedCommand('<id>', …)`), else the nearest named function, else the module. */
function commandOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'tracedCommand' && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      return n.arguments[0].text;
    }
  }
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) { return n.name.text; }
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) {
      const cls = n.parent;
      return ts.isClassDeclaration(cls) && cls.name ? `${cls.name.text}.${n.name.text}` : n.name.text;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      return n.name.text;
    }
  }
  return 'module';
}

/**
 * Whether an identifier stands in a value position (passed, stored, returned),
 * not as a name. A bare call `callServiceRoutine(…)` is a local function of that
 * name (src/serviceRoutine.ts), not a client method, which needs a receiver.
 */
function isValueUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p)) { return p.expression !== id; }
  if (ts.isVariableDeclaration(p)) { return p.initializer === id; }
  if (ts.isPropertyAssignment(p)) { return p.initializer === id; }
  return ts.isReturnStatement(p) || ts.isArrayLiteralExpression(p) || ts.isBinaryExpression(p) || ts.isConditionalExpression(p)
    || ts.isSpreadElement(p) || ts.isAsExpression(p) || ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p)
    || (ts.isArrowFunction(p) && p.body === id);
}

/** One source, by its name relative to src/ (posix), scanned into `out`. */
function scanSource(name: string, text: string, out: Scan): void {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const wrappers = wrappersOf(sf);
  out.wrappers[name] = [...wrappers.keys()];
  const fault = (n: ts.Node, text: string): void => { out.faults.push({ file: name, line: lineOf(sf, n), text }); };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if (WRITE.has(method)) {
        const wrapper = wrapperOf(n, wrappers);
        out.sites.push({ file: name, command: commandOf(n), method, line: lineOf(sf, n), wrapper });
        if (wrapper?.reducing) {
          if (!REDUCING.includes(method)) { fault(n, `${method} inside ${wrapper.name}: sendReducing is for Stop, Motors Off, the withdrawal and the lock release only`); }
          if (method === 'setAllowMotionControl' && n.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword) { fault(n, `setAllowMotionControl inside ${wrapper.name}: only the withdrawal (false) is reducing`); }
        }
      } else if (TEMP_POST.includes(method)) {
        const command = commandOf(n);
        const allowed = name === 'ControllerSourceProvider.ts' || (name === 'extension.ts' && ['abbRobot.pullAllModules', 'abbRobot.openModuleSource'].includes(command));
        if (!allowed) { fault(n, `${method} in ${command}: it saves to the controller's TEMP volume; decide whether this read may, then list it here`); }
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['confirmWrite', 'confirmChoice'].includes(n.expression.text)) {
      const allowed = name === 'confirm.ts' || name === 'motionControl.ts';
      if (!allowed) { fault(n, `${n.expression.text} outside confirm.ts and motionControl.ts: ask and send through sendConfirmed`); }
    }
    if (ts.isPropertyAccessExpression(n) && WRITE.has(n.name.text) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
      fault(n, `${n.name.text} used as a value, not called: the scan cannot follow it`);
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && WRITE.has(n.argumentExpression.text)) {
      fault(n, `${n.argumentExpression.text} reached by element access: call it by name inside a wrapper`);
    }
    // A member reached by a computed key and called: the scan cannot tell a write from a read, so it refuses the shape.
    if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression) && !ts.isStringLiteralLike(n.expression.argumentExpression) && !ts.isNumericLiteral(n.expression.argumentExpression)) {
      fault(n, `a computed member call ${n.expression.getText(sf)}(): the scan cannot follow it; call the method by name inside a wrapper`);
    }
    // A write method taken out of its receiver by destructuring, under its own name or another: the call that follows has no receiver to scan.
    if (ts.isBindingElement(n)) {
      const prop = n.propertyName ?? n.name;
      if (ts.isIdentifier(prop) && WRITE.has(prop.text)) { fault(n, `${prop.text} destructured: the scan cannot follow it`); }
    }
    if (ts.isShorthandPropertyAssignment(n) && WRITE.has(n.name.text)) { fault(n, `${n.name.text} passed as a value`); }
    if (ts.isIdentifier(n) && WRITE.has(n.text) && isValueUse(n)) { fault(n, `${n.text} used as a bare value`); }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'skipAsk') {
      if (!ts.isStringLiteral(n.initializer) || n.initializer.text !== 'jog-repeat') { fault(n, "skipAsk takes 'jog-repeat' only"); }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** Every .ts file under `dir`, subfolders included, as posix paths relative to `dir`, sorted. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(name); } else if (e.name.endsWith('.ts')) { out.push(name); }
    }
  };
  walk('');
  return out.sort();
}

function scanFile(name: string, out: Scan): void {
  scanSource(name, fs.readFileSync(path.join(srcDir, name), 'utf8'), out);
}

function scan(): Scan {
  const out: Scan = { sites: [], faults: [], wrappers: {} };
  for (const f of sourceFiles(srcDir)) { scanFile(f, out); }
  return out;
}

interface BaselineEntry { file: string; command: string; method: string }
const keyOf = (e: BaselineEntry): string => `${e.file} | ${e.command} | ${e.method}`;

function counts(entries: BaselineEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) { m.set(keyOf(e), (m.get(keyOf(e)) ?? 0) + 1); }
  return m;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('the client write surface, from the vendored type declarations', () => {
  const methods = [...new Set([
    ...publicInstanceMethods(path.join(clientDist, 'RobotManager.d.ts')),
    ...publicInstanceMethods(path.join(clientDist, 'MultiRobotManager.d.ts')),
  ])];

  it('every public method is classified once: a read by its verb, a write, a connection call, local state or the TEMP save', () => {
    const unclassified = methods.filter(m => classify(m).length === 0);
    assert.deepEqual(unclassified, [], `client added ${unclassified.join(', ')}; classify it (a write goes into WRITE_METHODS, a read into READ_EXCEPTIONS)`);
    const twice = methods.filter(m => classify(m).length > 1);
    assert.deepEqual(twice, []);
  });

  it('the hand-kept lists name only methods the client has', () => {
    const have = new Set(methods);
    for (const list of [WRITE_METHODS, READ_EXCEPTIONS, CONNECTION, LOCAL, TEMP_POST, REDUCING]) {
      assert.deepEqual(list.filter(m => !have.has(m)), [], 'gone from the client');
    }
    assert.ok(WRITE_METHODS.length >= 100, `${WRITE_METHODS.length} write methods`);
  });

  it('every write method the inventory names is a write here, and so is the consuming DIPC read', () => {
    assert.deepEqual(INVENTORY_WRITES.filter(m => !WRITE.has(m)), []);
    for (const m of CONSUMING_READS) { assert.ok(WRITE.has(m), m); }
  });
});

describe('every client write call in src/ sits inside a send wrapper', () => {
  const result = scan();
  const unwrapped = result.sites.filter(s => !s.wrapper);
  if (process.env.WRITE_SITES_PRINT) {
    const entries = unwrapped.map(({ file, command, method }) => ({ file, command, method }));
    console.log(JSON.stringify(entries, null, 2));
  }

  it('the wrappers are sendConfirmed, sendReducing and the extension\'s three adapters; no other file adds one', () => {
    assert.deepEqual(result.wrappers['extension.ts'].sort(), ['sendConfirmed', 'sendMotion', 'sendReducing', 'sendReducingTo', 'sendTo']);
    for (const [file, names] of Object.entries(result.wrappers)) {
      if (file === 'extension.ts') { continue; }
      assert.deepEqual(names.filter(n => n !== 'sendConfirmed' && n !== 'sendReducing'), [], `${file} adds a wrapper of its own`);
    }
  });

  it('no write method is passed as a value, reached by element access, or wrapped as reducing when it is not; skipAsk is the repeat jog only; the TEMP save and confirmWrite stay in their places', () => {
    assert.deepEqual(result.faults.map(f => `${f.file}:${f.line} ${f.text}`), []);
  });

  it('every write call not in the baseline is wrapped, and every baseline entry still stands (the list only shrinks)', () => {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BaselineEntry[];
    const want = counts(baseline);
    const have = counts(unwrapped);
    const added: string[] = [];
    const fixed: string[] = [];
    for (const [key, n] of have) {
      const allowed = want.get(key) ?? 0;
      if (n > allowed) {
        const lines = unwrapped.filter(s => keyOf(s) === key).map(s => s.line).join(', ');
        added.push(`${key} (line ${lines}): wrap it in sendConfirmed or sendReducing`);
      }
    }
    for (const [key, n] of want) {
      if ((have.get(key) ?? 0) < n) { fixed.push(`${key}: fixed, remove it from the baseline`); }
    }
    assert.deepEqual(added, [], 'new unwrapped writes');
    assert.deepEqual(fixed, [], 'stale baseline entries');
  });

  it('the baseline is sorted and keyed by file, command and method, never by line', () => {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Array<Record<string, unknown>>;
    for (const e of baseline) { assert.deepEqual(Object.keys(e).sort(), ['command', 'file', 'method']); }
    const keys = baseline.map(e => keyOf(e as unknown as BaselineEntry));
    assert.deepEqual(keys, [...keys].sort());
  });

  it('the reducing wrapper holds only Stop, Motors Off, the withdrawal and the lock release', () => {
    const reducing = result.sites.filter(s => s.wrapper?.reducing).map(s => s.method);
    assert.deepEqual(reducing.filter(m => !REDUCING.includes(m)), []);
  });
});

describe('what the scan refuses in planted sources (review finding 18)', () => {
  const planted = (text: string): Scan => {
    const out: Scan = { sites: [], faults: [], wrappers: {} };
    scanSource('planted/probe.ts', `import { sendConfirmed } from './confirm';\ndeclare const m: any; declare const ui: any; declare const robot: any; declare const req: any;\n${text}`, out);
    return out;
  };
  const faultsOf = (text: string): string[] => planted(text).faults.map(f => f.text);

  it('a write called by name inside the wrapper is a wrapped site and no fault (the control)', () => {
    const out = planted('async function f() { await sendConfirmed(ui, robot, req, () => m.startRapid()); }');
    assert.deepEqual(out.faults, []);
    assert.deepEqual(out.sites.map(s => [s.file, s.command, s.method, s.wrapper?.name]), [['planted/probe.ts', 'f', 'startRapid', 'sendConfirmed']]);
  });

  it('a destructured write method, plain or renamed, is a fault, with or without .call and .apply', () => {
    assert.deepEqual(faultsOf('const { startRapid } = m; startRapid.call(m);'), ['startRapid destructured: the scan cannot follow it']);
    assert.deepEqual(faultsOf('const { stopRapid: halt } = m; halt.apply(m);'), ['stopRapid destructured: the scan cannot follow it']);
    assert.deepEqual(faultsOf('function g({ resetRapid }: any) { resetRapid(); }'), ['resetRapid destructured: the scan cannot follow it']);
  });

  it('.call and .apply on the method itself are the value-use fault', () => {
    assert.deepEqual(faultsOf('m.startRapid.call(m);'), ['startRapid used as a value, not called: the scan cannot follow it']);
    assert.deepEqual(faultsOf('Reflect.apply(m.unloadModule, m, []);'), ['unloadModule used as a value, not called: the scan cannot follow it']);
  });

  it('element access by a string, a template string or a computed key is a fault', () => {
    assert.deepEqual(faultsOf("m['setMotorsOn']();"), ['setMotorsOn reached by element access: call it by name inside a wrapper']);
    assert.deepEqual(faultsOf('m[`setMotorsOn`]();'), ['setMotorsOn reached by element access: call it by name inside a wrapper']);
    assert.deepEqual(faultsOf("const k = 'resetRapid'; m[k]();"), ['a computed member call m[k](): the scan cannot follow it; call the method by name inside a wrapper']);
    assert.deepEqual(faultsOf('const k = 2; m[k]();'), ['a computed member call m[k](): the scan cannot follow it; call the method by name inside a wrapper']);
    assert.deepEqual(faultsOf('const t = [1, 2]; t[0];'), [], 'an element read with a literal key is not a call');
  });

  it('the files scanned are every .ts file under src, subfolders included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-sites-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
      for (const f of ['b.ts', 'a.ts', 'sub/z.ts', 'sub/deep/y.ts', 'sub/notes.md', 'c.d.ts']) { fs.writeFileSync(path.join(dir, f), ''); }
      assert.deepEqual(sourceFiles(dir), ['a.ts', 'b.ts', 'c.d.ts', 'sub/deep/y.ts', 'sub/z.ts']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const sources = sourceFiles(srcDir);
    assert.ok(sources.includes('extension.ts') && sources.includes('confirm.ts'));
    assert.ok(sources.every(f => !f.includes('\\')), 'names are posix paths relative to src');
  });

  it('the wrapper UI type requires the mode seam: a bare window cannot be handed to a wrapper', () => {
    const confirm = fs.readFileSync(path.join(srcDir, 'confirm.ts'), 'utf8');
    assert.match(confirm, /^  refuse\(label: string, robot: ConfirmRobot\): string \| undefined;$/m);
    assert.doesNotMatch(confirm, /refuse\?/);
    const ext = fs.readFileSync(path.join(srcDir, 'extension.ts'), 'utf8');
    assert.match(ext, /^const guardBase: ConfirmUi & Pick<GuardUi, 'log'> = \{ \.\.\.confirmUi, log: /m);
    assert.doesNotMatch(ext, /const guardUi\b/);
  });
});
