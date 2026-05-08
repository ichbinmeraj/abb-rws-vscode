import * as vscode from 'vscode';
import type { RobotManager } from 'abb-rws-client';
import type { FileEntry } from 'abb-rws-client';

export interface FileNode {
  path: string;
  entry: FileEntry;
}

class FileItem extends vscode.TreeItem {
  constructor(public readonly node: FileNode) {
    super(
      node.entry.name,
      node.entry.type === 'dir'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    if (node.entry.type === 'file') {
      const kb = node.entry.size !== undefined ? ` ${(node.entry.size / 1024).toFixed(1)} KB` : '';
      this.description = `${kb}  ${node.entry.modified ?? ''}`.trim();
      this.iconPath = new vscode.ThemeIcon('file-code');
      this.contextValue = 'controllerFile';
      this.command = {
        title: 'Download File',
        command: 'abbRobot.downloadControllerFile',
        arguments: [node],
      };
    } else {
      this.description = node.entry.modified ?? '';
      this.iconPath = new vscode.ThemeIcon('folder');
      this.contextValue = 'controllerDir';
    }
    this.tooltip = [
      `Path: ${node.path}`,
      node.entry.created ? `Created: ${node.entry.created}` : '',
      node.entry.modified ? `Modified: ${node.entry.modified}` : '',
      node.entry.size !== undefined ? `Size: ${node.entry.size} bytes` : '',
    ].filter(Boolean).join('\n');
  }
}

export class FileExplorerProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootPath = '$HOME';

  constructor(private manager: RobotManager) {}

  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el: FileItem) { return el; }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    const s = this.manager.state;
    if (!s.connected) {
      const item = new vscode.TreeItem('Not connected', vscode.TreeItemCollapsibleState.None);
      (item as vscode.TreeItem).iconPath = new vscode.ThemeIcon('circle-slash');
      return [item as unknown as FileItem];
    }

    const dirPath = element ? element.node.path : this.rootPath;
    try {
      const entries = await this.manager.listDirectory(dirPath);
      return entries.map(entry => new FileItem({
        path: `${dirPath}/${entry.name}`,
        entry,
      }));
    } catch {
      const errItem = new vscode.TreeItem('Failed to load', vscode.TreeItemCollapsibleState.None);
      (errItem as vscode.TreeItem).iconPath = new vscode.ThemeIcon('error');
      return [errItem as unknown as FileItem];
    }
  }
}
