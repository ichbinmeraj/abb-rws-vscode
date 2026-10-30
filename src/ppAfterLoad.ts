// The program pointer after Push or Load: the parts that need no `vscode`.
//
// Up to 1.4.0 the client moved the program pointer to main after loading a
// file that declares PROC main. That move is the whole execution's
// (`resetRapid` takes no task): on a multi-task system it moves every task the
// execution runs, not only the one the file went to. Push and Load now load
// with `resetPP: false`, and the move is its own ask that names the robot and
// the tasks it moves.

import type { ConfirmRequest } from './confirm';

/** Whether a module's text declares PROC main (the client's own test, `RobotManager.loadProgram`). */
export function declaresMain(text: string): boolean {
  return /\bPROC\s+main\s*\(/i.test(text);
}

/** The confirmation for PP to Main (and Reset RAPID, the same move under its own label), naming the tasks it moves. */
export function ppToMainRequest(tasks: string[], label: string = 'PP to Main'): ConfirmRequest {
  const moves = tasks.length > 1
    ? `Moves the program pointer to main for the whole execution, in every task it runs: ${tasks.join(', ')}.`
    : `Moves the program pointer of ${tasks[0] ?? 'the task'} to main.`;
  return { label, tier: 'disruptive', taskApplies: true, tasks, sideEffects: [moves] };
}

export const PP_TO_MAIN_BUTTON = 'PP to Main…';

/** What the success message and the move talk through. */
export interface AfterLoadUi {
  /** The success message alone. */
  info(message: string): void;
  /** The success message with one button; true when the person chose it. */
  offer(message: string, button: string): PromiseLike<boolean>;
  /**
   * The move, behind its confirmation naming the robot and the tasks
   * (`sendTo(entry, request, () => resetRapid())` in the extension); true when
   * it was sent. Its own errors are reported by the extension.
   */
  moveToMain(request: ConfirmRequest): PromiseLike<boolean>;
}

/**
 * After a successful Push or Load: the success message, and for a file with
 * PROC main the offer to move the program pointer to main. Nothing moves
 * unless the person chooses the offer and then confirms it.
 */
export async function afterLoad(ui: AfterLoadUi, text: string, success: string, tasks: string[]): Promise<'no-main' | 'kept' | 'moved'> {
  if (!declaresMain(text)) { ui.info(success); return 'no-main'; }
  if (!await ui.offer(`${success} The program pointer was not moved.`, PP_TO_MAIN_BUTTON)) { return 'kept'; }
  return await ui.moveToMain(ppToMainRequest(tasks)) ? 'moved' : 'kept';
}
