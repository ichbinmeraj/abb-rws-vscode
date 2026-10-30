// Confirmations before a write: the parts that need no `vscode`, so the unit
// tests can state the dialog texts.
//
// A confirmation names the robot and, where one applies, the task, and
// blocks nothing: a cancelled one sends nothing, a confirmed one sends. There
// is no setting that skips one.
//
// Since 1.5.0 the confirmation and the send are one call: `sendConfirmed`
// asks and then runs the write it was given, and `sendReducing` runs a write
// that only stops or gives up, with no dialog. Every call to a client write
// method in src/ sits inside one of them (test/writeSites.test.ts scans for
// it), so a write cannot leave RAPID Live without the dialog that names the
// robot.

import type { RemedyConfirmation } from 'abb-rws-client';

/** The robot a write goes to, as the dialogs name it. */
export interface ConfirmRobot {
  /** The name saved in the robot list. */
  name: string;
  host: string;
  port?: number;
  /** The name the controller reports for itself (`/ctrl/identity`), once read. */
  reportedName?: string | null;
}

/**
 * `motion`: the robot can move (start, run a routine, motors on, a UI
 * answer, a jog); the user types the robot's name. `disruptive`: the
 * controller's state or files change in a way that is hard to undo (restart,
 * restore, a CFG file load, the mode lock, a delete, a log clear); one button
 * naming the robot. `change`: a value changes (a signal, a CFG instance); one
 * acknowledgement naming the robot. `declaration`: a person's safety
 * confirmation (RobotWare 8 Allow Motion Control): the client's text
 * (`confirmationFor`) first, then RAPID Live's lines, the client's button, and
 * the robot's name typed in the client's words.
 */
export type ConfirmTier = 'motion' | 'disruptive' | 'change' | 'declaration';

export interface ConfirmRequest {
  /** What the command is called, e.g. "Start RAPID". */
  label: string;
  tier: ConfirmTier;
  /** What the write does on the controller, one sentence each; for `declaration`, RAPID Live's own lines. */
  sideEffects: string[];
  /**
   * Whether the write goes to a RAPID task. Required, so every request states
   * it: true with `task` (one task) or `tasks` (the whole execution), false
   * for a write that has no task (a signal, the clock, a file). A request
   * that says true and names none is a fault: `sendConfirmed` sends nothing.
   */
  taskApplies: boolean;
  /** The one task the write goes to; the title says "in <task>" and the detail "Task: <task>". */
  task?: string;
  /** An execution-wide write (Start, PP to Main): every task the write acts on. */
  tasks?: string[];
  /**
   * The one dialog that may be skipped: a repeat jog, after the first jog of
   * this robot and connection was confirmed at this increment or a higher one
   * (`jogNeedsAsk`). No other value exists, and the source scan refuses any other.
   */
  skipAsk?: 'jog-repeat';
  /**
   * `motion` only: paragraphs shown apart from what the write does, after it
   * (RobotWare 8: whether motion control is allowed from this station).
   */
  notes?: string[];
  /**
   * `motion` only: a second button on the first dialog (RobotWare 8:
   * "Allow Motion Control first…"). Choosing it sends nothing and asks for no
   * name; `confirmChoice` answers `alt`.
   */
  altButton?: string;
  /** With `altButton`: what that button does, said before "Otherwise choose Continue". */
  altHint?: string;
  /** `declaration` only: the client's confirmation text, shown verbatim before RAPID Live's lines. */
  confirmation?: RemedyConfirmation;
}

/** How a confirmation ended: confirmed (send), cancelled (send nothing), or the second button (send nothing). */
export type ConfirmChoice = 'confirmed' | 'cancelled' | 'alt';

/** The task words of a dialog: " in <task>" for the title, "Task: …" or "Tasks: …" for the detail, and the log's form. */
export function taskWords(request: Pick<ConfirmRequest, 'task' | 'tasks'>): { title: string; line: string | undefined; log: string } {
  if (request.task) { return { title: ` in ${request.task}`, line: `Task: ${request.task}`, log: request.task }; }
  const tasks = request.tasks ?? [];
  if (tasks.length === 1) { return { title: '', line: `Task: ${tasks[0]}`, log: tasks[0] }; }
  if (tasks.length > 1) { return { title: '', line: `Tasks: ${tasks.join(', ')} (the controller runs them together)`, log: tasks.join(',') }; }
  return { title: '', line: undefined, log: 'none' };
}

