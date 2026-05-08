import * as vscode from 'vscode';
import type { MultiRobotManager } from 'abb-rws-client';

/**
 * Configuration database tree provider — visualizes /rw/cfg as a 4-level tree:
 *   Domain (EIO/MMC/MOC/PROC/SIO/SYS) → Type → Instance → Attributes
 *
 * Lazy-loaded: each level fetches on expand, so the controller isn't hit until
 * the user actually opens a domain. Click an instance to open a JSON document
 * with all its attributes.
 */

class CfgItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: 'domain' | 'type' | 'instance',
    public readonly domain: string,
    public readonly type?: string,
    public readonly instance?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    if (kind === 'instance') {
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
      this.iconPath = new vscode.ThemeIcon('symbol-property');
      this.contextValue = 'cfg.instance';
      // Click to open JSON view
      this.command = {
        title: 'Open Instance',
        command: 'abbRobot.cfgOpenInstance',
        arguments: [domain, type, instance],
      };
      this.tooltip = `${domain} / ${type} / ${instance}`;
    } else if (kind === 'type') {
      this.iconPath = new vscode.ThemeIcon('symbol-class');
      this.contextValue = 'cfg.type';
      this.tooltip = `${domain} / ${type}`;
    } else {
      this.iconPath = new vscode.ThemeIcon('database');
      this.contextValue = 'cfg.domain';
      this.tooltip = `Configuration domain: ${label}`;
    }
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(label: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

type CfgNode = CfgItem | MessageItem;

export class CfgTreeProvider implements vscode.TreeDataProvider<CfgNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CfgNode | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly multi: MultiRobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: CfgNode): vscode.TreeItem { return el; }

  async getChildren(element?: CfgNode): Promise<CfgNode[]> {
    const m = this.multi.active;
    if (!m || !m.state.connected) {
      return [new MessageItem('Not connected', 'circle-slash')];
    }

    try {
      // Top level — list domains
      if (!element) {
        const domains = await m.listCfgDomains();
        if (domains.length === 0) {
          return [new MessageItem('No CFG domains (controller may not support /rw/cfg)', 'warning')];
        }
        return domains.map(d => new CfgItem(d, 'domain', d));
      }

      if (element instanceof CfgItem) {
        // Domain → list types
        if (element.kind === 'domain') {
          const types = await m.listCfgTypes(element.domain);
          if (types.length === 0) { return [new MessageItem('(empty)', 'circle-slash')]; }
          return types.map(t => new CfgItem(t, 'type', element.domain, t));
        }
        // Type → list instances
        if (element.kind === 'type' && element.type) {
          const instances = await m.listCfgInstances(element.domain, element.type);
          if (instances.length === 0) { return [new MessageItem('(no instances)', 'circle-slash')]; }
          return instances.map(i => new CfgItem(i, 'instance', element.domain, element.type, i));
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return [new MessageItem(`Error: ${msg.slice(0, 80)}`, 'error')];
    }

    return [];
  }
}
