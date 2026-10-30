// Connect to a saved robot. RobotStudio gives a virtual controller a new port when it restarts,
// and virtual controllers that restart together can swap ports. The robot's user and password go
// only to its saved address or to a controller the person chose:
// - a saved port on this PC that answers nothing: Connect looks on this PC's other ports (probes
//   without credentials) and asks before it takes a controller found there as the robot; with no
//   answer it stops and sends nothing;
// - a saved address that answers as another system than the one the robot last connected to:
//   Connect disconnects and asks before it keeps that controller as the robot.
// Telling two controllers apart needs a login, so Connect never logs in to a controller to look
// for the robot. Each connect gets a fresh manager, which has read no system id: the client then
// has nothing to compare a controller with, so it does not log in to others to look for one.
// No `vscode` import: extension.ts runs the probes and shows the dialogs; the tests run the flow
// with fakes.

import type { FoundController } from 'abb-rws-client';

/** What a robot connected to last time on this PC, read after each connect. */
export interface LastSeen {
  systemId: string;
  systemName?: string;
  rwVersion?: string;
}

/** The key in the extension's global state (this PC only, never synced) that holds `LastSeen` by robot id. */
export const LAST_SEEN_KEY = 'abbRobot.lastSeenControllers';

/** The system as the client reads it after a connect (`RobotState.systemInfo`). */
export interface SystemReading {
  name?: string;
  rwVersion?: string;
  sysid?: string;
}

/** The record with this robot's reading in it; undefined when the reading has no system id or changes nothing. */
export function withLastSeen(
  all: Readonly<Record<string, LastSeen>> | undefined, id: string, info: SystemReading | null | undefined,
): Record<string, LastSeen> | undefined {
  if (!info?.sysid) { return undefined; }
  const next: LastSeen = {
    systemId: info.sysid,
    ...(info.name ? { systemName: info.name } : {}),
    ...(info.rwVersion ? { rwVersion: info.rwVersion } : {}),
  };
  const prev = all?.[id];
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) { return undefined; }
  return { ...(all ?? {}), [id]: next };
}

/** The record without this robot; undefined when it had no entry. */
export function withoutLastSeen(
  all: Readonly<Record<string, LastSeen>> | undefined, id: string,
): Record<string, LastSeen> | undefined {
  if (!all || !Object.prototype.hasOwnProperty.call(all, id)) { return undefined; }
  const { [id]: _gone, ...rest } = all;
  return rest;
}

/** The protocol a saved robot speaks, from its saved HTTPS flag (RWS 2.0 runs over HTTPS); undefined when none is saved. */
export function savedProtocol(useHttps: boolean | undefined): 'rws1' | 'rws2' | undefined {
  return useHttps === undefined ? undefined : useHttps ? 'rws2' : 'rws1';
}

/**
 * The controllers found on this PC that could be the robot: probed, answering with an ABB
 * controller's login challenge, of the robot's protocol, on another port.
 */
export function movedPortCandidates(
  found: readonly FoundController[], saved: { port: number; useHttps?: boolean },
): FoundController[] {
  const protocol = savedProtocol(saved.useHttps);
  return found.filter(c => c.probe !== null && c.identified && c.probe.port !== saved.port
    && (protocol === undefined || c.generation === protocol));
}

/** `host:port` as the dialogs write it; the host alone when the port is not known. */
export function addressText(host: string, port: number | undefined): string {
  return port !== undefined ? `${host}:${port}` : host;
}

/**
 * One found controller in a line: address, name, RobotWare. `host` is the address Connect will
 * use (the robot's saved host); the scan may have probed another address of this PC, and a
 * virtual controller answers on each of them.
 */
export function foundControllerText(c: FoundController, host: string = c.host): string {
  const rw = c.rwVersion ? `RobotWare ${c.rwVersion}`
    : c.generation === 'rws1' ? 'RobotWare 6'
      : c.generation === 'rws2' ? 'RobotWare 7 or 8' : 'RobotWare not known';
  return `${host}:${c.port}: ${c.systemName ?? 'name not known'}, ${rw}`;
}

