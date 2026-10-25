// RobotWare 8 motion control in RAPID Live: allowing it after a person's
// confirmation, withdrawing it, and what the dialogs, indicators and notices
// say. No `vscode` import: the extension passes the window and the robot in,
// so the unit tests can run every path with fakes.
//
// ABB: a control station that jogs or starts RAPID must have an emergency stop
// and a normal stop, and allowing motion control is the station's confirmation
// that both are available (RWS 2.0 Control Station Service, Allow Motion
// Control; RobotWare 8 product specification, section 2). The client never
// allows it on its own, and withdraws it as the first request of a disconnect.
// RAPID Live allows it only in `runAllow`, after the typed-name confirmation,
// and this module holds RAPID Live's only calls of `setAllowMotionControl`.
//
// RAPID Live never: allows without the typed name; allows on a robot that is
// not the active one, or one whose settings carry `controlStation`; allows
// again by itself after a reconnect, a new session or a switch back; retries a
// refused command; offers Allow on RobotWare 6 or 7; calls its own Stop a
// normal stop or an emergency stop.

import { RwsError, confirmationFor } from 'abb-rws-client';
import type { AccessEvent, LocalStationStatus, MotionControlCause, RefusalRemedy, RemedyConfirmation } from 'abb-rws-client';
import { confirmChoice, confirmWrite, robotLabel, type ConfirmRequest, type ConfirmRobot, type ConfirmUi } from './confirm';
import { FIXED_STATION_NEXT_STEP } from './refusalUi';

type Generation = 'rw6' | 'rw7' | 'rw8' | null;

/**
 * Whether RAPID Live withdraws motion control on a robot that stops being the
 * active one. Built and held off in this release, as the client holds off its
 * withdrawals on a mode change and a FlexPendant take-back: it is turned on
 * once a run on a controller shows what a withdrawal does to a running
 * program. Until then the allowance stays while the robot is connected, and
 * the status bar and the Robots view show it. Tests turn it on.
 */
export const MOTION_CONTROL_SWITCH: { withdrawOnSwitch: boolean } = { withdrawOnSwitch: false };

/** The command's name, as the dialogs and messages use it. */
export const ALLOW_LABEL = 'Allow Motion Control';
/** The second button of a RobotWare 8 start or jog confirmation. */
export const ALLOW_FIRST_BUTTON = 'Allow Motion Control first…';
/** What that button does, said in the confirmation before "Otherwise choose Continue". */
export const ALLOW_FIRST_HINT = `To allow motion control first, choose "${ALLOW_FIRST_BUTTON}". `
  + 'It asks you to confirm that an emergency stop and a normal stop are within your reach, then this confirmation shows again.';
/** The button of the "not known" warning that withdraws. */
export const WITHDRAW_BUTTON = 'Withdraw';
/** Where the extension log is, for the messages that ask for it. */
export const LOG_HINT = 'send us the extension log (`~/.abb-rws-extension/logs`)';

/** What the flows read of a robot's state (`RobotState`). */
export interface MotionState {
  connected: boolean;
  /** `RobotState.quality`: `stale` (polls failing) or `reconnecting` while the client may be tearing the session down on its own. */
  quality?: string | null;
  execstate?: string | null;
  identity?: { type?: string } | null;
  access?: {
    generation: Generation;
    rw8: {
      registered: boolean;
      identity: 'option' | 'explicit' | 'default' | null;
      allowMotionControl: boolean | null;
      allowMotionControlSince: string | null;
    } | null;
  } | null;
}

/** The parts of `RobotManager` the flows call. */
export interface MotionManager {
  readonly state: MotionState;
  setAllowMotionControl(allow: boolean): Promise<void>;
  getAllowMotionControl(): Promise<boolean | null>;
  getLocalStationStatus(): Promise<LocalStationStatus>;
  refresh(): Promise<void>;
}

/** A saved robot as the flows see it (`MultiRobotManager.entries[i]`). */
export interface MotionRobot {
  id: string;
  config: { name: string; controlStation?: unknown };
  manager: MotionManager;
}

/** The RobotWare 8 motion-control reading of a robot; null on RobotWare 6 and 7, or before the generation is known. */
export interface MotionReading {
  /** True or false as the client last set or read it; null while not known. */
  allowed: boolean | null;
  /** The ISO time of this client's set that made it true, or null. */
  since: string | null;
  /** Whether the session registered as a control station (the client reads the allowance only after that). */
  registered: boolean;
}

export function motionReading(state: MotionState | null | undefined): MotionReading | null {
  const access = state?.access;
  if (!state?.connected || access?.generation !== 'rw8') { return null; }
  const rw8 = access.rw8;
  return { allowed: rw8?.allowMotionControl ?? null, since: rw8?.allowMotionControlSince ?? null, registered: rw8?.registered === true };
}

/**
 * Whether the robot registers as a fixed control station: its settings carry
 * `controlStation`, or the client reports that identity. Every window and
 * computer with that setting is the same station, so RAPID Live neither
 * allows motion control from it nor offers to.
 */
