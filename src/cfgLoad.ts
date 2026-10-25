// Load .cfg File: what each load action is said to do, and the next step after a
// refused load. No `vscode`.
//
// A load with the action "add" of a file the same controller had just saved was
// refused on 6.16.03, 7.21.4 and 8.2.1 (AUTO, 2026-10-12) with -1073437689
// `SYS_CTRL_E_CFG_NAME_EXIST` ("Name already exists in database (for named
// instances)"); on 6.16.03 the saved EIO domain got -1073437688
// `SYS_CTRL_E_CFG_DATA_INCORRECT` ("Cfg file contains errors.") instead. The
// vendored client explains both as a refusal of what was sent (`invalid-argument`)
// on every generation, so the error shows the client's sentence first. The client
// keeps its next step apart (`refusal.remedy`, a fix to the input), and no button
// stands for it, so the command shows it after the sentence. RAPID Live's own
// sentence for the two codes (`cfgFallbackMessage`) is kept only for an error that
// carries one of them with no refusal from the client; with the bundled client
// that does not happen.
//
// A third code takes the same path: -1073437686 `SYS_CTRL_E_CFG_VERSION` ("Wrong
// layout of version string"), which the 6.16.03, 7.21.4 and 8.2.1 virtual
// controllers answered to the validation of a file with no version header
// (2026-10-24; a load of such a file has not been tried). The bundled
// client (1.5.1) explains it as a refusal of the file with a fix to the input, so
// the command shows its sentence and next step like the two above. RAPID Live has
// no sentence of its own for it: `cfgFallbackMessage` knows the two codes only.

/** The label of Load .cfg File's confirmation and error. */
export const CFG_LOAD_LABEL = 'Load CFG file';

/** ABB's return codes (RWS 1.0 Rev M; the RWS 2.0 Retcode service) for the two refusals above. */
const CFG_NAME_EXIST = -1073437689;
const CFG_DATA_INCORRECT = -1073437688;

/** The one-line description each load action has in the pick list. */
export function loadActionDetail(action: 'add' | 'replace' | 'add-with-reset'): string {
  switch (action) {
    case 'add': return 'Adds the file\'s instances; the controller refuses the load when a named instance in the file already exists';
    case 'replace': return 'The file replaces the matching domain entirely';
    case 'add-with-reset': return 'Resets the domain first, then adds from the file';
  }
}

/**
 * The client's next step for a load it refused as wrong input: the detail of its
 * first remedy when that is a fix to the input with no call. Undefined for any
 * other error, which keeps its own message and buttons.
 */
export function cfgLoadNextStep(e: unknown): string | undefined {
  const first = (e as { refusal?: { remedy?: { kind?: unknown; call?: unknown; detail?: unknown } } } | null | undefined)?.refusal?.remedy;
  if (!first || first.kind !== 'fix-input' || first.call !== undefined) { return undefined; }
  return typeof first.detail === 'string' && first.detail !== '' ? first.detail : undefined;
}

/**
 * Which of the two configuration codes an error carries: its controller code, or
 * the code or ABB's name in its message (RobotWare 6 writes `code:-1073437689`
 * inside a wrapper with other codes).
 */
function cfgCodeOf(e: unknown): typeof CFG_NAME_EXIST | typeof CFG_DATA_INCORRECT | undefined {
  const code = (e as { controllerCode?: unknown } | null | undefined)?.controllerCode;
  if (code === CFG_NAME_EXIST || code === CFG_DATA_INCORRECT) { return code; }
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (/(?<!\d)-1073437689(?!\d)|CFG_NAME_EXIST/.test(raw)) { return CFG_NAME_EXIST; }
  if (/(?<!\d)-1073437688(?!\d)|CFG_DATA_INCORRECT/.test(raw)) { return CFG_DATA_INCORRECT; }
  return undefined;
}

/**
 * RAPID Live's own sentence for an error that carries one of the two
 * configuration codes and no refusal from the client. Undefined when the client
 * explained the error (its sentence is shown instead) and for any other error.
 * `label` is the operation's; for Load .cfg File (`CFG_LOAD_LABEL`) the sentence
 * is about the file.
 */
export function cfgFallbackMessage(label: string, e: unknown): string | undefined {
  if ((e as { refusal?: unknown } | null | undefined)?.refusal) { return undefined; }
  const code = cfgCodeOf(e);
  if (code === undefined) { return undefined; }
  const load = label === CFG_LOAD_LABEL;
  if (code === CFG_NAME_EXIST) {
    return load
      ? `${label}: the controller refused to load the file: a named instance in the file already exists on the controller `
        + '("Name already exists in database", SYS_CTRL_E_CFG_NAME_EXIST). It does not say which one. A file saved from this '
        + 'controller holds every instance of its domain, so it cannot be loaded back with "add". Load a file that holds only '
        + 'instances the controller does not have yet, or remove the existing instance first.'
      : `${label}: the controller refused it: an instance of that name already exists ("Name already exists in database", `
        + 'SYS_CTRL_E_CFG_NAME_EXIST). Use a name no instance of that type has, or change the existing instance instead.';
  }
  return load
    ? `${label}: the controller refused to load the file: it says the file contains errors ("Cfg file contains errors", `
      + 'SYS_CTRL_E_CFG_DATA_INCORRECT), and does not say which line. Check the file. If it is a domain saved from this '
      + 'controller, load a file that holds only instances the controller does not have yet.'
    : `${label}: the controller refused it: it says the configuration data contains errors ("Cfg file contains errors", `
      + 'SYS_CTRL_E_CFG_DATA_INCORRECT). Check the data sent.';
}
