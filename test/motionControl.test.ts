import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RwsError, type AccessEvent, type LocalStationStatus, type RefusalRemedy } from 'abb-rws-client';
import type { ConfirmRobot } from '../src/confirm';
import { FIXED_STATION_NEXT_STEP } from '../src/refusalUi';
import {
  ALLOW_FIRST_BUTTON, ALLOW_FIRST_HINT, MOTION_CONTROL_SWITCH, MotionControlTracker, WITHDRAW_BUTTON, allowFromRefusal, allowOriginOf, allowedMessage,
  confirmMotionWrite, disconnectMessage, fixedStation, hhmm, mayHaveBeenTaken, motionContextKeys, motionEntryOf, motionLine, motionLineOf, motionReading,
  noticeForEvent, rapidLiveLines, remoteWindow, robotsViewMotion, runAllow, runSwitchWithdraw, runWithdraw, sessionNow, sessionUnsettled, statusBarFor,
  statusIndicator, whenItEnds, withdrawCandidates, withdrawChoice, withdrawOnSwitch, withdrawPickItems,
  type AllowContext, type AllowOrigin, type MotionEntry, type MotionRobot, type MotionState, type MotionUi, type SessionNow,
} from '../src/motionControl';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

const cell: ConfirmRobot = { name: 'IRB1600_6_120', host: '127.0.0.1', port: 80, reportedName: 'IRB1600_6_120' };
const LABEL = 'IRB1600_6_120 (127.0.0.1:80)';

/** 14:02 today, local time, as the client records a set. */
const at1402 = new Date(2026, 9, 21, 14, 2, 30).toISOString();

type Behaviour = {
  set?: (allow: boolean) => Promise<void>;
  read?: () => Promise<boolean | null>;
  fp?: () => Promise<LocalStationStatus>;
  afterRefresh?: string;
};

/** A robot double: records each call; the state follows a set or read as the client's does. */
function fakeRobot(over: { gen?: 'rw6' | 'rw7' | 'rw8' | null; allowed?: boolean | null; connected?: boolean; virtual?: boolean;
  controlStation?: unknown; identity?: 'option' | 'explicit' | 'default' | null; execstate?: string } = {}, b: Behaviour = {}) {
  const calls: string[] = [];
  const state: MotionState = {
    connected: over.connected ?? true,
    execstate: over.execstate ?? 'stopped',
    identity: { type: over.virtual === false ? 'Real Controller' : 'Virtual Controller' },
    access: {
      generation: over.gen === undefined ? 'rw8' : over.gen,
      rw8: (over.gen ?? 'rw8') === 'rw8'
        ? { registered: true, identity: over.identity ?? 'default', allowMotionControl: over.allowed === undefined ? false : over.allowed, allowMotionControlSince: null }
        : null,
    },
  };
  const rw8 = () => state.access!.rw8!;
  const robot: MotionRobot = {
    id: 'r1',
    config: { name: cell.name, ...(over.controlStation !== undefined ? { controlStation: over.controlStation } : {}) },
    manager: {
      state,
      setAllowMotionControl: async allow => {
        calls.push(`set ${allow}`);
        if (b.set) { await b.set(allow); }
        rw8().allowMotionControl = allow;
        rw8().allowMotionControlSince = allow ? at1402 : null;
      },
      getAllowMotionControl: async () => {
        calls.push('read');
        if (b.read) { const v = await b.read(); rw8().allowMotionControl = v; return v; }
        return rw8().allowMotionControl;
      },
      getLocalStationStatus: async () => {
        calls.push('fp');
        return b.fp ? b.fp() : { flexPendantConnected: true, safetyProtocolConnected: true };
      },
      refresh: async () => { calls.push('refresh'); if (b.afterRefresh) { state.execstate = b.afterRefresh; } },
    },
  };
  return { robot, calls, state };
}

/** A window double that records every dialog and answers from a script. */
function fakeUi(answers: { modal?: (message: string, detail: string, buttons: string[]) => string | undefined; input?: (title: string, prompt: string) => string | undefined; ask?: (message: string, buttons: string[]) => string | undefined } = {}) {
  const shown: Array<Record<string, unknown>> = [];
  const ui: MotionUi = {
    modal: async (message, detail, buttons) => { shown.push({ kind: 'modal', message, detail, buttons }); return answers.modal?.(message, detail, buttons); },
    input: async (title, prompt, placeHolder) => { shown.push({ kind: 'input', title, prompt, placeHolder }); return answers.input?.(title, prompt); },
    warn: message => { shown.push({ kind: 'warn', message }); },
    info: message => { shown.push({ kind: 'info', message }); },
    ask: async (message, buttons) => { shown.push({ kind: 'ask', message, buttons }); return answers.ask?.(message, buttons); },
    refused: (label, e) => { shown.push({ kind: 'refused', label, error: (e as Error).message }); },
  };
  return { ui, shown };
}

/** The answers of a person who confirms both stops and types the right name. */
const confirms = { modal: (_m: string, _d: string, b: string[]) => b[0], input: () => cell.name };

function context(ui: MotionUi, over: Partial<AllowContext> = {}) {
  const log: string[] = [];
  const done: string[] = [];
  const tracker = new MotionControlTracker();
  const ctx: AllowContext = {
    ui, robot: cell, tracker, remote: null,
    isActive: () => true,
    forgetJogConfirmation: () => { done.push('forget-jog'); },
    withdraw: async () => { done.push('withdraw'); },
    disconnect: async () => { done.push('disconnect'); },
    log: m => { log.push(m); },
    ...over,
  };
  return { ctx, tracker, done, log };
}

const tick = () => new Promise(r => setImmediate(r));

