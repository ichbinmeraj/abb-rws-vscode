import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { modulesOfTask, modulesWithMain, type MainHolderRobot } from '../src/mainHolders';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

/** A two-task robot: T_ROB1's and T_ROB2's lists differ, and only T_ROB2's second module shares a name with T_ROB1's. */
function robot(over: { fresh?: string[] | Error; failing?: string[] } = {}) {
  const calls: string[] = [];
  const mains: Record<string, string[]> = { 'T_ROB1/MainModule': ['main', 'Pick'], 'T_ROB1/Shared': ['Helper'], 'T_ROB2/Shared': ['main'], 'T_ROB2/Cell2': ['main', 'Place'], 'T_TASK3/Bg': ['main'] };
  const r: MainHolderRobot = {
    state: { modulesByTask: { T_ROB1: ['BASE', 'user', 'MainModule', 'Shared'], T_ROB2: ['BASE', 'Shared', 'Cell2', 'DPUSER'] } },
    listModulesDetailed: async task => {
      calls.push(`list ${task}`);
      if (over.fresh instanceof Error) { throw over.fresh; }
      return (over.fresh ?? []).map(name => ({ name }));
    },
    listRoutines: async (task, module) => {
      calls.push(`routines ${task}/${module}`);
      if (over.failing?.includes(module)) { throw new Error('module in a state that cannot be queried'); }
      // The controller compares task names without case: so does this stub.
      const key = Object.keys(mains).find(k => k.toLowerCase() === `${task}/${module}`.toLowerCase());
      return (key ? mains[key] : []).map(name => ({ name }));
    },
  };
  return { r, calls };
}

describe('which loaded modules of a task declare main (review finding 16)', () => {
  it('reads the named task\'s own list, not the primary task\'s', async () => {
    const { r, calls } = robot();
    assert.deepEqual(await modulesWithMain(r, 'T_ROB2'), ['Shared', 'Cell2']);
    assert.deepEqual(calls, ['routines T_ROB2/Shared', 'routines T_ROB2/Cell2']);
    const first = robot();
    assert.deepEqual(await modulesWithMain(first.r, 'T_ROB1'), ['MainModule']);
    assert.deepEqual(first.calls, ['routines T_ROB1/MainModule', 'routines T_ROB1/Shared']);
  });

  it('a task with no polled list is read once; a failed read is an empty list, not another task\'s', async () => {
    const polled = robot({ fresh: ['BASE', 'Bg'] });
    assert.deepEqual(await modulesWithMain(polled.r, 'T_TASK3'), ['Bg']);
    assert.deepEqual(polled.calls, ['list T_TASK3', 'routines T_TASK3/Bg']);
    const failed = robot({ fresh: new Error('HTTP 503') });
    assert.deepEqual(await modulesWithMain(failed.r, 'T_TASK3'), []);
    assert.deepEqual(failed.calls, ['list T_TASK3']);
  });

  it('the task name is matched without case, and the system modules are left out', async () => {
    const { r } = robot();
    assert.deepEqual(await modulesOfTask(r, 't_rob2'), ['BASE', 'Shared', 'Cell2', 'DPUSER']);
    assert.deepEqual(await modulesWithMain(r, 't_rob2'), ['Shared', 'Cell2']);
  });

  it('a module whose routines cannot be read is skipped, and the others still count', async () => {
    const { r, calls } = robot({ failing: ['Shared'] });
    assert.deepEqual(await modulesWithMain(r, 'T_ROB2'), ['Cell2']);
    assert.deepEqual(calls, ['routines T_ROB2/Shared', 'routines T_ROB2/Cell2']);
  });

  it('the extension has no copy of its own and uses it for the Run routine dialog and the collision recovery', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.match(src, /import \{ modulesWithMain \} from '\.\/mainHolders';/);
    assert.doesNotMatch(src, /function modulesWithMain/);
    assert.doesNotMatch(src, /state\.modules\.filter/);
    assert.match(src, /const mainHolders = \(await modulesWithMain\(active, taskName\)\)\.filter\(m => m !== moduleName\);/);
    assert.match(src, /const withMain = await modulesWithMain\(robot, taskName\);/);
  });
});
