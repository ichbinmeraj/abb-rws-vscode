import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RobotListSync, applyRobotEdit, applyStoredList, clearLegacyWrites, legacyMigrationWrites, legacyRobot,
  movePasswordsToSecrets, plaintextPasswords, reconcileRobots, robotEditPlan, robotEntries, robotIdOfPasswordKey,
  robotsScope, saveRobotEdit, savedRobots, scrubMovedPasswords,
  type ApplyResult, type LegacyRobotKey, type RobotListChange, type RobotSettingsStore, type RobotsInMemory,
  type ScopedValue, type SettingsWrite, type StoredRobot,
} from '../src/robotSettings';

const none = (): Record<LegacyRobotKey, ScopedValue<unknown>> => ({ host: {}, username: {}, password: {} });

describe('the robot list is saved where it is read from', () => {
  it('the workspace when its settings set the list, else the user settings', () => {
    assert.equal(robotsScope({}), 'global');
    assert.equal(robotsScope({ global: [{ id: 'a' }] }), 'global');
    assert.equal(robotsScope({ global: [{ id: 'a' }], workspace: [] }), 'workspace');
  });
});

describe('legacy single-robot settings', () => {
  it('become robot "default" only when the list is empty and the person set a host', () => {
    // The schema's default host (192.168.125.1) is not reported by inspect: no robot.
    assert.equal(legacyRobot({}, none()), null);
    const legacy = { ...none(), host: { global: '10.0.0.5' }, password: { global: 'secret' } };
    assert.deepEqual(legacyRobot({}, legacy), {
      entry: { id: 'default', name: '10.0.0.5', host: '10.0.0.5', username: 'Admin' },
      password: 'secret',
    });
    // A workspace value wins over the user one, as VS Code reads it.
    assert.equal(legacyRobot({}, { ...legacy, host: { global: '10.0.0.5', workspace: 'cell.example' } })?.entry.host, 'cell.example');
    // Without a password set, the ABB default the legacy setting defaulted to.
    assert.equal(legacyRobot({}, { ...none(), host: { global: '10.0.0.5' } })?.password, 'robotics');
    // A saved robot list: the legacy settings are not used.
    assert.equal(legacyRobot({ global: [{ id: 'a' }] }, legacy), null);
    assert.equal(legacyRobot({}, { ...none(), host: { global: '  ' } }), null);
  });

  it('move once: the robot into the list, then every legacy setting removed wherever it is set', () => {
    const legacy = { host: { global: '10.0.0.5', workspace: '10.0.0.6' }, username: { global: 'op' }, password: { workspace: 'pw' } };
    const plan = legacyMigrationWrites({}, legacy);
    assert.deepEqual(plan.robot, { entry: { id: 'default', name: '10.0.0.6', host: '10.0.0.6', username: 'op' }, password: 'pw' });
    // The password goes to secure storage (by the caller) before these; the list is written first.
    assert.deepEqual(plan.writes, [
      { key: 'robots', scope: 'global', value: [{ id: 'default', name: '10.0.0.6', host: '10.0.0.6', username: 'op' }] },
      { key: 'host', scope: 'global', value: undefined },
      { key: 'host', scope: 'workspace', value: undefined },
      { key: 'username', scope: 'global', value: undefined },
      { key: 'password', scope: 'workspace', value: undefined },
    ]);
    // Nothing to move: no writes (legacy settings beside a saved list stay until a robot is removed).
    assert.deepEqual(legacyMigrationWrites({ global: [{ id: 'a' }] }, legacy), { robot: null, writes: [] });
  });

  it('removing a robot saves the list where it is read from and removes the legacy settings, so it does not come back', () => {
    const legacy = { ...none(), host: { global: '10.0.0.5' }, password: { global: 'pw' } };
    assert.deepEqual(robotEditPlan({ global: [{ id: 'default' }], workspace: [{ id: 'default' }] }, legacy, { kind: 'remove', id: 'default' }).writes, [
      { key: 'robots', scope: 'workspace', value: [] },
      { key: 'host', scope: 'global', value: undefined },
      { key: 'password', scope: 'global', value: undefined },
    ]);
    assert.deepEqual(clearLegacyWrites(none()), []);
  });

  it('stand in for an empty list until they are moved: a save writes the legacy robot into the list beside its own change', () => {
    const legacy = { ...none(), host: { global: '10.0.0.5' }, password: { global: 'pw' } };
    assert.deepEqual(savedRobots({}, legacy), [{ id: 'default', name: '10.0.0.5', host: '10.0.0.5', username: 'Admin', password: 'pw' }]);
    const add = robotEditPlan({}, legacy, { kind: 'add', robot: { id: 'b', name: 'B', host: '10.0.0.6', username: 'Admin' } });
    assert.deepEqual(add.writes, [{
      key: 'robots', scope: 'global',
      value: [{ id: 'default', name: '10.0.0.5', host: '10.0.0.5', username: 'Admin' }, { id: 'b', name: 'B', host: '10.0.0.6', username: 'Admin' }],
    }]);
    // Removing the legacy robot empties the list and removes the legacy settings.
    assert.deepEqual(robotEditPlan({}, legacy, { kind: 'remove', id: 'default' }).writes, [
      { key: 'robots', scope: 'global', value: [] },
      { key: 'host', scope: 'global', value: undefined },
      { key: 'password', scope: 'global', value: undefined },
    ]);
  });
});

