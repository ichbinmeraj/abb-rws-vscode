import * as vscode from 'vscode';
import type { RobotManager } from 'abb-rws-client';

function getCfg() {
  return vscode.workspace.getConfiguration('abbRobot');
}

class Item extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, command?: vscode.Command, tooltip?: string, color?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = color
      ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color))
      : new vscode.ThemeIcon(icon);
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
      const user = cfg.get<string>('username', 'Admin');
      return [
        new Item('Not connected', '', 'circle-slash'),
        new Item('Host',     host, 'remote',  undefined, `Will connect to ${host}`),
        new Item('Username', user, 'account', undefined, `Logging in as: ${user}`),
        new Item('Configure…', 'change host / credentials', 'settings-gear',
          { title: 'Configure Connection', command: 'abbRobot.configure' },
          'Set host, username and password',
        ),
      ];
    }

    const ctrlIcon = s.ctrlstate === 'motoron'  ? 'pass'          : 'warning';
    const modeIcon = s.opmode   === 'AUTO'       ? 'lock'          : 'unlock';
    const execIcon = s.execstate === 'running'   ? 'circle-filled' : 'circle-outline';

    // State-driven colors — VS Code's `charts.*` and `errorForeground` tokens
    // resolve to good values on every theme (light, dark, high contrast).
    const ctrlColor = s.ctrlstate === 'motoron'                                    ? 'charts.green'
                    : s.ctrlstate === 'guardstop' || s.ctrlstate === 'emergencystop' ? 'errorForeground'
                    : 'charts.orange';
    const modeColor = s.opmode === 'AUTO' ? 'charts.blue' : 'charts.orange';
    const execColor = s.execstate === 'running' ? 'charts.green' : 'descriptionForeground';
    const speedColor = s.speedRatio !== null && s.speedRatio < 30 ? 'charts.orange' : undefined;

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
    // Prefer systemInfo.name (RAPID system name, consistent across RWS versions)
    // over identity.name — RWS 1.0 reports the PC hostname there, not the robot.
    const ctrlName = s.systemInfo?.name || s.identity?.name || s.host;

    const coldetLabel = s.coldetstate !== null
      ? ({ INIT: 'OK', TRIGGERED: 'Triggered!', CONFIRMED: 'Confirmed', TRIGGERED_ACK: 'Acknowledged' }[s.coldetstate] ?? s.coldetstate)
      : null;
    const coldetIcon = s.coldetstate === 'INIT' ? 'shield' : s.coldetstate !== null ? 'warning' : null;

    const items: Item[] = [
      new Item('Host',            ctrlName,        'remote',       undefined,
        `Connected to ${s.host}\nController: ${ctrlName}\nRobotWare: ${rwVersion}`),
      new Item('RobotWare',       rwVersion,       'versions',     undefined, `System: ${s.systemInfo?.sysid ?? '—'}`),
      new Item('Controller',      ctrlLabel,       ctrlIcon,       undefined, `Controller state: ${s.ctrlstate}`, ctrlColor),
      new Item('Operation Mode',  s.opmode ?? '—', modeIcon,
        { title: 'Switch Operation Mode', command: 'abbRobot.setOpMode' },
        `Mode: ${s.opmode}\n\nClick to switch (VC only — real hardware uses the FlexPendant key switch).`,
        modeColor),
      new Item('Speed Ratio',     speedLabel,      'dashboard',
        { title: 'Set Speed Ratio', command: 'abbRobot.setSpeedRatio' },
        'Click to change speed ratio (0–100%). Only works in AUTO mode.',
        speedColor),
      new Item('RAPID',           s.execstate === 'running' ? 'Running' : 'Stopped',
                                                   execIcon,       undefined, `Execution state: ${s.execstate}`, execColor),
    ];

    if (coldetLabel !== null && coldetIcon !== null) {
      const coldetColor = s.coldetstate === 'INIT' ? 'charts.green' : 'errorForeground';
      items.push(new Item('Collision Detection', coldetLabel, coldetIcon, undefined,
        `Collision detection state: ${s.coldetstate}`, coldetColor));
    }

    // Detail row clickable for full system info (license / products / energy / etc.)
    items.push(new Item('System Info…', 'license, products, energy', 'info',
      { title: 'Show System Details', command: 'abbRobot.showSystemDetails' },
      'Click to view license, installed products, energy stats',
    ));

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
