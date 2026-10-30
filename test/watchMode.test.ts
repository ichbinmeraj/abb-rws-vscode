import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MODE_KEY, RobotModes, answerRecord, askOnceText, ctrlClassOf, defaultRecord, effectiveMode, firstConnectNotice, modeBadge,
  switchToOperateText, switchToWatchText, watchOnlyRefusal, type ModeRecord, type ModeState, type ModeVerdict,
} from '../src/watchMode';
import { sendConfirmed, sendReducing, type ConfirmRequest, type ConfirmRobot, type GuardUi } from '../src/confirm';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const cell: ConfirmRobot = { name: 'Cell 3', host: '10.0.5.20', port: 80, reportedName: 'Cell 3' };

const at = '2026-10-30T12:00:00.000Z';
const state = (type: string | null | undefined, over: Partial<ModeState> = {}): ModeState =>
  ({ connected: true, identity: type === undefined ? null : { type }, host: '10.0.5.20', port: 80, ...over });

describe('the class of a controller, from its own ctrl-type', () => {
  it('virtual on both wire forms, real for any other type, unknown for none', () => {
    assert.equal(ctrlClassOf('Virtual Controller'), 'virtual');
    assert.equal(ctrlClassOf('VIRTUAL_CONTROLLER'), 'virtual');
    assert.equal(ctrlClassOf('Real Controller'), 'real');
    assert.equal(ctrlClassOf('REAL_CONTROLLER'), 'real');
    assert.equal(ctrlClassOf('something new'), 'real');
    assert.equal(ctrlClassOf(''), 'unknown');
    assert.equal(ctrlClassOf('  '), 'unknown');
    assert.equal(ctrlClassOf(null), 'unknown');
    assert.equal(ctrlClassOf(undefined), 'unknown');
  });
});

describe('the mode rule', () => {
  const auto = defaultRecord('10.0.5.20', 80, at);
  const operateReal = answerRecord('operate', 'chosen', 'real', '10.0.5.20', 80, at);
  const watchChosen = answerRecord('watch', 'chosen', 'real', '10.0.5.20', 80, at);
  const watchDismissed = answerRecord('watch', 'dismissed', 'real', '10.0.5.20', 80, at);

  it('not connected, or the identity not read yet: watch only, no ask', () => {
    for (const record of [undefined, auto, operateReal]) {
      assert.deepEqual(effectiveMode(record, state('Virtual Controller', { connected: false })), { mode: 'watch', reason: 'controller type not read', ctrlClass: 'not-read', askDue: false });
      assert.deepEqual(effectiveMode(record, state(undefined)), { mode: 'watch', reason: 'controller type not read', ctrlClass: 'not-read', askDue: false });
    }
  });

  it('a saved Watch only stands whatever the controller says', () => {
    assert.deepEqual(effectiveMode(watchChosen, state('Virtual Controller')), { mode: 'watch', reason: 'chosen', ctrlClass: 'virtual', askDue: false });
    assert.deepEqual(effectiveMode(watchDismissed, state('Real Controller')), { mode: 'watch', reason: 'dismissed', ctrlClass: 'real', askDue: false });
  });

  it('a virtual controller is operated with no record, an auto record or an operate record', () => {
    for (const record of [undefined, auto, operateReal]) {
      assert.deepEqual(effectiveMode(record, state('Virtual Controller')), { mode: 'operate', ctrlClass: 'virtual' });
    }
  });

  it('auto on a real or unknown controller is watched, with no ask (Add Robot saved it)', () => {
    assert.deepEqual(effectiveMode(auto, state('Real Controller')), { mode: 'watch', reason: 'real controller', ctrlClass: 'real', askDue: false });
    assert.deepEqual(effectiveMode(auto, state('')), { mode: 'watch', reason: 'unknown controller', ctrlClass: 'unknown', askDue: false });
  });

  it('operate on a real controller counts while the class, host and port are the ones answered for', () => {
    assert.deepEqual(effectiveMode(operateReal, state('Real Controller')), { mode: 'operate', ctrlClass: 'real' });
    const moved = state('Real Controller', { host: '10.0.5.21' });
    assert.deepEqual(effectiveMode(operateReal, moved), { mode: 'watch', reason: 'record no longer matches', ctrlClass: 'real', askDue: true });
    const otherPort = state('Real Controller', { port: 443 });
    assert.equal(effectiveMode(operateReal, otherPort).mode, 'watch');
    const nowUnknown = state('');
    assert.deepEqual(effectiveMode(operateReal, nowUnknown), { mode: 'watch', reason: 'record no longer matches', ctrlClass: 'unknown', askDue: true });
  });

  it('no record on a real or unknown controller is watched, and the ask is due', () => {
    assert.deepEqual(effectiveMode(undefined, state('Real Controller')), { mode: 'watch', reason: 'real controller', ctrlClass: 'real', askDue: true });
    assert.deepEqual(effectiveMode(undefined, state('')), { mode: 'watch', reason: 'unknown controller', ctrlClass: 'unknown', askDue: true });
  });

  it('a tunnelled real controller at 127.0.0.1 is still real: the signal is the type, not the address', () => {
    assert.equal(effectiveMode(undefined, state('Real Controller', { host: '127.0.0.1' })).mode, 'watch');
  });
});

