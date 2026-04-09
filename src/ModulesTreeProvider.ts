import * as vscode from 'vscode';
import type { RobotManager } from './RobotManager';

class Item extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, command?: vscode.Command, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (command) this.command = command;
    if (tooltip) this.tooltip = tooltip;
  }
}

export class ModulesTreeProvider implements vscode.TreeDataProvider<Item> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: Item) { return el; }

  getChildren(): Item[] {
    const { connected, modules, execstate, ctrlstate, opmode } = this.manager.state;

    if (!connected) return [
      new Item('Not connected', 'click Connect first', 'circle-slash'),
    ];

    const isRunning = execstate === 'running';
    const motorOn   = ctrlstate === 'motoron';
    const isAuto    = opmode === 'AUTO';
    const items: Item[] = [];

    // ── Status bar ────────────────────────────────────────────────────────
    const statusIcon = isRunning ? 'circle-filled' : motorOn ? 'check' : 'warning';
    const statusText = isRunning
      ? 'RUNNING'
      : motorOn ? (isAuto ? 'Ready' : `Mode: ${opmode}`) : 'Motors OFF';
    items.push(new Item(
      statusText,
      isRunning ? 'program is running' : motorOn ? opmode ?? '' : 'enable on FlexPendant',
      statusIcon,
      undefined,
      `Controller: ${ctrlstate}  |  Mode: ${opmode}  |  RAPID: ${execstate}`,
    ));

    if (!motorOn) {
      items.push(new Item(
        'Enable Motors on FlexPendant first',
        '',
        'warning',
        undefined,
        'Press the Motors On button on the FlexPendant or enable in the Production Window',
      ));
    }

    items.push(new Item('', '', 'blank'));

    // ── Load Program ──────────────────────────────────────────────────────
    if (!isRunning) {
      items.push(new Item(
        'Load Program…',
        'pick .mod file — unloads old, loads new, PP to Main',
        'cloud-upload',
        { title: 'Load Program', command: 'abbRobot.uploadModule' },
        'Select a .mod file from your computer.\n' +
        'This will:\n' +
        '  1. Unload the current program\n' +
        '  2. Upload your file to the robot\n' +
        '  3. Load it\n' +
        '  4. Move PP to Main automatically',
      ));
    } else {
      items.push(new Item(
        'Load Program…',
        'stop the program first',
        'cloud-upload',
        undefined,
        'Stop the running program before loading a new one',
      ));
    }

    // ── Start / Stop ──────────────────────────────────────────────────────
    if (isRunning) {
      items.push(new Item(
        'Stop Program',
        '',
        'debug-stop',
        { title: 'Stop Program', command: 'abbRobot.stopRapid' },
      ));
    } else {
      const canStart = motorOn && isAuto;
      items.push(new Item(
        'Start Program',
        canStart ? 'runs from current PP position' : 'need motors ON + AUTO mode',
        'play',
        canStart ? { title: 'Start Program', command: 'abbRobot.startRapid' } : undefined,
        canStart
          ? 'Start RAPID execution'
          : 'Enable motors on FlexPendant and switch to AUTO mode first',
      ));
    }

    items.push(new Item('', '', 'blank'));

    // ── Loaded modules ────────────────────────────────────────────────────
    const systemNames = ['user', 'BASE', 'DPUSER', 'DPBASE'];
    const programModules = modules.filter(m => !systemNames.includes(m));

    if (programModules.length > 0) {
      items.push(new Item('── Program ──', '', 'list-flat'));
      for (const mod of programModules) {
        items.push(new Item(
          mod,
          'click to download',
          'file-code',
          {
            title: 'Download Module',
            command: 'abbRobot.downloadModule',
            arguments: [mod],
          },
          `Click to download ${mod}.mod to your computer`,
        ));
      }
    } else if (modules.length > 0) {
      items.push(new Item('No program loaded', 'click Load Program above', 'info'));
    } else {
      items.push(new Item('No modules', 'click Load Program above', 'info'));
    }

    return items;
  }
}
