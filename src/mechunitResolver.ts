// Which mechanical unit a command acts on, without `vscode`, so the unit tests
// can state the rule.
//
// One rule for Teleport Robot, Jog, Set Active Tool, Set Active Work Object
// and the mechanical-unit reads: exactly one unit in the controller's list is
// it; with several, the person picks; with none, the list is unknown (not read
// yet, or the read failed: the client leaves it empty on a failed read) and
// the person types the unit's name. There is no default name: ROB_1 is a
// convention, not a fact about this controller, and nothing here fills it in.

/** The slice of RobotState the rule reads. */
export interface MechunitState {
  mechunits: readonly string[];
}

export type MechunitAnswer =
  | { kind: 'unit'; unit: string }
  /** The person picks from every unit the controller lists. */
  | { kind: 'ask'; candidates: string[] }
  /** No list: the person names the unit, or nothing is sent. */
  | { kind: 'unknown'; reason: string };

export const MECHUNITS_UNKNOWN = 'the controller\'s list of mechanical units is unknown (not read yet, or the read failed)';

/** The rule above, with no prompt: the unit, a question for the person, or an unknown list. */
export function decideMechunit(state: MechunitState): MechunitAnswer {
  const units = state.mechunits.filter(u => u.trim() !== '');
  if (units.length === 1) { return { kind: 'unit', unit: units[0] }; }
  if (units.length > 1) { return { kind: 'ask', candidates: units }; }
  return { kind: 'unknown', reason: MECHUNITS_UNKNOWN };
}

/**
 * A typed unit name: a RAPID name (a letter, then letters, digits or
 * underscores), as the client's `jogUnitName` requires for a jog and as the
 * controller names its units. The reason it is not one, or undefined.
 */
export function unitNameProblem(typed: string): string | undefined {
  const name = typed.trim();
  if (name === '') { return 'Type the unit\'s name as the controller shows it, or press Escape to send nothing.'; }
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? undefined : 'A unit name is a letter followed by letters, digits or underscores.';
}

/** The window the resolver talks through (`vscode.window` in the extension). */
export interface MechunitUi {
  /** A quick pick; the unit picked, or undefined when dismissed. */
  pick(items: string[], title: string, placeHolder: string): PromiseLike<string | undefined>;
  /** An input box with no preset value; the text typed, or undefined when dismissed. `validate` answers the problem with the text so far. */
  input(title: string, prompt: string, validate: (typed: string) => string | undefined): PromiseLike<string | undefined>;
}

/**
 * The mechanical unit for a command on one robot: decided by the rule, picked
 * by the person when the controller lists several, or typed by the person
 * when the list is unknown. Undefined when the person dismissed the pick or
 * the box. `purpose` is the command as the person knows it ("Set Active
 * Tool"); `robot` names the robot as the dialogs do.
 */
export async function resolveMechunit(ui: MechunitUi, robot: string, state: MechunitState, purpose: string): Promise<string | undefined> {
  const a = decideMechunit(state);
  if (a.kind === 'unit') { return a.unit; }
  if (a.kind === 'ask') {
    return await ui.pick(a.candidates, `${purpose} on ${robot}`, `Which mechanical unit of ${robot}? (it lists ${a.candidates.length})`);
  }
  const typed = await ui.input(
    `${purpose} on ${robot}`,
    `Which mechanical unit? For ${robot}, ${a.reason}. Type the unit's name as the FlexPendant shows it; the confirmation names it, and the controller refuses a name it does not have. Escape sends nothing.`,
    unitNameProblem,
  );
  if (typed === undefined) { return undefined; }
  return unitNameProblem(typed) === undefined ? typed.trim() : undefined;
}
