import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { FileOrigins, type OriginStore } from '../src/fileOrigins';
import { textHash } from '../src/taskResolver';

/** An in-memory workspace store. */
function memoryStore(): OriginStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string, d: T) => (data.has(key) ? data.get(key) as T : d),
    update: async (key: string, value: unknown) => { data.set(key, value); },
  };
}

describe('the origin record per file', () => {
  const file = path.resolve('work', 'Rob2Main.mod');

  it('records task, hash, robot and time, and answers the task for that path', async () => {
    const origins = new FileOrigins(memoryStore());
    await origins.record(file, 'T_ROB2', 'MODULE Rob2Main\nENDMODULE\n', 'robot-1', '2026-10-29T12:00:00.000Z');
    assert.deepEqual(origins.get(file), {
      task: 'T_ROB2', hash: textHash('MODULE Rob2Main\nENDMODULE\n'), robotId: 'robot-1', at: '2026-10-29T12:00:00.000Z',
    });
    assert.equal(origins.taskOf(file), 'T_ROB2');
  });

  it('a later pull of the same path replaces its record, other paths keep theirs', async () => {
    const origins = new FileOrigins(memoryStore());
    const other = path.resolve('work', 'Shared.mod');
    await origins.record(file, 'T_ROB2', 'a');
    await origins.record(other, 'T_ROB1', 'b');
    await origins.record(file, 'T_ROB1', 'c');
    assert.equal(origins.taskOf(file), 'T_ROB1');
    assert.equal(origins.get(file)?.hash, textHash('c'));
    assert.equal(origins.taskOf(other), 'T_ROB1');
  });

  it('a file never pulled has no record', () => {
    const origins = new FileOrigins(memoryStore());
    assert.equal(origins.get(file), undefined);
    assert.equal(origins.taskOf(undefined), undefined);
  });
});