describe('Allow Motion Control: nothing is sent unless the person confirms', () => {
  it('Cancel at the modal sends nothing and asks for no name', async () => {
    const { robot, calls } = fakeRobot();
    const { ui, shown } = fakeUi({ modal: () => undefined, input: () => { throw new Error('not asked'); } });
    assert.equal(await runAllow(robot, 'palette', context(ui).ctx), 'not-sent');
    assert.deepEqual(calls, ['fp']);
    assert.deepEqual(shown.map(s => s.kind), ['modal']);
  });

  it('a dismissed name box sends nothing, quietly', async () => {
    const { robot, calls } = fakeRobot();
    const { ui, shown } = fakeUi({ modal: (_m, _d, b) => b[0], input: () => undefined });
    assert.equal(await runAllow(robot, 'palette', context(ui).ctx), 'not-sent');
    assert.ok(!calls.some(c => c.startsWith('set')));
    assert.deepEqual(shown.map(s => s.kind), ['modal', 'input']);
  });

  it('a wrong name sends nothing and says so', async () => {
    for (const typed of ['IRB1600', 'irb1600_6_120', '']) {
      const { robot, calls } = fakeRobot();
      const { ui, shown } = fakeUi({ modal: (_m, _d, b) => b[0], input: () => typed });
      assert.equal(await runAllow(robot, 'palette', context(ui).ctx), 'not-sent', typed);
      assert.ok(!calls.some(c => c.startsWith('set')), typed);
      assert.deepEqual(shown[2], { kind: 'warn', message: `Allow Motion Control not sent to IRB1600_6_120: "${typed}" is not its name.` });
    }
  });

  it('the right name sends exactly one setAllowMotionControl(true), on the robot given, then reads it back', async () => {
    const { robot, calls } = fakeRobot();
    const { ui, shown } = fakeUi(confirms);
    const { ctx, tracker, done } = context(ui);
    assert.equal(await runAllow(robot, 'palette', ctx), 'allowed');
    assert.deepEqual(calls, ['fp', 'set true', 'read']);
    assert.equal(tracker.allowedHere('r1'), true);
    // The jog asks again on the next jog.
    assert.deepEqual(done, ['forget-jog']);
    assert.deepEqual(shown.at(-1), { kind: 'info', message: `Motion control allowed on ${LABEL}.` });
  });

  it('refuses before any dialog: RobotWare 6 or 7, not connected, already allowed from the palette, not the active robot, a fixed control station', async () => {
    const cases: Array<{ robot: ReturnType<typeof fakeRobot>; active?: boolean; message: string; kind?: string }> = [
      { robot: fakeRobot({ gen: 'rw6' }), message: 'RobotWare 6 and 7 have no Allow Motion Control. Nothing was sent.' },
      { robot: fakeRobot({ gen: 'rw7' }), message: 'RobotWare 6 and 7 have no Allow Motion Control. Nothing was sent.' },
      { robot: fakeRobot({ connected: false }), message: 'Connect first.' },
      { robot: fakeRobot({ allowed: true }), message: `Motion control is already allowed on ${LABEL}.`, kind: 'info' },
      { robot: fakeRobot(), active: false, message: 'IRB1600_6_120 is not the active robot. Switch to it first, then allow motion control.' },
      { robot: fakeRobot({ controlStation: { name: 'cell', id: 'x' } }),
        message: 'IRB1600_6_120 is set to register as a fixed control station (`controlStation` in its settings). '
          + 'Motion control allowed from it could then count in other windows or on other computers with the same setting. '
          + 'Remove that setting to allow motion control from RAPID Live. Nothing was sent.' },
      { robot: fakeRobot({ identity: 'option' }),
        message: 'IRB1600_6_120 is set to register as a fixed control station (`controlStation` in its settings). '
          + 'Motion control allowed from it could then count in other windows or on other computers with the same setting. '
          + 'Remove that setting to allow motion control from RAPID Live. Nothing was sent.' },
    ];
    for (const c of cases) {
      const { ui, shown } = fakeUi({ modal: () => { throw new Error('no dialog'); } });
      const out = await runAllow(c.robot.robot, 'palette', context(ui, { isActive: () => c.active ?? true }).ctx);
      assert.ok(out === 'not-sent' || out === 'already-allowed', c.message);
      assert.deepEqual(c.robot.calls, [], c.message);
      assert.deepEqual(shown, [{ kind: c.kind ?? 'warn', message: c.message }]);
    }
  });

  it('from a refusal: one read before the dialog; a read of true sends nothing and asks for the log', async () => {
    for (const [origin, what, where] of [['run-routine', 'the start', 'Start'], ['start-rapid', 'the start', 'Start'], ['jog', 'the jog', 'Jog']] as const) {
      const { robot, calls } = fakeRobot({ allowed: false }, { read: async () => true });
      const { ui, shown } = fakeUi({ modal: () => { throw new Error('no dialog'); } });
      assert.equal(await runAllow(robot, origin, context(ui).ctx), 'not-sent');
      assert.deepEqual(calls, ['read']);
      assert.deepEqual(shown, [{ kind: 'warn', message: `${LABEL} refused ${what} for motion control, but reads it as allowed. Nothing was sent. `
        + `${where} from the FlexPendant, and send us the extension log (\`~/.abb-rws-extension/logs\`).` }]);
    }
  });

  it('from a refusal that still reads false: the read, then the dialog, the set and the read back', async () => {
    const { robot, calls } = fakeRobot({ allowed: false });
    const { ui, shown } = fakeUi(confirms);
    assert.equal(await runAllow(robot, 'run-routine', context(ui).ctx), 'allowed');
    assert.deepEqual(calls, ['read', 'fp', 'set true', 'read']);
    assert.deepEqual(shown.at(-1), { kind: 'info', message: `Motion control allowed on ${LABEL}. Click ▶ Run this routine again. It asks you to confirm, as before.` });
  });

  it('from a start confirmation: a read of true goes back to the confirmation, with no message', async () => {
    const { robot, calls } = fakeRobot({ allowed: null }, { read: async () => true });
    const { ui, shown } = fakeUi();
    assert.equal(await runAllow(robot, 'start-confirmation', context(ui).ctx), 'already-allowed');
    assert.deepEqual(calls, ['read']);
    assert.deepEqual(shown, []);
  });

  it('the message after allowing names what was clicked; nothing is run again', () => {
    const msg = (o: AllowOrigin) => allowedMessage(LABEL, o);
    assert.equal(msg('run-routine'), `Motion control allowed on ${LABEL}. Click ▶ Run this routine again. It asks you to confirm, as before.`);
    assert.equal(msg('start-rapid'), `Motion control allowed on ${LABEL}. Start RAPID again. It asks you to confirm, as before.`);
    assert.equal(msg('jog'), `Motion control allowed on ${LABEL}. Jog again. It asks you to confirm first.`);
    assert.equal(msg('palette'), `Motion control allowed on ${LABEL}.`);
    assert.equal(msg('refusal'), `Motion control allowed on ${LABEL}. Run the refused command again. It asks you to confirm, as before.`);
    assert.equal(msg('start-confirmation'), null);
    assert.equal(allowOriginOf('Run routine'), 'run-routine');
    assert.equal(allowOriginOf('Starting RAPID'), 'start-rapid');
    assert.equal(allowOriginOf('Jog'), 'jog');
    assert.equal(allowOriginOf('Set PP'), 'refusal');
  });

  it('a set with no answer and a failed read: the warning offers Withdraw and Disconnect; the robot counts as allowed here', async () => {
    const noAnswer = Object.assign(new Error('no answer within 3000 ms'), { code: 'NETWORK_ERROR' });
    const { robot, calls } = fakeRobot({}, { set: async () => { throw noAnswer; }, read: async () => { throw noAnswer; } });
    const { ui, shown } = fakeUi({ ...confirms, ask: () => WITHDRAW_BUTTON });
    const { ctx, tracker, done } = context(ui);
    assert.equal(await runAllow(robot, 'palette', ctx), 'unknown');
    assert.deepEqual(calls, ['fp', 'set true', 'read']);
    assert.equal(tracker.allowedHere('r1'), true);
    assert.deepEqual(shown.at(-1), { kind: 'ask', message: `Whether ${LABEL} allowed motion control is not known: the controller did not answer.`,
      buttons: ['Withdraw', 'Disconnect IRB1600_6_120'] });
    await tick();
    // The controller may have taken it: the next jog asks again, then the button's withdrawal.
    assert.deepEqual(done, ['forget-jog', 'withdraw']);
  });

  it('a set with no answer stays not known even when a read says false: the controller may still take it', async () => {
    const noAnswer = Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' });
    const { robot } = fakeRobot({}, { set: async () => { throw noAnswer; }, read: async () => false });
    const { ui, shown } = fakeUi({ ...confirms, ask: () => 'Disconnect IRB1600_6_120' });
    const { ctx, done } = context(ui);
    assert.equal(await runAllow(robot, 'palette', ctx), 'unknown');
    assert.equal(shown.at(-1)?.kind, 'ask');
    await tick();
    assert.deepEqual(done, ['forget-jog', 'disconnect']);
  });

  it('a jog confirmed earlier asks again after an Allow the controller did not answer', async () => {
    // Allow (answered), a jog confirmed, Withdraw, then an Allow with no answer: the
    // controller may have taken it, so the next jog must ask again.
    const jogConfirmed = new Map<string, number>([['r1', 1]]);
    const noAnswer = new RwsError('no answer within 3000 ms', 'NETWORK_ERROR');
    const { robot } = fakeRobot({}, { set: async () => { throw noAnswer; }, read: async () => { throw noAnswer; } });
    const { ui } = fakeUi({ ...confirms, ask: () => undefined });
    const { ctx } = context(ui, { forgetJogConfirmation: () => { jogConfirmed.delete('r1'); } });
    assert.equal(await runAllow(robot, 'palette', ctx), 'unknown');
    assert.equal(jogConfirmed.has('r1'), false);
  });

  it('an answer cut off mid-body (NETWORK_ERROR with an HTTP status) counts as possibly taken, as the client counts it', async () => {
    const cut = new RwsError('POST /rw/controlstation/allowmotioncontrol: response cut off mid-body (aborted)', 'NETWORK_ERROR', 200);
    const { robot } = fakeRobot({}, { set: async () => { throw cut; }, read: async () => { throw cut; } });
    const { ui, shown } = fakeUi({ ...confirms, ask: () => undefined });
    const { ctx, tracker, done } = context(ui);
    assert.equal(await runAllow(robot, 'palette', ctx), 'unknown');
    assert.equal(tracker.allowedHere('r1'), true);
    assert.deepEqual(done, ['forget-jog']);
    assert.equal(shown.at(-1)?.kind, 'ask');
    // The status bar then shows "not known", and a later failed withdrawal gives its notice.
    assert.equal(statusIndicator(cell.name, { allowed: null, since: null, registered: true }, tracker.allowedHere('r1'))?.text, '$(warning) Motion control: not known');
    assert.equal(tracker.onEvent('r1', 'withdraw-failed', { connected: true, quality: 'live' })?.level, 'warning');
  });

  it('mayHaveBeenTaken follows the client: anything that is not an RwsError, or a NETWORK_ERROR with or without a status', () => {
    assert.equal(mayHaveBeenTaken(new RwsError('x', 'NETWORK_ERROR')), true);
    assert.equal(mayHaveBeenTaken(new RwsError('x', 'NETWORK_ERROR', 200)), true);
    assert.equal(mayHaveBeenTaken(new RwsError('x', 'NETWORK_ERROR', 403)), true);
    assert.equal(mayHaveBeenTaken(new Error('a bug')), true);
    assert.equal(mayHaveBeenTaken('a string'), true);
    assert.equal(mayHaveBeenTaken(new RwsError('x', 'GRANT_DENIED', 403)), false);
    assert.equal(mayHaveBeenTaken(new RwsError('x', 'NOT_CONNECTED')), false);
    assert.equal(mayHaveBeenTaken(new RwsError('x', 'UNSUPPORTED_OPERATION')), false);
    // The client's own definition, which this follows.
    const core = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'dist', 'rws2', 'core.js'), 'utf8');
    assert.match(core, /static isUnanswered\(e\) \{\s*return !\(e instanceof RwsError\) \|\| e\.code === 'NETWORK_ERROR';\s*\}/,
      'the client changed what counts as no answer: update mayHaveBeenTaken');
  });

  it('a set with no answer whose read back says true: allowed here, and the texts say RAPID Live allowed it', async () => {
    const noAnswer = new RwsError('no answer within 3000 ms', 'NETWORK_ERROR');
    // The client clears the time when a set gets no answer; a read of true then leaves it unset.
    const { robot, state } = fakeRobot({}, { set: async () => { throw noAnswer; }, read: async () => true });
    const { ui, shown } = fakeUi(confirms);
    const { ctx, tracker, done } = context(ui);
    assert.equal(await runAllow(robot, 'palette', ctx), 'allowed');
    assert.deepEqual(done, ['forget-jog']);
    assert.deepEqual(shown.at(-1), { kind: 'info', message: `Motion control allowed on ${LABEL}.` });
    const reading = motionReading(state);
    assert.deepEqual(reading, { allowed: true, since: null, registered: true });
    const here = tracker.allowedHere('r1');
    assert.equal(here, true);
    assert.equal(statusIndicator(cell.name, reading, here)?.tooltip,
      'Motion control is allowed on IRB1600_6_120. RAPID Live allowed it on this connection, after you confirmed that an emergency stop and a normal stop are within your reach; '
      + "the time is not known. Withdrawing is not a stop: to stop the robot, use the FlexPendant's stops. Click to withdraw.");
    assert.equal(motionLine(reading, here)?.line,
      'Motion control allowed on this connection; the time is not known. You confirmed then that both stops are within your reach. '
      + 'If that is not so now, choose Cancel and withdraw it.');
    for (const text of [statusIndicator(cell.name, reading, here)?.tooltip, motionLine(reading, here)?.line]) {
      assert.doesNotMatch(text ?? '', /did not allow it/);
    }
  });

  it('a refused set shows the controller\'s refusal with its own remedy, and nothing more is sent', async () => {
    const refused = new RwsError('Remote access is not allowed', 'GRANT_DENIED', 403);
    const { robot, calls } = fakeRobot({}, { set: async () => { throw refused; } });
    const { ui, shown } = fakeUi(confirms);
    const { ctx, tracker, done } = context(ui);
    assert.equal(await runAllow(robot, 'palette', ctx), 'refused');
    assert.deepEqual(calls, ['fp', 'set true']);
    assert.deepEqual(shown.at(-1), { kind: 'refused', label: 'Allow Motion Control', error: 'Remote access is not allowed' });
    assert.equal(tracker.allowedHere('r1'), false);
    assert.deepEqual(done, []);
  });

  it('a set the client refuses before sending (a disconnect began) is shown as refused', async () => {
    const before = new RwsError('not connected', 'NOT_CONNECTED');
    const { robot } = fakeRobot({}, { set: async () => { throw before; } });
    const { ui, shown } = fakeUi(confirms);
    assert.equal(await runAllow(robot, 'palette', context(ui).ctx), 'refused');
    assert.equal(shown.at(-1)?.kind, 'refused');
  });

  it('a read back of false after a taken set: the warning, and the robot does not count as allowed here', async () => {
    const { robot } = fakeRobot({}, { read: async () => false });
    const { ui, shown } = fakeUi(confirms);
    const { ctx, tracker } = context(ui);
    assert.equal(await runAllow(robot, 'palette', ctx), 'read-false');
    assert.deepEqual(shown.at(-1), { kind: 'warn', message: `${LABEL} reads motion control as not allowed after RAPID Live allowed it. Nothing else was sent. `
      + 'Start from the FlexPendant, and send us the extension log (`~/.abb-rws-extension/logs`).' });
    assert.equal(tracker.allowedHere('r1'), false);
  });

  it('the robot switched away during the dialog: nothing is sent', async () => {
    const { robot, calls } = fakeRobot();
    let active = true;
    const { ui, shown } = fakeUi({ modal: (_m, _d, b) => b[0], input: () => { active = false; return cell.name; } });
    assert.equal(await runAllow(robot, 'palette', context(ui, { isActive: () => active }).ctx), 'not-sent');
    assert.ok(!calls.some(c => c.startsWith('set')));
    assert.deepEqual(shown.at(-1), { kind: 'warn', message: 'IRB1600_6_120 is no longer the active robot. Allow Motion Control was not sent.' });
  });
});

