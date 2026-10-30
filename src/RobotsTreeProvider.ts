import * as vscode from 'vscode';
import type { MultiRobotManager, RobotConfig, RobotManager } from 'abb-rws-client';
import { motionReading, robotsViewMotion } from './motionControl';

class RobotItem extends vscode.TreeItem {
  constructor(
    public readonly id: string,
    public readonly config: RobotConfig,
    manager: RobotManager,
    isActive: boolean,
    allowedHere: boolean,
    /** The robot's mode (src/watchMode.ts), while connected. */
    mode: { description: string; tooltip: string } | undefined,
  ) {
    super(config.name, vscode.TreeItemCollapsibleState.None);

    const s = manager.state;
    const connected = s.connected;
    const rw = s.systemInfo?.rwVersion ?? '';
    const rwMajor = rw ? `RW${rw.split('.')[0]}` : '';

    if (connected) {
      const motor = s.ctrlstate === 'motoron' ? '⚡' : '○';
      // RobotWare 8: motion control allowed, or not known after RAPID Live allowed it; nothing on 6 or 7.
      const motion = robotsViewMotion(motionReading(s), allowedHere);
      this.description = [rwMajor, s.opmode, `RAPID: ${s.execstate}`, mode?.description, motion.description].filter(Boolean).join('  ');
      this.tooltip     = new vscode.MarkdownString(
        `**${config.name}** ${motor}\n\n` +
        `Host: \`${config.host}\`\n\nRobotWare: ${rw}\n\n` +
        `Controller: ${s.ctrlstate}  |  Mode: ${s.opmode}  |  RAPID: ${s.execstate}` +
        (mode ? `\n\n${mode.tooltip}` : '') +
        (motion.tooltip ? `\n\n${motion.tooltip}` : '')
      );
      this.iconPath    = new vscode.ThemeIcon(
        isActive ? 'circle-filled' : 'plug',
        isActive ? new vscode.ThemeColor('charts.green') : undefined
      );
      // `.motion`: its motion control may stand, so the row offers Withdraw Motion Control.
      this.contextValue = (isActive ? 'robot.connected.active' : 'robot.connected') + (motion.withdraw ? '.motion' : '');
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

  /** `allowedHere`: whether RAPID Live allowed RobotWare 8 motion control on the robot during its connection. */
  constructor(
    private readonly multi: MultiRobotManager,
    private readonly allowedHere: (id: string) => boolean = () => false,
    private readonly modeOf: (id: string) => { description: string; tooltip: string } | undefined = () => undefined,
  ) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: RobotsTreeItem) { return el; }

  getChildren(): RobotsTreeItem[] {
    const items: RobotsTreeItem[] = this.multi.entries.map(({ id, config, manager }) =>
      new RobotItem(id, config, manager, id === this.multi.activeId, this.allowedHere(id), this.modeOf(id))
    );
    items.push(new AddRobotItem());
    return items;
  }
}
