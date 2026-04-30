import * as vscode from 'vscode';
import type { RobotManager } from './RobotManager';

function getCfg() {
  return vscode.workspace.getConfiguration('abbRobot');
}

class Item extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, command?: vscode.Command, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (command) this.command = command;
    if (tooltip) this.tooltip = tooltip;
  }
}

export class StatusTreeProvider implements vscode.TreeDataProvider<Item> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: Item) { return el; }

  getChildren(): Item[] {
    const s = this.manager.state;

    if (!s.connected) {
      const cfg  = getCfg();
      const host = cfg.get<string>('host', '192.168.125.1');
      const user = cfg.get<string>('username', 'Default User');
      return [
        new Item('Not connected', '', 'circle-slash'),
        new Item('Host',     host, 'remote',  `Will connect to ${host}`),
        new Item('Username', user, 'account', `Logging in as: ${user}`),
        new Item('Configure…', 'change host / credentials', 'settings-gear',
          { title: 'Configure Connection', command: 'abbRobot.configure' },
          'Set host, username and password',
        ),
      ];
    }

    const ctrlIcon = s.ctrlstate === 'motoron'  ? 'pass'          : 'warning';
    const modeIcon = s.opmode   === 'AUTO'       ? 'lock'          : 'unlock';
    const execIcon = s.execstate === 'running'   ? 'circle-filled' : 'circle-outline';

    const ctrlLabel = {
      motoron:             'Motors ON',
      motoroff:            'Motors OFF',
      guardstop:           'Guard Stop',
      emergencystop:       'Emergency Stop',
      emergencystopreset:  'E-Stop Reset',
      sysfail:             'System Failure',
      init:                'Initialising',
    }[s.ctrlstate ?? ''] ?? (s.ctrlstate ?? '—');

    const speedLabel = s.speedRatio !== null ? `${s.speedRatio}%` : '—';
    const rwVersion = s.systemInfo?.rwVersion ?? '—';
    const ctrlName = s.identity?.name ?? s.host;

    const coldetLabel = s.coldetstate !== null
      ? ({ INIT: 'OK', TRIGGERED: 'Triggered!', CONFIRMED: 'Confirmed', TRIGGERED_ACK: 'Acknowledged' }[s.coldetstate] ?? s.coldetstate)
      : null;
    const coldetIcon = s.coldetstate === 'INIT' ? 'shield' : s.coldetstate !== null ? 'warning' : null;

    const items: Item[] = [
      new Item('Host',            ctrlName,        'remote',       undefined,
        `Connected to ${s.host}\nController: ${ctrlName}\nRobotWare: ${rwVersion}`),
      new Item('RobotWare',       rwVersion,       'versions',     undefined, `System: ${s.systemInfo?.sysid ?? '—'}`),
      new Item('Controller',      ctrlLabel,       ctrlIcon,       undefined, `Controller state: ${s.ctrlstate}`),
      new Item('Operation Mode',  s.opmode ?? '—', modeIcon,       undefined, `Mode: ${s.opmode}`),
      new Item('Speed Ratio',     speedLabel,      'dashboard',
        { title: 'Set Speed Ratio', command: 'abbRobot.setSpeedRatio' },
        'Click to change speed ratio (0–100%). Only works in AUTO mode.'),
      new Item('RAPID',           s.execstate === 'running' ? 'Running' : 'Stopped',
                                                   execIcon,       undefined, `Execution state: ${s.execstate}`),
    ];

    if (coldetLabel !== null && coldetIcon !== null) {
      items.push(new Item('Collision Detection', coldetLabel, coldetIcon, undefined,
        `Collision detection state: ${s.coldetstate}`));
    }

    if (s.tasks.length > 0) {
      items.push(new Item('', '', 'blank'));
      for (const t of s.tasks) {
        const taskIcon = t.excstate === 'running' ? 'circle-filled' : 'circle-outline';
        items.push(new Item(
          t.name,
          `${t.type}  ${t.excstate === 'running' ? '▶ running' : '◼ stopped'}`,
          taskIcon,
          undefined,
          `Task: ${t.name}\nType: ${t.type}\nState: ${t.excstate}\nMotion task: ${t.motiontask}`,
        ));
      }
    }

    return items;
  }
}
