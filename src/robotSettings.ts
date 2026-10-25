/**
 * Where the saved robot list and the legacy single-robot settings live, what a save writes,
 * and how a change of the stored list is applied to the robots in memory.
 * No `vscode` import: extension.ts passes in the settings (read with `inspect`), secure storage
 * and the robots in memory, and test/robotSettings.test.ts runs the same save and apply in node.
 */

/** A settings scope the extension writes: user settings or this workspace's settings. */
export type SettingsScope = 'global' | 'workspace';

/** One setting as `WorkspaceConfiguration.inspect` reports it, the scopes the extension writes. */
export interface ScopedValue<T> {
  global?: T;
  workspace?: T;
}

/** The legacy single-robot settings, from before `abbRobot.robots`. */
export const LEGACY_ROBOT_KEYS = ['host', 'username', 'password'] as const;
export type LegacyRobotKey = typeof LEGACY_ROBOT_KEYS[number];

export interface LegacyRobotEntry {
  id: 'default';
  name: string;
  host: string;
  username: string;
}

export interface SettingsWrite {
  key: 'robots' | LegacyRobotKey;
  scope: SettingsScope;
  /** undefined: remove the setting from that scope. */
  value: unknown;
}

/**
 * The scope the robot list is read from, so a save goes where it takes effect: the workspace
 * when the workspace settings set `abbRobot.robots` (they override the user settings), else
 * the user settings.
 */
export function robotsScope(robots: ScopedValue<unknown>): SettingsScope {
  return robots.workspace !== undefined ? 'workspace' : 'global';
}

/** The value a setting has where it takes effect (workspace over user); undefined when neither sets it. */
function effective<T>(v: ScopedValue<T>): T | undefined {
  return v.workspace !== undefined ? v.workspace : v.global;
}

/** Every scope that sets a legacy single-robot setting, as a write that removes it. */
export function clearLegacyWrites(legacy: Record<LegacyRobotKey, ScopedValue<unknown>>): SettingsWrite[] {
  const writes: SettingsWrite[] = [];
  for (const key of LEGACY_ROBOT_KEYS) {
    for (const scope of ['global', 'workspace'] as const) {
      if (legacy[key][scope] !== undefined) { writes.push({ key, scope, value: undefined }); }
    }
  }
  return writes;
}

/**
 * The legacy single-robot settings as robot "default", when the robot list is empty and the
 * person set `abbRobot.host` (the schema's default host is no robot of theirs). null otherwise.
 * Its password is the legacy one, else the ABB default the legacy setting defaulted to.
 */
export function legacyRobot(
  robots: ScopedValue<unknown>, legacy: Record<LegacyRobotKey, ScopedValue<unknown>>,
): { entry: LegacyRobotEntry; password: string } | null {
  const list = effective(robots);
  if (Array.isArray(list) && list.length > 0) { return null; }
  const host = effective(legacy.host);
  if (typeof host !== 'string' || host.trim() === '') { return null; }
  const username = effective(legacy.username);
  const password = effective(legacy.password);
  return {
    entry: { id: 'default', name: host, host, username: typeof username === 'string' ? username : 'Admin' },
    password: typeof password === 'string' ? password : 'robotics',
  };
}

/**
 * Move the legacy single-robot settings once: robot "default" goes into `abbRobot.robots` (its
 * password into secure storage, by the caller, before these writes), then the legacy settings
 * are removed from every scope that sets them, so they never recreate a robot the person
 * removed and no plaintext password stays behind. Nothing to move: no writes, and legacy
 * settings beside a saved robot list stay until a robot is removed (robotEditPlan).
 */
export function legacyMigrationWrites(
  robots: ScopedValue<unknown>, legacy: Record<LegacyRobotKey, ScopedValue<unknown>>,
): { robot: { entry: LegacyRobotEntry; password: string } | null; writes: SettingsWrite[] } {
  const robot = legacyRobot(robots, legacy);
  if (!robot) { return { robot: null, writes: [] }; }
  return {
    robot,
    writes: [{ key: 'robots', scope: robotsScope(robots), value: [robot.entry] }, ...clearLegacyWrites(legacy)],
  };
}

