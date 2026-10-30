// The per-robot mode, Program and operate or Watch only: the parts that need
// no `vscode`, so the unit tests can state the rule.
//
// A virtual controller is operated; a real controller, or one that does not
// say what it is, is watched until the person chooses otherwise, once, per
// robot, on this PC. In Watch only RAPID Live reads and sends no writes: every
// send wrapper asks the mode before it asks the person (`GuardUi.refuse`).
// The signal is the controller's own `ctrl-type` (`RobotState.identity.type`),
// never the address: a real controller reached through a tunnel at 127.0.0.1
// still reports itself as real.

import { robotLabel, type ConfirmRobot } from './confirm';

/** What the controller reported itself as: virtual, real (any other non-empty type), or unknown (an empty type). */
export type CtrlClass = 'virtual' | 'real' | 'unknown';

/** What is saved per robot id, in the global state of this PC (not in the shareable settings). */
export interface ModeRecord {
  /** `auto`: decide by the controller's type (what Add Robot writes). `operate` and `watch`: the person's answer. */
  mode: 'auto' | 'operate' | 'watch';
  /** The controller's class when the answer was given, or the last class seen for an `auto` record. */
  ctrlClass: CtrlClass;
  host: string;
  port?: number;
  by: 'default' | 'chosen' | 'dismissed';
  /** ISO 8601. */
  at: string;
}

export const MODE_KEY = 'abbRobot.robotMode.v1';

/** Why a robot is watched, as the tooltip and the refusal say it. */
export type WatchReason =
  | 'controller type not read'
  | 'chosen'
  | 'dismissed'
  | 'real controller'
  | 'unknown controller'
  | 'record no longer matches';

export type ModeVerdict =
  | { mode: 'operate'; ctrlClass: CtrlClass }
  | {
    mode: 'watch'; reason: WatchReason; ctrlClass: CtrlClass | 'not-read';
    /** No answer is on record for a real or unknown controller: the ask-once dialog is due. */
    askDue: boolean;
  };

/** The class of a reported type: `Virtual Controller` (RWS 1.0) and `VIRTUAL_CONTROLLER` (RWS 2.0) are virtual; anything else non-empty is real. */
export function ctrlClassOf(identityType: string | null | undefined): CtrlClass {
  if (identityType === null || identityType === undefined || identityType.trim() === '') { return 'unknown'; }
  return /virtual/i.test(identityType) ? 'virtual' : 'real';
}

/** The slice of the robot's live state the rule reads. */
export interface ModeState {
  connected: boolean;
  /** `RobotState.identity`: null until the controller's identity is read. */
  identity: { type?: string | null } | null | undefined;
  host: string;
  port: number | undefined;
}

/**
 * The rule. Not connected, or the identity not read yet: Watch only. A saved
 * `watch` stands whatever the controller says. `operate` or `auto` on a
 * virtual controller: Program and operate. `auto` on a real or unknown
 * controller: Watch only. `operate` on a real or unknown controller counts
 * only while the class, host and port are the ones the answer was given for;
 * otherwise, and with no record at all, a real or unknown controller is
 * watched and the ask-once dialog is due.
 */
export function effectiveMode(record: ModeRecord | undefined, state: ModeState): ModeVerdict {
  if (!state.connected || !state.identity) {
    return { mode: 'watch', reason: 'controller type not read', ctrlClass: 'not-read', askDue: false };
  }
  const ctrlClass = ctrlClassOf(state.identity.type);
  const watched = (reason: WatchReason, askDue: boolean): ModeVerdict => ({ mode: 'watch', reason, ctrlClass, askDue });
  if (record?.mode === 'watch') { return watched(record.by === 'dismissed' ? 'dismissed' : 'chosen', false); }
  if (ctrlClass === 'virtual') { return { mode: 'operate', ctrlClass }; }
  if (record?.mode === 'auto') { return watched(ctrlClass === 'real' ? 'real controller' : 'unknown controller', false); }
  if (record?.mode === 'operate') {
    const same = record.ctrlClass === ctrlClass && record.host === state.host && record.port === state.port;
    if (same) { return { mode: 'operate', ctrlClass }; }
    return watched('record no longer matches', true);
  }
  return watched(ctrlClass === 'real' ? 'real controller' : 'unknown controller', true);
}

/** The record Add Robot writes: decide by the controller's type, nothing known yet. */
export function defaultRecord(host: string, port: number | undefined, at: string = new Date().toISOString()): ModeRecord {
  return { mode: 'auto', ctrlClass: 'unknown', host, port, by: 'default', at };
}

/** The record of an answer: the mode chosen, bound to the controller's class and address. */
export function answerRecord(mode: 'operate' | 'watch', by: 'chosen' | 'dismissed', ctrlClass: CtrlClass, host: string, port: number | undefined, at: string = new Date().toISOString()): ModeRecord {
  return { mode, ctrlClass, host, port, by, at };
}

/** The store the records live in (`context.globalState` in the extension). */
export interface ModeStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The records, per robot id. */
export class RobotModes {
  constructor(private readonly store: ModeStore) {}

  get(id: string): ModeRecord | undefined {
    return this.all()[id];
  }

  async set(id: string, record: ModeRecord): Promise<void> {
    await this.store.update(MODE_KEY, { ...this.all(), [id]: record });
  }

