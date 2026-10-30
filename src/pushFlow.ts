// The flow around a module file going to a task (Push Current File, Load
// Program from File, the lens load, Run routine): the parts that need no
// `vscode`, so the tests can drive them with fakes. In this order:
//
//   1. The mode seam, before any dialog: a watch-only or unconfirmed robot
//      refuses here, and nothing below runs.
//   2. The bytes: empty, byte order mark, non-ASCII are refused, naming the line.
//   3. The names: the file name must be the declared module name, exactly.
//   4. The controller's copy, read fresh from the task: a not-found answer
//      means the load adds the module; any other error stops. The polled
//      module list is not consulted (it can be empty, stale or another task's).
//   5. The base compare: nothing to push, same, changed or unknown; changed
//      and unknown stop with the diff and a Push anyway button.
//   6. The confirmation, then, inside the send and only then: the controller's
//      copy once more (a change while the dialog was open, a module gone or
//      one that appeared since stops the push), the restore point from that
//      fresh copy, and the load. A refused or cancelled push leaves no restore
//      point.
//   7. After a failed load (a refusal, or a load the controller took without
//      the named module loaded afterwards): the module is read again; absent, present but
//      changed, and read failed are told apart, each with its own offer.

import type { ConfirmRequest, SendOutcome } from './confirm';
import {
  asciiCheck, baseVerdict, changedText, controllerHash, failureReport, hasNonAscii, moduleNameMismatch, whenText, type BaseVerdict,
} from './pushGuard';
import type { FileOrigin } from './taskResolver';

/** An editor document of the file to load, as the extension sees it (`vscode.TextDocument`). */
export interface EditorDoc { isDirty: boolean; save(): PromiseLike<boolean> }

/**
 * Before a load from a file (Push Current File, Load Program from File, the
 * lens load, Run routine): the editor's unsaved changes are saved first, so
 * the file on disk is the one the editor shows (the lens names a routine the
 * editor has and the disk may not have yet). True when there is nothing to
 * save or the save went through. A save that did not (declined, or failed)
 * sends nothing and says so.
 */
export async function savedBeforeLoad(doc: EditorDoc | undefined, label: string, fileName: string, warn: (message: string) => void): Promise<boolean> {
  if (!doc?.isDirty) { return true; }
  if (await doc.save()) { return true; }
  warn(`${label} not sent: ${fileName} has unsaved changes that were not saved. Save the file, then try again. Nothing was sent.`);
  return false;
}

export interface PushUi {
  /** A modal with these buttons; the button chosen, or undefined when dismissed. */
  modal(message: string, detail: string | undefined, buttons: string[]): PromiseLike<string | undefined>;
  warn(message: string): void;
  info(message: string): void;
  /** Open the file at a line and column (the Go to line button). */
  goToLine(line: number, column: number): PromiseLike<void>;
  /** Show the controller's text against the local file, nothing sent. */
  showDiff(controllerText: string, title: string): PromiseLike<void>;
}

export interface RestorePoint { file: string; nonAscii: boolean; at: string }

/** The loads, with the stop offer; false when cancelled there. */
export interface LoadOps {
  /** The file itself into the task. */
  load(): Promise<boolean>;
  /** A saved copy into the task. */
  reload(file: string): Promise<boolean>;
}

export type SendStep = 'done' | 'cancelled' | 'failed';