describe('the Allow confirmation: the client\'s lines, then RAPID Live\'s', () => {
  const allowDialog = async (over: Parameters<typeof fakeRobot>[0] = {}, fp: LocalStationStatus = { flexPendantConnected: true, safetyProtocolConnected: true },
    remote: ReturnType<typeof remoteWindow> = null) => {
    const { robot } = fakeRobot(over, { fp: async () => fp });
    const { ui, shown } = fakeUi({ modal: () => undefined });
    await runAllow(robot, 'palette', context(ui, { remote }).ctx);
    return shown[0] as { message: string; detail: string; buttons: string[] };
  };

  const C1 = 'You confirm that an emergency stop and a normal stop are within your reach, for every robot and axis IRB1600_6_120 moves. '
    + "IRB1600_6_120 takes this as this control station's confirmation that both stops are available (ABB, Control Station Service: Allow Motion Control).";
  const C2 = "A normal stop is the FlexPendant's Stop button held for more than 1 second, or a safe input set up for it. "
    + 'It is a category 1 stop and ends in guard stop (ABB, RobotWare 8 product specification).';
  const VC = "This is a virtual controller. RobotStudio's virtual FlexPendant stands in for its FlexPendant.";
  const FP = 'The FlexPendant reads as not connected. Its stops are not available.';
  const MOVES = 'Allowing it moves nothing by itself.';
  const R1 = 'Stop RAPID in RAPID Live is a program stop sent over the network. It is neither of these stops. '
    + 'Neither RAPID Live nor VS Code gives you an emergency stop or a normal stop.';
  const R3 = 'Start RAPID and Run Routine still ask you first, every time. Jog asks on the next jog.';
  const R4 = 'RAPID Live withdraws it when you disconnect or choose Withdraw Motion Control, and when the controller session changes. '
    + 'It tries to when you close the window. If a withdrawal does not go through, whether the controller still counts it is not known.';
  const R5 = 'If either stop is out of your reach, choose Cancel.';
  const R6 = 'Nothing is sent yet. Choose "Both stops are within my reach". Then type the robot\'s name, IRB1600_6_120.';

  it('a virtual controller with the FlexPendant connected: the exact text, title and button', async () => {
    const m = await allowDialog();
    assert.equal(m.message, `Allow Motion Control on ${LABEL}`);
    assert.deepEqual(m.buttons, ['Both stops are within my reach']);
    assert.equal(m.detail, [C1, C2, VC, MOVES, R1, R3, R4, R5, R6].join('\n\n'));
  });

  it('a real controller has no virtual-controller line; a FlexPendant read as not connected adds its line; null adds nothing', async () => {
    assert.equal((await allowDialog({ virtual: false })).detail, [C1, C2, MOVES, R1, R3, R4, R5, R6].join('\n\n'));
    const off = await allowDialog({ virtual: false }, { flexPendantConnected: false, safetyProtocolConnected: false });
    assert.equal(off.detail, [C1, C2, FP, MOVES, R1, R3, R4, R5, R6].join('\n\n'));
    const unknown = await allowDialog({ virtual: false }, { flexPendantConnected: null, safetyProtocolConnected: null });
    assert.equal(unknown.detail, [C1, C2, MOVES, R1, R3, R4, R5, R6].join('\n\n'));
  });

  it('a remote or web window adds that the stops must be within reach where the person is', async () => {
    const ssh = await allowDialog({}, undefined, remoteWindow('ssh-remote', false));
    assert.ok(ssh.detail.includes(`${R1}\n\nThis window runs RAPID Live on another machine (ssh-remote). The stops must be within reach of you, where you are.\n\n${R3}`));
    const web = await allowDialog({}, undefined, remoteWindow(undefined, true));
    assert.ok(web.detail.includes('This window runs in a web browser, and RAPID Live runs on another machine. The stops must be within reach of you, where you are.'));
    assert.equal(remoteWindow(undefined, false), null);
  });

  it('the name box asks in the client\'s words', async () => {
    const { robot } = fakeRobot();
    const { ui, shown } = fakeUi({ modal: (_m, _d, b) => b[0], input: () => undefined });
    await runAllow(robot, 'palette', context(ui).ctx);
    assert.deepEqual(shown[1], { kind: 'input', title: 'Allow Motion Control on IRB1600_6_120',
      prompt: "Type the robot's name to confirm that both stops are within your reach: IRB1600_6_120", placeHolder: 'IRB1600_6_120' });
  });

  it('the line on when it ends names only the withdrawals that are on', () => {
    assert.equal(whenItEnds(false), R4);
    assert.equal(whenItEnds(true), 'RAPID Live withdraws it when you disconnect, switch robots or choose Withdraw Motion Control, '
      + 'and when the controller session changes. It tries to when you close the window. If a withdrawal does not go through, whether the controller still counts it is not known.');
    // No lifetime is claimed: what the controller does when a withdrawal does not go through is not known.
    for (const on of [false, true]) { assert.doesNotMatch(whenItEnds(on), /at most/); }
    assert.deepEqual(rapidLiveLines(null, false), [R1, R3, R4, R5]);
  });

  it('the confirmation from a refusal is the same: confirmationFor reads only the call', async () => {
    const fromRefusal: RefusalRemedy = {
      kind: 'declare-motion-control', byWhom: 'person-confirms-in-a-tool', label: 'Allow motion control', detail: 'x',
      appliesTo: { generation: 'rw8', scope: 'station', operation: 'POST /rw/rapid/execution/start' },
      call: { method: 'setAllowMotionControl', allow: true }, safetyDeclaration: true, afterwards: 'run-again', evidence: 'abb', basis: 'x',
    };
    const { robot } = fakeRobot({ allowed: false });
    const { ui, shown } = fakeUi({ modal: () => undefined });
    await runAllow(robot, 'start-rapid', context(ui).ctx, fromRefusal);
    const m = shown.find(s => s.kind === 'modal') as { detail: string };
    assert.equal(m.detail, [C1, C2, VC, MOVES, R1, R3, R4, R5, R6].join('\n\n'));
  });
});

