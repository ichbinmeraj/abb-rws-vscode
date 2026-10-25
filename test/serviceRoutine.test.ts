import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RwsError, type RwsRefusal } from 'abb-rws-client';
import {
  callServiceRoutine, modeRefusal, pointToServiceRoutine, serviceRoutineTarget,
  type ServiceRoutineRobot, type ServiceRoutineUi,
} from '../src/serviceRoutine';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

describe('Call Service Routine', () => {
  it('is still a contributed command', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    assert.ok(manifest.contributes.commands.some(c => c.command === 'abbRobot.callServiceRoutine'));
  });

  it('reads the routine and its module from the listing URL', () => {
    assert.deepEqual(serviceRoutineTarget('RAPID/T_ROB1/BASE/Home', 'Home'), { routineName: 'Home', moduleName: 'BASE' });
    assert.deepEqual(serviceRoutineTarget('', 'Home'), { routineName: 'Home', moduleName: undefined });
  });

  it('moves the pointer through setPPToServiceRoutine (task, routine, module), never setPPToRoutine', async () => {
    const calls: unknown[][] = [];
    const active = {
      setPPToServiceRoutine: async (...args: unknown[]) => { calls.push(['service', ...args]); },
      setPPToRoutine: async (...args: unknown[]) => { calls.push(['plain', ...args]); },
    };
    await pointToServiceRoutine(active, 'T_ROB1', { routineName: 'Home', moduleName: 'BASE' }, true);
    assert.deepEqual(calls, [['service', 'T_ROB1', 'Home', 'BASE', { stopIfRunning: true }]]);
  });

  it('the command in extension.ts goes through callServiceRoutine and modeRefusal', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.callServiceRoutine'");
    assert.ok(start >= 0);
    const end = src.indexOf('tracedCommand(', start + 1);
    const body = src.slice(start, end);
    assert.match(body, /callServiceRoutine\(active,/);
    assert.match(body, /modeRefusal\(/);
    assert.doesNotMatch(body, /setPPToRoutine\(/);
  });

  // A robot double that records every controller request the flow makes.
  function robot(onMove?: () => Promise<void>) {
    const calls: unknown[][] = [];
    const active: ServiceRoutineRobot = {
      listServiceRoutines: async (task: string) => { calls.push(['list', task]); return [{ name: 'Home', url: 'RAPID/T_ROB1/BASE/Home' }]; },
      setPPToServiceRoutine: async (...args: unknown[]) => { calls.push(['service', ...args]); await onMove?.(); },
    };
    return { active, calls };
  }
  function ui() {
    const shown: string[] = [];
    const u: ServiceRoutineUi = {
      pick: async items => items[0],
      info: m => { shown.push(`info:${m}`); },
      warn: m => { shown.push(`warn:${m}`); },
      movePointer: async run => { await run(false); return true; },
    };
    return { u, shown };
  }

  // The same flow on every generation: RWS 2.0 (RobotWare 7 and 8) moves the
  // pointer through setPPToServiceRoutine like RWS 1.0 does.
  it('lists, then moves the pointer through setPPToServiceRoutine, on every generation', async () => {
    const { active, calls } = robot();
    const { u, shown } = ui();
    await callServiceRoutine(active, 'T_ROB1', u);
    assert.deepEqual(calls, [['list', 'T_ROB1'], ['service', 'T_ROB1', 'Home', 'BASE', { stopIfRunning: false }]]);
    assert.deepEqual(shown, ['info:Program pointer set to Home (BASE). Start RAPID to run the service routine.']);
  });

  it('has no generation hold-back left in serviceRoutine.ts', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'serviceRoutine.ts'), 'utf8');
    assert.doesNotMatch(src, /HELD_BACK|HeldBack|generation/);
  });

  it('RobotWare 8 in AUTO: the client\'s hold reaches the command, and modeRefusal gives its sentence', async () => {
    const sentence = 'setPPToServiceRoutine: not sent on RobotWare 8 in Auto. The move is held back on RobotWare 8 in Auto until a run shows it works. '
      + 'Move the pointer to the service routine at the FlexPendant, or from this tool in manual mode (MANR or MANF) with write access. The program pointer was not moved.';
    const refusal = {
      kind: 'wrong-state', condition: 'operating-mode', grantor: 'key-switch', generation: 'rw8',
      missing: 'a manual operating mode (MANR or MANF)', fix: 'Switch to manual mode.', sentence, evidence: 'abb',
    } as unknown as RwsRefusal;
    const { active, calls } = robot(async () => {
      throw new RwsError(sentence, 'WRONG_MODE', undefined, undefined, undefined, undefined, refusal);
    });
    const { u, shown } = ui();
    const err = await callServiceRoutine(active, 'T_ROB1', u).then(() => undefined, (e: unknown) => e);
    assert.equal(modeRefusal(err), sentence);
    assert.deepEqual(calls, [['list', 'T_ROB1'], ['service', 'T_ROB1', 'Home', 'BASE', { stopIfRunning: false }]]);
    assert.deepEqual(shown, []);
  });

  it('shows the WRONG_MODE sentence the controller\'s own mode refusal carries', () => {
    const sentence = 'setPPToServiceRoutine: the controller refused the program pointer move in this operating mode (MODE_REJECT). '
      + 'ABB allows a remote client to move it in Auto; in manual only with RMMP exec on RobotWare 7. The program pointer was not moved.';
    const refusal = {
      kind: 'wrong-state', condition: 'operating-mode', grantor: 'key-switch', generation: 'rw8',
      missing: 'a manual operating mode (MANR or MANF)', fix: 'Switch to manual mode.', sentence, evidence: 'abb',
    } as unknown as RwsRefusal;
    const e = new RwsError(sentence, 'WRONG_MODE', undefined, undefined, undefined, undefined, refusal);
    assert.equal(modeRefusal(e), sentence);
  });

  it('the extension puts no mode check of its own before the call: in AUTO on RobotWare 6 and 7 the controller decides', async () => {
    const { active, calls } = robot();
    const { u, shown } = ui();
    // No operating mode is passed or read anywhere in the flow; the pointer move is sent as picked.
    await callServiceRoutine(active, 'T_ROB1', u);
    assert.deepEqual(calls, [['list', 'T_ROB1'], ['service', 'T_ROB1', 'Home', 'BASE', { stopIfRunning: false }]]);
    assert.deepEqual(shown, ['info:Program pointer set to Home (BASE). Start RAPID to run the service routine.']);
    const src = fs.readFileSync(path.join(root, 'src', 'serviceRoutine.ts'), 'utf8');
    assert.doesNotMatch(src, /opmode|getOperationMode|MANR or MANF and the routine/);
    assert.doesNotMatch(src, /Outside manual mode the client refuses/);
  });

  it('leaves every other error to the general error path', () => {
    const running = {
      kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool', generation: 'rw7',
      missing: 'a stopped RAPID program', fix: 'Stop the program first.', sentence: 'running', evidence: 'abb',
    } as unknown as RwsRefusal;
    assert.equal(modeRefusal(new RwsError('running', 'WRONG_MODE', undefined, undefined, undefined, undefined, running)), undefined);
    assert.equal(modeRefusal(new RwsError('not listed', 'INVALID_ARGUMENT')), undefined);
    assert.equal(modeRefusal(new Error('network')), undefined);
    assert.equal(modeRefusal(undefined), undefined);
  });
});
