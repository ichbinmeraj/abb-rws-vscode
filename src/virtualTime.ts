// Show / Control Virtual Time: the parts that need no `vscode`, so the unit
// tests can state them.

/**
 * Why the command offers no pause or resume: the client no longer has the
 * capability, and the virtual clock is controlled in RobotStudio. Speed writes
 * stay.
 */
export const VIRTUAL_TIME_NO_PAUSE =
  "Pause and resume are not offered: RobotStudio's Simulation tab controls the virtual clock.";

/** The actions on the notification (RobotWare 7 and 8): speed only. */
export const VIRTUAL_TIME_ACTIONS = ['Set scale 1x', 'Set scale 10x'] as const;
export type VirtualTimeAction = typeof VIRTUAL_TIME_ACTIONS[number];

const SCALE: Record<VirtualTimeAction, number> = { 'Set scale 1x': 1, 'Set scale 10x': 10 };

/** The RobotWare generation of the session, once known. */
export type VirtualTimeGeneration = 'rw6' | 'rw7' | 'rw8' | null | undefined;

/**
 * Shown instead of the speed actions on RobotWare 6. ABB's RWS 1.0 documents
 * the speed write for virtual controllers; RAPID Live does not send it in this
 * release, and the client refuses it there before sending.
 */
export const VIRTUAL_TIME_NOT_SET_RW6 =
  'RAPID Live does not set virtual time on RobotWare 6 in this release; change the simulation speed in RobotStudio.';

/** Whether the speed can be set from here: RobotWare 7 and 8 only. */
export function virtualTimeWritable(gen: VirtualTimeGeneration): boolean {
  return gen === 'rw7' || gen === 'rw8';
}

/** The actions to offer on the notification: the speed actions on RobotWare 7 and 8, none otherwise. */
export function virtualTimeActionsFor(gen: VirtualTimeGeneration): readonly VirtualTimeAction[] {
  return virtualTimeWritable(gen) ? VIRTUAL_TIME_ACTIONS : [];
}

/** The virtual time as the client reads it. */
export interface VirtualTimeReading {
  /** Milliseconds since the VC started. */
  time: number;
  running: boolean;
  /** A factor of real time; Infinity = as fast as possible. */
  speed?: number;
  /** The controller's own word for the state. */
  state?: string;
}

/** The notification text: time in seconds, running or paused, speed, state, and why there is no pause. */
export function virtualTimeSummary(vt: VirtualTimeReading): string {
  const speed = vt.speed === undefined ? '' : vt.speed === Infinity ? ', full speed' : `, ${vt.speed}x`;
  const state = vt.state ? ` (${vt.state})` : '';
  return `Virtual time: ${(vt.time / 1000).toFixed(1)} s - ${vt.running ? 'running' : 'paused'}${speed}${state}. ${VIRTUAL_TIME_NO_PAUSE}`;
}

/**
 * The notification text for a robot of this generation. On RobotWare 6 it is
 * the state alone, with the one line that says RAPID Live does not set it.
 * While the generation is not known yet, the text says nothing about
 * RobotWare 6 (and no speed action is offered).
 */
export function virtualTimeNotice(vt: VirtualTimeReading, gen: VirtualTimeGeneration): string {
  if (gen !== 'rw6') { return virtualTimeSummary(vt); }
  const speed = vt.speed === undefined ? '' : vt.speed === Infinity ? ', full speed' : `, ${vt.speed}x`;
  const state = vt.state ? ` (${vt.state})` : '';
  return `Virtual time: ${(vt.time / 1000).toFixed(1)} s - ${vt.running ? 'running' : 'paused'}${speed}${state}. ${VIRTUAL_TIME_NOT_SET_RW6}`;
}

/**
 * The scale the action the user picked asks for (`setVirtualTimeScale`, sent
 * by the extension behind its confirmation). Undefined, so nothing is sent,
 * for anything that is not a speed action, and on a generation where RAPID
 * Live does not set the speed.
 */
export function virtualTimeScaleFor(action: string | undefined, gen: VirtualTimeGeneration = 'rw7'): number | undefined {
  if (!virtualTimeWritable(gen)) { return undefined; }
  if (action === undefined || !Object.prototype.hasOwnProperty.call(SCALE, action)) { return undefined; }
  return SCALE[action as VirtualTimeAction];
}
