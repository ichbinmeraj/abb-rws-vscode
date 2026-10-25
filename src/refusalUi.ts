// The error dialog's buttons for a refusal: the parts that need no `vscode`,
// so the unit tests can state the table. Every button acts on the robot that
// refused, which the caller binds; this module only decides which to offer.

import type { RefusalCondition, RefusalKind, RemedyCall, RemedyKind, WriteAccessStatus } from 'abb-rws-client';

type Generation = 'rw6' | 'rw7' | 'rw8' | null;

/** What a remedy of the client says that decides a button or a note (`RefusalRemedy`). */
export interface RemedyFacts {
  /** A `RemedyKind`, or a kind of a newer client, which is shown as text. */
  kind: string;
  call?: RemedyCall;
  label?: string;
  detail?: string;
}

/** What a refusal says that decides the buttons. */
export interface RefusalFacts {
  kind: RefusalKind;
  condition: RefusalCondition;
  generation?: Generation;
  /** The controller's own answer behind the refusal: `METHOD /path` of the refused request. */
  controller?: { request?: string };
  /** The client's next step (`refusal.remedy`), and the other ways (`refusal.otherRemedies`). */
  remedy?: RemedyFacts;
  otherRemedies?: RemedyFacts[];
}

/** A refusal as the message helpers read it: every field optional, a kind of any client. */
export interface RefusalLike {
  kind?: string;
  grantor?: string | null;
  generation?: Generation;
  remedy?: RemedyFacts;
  otherRemedies?: RemedyFacts[];
}

export type RefusalAction = 'declare-motion-control' | 'request-rmmp' | 'show-holder' | 'release-own';

export interface RefusalButton {
  label: string;
  action: RefusalAction;
  /** `request-rmmp`: the level the client's remedy names for the refused operation. */
  level?: 'modify' | 'exec';
}

/** The button that opens Allow Motion Control for the robot that refused. */
export const ALLOW_MOTION_CONTROL_BUTTON = 'Allow Motion Control…';

/**
 * What RAPID Live knows of the robot that refused, beyond the refusal.
 * `fixedStation`: its settings register it as a fixed control station
 * (`controlStation`), which RAPID Live does not allow motion control from.
 */
export interface RobotFacts {
  fixedStation?: boolean;
}

/**
 * RAPID Live's next step for a robot that registers as a fixed control
 * station, where motion control is missing: Allow Motion Control is not
 * offered, and the FlexPendant is the way.
 */
export const FIXED_STATION_NEXT_STEP = 'RAPID Live does not allow motion control for this robot: its settings register it as a fixed control station '
  + '(`controlStation`), the same station in every window or computer with that setting. Start or jog from the FlexPendant.';

/** The remedy kinds this RAPID Live knows; another kind is shown as text, never as a button. */
const KNOWN_REMEDY_KINDS: ReadonlySet<string> = new Set<RemedyKind>([
  'declare-motion-control', 'request-rmmp', 'grant-rmmp-at-pendant', 'remote-access-on', 'release-pendant-write-access',
  'release-pendant-mastership', 'holder-releases', 'release-own-hold', 'stop-program-first', 'motors-on', 'reset-safety-stop',
  'mode', 'confirm-mode-change', 'do-at-pendant', 'grant-missing', 'signal-access-level', 'run-again', 'reconnect', 'fix-input',
  'check-state', 'wait', 'nothing-needed', 'option-missing', 'not-available', 'report', 'none-known',
]);

/** The refusal's remedies, the next step first. */
function remediesOf(refusal: RefusalLike): RemedyFacts[] {
  return [refusal.remedy, ...(refusal.otherRemedies ?? [])].filter((r): r is RemedyFacts => !!r && typeof r.kind === 'string');
}

/** Whether the refusal names allowing RobotWare 8 motion control as a way (a client without remedies: the kind). */
function namesAllowMotionControl(refusal: RefusalLike): boolean {
  const all = remediesOf(refusal);
  if (all.length === 0) { return refusal.kind === 'motion-control-off'; }
  return all.some(r => r.kind === 'declare-motion-control' && r.call?.method === 'setAllowMotionControl');
}

/** The RMMP request a remedy of the refusal names, with its level. */
function rmmpCall(refusal: RefusalLike): { level: 'modify' | 'exec' } | undefined {
  const call = remediesOf(refusal).find(r => r.kind === 'request-rmmp')?.call;
  return call?.method === 'requestRmmp' ? { level: call.level } : undefined;
}

