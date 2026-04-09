import * as vscode from 'vscode';
import type { RobotManager } from './RobotManager';

class Item extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) this.tooltip = tooltip;
  }
}

export class MotionTreeProvider implements vscode.TreeDataProvider<Item> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: Item) { return el; }

  getChildren(): Item[] {
    const { joints, cartesian, connected } = this.manager.state;
    if (!connected) return [];

    const deg = (n: number | null | undefined) =>
      n != null ? `${n.toFixed(3)}°` : '—';
    const mm = (n: number | null | undefined) =>
      n != null ? `${n.toFixed(2)} mm` : '—';
    const q = (n: number | null | undefined) =>
      n != null ? n.toFixed(6) : '—';

    const items: Item[] = [];

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

    return items;
  }
}