describe('the records', () => {
  function store() {
    const data = new Map<string, unknown>();
    return {
      get: <T,>(key: string, def: T): T => (data.has(key) ? data.get(key) as T : def),
      update: async (key: string, value: unknown) => { data.set(key, value); },
      data,
    };
  }

  it('Add Robot writes auto with nothing known; an answer is bound to class and address; Remove Robot forgets', async () => {
    const s = store();
    const modes = new RobotModes(s);
    assert.equal(modes.get('r1'), undefined);
    await modes.set('r1', defaultRecord('10.0.5.20', 80, at));
    assert.deepEqual(modes.get('r1'), { mode: 'auto', ctrlClass: 'unknown', host: '10.0.5.20', port: 80, by: 'default', at });
    await modes.set('r2', answerRecord('operate', 'chosen', 'real', '10.0.5.21', undefined, at));
    assert.deepEqual(modes.get('r2'), { mode: 'operate', ctrlClass: 'real', host: '10.0.5.21', port: undefined, by: 'chosen', at });
    assert.deepEqual(Object.keys(s.data.get(MODE_KEY) as object).sort(), ['r1', 'r2']);
    await modes.forget('r1');
    assert.equal(modes.get('r1'), undefined);
    assert.ok(modes.get('r2'));
    await modes.forget('r1');
    assert.equal(MODE_KEY, 'abbRobot.robotMode.v1');
  });

  it('a re-pointed robot asks again: the old operate answer no longer matches', () => {
    const record: ModeRecord = answerRecord('operate', 'chosen', 'virtual', '127.0.0.1', 80, at);
    // The same entry now answers as a real controller at the same address.
    assert.deepEqual(effectiveMode(record, state('Real Controller', { host: '127.0.0.1', port: 80 })), { mode: 'watch', reason: 'record no longer matches', ctrlClass: 'real', askDue: true });
  });
});