export function fixedStation(robot: { config: { controlStation?: unknown }; manager: { state: MotionState } }): boolean {
  const cs = robot.config.controlStation;
  return (cs !== undefined && cs !== null) || robot.manager.state.access?.rw8?.identity === 'option';
}

/** `HH:MM` of an ISO time, in local time; null when there is none. */
export function hhmm(iso: string | null | undefined): string | null {
  if (!iso) { return null; }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return null; }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── Which robots RAPID Live allowed motion control on, and the notices ──────

/** A notice to show after a motion-control event of the client. */
export interface MotionNotice {
  level: 'info' | 'warning';
  text: string;
  /** Buttons, in order: Withdraw, then Disconnect <name>. */
  buttons: string[];
}

/** The Disconnect button of a notice or warning. */
export const disconnectButton = (name: string): string => `Disconnect ${name}`;

/** What a notice reads of the robot's session when the client's event arrives. */
export interface SessionNow {
  connected: boolean;
  /** `RobotState.quality`. */
  quality?: string | null;
}

/** The session as a robot's state reads now; not connected when there is no robot. */
export function sessionNow(state: MotionState | null | undefined): SessionNow {
  return { connected: state?.connected === true, quality: state?.quality ?? null };
}

/**
 * Connected, but the client may be ending the session on its own: after
 * failed polls (`stale`; the third one disconnects) or in a reconnect
 * (`reconnecting`). Such a teardown withdraws before its state reads
 * disconnected, so a failed withdrawal then cannot yet tell a disconnect
 * from a session that stays.
 */
export function sessionUnsettled(session: SessionNow): boolean {
  return session.connected && (session.quality === 'stale' || session.quality === 'reconnecting');
}

/** A failed withdrawal at a disconnect: no buttons, the session is gone. */
function failedAtDisconnect(name: string): MotionNotice {
  return {
    level: 'warning',
    text: `Disconnected ${name}. Withdrawing motion control first did not go through, so whether the controller still counts it is not known. `
      + "The extension log has the controller's answer.",
    buttons: [],
  };
}

/** A failed withdrawal on a session that stays: Withdraw and Disconnect. */
function failedConnected(name: string): MotionNotice {
  return {
    level: 'warning',
    text: `${name}: withdrawing motion control did not go through, so whether the controller still counts it is not known. `
      + "The extension log has the controller's answer.",
    buttons: [WITHDRAW_BUTTON, disconnectButton(name)],
  };
}

/**
 * The robots RAPID Live allowed motion control on in this window, per robot
 * and connection (`allowedHere`), and the notices the client's motion-control
 * events give for them. Only a robot with `allowedHere` gets a notice: another
 * window is another station, and shows its own.
 */
export class MotionControlTracker {
  private readonly here = new Map<string, string>();
  /** The robots RAPID Live is disconnecting; true once a notice was given for that disconnect. */
  private readonly ending = new Map<string, boolean>();
  /** Failed withdrawals held back while the session was unsettled: the robot's name, by id. */
  private readonly held = new Map<string, string>();
  /** The window is closing: no notices. */
  closing = false;

  /** Whether RAPID Live allowed motion control on this robot during its connection. */
  allowedHere(id: string): boolean { return this.here.has(id); }

  /** RAPID Live allowed it (or may have: the controller did not answer). */
  markAllowed(id: string, name: string): void { this.here.set(id, name); }

  /** The allowance of this robot ended, or its connection did. A failed withdrawal held back is dropped (call `settle` first). */
  clear(id: string): void { this.here.delete(id); this.held.delete(id); }

  /** RAPID Live begins disconnecting this robot: a failed withdrawal says so, with no buttons. */
  beginDisconnect(id: string): void { this.ending.set(id, false); }

  /** The disconnect ended. True when a notice was given for it, so the caller adds no message of its own. */
  endDisconnect(id: string): boolean {
    const noticed = this.ending.get(id) === true;
    this.ending.delete(id);
    return noticed;
  }

  disconnecting(id: string): boolean { return this.ending.has(id); }

  /**
   * A `motionControl` event of robot `id`: updates `allowedHere`, and returns
   * the notice to show, if any. `session`: the robot's session as it reads at
   * the event. A failed withdrawal on a session that is still up offers
   * Withdraw and Disconnect; at a disconnect it offers nothing. While the
   * session is unsettled (`sessionUnsettled`: the client may be tearing it
   * down on its own, which withdraws before its state reads disconnected) the
   * notice is held back until `settle`.
   */
  onEvent(id: string, cause: MotionControlCause, session: SessionNow): MotionNotice | undefined {
    const name = this.here.get(id);
    if (name === undefined) { return undefined; }
    const withdrawn = (why: string): MotionNotice => {
      this.clear(id);
      return { level: 'info', text: `Motion control on ${name} was withdrawn: ${why}`, buttons: [] };
    };
    let notice: MotionNotice | undefined;
    switch (cause) {
      case 'withdrawn-at-disconnect':
        this.clear(id);
        notice = { level: 'info', text: `Disconnected ${name}. Motion control was withdrawn first.`, buttons: [] };
        break;
      case 'withdrawn-after-reissue':
        notice = withdrawn('the controller session changed. Allow it again to start from here.');
        break;
      case 'withdrawn-on-mode-change':
        notice = withdrawn('the operating mode changed.');
        break;
      case 'withdrawn-on-take-back':
        notice = withdrawn('the FlexPendant took write access.');
        break;
      case 'withdrawn-at-registration':
        this.clear(id);
        break;
      case 'withdraw-failed':
        // One warning per failure: a newer one replaces one held back.
        if (this.disconnecting(id) || !session.connected) { this.held.delete(id); notice = failedAtDisconnect(name); }
        else if (sessionUnsettled(session)) { this.held.set(id, name); }
        else { this.held.delete(id); notice = failedConnected(name); }
        break;
      default:
        break;
    }
    return this.given(id, notice);
  }

