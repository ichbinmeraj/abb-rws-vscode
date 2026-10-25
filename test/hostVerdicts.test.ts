import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The host harness's verdicts, checked offline: a synthetic result (what
// stub-ext/suite.js writes) and synthetic extension log lines stand in for a
// run against a controller. `npm test` never starts the harness itself.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const harness = require('./host/verdicts.js') as {
  ROBOT_NAME: string; ROBOT_NAME_2: string;
  dialogsIn(result: Result, name: string): string[];
  verdicts(result: Result, log: LogLine[]): Record<string, string>;
  placeGuardRows(rows: Row[], v: Record<string, string>): Row[];
  report(target: { url: string }, result: Result, log: LogLine[], rows: Row[]): string;
};

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

interface Ui { ts: string; step: string; kind: string; [k: string]: unknown }
interface Step { name: string; command: string; start: string; end: string; ok?: boolean }
interface Result {
  started: string; steps: Step[]; ui: Ui[]; readbacks: Array<{ ts: string; step: string; label: string; value?: unknown }>;
  cleanup: string[]; stepE?: Record<string, unknown>; stepF?: Record<string, unknown>; stepI?: Record<string, unknown>;
  [k: string]: unknown;
}
interface LogLine { ts: string; category: string; msg: string; data?: Record<string, unknown> }
interface Row { step: string; command: string; dialogs: string[]; requests: Array<{ method: string; path: string; status: unknown; body?: string }>; verdict: string }

const ROBOT = harness.ROBOT_NAME;
const label = `${ROBOT} (127.0.0.1:80)`;

/** A result builder: each step gets its own second, so log lines fall inside it. */
function fixture() {
  let t = Date.parse('2026-10-16T10:00:00.000Z');
  const result: Result = { started: new Date(t).toISOString(), steps: [], ui: [], readbacks: [], cleanup: [] };
  const log: LogLine[] = [];
  const at = (offset = 0) => new Date(t + offset).toISOString();
  const api = {
    result, log,
    step(name: string, command: string, fill: (s: { ui(kind: string, extra: Record<string, unknown>): void; request(method: string, p: string, status: number | 'err'): void; readback(label: string, value: unknown): void }) => void) {
      t += 10_000;
      const s: Step = { name, command, start: at(0), end: at(5_000), ok: true };
      result.steps.push(s);
      let k = 100;
      fill({
        ui: (kind, extra) => { result.ui.push({ ts: at(k += 100), step: name, kind, ...extra }); },
        request: (method, p, status) => {
          const ts = at(k += 100);
          log.push({ ts, category: 'http.req', msg: `${method} ${p}`, data: { method, path: p } });
          log.push({ ts: at(k += 50), category: status === 'err' ? 'http.err' : 'http.res', msg: `${status}`, data: { method, path: p, status } });
        },
        readback: (l, value) => { result.readbacks.push({ ts: at(k += 100), step: name, label: l, value }); },
      });
      return s;
    },
  };
  return api;
}

const motionModal = (what: string, detail = 'This can move the robot.\n\n• Starts the RAPID program.') =>
  ({ text: `${what} on ${label}`, detail, buttons: ['Continue'], modal: true });