describe('Withdraw Motion Control', () => {
  const ctxW = (ui: MotionUi) => {
    const done: string[] = [];
    const tracker = new MotionControlTracker();
    tracker.markAllowed('r1', cell.name);
    return { ctx: { ui, robot: cell, tracker, disconnect: async () => { done.push('disconnect'); }, log: () => undefined }, done, tracker };
  };

  it('sends false at once, with no dialog, reads it back, and says so', async () => {
    const { robot, calls } = fakeRobot({ allowed: true });
    const { ui, shown } = fakeUi();
    const { ctx, tracker } = ctxW(ui);
    assert.equal(await runWithdraw(robot, ctx), 'withdrawn');
    assert.deepEqual(calls, ['set false', 'read']);
    assert.deepEqual(shown, [{ kind: 'info', message: `Motion control withdrawn on ${LABEL}. RobotWare 8 refuses starts and jogs from RAPID Live until you allow it again.` }]);
    assert.equal(tracker.allowedHere('r1'), false);
  });

  it('with RAPID running, says what the controller did, from a fresh read', async () => {
    for (const [after, tail] of [['running', ' RAPID kept running.'], ['stopped', ' RAPID stopped.']] as const) {
      const { robot, calls } = fakeRobot({ allowed: true, execstate: 'running' }, { afterRefresh: after });
      const { ui, shown } = fakeUi();
      await runWithdraw(robot, ctxW(ui).ctx);
      assert.deepEqual(calls, ['set false', 'read', 'refresh']);
      assert.equal((shown[0] as { message: string }).message.endsWith(tail), true, after);
    }
  });

  it('refused: the controller\'s refusal, then the warning that offers Disconnect', async () => {
    const refused = new RwsError('refused', 'GRANT_DENIED', 403);
    const { robot } = fakeRobot({ allowed: true }, { set: async () => { throw refused; } });
    const { ui, shown } = fakeUi({ ask: () => 'Disconnect IRB1600_6_120' });
    const { ctx, done, tracker } = ctxW(ui);
    assert.equal(await runWithdraw(robot, ctx), 'refused');
    assert.deepEqual(shown, [
      { kind: 'refused', label: 'Withdraw Motion Control', error: 'refused' },
      { kind: 'ask', message: 'IRB1600_6_120 did not take the withdrawal. Disconnecting ends the session that allowed it. Whether that also ends the allowance is not known.',
        buttons: ['Disconnect IRB1600_6_120'] },
    ]);
    await tick();
    assert.deepEqual(done, ['disconnect']);
    assert.equal(tracker.allowedHere('r1'), true);
  });

  it('nothing on RobotWare 6 or 7, or when not connected', async () => {
    for (const [over, message] of [[{ gen: 'rw6' as const }, 'RobotWare 6 and 7 have no motion control to withdraw. Nothing was sent.'],
      [{ gen: 'rw7' as const }, 'RobotWare 6 and 7 have no motion control to withdraw. Nothing was sent.'],
      [{ connected: false }, 'Connect first.']] as const) {
      const { robot, calls } = fakeRobot(over);
      const { ui, shown } = fakeUi();
      assert.equal(await runWithdraw(robot, ctxW(ui).ctx), 'not-sent');
      assert.deepEqual(calls, []);
      assert.deepEqual(shown, [{ kind: 'warn', message }]);
    }
  });
});