// ─── The robot list shared with other windows ────────────────────────────────

const copy = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** settings.json in the two scopes the extension writes, shared by every window. */
class Settings implements RobotSettingsStore {
  robots: ScopedValue<unknown> = {};
  legacy: Record<LegacyRobotKey, ScopedValue<unknown>> = none();
  /** Every write is refused while set, as VS Code refuses one when settings.json has unsaved edits. */
  refuse: Error | undefined;
  reads = 0;

  constructor(global?: unknown[]) {
    if (global) { this.robots.global = global; }
  }

  read(): { robots: ScopedValue<unknown>; legacy: Record<LegacyRobotKey, ScopedValue<unknown>> } {
    this.reads++;
    return { robots: { global: copy(this.robots.global), workspace: copy(this.robots.workspace) }, legacy: copy(this.legacy) };
  }

  async write(writes: SettingsWrite[]): Promise<void> {
    if (this.refuse) { throw this.refuse; }
    this.store(writes);
  }

  /** Apply writes as VS Code stores them: a JSON copy, undefined fields dropped. */
  store(writes: SettingsWrite[]): void {
    for (const w of writes) {
      const target = w.key === 'robots' ? this.robots : this.legacy[w.key];
      if (w.value === undefined) { delete target[w.scope]; } else { target[w.scope] = copy(w.value); }
    }
  }

  /** The stored list where it is read from. */
  list(): StoredRobot[] {
    return robotEntries(this.robots.workspace !== undefined ? this.robots.workspace : this.robots.global);
  }
}

type Robot = StoredRobot & { password: string };

/**
 * One VS Code window: its robots in memory, saved through saveRobotEdit with the steps the
 * extension's commands give it, and a stored change applied through applyStoredList. Secure
 * storage is shared by every window, as VS Code's is.
 */
class Window {
  robots: Robot[];
  readonly connected = new Set<string>();
  readonly disconnected: string[] = [];

  constructor(private readonly settings: Settings, private readonly secrets = new Map<string, string>()) {
    this.robots = savedRobots(settings.robots, settings.legacy).map(r => ({ ...r, password: 'secret' }));
  }

  private find(id: string): Robot | undefined { return this.robots.find(r => r.id === id); }

  /** Add Robot: listed here and its password stored, then saved; a failed save takes both back. */
  async add(robot: Robot): Promise<boolean> {
    const { password, ...entry } = robot;
    return (await saveRobotEdit(this.settings, { kind: 'add', robot: entry as StoredRobot }, {
      inMemory: {
        apply: () => { this.secrets.set(robot.id, password); this.robots.push(robot); },
        undo: () => { this.robots = this.robots.filter(r => r.id !== robot.id); this.secrets.delete(robot.id); },
      },
    })).found;
  }

  /** Configure Robot or a port found again at connect: a failed save puts the old fields back. */
  async patch(id: string, fields: Record<string, unknown>): Promise<boolean> {
    let before: Robot | undefined;
    return (await saveRobotEdit(this.settings, { kind: 'patch', id, fields }, {
      inMemory: {
        apply: () => {
          before = this.find(id);
          this.robots = this.robots.map(r => (r.id === id ? { ...r, ...fields } : r));
        },
        undo: () => { if (before) { const b = before; this.robots = this.robots.map(r => (r.id === id ? b : r)); } },
      },
    })).found;
  }