/**
 * The buttons for an error on `robotName`, from the client's remedies. A
 * button only for a remedy whose call RAPID Live makes after a person
 * confirms: "Allow Motion Control…" where the client names allowing
 * RobotWare 8 motion control (it opens the Allow command for that robot, and
 * the person then runs the refused command again); "Request Remote Control"
 * where it names an RMMP request on RobotWare 6/7, at the level it names for
 * the refused operation. "Show Holder" where another client holds mastership
 * (RobotWare 6/7, read from the mastership status) or write access
 * (RobotWare 8, read from the control station status, which names the
 * station only): a read. Every remedy that only a person at the FlexPendant,
 * the holder, an administrator or the integrator can take is explained by the
 * sentence and never offered as an action. A mastership error the client did
 * not explain (`errorCode` MASTERSHIP_REQUIRED, RobotWare 6/7) offers Show
 * Holder and the release of this tool's own locks on that robot, named so
 * that nobody takes it for a way to take control from someone else. A robot
 * that registers as a fixed control station (`robot.fixedStation`) gets no
 * Allow Motion Control…: RAPID Live refuses it there.
 */
export function refusalButtons(
  refusal: RefusalFacts | undefined, generation: Generation, robotName: string, errorCode?: string, robot: RobotFacts = {},
): RefusalButton[] {
  const gen = refusal?.generation ?? generation;
  const rw67 = gen === 'rw6' || gen === 'rw7';
  if (refusal) {
    const buttons: RefusalButton[] = [];
    if (gen === 'rw8' && namesAllowMotionControl(refusal) && !robot.fixedStation) {
      buttons.push({ label: ALLOW_MOTION_CONTROL_BUTTON, action: 'declare-motion-control' });
    }
    const rmmp = rw67 ? rmmpCall(refusal) : undefined;
    if (rmmp) { buttons.push({ label: 'Request Remote Control', action: 'request-rmmp', level: rmmp.level }); }
    if (refusal.kind === 'held-by-other') {
      if (refusal.condition === 'mastership' && rw67) { buttons.push({ label: 'Show Holder', action: 'show-holder' }); }
      if (refusal.condition === 'write-access' && gen === 'rw8') { buttons.push({ label: 'Show Holder', action: 'show-holder' }); }
    }
    return buttons;
  }
  if (errorCode === 'MASTERSHIP_REQUIRED' && rw67) {
    return [
      { label: 'Show Holder', action: 'show-holder' },
      { label: `Release this tool's control of ${robotName}`, action: 'release-own' },
    ];
  }
  return [];
}

/**
 * Whether a RobotWare 8 write-access holder is the FlexPendant: the station name,
 * compared ignoring case and surrounding spaces, is `FlexPendant` (RW 8.2.1,
 * 2026-10-18). The client's write-access status carries the controller's name only
 * (its `isPendant` is on a refusal's holder), so the name decides. A station named
 * otherwise, `TPU` too, or none is not known to be the FlexPendant; the client,
 * the daemon and the panel use the same rule.
 */
export function isFlexPendantStation(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'flexpendant';
}

/**
 * Whether a RobotWare 6/7 mastership holder's application is the FlexPendant's:
 * `TPU`, compared ignoring case and surrounding spaces (RW 7.21.4, 2026-10-18).
 * Asked for a `local` holder only: a remote holder with application `TPU` has not
 * been seen and is not taken for the FlexPendant (the client, the daemon and the
 * panel use the same rule).
 */
export function isFlexPendantApplication(application: string | null | undefined): boolean {
  return typeof application === 'string' && application.trim().toLowerCase() === 'tpu';
}

/**
 * The RobotWare 8 write-access holder in one sentence: the station's name, never
 * its id; the FlexPendant by that name.
 */
export function writeAccessHolderText(robotName: string, status: WriteAccessStatus): string {
  let text: string;
  if (status.held === true) {
    text = status.heldByMe && status.heldByName ? `${robotName}: write access is held by this tool's own station, '${status.heldByName}'.`
      : isFlexPendantStation(status.heldByName) ? `${robotName}: write access is held by the FlexPendant.`
      : status.heldByName ? `${robotName}: write access is held by the station '${status.heldByName}'.`
      : `${robotName}: write access is held; the controller names no station.`;
  } else if (status.held === false) {
    text = `${robotName}: no station holds write access.`;
  } else {
    text = `${robotName}: the controller did not say whether write access is held.`;
  }
  if (status.externalControlEnabled === false) {
    text += ' Remote Access is off at the FlexPendant, so no remote station can take it.';
  }
  return text;
}