/** What the robot connected to last time, in a line. */
export function lastSeenText(last: LastSeen): string {
  return `${last.systemName ?? `system ${last.systemId}`}${last.rwVersion ? `, RobotWare ${last.rwVersion}` : ''}`;
}

export interface MovedPortQuestion {
  message: string;
  detail: string;
  /** One button per controller found; Cancel is the dialog's own. */
  choices: Array<{ label: string; controller: FoundController }>;
}

/** The modal that asks before a controller found on another port is taken as the robot. */
export function movedPortQuestion(
  robot: { name: string; host: string; port: number },
  candidates: readonly FoundController[],
  last?: LastSeen,
): MovedPortQuestion {
  const what = candidates.length === 1 ? 'the controller found' : `one of the ${candidates.length} controllers found`;
  const lines = [
    ...candidates.map(c => `Found ${foundControllerText(c, robot.host)}.`),
    ...(last ? [`"${robot.name}" last connected to ${lastSeenText(last)}.`] : []),
    'RAPID Live cannot tell which controller this is without logging in, so it asks first.',
    `The user and password of "${robot.name}" are sent only to the controller you choose, and its new port is saved once it connects. Cancel sends nothing.`,
  ];
  return {
    message: `"${robot.name}" does not answer on ${robot.host}:${robot.port}. Connect it to ${what} on this PC?`,
    detail: lines.join('\n'),
    choices: candidates.map(c => ({ label: `Connect to port ${c.port}`, controller: c })),
  };
}

// ─── Connect, step by step ──────────────────────────────────────────────────

/** The robot's entry in memory, as Connect reads it. */
export interface ConnectTarget {
  name: string;
  host: string;
  port?: number;
  useHttps?: boolean;
}

/** The robot's session now. */
export interface SessionNow {
  connected: boolean;
  host: string;
  port?: number;
  /** true when the session logged in with the user and password the robot has now. */
  sameLogin: boolean;
}

/**
 * What Connect does:
 * - `keep`: the robot is connected to its saved address with its saved login; the client keeps
 *   the session.
 * - `saved`: connect to the saved address, on a fresh manager.
 * - `chosen`: connect to a port of this PC chosen in the moved-port question, on a fresh manager.
 * - `stop`: send nothing. `message` says why, when there is something to say.
 */
export type ConnectPlan =
  | { kind: 'keep' }
  | { kind: 'saved' }
  | { kind: 'chosen'; port: number; useHttps: boolean }
  | { kind: 'stop'; why: 'declined' | 'cancelled' | 'no-answer'; message?: string };

export interface PlanSteps {
  isLocal(host: string): boolean;
  /** A probe without credentials: true when an RWS controller answers on `host:port`. */
  answers(host: string, port: number): Promise<boolean>;
  /** This PC's controllers, probed without credentials. Throws when the scan could not run. */
  find(): Promise<{ controllers: FoundController[]; notes: string[] }>;
  /** Show the moved-port question: the controller chosen, or undefined for Cancel. */
  ask(q: MovedPortQuestion): Promise<FoundController | undefined>;
  cancelled(): boolean;
  report(message: string): void;
}

/** Why Connect sent nothing: the robot, the address that answers nothing, and what the scan said. */
export function noAnswerMessage(
  robot: ConnectTarget & { port: number }, scan: { error: string } | { notes: readonly string[] },
): string {
  const at = `"${robot.name}" does not answer on ${robot.host}:${robot.port}`;
  if ('error' in scan) {
    return `${at}, and this PC could not be searched for it (${scan.error}). Nothing was sent.`;
  }
  const others = savedProtocol(robot.useHttps) ? 'no other controller of its protocol' : 'no other controller';
  return [`${at}, and ${others} answers on this PC. Nothing was sent.`, ...scan.notes].join(' ');
}

