import * as vscode from 'vscode';
import type { RobotManager } from 'abb-rws-client';
import type { Signal } from 'abb-rws-client';

const TYPE_LABEL: Record<string, string> = {
  DI: 'Digital Inputs',
  DO: 'Digital Outputs',
  AI: 'Analog Inputs',
  AO: 'Analog Outputs',
  GI: 'Group Inputs',
  GO: 'Group Outputs',
};

const TYPE_ORDER = ['DI', 'DO', 'AI', 'AO', 'GI', 'GO'];

export class GroupItem extends vscode.TreeItem {
  constructor(public readonly sigType: string, count: number) {
    super(
      `${TYPE_LABEL[sigType] ?? sigType} (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.iconPath = new vscode.ThemeIcon(
      sigType === 'AI' || sigType === 'AO' ? 'symbol-numeric'
      : sigType === 'GI' || sigType === 'GO' ? 'symbol-array'
      : 'symbol-boolean',
    );
    this.contextValue = 'ioGroup';
  }
}

export class SignalItem extends vscode.TreeItem {
  constructor(public readonly signal: Signal) {
    super(signal.name, vscode.TreeItemCollapsibleState.None);

    const isOutput  = signal.type === 'DO' || signal.type === 'AO' || signal.type === 'GO';
    const isDigital = signal.type === 'DI' || signal.type === 'DO';
    const isGroup   = signal.type === 'GI' || signal.type === 'GO';

    this.description = signal.lvalue;
    this.tooltip     = `[${signal.type}] ${signal.name} = ${signal.lvalue}`;

    if (isDigital) {
      this.iconPath = new vscode.ThemeIcon(
        signal.lvalue === '1' ? 'circle-filled' : 'circle-outline',
      );
    } else if (isGroup) {
      this.iconPath = new vscode.ThemeIcon('symbol-array');
    } else {
      this.iconPath = new vscode.ThemeIcon('symbol-numeric');
    }

    // Clicking a DO signal toggles it
    if (signal.type === 'DO') {
      this.command = {
        title: 'Toggle Signal',
        command: 'abbRobot.toggleSignal',
        arguments: [signal],
      };
    }

    this.contextValue = isOutput ? 'signalWritable' : 'signalReadOnly';
  }
}

type IoTreeItem = GroupItem | SignalItem | vscode.TreeItem;

export class IoTreeProvider implements vscode.TreeDataProvider<IoTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: IoTreeItem) { return el; }

  getChildren(element?: IoTreeItem): IoTreeItem[] {
    const s = this.manager.state;

    if (!s.connected) {
      const item = new vscode.TreeItem('Not connected', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return [item];
    }

    // Root: show type groups
    if (!element) {
      if (s.ioSignals.length === 0) {
        const item = new vscode.TreeItem(
          'No signals — click Refresh',
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return [item];
      }

      const grouped = new Map<string, number>();
      for (const sig of s.ioSignals) {
        grouped.set(sig.type, (grouped.get(sig.type) ?? 0) + 1);
      }

      return TYPE_ORDER
        .filter(t => grouped.has(t))
        .map(t => new GroupItem(t, grouped.get(t)!));
    }

    // Expanded group: list signals of that type
    if (element instanceof GroupItem) {
      return s.ioSignals
        .filter(sig => sig.type === element.sigType)
        .map(sig => new SignalItem(sig));
    }

    return [];
  }
}