  /**
   * At a state change of robot `id` (`session` undefined: the robot was
   * removed): a failed withdrawal held back while the session was unsettled,
   * once it settled. Disconnected: the disconnect's warning, with no buttons;
   * connected and settled: the warning with Withdraw and Disconnect; still
   * unsettled: nothing yet.
   */
  settle(id: string, session: SessionNow | undefined): MotionNotice | undefined {
    const name = this.held.get(id);
    if (name === undefined) { return undefined; }
    if (session && sessionUnsettled(session)) { return undefined; }
    this.held.delete(id);
    return this.given(id, session?.connected ? failedConnected(name) : failedAtDisconnect(name));
  }

  /** The notice to show, or none while the window closes; a disconnect in progress records that it got one. */
  private given(id: string, notice: MotionNotice | undefined): MotionNotice | undefined {
    if (!notice || this.closing) { return undefined; }
    if (this.ending.has(id)) { this.ending.set(id, true); }
    return notice;
  }
}

/** The notice for a client access event of robot `id` (`multi.onAccessEvent`), with the robot's state as it reads at the event. */
export function noticeForEvent(tracker: MotionControlTracker, id: string, event: AccessEvent, state: MotionState | null | undefined): MotionNotice | undefined {
  if (event.type !== 'motionControl') { return undefined; }
  return tracker.onEvent(id, event.cause, sessionNow(state));
}

/** What the Disconnect command says after the disconnect: nothing when a motion-control notice already spoke for it. */
export function disconnectMessage(noticeShown: boolean): string | undefined {
  return noticeShown ? undefined : 'Disconnected.';
}

// ─── The confirmation: the client's lines, then RAPID Live's ─────────────────

/** This window runs on another machine (a remote window) or in a web browser. */
export type RemoteWindow = { kind: 'remote'; name: string } | { kind: 'web' };

/** The window, as VS Code reports it (`vscode.env.remoteName`, `uiKind` Web). */
export function remoteWindow(remoteName: string | undefined, web: boolean): RemoteWindow | null {
  if (remoteName) { return { kind: 'remote', name: remoteName }; }
  return web ? { kind: 'web' } : null;
}

/**
 * When RAPID Live withdraws it, as the confirmation says. Only the triggers
 * that are on are named: the client withdraws at a disconnect and after a
 * re-issued session; its withdrawals on a mode change and a FlexPendant
 * take-back, and RAPID Live's on a robot switch, are held off in this release.
 */
export function whenItEnds(withdrawOnSwitch: boolean): string {
  const yours = withdrawOnSwitch
    ? 'when you disconnect, switch robots or choose Withdraw Motion Control'
    : 'when you disconnect or choose Withdraw Motion Control';
  return `RAPID Live withdraws it ${yours}, and when the controller session changes. `
    + 'It tries to when you close the window. If a withdrawal does not go through, whether the controller still counts it is not known.';
}

/** RAPID Live's own lines of the Allow confirmation, after the client's. */
export function rapidLiveLines(remote: RemoteWindow | null, withdrawOnSwitch: boolean): string[] {
  const lines = [
    'Stop RAPID in RAPID Live is a program stop sent over the network. It is neither of these stops. '
      + 'Neither RAPID Live nor VS Code gives you an emergency stop or a normal stop.',
  ];
  if (remote) {
    lines.push(remote.kind === 'remote'
      ? `This window runs RAPID Live on another machine (${remote.name}). The stops must be within reach of you, where you are.`
      : 'This window runs in a web browser, and RAPID Live runs on another machine. The stops must be within reach of you, where you are.');
  }
  lines.push('Start RAPID and Run Routine still ask you first, every time. Jog asks on the next jog.');
  lines.push(whenItEnds(withdrawOnSwitch));
  lines.push('If either stop is out of your reach, choose Cancel.');
  return lines;
}

/** The Allow confirmation: the client's text (`confirmationFor`), then RAPID Live's lines. */
export function declarationRequest(confirmation: RemedyConfirmation, lines: string[]): ConfirmRequest {
  return { label: ALLOW_LABEL, tier: 'declaration', sideEffects: lines, confirmation };
}

/**
 * The remedy the Allow command confirms when it was not started from a
 * refusal (the palette, a start confirmation): the same call the client's
 * `declare-motion-control` remedy names, so `confirmationFor` gives the same
 * text.
 */