/** The window the confirmation talks through (`vscode.window` in the extension). */
export interface ConfirmUi {
  /** A modal with these buttons; the button chosen, or undefined when dismissed. */
  modal(message: string, detail: string, buttons: string[]): PromiseLike<string | undefined>;
  /** An input box; undefined when dismissed. */
  input(title: string, prompt: string, placeHolder: string): PromiseLike<string | undefined>;
  warn(message: string): void;
}

/** Where a robot's session is, as its RobotManager reports it. */
export interface RobotSession {
  connected: boolean;
  /** The host the session connected to (`RobotState.host`); empty before the first connect. */
  host: string;
  /** The port the session is on (`RobotManager.currentPort`). */
  port?: number;
}

/**
 * The robot as the dialogs name it. While it is connected, the address is the one its session
 * is on, which is where a write goes: a saved address changed since (in another window, by a
 * hand edit) is used only from the next connect. Otherwise the saved address.
 */
export function confirmRobot(
  saved: { name: string; host: string; port?: number }, session: RobotSession, reportedName: string | null,
): ConfirmRobot {
  return session.connected && session.host !== ''
    ? { name: saved.name, host: session.host, port: session.port, reportedName }
    : { name: saved.name, host: saved.host, port: saved.port, reportedName };
}

/** `name (host:port)`, plus the controller's own name when it differs. */
export function robotLabel(robot: ConfirmRobot): string {
  const where = robot.port !== undefined ? `${robot.host}:${robot.port}` : robot.host;
  const reported = robot.reportedName && robot.reportedName !== robot.name ? `, reports itself as '${robot.reportedName}'` : '';
  return `${robot.name} (${where})${reported}`;
}

const bullets = (lines: string[]): string => lines.map(l => `• ${l}`).join('\n');

/**
 * Ask before a write. Resolves true when the user confirmed on this robot;
 * false when they cancelled, dismissed a box, or typed a name that is not the
 * robot's. The caller sends nothing on false.
 */
export async function confirmWrite(ui: ConfirmUi, robot: ConfirmRobot, request: ConfirmRequest): Promise<boolean> {
  return await confirmChoice(ui, robot, request) === 'confirmed';
}

/**
 * Ask before a write, as `confirmWrite`, and say which way it ended: `alt`
 * when the person chose the request's second button (nothing is sent; the
 * caller decides what follows).
 */
