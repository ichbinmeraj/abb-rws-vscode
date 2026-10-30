import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  programChangeRequest, sendConfirmed, sendReducing, taskWords, writeTrace,
  type ConfirmRequest, type ConfirmRobot, type GuardUi,
} from '../src/confirm';

const cell: ConfirmRobot = { name: 'Cell 3', host: '10.0.5.20', port: 80, reportedName: 'Cell 3' };

/** A window double that records every dialog and log line and answers from a script. */
function ui(answers: {
  modal?: (message: string, detail: string, buttons: string[]) => string | undefined;
  input?: (title: string, prompt: string) => string | undefined;
  refuse?: (label: string) => string | undefined;
  strict?: boolean;
} = {}) {
  const shown: Array<Record<string, unknown>> = [];
  const log: string[] = [];
  const u: GuardUi = {
    modal: async (message, detail, buttons) => { shown.push({ kind: 'modal', message, detail, buttons }); return answers.modal?.(message, detail, buttons); },
    input: async (title, prompt, placeHolder) => { shown.push({ kind: 'input', title, prompt, placeHolder }); return answers.input?.(title, prompt); },
    warn: message => { shown.push({ kind: 'warn', message }); },
    log: line => { log.push(line); },
    strict: answers.strict,
    refuse: (label: string) => answers.refuse?.(label),
  };
  return { u, shown, log };
}

/** A write that counts its calls and answers with a value. */
function write<T>(value: T) {
  let calls = 0;
  return { send: async () => { calls++; return value; }, calls: () => calls };
}

describe('sendConfirmed: the write runs only after the confirmation', () => {
  const request: ConfirmRequest = { label: 'Write user.reg1', tier: 'change', taskApplies: true, task: 'T_ROB2', sideEffects: ['Sets user.reg1 to 7 in T_ROB2.'] };

  it('confirmed: sends once, after one trace line, and hands back the write\'s result', async () => {
    const { u, shown, log } = ui({ modal: () => 'Write to Cell 3' });
    const w = write('ok');
    const out = await sendConfirmed(u, cell, request, w.send);
    assert.deepEqual(out, { sent: true, value: 'ok' });
    assert.equal(w.calls(), 1);
    assert.deepEqual(log, ['write Write user.reg1 robot=Cell 3 task=T_ROB2 tier=change']);
    assert.deepEqual(shown, [{
      kind: 'modal',
      message: 'Write user.reg1 in T_ROB2 on Cell 3 (10.0.5.20:80)',
      detail: 'Task: T_ROB2\n• Sets user.reg1 to 7 in T_ROB2.',
      buttons: ['Write to Cell 3'],
    }]);
  });

  it('cancelled or dismissed: sends nothing, logs nothing, says why', async () => {
    const { u, log } = ui({ modal: () => undefined });
    const w = write('ok');
    assert.deepEqual(await sendConfirmed(u, cell, request, w.send), { sent: false, why: 'cancelled' });
    assert.equal(w.calls(), 0);
    assert.deepEqual(log, []);
  });

  it('the second button (alt) sends nothing and says so', async () => {
    const alt: ConfirmRequest = { label: 'Start RAPID', tier: 'motion', taskApplies: true, tasks: ['T_ROB1'], sideEffects: ['Starts.'], altButton: 'Allow Motion Control first…', altHint: 'To allow first, choose it.' };
    const { u } = ui({ modal: () => 'Allow Motion Control first…', input: () => { throw new Error('not asked'); } });
    const w = write(undefined);
    assert.deepEqual(await sendConfirmed(u, cell, alt, w.send), { sent: false, why: 'alt' });
    assert.equal(w.calls(), 0);
  });

  it('a wrong typed name on the motion tier sends nothing', async () => {
    const motion: ConfirmRequest = { label: 'Motors On', tier: 'motion', taskApplies: false, sideEffects: ['Turns the motors on.'] };
    const { u, shown } = ui({ modal: () => 'Continue', input: () => 'Cell 4' });
    const w = write(undefined);
    assert.deepEqual(await sendConfirmed(u, cell, motion, w.send), { sent: false, why: 'cancelled' });
    assert.equal(w.calls(), 0);
    assert.equal(shown[shown.length - 1].kind, 'warn');
  });

  it('the write\'s own error is the caller\'s: it propagates after the trace line', async () => {
    const { u, log } = ui({ modal: () => 'Write to Cell 3' });
    await assert.rejects(sendConfirmed(u, cell, request, async () => { throw new Error('refused by the controller'); }), /refused by the controller/);
    assert.equal(log.length, 1);
  });

  it('an ask of its own (the motion loop) decides instead of the plain dialog', async () => {
    const { u, shown, log } = ui({ modal: () => { throw new Error('the plain dialog must not show'); } });
    const asked: string[] = [];
    const w = write(1);
    const out = await sendConfirmed(u, cell, request, w.send, { ask: async (_ui, robot, req) => { asked.push(`${req.label} on ${robot.name}`); return 'confirmed'; } });
    assert.deepEqual(out, { sent: true, value: 1 });
    assert.deepEqual(asked, ['Write user.reg1 on Cell 3']);
    assert.deepEqual(shown, []);
    assert.equal(log.length, 1);
  });
});

