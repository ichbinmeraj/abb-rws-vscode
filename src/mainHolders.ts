// Which loaded modules of one task declare PROC main(), without `vscode`, so
// the unit tests can state the rule.
//
// The controller refuses a pointer move (Set PP, Run routine) with a semantic
// error while two loaded modules of the task declare main. The dialog names the
// other holders before the move, and the recovery unloads only one of them. The
// list is the named task's own: the client polls every active task's modules
// (`state.modulesByTask`), and a task it has no list for is read once. The
// primary task's list is never read for another task.

export interface MainHolderRobot {
  state: { modulesByTask: Readonly<Record<string, readonly string[]>> };
  listModulesDetailed(task: string): Promise<Array<{ name: string }>>;
  listRoutines(task: string, module: string): Promise<Array<{ name: string }>>;
}

/** The modules RobotWare loads into every task; none of them is a program module of the person's. */
const SYSTEM_MODULES = new Set(['BASE', 'user', 'DPUSER', 'DPBASE']);

/**
 * The task's loaded modules: the polled list of that task (its name compared
 * without case, as RAPID compares names), else one read of that task's list.
 * Empty when the read fails.
 */
export async function modulesOfTask(robot: MainHolderRobot, taskName: string): Promise<string[]> {
  const byTask = robot.state.modulesByTask;
  const key = Object.keys(byTask).find(k => k.toLowerCase() === taskName.toLowerCase());
  if (key !== undefined) { return [...byTask[key]]; }
  try { return (await robot.listModulesDetailed(taskName)).map(m => m.name); }
  catch { return []; }
}

/** The loaded program modules of the task that declare `main` (reads only). A module whose routines cannot be read is skipped. */
export async function modulesWithMain(robot: MainHolderRobot, taskName: string): Promise<string[]> {
  const withMain: string[] = [];
  for (const m of (await modulesOfTask(robot, taskName)).filter(x => !SYSTEM_MODULES.has(x))) {
    try {
      const routines = await robot.listRoutines(taskName, m);
      if (routines.some(r => r.name.toLowerCase() === 'main')) { withMain.push(m); }
    } catch { /* skip: the module may be in a state that cannot be queried */ }
  }
  return withMain;
}