  /** Remove Robot: the robot and its password go once the settings no longer list it. */
  async remove(id: string): Promise<boolean> {
    return (await saveRobotEdit(this.settings, { kind: 'remove', id }, {
      afterWrite: () => { this.robots = this.robots.filter(r => r.id !== id); this.secrets.delete(id); },
    })).found;
  }

  memory(): RobotsInMemory {
    return {
      configs: () => this.robots,
      connected: id => this.connected.has(id),
      disconnect: async id => { this.connected.delete(id); this.disconnected.push(id); },
      remove: id => { this.robots = this.robots.filter(r => r.id !== id); },
      update: (id, fields) => { this.robots = this.robots.map(r => (r.id === id ? { ...r, ...fields } : r)); },
      add: async entry => { this.robots.push({ ...entry, password: this.secrets.get(entry.id) ?? '' }); },
    };
  }

  /** abbRobot.robots changed: apply it by id. */
  async sync(): Promise<ApplyResult> {
    return applyStoredList(this.settings, this.memory());
  }

  ids(): string[] { return this.robots.map(r => r.id).sort(); }
}

const robot = (id: string, extra: Record<string, unknown> = {}): Robot =>
  ({ id, name: `Robot ${id}`, host: '127.0.0.1', port: 80, username: 'Admin', password: 'pw', ...extra });
const stored = (id: string, extra: Record<string, unknown> = {}): StoredRobot => {
  const { password: _p, ...rest } = robot(id, extra);
  return rest;
};
const nothing: RobotListChange = { add: [], update: [], remove: [] };

describe('a save changes only its own robot in the stored list', () => {
  it('a robot added in a second window, then one added here: both are kept', async () => {
    const settings = new Settings([stored('a')]);
    const here = new Window(settings);
    const other = new Window(settings);
    await other.add(robot('b'));
    // This window has not seen the change yet; its save keeps robot b all the same.
    await here.add(robot('c'));
    assert.deepEqual(settings.list().map(r => r.id), ['a', 'b', 'c']);
    // Each window then applies the change: both list all three.
    assert.deepEqual((await here.sync()).change.add.map(r => r.id), ['b']);
    assert.deepEqual((await other.sync()).change.add.map(r => r.id), ['c']);
    assert.deepEqual(here.ids(), ['a', 'b', 'c']);
    assert.deepEqual(other.ids(), ['a', 'b', 'c']);
  });

  it('a hand edit that renames a robot is kept by the next save here and applied to the robot in memory', async () => {
    const settings = new Settings([stored('a'), stored('b')]);
    const here = new Window(settings);
    (settings.robots.global as StoredRobot[])[1] = { ...stored('b'), name: 'Cell 2', host: '10.0.0.7' };
    // A port found again at connect, for the other robot: only its port changes.
    await here.patch('a', { port: 5466, useHttps: true });
    assert.deepEqual(settings.list(), [
      { ...stored('a'), port: 5466, useHttps: true },
      { ...stored('b'), name: 'Cell 2', host: '10.0.0.7' },
    ]);
    const result = await here.sync();
    assert.deepEqual(result.change, { add: [], update: [{ id: 'b', fields: { name: 'Cell 2', host: '10.0.0.7' } }], remove: [] });
    const renamed = here.robots.find(r => r.id === 'b');
    assert.equal(renamed?.name, 'Cell 2');
    assert.equal(renamed?.password, 'secret', 'the password in memory is not touched');
  });

  it('a robot removed elsewhere is removed here, and a save here neither changes it in memory nor brings it back', async () => {
    const settings = new Settings([stored('a'), stored('b')]);
    const here = new Window(settings);
    const other = new Window(settings);
    await other.remove('b');
    // Before this window applies the removal, it saves a port it found for robot b, and then
    // changes robot a: robot b stays removed, and its in-memory step does not run.
    assert.equal(await here.patch('b', { port: 9403 }), false);
    assert.equal(here.robots.find(r => r.id === 'b')?.port, 80, 'nothing changed in memory');
    assert.equal(await here.patch('a', { host: '10.0.0.8' }), true);
    assert.deepEqual(settings.list(), [{ ...stored('a'), host: '10.0.0.8' }]);
    assert.deepEqual((await here.sync()).change, { add: [], update: [], remove: ['b'] });
    assert.deepEqual(here.ids(), ['a']);
  });

  it('the echo of this window\'s own save finds nothing to do', async () => {
    const settings = new Settings([]);
    const here = new Window(settings);
    await here.add(robot('a'));
    assert.deepEqual((await here.sync()).change, nothing);
    await here.patch('a', { port: 443, useHttps: true });
    assert.deepEqual((await here.sync()).change, nothing);
    await here.add(robot('b'));
    await here.remove('a');
    assert.deepEqual((await here.sync()).change, nothing);
    assert.deepEqual(here.ids(), ['b']);
  });

  it('a workspace list is saved to the workspace; the user list stays as it is', async () => {
    const settings = new Settings([stored('a')]);
    settings.robots.workspace = [stored('w')];
    const here = new Window(settings);
    assert.deepEqual(here.ids(), ['w']);
    await here.add(robot('x'));
    assert.deepEqual(settings.robots.global, [stored('a')]);
    assert.deepEqual((settings.robots.workspace as StoredRobot[]).map(r => r.id), ['w', 'x']);
  });

  it('the list is read again after the in-memory step, so a robot saved elsewhere meanwhile stays', async () => {
    const settings = new Settings([stored('a')]);
    const other = new Window(settings);
    // The in-memory step waits (Configure stores a password); another window saves meanwhile.
    await saveRobotEdit(settings, { kind: 'patch', id: 'a', fields: { host: '10.0.0.9' } }, {
      inMemory: { apply: async () => { await other.add(robot('b')); }, undo: () => assert.fail('no undo') },
    });
    assert.deepEqual(settings.list(), [{ ...stored('a'), host: '10.0.0.9' }, stored('b')]);
  });
});