describe('host harness verdicts: step E (Start RAPID behind the typed name)', () => {
  it('E1 passes when the modal names the robot, the wrong name is refused and nothing is sent', () => {
    const f = fixture();
    f.result.stepE = { wrongName: 'Host tess' };
    f.step('E1 startRapid wrong name', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('answer', { to: 'warning', value: 'Continue' });
      s.ui('inputBox', { title: `Start RAPID on ${ROBOT}`, prompt: `Type the robot's name to send it: ${ROBOT}`, placeHolder: ROBOT });
      s.ui('answer', { to: 'inputBox', value: 'Host tess' });
      s.ui('warning', { text: `Start RAPID not sent to ${ROBOT}: "Host tess" is not its name.`, buttons: [], modal: false });
      s.request('GET', '/rw/panel/ctrl-state', 200);
      s.readback('execution state after E1', 'stopped');
    });
    const v = harness.verdicts(f.result, f.log);
    assert.equal(v['E1 startRapid wrong name'], `PASS (modal names ${label}; "Host tess" refused; nothing sent)`);
  });

  it('E1 fails when a start request went out anyway, or the dialog does not name the robot', () => {
    const f = fixture();
    f.result.stepE = { wrongName: 'Host tess' };
    f.step('E1 startRapid wrong name', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('inputBox', { title: `Start RAPID on ${ROBOT}`, prompt: `Type the robot's name to send it: ${ROBOT}` });
      s.ui('warning', { text: `Start RAPID not sent to ${ROBOT}: "Host tess" is not its name.`, buttons: [], modal: false });
      s.request('POST', '/rw/rapid/execution/start', 204);
      s.readback('execution state after E1', 'running');
    });
    assert.match(harness.verdicts(f.result, f.log)['E1 startRapid wrong name'], /^FAIL: the wrong name was refused but something was sent: POST \/rw\/rapid\/execution\/start -> 204/);

    const g = fixture();
    g.result.stepE = { wrongName: 'Host tess' };
    g.step('E1 startRapid wrong name', 'abbRobot.startRapid', s => {
      s.ui('warning', { text: 'This will move the robot.', detail: '', buttons: ['Continue'], modal: true });
    });
    assert.match(harness.verdicts(g.result, g.log)['E1 startRapid wrong name'], /^FAIL: no modal "Start RAPID on/);
  });

  /** E1's second case: the name box answered with nothing typed (Enter on an empty box returns ''). */
  type StepApi = Parameters<Parameters<ReturnType<typeof fixture>['step']>[2]>[0];
  const emptyName = (f: ReturnType<typeof fixture>, extra: (s: StepApi) => void = () => {}) =>
    f.step('E1 startRapid empty name', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('answer', { to: 'warning', value: 'Continue' });
      s.ui('inputBox', { title: `Start RAPID on ${ROBOT}`, prompt: `Type the robot's name to send it: ${ROBOT}`, placeHolder: ROBOT });
      s.ui('answer', { to: 'inputBox', value: '' });
      s.ui('warning', { text: `Start RAPID not sent to ${ROBOT}: "" is not its name.`, buttons: [], modal: false });
      extra(s);
    });

  it('E1 with an empty name passes when the empty name is refused and nothing is sent', () => {
    const f = fixture();
    f.result.stepE = { wrongName: 'Host tess' };
    emptyName(f, s => {
      s.request('GET', '/rw/panel/ctrl-state', 200);
      s.readback('execution state after the empty name', 'stopped');
    });
    assert.equal(harness.verdicts(f.result, f.log)['E1 startRapid empty name'], `PASS (modal names ${label}; "" refused; nothing sent)`);
  });

  it('E1 with an empty name fails when a start went out, when RAPID reads running, or when the box was answered otherwise', () => {
    const sent = fixture();
    emptyName(sent, s => { s.request('POST', '/rw/rapid/execution/start', 204); });
    assert.match(harness.verdicts(sent.result, sent.log)['E1 startRapid empty name'],
      /^FAIL: the empty name was refused but something was sent: POST \/rw\/rapid\/execution\/start -> 204/);

    const running = fixture();
    emptyName(running, s => { s.readback('execution state after the empty name', 'running'); });
    assert.equal(harness.verdicts(running.result, running.log)['E1 startRapid empty name'], 'FAIL: RAPID reads running after the empty name');

    // A dismissed box (Escape) also sends nothing, but it is not the empty-name case: no refusal is shown.
    const dismissed = fixture();
    dismissed.step('E1 startRapid empty name', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('inputBox', { title: `Start RAPID on ${ROBOT}`, prompt: `Type the robot's name to send it: ${ROBOT}` });
    });
    assert.match(harness.verdicts(dismissed.result, dismissed.log)['E1 startRapid empty name'], /^FAIL: no refusal of the empty name "": Start RAPID on /);

    // A refusal recorded although the box was answered with something else.
    const other = fixture();
    other.step('E1 startRapid empty name', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('inputBox', { title: `Start RAPID on ${ROBOT}`, prompt: `Type the robot's name to send it: ${ROBOT}` });
      s.ui('answer', { to: 'inputBox', value: ' ' });
      s.ui('warning', { text: `Start RAPID not sent to ${ROBOT}: "" is not its name.`, buttons: [], modal: false });
    });
    assert.equal(harness.verdicts(other.result, other.log)['E1 startRapid empty name'], 'FAIL: the name box was not answered with ""');
  });

  it('the E2 guard row goes after the last E1 row; the other guards before their letter\'s first row', () => {
    const row = (step: string): Row => ({ step, command: '', dialogs: [], requests: [], verdict: 'PASS' });
    const rows = ['connect', 'A1 lockOpMode', 'E1 startRapid wrong name', 'E1 startRapid empty name', 'F1 toggle', 'disconnect'].map(row);
    harness.placeGuardRows(rows, { 'E2 guard': 'skipped: HOSTTEST_ALLOW_START is not 1', 'A guard': 'skipped: not virtual' });
    assert.deepEqual(rows.map(r => r.step),
      ['connect', 'A guard', 'A1 lockOpMode', 'E1 startRapid wrong name', 'E1 startRapid empty name', 'E2 guard', 'F1 toggle', 'disconnect']);
    assert.equal(rows[5].verdict, 'skipped: HOSTTEST_ALLOW_START is not 1');
  });

  it('E2 guard is reported when the step did not run; E2 and E3 pass with the start, the running read, the stop without a dialog', () => {
    const f = fixture();
    f.result.stepE = { wrongName: 'Host tess', e2: 'skipped: HOSTTEST_ALLOW_START is not 1' };
    assert.equal(harness.verdicts(f.result, f.log)['E2 guard'], 'skipped: HOSTTEST_ALLOW_START is not 1');

    const g = fixture();
    g.result.stepE = { wrongName: 'Host tess', e2: 'run' };
    g.step('E2 startRapid', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('answer', { to: 'warning', value: 'Continue' });
      s.ui('inputBox', { title: `Start RAPID on ${ROBOT}`, prompt: `Type the robot's name to send it: ${ROBOT}` });
      s.ui('answer', { to: 'inputBox', value: ROBOT });
      s.request('POST', '/rw/rapid/execution/start', 204);
      s.readback('execution state after E2 start', 'running');
    });
    g.step('E3 stopRapid', 'abbRobot.stopRapid', s => {
      s.request('POST', '/rw/rapid/execution/stop', 204);
      s.readback('execution state after E3 stop', 'stopped');
    });
    const v = harness.verdicts(g.result, g.log);
    assert.equal(v['E2 startRapid'], 'PASS (name typed; POST /rw/rapid/execution/start -> 204; reads running)');
    assert.equal(v['E3 stopRapid'], 'PASS (no confirmation; POST /rw/rapid/execution/stop -> 204; reads stopped)');
  });
});

describe('host harness verdicts: the controller refuses a confirmed write', () => {
  it('E2: a 403 on the start with a dialog that names the robot is the controller\'s refusal, not a failure', () => {
    const f = fixture();
    f.result.stepE = { wrongName: 'Host tess', e2: 'run' };
    f.step('E2 startRapid', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('answer', { to: 'warning', value: 'Continue' });
      s.ui('inputBox', { title: `Start RAPID on ${ROBOT}`, prompt: `Type the robot's name to send it: ${ROBOT}` });
      s.ui('answer', { to: 'inputBox', value: ROBOT });
      s.request('POST', '/rw/rapid/execution/start', 403);
      s.ui('error', { text: `${label}: Starting RAPID: the controller is in guard stop.`, buttons: [], modal: false });
      s.readback('execution state after E2 start', 'stopped');
    });
    assert.equal(harness.verdicts(f.result, f.log)['E2 startRapid'],
      `PASS (name typed; the controller refused: POST /rw/rapid/execution/start -> 403; the dialog names ${ROBOT}: ${label}: Starting RAPID: the controller is in guard stop.)`);
  });

  it('E2: a refusal whose dialog does not name the robot still fails', () => {
    const f = fixture();
    f.result.stepE = { wrongName: 'Host tess', e2: 'run' };
    f.step('E2 startRapid', 'abbRobot.startRapid', s => {
      s.ui('warning', motionModal('Start RAPID'));
      s.ui('answer', { to: 'warning', value: 'Continue' });
      s.ui('answer', { to: 'inputBox', value: ROBOT });
      s.request('POST', '/rw/rapid/execution/start', 403);
      s.ui('error', { text: 'Starting RAPID: refused.', buttons: [], modal: false });
      s.readback('execution state after E2 start', 'stopped');
    });
    assert.match(harness.verdicts(f.result, f.log)['E2 startRapid'], /^FAIL: start answered 403/);
  });

  it('F2: a 403 on the signal write with a dialog that names the robot passes, with the signal unchanged', () => {
    const f = fixture();
    f.result.stepF = { signal: 'IIO_do8', before: '0', after2: '0', after3: '0' };
    f.step('F1 toggleSignal cancel', 'abbRobot.toggleSignal', s => {
      s.ui('warning', { text: `Toggle IIO_do8 on ${label}`, detail: '', buttons: [`Write to ${ROBOT}`], modal: true });
      s.readback('signal IIO_do8 after F1', { lvalue: '0' });
    });
    f.step('F2 toggleSignal accept', 'abbRobot.toggleSignal', s => {
      s.ui('warning', { text: `Toggle IIO_do8 on ${label}`, detail: '', buttons: [`Write to ${ROBOT}`], modal: true });
      s.ui('answer', { to: 'warning', value: `Write to ${ROBOT}` });
      s.request('POST', '/rw/iosystem/signals/IntegratedIONetwork/IntegratedIOInternalDevice/IIO_do8/set-value', 403);
      s.ui('error', { text: `${label}: Toggle signal: refused writing signal 'IIO_do8' from a remote tool in AUTO.`, buttons: [], modal: false });
    });
    assert.match(harness.verdicts(f.result, f.log)['F2 toggleSignal accept'],
      /^PASS \(the controller refused: POST .*IIO_do8\/set-value -> 403; the dialog names Host test: .*; IIO_do8 still 0\)$/);
  });
});