// ─── The saved robot list, shared with other windows ─────────────────────────
//
// `abbRobot.robots` can change while the extension runs: another VS Code window saves a robot,
// the person edits settings.json, Settings Sync brings a list from another machine. So a save
// never writes this window's list from memory: it reads the stored list again and changes only
// its own robot's entry (robotEditPlan), and a change of the setting is applied to the robots
// in memory by id (reconcileRobots). Passwords are never part of either: they live in secure
// storage, keyed by robot id.

/** An entry of `abbRobot.robots` this extension reads: an object with a non-empty string id. */
export type StoredRobot = { id: string } & Record<string, unknown>;

function isStoredRobot(v: unknown): v is StoredRobot {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && typeof (v as { id?: unknown }).id === 'string' && (v as { id: string }).id !== '';
}

/** The robots of a stored list, the first entry of each id. Anything else in the list is skipped here and kept by a save. */
export function robotEntries(list: unknown): StoredRobot[] {
  if (!Array.isArray(list)) { return []; }
  const seen = new Set<string>();
  const out: StoredRobot[] = [];
  for (const v of list) {
    if (isStoredRobot(v) && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
  }
  return out;
}

/** The stored robot list as a save starts from it. */
export interface RobotListBase {
  /** Where the list is read from, and so where a save writes it. */
  scope: SettingsScope;
  /** The list as stored there, every element kept; the legacy robot when it stands in for an empty list. */
  list: unknown[];
  /** The legacy single-robot settings, when they stand in for an empty list (their move failed at activation). */
  legacy: { entry: LegacyRobotEntry; password: string } | null;
}

export function robotListBase(
  robots: ScopedValue<unknown>, legacy: Record<LegacyRobotKey, ScopedValue<unknown>>,
): RobotListBase {
  const scope = robotsScope(robots);
  const old = legacyRobot(robots, legacy);
  if (old) { return { scope, list: [old.entry], legacy: old }; }
  const stored = effective(robots);
  return { scope, list: Array.isArray(stored) ? [...stored] : [], legacy: null };
}

/**
 * The robots the settings hold, as the activation loads them and a settings change applies
 * them: the stored list, or the legacy robot (its legacy password the fallback when secure
 * storage has none) when it stands in for an empty list.
 */
export function savedRobots(
  robots: ScopedValue<unknown>, legacy: Record<LegacyRobotKey, ScopedValue<unknown>>,
): StoredRobot[] {
  const base = robotListBase(robots, legacy);
  return base.legacy ? [{ ...base.legacy.entry, password: base.legacy.password }] : robotEntries(base.list);
}

/**
 * One window's change to the saved list, by robot id. `add` stores a new robot (without a
 * password: that goes to secure storage). `patch` sets fields of one robot, an undefined value
 * removes the field; `id` and `password` are never set, and `dropPassword` removes a plaintext
 * password left in that entry (the person just gave the password, now in secure storage).
 * `remove` takes the robot out.
 */
export type RobotListEdit =
  | { kind: 'add'; robot: StoredRobot }
  | { kind: 'patch'; id: string; fields: Record<string, unknown>; dropPassword?: boolean }
  | { kind: 'remove'; id: string };

/** Whether two stored values are the same, as settings.json holds them. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function withoutPassword(robot: StoredRobot): StoredRobot {
  const { password: _password, ...rest } = robot;
  return rest as StoredRobot;
}

/**
 * The stored list with one edit applied; every other element stays as it is. `found`: the
 * edit's robot was in the list (always true for an add).
 */
export function applyRobotEdit(list: readonly unknown[], edit: RobotListEdit): { list: unknown[]; found: boolean } {
  const id = edit.kind === 'add' ? edit.robot.id : edit.id;
  const at = list.findIndex(v => isStoredRobot(v) && v.id === id);
  switch (edit.kind) {
    case 'add': {
      const robot = withoutPassword(edit.robot);
      return { list: at < 0 ? [...list, robot] : list.map((v, i) => (i === at ? robot : v)), found: true };
    }
    case 'patch': {
      // A robot no longer in the list was removed elsewhere: a patch does not bring it back.
      if (at < 0) { return { list: [...list], found: false }; }
      const next: Record<string, unknown> = { ...(list[at] as StoredRobot) };
      for (const [k, v] of Object.entries(edit.fields)) {
        if (k === 'id' || k === 'password') { continue; }
        if (v === undefined) { delete next[k]; } else { next[k] = v; }
      }
      if (edit.dropPassword) { delete next.password; }
      return { list: list.map((v, i) => (i === at ? next : v)), found: true };
    }
    case 'remove':
      return { list: list.filter(v => !(isStoredRobot(v) && v.id === id)), found: at >= 0 };
  }
}

/**
 * What a save writes: the stored list, read again just before, with only this edit applied,
 * to the scope it is read from. A list the edit leaves unchanged is not written, except when
 * the legacy robot stands in for it (it is then written into the list, as before). A removal
 * also removes the legacy single-robot settings wherever they are set, so an emptied list does
 * not bring the legacy robot (and its plaintext password) back on the next start.
 */
export function robotEditPlan(
  robots: ScopedValue<unknown>, legacy: Record<LegacyRobotKey, ScopedValue<unknown>>, edit: RobotListEdit,
): { writes: SettingsWrite[]; list: unknown[]; found: boolean } {
  const base = robotListBase(robots, legacy);
  const { list, found } = applyRobotEdit(base.list, edit);
  const writes: SettingsWrite[] = [];
  if (base.legacy || !sameValue(list, base.list)) { writes.push({ key: 'robots', scope: base.scope, value: list }); }
  if (edit.kind === 'remove') { writes.push(...clearLegacyWrites(legacy)); }
  return { writes, list, found };
}

/** What a change of the stored list means for the robots in memory, by id. */
export interface RobotListChange {
  /** Robots in the settings and not in memory, in the settings' order. */
  add: StoredRobot[];
  /** Robots in both whose fields differ: the stored value of each differing field (undefined: the field is gone). */
  update: Array<{ id: string; fields: Record<string, unknown> }>;
  /** Robots in memory that the settings no longer list. */
  remove: string[];
}

/**
 * Compare the robots in memory with the stored ones. Every field but `id` and `password` is
 * compared (the password lives in secure storage). Applying the result makes memory match the
 * settings, so a second call, or the echo of this window's own save, finds nothing to do.
 */
export function reconcileRobots(current: ReadonlyArray<{ id: string }>, stored: readonly StoredRobot[]): RobotListChange {
  const storedById = new Map(stored.map(r => [r.id, r]));
  const inMemory = new Set(current.map(c => c.id));
  const update: RobotListChange['update'] = [];
  for (const c of current) {
    const s = storedById.get(c.id);
    if (!s) { continue; }
    const now = c as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(now), ...Object.keys(s)])) {
      if (k === 'id' || k === 'password') { continue; }
      if (!sameValue(now[k], s[k])) { fields[k] = s[k]; }
    }
    if (Object.keys(fields).length > 0) { update.push({ id: c.id, fields }); }
  }
  return {
    add: stored.filter(r => !inMemory.has(r.id)),
    update,
    remove: current.filter(c => !storedById.has(c.id)).map(c => c.id),
  };
}