describe('the refusal inside the wrappers', () => {
  function ui(verdict: ModeVerdict) {
    const shown: Array<Record<string, unknown>> = [];
    const refuse = (label: string, robot: ConfirmRobot): string | undefined =>
      verdict.mode === 'watch' ? watchOnlyRefusal(label, robot, verdict.reason) : undefined;
    const u: GuardUi = {
      modal: async () => { throw new Error('no dialog in watch-only'); },
      input: async () => { throw new Error('no box in watch-only'); },
      warn: message => { shown.push({ kind: 'warn', message }); },
      log: () => {},
      refuse,
    };
    return { u, shown };
  }
  const watched: ModeVerdict = { mode: 'watch', reason: 'real controller', ctrlClass: 'real', askDue: true };

  it('every tier: the send never runs, no modal and no box, the message is the refusal sentence', async () => {
    for (const tier of ['motion', 'disruptive', 'change', 'declaration'] as const) {
      const { u, shown } = ui(watched);
      let sent = 0;
      const request: ConfirmRequest = { label: 'Write user.reg1', tier, taskApplies: true, task: 'T_ROB1', sideEffects: ['x'] };
      const out = await sendConfirmed(u, cell, request, async () => { sent++; });
      assert.deepEqual(out, { sent: false, why: 'watch-only' }, tier);
      assert.equal(sent, 0);
      assert.deepEqual(shown, [{ kind: 'warn', message: 'Write user.reg1 not sent: Cell 3 (10.0.5.20:80) is watch-only. RAPID Live reads from it and sends no writes.' }]);
    }
  });

  it('Stop RAPID and Motors Off are refused too (decision 1); a withdrawal and the lock release still go', async () => {
    const { u, shown } = ui(watched);
    let sent = 0;
    assert.deepEqual(await sendReducing(u, cell, { label: 'Stop RAPID' }, async () => { sent++; }), { sent: false, why: 'watch-only' });
    assert.deepEqual(await sendReducing(u, cell, { label: 'Motors Off' }, async () => { sent++; }), { sent: false, why: 'watch-only' });
    assert.equal(sent, 0);
    assert.equal(shown.length, 2);
    assert.deepEqual(await sendReducing(u, cell, { label: 'Withdraw Motion Control', exemptFromWatchOnly: true }, async () => { sent++; }), { sent: true, value: undefined });
    assert.deepEqual(await sendReducing(u, cell, { label: 'Release own locks', exemptFromWatchOnly: true }, async () => { sent++; }), { sent: true, value: undefined });
    assert.equal(sent, 2);
  });

  it('a repeat jog is refused as well', async () => {
    const { u } = ui(watched);
    let sent = 0;
    const jog: ConfirmRequest = { label: 'Jog', tier: 'motion', taskApplies: false, skipAsk: 'jog-repeat', sideEffects: ['x'] };
    assert.deepEqual(await sendConfirmed(u, cell, jog, async () => { sent++; }), { sent: false, why: 'watch-only' });
    assert.equal(sent, 0);
  });

  it('the not-read reason says so', () => {
    assert.equal(watchOnlyRefusal('Start RAPID', cell, 'controller type not read'),
      'Start RAPID not sent: Cell 3 (10.0.5.20:80) is watch-only. RAPID Live has not read what kind of controller this is yet.');
  });

  it('in Program and operate the hook returns nothing and the write goes on', async () => {
    const { u } = ui({ mode: 'operate', ctrlClass: 'virtual' });
    let sent = 0;
    assert.deepEqual(await sendReducing(u, cell, { label: 'Stop RAPID' }, async () => { sent++; }), { sent: true, value: undefined });
    assert.equal(sent, 1);
  });
});