export async function confirmChoice(ui: ConfirmUi, robot: ConfirmRobot, request: ConfirmRequest): Promise<ConfirmChoice> {
  const task = taskWords(request);
  const message = `${request.label}${task.title} on ${robotLabel(robot)}`;
  const taskLine = task.line ? `${task.line}\n` : '';
  const name = robot.name.trim();
  if (!name) {
    // An empty name would match an empty box: nothing to confirm against, so nothing is sent.
    ui.warn(`${request.label} not sent: this robot has no saved name. Give it a name in the Robots view (Configure), then try again.`);
    return 'cancelled';
  }
  const typedName = async (prompt: string): Promise<ConfirmChoice> => {
    const typed = await ui.input(`${request.label} on ${name}`, prompt, name);
    if (typed === undefined) { return 'cancelled'; }
    if (typed.trim() !== name) {
      ui.warn(`${request.label} not sent to ${name}: "${typed}" is not its name.`);
      return 'cancelled';
    }
    return 'confirmed';
  };
  switch (request.tier) {
    case 'motion': {
      const notes = (request.notes ?? []).map(n => `${n}\n\n`).join('');
      const choose = request.altButton && request.altHint
        ? `${request.altHint} Otherwise choose Continue`
        : 'Choose Continue';
      const detail = `${taskLine}This can move the robot.\n\n${bullets(request.sideEffects)}\n\n${notes}`
        + `Nothing is sent yet. ${choose}, then type the robot's name, ${name}, in the next box.`;
      const buttons = request.altButton ? ['Continue', request.altButton] : ['Continue'];
      const chosen = await ui.modal(message, detail, buttons);
      if (request.altButton && chosen === request.altButton) { return 'alt'; }
      if (chosen !== 'Continue') { return 'cancelled'; }
      return typedName(`Type the robot's name to send it: ${name}`);
    }
    case 'declaration': {
      const c = request.confirmation;
      // Without the client's text, or without its typed name, there is nothing to confirm against.
      if (!c || !c.typeName || !c.typePrompt) {
        ui.warn(`${request.label} not sent to ${name}: there is no confirmation text for it.`);
        return 'cancelled';
      }
      const detail = [...c.lines, ...request.sideEffects,
        `Nothing is sent yet. Choose "${c.confirmLabel}". Then type the robot's name, ${name}.`].join('\n\n');
      if (await ui.modal(c.title, detail, [c.confirmLabel]) !== c.confirmLabel) { return 'cancelled'; }
      return typedName(c.typePrompt);
    }
    case 'disruptive': {
      const button = `Continue on ${name}`;
      return await ui.modal(message, taskLine + bullets(request.sideEffects), [button]) === button ? 'confirmed' : 'cancelled';
    }
    case 'change': {
      const button = `Write to ${name}`;
      return await ui.modal(message, taskLine + bullets(request.sideEffects), [button]) === button ? 'confirmed' : 'cancelled';
    }
  }
}

// ─── The send wrappers ───────────────────────────────────────────────────────

/** The window and the log the wrappers talk through (`vscode.window` and the extension log). */
export interface GuardUi extends ConfirmUi {
  /** One line before each send: `write <label> robot=<name> task=<task|tasks|none> tier=<tier>`. */
  log(line: string): void;
  /** Tests: a request that names no task where one applies throws instead of warning. */
  strict?: boolean;
  /**
   * The per-robot mode (src/watchMode.ts): the sentence that refuses this
   * write before any dialog, or undefined to go on. Required, so no window
   * without the mode seam can be handed to a wrapper; the unit tests of the
   * dialogs answer undefined.
   */
  refuse(label: string, robot: ConfirmRobot): string | undefined;
  /** How a refusal is shown: `warn` unless given (the extension adds the switch button). */
  showRefusal?(sentence: string, robot: ConfirmRobot): void;
}

/** Show the refusal the mode seam gave. */
function showRefusal(ui: GuardUi, sentence: string, robot: ConfirmRobot): void {
  if (ui.showRefusal) { ui.showRefusal(sentence, robot); } else { ui.warn(sentence); }
}

/** How a send ended: sent (with the write's own result), or not, and why. */
export type SendOutcome<T> =
  | { sent: true; value: T }
  | { sent: false; why: 'cancelled' | 'alt' | 'no-task' | 'watch-only' };

export interface SendOptions {
  /**
   * How to ask: `confirmChoice` unless given. The motion flows pass the loop
   * that adds the RobotWare 8 motion-control line and its Allow button
   * (`confirmMotionWrite`).
   */
  ask?: (ui: GuardUi, robot: ConfirmRobot, request: ConfirmRequest) => PromiseLike<ConfirmChoice>;
}

/** The trace line of one send, as the log and the host test read it. */
export function writeTrace(label: string, robot: ConfirmRobot, task: string, tier: string): string {
  return `write ${label} robot=${robot.name} task=${task} tier=${tier}`;
}

/**
 * Ask, then send. In this order: a request that says a task applies and
 * names none sends nothing (a fault in RAPID Live, said as such); the mode
 * seam; the dialog at the request's tier (skipped for a repeat jog only);
 * then `send`, after one trace line. Anything but a confirmation sends
 * nothing and says why. An error `send` throws is the caller's to show, as
 * before.
 */