// ─── Saving and applying, with the settings and the robots passed in ─────────
//
// extension.ts passes VS Code's settings, secure storage and the MultiRobotManager; the tests
// pass a shared settings object and one robot list per window.

/** The robot settings as a save and an apply read and write them. */
export interface RobotSettingsStore {
  /** `abbRobot.robots` and the legacy single-robot settings, as stored now. */
  read(): { robots: ScopedValue<unknown>; legacy: Record<LegacyRobotKey, ScopedValue<unknown>> };
  /** Apply the writes in order; the first one that fails stops the rest and is thrown. */
  write(writes: SettingsWrite[]): Promise<void>;
}

/** A change a save makes to this window's robots before its settings write, and how to take it back. */
export interface InMemoryChange {
  apply(): void | Promise<void>;
  /** Run when `apply` or the settings write throws, so memory keeps matching the settings. */
  undo(): void | Promise<void>;
}

export interface SaveSteps {
  /** Made before the write, undone when the write fails. */
  inMemory?: InMemoryChange;
  /** Run only after the write succeeded (Remove Robot drops the robot and its saved password here). */
  afterWrite?: () => void | Promise<void>;
  /** An undo that failed itself; the write's error is still thrown. */
  onUndoError?: (e: unknown) => void;
}

export interface SaveResult {
  /** The edit's robot was in the stored list (always true for an add). */
  found: boolean;
  /** The list as written; undefined when the list was not written. */
  written?: unknown[];
}