describe('host harness verdicts: step F (toggle a probe output)', () => {
  const changeModal = (signal: string, from: string, to: string) => ({
    text: `Toggle ${signal} on ${label}`, detail: `• Sets the signal ${signal} from ${from} to ${to}.`, buttons: [`Write to ${ROBOT}`], modal: true,
  });

  it('cancel sends nothing; accept writes and reads back; the restore reads the first value again', () => {
    const f = fixture();
    f.result.stepF = { signal: 'ZZ_PROBE_DO', before: '0', after2: '1', after3: '0' };
    f.step('F1 toggleSignal cancel', 'abbRobot.toggleSignal', s => {
      s.ui('warning', changeModal('ZZ_PROBE_DO', '0', '1'));
      s.request('GET', '/rw/iosystem/signals', 200);
      s.readback('signal ZZ_PROBE_DO after F1', { name: 'ZZ_PROBE_DO', lvalue: '0' });
    });
    f.step('F2 toggleSignal accept', 'abbRobot.toggleSignal', s => {
      s.ui('warning', changeModal('ZZ_PROBE_DO', '0', '1'));
      s.ui('answer', { to: 'warning', value: `Write to ${ROBOT}` });
      s.request('POST', '/rw/iosystem/signals/Local/PANEL/ZZ_PROBE_DO/set-value', 204);
    });
    f.step('F3 toggleSignal restore', 'abbRobot.toggleSignal', s => {
      s.ui('warning', changeModal('ZZ_PROBE_DO', '1', '0'));
      s.ui('answer', { to: 'warning', value: `Write to ${ROBOT}` });
      s.request('POST', '/rw/iosystem/signals/Local/PANEL/ZZ_PROBE_DO/set-value', 204);
    });
    const v = harness.verdicts(f.result, f.log);
    assert.equal(v['F1 toggleSignal cancel'], `PASS (confirmation "Toggle ZZ_PROBE_DO on ${label}" [Write to ${ROBOT}]; cancelled; nothing sent; ZZ_PROBE_DO still 0)`);
    assert.equal(v['F2 toggleSignal accept'], 'PASS (POST /rw/iosystem/signals/Local/PANEL/ZZ_PROBE_DO/set-value -> 204; ZZ_PROBE_DO 0 -> 1)');
    assert.equal(v['F3 toggleSignal restore'], 'PASS (POST /rw/iosystem/signals/Local/PANEL/ZZ_PROBE_DO/set-value -> 204; ZZ_PROBE_DO back to 0)');
  });

  it('a cancelled toggle that still sent a request fails; a missing probe output is a guard, not a failure', () => {
    const f = fixture();
    f.result.stepF = { signal: 'ZZ_PROBE_DO', before: '0' };
    f.step('F1 toggleSignal cancel', 'abbRobot.toggleSignal', s => {
      s.ui('warning', changeModal('ZZ_PROBE_DO', '0', '1'));
      s.request('POST', '/rw/iosystem/signals/Local/PANEL/ZZ_PROBE_DO/set-value', 204);
      s.readback('signal ZZ_PROBE_DO after F1', { lvalue: '1' });
    });
    assert.match(harness.verdicts(f.result, f.log)['F1 toggleSignal cancel'], /^FAIL: cancelled but sent POST/);

    const g = fixture();
    g.result.stepF = { signal: 'ZZ_PROBE_DO', refused: 'no DO named ZZ_PROBE_DO on the controller (set HOSTTEST_DO); nothing sent' };
    assert.equal(harness.verdicts(g.result, g.log)['F guard'], 'skipped: no DO named ZZ_PROBE_DO on the controller (set HOSTTEST_DO); nothing sent');
  });
});