/**
 * The RobotWare 6/7 RAPID (edit) mastership status in one line. The FlexPendant
 * holds it when the status reads `local` with its application (`TPU` on RobotWare 7),
 * and is then named "the FlexPendant"; any other holder by its application as the
 * controller gives it.
 */
export function mastershipHolderText(robotName: string, status: { mastership: string; uid?: string; application?: string }): string {
  const pendant = status.mastership === 'local' && isFlexPendantApplication(status.application);
  const heldBy = pendant ? 'the FlexPendant' : status.application;
  return `${robotName}: domain=edit (rapid) | mastership=${status.mastership}`
    + (heldBy ? ` | held-by=${heldBy}` : '')
    + (status.uid ? ` | uid=${status.uid}` : '');
}

/**
 * The client's refusal of load, unload or a pointer move to a routine while
 * the RAPID program runs: a wrong-state refusal by this tool that misses a
 * stopped program. The client sends the write and the controller decides; its
 * refusal is explained this way and then carries the controller's HTTP status,
 * which a refusal the client raised before sending does not.
 */
export function isProgramRunningRefusal(e: unknown): boolean {
  const r = (e as { refusal?: { kind?: string; grantor?: string | null; missing?: string } } | null | undefined)?.refusal;
  return !!r && r.kind === 'wrong-state' && r.grantor === 'this-tool' && /stopped RAPID program/i.test(r.missing ?? '');
}

/** Where the Reset after a safety stop is on RobotWare 8. */
export const RW8_RESET_HINT = 'On RobotWare 8 the Reset is at the FlexPendant: press the thumb button in Auto (or the configured safe input).';

/**
 * RAPID Live's next step after RobotWare 8 refused a RAPID start or a jog
 * because motion control is not allowed for this station
 * (`motion-control-off`): the error offers Allow Motion Control, and the
 * FlexPendant stays the other way.
 */
export const MOTION_CONTROL_OFF_NEXT_STEP = 'To start or jog from here, choose Allow Motion Control and confirm both stops are within your reach. '
  + 'Or start or jog from the FlexPendant.';

/**
 * RAPID Live's own next step after the client's sentence, where it adds one;
 * undefined otherwise. For a robot that registers as a fixed control station
 * it names the FlexPendant only.
 */
export function refusalNextStep(refusal: RefusalLike | undefined, generation: Generation = null, robot: RobotFacts = {}): string | undefined {
  if (!refusal?.kind) { return undefined; }
  const gen = refusal.generation ?? generation;
  if (gen !== 'rw8' || !namesAllowMotionControl(refusal)) { return undefined; }
  return robot.fixedStation ? FIXED_STATION_NEXT_STEP : MOTION_CONTROL_OFF_NEXT_STEP;
}

/**
 * The client's own next step as text, where the dialog shows it apart from
 * the sentence: a remedy kind this RAPID Live does not know (shown as text,
 * never as a button), and a next step without a call when a button offers
 * another way (the person reads the next step first: "speak to the operator
 * first" before Request Remote Control, "check the state first" before Allow
 * Motion Control). Undefined otherwise: the sentence says it.
 */
export function remedyNote(refusal: RefusalLike | undefined, generation: Generation = null, robot: RobotFacts = {}): string | undefined {
  const first = refusal?.remedy;
  if (!refusal?.kind || !first || typeof first.detail !== 'string' || first.detail === '') { return undefined; }
  if (!KNOWN_REMEDY_KINDS.has(first.kind)) { return first.detail; }
  if (first.call) { return undefined; }
  const gen = refusal.generation ?? generation;
  const offered = (gen === 'rw8' && namesAllowMotionControl(refusal) && !robot.fixedStation)
    || ((gen === 'rw6' || gen === 'rw7') && rmmpCall(refusal) !== undefined);
  return offered ? first.detail : undefined;
}

/**
 * The error text for a refusal the client explained: the label, the client's
 * message (its sentence and the controller's answer), then RAPID Live's own
 * note where it has one: where the Reset is on RobotWare 8 after a safety
 * stop, unless the message says it already; the client's next step where it is
 * shown apart (`remedyNote`); and the next step for motion control (the
 * FlexPendant only, for a robot that registers as a fixed control station).
 */