export const ALLOW_REMEDY: RefusalRemedy = {
  kind: 'declare-motion-control',
  byWhom: 'person-confirms-in-a-tool',
  label: 'Allow motion control',
  detail: 'A person who has an emergency stop and a normal stop within reach allows motion control for this control station.',
  appliesTo: { generation: 'rw8', scope: 'station' },
  call: { method: 'setAllowMotionControl', allow: true },
  safetyDeclaration: true,
  afterwards: 'nothing',
  evidence: 'abb',
  basis: 'ABB RWS 2.0 Control Station Service Rev C, allowmotioncontrol',
};

// ─── Allow ───────────────────────────────────────────────────────────────────

/**
 * Where Allow was started: the palette, the second button of a start or jog
 * confirmation, or the button of a refusal of Run Routine (CodeLens), Start
 * RAPID, Jog or another command.
 */
export type AllowOrigin = 'palette' | 'start-confirmation' | 'run-routine' | 'start-rapid' | 'jog' | 'refusal';

/** The origin of a refusal's Allow button, from the label its error was shown with. */
export function allowOriginOf(label: string): AllowOrigin {
  if (label === 'Run routine') { return 'run-routine'; }
  if (label === 'Starting RAPID' || label === 'Start RAPID') { return 'start-rapid'; }
  if (label === 'Jog') { return 'jog'; }
  return 'refusal';
}

/**
 * What the error's Allow Motion Control… button opens: where it was started
 * (from the label the error was shown with), and the refusal's own
 * `declare-motion-control` remedy that names the call, the next step or
 * another way; undefined (a client without remedies): Allow's own.
 */
export function allowFromRefusal(
  refusal: { remedy?: RefusalRemedy; otherRemedies?: RefusalRemedy[] } | undefined, label: string,
): { origin: AllowOrigin; remedy: RefusalRemedy | undefined } {
  const remedy = [refusal?.remedy, ...(refusal?.otherRemedies ?? [])]
    .find((r): r is RefusalRemedy => r?.kind === 'declare-motion-control' && r.call?.method === 'setAllowMotionControl');
  return { origin: allowOriginOf(label), remedy };
}

/** What the person reads after allowing, by where they started; null: no message (the start confirmation shows again). */
export function allowedMessage(label: string, origin: AllowOrigin): string | null {
  const next: Record<AllowOrigin, string | null> = {
    'palette': '',
    'start-confirmation': null,
    'run-routine': ' Click ▶ Run this routine again. It asks you to confirm, as before.',
    'start-rapid': ' Start RAPID again. It asks you to confirm, as before.',
    'jog': ' Jog again. It asks you to confirm first.',
    'refusal': ' Run the refused command again. It asks you to confirm, as before.',
  };
  const tail = next[origin];
  return tail === null ? null : `Motion control allowed on ${label}.${tail}`;
}

/** How Allow ended. Only `allowed` and `already-allowed` let a start confirmation show again. */
export type AllowOutcome = 'allowed' | 'already-allowed' | 'not-sent' | 'refused' | 'read-false' | 'unknown';

/** The window the flows talk through. */
export interface MotionUi extends ConfirmUi {
  info(message: string): void;
  /** A warning with buttons; the button chosen, or undefined. Not waited for. */
  ask(message: string, buttons: string[]): PromiseLike<string | undefined>;
  /** Show a refused request the way every refusal is shown, with its own remedy. */
  refused(label: string, e: unknown): void;
}

export interface WithdrawContext {
  ui: MotionUi;
  /** The robot as the dialogs name it (`confirmRobotOf`). */
  robot: ConfirmRobot;
  tracker: MotionControlTracker;
  /** Disconnect this robot (the button of a warning). */
  disconnect(): Promise<void>;
  log(message: string): void;
}

export interface AllowContext extends WithdrawContext {
  /** Whether the robot is the active one, now. */
  isActive(): boolean;
  /** The window, for the remote line of the confirmation. */
  remote: RemoteWindow | null;
  /** Forget the jog confirmation of this robot, so the next jog asks again. */
  forgetJogConfirmation(): void;
  /** Withdraw on this robot (the button of the "not known" warning). */
  withdraw(): Promise<void>;
}

/**
 * Whether a set that threw may have been taken: the client's own test for a
 * request with no answer (an error that is not the client's `RwsError`, or a
 * `NETWORK_ERROR`, with or without an HTTP status: an answer cut off mid-body
 * carries one). The client then counts the allowance as possibly standing and
 * withdraws it at disconnect; RAPID Live counts it the same way.
 */
export function mayHaveBeenTaken(e: unknown): boolean {
  return !(e instanceof RwsError) || e.code === 'NETWORK_ERROR';
}

/**
 * Allow motion control on `target`, after the person confirms that an
 * emergency stop and a normal stop are within their reach and types the
 * robot's name. `remedy`: the refusal's `declare-motion-control` remedy, when
 * Allow was started from a refusal. Nothing is retried: the person runs the
 * refused command again.
 */