/**
 * Decide what Connect does, before anything is sent with the robot's user and password.
 * The probes and the scan send no credentials.
 */
export async function planConnect(
  robot: ConnectTarget, session: SessionNow, last: LastSeen | undefined, s: PlanSteps,
): Promise<ConnectPlan> {
  if (session.connected && session.sameLogin && session.host === robot.host && session.port === robot.port) {
    return { kind: 'keep' };
  }
  // Another machine names one controller per address; the client looks for it on that host only.
  if (robot.port === undefined || !s.isLocal(robot.host)) { return { kind: 'saved' }; }
  const saved = { ...robot, port: robot.port };
  if (await s.answers(saved.host, saved.port)) { return { kind: 'saved' }; }
  if (s.cancelled()) { return { kind: 'stop', why: 'cancelled' }; }
  s.report(`port ${saved.port} answers nothing - looking on this PC…`);
  let found: { controllers: FoundController[]; notes: string[] };
  try {
    found = await s.find();
  } catch (e) {
    return { kind: 'stop', why: 'no-answer', message: noAnswerMessage(saved, { error: e instanceof Error ? e.message : String(e) }) };
  }
  if (s.cancelled()) { return { kind: 'stop', why: 'cancelled' }; }
  const candidates = movedPortCandidates(found.controllers, saved);
  if (candidates.length === 0) {
    return { kind: 'stop', why: 'no-answer', message: noAnswerMessage(saved, { notes: found.notes }) };
  }
  const chosen = (await s.ask(movedPortQuestion(saved, candidates, last)))?.probe;
  if (!chosen) { return { kind: 'stop', why: 'declined' }; }
  // The question can stay open for any length of time: the chosen controller is probed again,
  // on the address Connect will use, before its user and password are sent.
  if (!await s.answers(saved.host, chosen.port)) {
    return {
      kind: 'stop', why: 'no-answer',
      message: `"${robot.name}": nothing answers on ${saved.host}:${chosen.port} now, so nothing was sent. Connect again to look for it.`,
    };
  }
  return { kind: 'chosen', port: chosen.port, useHttps: chosen.useHttps };
}

export interface AttemptSteps {
  connect(): Promise<void>;
  /** Before each retry: false when the address answers nothing now, which ends the retries. Omitted: no probe. */
  answers?(): Promise<boolean>;
  cancelled(): boolean;
  wait(ms: number): Promise<void>;
  report(message: string): void;
}

/**
 * - `connected`: the connect returned (the session may still have ended meanwhile).
 * - `failed`: the last attempt's error, also when Cancel came after a busy retry.
 * - `gone`: the address no longer answered between busy retries; nothing more was sent.
 */
export type AttemptResult =
  | { kind: 'connected' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'cancelled' }
  | { kind: 'gone' };

/** A controller that answers 503 or says it is busy is tried again, up to `attempts` times. */
export function isBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('503') || msg.toLowerCase().includes('busy');
}

/** Connect, retrying only while the controller is busy; the address is probed again before each retry. */
export async function connectWithRetries(s: AttemptSteps, attempts = 20, waitMs = 3000): Promise<AttemptResult> {
  let error: unknown;
  let failed = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (s.cancelled()) { return failed ? { kind: 'failed', error } : { kind: 'cancelled' }; }
    if (attempt > 1 && s.answers && !await s.answers()) { return { kind: 'gone' }; }
    try {
      await s.connect();
      return { kind: 'connected' };
    } catch (e) {
      error = e;
      failed = true;
      if (!isBusyError(e) || attempt >= attempts) { return { kind: 'failed', error: e }; }
      s.report(`Controller busy - retrying… (${attempt}/${attempts})`);
      await s.wait(waitMs);
    }
  }
  return { kind: 'failed', error };
}

/** How a reading compares with what the robot last connected to. */
export type IdentityVerdict = 'first' | 'same' | 'different' | 'unknown';

/** System ids compare without braces, case or surrounding spaces. */
function systemIdKey(id: string): string {
  return id.trim().replace(/^\{|\}$/g, '').toLowerCase();
}