export async function sendConfirmed<T>(
  ui: GuardUi, robot: ConfirmRobot, request: ConfirmRequest, send: () => PromiseLike<T>, options: SendOptions = {},
): Promise<SendOutcome<T>> {
  const task = taskWords(request);
  if (request.taskApplies && task.log === 'none') {
    ui.log(`write ${request.label} robot=${robot.name} not sent: the request says a task applies and names none`);
    const text = `${request.label} not sent: no task was named. This is a fault in RAPID Live; the log has the details.`;
    if (ui.strict) { throw new Error(text); }
    ui.warn(text);
    return { sent: false, why: 'no-task' };
  }
  const refusal = ui.refuse(request.label, robot);
  if (refusal !== undefined) { showRefusal(ui, refusal, robot); return { sent: false, why: 'watch-only' }; }
  if (request.skipAsk !== 'jog-repeat') {
    const choice = await (options.ask ?? confirmChoice)(ui, robot, request);
    if (choice !== 'confirmed') { return { sent: false, why: choice }; }
  }
  ui.log(writeTrace(request.label, robot, task.log, request.tier));
  return { sent: true, value: await send() };
}

/** A write that only stops or gives up: Stop RAPID, Motors Off, Withdraw Motion Control, the release of this tool's own locks. */
export interface ReducingRequest {
  label: string;
  /**
   * True for a write that only gives up access RAPID Live holds (a withdrawal,
   * a release): the mode seam never refuses it, so a robot can always be let go.
   */
  exemptFromWatchOnly?: boolean;
}

/**
 * Send a reducing write with no dialog: one click stays one click. The mode
 * seam still runs, unless the request is exempt. The source scan allows only
 * Stop, Motors Off, the withdrawal and the lock release inside it.
 */
export async function sendReducing<T>(
  ui: GuardUi, robot: ConfirmRobot, request: ReducingRequest, send: () => PromiseLike<T>,
): Promise<SendOutcome<T>> {
  if (!request.exemptFromWatchOnly) {
    const refusal = ui.refuse(request.label, robot);
    if (refusal !== undefined) { showRefusal(ui, refusal, robot); return { sent: false, why: 'watch-only' }; }
  }
  ui.log(writeTrace(request.label, robot, 'none', 'reducing'));
  return { sent: true, value: await send() };
}

/**
 * What each restart mode does to programs and configuration, for the Restart
 * confirmation. Sources: ABB's troubleshooting manual for IRC5 (3HAC020738),
 * section 6, event 10090 "P-Start done": the system's state is resumed except
 * for manually loaded programs and modules, modules are installed and loaded in
 * accordance with the configuration, system parameters are not affected; ABB's
 * Operating manual - RobotStudio (3HAC032104), Controller tab, the restart
 * modes Reset system (I-start), Reset RAPID (P-start) and Revert to last auto
 * saved (B-start).
 */
export function restartSideEffects(mode: 'restart' | 'pstart' | 'istart' | 'bstart'): string[] {
  const effect: Record<typeof mode, string> = {
    restart: 'Warm restart: programs and configuration are kept; the state of the system is resumed.',
    pstart: 'P-Start (Reset RAPID): removes the modules and programs loaded by hand; modules are loaded again as the configuration says. System parameters are not affected.',
    istart: 'I-Start (Reset system): restores the original installation; programs and configuration are lost.',
    bstart: 'B-Start (Revert to last auto saved): reverts to the last auto-saved state; changes made since then are lost.',
  };
  return [effect[mode], 'RAPID stops; the connection drops until the controller is back.'];
}

/**
 * The warning the client raises before a RAPID start under RobotWare 8 write
 * access (`heartbeat-required`), for the Start and Run routine confirmations:
 * HeartBeat `Select` is true and ABB documents no RWS way to send the
 * heartbeat. Nothing is blocked; the start goes out when confirmed.
 */
export function heartbeatWarning(
  access: { generation: string | null; watchdog: { enforced: boolean | null; timeoutMs: number | null } | null } | null | undefined,
): string | undefined {
  if (!access || access.generation !== 'rw8' || access.watchdog?.enforced !== true) { return undefined; }
  const after = access.watchdog.timeoutMs !== null ? `${access.watchdog.timeoutMs} ms` : 'the HeartBeat timeout';
  return 'The controller requires the station that holds write access to send a periodic heartbeat while RAPID runs. '
    + `RobotWare 8 offers no RWS way to send it, so RAPID may stop after ${after}.`;
}