describe('a save the settings refuse', () => {
  const refused = new Error('settings.json has unsaved changes');

  it('Add: the robot and its password are taken out again, and the error is thrown', async () => {
    const secrets = new Map<string, string>();
    const settings = new Settings([stored('a')]);
    const here = new Window(settings, secrets);
    settings.refuse = refused;
    await assert.rejects(here.add(robot('c', { password: 'typed' })), /unsaved changes/);
    assert.deepEqual(here.ids(), ['a']);
    assert.equal(secrets.has('c'), false);
    // The next change of the list finds memory and settings in agreement: nothing is dropped.
    settings.refuse = undefined;
    assert.deepEqual((await here.sync()).change, nothing);
  });

  it('Remove: the robot and its saved password stay, so it does not come back without one', async () => {
    const secrets = new Map([['b', 'pw-b']]);
    const settings = new Settings([stored('a'), stored('b')]);
    const here = new Window(settings, secrets);
    settings.refuse = refused;
    await assert.rejects(here.remove('b'), /unsaved changes/);
    assert.deepEqual(here.ids(), ['a', 'b']);
    assert.equal(secrets.get('b'), 'pw-b');
    settings.refuse = undefined;
    assert.deepEqual((await here.sync()).change, nothing);
    // Removing it again works.
    assert.equal(await here.remove('b'), true);
    assert.deepEqual(here.ids(), ['a']);
    assert.equal(secrets.has('b'), false);
  });

  it('Configure: the old host and user are put back in memory', async () => {
    const settings = new Settings([stored('a')]);
    const here = new Window(settings);
    settings.refuse = refused;
    await assert.rejects(here.patch('a', { host: '10.0.0.8', username: 'op' }), /unsaved changes/);
    const a = here.robots.find(r => r.id === 'a');
    assert.equal(a?.host, '127.0.0.1');
    assert.equal(a?.username, 'Admin');
    settings.refuse = undefined;
    assert.deepEqual((await here.sync()).change, nothing);
  });

  it('an undo that fails itself is reported, and the write\'s error is still thrown', async () => {
    const settings = new Settings([]);
    settings.refuse = refused;
    const undoErrors: unknown[] = [];
    let afterWrite = false;
    await assert.rejects(saveRobotEdit(settings, { kind: 'add', robot: stored('a') }, {
      inMemory: { apply: () => undefined, undo: () => { throw new Error('undo failed'); } },
      afterWrite: () => { afterWrite = true; },
      onUndoError: e => undoErrors.push(e),
    }), /unsaved changes/);
    assert.equal((undoErrors[0] as Error).message, 'undo failed');
    assert.equal(afterWrite, false, 'afterWrite runs only after a write that succeeded');
  });

  it('an in-memory step that throws is undone too, and nothing is written', async () => {
    const settings = new Settings([]);
    let undone = false;
    await assert.rejects(saveRobotEdit(settings, { kind: 'add', robot: stored('a') }, {
      inMemory: { apply: () => { throw new Error('add failed'); }, undo: () => { undone = true; } },
    }), /add failed/);
    assert.equal(undone, true);
    assert.deepEqual(settings.list(), []);
  });
});

