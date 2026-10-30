// What the jog settings and dialogs say, no `vscode`. Taken from the client's
// own documentation of `jog` (README and the JogParams docblock): the six axis
// values are sent as ABB's `axis1`..`axis6`, which ABB documents without a
// unit (its sample sends `axis1=900` with `inc-mode=Large`). They are not
// degrees or millimetres. The sign sets the direction of one jog step; zero
// leaves an axis still; what the magnitude does is not documented. One call is
// one step (RW 8.2.1: axis 5 set to 1 with the default Small increment moved it
// about 0.01 degree). `speed` and `mode` are not sent: ABB's jog form has no
// speed field and no mode field, and the controller jogs in the jog mode of the
// unit selected for jogging. The unit is sent: the extension names it
// (src/mechunitResolver.ts), and the client selects it for jogging first when
// the controller has another one selected (or none); that selection stays, on
// the FlexPendant too.

export const JOG_AXIS_VALUE_SETTING =
  'The axis value each Jog click sends (ABB\'s axis1..axis6). ABB documents it without a unit, so it is not degrees or '
  + 'millimetres: the button sets the sign, which is the direction, and one click is one jog step. The extension sends the '
  + 'smallest increment size (Small); on RobotWare 8.2.1 a value of 1 moved axis 5 about 0.01 degree. What a larger value does is not documented.';

export const JOG_SPEED_SETTING =
  'Not sent: ABB\'s jog form has no speed field. Kept for compatibility; it changes nothing on the controller.';

export const JOG_MODE_SETTING =
  'Not sent: ABB\'s jog form has no mode field; the controller jogs in the jog mode of the unit selected for jogging. '
  + 'This only chooses the axis labels in the Motion view (J1-J6, or X, Y, Z, Rx, Ry, Rz).';

export const JOG_AXIS_VALUE_TOOLTIP = 'The axis value sent with each jog click: no unit (ABB documents none), the button sets the direction';

/** The Jog block's rows: one click is one step; there is no stop button, because there is no jog in progress to stop. */
export const JOG_STEP_TOOLTIP = 'Each click sends one jog step. Stop robot motion at the FlexPendant or with the emergency stop.';

/**
 * What the first-jog confirmation lists: the unit the jog is sent to, the
 * step, what the Joint or Cartesian setting is and is not, and when the
 * question comes back. `labels` is the Motion view's axis-label setting.
 */
export function jogConfirmEffects(axisValue: number, unit: string, labels: string): string[] {
  return [
    `Jogs ${unit}: one jog step per click, axis value ${axisValue} (no unit; ABB documents none) in the direction of the button, with the smallest increment size.`,
    `If ${unit} is not the unit the controller has selected for jogging, it is selected first, and it stays selected on the FlexPendant too. The controller jogs it in the jog mode set for it there. The ${labels} setting of the Motion view only chooses the axis labels you click; it is not sent.`,
    'Keep the workspace clear. The jog is sent in any mode; the controller decides whether the mode, the motors and its other conditions allow it, and its refusal is shown as it answers.',
    'Asked once per connection to this robot, and again when the axis value is raised, the unit changes or the axis labels change.',
  ];
}

/** The status line of the Jog block in the Motion view. */
export function jogStatusText(mode: string, axisValue: number): string {
  return `${mode} labels · axis value ${axisValue} · one step per click`;
}
