import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  activeTasks, decideTask, originKey, quietTask, resolveTask, tasksListing, textHash,
  type TaskPickItem, type TaskState, type TaskUi,
} from '../src/taskResolver';

/** A MultiMove controller: two robot tasks, a background task that is not active. */
const multiMove: TaskState = {
  tasks: [{ name: 'T_ROB1', active: true }, { name: 'T_ROB2', active: true }, { name: 'T_BCK', active: false }],
  modules: ['MainModule', 'Shared'],
  modulesByTask: {
    T_ROB1: ['BASE', 'user', 'MainModule', 'Shared'],
    T_ROB2: ['BASE', 'user', 'Rob2Main', 'Shared'],
  },
};

const singleTask: TaskState = {
  tasks: [{ name: 'T_ROB1', active: true }],
  modules: ['MainModule'],
  modulesByTask: { T_ROB1: ['BASE', 'user', 'MainModule'] },
};

/** A UI that records what it was asked and answers with a fixed pick. */
function fakeUi(answer: string | undefined) {
  const asked: Array<{ items: TaskPickItem[]; title: string; placeHolder: string }> = [];
  const warned: string[] = [];
  const ui: TaskUi = {
    pick: async (items, title, placeHolder) => { asked.push({ items, title, placeHolder }); return answer; },
    warn: m => { warned.push(m); },
  };
  return { ui, asked, warned };
}

describe('which task a command acts on', () => {
  it('a task the caller already knows wins over everything', () => {
    assert.deepEqual(decideTask(multiMove, { explicit: 'T_ROB2', module: 'MainModule', recorded: 'T_ROB1' }),
      { kind: 'task', task: 'T_ROB2', why: 'explicit' });
  });

  it('the recorded task of the file wins over the module listing', () => {
    // MainModule is listed only in T_ROB1, but the file was pulled from T_ROB2.
    assert.deepEqual(decideTask(multiMove, { module: 'MainModule', recorded: 'T_ROB2' }),
      { kind: 'task', task: 'T_ROB2', why: 'recorded' });
  });

  it('a recorded task this robot does not have asks, even on a single-task robot', () => {
    const a = decideTask(singleTask, { module: 'Rob2Main', recorded: 'T_ROB2' });
    assert.deepEqual(a, { kind: 'ask', candidates: ['T_ROB1'], listing: [], recordedMissing: 'T_ROB2' });
    assert.equal(quietTask(singleTask, { module: 'MainModule', recorded: 'T_ROB2' }), undefined);
    // On a multi-task robot without that task, every active task is offered, marked where the module is.
    const b = decideTask(multiMove, { module: 'Shared', recorded: 'T_ROB9' });
    assert.deepEqual(b, { kind: 'ask', candidates: ['T_ROB1', 'T_ROB2'], listing: ['T_ROB1', 'T_ROB2'], recordedMissing: 'T_ROB9' });
  });

  it('exactly one task listing the module decides it, ignoring case', () => {
    assert.deepEqual(decideTask(multiMove, { module: 'Rob2Main' }), { kind: 'task', task: 'T_ROB2', why: 'listed' });
    assert.deepEqual(decideTask(multiMove, { module: 'rob2main' }), { kind: 'task', task: 'T_ROB2', why: 'listed' });
  });

  it('the same module name in two tasks asks, offering only those two', () => {
    const a = decideTask(multiMove, { module: 'Shared' });
    assert.equal(a.kind, 'ask');
    assert.deepEqual(a.kind === 'ask' && a.candidates, ['T_ROB1', 'T_ROB2']);
    assert.deepEqual(a.kind === 'ask' && a.listing, ['T_ROB1', 'T_ROB2']);
  });

  it('a module no task lists asks among the active tasks on a multi-task system, never the first one', () => {
    const a = decideTask(multiMove, { module: 'NewModule' });
    assert.equal(a.kind, 'ask');
    assert.deepEqual(a.kind === 'ask' && a.candidates, ['T_ROB1', 'T_ROB2']);
  });

  it('with no module, a multi-task system asks among the active tasks', () => {
    const a = decideTask(multiMove, {});
    assert.equal(a.kind, 'ask');
    assert.deepEqual(a.kind === 'ask' && a.candidates, activeTasks(multiMove));
  });

  it('a single-task system needs no pick, for a new module or none', () => {
    assert.deepEqual(decideTask(singleTask, { module: 'NewModule' }), { kind: 'task', task: 'T_ROB1', why: 'single' });
    assert.deepEqual(decideTask(singleTask, {}), { kind: 'task', task: 'T_ROB1', why: 'single' });
  });

  it('a robot whose tasks are not read yet gets no task, not T_ROB1', () => {
    const empty: TaskState = { tasks: [], modules: [] };
    assert.equal(decideTask(empty, { module: 'MainModule' }).kind, 'none');
    assert.equal(quietTask(empty, {}), undefined);
    const inactive: TaskState = { tasks: [{ name: 'T_ROB1', active: false }], modules: [] };
    assert.equal(decideTask(inactive, {}).kind, 'none');
  });

  it('the flat module list names no task when several are active', () => {
    const noMap: TaskState = { tasks: multiMove.tasks, modules: ['MainModule'] };
    assert.deepEqual(tasksListing(noMap, 'MainModule'), []);
    assert.equal(decideTask(noMap, { module: 'MainModule' }).kind, 'ask');
  });

  it('what cannot ask gets the task only when the rule settles it', () => {
    assert.equal(quietTask(multiMove, { module: 'Rob2Main' }), 'T_ROB2');
    assert.equal(quietTask(multiMove, { module: 'Shared' }), undefined);
    assert.equal(quietTask(multiMove, {}), undefined);
    assert.equal(quietTask(singleTask, {}), 'T_ROB1');
  });
});