/** What the flow needs from the extension, bound to one robot, task and file. */
export interface PushDeps {
  /** The command as the person knows it ("Push Current File"). */
  label: string;
  fileName: string;
  taskName: string;
  robotName: string;
  /** The robot as the dialogs name it. */
  robotLabel: string;
  robotId: string;
  /** The module a file's text declares, else its file name. */
  moduleOf(text: string): string;
  /** The mode seam: the sentence that refuses this write, or undefined. */
  refusal(): string | undefined;
  showRefusal(sentence: string): void;
  readBytes(): Buffer;
  getModuleText(task: string, module: string): Promise<{ text: string; changeCount: number }>;
  /** Whether an error says the module is not there (the client's MODULE_NOT_FOUND or RESOURCE_NOT_FOUND). */
  isNotFound(e: unknown): boolean;
  listModules(task: string): Promise<string[]>;
  origin(): FileOrigin | undefined;
  /** Save the controller's copy; undefined when it could not be written (nothing is sent then). */
  writeRestorePoint(module: string, ctrl: { text: string; changeCount: number }, reason: string): RestorePoint | undefined;
  ui: PushUi;
  /**
   * The confirmed send (`sendTo` in the extension): asks, then runs `run` with
   * the loads, which the extension defines inside the send itself, so every
   * client write sits lexically inside a wrapper for the source scan.
   */
  send(request: ConfirmRequest, run: (ops: LoadOps) => Promise<SendStep>): Promise<SendOutcome<SendStep>>;
  errorText(e: unknown): string;
  showError(e: unknown): void;
  /** Record the file's origin with the controller's copy as the base, after a successful load. */
  recordBase(module: string, text: string): Promise<void>;
}

export interface Preflight {
  text: string;
  bytes: number;
  fileName: string;
  moduleName: string;
  /** The module is loaded in that task (read fresh): the load replaces it. */
  replaces: boolean;
  base: BaseVerdict | undefined;
  ctrl?: { text: string; changeCount: number };
  /** The person chose Push anyway over a changed or unknown base. */
  anyway: boolean;
}

/** Steps 1 to 5. Undefined when the flow stopped; the message said why. Nothing is sent by it. */
export async function preflight(d: PushDeps): Promise<Preflight | undefined> {
  const refusal = d.refusal();
  if (refusal !== undefined) { d.showRefusal(refusal); return undefined; }
  // A .prg is a program, not a module: the client would load it under the name "X.prg" while the dialog would say X.
  if (/\.prg$/i.test(d.fileName)) {
    d.ui.warn(`${d.label} not sent: ${d.fileName} is a program file. RAPID Live loads modules (.mod and .sys). Load a program from RobotStudio or the FlexPendant. Nothing was sent.`);
    return undefined;
  }
  let bytes: Buffer;
  try { bytes = d.readBytes(); }
  catch (e) { d.ui.warn(`${d.label} not sent: ${d.fileName} cannot be read (${d.errorText(e)}).`); return undefined; }
  const ascii = asciiCheck(bytes, d.label, d.fileName);
  if (!ascii.ok) {
    const first = ascii.offenders[0];
    const goTo = first ? `Go to line ${first.line}` : undefined;
    const choice = await d.ui.modal(ascii.message, undefined, goTo ? [goTo] : []);
    if (goTo && choice === goTo && first) { await d.ui.goToLine(first.line, first.column); }
    return undefined;
  }
  const text = ascii.text;
  const moduleName = d.moduleOf(text);
  const mismatch = moduleNameMismatch(d.label, d.fileName, moduleName);
  if (mismatch) { await d.ui.modal(mismatch, undefined, []); return undefined; }
  // The controller's copy, fresh: the poll's list is not asked.
  let ctrl: { text: string; changeCount: number } | undefined;
  try { ctrl = await d.getModuleText(d.taskName, moduleName); }
  catch (e) {
    if (!d.isNotFound(e)) { d.showError(e); return undefined; }
  }
  if (!ctrl) { return { text, bytes: bytes.length, fileName: d.fileName, moduleName, replaces: false, base: undefined, anyway: false }; }
  const verdict = baseVerdict(d.origin(), d.robotId, d.taskName, ctrl.text, text);
  if (verdict.kind === 'nothing-to-push') {
    d.ui.info(`${d.label}: nothing to push. ${moduleName} in ${d.taskName} on ${d.robotName} already equals ${d.fileName}.`);
    return undefined;
  }
  let anyway = false;
  if (verdict.kind !== 'same') {
    const t = changedText(verdict, moduleName, d.taskName, d.robotLabel, d.fileName);
    const choice = await d.ui.modal(t.message, t.detail, [t.showDiff, t.pushAnyway]);
    if (choice === t.showDiff) {
      await d.ui.showDiff(ctrl.text, `${d.taskName}/${moduleName} on ${d.robotName} (controller, read ${whenText(new Date().toISOString())}) <-> ${d.fileName} (local)`);
      return undefined;
    }
    if (choice !== t.pushAnyway) { return undefined; }
    anyway = true;
  }
  return { text, bytes: bytes.length, fileName: d.fileName, moduleName, replaces: true, base: verdict, ctrl, anyway };
}