describe('applying a change made elsewhere to a connected robot', () => {
  it('a connected robot the settings drop is disconnected, then dropped, and named in the result', async () => {
    const settings = new Settings([stored('a'), stored('b')]);
    const here = new Window(settings);
    const other = new Window(settings);
    here.connected.add('b');
    await other.remove('b');
    const result = await here.sync();
    assert.deepEqual(here.disconnected, ['b']);
    assert.deepEqual(here.ids(), ['a']);
    assert.deepEqual(result.removedWhileConnected, [{ id: 'b', name: 'Robot b' }]);
    // An offline robot that is dropped is not reported.
    await other.remove('a');
    assert.deepEqual((await here.sync()).removedWhileConnected, []);
  });

  it('a connected robot whose address or user changed elsewhere takes the new values for its next connect, and is named', async () => {
    const settings = new Settings([stored('a'), stored('b')]);
    const here = new Window(settings);
    const other = new Window(settings);
    here.connected.add('a');
    here.connected.add('b');
    await other.patch('a', { host: '10.0.0.8', port: 5466, username: 'op' });
    await other.patch('b', { name: 'Cell 2' });
    const result = await here.sync();
    assert.deepEqual(result.changedWhileConnected, [{ id: 'a', name: 'Robot a', fields: ['host', 'port', 'username'] }]);
    assert.equal(here.robots.find(r => r.id === 'a')?.host, '10.0.0.8');
    assert.equal(here.robots.find(r => r.id === 'b')?.name, 'Cell 2', 'a new name is applied and not reported');
    assert.deepEqual(here.disconnected, [], 'nothing is disconnected');
    // Offline, an address change is just applied.
    here.connected.clear();
    await other.patch('a', { host: '10.0.0.9' });
    assert.deepEqual((await here.sync()).changedWhileConnected, []);
  });

  it('one robot\'s failed step does not stop the others', async () => {
    const settings = new Settings([stored('a', { host: '10.0.0.1' }), stored('b', { host: '10.0.0.2' }), stored('c')]);
    const here = new Window(new Settings([stored('a'), stored('b'), stored('d')]));
    const memory = here.memory();
    const result = await applyStoredList(settings, {
      ...memory,
      update: (id, fields) => { if (id === 'a') { throw new Error('bad identity'); } memory.update(id, fields); },
      disconnect: async () => { throw new Error('socket closed'); },
    });
    assert.deepEqual(result.failed.map(f => [f.id, f.step]), [['d', 'disconnect'], ['a', 'update']]);
    assert.deepEqual(here.ids(), ['a', 'b', 'c']);
    assert.equal(here.robots.find(r => r.id === 'b')?.host, '10.0.0.2');
  });
});