describe('sendConfirmed: the task', () => {
  it('a request that says a task applies and names none sends nothing: a warning in the extension, a throw in strict tests', async () => {
    const bad: ConfirmRequest = { label: 'Set PP to routine', tier: 'change', taskApplies: true, sideEffects: ['Moves the pointer.'] };
    const { u, shown, log } = ui({ modal: () => { throw new Error('no dialog'); } });
    const w = write(undefined);
    assert.deepEqual(await sendConfirmed(u, cell, bad, w.send), { sent: false, why: 'no-task' });
    assert.equal(w.calls(), 0);
    assert.deepEqual(shown, [{ kind: 'warn', message: 'Set PP to routine not sent: no task was named. This is a fault in RAPID Live; the log has the details.' }]);
    assert.match(log[0], /names none/);
    const strict = ui({ strict: true });
    await assert.rejects(sendConfirmed(strict.u, cell, bad, w.send), /no task was named/);
    assert.equal(w.calls(), 0);
  });

  it('an empty task list counts as none', async () => {
    const bad: ConfirmRequest = { label: 'PP to Main', tier: 'disruptive', taskApplies: true, tasks: [], sideEffects: ['Moves.'] };
    const { u } = ui({ strict: true });
    await assert.rejects(sendConfirmed(u, cell, bad, write(undefined).send), /no task was named/);
  });

  it('a write with no task (taskApplies false) names none in the title, the detail and the log', async () => {
    const clock: ConfirmRequest = { label: 'Set Controller Clock', tier: 'disruptive', taskApplies: false, sideEffects: ['Sets the clock to 2026-10-30 12:00:00.'] };
    const { u, shown, log } = ui({ modal: () => 'Continue on Cell 3' });
    assert.deepEqual(await sendConfirmed(u, cell, clock, write(undefined).send), { sent: true, value: undefined });
    assert.deepEqual(shown, [{ kind: 'modal', message: 'Set Controller Clock on Cell 3 (10.0.5.20:80)', detail: '• Sets the clock to 2026-10-30 12:00:00.', buttons: ['Continue on Cell 3'] }]);
    assert.deepEqual(log, ['write Set Controller Clock robot=Cell 3 task=none tier=disruptive']);
  });

  it('an execution-wide write lists every task it acts on, and the title names none', async () => {
    const reset: ConfirmRequest = { label: 'Reset RAPID', tier: 'disruptive', taskApplies: true, tasks: ['T_ROB1', 'T_ROB2'], sideEffects: ['Moves the program pointer to main in every task.'] };
    const { u, shown, log } = ui({ modal: () => 'Continue on Cell 3' });
    await sendConfirmed(u, cell, reset, write(undefined).send);
    assert.equal(shown[0].message, 'Reset RAPID on Cell 3 (10.0.5.20:80)');
    assert.equal(shown[0].detail, 'Tasks: T_ROB1, T_ROB2 (the controller runs them together)\n• Moves the program pointer to main in every task.');
    assert.deepEqual(log, ['write Reset RAPID robot=Cell 3 task=T_ROB1,T_ROB2 tier=disruptive']);
  });

  it('one task in the list reads as one task', () => {
    assert.deepEqual(taskWords({ tasks: ['T_ROB1'] }), { title: '', line: 'Task: T_ROB1', log: 'T_ROB1' });
    assert.deepEqual(taskWords({ task: 'T_ROB2' }), { title: ' in T_ROB2', line: 'Task: T_ROB2', log: 'T_ROB2' });
    assert.deepEqual(taskWords({}), { title: '', line: undefined, log: 'none' });
  });

  it('the motion tier puts the task line before "This can move the robot."', async () => {
    const start: ConfirmRequest = { label: 'Start RAPID', tier: 'motion', taskApplies: true, tasks: ['T_ROB1', 'T_ROB2'], sideEffects: ['Starts the RAPID program.'] };
    const { u, shown } = ui({ modal: () => 'Continue', input: () => 'Cell 3' });
    assert.deepEqual(await sendConfirmed(u, cell, start, write(undefined).send), { sent: true, value: undefined });
    assert.equal(shown[0].message, 'Start RAPID on Cell 3 (10.0.5.20:80)');
    assert.match(String(shown[0].detail), /^Tasks: T_ROB1, T_ROB2 \(the controller runs them together\)\nThis can move the robot\.\n\n• Starts the RAPID program\./);
  });
});

