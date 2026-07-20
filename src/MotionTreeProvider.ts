import * as vscode from 'vscode';
import type { RobotManager } from 'abb-rws-client';

class Item extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) this.tooltip = tooltip;
  }
}

/** Clickable action - fires a VS Code command when the user activates the row. */
class ActionItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, command: string, tooltip: string, args: unknown[] = []) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip;
    this.command = { command, title: label, arguments: args };
  }
}

export class MotionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: vscode.TreeItem) { return el; }

  getChildren(): vscode.TreeItem[] {
    const { joints, cartesian, connected } = this.manager.state;
    if (!connected) return [];

    const deg = (n: number | null | undefined) =>
      n != null ? `${n.toFixed(3)}°` : '-';
    const mm = (n: number | null | undefined) =>
      n != null ? `${n.toFixed(2)} mm` : '-';
    const q = (n: number | null | undefined) =>
      n != null ? n.toFixed(6) : '-';

    const items: vscode.TreeItem[] = [];

    // ── Joint positions ─────────────────────────────────────────────────────
    items.push(new Item('Joint Positions', '', 'symbol-ruler'));

    if (joints) {
      const axes = [
        ['J1', joints.rax_1],
        ['J2', joints.rax_2],
        ['J3', joints.rax_3],
        ['J4', joints.rax_4],
        ['J5', joints.rax_5],
        ['J6', joints.rax_6],
      ] as [string, number][];

      for (const [label, val] of axes) {
        items.push(new Item(label, deg(val), 'symbol-numeric', `${label} = ${deg(val)}`));
      }
    } else {
      items.push(new Item('No data', '', 'info'));
    }

    // ── Cartesian position ───────────────────────────────────────────────────
    items.push(new Item('', '', 'blank'));
    items.push(new Item('TCP Position', '', 'move'));

    if (cartesian) {
      items.push(
        new Item('X', mm(cartesian.x),  'symbol-numeric', `X = ${mm(cartesian.x)}`),
        new Item('Y', mm(cartesian.y),  'symbol-numeric', `Y = ${mm(cartesian.y)}`),
        new Item('Z', mm(cartesian.z),  'symbol-numeric', `Z = ${mm(cartesian.z)}`),
      );
      items.push(new Item('', '', 'blank'));
      items.push(new Item('Orientation (quaternion)', '', 'symbol-numeric'));
      items.push(
        new Item('Q1', q(cartesian.q1), 'symbol-numeric'),
        new Item('Q2', q(cartesian.q2), 'symbol-numeric'),
        new Item('Q3', q(cartesian.q3), 'symbol-numeric'),
        new Item('Q4', q(cartesian.q4), 'symbol-numeric'),
      );
    } else {
      items.push(new Item('No data', '', 'info'));
    }

    // ── Jog ──────────────────────────────────────────────────────────────────
    items.push(new Item('', '', 'blank'));

    const cfg = vscode.workspace.getConfiguration('abbRobot');
    const inc   = cfg.get<number>('jog.increment', 1);
    const speed = cfg.get<number>('jog.speed', 10);
    const mode  = cfg.get<string>('jog.mode', 'Joint');

    const opmode = this.manager.state.opmode;
    const ctrl   = this.manager.state.ctrlstate;
    const jogReady = opmode !== 'AUTO' && ctrl === 'motoron';
    const jogStatus = !jogReady
      ? (opmode === 'AUTO' ? '⚠ AUTO mode - switch to MANR' : '⚠ motors off')
      : `${mode} · ${inc}${mode === 'Joint' ? '°' : ' mm'} · speed ${speed}%`;

    items.push(new Item('Jog Robot', jogStatus, 'arrow-swap', `Jog ready: ${jogReady}`));
    items.push(new ActionItem('  Set increment…',  `${inc}${mode === 'Joint' ? '°' : ' mm'}`, 'gear', 'abbRobot.setJogIncrement', 'Change the per-click jog distance'));
    items.push(new ActionItem('  Set speed…',      `${speed}%`,      'gear',   'abbRobot.setJogSpeed',     'Change the jog speed (0-100%)'));
    items.push(new ActionItem('  Set mode…',       mode,             'gear',   'abbRobot.setJogMode',      'Switch between Joint and Cartesian jog'));

    if (jogReady) {
      const labels = mode === 'Joint'
        ? ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']
        : ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'];
      for (let i = 0; i < 6; i++) {
        items.push(new ActionItem(`  ⬆ ${labels[i]} +${inc}`, '', 'arrow-up',   'abbRobot.jog', '', [i, +1]));
        items.push(new ActionItem(`  ⬇ ${labels[i]} −${inc}`, '', 'arrow-down', 'abbRobot.jog', '', [i, -1]));
      }
      items.push(new ActionItem('  ⏹ Stop Jog', 'sends axes=[0,0,0,0,0,0]', 'debug-stop', 'abbRobot.jogStop', 'Send a zero-jog command to halt any in-progress motion.'));
    }

    // ── Frames & Tools ───────────────────────────────────────────────────────
    items.push(new Item('', '', 'blank'));
    items.push(new Item('Frames & Tools', '', 'tools'));
    items.push(new ActionItem(
      '  Active Tool / WObj / Payload',
      'Click to view',
      'symbol-property',
      'abbRobot.showActiveToolWobj',
      'Currently active tool, work object and payload',
    ));
    items.push(new ActionItem(
      '  Mechunit Details',
      'base frame, axes, status',
      'circuit-board',
      'abbRobot.showMechunitDetails',
      'Show the mechanical unit\'s base frame transform, axis configuration, and detailed status',
    ));
    items.push(new ActionItem(
      '  Motion Info (errors, modes)',
      'change-count, error state, dry-run, collision pred',
      'symbol-event',
      'abbRobot.showMotionInfo',
      'Show motion change-count, error state, non-motion mode, collision-prediction mode',
    ));

    // ── Actions ──────────────────────────────────────────────────────────────
    items.push(new Item('', '', 'blank'));
    items.push(new Item('Actions', '', 'tools'));
    items.push(new ActionItem(
      'Calculate Inverse Kinematics…',
      'X,Y,Z,Q → J1-J6',
      'symbol-numeric',
      'abbRobot.calcIK',
      'Compute joint angles for a target Cartesian pose. Pre-fills with current TCP position.',
    ));
    items.push(new ActionItem(
      'Show Program Pointer / Motion Pointer',
      'PP and MP location',
      'debug-stackframe',
      'abbRobot.showProgramPointer',
      'Show the current program pointer (PP) and motion pointer (MP) location for the active task',
    ));

    return items;
  }
}