export function refusalMessage(
  label: string, raw: string,
  refusal: RefusalLike,
  generation: Generation,
  robot: RobotFacts = {},
): string {
  let msg = `${label}: ${raw}`;
  if (refusal.grantor === 'cell-safety' && (refusal.generation ?? generation) === 'rw8' && !/thumb button/i.test(raw)) {
    msg += ` ${RW8_RESET_HINT}`;
  }
  return withNote(withNote(msg, remedyNote(refusal, generation, robot)), refusalNextStep(refusal, generation, robot));
}

/** The name of a safety stop (guard stop, emergency stop); undefined in any other controller state. */
export function safetyStopName(ctrlstate: string | null | undefined): string | undefined {
  return ctrlstate === 'guardstop' ? 'guard stop' : ctrlstate === 'emergencystop' ? 'emergency stop' : undefined;
}

/** A safety stop: guard stop or emergency stop. */
export function inSafetyStop(ctrlstate: string | null | undefined): boolean {
  return safetyStopName(ctrlstate) !== undefined;
}

/**
 * The note after a refused operating-mode switch. The switch is sent in every
 * controller state and the controller decides; its refusal (`message`) is
 * shown with the client's sentence. On RobotWare 8 in a safety stop the note
 * says where the Reset is, unless the sentence already does; otherwise there
 * is none.
 */
export function opModeRefusalNote(ctrlstate: string | null | undefined, generation: Generation, message = ''): string | undefined {
  return generation === 'rw8' && inSafetyStop(ctrlstate) && !/thumb button/i.test(message) ? RW8_RESET_HINT : undefined;
}

/** A message with a note after it, unless the message already carries the note. */
export function withNote(message: string, note?: string): string {
  return note && !message.includes(note) ? `${message} ${note}` : message;
}

/** The controller's code for a RAPID semantic error (SYS_CTRL_E_RAPID_SEMANTIC_ERROR). */
export const RAPID_SEMANTIC_ERROR = -1073442802;

/**
 * A RAPID semantic error (-1073442802, icode -519): on a program pointer move
 * usually two modules each declaring PROC main(). When the error carries the
 * controller's code, the code decides: the client's sentence can quote an
 * event-log message that speaks of a semantic error while the refusal is
 * another one (an unload refused with its reason in the event log). The text
 * decides only for an error without a code.
 */
export function isSemanticError(e: unknown): boolean {
  const code = (e as { controllerCode?: unknown } | null | undefined)?.controllerCode;
  if (typeof code === 'number') { return code === RAPID_SEMANTIC_ERROR; }
  const msg = e instanceof Error ? e.message : String(e);
  return /Semantic error|semantic error\(s\)|icode:-519/.test(msg);
}

/** The client reports what a call did before it was refused ("Done before it: ..."). */
export function reportsStepsDone(message: string): boolean {
  return /Done before it:/.test(message);
}

/** The hint after a semantic error that ended a call which had already done steps. */
export const SEMANTIC_ERROR_HINT = 'If two loaded modules each define PROC main(), unload one of them in the Modules panel.';

/**
 * The error text for a RAPID semantic error. A call that did steps before the
 * refusal reports them: a load says it uploaded and loaded the module, under
 * the name the controller gave it when that differs (`<NAME>#2`). That report
 * is shown whole (`explained`: the client's sentence as RAPID Live shows a
 * refusal), with the PROC main() hint after it. Any other semantic error gets
 * the hint alone.
 */
export function semanticErrorText(label: string, raw: string, explained?: string): string {
  if (reportsStepsDone(raw)) { return withNote(explained ?? `${label} failed: ${raw}`, SEMANTIC_ERROR_HINT); }
  return `${label} blocked - RAPID program has a semantic error. Most often this means two loaded modules each define PROC main(). Open the Modules panel, right-click any of the program modules, and Unload Module. Then try again.`;
}

/** What the "stop the program first?" dialog says under its question. */
export function stopOfferDetail(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message;
  const done = typeof msg === 'string' && reportsStepsDone(msg);
  const first = done
    ? 'The controller refused it while the program ran; read the message for what was done before the refusal.'
    : 'The controller refused it while the program ran. Nothing was changed.';
  return `${first} The program is stopped only if you choose to stop it here.`;
}