describe('the robot switch', () => {
  const from = (o: Partial<Parameters<typeof withdrawOnSwitch>[0] & object> = {}) =>
    ({ connected: true, generation: 'rw8' as const, allowed: true as boolean | null, allowedHere: true, ...o });

  it('is held off in this release: nothing is withdrawn on a switch', () => {
    assert.equal(MOTION_CONTROL_SWITCH.withdrawOnSwitch, false);
    assert.equal(withdrawOnSwitch(from()), false);
  });

  it('when on: the robot that stopped being active is withdrawn when connected, RobotWare 8, and reading true or allowed here and not false', () => {
    assert.equal(withdrawOnSwitch(from(), true), true);
    assert.equal(withdrawOnSwitch(from({ allowed: null }), true), true);
    assert.equal(withdrawOnSwitch(from({ allowed: true, allowedHere: false }), true), true);
    assert.equal(withdrawOnSwitch(from({ allowed: false }), true), false);
    assert.equal(withdrawOnSwitch(from({ allowed: null, allowedHere: false }), true), false);
    assert.equal(withdrawOnSwitch(from({ connected: false }), true), false);
    assert.equal(withdrawOnSwitch(from({ generation: 'rw7' }), true), false);
    assert.equal(withdrawOnSwitch(undefined, true), false);
  });

  it('when on, the withdrawal says which robot is now active', async () => {
    const { robot, calls } = fakeRobot({ allowed: true });
    const { ui, shown } = fakeUi();
    const tracker = new MotionControlTracker();
    await runSwitchWithdraw(robot, 'IRB1200_7', { ui, robot: cell, tracker, disconnect: async () => undefined, log: () => undefined });
    assert.deepEqual(calls, ['set false', 'read']);
    assert.deepEqual(shown, [{ kind: 'info', message: 'Motion control withdrawn on IRB1600_6_120: IRB1200_7 is now the active robot. Allow it again on IRB1600_6_120 when you switch back.' }]);
  });
});

describe('indicators', () => {
  const reading = (allowed: boolean | null, since: string | null = null, registered = true) => ({ allowed, since, registered });

  it('hhmm is local time', () => {
    assert.equal(hhmm(at1402), '14:02');
    assert.equal(hhmm(null), null);
    assert.equal(hhmm('not a time'), null);
  });

  it('motionReading: only a connected RobotWare 8 robot has one', () => {
    assert.deepEqual(motionReading(fakeRobot({ allowed: true }).state), { allowed: true, since: null, registered: true });
    assert.equal(motionReading(fakeRobot({ gen: 'rw7' }).state), null);
    assert.equal(motionReading(fakeRobot({ connected: false }).state), null);
    assert.equal(motionReading(undefined), null);
  });

  it('the status bar: allowed since HH:MM, not known after RAPID Live allowed it, hidden otherwise', () => {
    assert.deepEqual(statusIndicator('IRB1600_6_120', reading(true, at1402), true), {
      text: '$(shield) Motion allowed since 14:02',
      tooltip: 'Motion control is allowed on IRB1600_6_120 since 14:02. You confirmed then that an emergency stop and a normal stop are within your reach. '
        + "Withdrawing is not a stop: to stop the robot, use the FlexPendant's stops. Click to withdraw.",
      warning: true,
    });
    assert.deepEqual(statusIndicator('IRB1600_6_120', reading(null), true), {
      text: '$(warning) Motion control: not known', tooltip: 'IRB1600_6_120 may still allow motion control from this station. Click to withdraw.', warning: true,
    });
    assert.equal(statusIndicator('IRB1600_6_120', reading(true), false)?.text, '$(shield) Motion allowed');
    assert.match(statusIndicator('IRB1600_6_120', reading(true), false)?.tooltip ?? '', /RAPID Live did not allow it on this connection\./);
    assert.match(statusIndicator('IRB1600_6_120', reading(true), true)?.tooltip ?? '', /RAPID Live allowed it on this connection, after you confirmed/);
    assert.equal(statusIndicator('IRB1600_6_120', reading(null), false), undefined);
    assert.equal(statusIndicator('IRB1600_6_120', reading(false), true), undefined);
    assert.equal(statusIndicator('IRB1600_6_120', null, true), undefined);
  });

  it('the Robots view: a description and a tooltip line on RobotWare 8; nothing on 6 or 7', () => {
    assert.deepEqual(robotsViewMotion(reading(true, at1402), true), { description: 'motion allowed', tooltip: 'Motion control (RobotWare 8): allowed since 14:02', withdraw: true });
    assert.deepEqual(robotsViewMotion(reading(false), false), { tooltip: 'Motion control (RobotWare 8): not allowed' });
    assert.deepEqual(robotsViewMotion(reading(null), true), { description: 'motion: not known', tooltip: 'Motion control (RobotWare 8): not known', withdraw: true });
    assert.equal(robotsViewMotion(reading(true), false).withdraw, true);
    assert.deepEqual(robotsViewMotion(reading(null, null, false), false), { tooltip: 'Motion control (RobotWare 8): not read yet' });
    assert.deepEqual(robotsViewMotion(reading(null, null, true), false), { tooltip: 'Motion control (RobotWare 8): not known' });
    assert.deepEqual(robotsViewMotion(null, true), {});
  });
});