export async function runAllow(target: MotionRobot, origin: AllowOrigin, ctx: AllowContext, remedy: RefusalRemedy = ALLOW_REMEDY): Promise<AllowOutcome> {
  const { ui } = ctx;
  const name = target.config.name;
  const label = robotLabel(ctx.robot);
  const m = target.manager;

  // 1-3: the active robot, connected, RobotWare 8, and no fixed station identity.
  if (!ctx.isActive()) {
    ui.warn(`${name} is not the active robot. Switch to it first, then allow motion control.`);
    return 'not-sent';
  }
  if (!m.state.connected) { ui.warn('Connect first.'); return 'not-sent'; }
  const gen = m.state.access?.generation ?? null;
  if (gen !== 'rw8') {
    ui.warn(gen === 'rw6' || gen === 'rw7'
      ? 'RobotWare 6 and 7 have no Allow Motion Control. Nothing was sent.'
      : `The RobotWare version of ${name} is not known yet, and Allow Motion Control is for RobotWare 8 only. Nothing was sent.`);
    return 'not-sent';
  }
  if (fixedStation(target)) {
    ui.warn(`${name} is set to register as a fixed control station (\`controlStation\` in its settings). `
      + 'Motion control allowed from it could then count in other windows or on other computers with the same setting. '
      + 'Remove that setting to allow motion control from RAPID Live. Nothing was sent.');
    return 'not-sent';
  }

  // 4: the state, or a read when a refusal or a start confirmation is newer than the state.
  if (origin === 'palette') {
    if (m.state.access?.rw8?.allowMotionControl === true) {
      ui.info(`Motion control is already allowed on ${label}.`);
      return 'already-allowed';
    }
  } else {
    let read: boolean | null = null;
    try { read = await m.getAllowMotionControl(); }
    catch (e) { ctx.log(`Allow Motion Control on ${name}: the read before the dialog failed (${e instanceof Error ? e.message : String(e)}); asking anyway`); }
    if (read === true) {
      if (origin === 'start-confirmation') { return 'already-allowed'; }
      const what = origin === 'jog' ? 'the jog' : origin === 'refusal' ? 'the command' : 'the start';
      const where = origin === 'jog' ? 'Jog from the FlexPendant' : 'Start from the FlexPendant';
      ui.warn(`${label} refused ${what} for motion control, but reads it as allowed. Nothing was sent. ${where}, and ${LOG_HINT}.`);
      return 'not-sent';
    }
  }

  // 5: the FlexPendant connection, for the confirmation's line.
  let fp: LocalStationStatus | null = null;
  try { fp = await m.getLocalStationStatus(); }
  catch (e) { ctx.log(`Allow Motion Control on ${name}: the FlexPendant connection read failed (${e instanceof Error ? e.message : String(e)})`); }

  // 6: the confirmation. Cancel, a dismissed box or a wrong name: nothing is sent.
  const typeIdentity = m.state.identity?.type;
  const confirmation = confirmationFor(remedy, {
    name: ctx.robot.name.trim(),
    label,
    virtual: typeof typeIdentity === 'string' && typeIdentity !== '' ? /virtual/i.test(typeIdentity) : null,
    flexPendantConnected: fp?.flexPendantConnected ?? null,
  });
  if (!confirmation) { return 'not-sent'; }
  const request = declarationRequest(confirmation, rapidLiveLines(ctx.remote, MOTION_CONTROL_SWITCH.withdrawOnSwitch));
  if (!await confirmWrite(ui, ctx.robot, request)) { return 'not-sent'; }
  if (!ctx.isActive()) {
    ui.warn(`${name} is no longer the active robot. Allow Motion Control was not sent.`);
    return 'not-sent';
  }

  // 7: the one call that allows it.
  let answered = true;
  try {
    await m.setAllowMotionControl(true);
  } catch (e) {
    if (!mayHaveBeenTaken(e)) { ui.refused(ALLOW_LABEL, e); return 'refused'; }
    answered = false;
    ctx.log(`Allow Motion Control on ${name}: no answer (${e instanceof Error ? e.message : String(e)}); reading it back`);
  }
  // It is allowed, or may be: the indicators and the withdrawals count it from here,
  // and the next jog asks again, whatever the read back says.
  ctx.tracker.markAllowed(target.id, name);
  ctx.forgetJogConfirmation();
  let reading: boolean | null;
  try { reading = await m.getAllowMotionControl(); }
  catch { reading = answered ? (m.state.access?.rw8?.allowMotionControl ?? null) : null; }

  if (reading === true) {
    // 8: the person runs the refused command again.
    const message = allowedMessage(label, origin);
    if (message !== null) { ui.info(message); }
    return 'allowed';
  }
  if (reading === false && answered) {
    // 9: the controller took the set and reads false.
    ctx.tracker.clear(target.id);
    ui.warn(`${label} reads motion control as not allowed after RAPID Live allowed it. Nothing else was sent. `
      + `Start from the FlexPendant, and ${LOG_HINT}.`);
    return 'read-false';
  }
  // 10: no answer to the set, and no read that settles it. A set with no answer may
  // still be taken after a read of false, so only a withdrawal settles it.
  void Promise.resolve(ui.ask(`Whether ${label} allowed motion control is not known: the controller did not answer.`,
    [WITHDRAW_BUTTON, disconnectButton(name)])).then(async choice => {
    if (choice === WITHDRAW_BUTTON) { await ctx.withdraw(); }
    else if (choice === disconnectButton(name)) { await ctx.disconnect(); }
  });
  return 'unknown';
}