describe('the texts', () => {
  it('the ask names the robot, says what it reports, and offers the two modes with no preselected answer', () => {
    const t = askOnceText(cell, 'real');
    assert.equal(t.message, 'How should RAPID Live treat Cell 3 (10.0.5.20:80)?');
    assert.match(t.detail, /^Cell 3 reports itself as a real controller\. RAPID Live used to send writes to every robot after a confirmation\. From 1\.5\.0 a real controller is watch-only until you choose\.\n• Watch only: RAPID Live reads and sends no writes\. Pull All Modules, Diff Current File with Controller and Open Loaded Module Source still save a temporary copy to the controller's TEMP volume and delete it\.\n• Program and operate: writes are sent after a confirmation that names the robot and the task\.$/);
    assert.equal(t.watch, 'Watch only');
    assert.equal(t.operate, 'Program and operate on Cell 3');
    assert.match(askOnceText(cell, 'unknown').detail, /^Cell 3 does not say what kind of controller it is\./);
  });

  it('the first-connect notice, the two switch dialogs and the badge', () => {
    assert.equal(firstConnectNotice(cell, 'real'), 'Cell 3 reports itself as a real controller, so RAPID Live is watch-only on it. It reads and sends no writes.');
    assert.equal(switchToOperateText(cell, 'real').button, 'Program and operate on Cell 3');
    assert.match(switchToOperateText(cell, 'not-read').detail, /has not been read yet \(connect it first\)/);
    assert.equal(switchToWatchText(cell).button, 'Watch only on Cell 3');
    assert.match(switchToWatchText(cell).detail, /withdraws the RobotWare 8 motion control and releases the locks it holds/);
    const operateReal = modeBadge({ mode: 'operate', ctrlClass: 'real' });
    assert.equal(operateReal.text, '$(tools) Program and operate');
    assert.equal(operateReal.warning, true);
    assert.equal(modeBadge({ mode: 'operate', ctrlClass: 'virtual' }).warning, false);
    const watch = modeBadge({ mode: 'watch', reason: 'dismissed', ctrlClass: 'real', askDue: false });
    assert.equal(watch.text, '$(eye) Watch only');
    assert.equal(watch.description, 'watch only');
    assert.match(watch.tooltip, /the question was dismissed/);
    assert.match(watch.tooltip, /TEMP volume/);
  });
});

describe('the extension wires the mode into every send', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

  it('each adapter builds its window per robot with the refusal hook, and nothing uses the bare window for a send', () => {
    assert.match(src, /function guardUiFor\(entry: RobotEntry\): GuardUi \{/);
    // The bare window is not a GuardUi (its refuse is required, review finding 18): only guardUiFor makes one.
    assert.match(src, /const guardBase: ConfirmUi & Pick<GuardUi, 'log'> = /);
    assert.doesNotMatch(src, /const guardUi\b/);
    for (const adapter of ['sendTo', 'sendMotion', 'sendReducingTo']) {
      const start = src.indexOf(`function ${adapter}<T>(`);
      assert.ok(start > 0, adapter);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      assert.match(body, /guardUiFor\(entry\)/, adapter);
      assert.doesNotMatch(body, /\bguardUi\b[^F]/, `${adapter} uses the per-robot window`);
    }
    assert.match(src, /guard: \{ uiFor: guardUiFor, robotOf: confirmRobotOf \}/);
    assert.match(src, /function motionUiFor\(entry: RobotEntry\): MotionUi \{\s*return \{\s*\.\.\.guardUiFor\(entry\),/);
  });

  it('the refusal hook reads the live mode of that robot and shows the sentence with the switch button', () => {
    assert.match(src, /refuse: label => \{\s*if \(unverifiedPorts\.has\(entry\.id\)\) \{ return unverifiedWriteRefusal\(label, robotLabel\(confirmRobotOf\(entry\)\)\); \}\s*const verdict = modeOf\(entry\);\s*return verdict\.mode === 'watch' \? watchOnlyRefusal\(label, confirmRobotOf\(entry\), verdict\.reason\) : undefined;/);
    assert.match(src, /showRefusal: sentence => \{ showWatchOnlyRefusal\(entry, sentence\); \}/);
  });

  it('Add Robot writes the auto record, Remove Robot forgets it, and the connect settles the mode', () => {
    assert.match(src, /robotModes\.set\(config\.id, defaultRecord\(config\.host, config\.port\)\)/);
    assert.match(src, /await robotModes\.forget\(id\)/);
    assert.match(src, /case 'save':\s*case 'done':[\s\S]*?await settleMode\(id\);/);
  });

  it('Set Robot Mode is a command, in the palette and on every robot row, and the status bar item clicks it', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }>; menus: Record<string, Array<{ command: string; when?: string }>> } };
    assert.ok(manifest.contributes.commands.some(c => c.command === 'abbRobot.setRobotMode' && c.title === 'Set Robot Mode (Watch only / Program and operate)…'));
    const row = manifest.contributes.menus['view/item/context'].find(m => m.command === 'abbRobot.setRobotMode');
    assert.ok(row && /viewItem =~ \/\^robot\\\.\(connected\|disconnected\)\//.test(row.when ?? ''));
    // The command resolves the robot and hands the flow to src/modeFlow.ts (test/modeFlow.test.ts runs it against stubs).
    assert.match(src, /tracedCommand\('abbRobot\.setRobotMode', async \(arg\?: unknown, targetMode\?: unknown\) => \{[\s\S]*?await setRobotMode\(modeRobotOf\(target\), want, robotModes, modeUi\);/);
    assert.match(src, /sbWatch\.command\s*=\s*\{ title: 'Set Robot Mode', command: 'abbRobot\.setRobotMode', arguments: \[multi\.activeId\] \}/);
  });
});
