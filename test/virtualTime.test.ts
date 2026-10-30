import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  VIRTUAL_TIME_ACTIONS, VIRTUAL_TIME_NO_PAUSE, VIRTUAL_TIME_NOT_SET_RW6, virtualTimeActionsFor,
  virtualTimeNotice, virtualTimeScaleFor, virtualTimeSummary, virtualTimeWritable,
} from '../src/virtualTime';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

describe('Show / Control Virtual Time', () => {
  it('offers the speed actions only: no pause, no resume', () => {
    assert.deepEqual([...VIRTUAL_TIME_ACTIONS], ['Set scale 1x', 'Set scale 10x']);
    for (const a of VIRTUAL_TIME_ACTIONS) { assert.doesNotMatch(a, /pause|resume/i); }
  });

  it('says in one line that pause and resume are not offered, and where the clock is controlled', () => {
    assert.equal(VIRTUAL_TIME_NO_PAUSE,
      "Pause and resume are not offered: RobotStudio's Simulation tab controls the virtual clock.");
    assert.doesNotMatch(VIRTUAL_TIME_NO_PAUSE, /\n/);
  });

  it('shows time in seconds, state, speed and the note', () => {
    assert.equal(virtualTimeSummary({ time: 12345, running: true, speed: 10, state: 'VTFREERUN' }),
      `Virtual time: 12.3 s - running, 10x (VTFREERUN). ${VIRTUAL_TIME_NO_PAUSE}`);
    assert.equal(virtualTimeSummary({ time: 0, running: false, speed: Infinity }),
      `Virtual time: 0.0 s - paused, full speed. ${VIRTUAL_TIME_NO_PAUSE}`);
    assert.equal(virtualTimeSummary({ time: 1000, running: true }),
      `Virtual time: 1.0 s - running. ${VIRTUAL_TIME_NO_PAUSE}`);
  });

  it('the speed actions name the scale to set; anything else sends nothing', () => {
    assert.equal(virtualTimeScaleFor('Set scale 1x'), 1);
    assert.equal(virtualTimeScaleFor('Set scale 10x'), 10);
    assert.equal(virtualTimeScaleFor(undefined), undefined);
    assert.equal(virtualTimeScaleFor('Pause/Resume'), undefined);
  });

  it('the command in extension.ts goes through the module and never calls setVirtualTimeRunning', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.showVirtualTime'");
    assert.ok(start >= 0);
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.ok(body.includes("virtualTimeActionsFor(gen)"));
    assert.ok(body.includes("virtualTimeNotice(vt, gen)"));
    assert.match(body, /const scale = virtualTimeScaleFor\(action, gen\);\s*if \(scale === undefined\) \{ return; \}/);
    assert.match(body, /sendTo\(entry, virtualOnlyRequest\(action, [\s\S]*?\(\) => m\.setVirtualTimeScale\(scale\)\)/);
    assert.doesNotMatch(body, /Pause|Resume|setVirtualTimeRunning/);
    assert.doesNotMatch(src, /setVirtualTimeRunning/);
  });
});

describe('Virtual Time on RobotWare 6: RAPID Live does not set it in this release', () => {
  const vt = { time: 12345, running: true, speed: 10, state: 'VTFREERUN' };

  it('says in one line that RAPID Live does not set it, and where to change the speed', () => {
    assert.equal(VIRTUAL_TIME_NOT_SET_RW6,
      'RAPID Live does not set virtual time on RobotWare 6 in this release; change the simulation speed in RobotStudio.');
    assert.doesNotMatch(VIRTUAL_TIME_NOT_SET_RW6, /\n/);
  });

  it('does not call it read-only and gives no reason: ABB\'s RWS 1.0 documents the speed write', () => {
    assert.doesNotMatch(VIRTUAL_TIME_NOT_SET_RW6, /read-only|because|cannot|not supported/i);
    // The vendored client holds the same line: it sends no virtual-time write on RobotWare 6.
    const clientReadme = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'README.md'), 'utf8');
    assert.match(clientReadme, /RobotWare 6: the client sends no virtual-time write in this release\. `setVirtualTimeScale` is refused before sending, although ABB's RWS 1\.0 documents the speed write/);
    const src = fs.readFileSync(path.join(root, 'src', 'virtualTime.ts'), 'utf8');
    assert.doesNotMatch(src, /read-only/);
  });

  it('RobotWare 6 offers no write action; RobotWare 7 and 8 still offer 1x and 10x', () => {
    assert.deepEqual([...virtualTimeActionsFor('rw6')], []);
    assert.deepEqual([...virtualTimeActionsFor('rw7')], ['Set scale 1x', 'Set scale 10x']);
    assert.deepEqual([...virtualTimeActionsFor('rw8')], ['Set scale 1x', 'Set scale 10x']);
    assert.equal(virtualTimeWritable('rw6'), false);
    assert.equal(virtualTimeWritable('rw7'), true);
    assert.equal(virtualTimeWritable('rw8'), true);
  });

  it('a generation that is not known yet offers nothing to write either', () => {
    assert.deepEqual([...virtualTimeActionsFor(null)], []);
    assert.deepEqual([...virtualTimeActionsFor(undefined)], []);
  });

  it('a generation that is not known yet shows the reading and says nothing about RobotWare 6', () => {
    for (const gen of [null, undefined]) {
      const t = virtualTimeNotice(vt, gen);
      assert.equal(t, virtualTimeSummary(vt));
      assert.doesNotMatch(t, /RobotWare 6/);
      assert.ok(!t.includes(VIRTUAL_TIME_NOT_SET_RW6));
    }
  });

  it('the RobotWare 6 notice shows the state and the sentence, not the pause note', () => {
    const t = virtualTimeNotice(vt, 'rw6');
    assert.equal(t, `Virtual time: 12.3 s - running, 10x (VTFREERUN). ${VIRTUAL_TIME_NOT_SET_RW6}`);
    assert.doesNotMatch(t, /Pause and resume/);
  });

  it('the RobotWare 7 and 8 notice is the one it was', () => {
    assert.equal(virtualTimeNotice(vt, 'rw7'), virtualTimeSummary(vt));
    assert.equal(virtualTimeNotice(vt, 'rw8'), virtualTimeSummary(vt));
  });

  it('a command still invoked on RobotWare 6 sends nothing, whatever action it carries', () => {
    assert.equal(virtualTimeScaleFor('Set scale 1x', 'rw6'), undefined);
    assert.equal(virtualTimeScaleFor('Set scale 10x', 'rw6'), undefined);
    assert.equal(virtualTimeScaleFor('Set scale 10x', null), undefined);
    assert.equal(virtualTimeScaleFor('Set scale 10x', 'rw7'), 10);
  });

  it('the command reads the generation of the robot it acts on', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.showVirtualTime'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.ok(body.includes("generationOf(entry.manager.state)"));
  });
});