describe('plaintext passwords in the settings', () => {
  it('move to secure storage, and only those password fields leave the list', async () => {
    const settings = new Settings([{ ...stored('a'), password: 'pa' }, stored('b'), 'not a robot']);
    settings.robots.workspace = [{ ...stored('w'), password: 'pw' }];
    const secrets = new Map<string, string>();
    assert.equal(await movePasswordsToSecrets(settings, async (id, pw) => { secrets.set(id, pw); }), 2);
    assert.deepEqual([...secrets], [['a', 'pa'], ['w', 'pw']]);
    assert.deepEqual(settings.robots.global, [stored('a'), stored('b'), 'not a robot']);
    assert.deepEqual(settings.robots.workspace, [stored('w')]);
    // Clean settings: nothing moves and nothing is written.
    settings.refuse = new Error('no write expected');
    assert.equal(await movePasswordsToSecrets(settings, async () => assert.fail('nothing to store')), 0);
  });

  it('a robot another window saves while the passwords wait for secure storage stays', async () => {
    const settings = new Settings([{ ...stored('a'), password: 'pa' }]);
    const other = new Window(settings);
    await movePasswordsToSecrets(settings, async () => { await other.add(robot('b')); });
    assert.deepEqual(settings.list(), [stored('a'), stored('b')]);
  });

  it('a password changed in the settings meanwhile stays for the next move; a failed store leaves the settings as they are', async () => {
    const settings = new Settings([{ ...stored('a'), password: 'old' }]);
    await movePasswordsToSecrets(settings, async () => { settings.robots.global = [{ ...stored('a'), password: 'new' }]; });
    assert.deepEqual(settings.list(), [{ ...stored('a'), password: 'new' }]);
    await assert.rejects(movePasswordsToSecrets(settings, async () => { throw new Error('keychain locked'); }), /keychain locked/);
    assert.deepEqual(settings.list(), [{ ...stored('a'), password: 'new' }]);
  });

  it('are found entry by entry, and only an entry still holding the moved password loses it', () => {
    assert.deepEqual(plaintextPasswords([{ id: 'a', password: 'x' }, { id: 'b' }, { id: 'c', password: 3 }, null]), [{ id: 'a', password: 'x' }]);
    assert.deepEqual(plaintextPasswords(undefined), []);
    const list = [{ id: 'a', password: 'x' }, { id: 'a', password: 'y' }, { id: 'b', password: 'x' }];
    assert.deepEqual(scrubMovedPasswords(list, [{ id: 'a', password: 'x' }]), [{ id: 'a' }, { id: 'a', password: 'y' }, { id: 'b', password: 'x' }]);
    assert.equal(scrubMovedPasswords(list, [{ id: 'c', password: 'x' }]), null);
    assert.equal(scrubMovedPasswords(undefined, [{ id: 'a', password: 'x' }]), null);
  });
});

describe('the stored list edits', () => {
  it('never write a password into the settings, and leave every other entry as it is', () => {
    const list: unknown[] = ['not a robot', { name: 'no id' }, { id: 'a', name: 'A', password: 'typed by hand' }, { id: 'b', name: 'B' }];
    const added = applyRobotEdit(list, { kind: 'add', robot: { id: 'c', name: 'C', password: 'pw' } });
    assert.deepEqual(added.list.slice(0, 4), list);
    assert.deepEqual(added.list[4], { id: 'c', name: 'C' });
    // A patch never sets the id or a password.
    const patched = applyRobotEdit(list, { kind: 'patch', id: 'b', fields: { id: 'z', password: 'pw', host: 'h' } });
    assert.deepEqual(patched.list[3], { id: 'b', name: 'B', host: 'h' });
    // Configure Robot drops a plaintext password left in its own entry (the new one is in secure storage).
    const configured = applyRobotEdit(list, { kind: 'patch', id: 'a', fields: { host: 'h' }, dropPassword: true });
    assert.deepEqual(configured.list[2], { id: 'a', name: 'A', host: 'h' });
    // Without it, the entry keeps what it has.
    assert.deepEqual(applyRobotEdit(list, { kind: 'patch', id: 'a', fields: { port: 80 } }).list[2], { id: 'a', name: 'A', password: 'typed by hand', port: 80 });
  });

  it('a patch removes a field set to undefined; an edit that changes nothing writes nothing', () => {
    const robots = { global: [{ id: 'a', name: 'A', port: 80, useHttps: false }] };
    assert.deepEqual(robotEditPlan(robots, none(), { kind: 'patch', id: 'a', fields: { port: undefined, useHttps: undefined } }).writes, [
      { key: 'robots', scope: 'global', value: [{ id: 'a', name: 'A' }] },
    ]);
    assert.deepEqual(robotEditPlan(robots, none(), { kind: 'patch', id: 'a', fields: { port: 80 } }).writes, []);
    assert.deepEqual(robotEditPlan(robots, none(), { kind: 'remove', id: 'gone' }), {
      writes: [], list: robots.global, found: false,
    });
  });

  it('the robots of a list: entries with a string id, the first of each id', () => {
    assert.deepEqual(robotEntries(undefined), []);
    assert.deepEqual(robotEntries({ id: 'a' }), []);
    assert.deepEqual(robotEntries([{ id: '' }, { id: 1 }, null, [], { id: 'a', name: 'first' }, { id: 'a', name: 'second' }]), [{ id: 'a', name: 'first' }]);
  });
});