export function identityVerdict(last: LastSeen | undefined, reading: SystemReading | null | undefined): IdentityVerdict {
  if (!last) { return 'first'; }
  if (!reading?.sysid) { return 'unknown'; }
  return systemIdKey(reading.sysid) === systemIdKey(last.systemId) ? 'same' : 'different';
}

/**
 * The question before a port found by scanning this PC is saved, when the
 * controller gave no system id to confirm it is the robot last seen. Saying
 * no keeps the saved address; the session stays on the port it connected to.
 */
export function unverifiedPortQuestion(name: string, port: number, last: LastSeen): { message: string; detail: string; button: string } {
  const seen = last.systemName ? `${last.systemName} (system id ${last.systemId})` : `system ${last.systemId}`;
  return {
    message: `Save port ${port} for "${name}"?`,
    detail: `"${name}" answers on port ${port}, which RAPID Live found by scanning this PC. The controller did not say its system id, so RAPID Live cannot confirm it is the one last seen (${seen}). Writes to it are held back until the controller confirms it. Nothing is sent by this choice.`,
    button: `Save port ${port}`,
  };
}

/** The refusal of a write while a scanned port's controller has not confirmed its system id (the wrappers' mode seam). */
export function unverifiedWriteRefusal(label: string, robotLabel: string): string {
  return `${label} not sent: ${robotLabel} answered on a port RAPID Live found by scanning, and the controller has not confirmed its system id yet. Connect again once it has, or check the robot's address.`;
}

/** A port and HTTPS flag, as a robot's entry holds them. */
export interface PortOf { port?: number; useHttps?: boolean }

export interface AfterConnect {
  plan: Exclude<ConnectPlan, { kind: 'stop' }>;
  /** The robot's address is on this PC. */
  local: boolean;
  /** The robot's entry before Connect. */
  saved: PortOf;
  /** What the last connect attempt was given. */
  asked: PortOf;
  /** The robot's entry in memory now. */
  memory: PortOf;
  connected: boolean;
  /** The port the session runs on. */
  currentPort?: number;
  reading?: SystemReading | null;
  last?: LastSeen;
}

/**
 * What Connect does once the connect returned. `restore`: put this port back in memory.
 * - `not-connected`: a chosen port that did not connect is not kept (a port changed outside this
 *   window meanwhile is).
 * - `elsewhere`: on this PC the session runs on another port than the one asked for: the address
 *   no longer answered and the client took another controller. Disconnect, save nothing.
 * - `different`: the controller read another system id than the robot last connected to.
 *   Disconnect, save nothing, ask.
 * - `save`: save this port: chosen in the question, or found by the client on the robot's own
 *   host (a controller on another machine, or a robot saved without a port).
 * - `done`: `record` the reading as what the robot connected to; `verifyLater` when the reading
 *   has no system id yet and the robot has a record to compare it with.
 */
export type ConnectOutcome =
  | { kind: 'not-connected'; restore?: PortOf }
  | { kind: 'elsewhere'; port: number; restore?: PortOf }
  | { kind: 'different'; reading: SystemReading; restore?: PortOf }
  | { kind: 'save'; port: number; useHttps?: boolean; record: boolean; verifyLater: boolean }
  | { kind: 'done'; record: boolean; verifyLater: boolean };