// ─── Withdraw ────────────────────────────────────────────────────────────────

export type WithdrawOutcome = 'withdrawn' | 'not-sent' | 'refused' | 'still-allowed';

/**
 * Withdraw motion control on `target`, sent at once with no confirmation, like
 * Stop RAPID. It only removes the permission: withdrawing is not a stop.
 */
export async function runWithdraw(target: MotionRobot, ctx: WithdrawContext): Promise<WithdrawOutcome> {
  const { ui } = ctx;
  const name = target.config.name;
  const label = robotLabel(ctx.robot);
  const m = target.manager;
  if (!m.state.connected) { ui.warn('Connect first.'); return 'not-sent'; }
  const gen = m.state.access?.generation ?? null;
  if (gen !== 'rw8') {
    ui.warn(gen === 'rw6' || gen === 'rw7'
      ? 'RobotWare 6 and 7 have no motion control to withdraw. Nothing was sent.'
      : `The RobotWare version of ${name} is not known yet. Nothing was sent.`);
    return 'not-sent';
  }
  const wasRunning = m.state.execstate === 'running';
  const sent = await sendWithdrawal(target, ctx);
  if (sent !== 'withdrawn') { return sent; }
  let text = `Motion control withdrawn on ${label}. RobotWare 8 refuses starts and jogs from RAPID Live until you allow it again.`;
  if (wasRunning) {
    // What the controller did with the running program, from a fresh read.
    try { await m.refresh(); } catch { /* the state stays as last read */ }
    const now = m.state.execstate;
    text += now === 'running' ? ' RAPID kept running.' : now === 'stopped' ? ' RAPID stopped.' : '';
  }
  ui.info(text);
  return 'withdrawn';
}

/**
 * One withdrawal: POST false, then a read back. Refused, or still reading
 * true: the controller's refusal, then the warning that offers Disconnect.
 */
async function sendWithdrawal(target: MotionRobot, ctx: WithdrawContext): Promise<'withdrawn' | 'refused' | 'still-allowed'> {
  const { ui } = ctx;
  const name = target.config.name;
  const m = target.manager;
  const notTaken = (): void => {
    void Promise.resolve(ui.ask(`${name} did not take the withdrawal. Disconnecting ends the session that allowed it. `
      + 'Whether that also ends the allowance is not known.', [disconnectButton(name)])).then(async choice => {
      if (choice === disconnectButton(name)) { await ctx.disconnect(); }
    });
  };
  try {
    await m.setAllowMotionControl(false);
  } catch (e) {
    ui.refused('Withdraw Motion Control', e);
    notTaken();
    return 'refused';
  }
  let reading: boolean | null;
  try { reading = await m.getAllowMotionControl(); }
  catch { reading = m.state.access?.rw8?.allowMotionControl ?? null; }
  if (reading === true) { notTaken(); return 'still-allowed'; }
  ctx.tracker.clear(target.id);
  return 'withdrawn';
}

// ─── The robot switch ────────────────────────────────────────────────────────

/**
 * The switch withdrawal (held off in this release, see `MOTION_CONTROL_SWITCH`):
 * withdraw on the robot that stopped being active, and say so.
 */
export async function runSwitchWithdraw(target: MotionRobot, toName: string, ctx: WithdrawContext): Promise<void> {
  if (await sendWithdrawal(target, ctx) === 'withdrawn') { ctx.ui.info(switchNotice(target.config.name, toName)); }
}

/** What the switch decision reads of the robot that stopped being active. */
export interface SwitchedFrom {
  connected: boolean;
  generation: Generation;
  allowed: boolean | null;
  allowedHere: boolean;
}

/**
 * Whether RAPID Live withdraws motion control on the robot that stopped
 * being the active one: connected, RobotWare 8, and reading true (or allowed
 * here and not reading false). Never while the switch withdrawal is off.
 */
export function withdrawOnSwitch(from: SwitchedFrom | undefined, enabled = MOTION_CONTROL_SWITCH.withdrawOnSwitch): boolean {
  if (!enabled || !from || !from.connected || from.generation !== 'rw8') { return false; }
  return from.allowed === true || (from.allowedHere && from.allowed !== false);
}

/** The notice after a switch withdrawal. */
export function switchNotice(from: string, to: string): string {
  return `Motion control withdrawn on ${from}: ${to} is now the active robot. Allow it again on ${from} when you switch back.`;
}

// ─── Indicators ──────────────────────────────────────────────────────────────

