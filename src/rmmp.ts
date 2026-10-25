// Request Manual Mode Privileges (RMMP): what a grant covers, and the outcome
// of a request. No `vscode`.
//
// Sources: ABB's RWS 1.0 (Rev M) and RWS 2.0 (Rev L, the RWS site) user and
// RAPID pages. RMMP is the manual-mode counterpart of a
// mastership request; `modify` fits what needs mastership (RAPID data, module
// loads); `exec` is documented for program-pointer-to-routine on RobotWare 7
// only ("RMMP_Exe"); ABB gives Start and PP to Main to a remote client in
// Auto, or to a local client at the FlexPendant. The request is accepted in
// MANR only on RobotWare 7 and has no documented mode rule on RobotWare 6.
//
// Which level fits a refused operation is the client's to say: its remedy
// `request-rmmp` names the level (`remedy.call.level`), and it names none for
// an operation RMMP does not cover (a start, PP to Main, another pointer move).

type Generation = 'rw6' | 'rw7' | 'rw8' | null;
export type RmmpLevelChoice = 'modify' | 'exec';

export const RMMP_NAME = 'Request Manual Mode Privileges (RMMP)';

/** The refused operation a request came from: its `METHOD /path`, and the level the client named for it. */
export interface RmmpRefused {
  request?: string;
  level: RmmpLevelChoice;
}

/** What a granted privilege covers, in place of a blanket "retry". */
export function rmmpGrantedText(name: string, privilege: string, gen: Generation, refused: RmmpRefused | undefined): string {
  const level = privilege === 'exec' ? 'exec' : 'modify';
  const data = 'RAPID data writes, loading and unloading modules, and the other changes that need mastership in manual mode';
  let text: string;
  if (level === 'exec') {
    text = gen === 'rw7'
      ? `RMMP granted on ${name} (exec). Besides ${data}, on RobotWare 7 it covers moving the program pointer to a routine (ABB: RMMP_Exe). `
        + 'PP to Main and Start stay with Auto or the FlexPendant.'
      : `RMMP granted on ${name} (exec). ABB does not say what exec covers on RobotWare 6; the controller granted it. It covers at least ${data}. `
        + 'PP to Main and Start stay with Auto or the FlexPendant.';
  } else {
    text = `RMMP granted on ${name} (modify). It covers ${data}. `
      + 'It does not cover moving the program pointer, PP to Main or Start: do those in Auto or at the FlexPendant.';
  }
  if (refused) {
    // The grant covers the refused operation when it is at least the level the client named for it.
    if (refused.level === level || (refused.level === 'modify' && level === 'exec')) {
      text += /\/pcp\//.test(refused.request ?? '') ? ' Try the refused pointer move again.' : ' Try the refused write again.';
    }
  }
  return text;
}

/**
 * The warning after a request the operator denied or that expired: the
 * client's sentence, then its next step (a denial: speak to the operator
 * first; this tool never asks again on its own).
 */
export function rmmpOutcomeText(refusal: { sentence?: string; remedy?: { detail?: string } } | undefined, detail: string): string {
  const sentence = refusal?.sentence ?? detail;
  const step = refusal?.remedy?.detail;
  return step && !sentence.includes(step) ? `${sentence} ${step}` : sentence;
}
