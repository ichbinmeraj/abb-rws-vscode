import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setRobotMode, settleMode, type ModeRobot, type ModeUi } from '../src/modeFlow';
import { KEEP_WATCHING, MODE_KEY, RobotModes, answerRecord, defaultRecord, type ModeRecord, type ModeVerdict } from '../src/watchMode';
import type { ConfirmRobot } from '../src/confirm';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

const cell: ConfirmRobot = { name: 'Cell 3', host: '10.0.5.20', port: 80 };

/** The records in memory, as `context.globalState` holds them. */
function modes(initial?: ModeRecord) {
  const data: Record<string, unknown> = initial ? { [MODE_KEY]: { r1: initial } } : {};
  const m = new RobotModes({ get: <T>(key: string, d: T): T => (data[key] as T | undefined) ?? d, update: async (key, value) => { data[key] = value; } });
  return { m, record: () => m.get('r1') };
}

/** A robot whose verdicts come in the order given (the last one repeats), with every call logged. */
function robot(verdicts: ModeVerdict[], over: { connected?: boolean; identityRead?: boolean; motion?: boolean; releaseFails?: boolean; refreshFails?: boolean } = {}) {
  const calls: string[] = [];
  let i = 0;
  const r: ModeRobot = {
    id: 'r1', robot: cell,
    connected: () => over.connected ?? true,
    identityRead: () => over.identityRead ?? true,
    refresh: async () => { calls.push('refresh'); if (over.refreshFails) { throw new Error('HTTP 503'); } },
    verdict: () => verdicts[Math.min(i++, verdicts.length - 1)],
    motionAllowedHere: () => over.motion ?? false,
    withdraw: async () => { calls.push('withdraw'); },
    releaseLocks: async () => { calls.push('release'); if (over.releaseFails) { throw new Error('nothing held'); } },
  };
  return { r, calls };
}

/** A window that answers the modal and the notice as told, and records what it showed. */
function ui(answers: { modal?: (message: string, buttons: string[]) => string | undefined; notice?: (message: string, buttons: string[]) => string | undefined } = {}) {
  const shown: Array<Record<string, unknown>> = [];
  const log: string[] = [];
  const u: ModeUi = {
    notice: async (message, buttons) => { shown.push({ kind: 'notice', message, buttons }); return answers.notice?.(message, buttons); },
    modal: async (message, detail, buttons) => { shown.push({ kind: 'modal', message, detail, buttons }); return answers.modal?.(message, buttons); },
    info: message => { shown.push({ kind: 'info', message }); },
    warn: message => { shown.push({ kind: 'warn', message }); },
    log: line => { log.push(line); },
    switchToOperate: id => { shown.push({ kind: 'switch', id }); },
    refreshBadge: () => { shown.push({ kind: 'badge' }); },
  };
  return { u, shown, log };
}

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

const watchReal: ModeVerdict = { mode: 'watch', reason: 'real controller', ctrlClass: 'real', askDue: true };
const watchNoAsk: ModeVerdict = { mode: 'watch', reason: 'chosen', ctrlClass: 'real', askDue: false };
const notRead: ModeVerdict = { mode: 'watch', reason: 'controller type not read', ctrlClass: 'not-read', askDue: false };
const operateVirtual: ModeVerdict = { mode: 'operate', ctrlClass: 'virtual' };

