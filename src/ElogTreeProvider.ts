import * as vscode from 'vscode';
import type { RobotManager } from 'abb-rws-client';
import type { ElogMessage } from 'abb-rws-client';

const MSGTYPE_ICON: Record<number, string> = {
  1: 'info',
  2: 'warning',
  3: 'error',
};

// Severity label for the icon tooltip
const MSGTYPE_LABEL: Record<number, string> = {
  1: 'Information',
  2: 'Warning',
  3: 'Error',
};

const MSGTYPE_COLOR: Record<number, string> = {
  1: 'charts.blue',
  2: 'charts.orange',
  3: 'errorForeground',
};

class MsgItem extends vscode.TreeItem {
  /** Direct reference so getChildren can access all fields without a re-search. */
  constructor(public readonly msg: ElogMessage) {
    super(`[${msg.code}] ${msg.title || `Event ${msg.code}`}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = msg.timestamp;
    const colorToken = MSGTYPE_COLOR[msg.msgtype];
    this.iconPath    = colorToken
      ? new vscode.ThemeIcon(MSGTYPE_ICON[msg.msgtype] ?? 'circle-outline', new vscode.ThemeColor(colorToken))
      : new vscode.ThemeIcon(MSGTYPE_ICON[msg.msgtype] ?? 'circle-outline');
    this.tooltip     = new vscode.MarkdownString(
      `**[${msg.code}] ${msg.title || `Event ${msg.code}`}**  \n` +
      `*${MSGTYPE_LABEL[msg.msgtype] ?? 'Event'}*  \n\n` +
      (msg.desc         ? `${msg.desc}\n\n` : '') +
      (msg.causes       ? `**Causes:** ${msg.causes}\n\n` : '') +
      (msg.consequences ? `**Consequences:** ${msg.consequences}\n\n` : '') +
      (msg.actions      ? `**Actions:** ${msg.actions}` : '')
    );
    this.contextValue = 'elogMessage';
  }
}

class DetailItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon = 'symbol-string') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath    = new vscode.ThemeIcon(icon);
    this.tooltip     = value;
  }
}

type ElogTreeItem = MsgItem | DetailItem | vscode.TreeItem;

export class ElogTreeProvider implements vscode.TreeDataProvider<ElogTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: ElogTreeItem) { return el; }

  getChildren(element?: ElogTreeItem): ElogTreeItem[] {
    const s = this.manager.state;

    if (!s.connected) {
      const item = new vscode.TreeItem('Not connected', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return [item];
    }

    // Top-level: list messages
    if (!element) {
      if (s.eventLog.length === 0) {
        const item = new vscode.TreeItem('No events', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('check');
        return [item];
      }
      return s.eventLog.map(msg => new MsgItem(msg));
    }

    // Expanded message → detail rows
    if (element instanceof MsgItem) {
      const msg = element.msg;
      const details: DetailItem[] = [];

      if (msg.desc) {
        details.push(new DetailItem('Description', msg.desc, 'info'));
      }
      if (msg.causes && msg.causes.trim()) {
        details.push(new DetailItem('Causes', msg.causes, 'question'));
      }
      if (msg.consequences && msg.consequences.trim()) {
        details.push(new DetailItem('Consequences', msg.consequences, 'warning'));
      }
      if (msg.actions && msg.actions.trim()) {
        details.push(new DetailItem('Actions', msg.actions, 'lightbulb'));
      }
      if (details.length === 0) {
        details.push(new DetailItem('No details', `Event code ${msg.code}`, 'circle-slash'));
      }
      return details;
    }

    return [];
  }
}
