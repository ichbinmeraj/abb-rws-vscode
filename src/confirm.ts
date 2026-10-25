// Confirmations before a write: the parts that need no `vscode`, so the unit
// tests can state the dialog texts.
//
// A confirmation names the robot and blocks nothing: a cancelled one sends
// nothing, a confirmed one sends. There is no setting that skips one.

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
  const message = `${request.label} on ${robotLabel(robot)}`;
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
      const detail = `This can move the robot.\n\n${bullets(request.sideEffects)}\n\n${notes}`
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
      return await ui.modal(message, bullets(request.sideEffects), [button]) === button ? 'confirmed' : 'cancelled';
    }
    case 'change': {
      const button = `Write to ${name}`;
      return await ui.modal(message, bullets(request.sideEffects), [button]) === button ? 'confirmed' : 'cancelled';
    }
  }
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
 */
export function speedRatioRequest(current: number, next: number, running: boolean): ConfirmRequest {
  const raising = running && next > current;
  return {
    label: 'Set Speed Ratio',
    tier: raising ? 'disruptive' : 'change',
    sideEffects: [
      `Changes the speed ratio from ${current} % to ${next} %.`,
      ...(raising ? ['RAPID is running: a motion in progress goes faster.'] : []),
    ],
  };
}

/** Switch Operation Mode (a virtual controller): disruptive. */
export function opModeRequest(from: string, to: string): ConfirmRequest {
  return {
    label: `Switch operation mode to ${to}`,
    tier: 'disruptive',
    sideEffects: [
      `Asks the controller to change from ${from} to ${to}; the controller may wait for an Accept at the FlexPendant.`,
      'Virtual controller only: a real controller has the key switch.',
    ],
  };
}

/** A simulation action that only a virtual controller takes: disruptive, and says so. */
export function virtualOnlyRequest(label: string, effects: string[]): ConfirmRequest {
  return { label, tier: 'disruptive', sideEffects: [...effects, 'Virtual controller only.'] };
}

/**
 * A program change (pointer move, unload) that asks (change tier) only while
 * RAPID runs. Undefined: nothing to ask.
 */
export function whileRunningRequest(label: string, running: boolean, effects: string[]): ConfirmRequest | undefined {
  if (!running) { return undefined; }
  return { label, tier: 'change', sideEffects: ['RAPID is running.', ...effects] };
}

/**
 * Whether the first-jog confirmation must be asked: never given on this
 * connection, or the axis value is now higher than the one confirmed.
 */
export function jogNeedsAsk(confirmedValue: number | undefined, value: number): boolean {
  return confirmedValue === undefined || value > confirmedValue;
}