/** The status bar item for one robot; undefined: hidden. */
export function statusIndicator(name: string, reading: MotionReading | null, allowedHere: boolean): { text: string; tooltip: string; warning: boolean } | undefined {
  if (!reading) { return undefined; }
  if (reading.allowed === true) {
    const at = hhmm(reading.since);
    const notAStop = "Withdrawing is not a stop: to stop the robot, use the FlexPendant's stops. Click to withdraw.";
    if (at) {
      return {
        text: `$(shield) Motion allowed since ${at}`,
        tooltip: `Motion control is allowed on ${name} since ${at}. You confirmed then that an emergency stop and a normal stop are within your reach. ${notAStop}`,
        warning: true,
      };
    }
    // No time: RAPID Live's set got no answer and a read found it allowed (the client keeps no
    // time then), or RAPID Live did not allow it on this connection.
    return {
      text: '$(shield) Motion allowed',
      tooltip: allowedHere
        ? `Motion control is allowed on ${name}. RAPID Live allowed it on this connection, after you confirmed that an emergency stop and a normal stop are within your reach; `
          + `the time is not known. ${notAStop}`
        : `${name} reads motion control as allowed for this control station; RAPID Live did not allow it on this connection. ${notAStop}`,
      warning: true,
    };
  }
  if (reading.allowed === null && allowedHere) {
    return {
      text: '$(warning) Motion control: not known',
      tooltip: `${name} may still allow motion control from this station. Click to withdraw.`,
      warning: true,
    };
  }
  return undefined;
}

/**
 * The Robots view's words for one robot: a description part and a tooltip
 * line; nothing on RobotWare 6 or 7. `withdraw`: the row offers Withdraw
 * Motion Control (allowed, or not known after RAPID Live allowed it: the
 * robots the status bar counts).
 */
export function robotsViewMotion(reading: MotionReading | null, allowedHere: boolean): { description?: string; tooltip?: string; withdraw?: true } {
  if (!reading) { return {}; }
  if (reading.allowed === true) {
    const at = hhmm(reading.since);
    return { description: 'motion allowed', tooltip: `Motion control (RobotWare 8): allowed${at ? ` since ${at}` : ''}`, withdraw: true };
  }
  if (reading.allowed === false) { return { tooltip: 'Motion control (RobotWare 8): not allowed' }; }
  if (allowedHere) { return { description: 'motion: not known', tooltip: 'Motion control (RobotWare 8): not known', withdraw: true }; }
  return { tooltip: `Motion control (RobotWare 8): ${reading.registered ? 'not known' : 'not read yet'}` };
}

// ─── Every robot at once: the status bar, the palette's Withdraw, the context keys ──

/** One robot as the status bar, the palette's Withdraw and the context keys read it. */
export interface MotionEntry {
  id: string;
  name: string;
  reading: MotionReading | null;
  allowedHere: boolean;
  /** Registers as a fixed control station (`fixedStation`): Allow is not offered. */
  fixedStation: boolean;
}

/** A saved robot (`MultiRobotManager.entries[i]`) as `MotionEntry`. */
export function motionEntryOf(robot: MotionRobot, allowedHere: boolean): MotionEntry {
  return { id: robot.id, name: robot.config.name, reading: motionReading(robot.manager.state), allowedHere, fixedStation: fixedStation(robot) };
}

/**
 * The robots whose motion control may stand (the status bar indicator shows
 * for them, and their Robots view row offers Withdraw), the active robot
 * first, then the others in the list's order.
 */
export function withdrawCandidates(robots: readonly MotionEntry[], activeId: string | null | undefined): MotionEntry[] {
  const standing = robots.filter(r => statusIndicator(r.name, r.reading, r.allowedHere) !== undefined);
  return [...standing.filter(r => r.id === activeId), ...standing.filter(r => r.id !== activeId)];
}

/** The status bar item: undefined when hidden; `robotId`: the robot its click withdraws on, or undefined when the click asks which. */
export interface MotionStatusBar {
  text: string;
  tooltip: string;
  robotId?: string;
}

/**
 * The status bar item for every robot at once. One robot whose motion control
 * may stand: its indicator, named when it is not the active robot, and the
 * click withdraws there. Several: their count and each one's state, and the
 * click asks which robot to withdraw it on.
 */
export function statusBarFor(robots: readonly MotionEntry[], activeId: string | null | undefined): MotionStatusBar | undefined {
  const shown = withdrawCandidates(robots, activeId);
  const indicator = (r: MotionEntry) => statusIndicator(r.name, r.reading, r.allowedHere)!;
  if (shown.length === 0) { return undefined; }
  if (shown.length === 1) {
    const [r] = shown;
    const one = indicator(r);
    return { text: r.id === activeId ? one.text : `${one.text} (${r.name})`, tooltip: one.tooltip, robotId: r.id };
  }
  return {
    text: `$(shield) Motion control on ${shown.length} robots`,
    tooltip: shown.map(r => `${r.name}: ${plainText(indicator(r).text)}`).join('\n')
      + "\n\nWithdrawing is not a stop: to stop a robot, use its FlexPendant's stops. Click to choose the robot to withdraw it on.",
  };
}

/** A status bar text without its icon. */
function plainText(text: string): string { return text.replace(/^\$\([^)]*\)\s*/, ''); }

/**
 * Which robot Withdraw Motion Control acts on when no robot is named (the
 * palette, the status bar with several): the one robot whose motion control
 * may stand, else the active robot (which then says what there is to
 * withdraw); with several, the person picks.
 */