describe('the notices of the client\'s withdrawals', () => {
  const tracked = () => { const t = new MotionControlTracker(); t.markAllowed('r1', 'IRB1600_6_120'); return t; };
  const live: SessionNow = { connected: true, quality: 'live' };
  const FAILED_CONNECTED = "IRB1600_6_120: withdrawing motion control did not go through, so whether the controller still counts it is not known. The extension log has the controller's answer.";
  const FAILED_AT_DISCONNECT = 'Disconnected IRB1600_6_120. Withdrawing motion control first did not go through, so whether the controller still counts it is not known. '
    + "The extension log has the controller's answer.";

  it('only for a robot RAPID Live allowed motion control on', () => {
    assert.equal(new MotionControlTracker().onEvent('r1', 'withdrawn-at-disconnect', live), undefined);
  });

  it('each cause has its text, and a withdrawal ends allowedHere', () => {
    const cases = [
      ['withdrawn-at-disconnect', 'Disconnected IRB1600_6_120. Motion control was withdrawn first.'],
      ['withdrawn-after-reissue', 'Motion control on IRB1600_6_120 was withdrawn: the controller session changed. Allow it again to start from here.'],
      ['withdrawn-on-mode-change', 'Motion control on IRB1600_6_120 was withdrawn: the operating mode changed.'],
      ['withdrawn-on-take-back', 'Motion control on IRB1600_6_120 was withdrawn: the FlexPendant took write access.'],
    ] as const;
    for (const [cause, text] of cases) {
      const t = tracked();
      assert.deepEqual(t.onEvent('r1', cause, live), { level: 'info', text, buttons: [] }, cause);
      assert.equal(t.allowedHere('r1'), false, cause);
    }
    const t = tracked();
    assert.equal(t.onEvent('r1', 'withdrawn-at-registration', live), undefined);
    assert.equal(t.allowedHere('r1'), false);
    for (const cause of ['set', 'read', 'session-reissued'] as const) {
      const u = tracked();
      assert.equal(u.onEvent('r1', cause, live), undefined, cause);
      assert.equal(u.allowedHere('r1'), true, cause);
    }
  });

  it('a leftover the client withdraws at a registration: no notice, and the robot reads not allowed (not known after a failed withdrawal), never allowed', () => {
    // The client withdraws an allowance it finds at a registration when it made none in this run. RAPID Live's
    // station id is made for each connection, so only a robot whose settings name a fixed controlStation can meet
    // one, and RAPID Live never allowed motion control on it: the tracker has nothing to say.
    const t = new MotionControlTracker();
    assert.equal(t.onEvent('r1', 'withdrawn-leftover', live), undefined);
    assert.equal(t.onEvent('r1', 'withdraw-failed', live), undefined);
    assert.equal(t.allowedHere('r1'), false);
    const state = (allowMotionControl: boolean | null) => ({
      connected: true,
      access: { generation: 'rw8' as const, rw8: { registered: true, identity: 'option' as const, allowMotionControl, allowMotionControlSince: null } },
    });
    const withdrawn = motionReading(state(false));
    assert.deepEqual(robotsViewMotion(withdrawn, false), { tooltip: 'Motion control (RobotWare 8): not allowed' });
    assert.equal(statusIndicator('IRB1600_6_120', withdrawn, false), undefined);
    assert.match(motionLine(withdrawn, false, true)!.line, /^Motion control is not allowed from this station\./);
    const failed = motionReading(state(null));
    assert.deepEqual(robotsViewMotion(failed, false), { tooltip: 'Motion control (RobotWare 8): not known' });
    assert.equal(statusIndicator('IRB1600_6_120', failed, false), undefined);
    assert.match(motionLine(failed, false, true)!.line, /^Whether motion control is allowed from this station is not known yet\./);
  });

  it('a failed withdrawal: not known; Withdraw and Disconnect while connected, none during a disconnect', () => {
    const t = tracked();
    assert.deepEqual(t.onEvent('r1', 'withdraw-failed', live), { level: 'warning', text: FAILED_CONNECTED, buttons: ['Withdraw', 'Disconnect IRB1600_6_120'] });
    assert.equal(t.allowedHere('r1'), true);
    t.beginDisconnect('r1');
    assert.deepEqual(t.onEvent('r1', 'withdraw-failed', live), { level: 'warning', text: FAILED_AT_DISCONNECT, buttons: [] });
    assert.deepEqual(tracked().onEvent('r1', 'withdraw-failed', { connected: false }), { level: 'warning', text: FAILED_AT_DISCONNECT, buttons: [] });
  });

  it('the client\'s own disconnect after failed polls: the withdrawal fails while the state still reads connected (stale); the notice waits, then has no buttons', () => {
    // The client's order: polls fail (quality stale), the third one tears the session down,
    // and the teardown withdraws first, before its state reads disconnected.
    const core = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'dist', 'RobotManager.js'), 'utf8');
    assert.ok(core.indexOf("await motionControl.withdraw('disconnect');") < core.indexOf("connected: false, quality: 'disconnected', qualityReason: 'disconnected',"),
      'the client changed its teardown order: check when a failed withdrawal is held back');
    assert.match(core, /this\.setQuality\('stale', /);
    const t = tracked();
    const stale: SessionNow = { connected: true, quality: 'stale' };
    assert.equal(sessionUnsettled(stale), true);
    assert.equal(t.onEvent('r1', 'withdraw-failed', stale), undefined, 'held back while the session may be going');
    // The change notice of the event itself: still unsettled, still held.
    assert.equal(t.settle('r1', stale), undefined);
    // The teardown's own change notice: disconnected; the warning says so, with no buttons.
    assert.deepEqual(t.settle('r1', sessionNow({ connected: false, quality: 'disconnected' })), { level: 'warning', text: FAILED_AT_DISCONNECT, buttons: [] });
    assert.equal(t.settle('r1', { connected: false }), undefined, 'given once');
    // A reconnect cycle tears down the same way.
    const u = tracked();
    assert.equal(u.onEvent('r1', 'withdraw-failed', { connected: true, quality: 'reconnecting' }), undefined);
    assert.equal(u.settle('r1', undefined)?.text, FAILED_AT_DISCONNECT, 'a removed robot');
  });

  it('a failed withdrawal held back on a session that then stays (polls answer again) gets Withdraw and Disconnect', () => {
    const t = tracked();
    assert.equal(t.onEvent('r1', 'withdraw-failed', { connected: true, quality: 'stale' }), undefined);
    assert.deepEqual(t.settle('r1', { connected: true, quality: 'polling' }), { level: 'warning', text: FAILED_CONNECTED, buttons: ['Withdraw', 'Disconnect IRB1600_6_120'] });
    // The person disconnects while one is held back: the disconnect's own failure is the one warning.
    const d = tracked();
    d.onEvent('r1', 'withdraw-failed', { connected: true, quality: 'stale' });
    d.beginDisconnect('r1');
    assert.equal(d.onEvent('r1', 'withdraw-failed', { connected: true, quality: 'stale' })?.text, FAILED_AT_DISCONNECT);
    assert.equal(d.settle('r1', { connected: false }), undefined);
    assert.equal(d.endDisconnect('r1'), true);
    // A withdrawal that went through meanwhile drops the one held back.
    const u = tracked();
    u.onEvent('r1', 'withdraw-failed', { connected: true, quality: 'stale' });
    u.onEvent('r1', 'withdrawn-after-reissue', { connected: true, quality: 'stale' });
    assert.equal(u.settle('r1', live), undefined);
    // Nothing held: nothing to give.
    assert.equal(tracked().settle('r1', { connected: false }), undefined);
  });

  it('noticeForEvent reads the robot\'s session at the event, and ignores other access events', () => {
    const t = tracked();
    const event = (cause: 'withdraw-failed' | 'withdrawn-at-disconnect'): AccessEvent => ({ type: 'motionControl', lock: 'writeaccess', allowed: null, cause, at: 0 });
    const state = (connected: boolean, quality: string): MotionState => ({ connected, quality });
    assert.equal(noticeForEvent(t, 'r1', { type: 'acquired', lock: 'writeaccess', at: 0 } as AccessEvent, state(true, 'live')), undefined);
    assert.equal(noticeForEvent(t, 'r1', event('withdraw-failed'), state(true, 'stale')), undefined);
    assert.deepEqual(noticeForEvent(t, 'r1', event('withdraw-failed'), state(true, 'live'))?.buttons, ['Withdraw', 'Disconnect IRB1600_6_120']);
    assert.deepEqual(noticeForEvent(tracked(), 'r1', event('withdraw-failed'), undefined)?.buttons, [], 'no robot: not connected');
    assert.deepEqual(sessionNow(undefined), { connected: false, quality: null });
  });

  it('a disconnect says "Disconnected." unless a notice spoke for it, whatever RAPID Live counted before', () => {
    // A notice for the disconnect: the command adds nothing.
    const t = tracked();
    t.beginDisconnect('r1');
    assert.equal(t.onEvent('r1', 'withdrawn-at-disconnect', { connected: true, quality: 'live' })?.level, 'info');
    assert.equal(t.endDisconnect('r1'), true);
    assert.equal(disconnectMessage(true), undefined);
    // Allowed here, but the client had nothing to withdraw (a read of false ended it): no event, so "Disconnected.".
    const u = tracked();
    u.beginDisconnect('r1');
    assert.equal(u.onEvent('r1', 'read', live), undefined);
    assert.equal(u.endDisconnect('r1'), false);
    assert.equal(disconnectMessage(false), 'Disconnected.');
    // A robot RAPID Live never allowed it on: "Disconnected.".
    const v = new MotionControlTracker();
    v.beginDisconnect('r2');
    assert.equal(v.endDisconnect('r2'), false);
    // While the window closes there are no notices, and none counts as given.
    const w = tracked();
    w.closing = true;
    w.beginDisconnect('r1');
    assert.equal(w.onEvent('r1', 'withdrawn-at-disconnect', live), undefined);
    assert.equal(w.endDisconnect('r1'), false);
  });

  it('no notices while the window closes', () => {
    const t = tracked();
    t.closing = true;
    assert.equal(t.onEvent('r1', 'withdrawn-at-disconnect', live), undefined);
    const u = tracked();
    u.onEvent('r1', 'withdraw-failed', { connected: true, quality: 'stale' });
    u.closing = true;
    assert.equal(u.settle('r1', { connected: false }), undefined);
  });
});