describe('host harness verdicts: step G (CFG load cancelled) and step I (two entries, one controller)', () => {
  it('G passes when the disruptive confirmation names the robot and the file, and nothing is sent', () => {
    const f = fixture();
    f.step('G loadCfgFile cancel', 'abbRobot.loadCfgFile', s => {
      s.ui('inputBox', { prompt: 'Path to .cfg file on the controller (e.g. $HOME/MOC.cfg)' });
      s.ui('answer', { to: 'inputBox', value: '$HOME/ZZ_HOSTTEST.cfg' });
      s.ui('quickPick', { items: [{ label: 'add' }] });
      s.ui('answer', { to: 'quickPick', value: 'add' });
      s.ui('warning', { text: `Load CFG file on ${label}`, detail: '• Loads $HOME/ZZ_HOSTTEST.cfg into the configuration (add): Merge.\n• Most configuration changes take effect after a controller restart.', buttons: [`Continue on ${ROBOT}`], modal: true });
    });
    assert.equal(harness.verdicts(f.result, f.log)['G loadCfgFile cancel'], `PASS (confirmation "Load CFG file on ${label}" [Continue on ${ROBOT}]; cancelled; nothing sent)`);
    assert.deepEqual(harness.dialogsIn(f.result, 'G loadCfgFile cancel'), [
      'input:  / Path to .cfg file on the controller (e.g. $HOME/MOC.cfg)',
      'answer(inputBox): "$HOME/ZZ_HOSTTEST.cfg"',
      'answer(quickPick): "add"',
      `modal warning: Load CFG file on ${label} / • Loads $HOME/ZZ_HOSTTEST.cfg into the configuration (add): Merge. • Most configuration changes take effect after a controller restart. [Continue on ${ROBOT}]`,
    ]);
  });

  it('I5 passes when the confirmation and the notification name the first robot, never the active second one', () => {
    const f = fixture();
    f.step('I5 save on non-active', '(Ctrl+S on the CFG document)', s => {
      s.ui('warning', { text: `Write SYS/CAB_TASKS/T_ROB1 on ${label}`, detail: '• Writes 5 attributes of the instance to the controller.', buttons: [`Write to ${ROBOT}`], modal: true });
      s.ui('answer', { to: 'warning', value: `Write to ${ROBOT}` });
      s.request('POST', '/rw/cfg/SYS/CAB_TASKS/instances/T_ROB1', 204);
      s.ui('info', { text: `✓ Wrote SYS/CAB_TASKS/T_ROB1 to "${ROBOT}". Most CFG changes need a controller restart to take effect.`, buttons: [], modal: false });
    });
    assert.equal(harness.verdicts(f.result, f.log)['I5 save on non-active'],
      `PASS (confirmation "Write SYS/CAB_TASKS/T_ROB1 on ${label}"; wrote back: ✓ Wrote SYS/CAB_TASKS/T_ROB1 to "${ROBOT}". Most CFG changes need a controller restart to take effect.)`);
  });

  it('I5 fails when the error text does not name the first robot, whatever the trace says', () => {
    const f = fixture();
    const s5 = f.step('I5 save on non-active', '(Ctrl+S on the CFG document)', s => {
      s.ui('warning', { text: `Write SYS/CAB_TASKS/T_ROB1 on ${label}`, detail: '', buttons: [`Write to ${ROBOT}`], modal: true });
      s.ui('answer', { to: 'warning', value: `Write to ${ROBOT}` });
      s.ui('error', { text: 'Write SYS/CAB_TASKS/T_ROB1: refused', buttons: [], modal: false });
    });
    f.log.push({ ts: new Date(Date.parse(s5.start) + 4000).toISOString(), category: 'error.shown', msg: 'x', data: { friendly: 'refused', robot: ROBOT } });
    assert.match(harness.verdicts(f.result, f.log)['I5 save on non-active'], new RegExp(`^FAIL: no notification names ${ROBOT}`));
  });

  it('I5 passes on a refusal too, when the error dialog is bound to the first robot; and fails when it names the second', () => {
    const f = fixture();
    const s5 = f.step('I5 save on non-active', '(Ctrl+S on the CFG document)', s => {
      s.ui('warning', { text: `Write SYS/CAB_TASKS/T_ROB1 on ${label}`, detail: '• Writes 5 attributes.', buttons: [`Write to ${ROBOT}`], modal: true });
      s.ui('answer', { to: 'warning', value: `Write to ${ROBOT}` });
      s.request('POST', '/rw/cfg/SYS/CAB_TASKS/instances/T_ROB1', 403);
      s.ui('error', { text: `${label}: Write SYS/CAB_TASKS/T_ROB1: ${ROBOT} refused the write: write access is held by the FlexPendant.`, buttons: ['Show Holder'], modal: false });
    });
    f.log.push({ ts: s5.start < s5.end ? new Date(Date.parse(s5.start) + 4000).toISOString() : s5.end, category: 'error.shown', msg: 'Write SYS/CAB_TASKS/T_ROB1',
      data: { friendly: `${label}: Write SYS/CAB_TASKS/T_ROB1: ${ROBOT} refused the write: write access is held by the FlexPendant.`, robot: ROBOT, refusalKind: 'held-by-other' } });
    assert.equal(harness.verdicts(f.result, f.log)['I5 save on non-active'],
      `PASS (confirmation "Write SYS/CAB_TASKS/T_ROB1 on ${label}"; error names ${ROBOT}: ${label}: Write SYS/CAB_TASKS/T_ROB1: ${ROBOT} refused the write: write access is held by the FlexPendant.)`);

    const g = fixture();
    g.step('I5 save on non-active', '(Ctrl+S on the CFG document)', s => {
      s.ui('warning', { text: `Write SYS/CAB_TASKS/T_ROB1 on ${harness.ROBOT_NAME_2} (127.0.0.1:80)`, detail: '', buttons: [`Write to ${harness.ROBOT_NAME_2}`], modal: true });
    });
    assert.match(harness.verdicts(g.result, g.log)['I5 save on non-active'], new RegExp(`^FAIL: the confirmation does not name ${ROBOT}`));
  });
});

describe('host harness verdicts: step A now expects the confirmation', () => {
  it('A1 fails without the "Continue on <robot>" button pressed, and passes with it', () => {
    const base = (pressed: boolean) => {
      const f = fixture();
      f.result.stepA = { pin: '4711', wrong: '9999' };
      f.result.lockStates = [{ label: 'lock state after lock', value: 'permlocked' }];
      f.step('A1 lockOpMode', 'abbRobot.lockOpMode', s => {
        s.ui('inputBox', { title: 'Lock Operation Mode', prompt: '4-digit PIN code' });
        s.ui('answer', { to: 'inputBox', value: '4711' });
        s.ui('warning', { text: `Lock Operation Mode on ${label}`, detail: '• Locks the operation mode selector permanently with this PIN.', buttons: [`Continue on ${ROBOT}`], modal: true });
        if (pressed) { s.ui('answer', { to: 'warning', value: `Continue on ${ROBOT}` }); }
        s.ui('info', { text: 'Operation mode locked.', buttons: [], modal: false });
      });
      return harness.verdicts(f.result, f.log)['A1 lockOpMode'];
    };
    assert.equal(base(true), `PASS (confirmation names ${ROBOT}; notification "Operation mode locked."; lock-state permlocked)`);
    assert.equal(base(false), `FAIL: the button "Continue on ${ROBOT}" was not pressed`);
  });
});