/** The controller's execution state when the RAPID program is running. */
export function isRapidRunning(execstate: string | null | undefined): boolean {
  return execstate === 'running';
}

/**
 * Set Speed Ratio: a value change; disruptive when the new ratio is higher
 * than the current one while RAPID runs, because a running motion speeds up.
 * A current ratio of null is unread (before the first poll, or after a failed
 * read): the dialog says so instead of a number, and while RAPID runs the
 * write is disruptive, since the motion may speed up.
 */
export function speedRatioRequest(current: number | null, next: number, running: boolean): ConfirmRequest {
  const unread = current === null;
  const raising = running && (unread || next > current);
  return {
    label: 'Set Speed Ratio',
    tier: raising ? 'disruptive' : 'change',
    taskApplies: false,
    sideEffects: [
      unread ? `Changes the speed ratio from an unread value to ${next} %.` : `Changes the speed ratio from ${current} % to ${next} %.`,
      ...(raising ? [unread ? 'RAPID is running and the current ratio is not read: a motion in progress may go faster.' : 'RAPID is running: a motion in progress goes faster.'] : []),
    ],
  };
}

/** Switch Operation Mode (a virtual controller): disruptive. */
export function opModeRequest(from: string, to: string): ConfirmRequest {
  return {
    label: `Switch operation mode to ${to}`,
    tier: 'disruptive',
    taskApplies: false,
    sideEffects: [
      `Asks the controller to change from ${from} to ${to}; the controller may wait for an Accept at the FlexPendant.`,
      'Virtual controller only: a real controller has the key switch.',
    ],
  };
}

/** A simulation action that only a virtual controller takes: disruptive, and says so. */
export function virtualOnlyRequest(label: string, effects: string[]): ConfirmRequest {
  return { label, tier: 'disruptive', taskApplies: false, sideEffects: [...effects, 'Virtual controller only.'] };
}

/**
 * A program change (pointer move, unload) in one task. It always asks; while
 * RAPID runs the first line says so. Set PP to Routine and the service-routine
 * pointer move are a change; Unload Module is disruptive (a module loaded at
 * the FlexPendant and unloaded here has no copy).
 */
export function programChangeRequest(label: string, running: boolean, tier: 'change' | 'disruptive', effects: string[], task: string): ConfirmRequest {
  return { label, tier, taskApplies: true, task, sideEffects: [...(running ? ['RAPID is running.'] : []), ...effects] };
}

/**
 * The start line of a Run routine dialog. The client's start takes no task:
 * it starts the whole execution, so on a multi-task system every other active
 * task runs too, from its own program pointer, and the dialog names them.
 */
export function startEffect(task: string, otherActive: string[], target: string): string {
  if (otherActive.length === 0) { return 'Starts RAPID there; the robot moves as the routine says.'; }
  const pointers = otherActive.length === 1 ? 'its current program pointer' : 'their current program pointers';
  return `Starts RAPID for the whole execution: ${task} from ${target}, and ${otherActive.join(', ')} from ${pointers}. Every robot of those tasks moves as its program says.`;
}

/** What a jog confirmation covered: the axis value, the mechanical unit and the Motion view's axis labels. */
export interface JogConfirmed { value: number; unit: string; labels: string }

/**
 * Whether the first-jog confirmation must be asked: never given on this
 * connection, the axis value is now higher than the one confirmed, the jog
 * goes to another unit (names compared without case, as RAPID compares them),
 * or the axis labels changed since (the dialog names them).
 */
export function jogNeedsAsk(confirmed: JogConfirmed | undefined, now: JogConfirmed): boolean {
  return confirmed === undefined || now.value > confirmed.value
    || now.unit.toLowerCase() !== confirmed.unit.toLowerCase() || now.labels !== confirmed.labels;
}