describe('the line and the button of a RobotWare 8 start or jog confirmation', () => {
  const request = { label: 'Run M.r', tier: 'motion' as const, sideEffects: ['Starts RAPID there; the robot moves as the routine says.'] };

  it('the line per state', () => {
    const r = (allowed: boolean | null, since: string | null = null) => ({ allowed, since, registered: true });
    assert.deepEqual(motionLine(r(false), false), { line: 'Motion control is not allowed from this station. RobotWare 8 refuses a start or a jog without it.', offerAllow: true });
    assert.deepEqual(motionLine(r(null), false), { line: 'Whether motion control is allowed from this station is not known yet. RobotWare 8 refuses a start or a jog without it.', offerAllow: true });
    assert.deepEqual(motionLine(r(null), true), { line: 'Motion control: not known. The controller did not answer, or the controller session changed.', offerAllow: true });
    assert.deepEqual(motionLine(r(true, at1402), true), {
      line: 'Motion control allowed at 14:02. You confirmed then that both stops are within your reach. If that is not so now, choose Cancel and withdraw it.', offerAllow: false });
    assert.equal(motionLine(r(true), false)?.offerAllow, false);
    assert.equal(motionLine(null, false), undefined);
  });

  it('on RobotWare 8 with motion control not allowed: Allow Motion Control first…, then the same confirmation again, with the typed name', async () => {
    const { robot, state } = fakeRobot({ allowed: false });
    const modals: Array<{ detail: string; buttons: string[] }> = [];
    let round = 0;
    const { ui, shown } = fakeUi({
      modal: (_m, detail, buttons) => { modals.push({ detail, buttons }); round++; return round === 1 ? ALLOW_FIRST_BUTTON : 'Continue'; },
      input: () => cell.name,
    });
    const allowFirst: string[] = [];
    const ok = await confirmMotionWrite(ui, () => cell, request,
      () => motionLine(motionReading(state), false),
      async () => {
        allowFirst.push('allow');
        state.access!.rw8!.allowMotionControl = true;
        state.access!.rw8!.allowMotionControlSince = at1402;
        return 'allowed';
      });
    assert.equal(ok, true);
    assert.deepEqual(allowFirst, ['allow']);
    assert.deepEqual(modals[0].buttons, ['Continue', ALLOW_FIRST_BUTTON]);
    // The line stands apart from what the start does, and the end says what each button does.
    assert.equal(modals[0].detail, 'This can move the robot.\n\n'
      + '• Starts RAPID there; the robot moves as the routine says.\n\n'
      + 'Motion control is not allowed from this station. RobotWare 8 refuses a start or a jog without it.\n\n'
      + 'Nothing is sent yet. To allow motion control first, choose "Allow Motion Control first…". '
      + 'It asks you to confirm that an emergency stop and a normal stop are within your reach, then this confirmation shows again. '
      + "Otherwise choose Continue, then type the robot's name, IRB1600_6_120, in the next box.");
    assert.ok(modals[0].detail.includes(ALLOW_FIRST_HINT));
    // The same confirmation again: the allowed line, no second button, and the typed name.
    assert.deepEqual(modals[1].buttons, ['Continue']);
    assert.equal(modals[1].detail, 'This can move the robot.\n\n'
      + '• Starts RAPID there; the robot moves as the routine says.\n\n'
      + 'Motion control allowed at 14:02. You confirmed then that both stops are within your reach. If that is not so now, choose Cancel and withdraw it.\n\n'
      + "Nothing is sent yet. Choose Continue, then type the robot's name, IRB1600_6_120, in the next box.");
    assert.deepEqual(shown.map(s => s.kind), ['modal', 'modal', 'input']);
    assert.ok(robot);
  });

  it('a robot that registers as a fixed control station: the line names the FlexPendant, and Allow first is not offered', async () => {
    for (const over of [{ controlStation: { name: 'cell', id: 'x' } }, { identity: 'option' as const }]) {
      for (const allowed of [false, null] as const) {
        const { robot } = fakeRobot({ ...over, allowed });
        assert.equal(fixedStation(robot), true);
        const ml = motionLineOf(robot, false);
        assert.equal(ml?.offerAllow, false);
        assert.ok(ml?.line.endsWith(` ${FIXED_STATION_NEXT_STEP}`), ml?.line);
        const { ui, shown } = fakeUi({ modal: () => 'Continue', input: () => cell.name });
        const ok = await confirmMotionWrite(ui, () => cell, request, () => motionLineOf(robot, false), async () => { throw new Error('Allow is never offered'); });
        assert.equal(ok, true);
        const first = shown[0] as { detail: string; buttons: string[] };
        assert.deepEqual(first.buttons, ['Continue']);
        assert.ok(first.detail.includes(FIXED_STATION_NEXT_STEP));
        assert.doesNotMatch(first.detail, /Allow Motion Control first/);
      }
    }
    assert.equal(FIXED_STATION_NEXT_STEP, 'RAPID Live does not allow motion control for this robot: its settings register it as a fixed control station '
      + '(`controlStation`), the same station in every window or computer with that setting. Start or jog from the FlexPendant.');
    // An entry without the setting is not one.
    assert.equal(fixedStation(fakeRobot().robot), false);
    assert.equal(fixedStation(fakeRobot({ controlStation: null }).robot), false);
    assert.equal(motionLineOf(fakeRobot({ allowed: false }).robot, false)?.offerAllow, true);
  });

  it('Allow first that ends without allowing sends nothing of the start', async () => {
    for (const outcome of ['not-sent', 'refused', 'read-false', 'unknown'] as const) {
      const { ui, shown } = fakeUi({ modal: () => ALLOW_FIRST_BUTTON, input: () => cell.name });
      const ok = await confirmMotionWrite(ui, () => cell, request, () => motionLine({ allowed: false, since: null, registered: true }, false), async () => outcome);
      assert.equal(ok, false, outcome);
      assert.deepEqual(shown.map(s => s.kind), ['modal'], outcome);
    }
  });

  it('allowed already: the line, no second button; RobotWare 6 or 7: no line and no button', async () => {
    const { ui, shown } = fakeUi({ modal: () => 'Continue', input: () => cell.name });
    assert.equal(await confirmMotionWrite(ui, () => cell, request, () => motionLine({ allowed: true, since: at1402, registered: true }, true), async () => { throw new Error('no allow'); }), true);
    assert.deepEqual((shown[0] as { buttons: string[] }).buttons, ['Continue']);
    const other = fakeUi({ modal: () => 'Continue', input: () => cell.name });
    assert.equal(await confirmMotionWrite(other.ui, () => cell, request, () => motionLine(motionReading(fakeRobot({ gen: 'rw7' }).state), false), async () => 'allowed'), true);
    const first = other.shown[0] as { detail: string; buttons: string[] };
    assert.deepEqual(first.buttons, ['Continue']);
    assert.doesNotMatch(first.detail, /Motion control/);
  });
});

