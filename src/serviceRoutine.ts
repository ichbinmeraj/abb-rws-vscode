// Call Service Routine: the parts that need no `vscode`, so the unit tests can
// state them.

export interface ServiceRoutineTarget { routineName: string; moduleName: string | undefined }

/**
 * The routine and its module from a service-routine listing URL
 * (`RAPID/{task}/{module}/{routine}`). Without a module in the URL the module
 * is left out, and the client takes it from its own read of the listing.
 */
export function serviceRoutineTarget(url: string, label: string): ServiceRoutineTarget {
  const seg = url.split('/').filter(Boolean);
  return {
    routineName: seg[seg.length - 1] || label,
    moduleName: seg.length >= 2 ? seg[seg.length - 2] : undefined,
  };
}

/** The active robot as the command reads it; the pointer move itself is the extension's, behind its confirmation. */
export interface ServiceRoutineRobot {
  listServiceRoutines(task: string): Promise<Array<{ name: string; url: string }>>;
}

/** The window the command talks through (`vscode` in the extension). */
export interface ServiceRoutineUi {
  pick(items: Array<{ label: string; description: string; url: string }>): PromiseLike<{ label: string; url: string } | undefined>;
  info(message: string): void;
  warn(message: string): void;
  /**
   * Move the program pointer to the picked routine, behind the confirmation
   * naming the robot and the task (`setPPToServiceRoutine(task, routine,
   * module)`, with the stop offer); false when nothing was sent.
   */
  movePointer(target: ServiceRoutineTarget): Promise<boolean>;
}

/**
 * Call Service Routine: list the task's service routines (a read), let the
 * user pick one, and set the program pointer to it, on RWS 1.0 and RWS 2.0
 * alike. The client reads the task's service-routine listing first and
 * refuses, sending nothing, a routine that is not listed. The controller
 * decides the operating mode: ABB documents a pointer move to a routine for a
 * remote client in Auto on RobotWare 6 and 7 (in manual only with RMMP exec on
 * RobotWare 7). One case is held back by the client itself: RobotWare 8 in
 * Auto. A refusal (the controller's, or the client's hold) propagates.
 */
export async function callServiceRoutine(active: ServiceRoutineRobot, taskName: string, ui: ServiceRoutineUi): Promise<void> {
  const routines = await active.listServiceRoutines(taskName);
  if (routines.length === 0) { ui.warn(`Task ${taskName} lists no service routines.`); return; }
  const pick = await ui.pick(routines.map(r => ({ label: r.name, description: r.url, url: r.url })));
  if (!pick) { return; }
  const target = serviceRoutineTarget(pick.url, pick.label);
  if (!await ui.movePointer(target)) { return; }
  const where = target.moduleName ? ` (${target.moduleName})` : '';
  ui.info(`Program pointer set to ${target.routineName}${where}. Start RAPID to run the service routine.`);
}

/**
 * A refusal of the pointer move for the operating mode: the controller's own
 * (ABB: a remote client moves it in Auto; in manual only with RMMP exec on
 * RobotWare 7) or the client's hold on RobotWare 8 in Auto. Its message is the
 * sentence to show; `undefined` for any other error.
 */
export function modeRefusal(e: unknown): string | undefined {
  const err = e as { code?: unknown; message?: unknown; refusal?: { condition?: unknown } } | null | undefined;
  if (err?.code !== 'WRONG_MODE' || err.refusal?.condition !== 'operating-mode') { return undefined; }
  return typeof err.message === 'string' ? err.message : undefined;
}
