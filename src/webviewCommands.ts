// The commands the Program view's page may run, without `vscode`, so the unit
// tests can state the list.
//
// The page posts `{ type: 'command', name, args }` through one function,
// `cmd(name, ...args)`, and the provider dispatches it through VS Code's
// command system. Only the ids below are dispatched, with arguments of the
// shapes below; anything else is refused and logged. Every write among them
// still goes through the send wrappers, because the handler it reaches is the
// same registered command.

/** The ids the page's `cmd('…')` calls name (test/webviewCommands.test.ts parses them from the page). */
export const WEBVIEW_COMMANDS: readonly string[] = [
  // Writes, through the guard.
  'abbRobot.uploadModule', 'abbRobot.ppToMain', 'abbRobot.setOpMode', 'abbRobot.setSpeedRatio',
  'abbRobot.motorsOn', 'abbRobot.motorsOff', 'abbRobot.startRapid', 'abbRobot.stopRapid',
  'abbRobot.createRapidTask', 'abbRobot.activateTask', 'abbRobot.deactivateTask',
  'abbRobot.setPPToRoutine', 'abbRobot.unloadModule', 'abbRobot.runRoutineFromCodeLens', 'abbRobot.setPPFromCodeLens',
  'abbRobot.writeWatchValue',
  // Reads and local state.
  'abbRobot.addWatch', 'abbRobot.refreshWatches', 'abbRobot.clearWatches', 'abbRobot.removeWatch',
  'abbRobot.openModuleSource', 'abbRobot.viewModuleText',
];

const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * The watch row the page hands back for Edit and Remove: `{ entry: { task,
 * module, symbol, … } }`, the row as the page received it, with scalar fields
 * only (the handler reads task, module, symbol, value and robotId from it).
 */
function isWatchRowArg(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { return false; }
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== 'entry') { return false; }
  const entry = (v as { entry: unknown }).entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return false; }
  const e = entry as Record<string, unknown>;
  if (typeof e.task !== 'string' || typeof e.module !== 'string' || typeof e.symbol !== 'string') { return false; }
  return Object.values(e).every(x => x === undefined || x === null || isScalar(x));
}

/**
 * Whether the page may run this command with these arguments: a listed id,
 * and at most five scalar arguments (a module, a routine, its kind, no file,
 * a task), except the two watch-row commands, which take the one row object.
 */
export function isWebviewCommand(name: unknown, args: unknown): name is string {
  if (typeof name !== 'string' || !WEBVIEW_COMMANDS.includes(name)) { return false; }
  const list = args === undefined ? [] : args;
  if (!Array.isArray(list)) { return false; }
  if (name === 'abbRobot.writeWatchValue' || name === 'abbRobot.removeWatch') {
    return list.length === 1 && isWatchRowArg(list[0]);
  }
  return list.length <= 5 && list.every(isScalar);
}