/**
 * One window's save of one robot. A patch of a robot the stored list no longer has (removed
 * elsewhere) changes nothing, here or in the settings. Otherwise the in-memory step runs, the
 * stored list is read again (the step may have waited for secure storage) and only this edit is
 * written to it. A failed write undoes the in-memory step and is thrown; `afterWrite` runs only
 * once the write succeeded.
 */
export async function saveRobotEdit(store: RobotSettingsStore, edit: RobotListEdit, steps: SaveSteps = {}): Promise<SaveResult> {
  if (edit.kind === 'patch') {
    const { robots, legacy } = store.read();
    if (!robotEditPlan(robots, legacy, edit).found) { return { found: false }; }
  }
  let plan: ReturnType<typeof robotEditPlan>;
  try {
    await steps.inMemory?.apply();
    const { robots, legacy } = store.read();
    plan = robotEditPlan(robots, legacy, edit);
    await store.write(plan.writes);
  } catch (e) {
    if (steps.inMemory) {
      try { await steps.inMemory.undo(); } catch (u) { steps.onUndoError?.(u); }
    }
    throw e;
  }
  await steps.afterWrite?.();
  return { found: plan.found, written: plan.writes.some(w => w.key === 'robots') ? plan.list : undefined };
}

/** The fields a session uses to reach and log in to its controller. A connected robot keeps the ones it connected with. */
export const CONNECTION_FIELDS = ['host', 'port', 'useHttps', 'username'] as const;

/** This window's robots, as applying a stored change reads and changes them. */
export interface RobotsInMemory {
  /** Each robot with the fields the settings store (and its password, which is not compared). */
  configs(): ReadonlyArray<{ id: string }>;
  connected(id: string): boolean;
  disconnect(id: string): Promise<void>;
  remove(id: string): void;
  update(id: string, fields: Record<string, unknown>): void;
  /** Add a robot from its stored entry; its password comes from secure storage. */
  add(entry: StoredRobot): Promise<void>;
}

/** What applying a stored change did. */
export interface ApplyResult {
  change: RobotListChange;
  /** Robots that were connected when the settings dropped them: disconnected here and removed. */
  removedWhileConnected: Array<{ id: string; name: string }>;
  /**
   * Connected robots whose saved address or user changed: the new values are kept for the next
   * connect, and the session stays on the controller it connected to until then.
   */
  changedWhileConnected: Array<{ id: string; name: string; fields: string[] }>;
  /** Steps that failed; the others still ran. */
  failed: Array<{ id: string; step: 'disconnect' | 'update' | 'add'; error: unknown }>;
}

const nameOf = (robot: { id: string } | undefined, id: string): string => {
  const name = (robot as Record<string, unknown> | undefined)?.name;
  return typeof name === 'string' ? name : id;
};

/**
 * Make this window's robots match the stored list, by id (reconcileRobots): a robot the list
 * no longer has is disconnected and dropped, a changed one gets the stored fields, a new one is
 * added. One robot's failed step does not stop the others.
 */
export async function applyStoredList(store: Pick<RobotSettingsStore, 'read'>, robots: RobotsInMemory): Promise<ApplyResult> {
  const { robots: stored, legacy } = store.read();
  const current = robots.configs();
  const change = reconcileRobots(current, savedRobots(stored, legacy));
  const result: ApplyResult = { change, removedWhileConnected: [], changedWhileConnected: [], failed: [] };
  const byId = new Map(current.map(c => [c.id, c]));
  for (const id of change.remove) {
    const wasConnected = robots.connected(id);
    try { await robots.disconnect(id); } catch (error) { result.failed.push({ id, step: 'disconnect', error }); }
    robots.remove(id);
    if (wasConnected) { result.removedWhileConnected.push({ id, name: nameOf(byId.get(id), id) }); }
  }
  for (const { id, fields } of change.update) {
    const connection = CONNECTION_FIELDS.filter(k => k in fields);
    const wasConnected = connection.length > 0 && robots.connected(id);
    try {
      robots.update(id, fields);
      if (wasConnected) { result.changedWhileConnected.push({ id, name: nameOf(byId.get(id), id), fields: connection }); }
    } catch (error) { result.failed.push({ id, step: 'update', error }); }
  }
  for (const entry of change.add) {
    try { await robots.add(entry); } catch (error) { result.failed.push({ id: entry.id, step: 'add', error }); }
  }
  return result;
}