/** The dialog lines of a load, from its preflight; the last line is the pointer. */
export function loadBullets(pre: Preflight, taskName: string): string[] {
  return [
    pre.replaces
      ? `Replaces module ${pre.moduleName} in ${taskName} with ${pre.fileName} (${pre.bytes} bytes, ASCII). The module is unloaded, then loaded. If the load fails, RAPID Live offers to reload the copy it saved.`
      : `Adds module ${pre.moduleName} to ${taskName} from ${pre.fileName} (${pre.bytes} bytes, ASCII).`,
    ...(pre.replaces ? [`The controller's copy is saved as a restore point before anything is sent, once this is confirmed.${pre.ctrl && hasNonAscii(pre.ctrl.text) ? ' It contains non-ASCII characters; the saved copy cannot be reloaded by RAPID Live yet.' : ''}`] : []),
    ...(pre.anyway && pre.base?.kind === 'changed' ? [`Overwrites changes made on the controller since ${whenText(pre.base.recordedAt)}.`] : []),
    ...(pre.anyway && pre.base?.kind === 'unknown' ? ['Overwrites the controller\'s copy, of which RAPID Live has no record.'] : []),
    'The program pointer is not moved.',
  ];
}

/**
 * Step 6 inside the send: the controller's copy once more, now that the
 * dialog is answered (the dialog described the copy read before it; a change
 * meanwhile, a module gone or one that appeared since sends nothing), then
 * the restore point from that fresh copy (only now, after the confirmation),
 * then the load. A failed load runs the failure flow and answers `failed`; a
 * load cancelled at the stop offer, or stopped here, answers `cancelled`; on
 * `done` the origin is recorded with the controller's copy as the base.
 */
export async function loadInsideSend(d: PushDeps, pre: Preflight, ops: LoadOps): Promise<SendStep> {
  const stop = (why: string): SendStep => { d.ui.warn(`${d.label} not sent: ${why} Nothing was sent.`); return 'cancelled'; };
  let ctrl = pre.ctrl;
  try {
    const now = await d.getModuleText(d.taskName, pre.moduleName);
    if (!ctrl) { return stop(`${pre.moduleName} was loaded into ${d.taskName} while the dialog was open. Push again to see it against your file.`); }
    if (controllerHash(now.text) !== controllerHash(ctrl.text)) { return stop(`the controller's copy of ${pre.moduleName} in ${d.taskName} changed while the dialog was open. Push again to see the new diff.`); }
    ctrl = now;
  } catch (e) {
    if (!d.isNotFound(e)) { d.showError(e); return 'cancelled'; }
    if (ctrl) { return stop(`${pre.moduleName} was unloaded from ${d.taskName} while the dialog was open. Push again to add it.`); }
  }
  let restore: RestorePoint | undefined;
  if (ctrl) {
    restore = d.writeRestorePoint(pre.moduleName, ctrl, `before ${d.label} of ${pre.fileName}`);
    if (!restore) { return 'cancelled'; }
  }
  // The task's modules before and after the load. The controller can take a file and still not load the module the
  // dialog named: RobotWare 6.16 loads a file with no MODULE line under another name ("this is not RAPID" became a
  // module "this", 2026-10-30), 7.21.4 refuses such a file after unloading the old module, and a clash lands as
  // NAME#2 beside a module that stayed. Either way the named module is not what the dialog said afterwards, and that
  // is a failed load, with the same flow as a refused one (loadLanded).
  const before = await taskModules(d);
  try {
    if (!await ops.load()) { return 'cancelled'; }
  } catch (e) {
    await afterFailedLoad(d, pre, restore, e);
    return 'failed';
  }
  // An empty list is a read that answered nothing, not a task with no module: the module was just loaded into it. A
  // list that cannot be read after the load is not held against the load either (fail open, by design): the
  // controller answered the load, and the next push's fresh read is the check.
  const after = await taskModules(d);
  if (after && after.length > 0) {
    const landed = loadLanded(pre.moduleName, d.taskName, before, after);
    if (!landed.landed) {
      await afterFailedLoad(d, pre, restore, new Error(`the controller took ${pre.fileName}, but ${landed.why}`));
      return 'failed';
    }
  }
  await d.recordBase(pre.moduleName, pre.text);
  return 'done';
}