export function withdrawChoice(robots: readonly MotionEntry[], activeId: string | null | undefined): { id: string | undefined } | { pick: MotionEntry[] } {
  const candidates = withdrawCandidates(robots, activeId);
  if (candidates.length > 1) { return { pick: candidates }; }
  return { id: candidates[0]?.id ?? activeId ?? undefined };
}

/** The pick list of Withdraw Motion Control with several robots: each robot and its state, the active one marked. */
export function withdrawPickItems(pick: readonly MotionEntry[], activeId: string | null | undefined): Array<{ id: string; label: string; description: string }> {
  return pick.map(r => ({
    id: r.id,
    label: r.name,
    description: `${plainText(statusIndicator(r.name, r.reading, r.allowedHere)?.text ?? '')}${r.id === activeId ? ' (active)' : ''}`,
  }));
}

/** The context keys of the motion-control commands. */
export interface MotionContextKeys {
  /** The active robot is a connected RobotWare 8 robot. */
  activeRw8: boolean;
  /** The active robot reads motion control as allowed. */
  motionControlAllowed: boolean;
  /** The active robot registers as a fixed control station: the palette offers no Allow. */
  activeFixedStation: boolean;
  /** Some robot's motion control may stand: the palette offers Withdraw. */
  motionWithdrawable: boolean;
}

export function motionContextKeys(robots: readonly MotionEntry[], activeId: string | null | undefined): MotionContextKeys {
  const active = robots.find(r => r.id === activeId);
  return {
    activeRw8: !!active?.reading,
    motionControlAllowed: active?.reading?.allowed === true,
    activeFixedStation: !!active?.reading && active.fixedStation,
    motionWithdrawable: withdrawCandidates(robots, activeId).length > 0,
  };
}

// ─── The line and the button of a RobotWare 8 start or jog confirmation ──────

/** The motion-control line of a start or jog confirmation, and whether it offers Allow first. */
export interface MotionLine {
  line: string;
  offerAllow: boolean;
}

/**
 * On RobotWare 8 only; undefined on RobotWare 6 and 7. `fixed`: the robot
 * registers as a fixed control station (`fixedStation`): RAPID Live does not
 * allow motion control from it, so the line says so and names the
 * FlexPendant, and Allow is not offered.
 */
export function motionLine(reading: MotionReading | null, allowedHere: boolean, fixed = false): MotionLine | undefined {
  if (!reading) { return undefined; }
  if (reading.allowed === true) {
    const at = hhmm(reading.since);
    return {
      line: at
        ? `Motion control allowed at ${at}. You confirmed then that both stops are within your reach. If that is not so now, choose Cancel and withdraw it.`
        : allowedHere
          ? 'Motion control allowed on this connection; the time is not known. You confirmed then that both stops are within your reach. '
            + 'If that is not so now, choose Cancel and withdraw it.'
          : 'Motion control reads as allowed from this station; RAPID Live did not allow it on this connection. '
            + 'If an emergency stop and a normal stop are not within your reach, choose Cancel and withdraw it.',
      offerAllow: false,
    };
  }
  const line = reading.allowed === false
    ? 'Motion control is not allowed from this station. RobotWare 8 refuses a start or a jog without it.'
    : allowedHere
      ? 'Motion control: not known. The controller did not answer, or the controller session changed.'
      : 'Whether motion control is allowed from this station is not known yet. RobotWare 8 refuses a start or a jog without it.';
  return fixed ? { line: `${line} ${FIXED_STATION_NEXT_STEP}`, offerAllow: false } : { line, offerAllow: true };
}

/** The motion-control line of a start, run or jog confirmation for this robot (`motionLine`). */
export function motionLineOf(robot: MotionRobot, allowedHere: boolean): MotionLine | undefined {
  return motionLine(motionReading(robot.manager.state), allowedHere, fixedStation(robot));
}

/**
 * A start, run or jog confirmation with the RobotWare 8 motion-control line,
 * shown apart from what the write does. `Allow Motion Control first…`, which
 * the text explains, sends nothing of the start: it runs Allow, and after it
 * the same confirmation shows again (it still asks for the typed name). True
 * only when the person confirmed the write itself.
 */
export async function confirmMotionWrite(
  ui: ConfirmUi, robot: () => ConfirmRobot, request: ConfirmRequest,
  line: () => MotionLine | undefined, allowFirst: () => Promise<AllowOutcome>,
): Promise<boolean> {
  // At most twice: once Allow went through, the line no longer offers it.
  for (let round = 0; round < 2; round++) {
    const ml = line();
    const req: ConfirmRequest = ml
      ? { ...request, notes: [...(request.notes ?? []), ml.line], ...(ml.offerAllow ? { altButton: ALLOW_FIRST_BUTTON, altHint: ALLOW_FIRST_HINT } : {}) }
      : request;
    const choice = await confirmChoice(ui, robot(), req);
    if (choice !== 'alt') { return choice === 'confirmed'; }
    const outcome = await allowFirst();
    if (outcome !== 'allowed' && outcome !== 'already-allowed') { return false; }
  }
  return false;
}