export function settleConnect(a: AfterConnect): ConnectOutcome {
  const chosen = a.plan.kind === 'chosen' ? a.plan : undefined;
  if (!a.connected) {
    return chosen && a.memory.port === chosen.port ? { kind: 'not-connected', restore: a.saved } : { kind: 'not-connected' };
  }
  if (a.plan.kind === 'keep') { return { kind: 'done', record: false, verifyLater: false }; }
  // The session runs on another port than the one asked for: the client found it (`moved`
  // when it left a port it was given; with no port given it looks on the robot's host).
  const portChanged = a.currentPort !== undefined && a.currentPort !== a.asked.port;
  const moved = portChanged && a.asked.port !== undefined;
  // After a connect the client keeps the port it ended on in memory.
  const memoryIsSession = a.currentPort !== undefined && a.memory.port === a.currentPort;
  if (moved && a.local) {
    const restore = memoryIsSession ? (chosen ? a.saved : a.asked) : undefined;
    return restore ? { kind: 'elsewhere', port: a.currentPort as number, restore } : { kind: 'elsewhere', port: a.currentPort as number };
  }
  if (chosen) {
    return a.memory.port === chosen.port
      ? { kind: 'save', port: chosen.port, useHttps: chosen.useHttps, record: true, verifyLater: false }
      : { kind: 'done', record: true, verifyLater: false };
  }
  const verdict = identityVerdict(a.last, a.reading);
  if (verdict === 'different') {
    const reading = a.reading as SystemReading;
    return portChanged && memoryIsSession ? { kind: 'different', reading, restore: a.asked } : { kind: 'different', reading };
  }
  const record = verdict === 'first' || verdict === 'same';
  const verifyLater = verdict === 'unknown';
  if (portChanged && memoryIsSession) {
    return { kind: 'save', port: a.currentPort as number, useHttps: a.memory.useHttps, record, verifyLater };
  }
  return { kind: 'done', record, verifyLater };
}

/** A system reading in a line: name (or system id) and RobotWare. */
function readingText(reading: SystemReading, sameNameAs?: string): string {
  const name = reading.name ?? `system ${reading.sysid ?? 'not known'}`;
  const id = reading.name && reading.name === sameNameAs && reading.sysid ? ` (system id ${reading.sysid})` : '';
  return `${name}${id}${reading.rwVersion ? `, RobotWare ${reading.rwVersion}` : ''}`;
}

export interface DifferentSystemQuestion {
  message: string;
  detail: string;
  accept: string;
}

/** The modal shown after the robot's address answered as another system than last time. */
export function differentSystemQuestion(
  robot: { name: string; host: string; port?: number }, reading: SystemReading, last: LastSeen,
): DifferentSystemQuestion {
  const at = addressText(robot.host, robot.port);
  const sameName = !!last.systemName && last.systemName === reading.name;
  const lastLine = sameName ? `${lastSeenText(last)} (system id ${last.systemId})` : lastSeenText(last);
  return {
    message: `"${robot.name}" answers on ${at} as another controller than last time. Keep this controller as "${robot.name}"?`,
    detail: [
      `On ${at}: ${readingText(reading, last.systemName)}.`,
      `"${robot.name}" last connected to ${lastLine}.`,
      'RAPID Live disconnected it and saved nothing.',
      `Connect to this controller connects again and takes it as "${robot.name}" from now on. Cancel leaves it disconnected.`,
    ].join('\n'),
    accept: 'Connect to this controller',
  };
}

/** The message after the client connected the robot to another port of this PC than the one asked for. */
export function elsewhereMessage(robot: { name: string; host: string }, asked: number | undefined, port: number): string {
  return `"${robot.name}" no longer answered on ${addressText(robot.host, asked)} during the connect, and another controller on this PC answered on port ${port}. `
    + `RAPID Live disconnected from it and saved nothing. Connect again to look for "${robot.name}".`;
}

/** The message after the address no longer answered between busy retries. */
export function goneMessage(robot: { name: string; host: string; port?: number }): string {
  return `Connect to "${robot.name}" stopped: nothing answers on ${addressText(robot.host, robot.port)} now. Connect again to look for it.`;
}

/**
 * Run `run` for a robot unless one is already running for it: a second Connect (a double click,
 * Reconnect while the row's Connect runs) shows no second question. Undefined when skipped.
 */
export async function onceAtATime<T>(running: Set<string>, id: string, run: () => Promise<T>): Promise<T | undefined> {
  if (running.has(id)) { return undefined; }
  running.add(id);
  try {
    return await run();
  } finally {
    running.delete(id);
  }
}