/** The task's module list, or undefined when it cannot be read. */
async function taskModules(d: PushDeps): Promise<string[] | undefined> {
  try { return await d.listModules(d.taskName); } catch { return undefined; }
}

/**
 * After a load the controller took: whether the module the dialog named is
 * listed under that exact name, with nothing landed under a numbered name.
 * The client unloads only an exact-case match of the file's name, and
 * RobotWare lists a clash as `NAME#2`: a module held under another case
 * stays, and the new copy lands renamed, so a case-blind match would report
 * "Pushed" with the old text as the base. `before` undefined means the list
 * before the load was not read: then no stray name is guessed.
 */
export function loadLanded(moduleName: string, task: string, before: string[] | undefined, after: string[]): { landed: true } | { landed: false; why: string } {
  const isNew = (n: string): boolean => before !== undefined && !before.includes(n);
  const exact = after.includes(moduleName);
  const renamed = after.filter(n => /#\d+$/.test(n) && (before === undefined ? n.toLowerCase().startsWith(`${moduleName.toLowerCase()}#`) : isNew(n)));
  if (exact && renamed.length === 0) { return { landed: true }; }
  if (exact) {
    return { landed: false, why: `${moduleName} is listed in ${task}, but ${renamed.join(', ')} landed beside it: the old module stayed and the new copy got a numbered name` };
  }
  const stray = before === undefined ? renamed : after.filter(isNew);
  const held = after.filter(n => n !== moduleName && n.toLowerCase() === moduleName.toLowerCase() && !stray.includes(n));
  return {
    landed: false,
    why: `no module ${moduleName} is loaded in ${task} afterwards${stray.length ? ` (it loaded ${stray.join(', ')} instead)` : ''}${held.length ? `, and ${held.join(', ')} is still there under another case` : ''}`,
  };
}

/**
 * Restore Module from Restore Point, inside the send: the module loaded in
 * the task now, if any, is saved as a restore point of its own, then the saved
 * copy is loaded (the deps are built on the saved copy's file, so `ops.load`
 * loads it). A read that fails for another reason than "not loaded" sends
 * nothing and shows the error; a restore point that cannot be written sends
 * nothing; a load cancelled at the stop offer answers `cancelled`.
 */
export async function restoreInsideSend(d: PushDeps, moduleName: string, ops: LoadOps): Promise<SendStep> {
  let live: { text: string; changeCount: number } | undefined;
  try { live = await d.getModuleText(d.taskName, moduleName); }
  catch (e) { if (!d.isNotFound(e)) { d.showError(e); return 'cancelled'; } }
  if (live && !d.writeRestorePoint(moduleName, live, `before the restore of ${moduleName}`)) { return 'cancelled'; }
  const before = await taskModules(d);
  if (!await ops.load()) { return 'cancelled'; }
  // The read-back: a reload that landed under a numbered name is not "reloaded". An unreadable list is not held against it.
  const after = await taskModules(d);
  if (after && after.length > 0) {
    const landed = loadLanded(moduleName, d.taskName, before, after);
    if (!landed.landed) { d.ui.warn(`${d.label}: the saved copy was loaded, but ${landed.why}. Nothing else was changed.`); return 'failed'; }
  }
  return 'done';
}

/** Push Current File and Load Program from File: the preflight, the disruptive confirmation, the send. The text on `done`. */
export async function pushModule(d: PushDeps): Promise<{ text: string } | undefined> {
  const pre = await preflight(d);
  if (!pre) { return undefined; }
  const out = await d.send({ label: d.label, tier: 'disruptive', taskApplies: true, task: d.taskName, sideEffects: loadBullets(pre, d.taskName) }, ops => loadInsideSend(d, pre, ops));
  return out.sent && out.value === 'done' ? { text: pre.text } : undefined;
}

export type AfterLoadState = 'absent' | 'present-same' | 'present-changed' | 'read-failed';

/** Step 7's reading: what is loaded in the task now, against the copy saved before the push. */
export async function moduleStateAfter(d: PushDeps, pre: Preflight): Promise<{ state: AfterLoadState; text?: string; changeCount?: number; error?: string }> {
  try {
    const now = await d.getModuleText(d.taskName, pre.moduleName);
    const same = pre.ctrl !== undefined && controllerHash(now.text) === controllerHash(pre.ctrl.text);
    return { state: same ? 'present-same' : 'present-changed', text: now.text, changeCount: now.changeCount };
  } catch (e) {
    if (d.isNotFound(e)) { return { state: 'absent' }; }
    // A second opinion: the task's list, which needs no module read.
    try {
      const names = await d.listModules(d.taskName);
      if (!names.some(n => n.toLowerCase() === pre.moduleName.toLowerCase())) { return { state: 'absent' }; }
    } catch { /* the list could not be read either */ }
    return { state: 'read-failed', error: d.errorText(e) };
  }
}

/**
 * After a failed load. When nothing was to be replaced, the error is shown as
 * it is. Otherwise the module is read again: still there as it was, nothing
 * was lost; gone, the saved copy is offered back; there but changed, the offer
 * says it replaces the loaded module and saves that one first; the read
 * failed, the saved copy is named and nothing is offered. One closing message
 * states what happened to each step.
 */
export async function afterFailedLoad(d: PushDeps, pre: Preflight, restore: RestorePoint | undefined, e: unknown): Promise<void> {
  const reason = d.errorText(e);
  const report = (what: Parameters<typeof failureReport>[5]): string => failureReport(d.label, pre.fileName, d.taskName, d.robotLabel, reason, what);
  if (!restore || !pre.ctrl) { d.showError(e); return; }
  const after = await moduleStateAfter(d, pre);
  if (after.state === 'present-same') { d.ui.warn(report('not-needed')); return; }
  if (after.state === 'read-failed') {
    d.ui.warn(`${report({ failed: `the module could not be read back (${after.error ?? 'no detail'}), so RAPID Live cannot tell whether ${pre.moduleName} is still loaded` })} The saved copy is at ${restore.file}.`);
    return;
  }
  if (restore.nonAscii) { d.ui.warn(report('withheld')); return; }
  const reload = 'Reload the saved copy…';
  const present = after.state === 'present-changed';
  const detail = present
    ? `${pre.moduleName} is loaded in ${d.taskName}, but not as it was before the push. RAPID Live saved the controller's copy at ${whenText(restore.at)}. Reloading it replaces the module loaded now, after saving that one as a restore point too.`
    : `The module ${pre.moduleName} is no longer loaded in ${d.taskName}. RAPID Live saved the controller's copy at ${whenText(restore.at)}.`;
  const choice = await d.ui.modal(`${d.label} of ${pre.fileName} to ${d.taskName} on ${d.robotLabel} failed: ${reason}`, detail, [reload, 'Leave it']);
  if (choice !== reload) { d.ui.warn(report('declined')); return; }
  try {
    const out = await d.send({
      label: `Restore module ${pre.moduleName}`, tier: 'disruptive', taskApplies: true, task: d.taskName,
      sideEffects: [
        `Loads ${restore.file}, the controller's copy as of ${whenText(restore.at)}, into ${d.taskName}.${present ? ` It replaces the module loaded there now, which is saved as a restore point first.` : ''}`,
        'The program pointer is not moved.',
      ],
    }, async ops => {
      if (present && after.text !== undefined) {
        const saved = d.writeRestorePoint(pre.moduleName, { text: after.text, changeCount: after.changeCount ?? 0 }, `before the restore of ${pre.moduleName}`);
        if (!saved) { return 'cancelled'; }
      }
      return (await ops.reload(restore.file)) ? 'done' : 'cancelled';
    });
    if (!out.sent || out.value !== 'done') { d.ui.warn(report('declined')); return; }
    d.ui.info(report('reloaded'));
  } catch (e2) {
    d.ui.warn(report({ failed: d.errorText(e2) }));
  }
}
