import * as vscode from 'vscode';
import type { RobotManager } from './RobotManager';

class Item extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, command?: vscode.Command, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (command) this.command = command;
    if (tooltip) this.tooltip = tooltip;
  }
}

export class RapidTreeProvider implements vscode.TreeDataProvider<Item> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: Item) { return el; }

  getChildren(): Item[] {
    const { connected, execstate, ctrlstate, tasks } = this.manager.state;
    if (!connected) return [];

    const isRunning = execstate === 'running';
    const motorOn   = ctrlstate === 'motoron';

    const items: Item[] = [];

    // ── Execution controls ───────────────────────────────────────────────────
    items.push(new Item(
      'PP to Main',
      isRunning ? 'stop first' : 'reset program pointer',
      'debug-restart',
      isRunning ? undefined : { title: 'PP to Main', command: 'abbRobot.ppToMain' },
      'Move the program pointer to the start of main()\nRAPID must be stopped first.',
    ));

    items.push(new Item(
      isRunning ? 'Stop RAPID' : 'Start RAPID',
      isRunning ? 'click to stop' : motorOn ? 'click to start' : 'motors off',
      isRunning ? 'debug-stop' : 'play',
      (isRunning || motorOn) ? {
        title: isRunning ? 'Stop RAPID' : 'Start RAPID',
        command: isRunning ? 'abbRobot.stopRapid' : 'abbRobot.startRapid',
      } : undefined,
      isRunning
        ? 'Stop RAPID execution'
        : motorOn
          ? 'Start RAPID execution from current PP position'
          : 'Enable motors on FlexPendant before starting',
    ));

    // ── Tasks ────────────────────────────────────────────────────────────────
    if (tasks.length > 0) {
      items.push(new Item('', '', 'blank'));
      items.push(new Item('Tasks', '', 'symbol-event'));
      for (const t of tasks) {
        items.push(new Item(
          t.name,
          `${t.excstate === 'running' ? '▶' : '◼'}  ${t.type}${t.motiontask ? '  · motion' : ''}`,
          t.excstate === 'running' ? 'circle-filled' : 'circle-outline',
          undefined,
          `Task: ${t.name}\nType: ${t.type}\nState: ${t.excstate}\nMotion task: ${t.motiontask}`,
        ));
      }
    }

    return items;
  }
}