describe('host harness verdicts: the read-only acceptance steps', () => {
  it('U1 fails on any provider check that came back empty, and names it', () => {
    const f = fixture();
    f.result.u1 = { checks: [
      { id: 'languageId', ok: true, detail: '.mod opens as "rapid"' },
      { id: 'hover', ok: true, detail: '1 hover(s)' },
      { id: 'codeLens', ok: false, detail: '0 lens(es)' },
    ] };
    assert.equal(harness.verdicts(f.result, f.log)['U1 language'], 'FAIL: codeLens (0 lens(es))');
    f.result.u1 = { checks: [{ id: 'hover', ok: true, detail: '1 hover(s)' }] };
    assert.equal(harness.verdicts(f.result, f.log)['U1 language'], 'PASS (hover: 1 hover(s))');
  });

  it('U2: the VC row, the factory user and the saved entry without a password pass; a password in the settings fails', () => {
    const f = fixture();
    f.result.u2 = {
      port: 42179,
      scanList: [{ label: '$(circuit-board)  127.0.0.1:42179', description: 'RWS 1.0 · IRC5 · RobotWare 6 · HTTP · virtual controller', detail: 'Found via local VC process' }],
      userPrefill: 'Default User', passwordPrefilled: true, suggestedName: 'IRC5 (127.0.0.1)',
      added: { id: 'x1', name: 'Acceptance 42179', host: '127.0.0.1', port: 42179, useHttps: false, username: 'Default User', hasPassword: false },
      ids: { first: 'hosttest', second: 'hosttest-2', added: 'x1' },
      removed: true, passwordsInSettings: [], after: [{ id: 'hosttest', name: 'Host test', host: '127.0.0.1', port: 42179, username: 'Default User' }],
      configureUnchanged: true,
    };
    f.step('U2 addRobot', 'abbRobot.addRobot', s => {
      s.ui('info', { text: '✓ Added "Acceptance 42179"  (127.0.0.1:42179)', buttons: ['Connect Now'], modal: false });
    });
    f.step('U2 removeRobot', 'abbRobot.removeRobot', s => {
      s.ui('warning', { text: 'Remove "Acceptance 42179" from the robot list?', detail: '127.0.0.1:42179. Disconnects it and deletes its saved password.', buttons: ['Remove'], modal: true });
    });
    f.step('U2 configure cancel', 'abbRobot.configure', s => {
      s.ui('inputBox', { title: 'Configure Robot (1/3)', prompt: 'Host', value: '127.0.0.1' });
    });
    const v = harness.verdicts(f.result, f.log);
    assert.match(v['U2 addRobot'], /^PASS \(scan list 1 rows; row "\$\(circuit-board\)  127\.0\.0\.1:42179" \/ RWS 1\.0 · IRC5/);
    assert.match(v['U2 removeRobot'], /^PASS \(confirmation "Remove "Acceptance 42179" from the robot list\?"/);
    assert.match(v['U2 configure cancel'], /^PASS \(one box, "Configure Robot \(1\/3\)", cancelled/);
    assert.match(v['U2 settings S1'], /^PASS \(abbRobot\.robots: 1 entry, none with a password/);
    (f.result.u2 as { passwordsInSettings: string[] }).passwordsInSettings = ['hosttest'];
    assert.equal(harness.verdicts(f.result, f.log)['U2 settings S1'], 'FAIL: entries with a password in the settings: ["hosttest"]');
  });

  it('U2: Set as Active Robot is shown by the id Connect (active) was given', () => {
    const f = fixture();
    f.result.u2 = { port: 80, scanList: [], ids: { first: 'hosttest', second: 'hosttest-2', added: null } };
    const s = f.step('U2 connect active (second)', 'abbRobot.connect', () => undefined);
    f.log.push({ ts: new Date(Date.parse(s.start) + 1000).toISOString(), category: 'command', msg: '→ abbRobot.connectRobot', data: { args: ['hosttest-2'] } });
    assert.equal(harness.verdicts(f.result, f.log)['U2 connect active (second)'], 'PASS (Connect (active) connected the second entry hosttest-2)');
    const g = fixture();
    g.result.u2 = f.result.u2;
    const s2 = g.step('U2 connect active (second)', 'abbRobot.connect', () => undefined);
    g.log.push({ ts: new Date(Date.parse(s2.start) + 1000).toISOString(), category: 'command', msg: '→ abbRobot.connectRobot', data: { args: ['hosttest'] } });
    assert.match(harness.verdicts(g.result, g.log)['U2 connect active (second)'], /^FAIL: Connect \(active\) connected \["hosttest"\], want hosttest-2/);
  });

  it('U3: a read passes on the dialog or document it expects, fails on an error dialog, and skips with a reason', () => {
    const f = fixture();
    f.result.u3 = { selections: {}, errors: [], expect: {
      'U3 #108 getControllerClock': { rows: ['#108'], dialog: '^Controller clock: \\d{4}-\\d\\d-\\d\\d T ' },
      'U3 #83 showMotionInfo': { rows: ['#83'], dialog: '.' },
      'U3 #70 listFileVolumes': { rows: ['#70'], document: 'File volumes' },
      'U3 #65 downloadControllerFile': { rows: ['#65', '#66'], skipped: 'no file in HOME, TEMP or BACKUP to download' },
      'U3 #49 searchSymbols': { rows: ['#49'], document: 'symbols in', dialog: 'No symbols in', any: true },
    } };
    f.step('U3 #108 getControllerClock', 'abbRobot.getControllerClock', s => {
      s.ui('info', { text: 'Controller clock: 2026-10-12 T 01:02:03\nABB documents the value as UTC; a virtual controller answers this PC\'s local time.', buttons: ['Copy', 'Set…'], modal: false });
    });
    f.step('U3 #83 showMotionInfo', 'abbRobot.showMotionInfo', s => {
      s.ui('error', { text: `${label}: Show motion info: refused`, buttons: [], modal: false });
    });
    f.step('U3 #70 listFileVolumes', 'abbRobot.listFileVolumes', s => {
      s.ui('document', { languageId: 'plaintext', file: 'Untitled-1', text: '# File volumes\n\n- HOME' });
    });
    f.step('U3 #49 searchSymbols', 'abbRobot.searchSymbols', s => {
      s.ui('info', { text: 'No symbols in T_ROB1.', buttons: [], modal: false });
    });
    const v = harness.verdicts(f.result, f.log);
    assert.match(v['U3 #108 getControllerClock'], /^PASS \(#108; dialog: Controller clock: 2026-10-12 T 01:02:03/);
    assert.match(v['U3 #83 showMotionInfo'], /^FAIL \(#83\): .*Show motion info: refused/);
    assert.match(v['U3 #70 listFileVolumes'], /^PASS \(#70; document: plaintext # File volumes\)/);
    assert.equal(v['U3 #65 downloadControllerFile'], 'SKIPPED (#65 #66): no file in HOME, TEMP or BACKUP to download');
    assert.match(v['U3 #49 searchSymbols'], /^PASS \(#49; dialog: No symbols in T_ROB1\.\)/);
  });

  it('U3: an expected controller answer is EXPECTED, a read the view cannot show is PARTIAL', () => {
    const f = fixture();
    f.result.u3 = { selections: {}, errors: [], expect: {
      'U3 #18 downloadModule': { rows: ['#18'], file: '/nonexistent/x.mod', dialog: 'saved\\.', expectedError: 'HTTP 404 from GET /rw/rapid/.*', reason: 'the module is not loaded' },
      'U3 #64 refreshFiles': { rows: ['#64'], partial: 'the file tree re-reads only while its view is visible' },
    } };
    f.step('U3 #18 downloadModule', 'abbRobot.downloadModule', s => {
      s.ui('error', { text: `${label}: Save RAPID text failed: HTTP 404 from GET /rw/rapid/tasks/T_ROB1/modules/NOPE`, buttons: [], modal: false });
    });
    f.step('U3 #64 refreshFiles', 'abbRobot.refreshFiles', () => undefined);
    const v = harness.verdicts(f.result, f.log);
    assert.match(v['U3 #18 downloadModule'], /^EXPECTED \(#18\): the controller answered the way it must here \(the module is not loaded\)/);
    assert.equal(v['U3 #64 refreshFiles'], 'PARTIAL (#64): the command ran without an error; the file tree re-reads only while its view is visible');
  });

  it('U3: Download Module passes only when the saved file holds the module text', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rapid-live-dl-'));
    try {
      const good = path.join(dir, 'BASE.mod');
      const bad = path.join(dir, 'HTML.mod');
      fs.writeFileSync(good, 'MODULE BASE(SYSMODULE)\nENDMODULE\n');
      fs.writeFileSync(bad, '<html>404</html>');
      const run = (file: string) => {
        const f = fixture();
        f.result.u3 = { selections: {}, errors: [], expect: {
          'U3 #18 downloadModule': { rows: ['#18'], file, fileText: 'MODULE\\s+BASE\\b', dialog: 'saved\\.' },
        } };
        f.step('U3 #18 downloadModule', 'abbRobot.downloadModule', s => {
          s.ui('info', { text: '✓ BASE.mod saved.', buttons: ['Open'], modal: false });
        });
        return harness.verdicts(f.result, f.log)['U3 #18 downloadModule'];
      };
      assert.match(run(good), /^PASS \(#18; .*file text: matches/);
      assert.match(run(bad), /^FAIL \(#18\)/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('U3: the check after Disconnect passes on a free mastership or write access, and fails on a leftover hold', () => {
    const base = (after: Record<string, unknown>) => {
      const f = fixture();
      f.result.u3 = { selections: {}, errors: [], expect: {} };
      f.result.u3after = after;
      return harness.verdicts(f.result, f.log)['U3 after disconnect'];
    };
    assert.match(base({ systemStatus: 200, generation: 'rw7', mastership: { mastership: 'nomaster' } }), /^PASS .*RAPID mastership nomaster/);
    assert.match(base({ systemStatus: 200, generation: 'rw7', mastership: { mastership: 'remote', application: 'RAPID Live' } }), /^FAIL: RAPID mastership is "remote" \(RAPID Live\)/);
    assert.match(base({ systemStatus: 200, generation: 'rw8', writeAccess: { held: false, heldByName: null } }), /^PASS .*write access held false/);
    assert.match(base({ systemStatus: 200, generation: 'rw8', writeAccess: { held: true, heldByName: 'abb-rws-client' } }), /^FAIL: write access is still held by "abb-rws-client"/);
    assert.match(base({ systemStatus: 401, generation: 'rw7', mastership: { mastership: 'nomaster' } }), /^FAIL: GET \/rw\/system answered 401/);
  });

  it('U steps never run with the write steps; a run without a controller is only U1', () => {
    const runner = fs.readFileSync(path.join(root, 'test', 'host', 'run-commands.test.js'), 'utf8');
    assert.ok(runner.includes("const NO_CONTROLLER_RUN = ONLY === 'U1';"));
    const suite = fs.readFileSync(path.join(root, 'test', 'host', 'stub-ext', 'suite.js'), 'utf8');
    assert.ok(suite.includes('the read-only U steps never run together with the write steps A-I'));
    const acceptance = fs.readFileSync(path.join(root, 'test', 'host', 'stub-ext', 'acceptance.js'), 'utf8');
    const written = ['startRapid', 'stopRapid', 'motorsOn', 'motorsOff', 'jog', 'writeSignal', 'toggleSignal', 'lockOpMode', 'unlockOpMode', 'loadCfgFile', 'restartController',
      'restoreBackup', 'createBackup', 'clearEventLog', 'deleteControllerFile', 'setSpeedRatio', 'writeVariable', 'uploadModule', 'pushCurrentFile', 'setOpMode', 'showVirtualTime'];
    for (const c of written) { assert.ok(!acceptance.includes(`'abbRobot.${c}'`), `acceptance.js runs ${c}`); }
  });
});

describe('host harness verdicts: U4, the write commands in AUTO', () => {
  const base = () => {
    const f = fixture();
    f.result.u4 = {
      rows: [] as Array<Record<string, unknown>>, cleanup: ['speed set back to 100'],
      original: { speedRatio: 100, execCycle: 'forever', ctrlstate: 'motoroff', opmode: 'AUTO', execstate: 'stopped', modules: ['BASE'], signal: { name: 'ZZ_PROBE_DO1', lvalue: '0' } },
      final: { speedRatio: 100, execCycle: 'forever', ctrlstate: 'motoroff', opmode: 'AUTO', execstate: 'stopped', modules: ['BASE'], signal: { name: 'ZZ_PROBE_DO1', lvalue: '0' }, programPointer: '/', backups: [] },
    };
    return f;
  };
  const rows = (f: ReturnType<typeof base>) => (f.result.u4 as { rows: Array<Record<string, unknown>> }).rows;

  it('PASS when the read-back agrees, FAIL when it does not or an error dialog came, SKIPPED with its reason', () => {
    const f = base();
    f.step('U4 #26 setSpeedRatio', 'abbRobot.setSpeedRatio', s => { s.ui('info', { text: 'Speed ratio: 50%', buttons: [], modal: false }); });
    rows(f).push({ row: '#26', name: 'U4 #26 setSpeedRatio', ok: true, detail: 'speed 100 -> 50' });
    f.step('U4 #52 writeSignal', 'abbRobot.writeSignal', s => { s.ui('error', { text: `${label}: Write signal: refused`, buttons: [], modal: false }); });
    rows(f).push({ row: '#52', name: 'U4 #52 writeSignal', ok: false, detail: 'ZZ_PROBE_DO1 0 -> 0' });
    rows(f).push({ row: '#68', name: 'U4 #68 createDirectory', skipped: 'no TEMP volume could be listed' });
    const v = harness.verdicts(f.result, f.log);
    assert.equal(v['U4 #26 setSpeedRatio'], 'PASS (#26; speed 100 -> 50; Speed ratio: 50%)');
    assert.match(v['U4 #52 writeSignal'], /^FAIL \(#52\): .*Write signal: refused; ZZ_PROBE_DO1 0 -> 0/);
    assert.equal(v['U4 #68 createDirectory'], 'SKIPPED (#68): no TEMP volume could be listed');
  });

  it('a refusal the row expected is REFUSED, any other refusal is a FAIL', () => {
    const f = base();
    f.step('U4 #21 startRapid', 'abbRobot.startRapid', s => { s.ui('error', { text: `${label}: Starting RAPID: the controller is in guard stop.`, buttons: [], modal: false }); });
    rows(f).push({ row: '#21', name: 'U4 #21 startRapid', ok: true, detail: 'execution stopped', expectRefusal: 'guard stop|Reset', why: 'the controller is in a guard stop' });
    f.step('U4 #22 stopRapid', 'abbRobot.stopRapid', s => { s.ui('error', { text: `${label}: Stopping RAPID: something else`, buttons: [], modal: false }); });
    rows(f).push({ row: '#22', name: 'U4 #22 stopRapid', ok: true, detail: 'execution stopped', expectRefusal: 'guard stop|Reset', why: 'the controller is in a guard stop' });
    const v = harness.verdicts(f.result, f.log);
    assert.match(v['U4 #21 startRapid'], /^REFUSED \(#21\): as expected \(the controller is in a guard stop\); execution stopped; dialog: .*guard stop/);
    assert.match(v['U4 #22 stopRapid'], /^FAIL \(#22\)/);
  });

  it('reports what was not put back, and a controller waiting for Remote Access', () => {
    const f = base();
    (f.result.u4 as { final: Record<string, unknown> }).final.speedRatio = 50;
    assert.equal(harness.verdicts(f.result, f.log)['U4 restored'], 'FAIL: not back as found: speedRatio 100 -> 50');
    const g = fixture();
    g.result.u4 = { rows: [], cleanup: [], original: {}, final: {}, waiting: 'Remote Access is off on this controller (externalControlEnabled false); nothing was written' };
    assert.match(harness.verdicts(g.result, g.log)['U4 waiting'], /^WAITING: Remote Access is off/);
  });
});

describe('host harness verdicts: step D judges the mode refusal on its kind or a stable fragment, not one sentence', () => {
  const D = 'D callServiceRoutine';
  // The two wordings the client has used for the refusal in AUTO.
  const OLD = 'Service routines are called in manual mode; the controller is in AUTO. Switch it to manual (MANR or MANF) and retry.';
  const NEW_RW8 = 'setPPToServiceRoutine: not sent on RobotWare 8 in Auto. The move is held back on RobotWare 8 in Auto until a run shows it works. '
    + 'Move the pointer to the service routine at the FlexPendant, or from this tool in manual mode (MANR or MANF) with write access. '
    + 'The program pointer was not moved.';

  /** Step D as the harness records it: the refusal as a plain warning (the extension's path), nothing sent. */
  function refused(mode: string, text: string, requests: Array<[string, string, number]> = []) {
    const f = fixture();
    f.result.mode = mode;
    f.result.routineWanted = 'SkipTaskExec';
    f.step(D, 'abbRobot.callServiceRoutine', s => {
      s.ui('quickPick', { items: [{ label: 'SkipTaskExec' }] });
      s.ui('answer', { to: 'quickPick', value: 'SkipTaskExec' });
      s.ui('warning', { text, buttons: [], modal: false });
      for (const [m, path, st] of requests) { s.request(m, path, st); }
    });
    return f;
  }
  const verdict = (f: ReturnType<typeof fixture>) => harness.verdicts(f.result, f.log)[D];

  it('rw7 in AUTO, the old sentence: PASS', () => {
    assert.match(verdict(refused('AUTO', OLD, [['GET', '/rw/panel/opmode', 200]])), /^PASS \(refused in AUTO; nothing written; matched on the dialog text\)/);
  });

  it('rw8 in Auto, the new sentence: PASS (this was a false FAIL before)', () => {
    assert.match(verdict(refused('AUTO', NEW_RW8, [['GET', '/rw/panel/opmode', 200]])), /^PASS \(refused in AUTO; nothing written; matched on the dialog text\)/);
  });

  it('a refusal shown as an error is judged on its kind, whatever the wording', () => {
    const f = refused('AUTO', 'Host test: something reworded entirely.');
    const step = f.result.steps.find(x => x.name === D)!;
    f.log.push({ ts: step.start, category: 'error.shown', msg: 'Call service routine', data: { rwsCode: 'WRONG_MODE', refusalKind: 'wrong-state', friendly: 'reworded' } });
    f.log.push({ ts: step.start, category: 'error.shown', msg: 'x', data: {} });
    assert.match(verdict(f), /^PASS \(refused in AUTO; nothing written; matched on the error kind\)/);
  });

  it('FAILs when the refusal came with a pointer move or a write-access request', () => {
    const f = refused('AUTO', NEW_RW8, [['POST', '/rw/rapid/tasks/T_ROB1/pcp/routine', 204]]);
    assert.match(verdict(f), /^FAIL: refused for the mode but sent POST \/rw\/rapid\/tasks\/T_ROB1\/pcp\/routine/);
    const g = refused('AUTO', OLD, [['POST', '/rw/mastership/edit/request', 204]]);
    assert.match(verdict(g), /^FAIL: refused for the mode but sent POST \/rw\/mastership\/edit\/request/);
  });

  it('an unrelated error is still a FAIL, and a normal pointer move still passes', () => {
    assert.match(verdict(refused('MANR', 'Host test: Call service routine failed: HTTP 500.')), /^FAIL: Host test: Call service routine failed/);

    const f = fixture();
    f.result.mode = 'MANR';
    f.result.routineWanted = 'SkipTaskExec';
    f.step(D, 'abbRobot.callServiceRoutine', s => {
      s.ui('quickPick', { items: [{ label: 'SkipTaskExec' }] });
      s.ui('answer', { to: 'quickPick', value: 'SkipTaskExec' });
      s.ui('info', { text: 'Program pointer set to SkipTaskExec (BASEFUN). Start RAPID to run the service routine.', buttons: [], modal: false });
      s.readback('program pointer before', { module: 'ZZ_PROBE', routine: 'ZZ_PROBE_LOOP' });
      s.readback('program pointer after', { module: 'BASEFUN', routine: 'SkipTaskExec' });
    });
    assert.match(verdict(f), /^PASS \(picked SkipTaskExec from 1 listed; PP ZZ_PROBE\/ZZ_PROBE_LOOP -> BASEFUN\/SkipTaskExec; not started\)/);
  });

  it('modeRefusalIn: the fragment match ignores a pointer-set notification that merely mentions a mode', () => {
    const fn = (harness as unknown as { modeRefusalIn(l: unknown[], t: string[]): unknown }).modeRefusalIn;
    assert.equal(fn([], ['Program pointer set to Main (manual mode run). Start RAPID.']), undefined);
    assert.ok(fn([], [NEW_RW8]));
  });
});

describe('host harness report and wiring', () => {
  it('the report table carries the dialog texts of each step', () => {
    const f = fixture();
    f.step('G loadCfgFile cancel', 'abbRobot.loadCfgFile', s => {
      s.ui('warning', { text: `Load CFG file on ${label}`, detail: '• x', buttons: [`Continue on ${ROBOT}`], modal: true });
    });
    f.result.before = 'GET /rw/system -> 200'; f.result.after = 'GET /rw/system -> 200';
    const rows: Row[] = [{ step: 'G loadCfgFile cancel', command: 'abbRobot.loadCfgFile', dialogs: harness.dialogsIn(f.result, 'G loadCfgFile cancel'), requests: [], verdict: 'PASS' }];
    const md = harness.report({ url: 'https://127.0.0.1:80' }, f.result, f.log, rows);
    assert.match(md, /\| Step \| Command \| Dialogs \| Requests sent \| Status \| Verdict \|/);
    assert.match(md, new RegExp(`\\| G loadCfgFile cancel \\| abbRobot.loadCfgFile \\| modal warning: Load CFG file on ${ROBOT.replace(' ', ' ')} \\(127.0.0.1:80\\) / • x \\[Continue on ${ROBOT}\\] \\| \\(none\\) \\| - \\| PASS \\|`));
  });

  it('npm test never runs the host harness; npm run test:host does, and skips itself without a controller', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(manifest.scripts['test:host'], 'node --test test/host/run-commands.test.js');
    assert.doesNotMatch(manifest.scripts.test, /host/);
    const build = fs.readFileSync(path.join(root, 'build.js'), 'utf8');
    assert.match(build, /entryPoints: \['test\/\*\.test\.ts'\]/);
    const runner = fs.readFileSync(path.join(root, 'test', 'host', 'run-commands.test.js'), 'utf8');
    assert.match(runner, /skip: NO_VC/);
    assert.match(runner, /no VC: skipped/);
    // U1 needs no controller and runs without RWS_TEST_HOST.
    assert.match(runner, /const NO_CONTROLLER_RUN = ONLY === 'U1';/);
    assert.match(runner, /const NO_VC = TARGET \|\| NO_CONTROLLER_RUN \? false : /);
    const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.doesNotMatch(ci, /RWS_TEST_HOST:/, 'CI has no controller');
    // vendor/ is not in git: each job packs the client at CLIENT_REF before npm ci.
    const buildJob = ci.slice(ci.indexOf('\n  build:'), ci.indexOf('\n  host:'));
    const host = ci.slice(ci.indexOf('\n  host:'));
    for (const job of [buildJob, host]) {
      assert.match(job, /checkout --detach "\$CLIENT_REF"/);
      assert.ok(job.indexOf('- run: npm run vendor') >= 0 && job.indexOf('- run: npm run vendor') < job.indexOf('- run: npm ci'));
    }
    // The host job: the plain run (every controller step skips itself), then the packaged
    // .vsix and step U1 in VS Code for Linux under xvfb, and a summary of what ran.
    assert.match(host, /^\n  host:\n    runs-on: ubuntu-latest\n/);
    const plain = host.indexOf('        run: npm run test:host\n');
    const pack = host.indexOf('        run: npm run package\n');
    const u1 = host.indexOf('        run: xvfb-run -a npm run test:host\n');
    assert.ok(plain > 0 && pack > plain && u1 > pack, 'plain run, package, then U1 under xvfb');
    const u1Step = host.slice(host.lastIndexOf('      - name:', u1), u1);
    assert.match(u1Step, /RWS_TEST_ONLY: U1\n/);
    assert.match(u1Step, /VSCODE_EXE: \$\{\{ runner\.temp \}\}\/VSCode-linux-x64\/code\n/);
    assert.match(u1Step, /RWS_TEST_VSCODE_ARGS: --no-sandbox --disable-gpu --password-store=basic\n/);
    assert.match(host, /GITHUB_STEP_SUMMARY/);
    assert.match(host, /steps\.u1\.outcome/);
    // CI packs the client at the release tag of the version the pin names, which the
    // public client repository carries.
    const pin = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> })
      .dependencies['abb-rws-client'];
    const pinned = /^file:vendor\/abb-rws-client-(\d+\.\d+\.\d+)\.tgz$/.exec(pin);
    assert.ok(pinned, `unexpected client pin ${pin}`);
    assert.ok(ci.includes(`\n  CLIENT_REF: v${pinned[1]}\n`), `CLIENT_REF is not v${pinned[1]}, the tag of the pinned client`);
    // ...and CLIENT_INTEGRITY is the lock's integrity of that tarball, which the vendor
    // step checks the packed one against (scripts/vendor.mjs), so the three move together.
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string }> };
    const integrity = lock.packages['node_modules/abb-rws-client']?.integrity;
    assert.ok(integrity, 'the lock names an integrity for abb-rws-client');
    assert.ok(ci.includes(`\n  CLIENT_INTEGRITY: ${integrity}\n`), `CLIENT_INTEGRITY is not the lock's ${integrity}`);
  });
});