describe('the task pick', () => {
  it('names the robot, the command and the tasks, and marks where the module is loaded', async () => {
    const { ui, asked } = fakeUi('T_ROB2');
    const task = await resolveTask(ui, 'Cell 2 (127.0.0.1:80)', multiMove, { module: 'Shared' }, 'Push Current File');
    assert.equal(task, 'T_ROB2');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, 'Push Current File on Cell 2 (127.0.0.1:80)');
    assert.match(asked[0].placeHolder, /Which task of Cell 2 .* is Shared for\? \(Shared is loaded in T_ROB1 and T_ROB2\)/);
    assert.deepEqual(asked[0].items.map(i => [i.label, i.description]),
      [['T_ROB1', 'Shared is loaded here'], ['T_ROB2', 'Shared is loaded here']]);
  });

  it('says why it asks when the file came from a task this robot does not have', async () => {
    const { ui, asked } = fakeUi('T_ROB1');
    assert.equal(await resolveTask(ui, 'Bench VC', singleTask, { module: 'Rob2Main', recorded: 'T_ROB2' }, 'Push Current File'), 'T_ROB1');
    assert.equal(asked[0].placeHolder, 'Which task of Bench VC is Rob2Main for? (the file was pulled from T_ROB2, which Bench VC does not have)');
  });

  it('a dismissed pick sends nothing', async () => {
    const { ui } = fakeUi(undefined);
    assert.equal(await resolveTask(ui, 'Cell 2', multiMove, { module: 'NewModule' }, 'Load Program from File'), undefined);
  });

  it('a settled task asks nothing', async () => {
    const { ui, asked } = fakeUi('T_ROB1');
    assert.equal(await resolveTask(ui, 'Cell 2', multiMove, { module: 'Rob2Main' }, 'Diff'), 'T_ROB2');
    assert.equal(asked.length, 0);
  });

  it('no task to act on warns and names the robot', async () => {
    const { ui, asked, warned } = fakeUi('T_ROB1');
    assert.equal(await resolveTask(ui, 'Cell 2', { tasks: [], modules: [] }, {}, 'Show Program Pointer'), undefined);
    assert.equal(asked.length, 0);
    assert.match(warned[0], /^Show Program Pointer on Cell 2: nothing sent, its task list has not been read yet/);
  });
});

describe('the origin record of a pulled file', () => {
  it('hashes the text as written', () => {
    assert.equal(textHash('MODULE A\nENDMODULE\n'), textHash('MODULE A\nENDMODULE\n'));
    assert.notEqual(textHash('MODULE A\nENDMODULE\n'), textHash('MODULE A\r\nENDMODULE\r\n'));
    assert.match(textHash(''), /^[0-9a-f]{64}$/);
  });

  it('keys a path once per file: case folded on Windows only', () => {
    assert.equal(originKey('C:\\Work\\Rob2Main.mod', 'win32'), originKey('c:\\work\\ROB2MAIN.mod', 'win32'));
    assert.notEqual(originKey('/work/Rob2Main.mod', 'linux'), originKey('/work/rob2main.mod', 'linux'));
  });
});
