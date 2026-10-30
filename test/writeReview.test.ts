import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isRapidRunning, jogNeedsAsk, opModeRequest, programChangeRequest, speedRatioRequest, virtualOnlyRequest,
} from '../src/confirm';
import { duplicateRobotNames, entryForArg, extractRobotId } from '../src/robotArg';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

/** The body of one command's handler, up to the next registered command. */
function handler(id: string): string {
  const start = src.indexOf(`tracedCommand('${id}'`);
  assert.ok(start >= 0, `${id} is registered`);
  const next = src.indexOf('tracedCommand(', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe('which robot a command is for', () => {
  const entries = [{ id: 'a' }, { id: 'b' }];

  it('reads an id from a string or an object with an id', () => {
    assert.equal(extractRobotId('b'), 'b');
    assert.equal(extractRobotId({ id: 'b' }), 'b');
    assert.equal(extractRobotId({ label: 'x' }), undefined);
    assert.equal(extractRobotId(undefined), undefined);
  });

  it('the argument decides, even when another robot is active', () => {
    assert.deepEqual(entryForArg(entries, 'a', 'b'), { id: 'b' });
    assert.deepEqual(entryForArg(entries, 'a', { id: 'b' }), { id: 'b' });
  });

  it('with no argument the active robot is used; with neither there is none', () => {
    assert.deepEqual(entryForArg(entries, 'a'), { id: 'a' });
    assert.equal(entryForArg(entries, undefined), undefined);
  });

  it('a named robot that is gone is never replaced by the active one', () => {
    assert.equal(entryForArg(entries, 'a', 'gone'), undefined);
  });

  it('a row can connect with no active robot, and a failed connect edits the row, not the active robot', () => {
    const connect = handler('abbRobot.connectRobot');
    assert.doesNotMatch(connect, /activeEntry\(multi\)/);
    assert.match(connect, /extractRobotId\(arg\) \?\? multi\.activeId/);
    assert.match(connect, /executeCommand\('abbRobot\.configure', targetId\)/);
    assert.doesNotMatch(handler('abbRobot.disconnectRobot'), /activeEntry\(multi\)/);
    const configure = handler('abbRobot.configure');
    assert.match(configure, /async \(arg\?: unknown\)/);
    assert.match(configure, /entryOf\(multi, arg\)/);
  });
});

describe('follow-up actions stay on the robot that asked', () => {
  it('Restart Now and the clock Set… pass the robot id', () => {
    assert.match(handler('abbRobot.createRapidTask'), /executeCommand\('abbRobot\.restartController', entry\.id\)/);
    assert.match(handler('abbRobot.getControllerClock'), /executeCommand\('abbRobot\.setControllerClock', entry\.id\)/);
    for (const id of ['abbRobot.restartController', 'abbRobot.setControllerClock', 'abbRobot.getControllerClock']) {
      assert.match(handler(id), /entryOf\(multi, arg\)/, id);
    }
  });

  it('Create RAPID Task asks through the send wrapper, disruptive, and has no dialog of its own', () => {
    const body = handler('abbRobot.createRapidTask');
    assert.doesNotMatch(body, /showWarningMessage\(\s*`Create task/);
    assert.match(body, /await sendTo\(entry, \{\s*label: `Create RAPID task/);
    assert.match(body, /tier: 'disruptive'/);
    assert.doesNotMatch(body, /const confirm = /);
  });
});

describe('confirmations for the writes that had none', () => {
  it('Set Speed Ratio is a change, and disruptive only when raising it while RAPID runs', () => {
    assert.equal(speedRatioRequest(50, 80, false).tier, 'change');
    assert.equal(speedRatioRequest(50, 30, true).tier, 'change');
    assert.equal(speedRatioRequest(50, 50, true).tier, 'change');
    // Unread (review finding 12): no number is made up, and while RAPID runs any value may be a speed-up.
    const unread = speedRatioRequest(null, 100, true);
    assert.equal(unread.tier, 'disruptive');
    assert.deepEqual(unread.sideEffects, ['Changes the speed ratio from an unread value to 100 %.', 'RAPID is running and the current ratio is not read: a motion in progress may go faster.']);
    const unreadStopped = speedRatioRequest(null, 10, false);
    assert.equal(unreadStopped.tier, 'change');
    assert.deepEqual(unreadStopped.sideEffects, ['Changes the speed ratio from an unread value to 10 %.']);
    assert.match(handler('abbRobot.setSpeedRatio'), /const current = entry\.manager\.state\.speedRatio;/);
    assert.doesNotMatch(handler('abbRobot.setSpeedRatio'), /\?\? 100/);
    const raise = speedRatioRequest(50, 80, true);
    assert.equal(raise.tier, 'disruptive');
    assert.match(raise.sideEffects.join(' '), /goes faster/);
    assert.match(raise.sideEffects[0], /from 50 % to 80 %/);
    assert.match(handler('abbRobot.setSpeedRatio'), /speedRatioRequest\(/);
  });

  it('Switch Operation Mode is disruptive and says it is for a virtual controller', () => {
    const r = opModeRequest('MANR', 'AUTO');
    assert.equal(r.tier, 'disruptive');
    assert.match(r.sideEffects.join(' '), /from MANR to AUTO/);
    assert.match(r.sideEffects.join(' '), /Virtual controller only/);
    assert.match(handler('abbRobot.setOpMode'), /opModeRequest\(/);
  });

  it('virtual-time, teleport and the simulated stops and enable switch are disruptive and say virtual only', () => {
    const r = virtualOnlyRequest('Simulate E-Stop', ['Engages it.']);
    assert.equal(r.tier, 'disruptive');
    assert.equal(r.sideEffects[r.sideEffects.length - 1], 'Virtual controller only.');
    for (const id of [
      'abbRobot.showVirtualTime', 'abbRobot.teleportRobot', 'abbRobot.simEStop', 'abbRobot.simResetEStop',
      'abbRobot.simGeneralStop', 'abbRobot.simAutoStop', 'abbRobot.simEnableSwitch',
    ]) {
      assert.match(handler(id), /virtualOnlyRequest\(/, id);
    }
  });

  it('a pointer move always asks as a change and an unload as disruptive, each naming the task and saying first when RAPID runs', () => {
    const r = programChangeRequest('Unload module', true, 'disruptive', ['Unloads Foo from T_ROB1.'], 'T_ROB1');
    assert.equal(r.tier, 'disruptive');
    assert.equal(r.sideEffects[0], 'RAPID is running.');
    assert.equal(programChangeRequest('Unload module', false, 'disruptive', ['x'], 'T_ROB1').sideEffects[0], 'x');
    assert.equal(isRapidRunning('running'), true);
    assert.equal(isRapidRunning('stopped'), false);
    assert.equal(isRapidRunning(null), false);
    for (const id of ['abbRobot.setPPToRoutine', 'abbRobot.callServiceRoutine']) {
      assert.match(handler(id), /sendTo\(entry,\s*programChangeRequest\('Set PP to (service )?routine', isRapidRunning\([^)]*\), 'change', /, id);
    }
    assert.match(handler('abbRobot.unloadModule'), /sendTo\(entry,\s*programChangeRequest\('Unload module', isRapidRunning\([^)]*\), 'disruptive', /);
    assert.doesNotMatch(src, /whileRunningRequest/);
  });
});

describe('smaller review fixes', () => {
  it('the jog confirmation is asked again when the axis value is raised, the unit changes or the labels change; the unit is sent (review finding 11)', () => {
    const j = (value: number, unit = 'ROB_1', labels = 'Joint') => ({ value, unit, labels });
    assert.equal(jogNeedsAsk(undefined, j(1)), true);
    assert.equal(jogNeedsAsk(j(1), j(1)), false);
    assert.equal(jogNeedsAsk(j(5), j(1)), false);
    assert.equal(jogNeedsAsk(j(1), j(5)), true);
    assert.equal(jogNeedsAsk(j(1), j(1, 'ROB_2')), true);
    assert.equal(jogNeedsAsk(j(1), j(1, 'rob_1')), false, 'unit names compare without case');
    assert.equal(jogNeedsAsk(j(1), j(1, 'ROB_1', 'Cartesian')), true);
    const jog = handler('abbRobot.jog');
    assert.match(jog, /const mechunit = await mechunitFor\(entry, 'Jog'\);\s*if \(!mechunit\) \{ return; \}/);
    assert.match(jog, /const now: JogConfirmed = \{ value: inc, unit: mechunit, labels: mode \};\s*const ask = jogNeedsAsk\(jogConfirmed\.get\(entry\.id\), now\)/);
    assert.match(jog, /entry\.manager\.jog\(\{ mode, axes, speed, mechunit \}\)/);
    assert.match(jog, /jogConfirmed\.set\(entry\.id, now\)/);
  });

  it('a signal search that returns after a robot switch is not pinned under the new robot', () => {
    const body = handler('abbRobot.searchSignals');
    const guard = body.indexOf('!isActiveEntry(multi, entry)');
    const pin = body.indexOf('ioProvider.setSearch(');
    assert.ok(guard >= 0 && pin > guard, 'the active-robot check comes before the pin');
  });

  it('Set PP from CodeLens uses the lens document, read before any prompt', () => {
    const body = handler('abbRobot.setPPFromCodeLens');
    assert.match(body, /lensFile\?: unknown/);
    assert.ok(body.indexOf('const lensPath') < body.indexOf('showWarningMessage'));
    assert.doesNotMatch(body, /const editor = vscode\.window\.activeTextEditor/);
    const provider = fs.readFileSync(path.join(root, 'src', 'RapidCodeLensProvider.ts'), 'utf8');
    assert.equal((provider.match(/arguments: \[moduleName, name, kind, document\.fileName\]/g) ?? []).length, 2);
  });

  it('the stop offer names the robot; the main-collision unload is a disruptive ask naming the task and both modules (the dialog names the robot)', () => {
    assert.match(src, /async function withStopOffer<T>\(what: string, fn: \(stopIfRunning: boolean\) => Promise<T>, entry: RobotEntry\)/);
    assert.ok(src.includes('`${what} on ${robotLabel(confirmRobotOf(entry))}: the RAPID program is running. Stop the program first?`'));
    const collision = src.slice(src.indexOf('async function tryResolveMainCollision('), src.indexOf('async function wrap('));
    assert.match(collision, /sendTo\(entry, \{\s*label: `Unload \$\{mod\}`, tier: 'disruptive', taskApplies: true, task: taskName,/);
    assert.ok(collision.includes('`Two modules in ${taskName} declare PROC main(): ${currentModule} and ${mod}. RAPID needs exactly one, so the controller refused the pointer move.`'));
    assert.doesNotMatch(collision, /showWarningMessage\(/);
  });

  it('two saved robots with one name are reported, without case or surrounding spaces', () => {
    assert.deepEqual(duplicateRobotNames([{ name: 'Cell 3' }, { name: 'cell 3 ' }, { name: 'Cell 4' }]), ['Cell 3']);
    assert.deepEqual(duplicateRobotNames([{ name: 'A' }, { name: 'B' }, { name: '' }, { name: ' ' }]), []);
    assert.match(src, /duplicateRobotNames\(configs\)/);
  });
});