describe('every robot at once: the status bar, Withdraw with no robot named, the context keys', () => {
  const entry = (id: string, allowed: boolean | null | 'rw7', o: { since?: string | null; here?: boolean; fixed?: boolean } = {}): MotionEntry => ({
    id, name: id.toUpperCase(),
    reading: allowed === 'rw7' ? null : { allowed, since: o.since ?? null, registered: true },
    allowedHere: o.here ?? false, fixedStation: o.fixed ?? false,
  });

  it('motionEntryOf reads a saved robot as the flows do', () => {
    const { robot } = fakeRobot({ allowed: true, controlStation: { name: 'cell', id: 'x' } });
    assert.deepEqual(motionEntryOf(robot, true), { id: 'r1', name: cell.name, reading: { allowed: true, since: null, registered: true }, allowedHere: true, fixedStation: true });
  });

  it('one robot whose allowance may stand: its indicator, named when it is not the active one, and the click withdraws there', () => {
    const a = entry('a', true, { since: at1402, here: true });
    assert.deepEqual(statusBarFor([a, entry('b', false)], 'a'), {
      text: '$(shield) Motion allowed since 14:02', tooltip: statusIndicator('A', a.reading, true)!.tooltip, robotId: 'a' });
    // Allowed on A, then the active robot is B (RobotWare 7, or RobotWare 8 not allowed): A still shows, by name.
    for (const b of [entry('b', 'rw7'), entry('b', false), entry('b', null)]) {
      assert.deepEqual(statusBarFor([a, b], 'b'), { text: '$(shield) Motion allowed since 14:02 (A)', tooltip: statusIndicator('A', a.reading, true)!.tooltip, robotId: 'a' });
    }
    assert.equal(statusBarFor([entry('a', false), entry('b', null)], 'a'), undefined);
    assert.equal(statusBarFor([], null), undefined);
  });

  it('two robots allowed (A, then B made active and allowed): both are counted, and the click asks which', () => {
    const a = entry('a', true, { since: at1402, here: true });
    const b = entry('b', null, { here: true });
    assert.deepEqual(withdrawCandidates([a, b], 'b').map(r => r.id), ['b', 'a'], 'the active robot first');
    assert.deepEqual(statusBarFor([a, b], 'b'), {
      text: '$(shield) Motion control on 2 robots',
      tooltip: 'B: Motion control: not known\nA: Motion allowed since 14:02\n\n'
        + "Withdrawing is not a stop: to stop a robot, use its FlexPendant's stops. Click to choose the robot to withdraw it on.",
    });
    // Withdraw with no robot named: the person picks, the active robot first and marked.
    const choice = withdrawChoice([a, b], 'b');
    assert.ok('pick' in choice);
    assert.deepEqual(withdrawPickItems(choice.pick, 'b'), [
      { id: 'b', label: 'B', description: 'Motion control: not known (active)' },
      { id: 'a', label: 'A', description: 'Motion allowed since 14:02' },
    ]);
  });

  it('Withdraw with no robot named: the one robot whose allowance may stand, else the active one', () => {
    const a = entry('a', true, { since: at1402, here: true });
    assert.deepEqual(withdrawChoice([a, entry('b', 'rw7')], 'b'), { id: 'a' });
    assert.deepEqual(withdrawChoice([entry('a', false), entry('b', false)], 'b'), { id: 'b' });
    assert.deepEqual(withdrawChoice([], null), { id: undefined });
  });

  it('the context keys: Allow is not in the palette for a fixed station; Withdraw is wherever an allowance may stand', () => {
    const a = entry('a', true, { since: at1402, here: true });
    assert.deepEqual(motionContextKeys([a, entry('b', 'rw7')], 'b'), { activeRw8: false, motionControlAllowed: false, activeFixedStation: false, motionWithdrawable: true });
    assert.deepEqual(motionContextKeys([a], 'a'), { activeRw8: true, motionControlAllowed: true, activeFixedStation: false, motionWithdrawable: true });
    assert.deepEqual(motionContextKeys([entry('c', false, { fixed: true })], 'c'), { activeRw8: true, motionControlAllowed: false, activeFixedStation: true, motionWithdrawable: false });
    assert.deepEqual(motionContextKeys([entry('c', 'rw7', { fixed: true })], 'c'), { activeRw8: false, motionControlAllowed: false, activeFixedStation: false, motionWithdrawable: false });
  });

  it('the error\'s Allow button opens Allow with the refusal\'s own remedy and an origin from the error\'s label', () => {
    const declare: RefusalRemedy = {
      kind: 'declare-motion-control', byWhom: 'person-confirms-in-a-tool', label: 'Allow motion control', detail: 'x',
      appliesTo: { generation: 'rw8', scope: 'station' }, call: { method: 'setAllowMotionControl', allow: true }, safetyDeclaration: true,
      afterwards: 'run-again', evidence: 'abb', basis: 'x',
    };
    const pendant: RefusalRemedy = { ...declare, kind: 'do-at-pendant', byWhom: 'person-at-pendant', call: undefined, safetyDeclaration: undefined };
    assert.deepEqual(allowFromRefusal({ remedy: declare, otherRemedies: [pendant] }, 'Run routine'), { origin: 'run-routine', remedy: declare });
    assert.deepEqual(allowFromRefusal({ remedy: { ...pendant, kind: 'check-state' }, otherRemedies: [declare, pendant] }, 'Jog'), { origin: 'jog', remedy: declare });
    assert.deepEqual(allowFromRefusal({ remedy: { ...declare, call: undefined } }, 'Starting RAPID'), { origin: 'start-rapid', remedy: undefined });
    assert.deepEqual(allowFromRefusal(undefined, 'Set PP'), { origin: 'refusal', remedy: undefined });
  });
});

describe('RAPID Live wiring in extension.ts', () => {
  // The logic is in the functions tested above, run with fakes; these scans only check that
  // extension.ts calls them, and the two steps that only the VS Code host can run.
  const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const handler = (id: string): string => {
    const start = src.indexOf(`tracedCommand('${id}'`);
    assert.ok(start >= 0, id);
    return src.slice(start, src.indexOf('tracedCommand(', start + 1));
  };

  it('calls the tested functions', () => {
    assert.match(src, /noticeForEvent\(motionTracker, id, event, /);
    assert.match(src, /motionTracker\.settle\(id, entry \? sessionNow\(entry\.manager\.state\) : undefined\)/);
    assert.match(src, /statusBarFor\(motion, multi\.activeId\)/);
    assert.match(src, /motionContextKeys\(motion, multi\.activeId\)/);
    assert.match(src, /motionLineOf\(entry, motionTracker\.allowedHere\(entry\.id\)\)/);
    assert.match(src, /allowFromRefusal\(refusal, label\)/);
    assert.match(handler('abbRobot.disconnectRobot'), /disconnectMessage\(await endConnection\(multi, targetId\)\)/);
    assert.match(handler('abbRobot.withdrawMotionControl'), /const target = await withdrawTargetOf\(multi, arg\);/);
    assert.match(src, /const choice = withdrawChoice\(motionEntries\(multi\), multi\.activeId\);/);
    assert.match(handler('abbRobot.allowMotionControl'), /await allowFor\(activeEntry\(multi\), 'palette'\);/);
    for (const key of ['activeRw8', 'motionControlAllowed', 'activeFixedStation', 'motionWithdrawable']) {
      assert.match(src, new RegExp(`setContext', 'abbRobot\\.${key}', keys\\.${key}\\)`), key);
    }
  });

  it('closing the window disconnects every robot at once with the client\'s disconnectAll; Remove Robot waits for the disconnect', () => {
    const start = src.indexOf('export async function deactivate()');
    const body = src.slice(start);
    assert.match(body, /motionTracker\.closing = true;/);
    assert.match(body, /await globalMulti\.disconnectAll\(\)/);
    assert.match(handler('abbRobot.removeRobot'), /await endConnection\(multi, id, 'remove'\)\.catch\(\(\) => undefined\);/);
  });

  it('the commands are contributed: Allow in the palette for a connected RobotWare 8 active robot that is not a fixed station; Withdraw also wherever an allowance may stand, and on its Robots view row', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string; category?: string; icon?: string }>; menus: Record<string, Array<{ command: string; when?: string; group?: string }>> };
    };
    const cmd = (id: string) => manifest.contributes.commands.find(c => c.command === id);
    assert.deepEqual(cmd('abbRobot.allowMotionControl'), { command: 'abbRobot.allowMotionControl', title: 'Allow Motion Control (RobotWare 8)…', category: 'ABB Robot', icon: '$(shield)' });
    assert.deepEqual(cmd('abbRobot.withdrawMotionControl'), { command: 'abbRobot.withdrawMotionControl', title: 'Withdraw Motion Control (RobotWare 8)', category: 'ABB Robot' });
    const palette = (id: string) => manifest.contributes.menus.commandPalette.find(m => m.command === id)?.when;
    assert.equal(palette('abbRobot.allowMotionControl'), 'abbRobot.connected && abbRobot.activeRw8 && !abbRobot.activeFixedStation');
    assert.equal(palette('abbRobot.withdrawMotionControl'), 'abbRobot.motionWithdrawable || abbRobot.connected && abbRobot.activeRw8');
    const row = manifest.contributes.menus['view/item/context'].find(m => m.command === 'abbRobot.withdrawMotionControl');
    const when = row?.when ?? '';
    assert.ok(when.startsWith('view == abbRobot.robots && viewItem =~ '), when);
    const re = new RegExp(/viewItem =~ \/(.+?)\/$/.exec(when)![1]);
    for (const v of ['robot.connected.motion', 'robot.connected.active.motion']) { assert.ok(re.test(v), v); }
    for (const v of ['robot.connected', 'robot.connected.active', 'robot.disconnected', 'robot.disconnected.active', 'robot.add']) { assert.ok(!re.test(v), v); }
    // The Robots view row says so from robotsViewMotion's `withdraw`.
    const tree = fs.readFileSync(path.join(root, 'src', 'RobotsTreeProvider.ts'), 'utf8');
    assert.match(tree, /\+ \(motion\.withdraw \? '\.motion' : ''\)/);
  });
});
