import * as vscode from 'vscode';

/**
 * Aggregates several existing TreeDataProviders into a single tree, with each
 * underlying provider's tree shown as a top-level collapsible "── Section ──"
 * row.
 *
 * Used to merge the previously-separate panels (Modules + Watch + …) into
 * single domain-grouped panels (Program / Controller Data / Diagnostics).
 *
 * Why this design:
 *   - Zero changes to the existing providers - they still expose their full
 *     tree. The composite only adds a "section header" wrapper.
 *   - Each underlying provider's `refresh()` continues to be callable from
 *     the extension; the composite subscribes to each child's
 *     `onDidChangeTreeData` event and re-fires its own.
 *   - Right-click `viewItem == programModule` etc. still resolves correctly
 *     because TreeItems passed up by underlying providers retain their
 *     `contextValue`. Existing menu contributions just need their `view ==`
 *     references updated to the new composite view IDs.
 *
 * The composite uses a WeakMap to remember which provider each TreeItem
 * came from, so `getChildren(item)` routes the call back to the correct
 * underlying provider.
 */

export interface CompositeSection {
  /** Stable identifier - used by tests/log lines and as the TreeItem id. */
  id: string;
  /** Label shown to the user. Convention: "── Name ──". */
  label: string;
  /** The underlying provider whose tree fills the section. */
  provider: vscode.TreeDataProvider<unknown>;
  /** Optional icon (codicon name) for the section header row. */
  icon?: string;
  /** Default collapse state. Defaults to Expanded. */
  initiallyCollapsed?: boolean;
}

export class CompositeTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly itemProvider = new WeakMap<object, vscode.TreeDataProvider<unknown>>();
  private readonly sectionByItem = new WeakMap<object, CompositeSection>();

  constructor(private readonly sections: CompositeSection[]) {
    // Bubble child-provider change events up. We re-fire with no argument so
    // VS Code re-asks for the visible subtree; for this extension's data
    // volumes (~50 items per panel max) the cost is negligible and the
    // alternative (mapping a child element back to its parent section) is
    // brittle since underlying providers don't track parents.
    for (const s of this.sections) {
      const evt = s.provider.onDidChangeTreeData;
      if (evt) {
        evt(() => this._onDidChangeTreeData.fire());
      }
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    // Section headers have already been built with the correct shape by
    // `buildSectionHeader`. Items returned by underlying providers are
    // already TreeItems - VS Code calls getTreeItem on them too in some
    // flows, but since they ARE TreeItems we just return as-is.
    if ((element as { _isSectionHeader?: boolean })._isSectionHeader) {
      return element;
    }
    // Delegate to the providing provider's getTreeItem (some providers do
    // light formatting in there).
    const provider = this.itemProvider.get(element);
    if (provider?.getTreeItem) {
      return provider.getTreeItem(element);
    }
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // Root - emit one section header per section.
      return this.sections.map(s => this.buildSectionHeader(s));
    }

    // Was this element a section header? Then emit its provider's root.
    if ((element as { _isSectionHeader?: boolean })._isSectionHeader) {
      const section = this.sectionByItem.get(element);
      if (!section) { return []; }
      const children = (await section.provider.getChildren?.(undefined)) ?? [];
      const items = await Promise.all(children.map(c => this.coerceToTreeItem(c, section.provider)));
      for (const c of items) { this.itemProvider.set(c, section.provider); }
      return items;
    }

    // Delegated descendant - find the providing provider, ask for its children.
    const provider = this.itemProvider.get(element);
    if (!provider) { return []; }
    const children = (await provider.getChildren?.(element)) ?? [];
    const items = await Promise.all(children.map(c => this.coerceToTreeItem(c, provider)));
    for (const c of items) { this.itemProvider.set(c, provider); }
    return items;
  }

  private buildSectionHeader(s: CompositeSection): vscode.TreeItem {
    const collapseState = s.initiallyCollapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(s.label, collapseState);
    item.id = `composite:${s.id}`;
    item.contextValue = `compositeSection:${s.id}`;
    if (s.icon) {
      item.iconPath = new vscode.ThemeIcon(s.icon, new vscode.ThemeColor('descriptionForeground'));
    }
    (item as { _isSectionHeader?: boolean })._isSectionHeader = true;
    this.sectionByItem.set(item, s);
    return item;
  }

  /** Underlying providers may return non-TreeItem objects (their internal types).
   *  Resolve those to TreeItems via the provider's own `getTreeItem`. */
  private async coerceToTreeItem(child: unknown, provider: vscode.TreeDataProvider<unknown>): Promise<vscode.TreeItem> {
    if (child instanceof vscode.TreeItem) { return child; }
    if (provider.getTreeItem) {
      return await provider.getTreeItem(child);
    }
    // Fallback - should not happen in our codebase since every provider
    // either returns TreeItems directly or implements getTreeItem.
    return new vscode.TreeItem('?');
  }
}
