import * as vscode from 'vscode';
import type { MultiRobotManager, RobotConfig, RobotManager } from 'abb-rws-client';

class RobotItem extends vscode.TreeItem {
  constructor(
    public readonly id: string,
    public readonly config: RobotConfig,
    manager: RobotManager,
    isActive: boolean,
  ) {
    super(config.name, vscode.TreeItemCollapsibleState.None);

    const s = manager.state;
    const connected = s.connected;
    const rw = s.systemInfo?.rwVersion ?? '';
    const rwMajor = rw ? `RW${rw.split('.')[0]}` : '';

    if (connected) {
      const motor = s.ctrlstate === 'motoron' ? '⚡' : '○';
      this.description = [rwMajor, s.opmode, `RAPID: ${s.execstate}`].filter(Boolean).join('  ');
      this.tooltip     = new vscode.MarkdownString(
        `**${config.name}** ${motor}\n\n` +
        `Host: \`${config.host}\`\n\nRobotWare: ${rw}\n\n` +
        `Controller: ${s.ctrlstate}  |  Mode: ${s.opmode}  |  RAPID: ${s.execstate}`
      );
      this.iconPath    = new vscode.ThemeIcon(
        isActive ? 'circle-filled' : 'plug',
        isActive ? new vscode.ThemeColor('charts.green') : undefined
      );
      this.contextValue = isActive ? 'robot.connected.active' : 'robot.connected';
    } else {
      this.description  = 'offline';
      this.tooltip      = `${config.name}\nHost: ${config.host}\nNot connected`;
      this.iconPath     = new vscode.ThemeIcon('circle-outline');
      this.contextValue = isActive ? 'robot.disconnected.active' : 'robot.disconnected';
    }

    // Click to set as active robot
    this.command = {
      title:     'Set Active Robot',
      command:   'abbRobot.setActiveRobot',
      arguments: [id],
    };
  }
}

class AddRobotItem extends vscode.TreeItem {
  constructor() {
    super('Add Robot…', vscode.TreeItemCollapsibleState.None);
    this.iconPath    = new vscode.ThemeIcon('add');
    this.command     = { title: 'Add Robot', command: 'abbRobot.addRobot' };
    this.contextValue = 'robot.add';
  }
}

type RobotsTreeItem = RobotItem | AddRobotItem;

export class RobotsTreeProvider implements vscode.TreeDataProvider<RobotsTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly multi: MultiRobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: RobotsTreeItem) { return el; }

  getChildren(): RobotsTreeItem[] {
    const items: RobotsTreeItem[] = this.multi.entries.map(({ id, config, manager }) =>
      new RobotItem(id, config, manager, id === this.multi.activeId)
    );
    items.push(new AddRobotItem());
    return items;
  }
}