// ─── Plaintext passwords in the settings ─────────────────────────────────────

/** The plaintext passwords a stored list holds, entry by entry, in list order. */
export function plaintextPasswords(list: unknown): Array<{ id: string; password: string }> {
  if (!Array.isArray(list)) { return []; }
  return list
    .filter((v): v is StoredRobot & { password: string } => isStoredRobot(v) && typeof v.password === 'string')
    .map(v => ({ id: v.id, password: v.password }));
}

/**
 * The stored list with the passwords just moved to secure storage taken out: an entry loses its
 * `password` only when it still holds the one that moved for its id. Everything else stays as
 * it is now. null when nothing changes, so nothing is written.
 */
export function scrubMovedPasswords(list: unknown, moved: ReadonlyArray<{ id: string; password: string }>): unknown[] | null {
  if (!Array.isArray(list)) { return null; }
  const byId = new Map<string, Set<string>>();
  for (const m of moved) {
    const set = byId.get(m.id) ?? new Set<string>();
    set.add(m.password);
    byId.set(m.id, set);
  }
  let changed = false;
  const out = list.map(v => {
    if (!isStoredRobot(v) || typeof v.password !== 'string' || !byId.get(v.id)?.has(v.password)) { return v; }
    changed = true;
    return withoutPassword(v);
  });
  return changed ? out : null;
}

/**
 * Move plaintext passwords out of `abbRobot.robots` (which Settings Sync uploads) into secure
 * storage, in each scope that holds one. Every password is stored first; then the list is read
 * again and only the moved password fields are removed from it, so a robot another window saved
 * meanwhile stays. A failure to store one is thrown before the settings are touched. Returns
 * how many passwords moved.
 */
export async function movePasswordsToSecrets(
  store: RobotSettingsStore, storeSecret: (id: string, password: string) => Promise<void>,
): Promise<number> {
  const first = store.read().robots;
  let moved = 0;
  for (const scope of ['global', 'workspace'] as const) {
    const found = plaintextPasswords(first[scope]);
    if (found.length === 0) { continue; }
    for (const { id, password } of found) { await storeSecret(id, password); }
    const scrubbed = scrubMovedPasswords(store.read().robots[scope], found);
    if (scrubbed) { await store.write([{ key: 'robots', scope, value: scrubbed }]); }
    moved += found.length;
  }
  return moved;
}

/** The secure-storage key prefix of a robot's password: `abbRobot.password/<robot id>`. */
export const PASSWORD_SECRET_PREFIX = 'abbRobot.password/';

/** The robot id a secure-storage key holds the password of; undefined for any other key. */
export function robotIdOfPasswordKey(key: string): string | undefined {
  return key.startsWith(PASSWORD_SECRET_PREFIX) && key.length > PASSWORD_SECRET_PREFIX.length
    ? key.slice(PASSWORD_SECRET_PREFIX.length) : undefined;
}

/**
 * Runs this window's saves of the robot list, and the applying of stored changes, one at a
 * time and in order. A settings change seen while one of them runs (the echo of a save among
 * them) is applied once, after the last one queued; applying is idempotent, so an echo finds
 * nothing to do and writes nothing, and no loop starts. A failed apply goes to `onError` and
 * does not stop the queue.
 */
export class RobotListSync {
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private dirty = false;

  constructor(
    private readonly apply: () => Promise<void>,
    private readonly onError: (e: unknown) => void,
  ) {}

  /** Queue one save: a change to the robots in memory and its settings writes. No apply runs while it does. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;
    const done = this.queue.then(fn);
    this.queue = done.then(() => undefined, () => undefined).then(() => this.finished());
    return done;
  }

  /** The stored list changed: apply it now, or once the queued saves are done. */
  changed(): void {
    if (this.queued > 0) { this.dirty = true; return; }
    void this.run(() => this.apply().catch(e => this.onError(e)));
  }

  private finished(): void {
    this.queued--;
    if (this.queued === 0 && this.dirty) {
      this.dirty = false;
      this.changed();
    }
  }
}
