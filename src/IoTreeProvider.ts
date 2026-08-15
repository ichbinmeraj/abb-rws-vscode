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

export class SearchGroupItem extends vscode.TreeItem {
  constructor(label: string, count: number) {
    super(`Search: ${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('search');
    this.contextValue = 'ioSearchGroup';
  }
}

type IoTreeItem = GroupItem | SignalItem | SearchGroupItem | vscode.TreeItem;

export class IoTreeProvider implements vscode.TreeDataProvider<IoTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Server-side search results, pinned as an extra root group until cleared.
  private searchResults: Signal[] | null = null;
  private searchLabel = '';

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: IoTreeItem) { return el; }

  setSearch(results: Signal[], label: string) {
    this.searchResults = results;
    this.searchLabel = label;
    this.refresh();
  }
  clearSearch() {
    this.searchResults = null;
    this.searchLabel = '';
    this.refresh();
  }
  get hasSearch(): boolean { return this.searchResults !== null; }

  getChildren(element?: IoTreeItem): IoTreeItem[] {
    const s = this.manager.state;

    if (!s.connected) {
      const item = new vscode.TreeItem('Not connected', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return [item];
    }

    // Expanded search group: the pinned server-side results. Prefer the LIVE
    // signal object from the polled snapshot when one exists - the frozen
    // search-time copy never updates, so rendering (and the toggle command,
    // which computes the write from lvalue) would act on stale values.
    if (element instanceof SearchGroupItem) {
      return (this.searchResults ?? []).map(sig => {
        const live = s.ioSignals.find(x => x.name === sig.name && x.type === sig.type);
        return new SignalItem(live ?? sig);
      });
    }

    // Root: pinned search group (if any), then the type groups
    if (!element) {
      const head: IoTreeItem[] = this.searchResults !== null
        ? [new SearchGroupItem(this.searchLabel, this.searchResults.length)]
        : [];

      if (s.ioSignals.length === 0 && head.length === 0) {
        const item = new vscode.TreeItem(
          'No signals - click Refresh',
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return [item];
      }

      const grouped = new Map<string, number>();
      for (const sig of s.ioSignals) {
        grouped.set(sig.type, (grouped.get(sig.type) ?? 0) + 1);
      }

      return [
        ...head,
        ...TYPE_ORDER.filter(t => grouped.has(t)).map(t => new GroupItem(t, grouped.get(t)!)),
      ];
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