describe('applying a change of the stored list', () => {
  it('compares every field but the id and the password', () => {
    const memory = [{ id: 'a', name: 'A', host: 'h', port: 80, password: 'secret' }];
    assert.deepEqual(reconcileRobots(memory, [{ id: 'a', name: 'A', host: 'h', port: 80 }]), nothing);
    assert.deepEqual(reconcileRobots(memory, [{ id: 'a', name: 'A', host: 'h', password: 'other' }]), {
      add: [], update: [{ id: 'a', fields: { port: undefined } }], remove: [],
    });
    assert.deepEqual(reconcileRobots(memory, [{ id: 'a', name: 'A', host: 'h', port: 80, controlStation: { name: 'x' } }]).update,
      [{ id: 'a', fields: { controlStation: { name: 'x' } } }]);
  });

  it('a password in secure storage is found by its key', () => {
    assert.equal(robotIdOfPasswordKey('abbRobot.password/1f2e'), '1f2e');
    assert.equal(robotIdOfPasswordKey('abbRobot.password/'), undefined);
    assert.equal(robotIdOfPasswordKey('other.key/1f2e'), undefined);
  });
});

describe('saves and applying run one at a time', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) { await new Promise(r => setImmediate(r)); } };
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  };

  it('with nothing running, a change is applied at once', async () => {
    let applied = 0;
    const sync = new RobotListSync(async () => { applied++; }, () => assert.fail('no error'));
    sync.changed();
    await settle();
    assert.equal(applied, 1);
  });

  it('changes seen while a save runs, its own echo among them, are applied once, after it', async () => {
    const log: string[] = [];
    const sync = new RobotListSync(async () => { log.push('apply'); }, () => assert.fail('no error'));
    const gate = deferred();
    const save = sync.run(async () => { log.push('save start'); await gate.promise; log.push('save end'); return 'saved'; });
    await settle();
    sync.changed();
    sync.changed();
    await settle();
    assert.deepEqual(log, ['save start']);
    gate.resolve();
    assert.equal(await save, 'saved');
    await settle();
    assert.deepEqual(log, ['save start', 'save end', 'apply']);
  });

  it('applies never overlap: a change during one is applied once more after it', async () => {
    let running = 0;
    let most = 0;
    let applied = 0;
    const gate = deferred();
    const sync = new RobotListSync(async () => {
      running++; most = Math.max(most, running);
      if (applied++ === 0) { await gate.promise; }
      running--;
    }, () => assert.fail('no error'));
    sync.changed();
    await settle();
    sync.changed();
    sync.changed();
    gate.resolve();
    await settle();
    assert.equal(applied, 2);
    assert.equal(most, 1);
  });

  it('a failed apply is reported and a failed save is thrown to its caller; the queue goes on', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const sync = new RobotListSync(async () => { if (fail) { fail = false; throw new Error('settings unreadable'); } }, e => errors.push(e));
    sync.changed();
    await settle();
    assert.equal((errors[0] as Error).message, 'settings unreadable');
    await assert.rejects(sync.run(async () => { throw new Error('write refused'); }), /write refused/);
    assert.equal(await sync.run(async () => 'next'), 'next');
  });
});