describe('settling the mode after a connect (review finding 19)', () => {
  it('reads the identity now when the client has not, and does nothing while the type is not read', async () => {
    const { r, calls } = robot([notRead], { identityRead: false });
    const { m, record } = modes();
    const { u, shown } = ui();
    await settleMode(r, m, u);
    assert.deepEqual(calls, ['refresh']);
    assert.deepEqual(shown, []);
    assert.equal(record(), undefined);
    // A refresh that fails is not fatal: the verdict decides, and here it is still not read.
    const failing = robot([notRead], { identityRead: false, refreshFails: true });
    await settleMode(failing.r, m, u);
    assert.deepEqual(failing.calls, ['refresh']);
    const read = robot([watchNoAsk]);
    await settleMode(read.r, m, u);
    assert.deepEqual(read.calls, [], 'no refresh when the identity is read');
    const offline = robot([notRead], { connected: false, identityRead: false });
    await settleMode(offline.r, m, u);
    assert.deepEqual(offline.calls, [], 'no refresh when not connected');
  });

  it('a robot saved before 1.5.0 gets its class recorded; on a real controller a notice offers the switch, and its button runs Set Robot Mode', async () => {
    const { r } = robot([watchReal]);
    const { m, record } = modes(defaultRecord('10.0.5.20', 80, '2026-10-01T00:00:00.000Z'));
    const button = 'Switch Cell 3 to Program and operate…';
    const { u, shown } = ui({ notice: () => button });
    await settleMode(r, m, u);
    await settled();
    assert.deepEqual(record(), { ...defaultRecord('10.0.5.20', 80, '2026-10-01T00:00:00.000Z'), ctrlClass: 'real' });
    assert.equal(shown[0].kind, 'notice');
    assert.equal(shown[0].message, 'Cell 3 reports itself as a real controller, so RAPID Live is watch-only on it. It reads and sends no writes.');
    assert.deepEqual(shown[0].buttons, [button, KEEP_WATCHING]);
    assert.deepEqual(shown.slice(1), [{ kind: 'badge' }, { kind: 'switch', id: 'r1' }]);
    // Keep watching, or closing the notice, runs nothing.
    const kept = ui({ notice: () => KEEP_WATCHING });
    const again = modes(defaultRecord('10.0.5.20', 80));
    await settleMode(robot([watchReal]).r, again.m, kept.u);
    await settled();
    assert.deepEqual(kept.shown.map(s => s.kind), ['notice', 'badge']);
  });

  it('a robot saved before 1.5.0 on a virtual controller gets its class recorded with no notice', async () => {
    const { r } = robot([operateVirtual]);
    const { m, record } = modes(defaultRecord('10.0.5.20', 80, '2026-10-01T00:00:00.000Z'));
    const { u, shown } = ui();
    await settleMode(r, m, u);
    assert.equal(record()?.ctrlClass, 'virtual');
    assert.equal(record()?.mode, 'auto');
    assert.deepEqual(shown, [{ kind: 'badge' }]);
  });

  it('a real controller with no answer on record is asked once: the answer is recorded as chosen, a closed question as watch, dismissed', async () => {
    const { m, record } = modes();
    const chosen = ui({ modal: (_m, buttons) => buttons[1] });
    await settleMode(robot([watchReal]).r, m, chosen.u);
    assert.equal(chosen.shown[0].kind, 'modal');
    assert.deepEqual(chosen.shown[0].buttons, ['Watch only', 'Program and operate on Cell 3']);
    assert.equal(chosen.shown[0].message, 'How should RAPID Live treat Cell 3 (10.0.5.20:80)?');
    const rec = record();
    assert.ok(rec && rec.mode === 'operate' && rec.by === 'chosen' && rec.ctrlClass === 'real' && rec.host === '10.0.5.20' && rec.port === 80);
    assert.deepEqual(chosen.log, ['"Cell 3": mode operate (chosen; the controller is real)']);
    assert.deepEqual(chosen.shown.map(s => s.kind), ['modal', 'badge']);

    const closed = ui({ modal: () => undefined });
    const fresh = modes();
    await settleMode(robot([watchReal]).r, fresh.m, closed.u);
    const dismissed = fresh.record();
    assert.ok(dismissed && dismissed.mode === 'watch' && dismissed.by === 'dismissed');
    assert.deepEqual(closed.log, ['"Cell 3": mode watch (the question was dismissed; the controller is real)']);
  });

  it('a robot with an answer on record, or an operating one, is asked nothing', async () => {
    const { m } = modes(answerRecord('watch', 'chosen', 'real', '10.0.5.20', 80));
    const { u, shown } = ui({ modal: () => { throw new Error('no question'); } });
    await settleMode(robot([watchNoAsk]).r, m, u);
    await settleMode(robot([operateVirtual]).r, m, u);
    assert.deepEqual(shown, []);
  });
});

