// Which RAPID task a command acts on: the parts that need no `vscode`, so the
// unit tests can state the rule.
//
// One rule for every command that names a task. On a multi-task system
// (MultiMove, or a background task beside the robot task) nothing goes to a
// task for being first in the controller's list, and there is no default
// task name: when the rule cannot tell, the person picks.
//
//   1. A task the caller already knows (a Program panel row, a picked module) wins.
//   2. Then the task the file was pulled from (Pull, Pull All). When this robot
//      does not have that task, the person picks, on any robot.
//   3. Then the one task that lists the module, when exactly one does.
//   4. Then the one active task, on a single-task system.
//   5. Otherwise the person picks from the tasks that list the module, or
//      from every active task when none or one does not settle it.

import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** The slice of RobotState the rule reads. */
export interface TaskState {
  tasks: Array<{ name: string; active: boolean }>;
  modules: string[];
  /** Every active task's loaded modules (client 1.3.1 and later). */
  modulesByTask?: Record<string, string[]>;
}

/** What Pull, Pull All and a successful Push recorded for one file path. */
export interface FileOrigin {
  /** The task the text was read from or written to. */
  task: string;
  /** sha256 of the text as it was written, hex. */
  hash: string;
  /** The saved robot entry it came from. */
  robotId?: string;
  /** When it was recorded, ISO 8601. */
  at?: string;
}

export interface TaskQuery {
  /** A task the caller already knows: it wins. */
  explicit?: string;
  /** The module the command is about, when there is one. */
  module?: string;
  /** The file's recorded task (`FileOrigin.task`), when there is one. */
  recorded?: string;
}

export type TaskAnswer =
  | { kind: 'task'; task: string; why: 'explicit' | 'recorded' | 'listed' | 'single' }
  /** The person picks. `listing` are the candidates that list the module. */
  | { kind: 'ask'; candidates: string[]; listing: string[]; recordedMissing?: string }
  | { kind: 'none'; reason: string };

/** The names of the active tasks, in the controller's order. */
export function activeTasks(state: TaskState): string[] {
  return state.tasks.filter(t => t.active).map(t => t.name);
}

/**
 * The tasks whose module list holds `module`, ignoring case (RAPID names are
 * not case-sensitive). Only the per-task lists count: the flat `modules` list
 * belongs to no task this rule can name.
 */
export function tasksListing(state: TaskState, module: string): string[] {
  const want = module.toLowerCase();
  return Object.entries(state.modulesByTask ?? {})
    .filter(([, mods]) => mods.some(m => m.toLowerCase() === want))
    .map(([task]) => task);
}

/** The rule above, with no prompt: a task, a question for the person, or nothing to act on. */
export function decideTask(state: TaskState, q: TaskQuery): TaskAnswer {
  if (q.explicit) { return { kind: 'task', task: q.explicit, why: 'explicit' }; }
  const listing = q.module ? tasksListing(state, q.module) : [];
  const active = activeTasks(state);
  if (q.recorded) {
    if (state.tasks.some(t => t.name === q.recorded)) { return { kind: 'task', task: q.recorded, why: 'recorded' }; }
    // The file came from a task this robot does not have (another cell, say):
    // the person picks, even on a single-task robot, so a file of T_ROB2
    // never lands in T_ROB1 by default.
    if (active.length > 0) { return { kind: 'ask', candidates: active, listing, recordedMissing: q.recorded }; }
  }
  if (listing.length === 1) { return { kind: 'task', task: listing[0], why: 'listed' }; }
  if (active.length === 1) { return { kind: 'task', task: active[0], why: 'single' }; }
  if (active.length === 0) {
    return { kind: 'none', reason: state.tasks.length === 0 ? 'its task list has not been read yet' : 'it has no active task' };
  }
  return { kind: 'ask', candidates: listing.length > 1 ? listing : active, listing };
}

/** `decideTask` for what cannot ask (a hover, an inlay hint, a line marker): the task, or undefined. */
export function quietTask(state: TaskState, q: TaskQuery): string | undefined {
  const a = decideTask(state, q);
  return a.kind === 'task' ? a.task : undefined;
}

/** One row of the task pick. */
export interface TaskPickItem { label: string; description?: string; task: string }

/** The window the resolver talks through (`vscode.window` in the extension). */
export interface TaskUi {
  /** A quick pick; the task picked, or undefined when dismissed. */
  pick(items: TaskPickItem[], title: string, placeHolder: string): PromiseLike<string | undefined>;
  warn(message: string): void;
}

/**
 * The task for a command on one robot: decided by the rule, or picked by the
 * person when it cannot tell. Undefined when the person dismissed the pick or
 * there is no task to act on (the warning says which).
 * `purpose` is the command as the person knows it ("Push Current File");
 * `robot` names the robot as the dialogs do.
 */
export async function resolveTask(
  ui: TaskUi, robot: string, state: TaskState, q: TaskQuery, purpose: string,
): Promise<string | undefined> {
  const a = decideTask(state, q);
  if (a.kind === 'task') { return a.task; }
  if (a.kind === 'none') {
    ui.warn(`${purpose} on ${robot}: nothing sent, ${a.reason}. Refresh the robot, then try again.`);
    return undefined;
  }
  const what = q.module ? `${q.module}` : undefined;
  const items: TaskPickItem[] = a.candidates.map(task => ({
    label: task,
    description: what && a.listing.includes(task) ? `${what} is loaded here` : undefined,
    task,
  }));
  const why = a.recordedMissing
    ? `the file was pulled from ${a.recordedMissing}, which ${robot} does not have`
    : a.listing.length > 1 ? `${what} is loaded in ${a.listing.join(' and ')}`
    : `${robot} runs ${a.candidates.length} tasks`;
  const placeHolder = what ? `Which task of ${robot} is ${what} for? (${why})` : `Which task of ${robot}? (${why})`;
  return await ui.pick(items, `${purpose} on ${robot}`, placeHolder);
}

/** sha256 of a module's text as written to a file, hex. */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The key a file's origin is kept under: the resolved path, lower-cased on
 * Windows, where two spellings name one file.
 */
export function originKey(fsPath: string, platform: string = process.platform): string {
  const p = path.resolve(fsPath);
  return platform === 'win32' ? p.toLowerCase() : p;
}