describe('sendConfirmed: the repeat jog', () => {
  const jog: ConfirmRequest = { label: 'Jog', tier: 'motion', taskApplies: false, skipAsk: 'jog-repeat', sideEffects: ['Moves one axis by 1 degree.'] };

  it('skips the dialog, still logs, still sends', async () => {
    const { u, shown, log } = ui({ modal: () => { throw new Error('no dialog'); } });
    const w = write(undefined);
    assert.deepEqual(await sendConfirmed(u, cell, jog, w.send), { sent: true, value: undefined });
    assert.equal(w.calls(), 1);
    assert.deepEqual(shown, []);
    assert.deepEqual(log, ['write Jog robot=Cell 3 task=none tier=motion']);
  });

  it('is still refused by the mode seam', async () => {
    const { u, shown } = ui({ refuse: label => `${label} not sent: Cell 3 is watch-only.` });
    const w = write(undefined);
    assert.deepEqual(await sendConfirmed(u, cell, jog, w.send), { sent: false, why: 'watch-only' });
    assert.equal(w.calls(), 0);
    assert.deepEqual(shown, [{ kind: 'warn', message: 'Jog not sent: Cell 3 is watch-only.' }]);
  });
});

describe('sendConfirmed: the mode seam', () => {
  it('a refusal shows its sentence, opens no dialog and sends nothing', async () => {
    const request: ConfirmRequest = { label: 'Create Backup', tier: 'change', taskApplies: false, sideEffects: ['Creates a backup.'] };
    const { u, shown, log } = ui({ modal: () => { throw new Error('no dialog'); }, refuse: label => `${label} not sent: Cell 3 (10.0.5.20:80) is watch-only.` });
    const w = write(undefined);
    assert.deepEqual(await sendConfirmed(u, cell, request, w.send), { sent: false, why: 'watch-only' });
    assert.equal(w.calls(), 0);
    assert.deepEqual(shown, [{ kind: 'warn', message: 'Create Backup not sent: Cell 3 (10.0.5.20:80) is watch-only.' }]);
    assert.deepEqual(log, []);
  });

  it('without a seam, or with one that returns undefined, the write goes on', async () => {
    const request: ConfirmRequest = { label: 'Create Backup', tier: 'change', taskApplies: false, sideEffects: ['Creates a backup.'] };
    const { u } = ui({ modal: () => 'Write to Cell 3', refuse: () => undefined });
    assert.deepEqual(await sendConfirmed(u, cell, request, write(2).send), { sent: true, value: 2 });
  });
});

describe('sendReducing: no dialog', () => {
  it('sends at once, logs the reducing tier, and hands back the result', async () => {
    const { u, shown, log } = ui({ modal: () => { throw new Error('no dialog'); } });
    const w = write('stopped');
    assert.deepEqual(await sendReducing(u, cell, { label: 'Stop RAPID' }, w.send), { sent: true, value: 'stopped' });
    assert.equal(w.calls(), 1);
    assert.deepEqual(shown, []);
    assert.deepEqual(log, ['write Stop RAPID robot=Cell 3 task=none tier=reducing']);
  });

  it('the mode seam refuses Stop and Motors Off, and never a write that only gives up access', async () => {
    const refusing = () => ui({ refuse: label => `${label} not sent: watch-only.` });
    const stop = refusing();
    const w = write(undefined);
    assert.deepEqual(await sendReducing(stop.u, cell, { label: 'Motors Off' }, w.send), { sent: false, why: 'watch-only' });
    assert.equal(w.calls(), 0);
    assert.deepEqual(stop.shown, [{ kind: 'warn', message: 'Motors Off not sent: watch-only.' }]);
    const release = refusing();
    assert.deepEqual(await sendReducing(release.u, cell, { label: 'Release own locks', exemptFromWatchOnly: true }, w.send), { sent: true, value: undefined });
    assert.equal(w.calls(), 1);
    assert.deepEqual(release.shown, []);
  });

  it('the write\'s own error propagates', async () => {
    const { u } = ui();
    await assert.rejects(sendReducing(u, cell, { label: 'Stop RAPID' }, async () => { throw new Error('no session'); }), /no session/);
  });
});

describe('programChangeRequest', () => {
  it('always asks, names the task, and says when RAPID is running', () => {
    assert.deepEqual(programChangeRequest('Set PP to routine', false, 'change', ['Moves the program pointer to M.r.'], 'T_ROB1'), {
      label: 'Set PP to routine', tier: 'change', taskApplies: true, task: 'T_ROB1', sideEffects: ['Moves the program pointer to M.r.'],
    });
    const running = programChangeRequest('Unload module', true, 'disruptive', ['Unloads M from T_ROB1.'], 'T_ROB1');
    assert.equal(running.tier, 'disruptive');
    assert.deepEqual(running.sideEffects, ['RAPID is running.', 'Unloads M from T_ROB1.']);
  });

  it('the trace line is one line with the four fields', () => {
    assert.equal(writeTrace('Push Current File', cell, 'T_ROB2', 'disruptive'), 'write Push Current File robot=Cell 3 task=T_ROB2 tier=disruptive');
  });
});
