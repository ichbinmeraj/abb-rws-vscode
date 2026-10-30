// The two flows that set a robot's mode, without `vscode`, so the unit tests
// can run them against stubs (review finding 19): settling the mode after a
// connect (the first-connect notice, the ask-once question) and Set Robot
// Mode (the switch to Program and operate or to Watch only, with what the
// switch to Watch only gives up first). The rule itself is `effectiveMode`
// (src/watchMode.ts); the extension hands these flows a robot read live at
// each step and the window they talk through.

import { robotLabel, type ConfirmRobot } from './confirm';
import {
  KEEP_WATCHING, SWITCH_TO_OPERATE, answerRecord, askOnceText, firstConnectNotice, switchToOperateText, switchToWatchText,
  type ModeVerdict, type RobotModes,
} from './watchMode';

/** One robot as the flows see it (a RobotEntry in the extension), read live at each step. */
export interface ModeRobot {
  id: string;
  /** The robot as the dialogs name it. */
  robot: ConfirmRobot;
  connected(): boolean;
  /** Whether the client has read the controller's identity (its type) on this connection. */
  identityRead(): boolean;
  /** The client's slow read now (identity, system info), so the mode is settled on this connect and not on a later poll. */
  refresh(): Promise<void>;
  /** The mode now, from the live state and the record (`effectiveMode`). */
  verdict(): ModeVerdict;
  /** RobotWare 8 with motion control allowed from this station: the switch to Watch only withdraws it first. */
  motionAllowedHere(): boolean;
  withdraw(): Promise<void>;
  /** The reducing send that releases this tool's own locks (inside the wrapper, in the extension). Throws when nothing was released. */
  releaseLocks(): Promise<void>;
}

/** The window the flows talk through (`vscode.window` and the extension log). */
export interface ModeUi {
  /** A notice with buttons the person may click later: the choice, or undefined. The flow does not wait for it. */
  notice(message: string, buttons: string[]): PromiseLike<string | undefined>;
  /** A modal question: the button chosen, or undefined when closed. */
  modal(message: string, detail: string, buttons: string[]): PromiseLike<string | undefined>;
  info(message: string): void;
  warn(message: string): void;
  log(line: string): void;
  /** Runs Set Robot Mode for one robot, to Program and operate (the first-connect notice's button). */
  switchToOperate(id: string): void;
  refreshBadge(): void;
}

/**
 * After a connect: the controller's type is read now if the client has not
 * read it yet. A robot added before 1.5.0 (an `auto` record with the class
 * unknown) gets its class recorded, and a notice with the switch when that
 * makes it watch-only. A real or unknown controller with no answer on record
 * is asked once, modally; closing the question records watch. A controller
 * whose type could not be read is left as it is: watch-only until the type
 * arrives, and asked on a later connect.
 */
export async function settleMode(r: ModeRobot, modes: RobotModes, ui: ModeUi): Promise<void> {
  if (r.connected() && !r.identityRead()) { await r.refresh().catch(() => undefined); }
  const verdict = r.verdict();
  if (verdict.ctrlClass === 'not-read') { return; }
  const record = modes.get(r.id);
  if (record?.mode === 'auto' && record.ctrlClass === 'unknown') {
    await modes.set(r.id, { ...record, ctrlClass: verdict.ctrlClass });
    if (verdict.mode === 'watch') {
      const button = SWITCH_TO_OPERATE(r.robot.name);
      void Promise.resolve(ui.notice(firstConnectNotice(r.robot, verdict.ctrlClass), [button, KEEP_WATCHING])).then(choice => {
        if (choice === button) { ui.switchToOperate(r.id); }
      });
    }
    ui.refreshBadge();
    return;
  }
  if (verdict.mode === 'watch' && verdict.askDue) {
    const t = askOnceText(r.robot, verdict.ctrlClass);
    const choice = await ui.modal(t.message, t.detail, [t.watch, t.operate]);
    const mode = choice === t.operate ? 'operate' : 'watch';
    await modes.set(r.id, answerRecord(mode, choice === undefined ? 'dismissed' : 'chosen', verdict.ctrlClass, r.robot.host, r.robot.port));
    ui.log(`"${r.robot.name}": mode ${mode} (${choice === undefined ? 'the question was dismissed' : 'chosen'}; the controller is ${verdict.ctrlClass})`);
    ui.refreshBadge();
  }
}

/**
 * Set Robot Mode: to `want`, or to the other mode than the robot's now. To
 * Program and operate: only a connected robot whose type is read, after a
 * modal question; the answer is bound to that type, host and port. To Watch
 * only: after a modal question; a connected robot first withdraws motion
 * control it holds (RobotWare 8) and releases this tool's own locks, and the
 * message says which of the two happened.
 */
export async function setRobotMode(r: ModeRobot, want: 'operate' | 'watch' | undefined, modes: RobotModes, ui: ModeUi): Promise<void> {
  const verdict = r.verdict();
  const name = r.robot.name;
  const target: 'operate' | 'watch' = want ?? (verdict.mode === 'watch' ? 'operate' : 'watch');
  if (target === 'operate') {
    if (verdict.ctrlClass === 'not-read') {
      ui.warn(`Set Robot Mode on ${robotLabel(r.robot)}: connect it first. RAPID Live binds the answer to what the controller reports itself as.`);
      return;
    }
    if (verdict.mode === 'operate') { ui.info(`${name} is in Program and operate already.`); return; }
    const t = switchToOperateText(r.robot, verdict.ctrlClass);
    if (await ui.modal(t.message, t.detail, [t.button]) !== t.button) { return; }
    await modes.set(r.id, answerRecord('operate', 'chosen', verdict.ctrlClass, r.robot.host, r.robot.port));
    ui.info(`Program and operate on ${name}: writes are sent after a confirmation that names the robot and the task.`);
  } else {
    const t = switchToWatchText(r.robot);
    if (await ui.modal(t.message, t.detail, [t.button]) !== t.button) { return; }
    const gaveUp: string[] = [];
    if (r.connected()) {
      if (r.motionAllowedHere()) { await r.withdraw(); gaveUp.push('motion control withdrawn'); }
      try {
        await r.releaseLocks();
        gaveUp.push('its locks released');
      } catch (e) { ui.log(`"${name}": nothing to release before Watch only (${e instanceof Error ? e.message : String(e)})`); }
    }
    await modes.set(r.id, answerRecord('watch', 'chosen', verdict.ctrlClass === 'not-read' ? 'unknown' : verdict.ctrlClass, r.robot.host, r.robot.port));
    ui.info(`Watch only on ${name}: RAPID Live reads and sends no writes.${gaveUp.length ? ` First ${gaveUp.join(', ')}.` : ''}`);
  }
  ui.refreshBadge();
}