  /** Remove Robot forgets the record, as it forgets the robot's last-seen system. */
  async forget(id: string): Promise<void> {
    const all = this.all();
    if (!(id in all)) { return; }
    const { [id]: _gone, ...rest } = all;
    await this.store.update(MODE_KEY, rest);
  }

  private all(): Record<string, ModeRecord> {
    return this.store.get<Record<string, ModeRecord>>(MODE_KEY, {});
  }
}

// ─── Texts ───────────────────────────────────────────────────────────────────

/** The sentence that refuses a write in Watch only (`GuardUi.refuse`). */
export function watchOnlyRefusal(label: string, robot: ConfirmRobot, reason: WatchReason): string {
  const why = reason === 'controller type not read'
    ? 'RAPID Live has not read what kind of controller this is yet.'
    : 'RAPID Live reads from it and sends no writes.';
  return `${label} not sent: ${robotLabel(robot)} is watch-only. ${why}`;
}

/** The button on the refusal message, and on the first-connect notice: the switch of `abbRobot.setRobotMode`. */
export const SWITCH_TO_OPERATE = (name: string): string => `Switch ${name} to Program and operate…`;
export const KEEP_WATCHING = 'Keep watching';

/** The TEMP-read sentence of the ask, the tooltip and the CHANGELOG. */
export const TEMP_READS_SENTENCE = 'Pull All Modules, Diff Current File with Controller and Open Loaded Module Source still save a temporary copy to the controller\'s TEMP volume and delete it.';

/** The ask-once modal for a robot saved before 1.5.0 (or synced from another PC) that answers as a real or unknown controller. */
export function askOnceText(robot: ConfirmRobot, ctrlClass: CtrlClass): { message: string; detail: string; watch: string; operate: string } {
  const says = ctrlClass === 'real' ? 'reports itself as a real controller' : 'does not say what kind of controller it is';
  return {
    message: `How should RAPID Live treat ${robotLabel(robot)}?`,
    detail: `${robot.name} ${says}. RAPID Live used to send writes to every robot after a confirmation. From 1.5.0 a real controller is watch-only until you choose.\n`
      + `• Watch only: RAPID Live reads and sends no writes. ${TEMP_READS_SENTENCE}\n`
      + '• Program and operate: writes are sent after a confirmation that names the robot and the task.',
    watch: 'Watch only',
    operate: `Program and operate on ${robot.name}`,
  };
}

/** The non-modal notice at the first connect of a robot Add Robot saved, when the controller answers as real or unknown. */
export function firstConnectNotice(robot: ConfirmRobot, ctrlClass: CtrlClass): string {
  const says = ctrlClass === 'real' ? 'reports itself as a real controller' : 'does not say what kind of controller it is';
  return `${robot.name} ${says}, so RAPID Live is watch-only on it. It reads and sends no writes.`;
}

/** The Set Robot Mode dialog, to Program and operate. */
export function switchToOperateText(robot: ConfirmRobot, ctrlClass: CtrlClass | 'not-read'): { message: string; detail: string; button: string } {
  const says = ctrlClass === 'virtual' ? 'reports itself as a virtual controller'
    : ctrlClass === 'real' ? 'reports itself as a real controller'
    : ctrlClass === 'unknown' ? 'does not say what kind of controller it is'
    : 'has not been read yet (connect it first)';
  return {
    message: `Program and operate on ${robotLabel(robot)}?`,
    detail: `${robot.name} ${says}. Program and operate sends writes after a confirmation that names the robot and the task.`,
    button: `Program and operate on ${robot.name}`,
  };
}

/** The Set Robot Mode dialog, to Watch only. */
export function switchToWatchText(robot: ConfirmRobot): { message: string; detail: string; button: string } {
  return {
    message: `Watch only on ${robotLabel(robot)}?`,
    detail: `RAPID Live reads from ${robot.name} and sends no writes. Before that it withdraws the RobotWare 8 motion control and releases the locks it holds on this robot, and says so. ${TEMP_READS_SENTENCE}`,
    button: `Watch only on ${robot.name}`,
  };
}

/** The status bar item and the Robots view badge for a verdict. */
export function modeBadge(verdict: ModeVerdict): { text: string; description: string; tooltip: string; warning: boolean } {
  if (verdict.mode === 'operate') {
    const real = verdict.ctrlClass !== 'virtual';
    return {
      text: '$(tools) Program and operate',
      description: 'operate',
      tooltip: real
        ? 'Program and operate on a controller that does not report itself as virtual: writes are sent after a confirmation. Click to switch to Watch only.'
        : 'Program and operate (virtual controller): writes are sent after a confirmation. Click to switch to Watch only.',
      warning: real,
    };
  }
  const why: Record<WatchReason, string> = {
    'controller type not read': 'the kind of controller is not read yet',
    chosen: 'chosen for this robot',
    dismissed: 'the question was dismissed; the choice stands until you switch',
    'real controller': 'the controller reports itself as real',
    'unknown controller': 'the controller does not say what kind it is',
    'record no longer matches': 'the controller or its address changed since the choice was made',
  };
  return {
    text: '$(eye) Watch only',
    description: 'watch only',
    tooltip: `Watch only: RAPID Live reads and sends no writes (${why[verdict.reason]}). ${TEMP_READS_SENTENCE} Click to switch.`,
    warning: false,
  };
}