describe('the save paths in extension.ts', () => {
  // The bundled test runs from out/test/, two levels below the extension root.
  const src = fs.readFileSync(path.join(path.resolve(__dirname, '..', '..'), 'src', 'extension.ts'), 'utf8');
  const handler = (id: string): string => {
    const start = src.indexOf(`tracedCommand('${id}'`);
    assert.ok(start >= 0, `${id} is registered`);
    const next = src.indexOf('tracedCommand(', start + 1);
    return src.slice(start, next < 0 ? undefined : next);
  };
  const fn = (name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} is defined`);
    const next = src.indexOf('\nfunction ', start + 1);
    const nextAsync = src.indexOf('\nasync function ', start + 1);
    const end = [next, nextAsync].filter(i => i > 0).sort((a, b) => a - b)[0];
    return src.slice(start, end);
  };

  it('each one sends its own change through changeSavedRobots, with the step that undoes it', () => {
    const add = src.slice(src.indexOf('async function finishAddRobot('), src.indexOf('/** Human label for an mDNS-discovered controller'));
    assert.match(add, /changeSavedRobots\(\{ kind: 'add', robot: storedEntryOf\(config\) \}, \{\s*inMemory: \{/);
    assert.match(add, /multi\.addRobot\(config\)/);
    assert.match(add, /undo: async \(\) => \{\s*multi\.removeRobot\(config\.id\);\s*await secrets\.delete\(passwordSecretKey\(config\.id\)\);/);
    // Remove: the robot and its password go only after the write.
    const remove = handler('abbRobot.removeRobot');
    assert.match(remove, /changeSavedRobots\(\{ kind: 'remove', id \}, \{\s*afterWrite: async \(\) => \{[^]*?await endConnection\(multi, id, 'remove'\)\.catch\(\(\) => undefined\);\s*try \{ await context\.secrets\.delete\(passwordSecretKey\(id\)\); \}/);
    assert.doesNotMatch(remove, /inMemory/);
    // Connect saves a port through saveConnectedPort (connectOnce, run by the Connect command).
    const savePort = src.slice(src.indexOf('const saveConnectedPort = async'), src.indexOf('const connectOnce = async'));
    assert.match(savePort, /changeSavedRobots\(\{ kind: 'patch', id, fields: \{ port: now\.port, useHttps: now\.useHttps \} \}, \{\s*inMemory: \{\s*apply: \(\) => undefined,\s*undo: \(\) => multi\.updateConfig\(id, \{ port: saved\.port, useHttps: saved\.useHttps \}\),/);
    // A port the scan found with no system id to confirm the controller asks first (tracker 573); any other save goes straight through.
    assert.match(src.slice(src.indexOf('const connectOnce = async')), /if \(outcome\.kind === 'save'\) \{\s*if \(outcome\.verifyLater && last\) \{[\s\S]*?=== q\.button\) \{ await saveConnectedPort\(id, name, saved, outcome\); \}[\s\S]*?\} else \{ await saveConnectedPort\(id, name, saved, outcome\); \}\s*\}/);
    assert.match(handler('abbRobot.connectRobot'), /connectOnce\(targetId\)/);
    const configure = handler('abbRobot.configure');
    assert.match(configure, /changeSavedRobots\(\s*\{ kind: 'patch', id, fields: \{ host: host\.trim\(\), username: username\.trim\(\) \}, dropPassword: true \}/);
    assert.match(configure, /multi\.updateConfig\(id, \{ host: before\.host, username: before\.username, password: before\.password \}\)/);
    assert.doesNotMatch(src, /saveConfigs\(/);
  });

  it('every write of the robot list goes through the settings store, whose reads are fresh', () => {
    assert.doesNotMatch(src, /update\('robots'/);
    assert.match(src, /const robotSettingsStore: RobotSettingsStore = \{\s*read: \(\) => inspectRobotSettings\(\),\s*write: applySettingsWrites,\s*\};/);
    assert.match(fn('changeSavedRobots'), /saveRobotEdit\(robotSettingsStore, edit, \{/);
    assert.match(fn('migratePasswordsToSecrets'), /movePasswordsToSecrets\(robotSettingsStore, /);
    assert.match(fn('inspectRobotSettings'), /cfg: vscode\.WorkspaceConfiguration = vscode\.workspace\.getConfiguration\('abbRobot'\)/);
  });

  it('a change of abbRobot.robots is applied while the extension runs, and a changed password is picked up', () => {
    assert.match(src, /e\.affectsConfiguration\('abbRobot\.robots'\)\) \{ sync\.changed\(\); \}/);
    assert.match(src, /new RobotListSync\(\s*\(\) => applyStoredRobots\(multi, context\.secrets\)/);
    assert.match(src, /context\.secrets\.onDidChange\(/);
    const apply = fn('applyStoredRobots');
    assert.match(apply, /applyStoredList\(robotSettingsStore, robotsInMemory\(multi, secrets\)\)/);
    assert.match(apply, /removedWhileConnected/);
    assert.match(apply, /changedWhileConnected[\s\S]*'Reconnect'/);
    assert.doesNotMatch(apply, /secrets\.delete/, 'a robot removed elsewhere keeps its saved password');
    assert.match(fn('robotsInMemory'), /disconnect: async id => \{ await endConnection\(multi, id\); \}/);
  });

  it('the confirmations name the address the session is on', () => {
    assert.match(fn('confirmRobotOf'), /confirmRobot\(\s*entry\.config,\s*\{ connected: s\.connected, host: s\.host, port: entry\.manager\.currentPort \}/);
  });
});
