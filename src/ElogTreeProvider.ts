import * as vscode from 'vscode';
import type { RobotManager } from './RobotManager';
import type { ElogMessage } from 'abb-rws-client';

const MSGTYPE_ICON: Record<number, string> = {
  1: 'info',
  2: 'warning',
  3: 'error',
};

class MsgItem extends vscode.TreeItem {
  constructor(msg: ElogMessage) {
    super(`[${msg.code}] ${msg.title}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = msg.timestamp;
    this.iconPath = new vscode.ThemeIcon(MSGTYPE_ICON[msg.msgtype] ?? 'circle-outline');
    this.tooltip = new vscode.MarkdownString(
      `**${msg.title}**\n\n${msg.desc}` +
      (msg.causes        ? `\n\n**Causes:** ${msg.causes}`         : '') +
      (msg.consequences  ? `\n\n**Consequences:** ${msg.consequences}` : '') +
      (msg.actions       ? `\n\n**Actions:** ${msg.actions}`       : ''),
    );
    this.contextValue = 'elogMessage';
  }
}

class DetailItem extends vscode.TreeItem {
  constructor(label: string, value: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon('symbol-string');
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

    // Expanded message: show details
    if (element instanceof MsgItem) {
      const msg = s.eventLog.find(m => `[${m.code}] ${m.title}` === element.label);
      if (!msg) return [];
      const details: DetailItem[] = [
        new DetailItem('Description', msg.desc),
      ];
      if (msg.causes)       details.push(new DetailItem('Causes',       msg.causes));
      if (msg.consequences) details.push(new DetailItem('Consequences', msg.consequences));
      if (msg.actions)      details.push(new DetailItem('Actions',      msg.actions));
      return details;
    }

    return [];
  }
}