describe('Set Robot Mode (review finding 19)', () => {
  it('to Program and operate: a robot whose type is not read is refused with a warning; one operating already says so', async () => {
    const { m, record } = modes();
    const { u, shown } = ui();
    await setRobotMode(robot([notRead]).r, 'operate', m, u);
    assert.deepEqual(shown, [{ kind: 'warn', message: 'Set Robot Mode on Cell 3 (10.0.5.20:80): connect it first. RAPID Live binds the answer to what the controller reports itself as.' }]);
    assert.equal(record(), undefined);
    const already = ui();
    await setRobotMode(robot([operateVirtual]).r, 'operate', m, already.u);
    assert.deepEqual(already.shown, [{ kind: 'info', message: 'Cell 3 is in Program and operate already.' }]);
  });

  it('to Program and operate: the modal question, then the record bound to the class, host and port; a closed question records nothing', async () => {
    const { m, record } = modes();
    const { u, shown } = ui({ modal: (_m, buttons) => buttons[0] });
    await setRobotMode(robot([watchNoAsk]).r, 'operate', m, u);
    assert.equal(shown[0].kind, 'modal');
    assert.match(shown[0].message as string, /Cell 3/);
    const rec = record();
    assert.ok(rec && rec.mode === 'operate' && rec.by === 'chosen' && rec.ctrlClass === 'real' && rec.host === '10.0.5.20' && rec.port === 80);
    assert.deepEqual(shown.slice(1), [{ kind: 'info', message: 'Program and operate on Cell 3: writes are sent after a confirmation that names the robot and the task.' }, { kind: 'badge' }]);
    const closed = ui({ modal: () => undefined });
    const fresh = modes();
    await setRobotMode(robot([watchNoAsk]).r, 'operate', fresh.m, closed.u);
    assert.equal(fresh.record(), undefined);
    assert.deepEqual(closed.shown.map(s => s.kind), ['modal']);
  });

  it('to Watch only on a connected RobotWare 8 robot: motion control withdrawn and the locks released, then the record, and the message names both', async () => {
    const { r, calls } = robot([operateVirtual], { motion: true });
    const { m, record } = modes(answerRecord('operate', 'chosen', 'virtual', '10.0.5.20', 80));
    const { u, shown } = ui({ modal: (_m, buttons) => buttons[0] });
    await setRobotMode(r, 'watch', m, u);
    assert.deepEqual(calls, ['withdraw', 'release']);
    const rec = record();
    assert.ok(rec && rec.mode === 'watch' && rec.by === 'chosen' && rec.ctrlClass === 'virtual');
    assert.deepEqual(shown.slice(1), [{ kind: 'info', message: 'Watch only on Cell 3: RAPID Live reads and sends no writes. First motion control withdrawn, its locks released.' }, { kind: 'badge' }]);
  });

  it('to Watch only: nothing to release is logged, not shown; a disconnected robot gives up nothing; the type not read records the class as unknown', async () => {
    const held = robot([operateVirtual], { releaseFails: true });
    const { m, record } = modes();
    const { u, shown, log } = ui({ modal: (_m, buttons) => buttons[0] });
    await setRobotMode(held.r, 'watch', m, u);
    assert.deepEqual(held.calls, ['release']);
    assert.deepEqual(log, ['"Cell 3": nothing to release before Watch only (nothing held)']);
    assert.deepEqual(shown.slice(1), [{ kind: 'info', message: 'Watch only on Cell 3: RAPID Live reads and sends no writes.' }, { kind: 'badge' }]);
    const offline = robot([notRead], { connected: false, motion: true });
    await setRobotMode(offline.r, 'watch', m, ui({ modal: (_m, buttons) => buttons[0] }).u);
    assert.deepEqual(offline.calls, []);
    assert.equal(record()?.ctrlClass, 'unknown');
    assert.equal(record()?.mode, 'watch');
  });

  it('to Watch only: a closed question changes nothing and gives nothing up', async () => {
    const { r, calls } = robot([operateVirtual], { motion: true });
    const { m, record } = modes();
    await setRobotMode(r, 'watch', m, ui({ modal: () => undefined }).u);
    assert.deepEqual(calls, []);
    assert.equal(record(), undefined);
  });

  it('with no mode named, the switch goes to the other mode than the robot\'s now', async () => {
    const { m } = modes();
    const toOperate = ui({ modal: (_m, buttons) => buttons[0] });
    await setRobotMode(robot([watchNoAsk]).r, undefined, m, toOperate.u);
    assert.equal(m.get('r1')?.mode, 'operate');
    const toWatch = ui({ modal: (_m, buttons) => buttons[0] });
    await setRobotMode(robot([operateVirtual]).r, undefined, m, toWatch.u);
    assert.equal(m.get('r1')?.mode, 'watch');
  });

  it('the extension runs both flows through one robot adapter and one window; the lock release is a reducing send', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.match(src, /const modeRobotOf = \(entry: RobotEntry\): ModeRobot => \(\{/);
    assert.match(src, /releaseLocks: async \(\) => \{\s*const out = await sendReducingTo\(entry, \{ label: 'Release own locks', exemptFromWatchOnly: true \}, \(\) => entry\.manager\.releaseMastershipAll\(\)\);/);
    assert.match(src, /motionAllowedHere: \(\) => generationOf\(entry\.manager\.state\) === 'rw8' && motionTracker\.allowedHere\(entry\.id\)/);
    assert.match(src, /const settleMode = async \(id: string\): Promise<void> => \{[\s\S]*?await settleRobotMode\(modeRobotOf\(entry\), robotModes, modeUi\);/);
    const start = src.indexOf("tracedCommand('abbRobot.setRobotMode'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.match(body, /await setRobotMode\(modeRobotOf\(target\), want, robotModes, modeUi\);/);
    assert.doesNotMatch(body, /robotModes\.set\(/);
  });
});
