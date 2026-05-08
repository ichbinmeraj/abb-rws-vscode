import * as vscode from 'vscode';
import type { MultiRobotManager } from 'abb-rws-client';
import { Logger } from './Logger';

/**
 * Variables (Watch) panel — live values for RAPID variables, the way
 * RobotStudio's debugger does it. The user adds a (task, module, symbol)
 * entry to the watch list; we poll its value each refresh tick and surface
 * the result inline.
 *
 *   T_ROB1.MotionTest.counter         12
 *   T_ROB1.MotionTest.targetPos       [[100,200,300],...]
 *   T_ROB1.user.totalCycles           4823
 *
 * Right-click a watch entry → Edit value (writes via setRapidVariable),
 * Remove from watch.
 *
 * Persistence: watch entries live in workspace state so they survive reload.
 */

interface WatchEntry {
  task: string;
  module: string;
  symbol: string;
  value?: string;
  error?: string;
  lastUpdated?: number;
}

const WATCH_STATE_KEY = 'abbRobot.watches.v1';

class WatchItem extends vscode.TreeItem {
  constructor(label: string, public readonly entry: WatchEntry | null) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

export class VariableWatchProvider implements vscode.TreeDataProvider<WatchItem> {
  private _onDidChange = new vscode.EventEmitter<WatchItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private watches: WatchEntry[] = [];
  /** Throttle: don't poll faster than once per second even if refresh fires more often. */
  private lastPollAt = 0;
  /** Single-flight guard for the poll cycle. */
  private polling = false;

  constructor(
    private manager: MultiRobotManager,
    private context: vscode.ExtensionContext,
  ) {
    this.watches = context.globalState.get<WatchEntry[]>(WATCH_STATE_KEY, []);
  }

  refresh(): void {
    void this.poll();
  }

  /** Read-only snapshot of the current watch entries — used by the
   *  Program webview to render its Watch tab without re-implementing
   *  the polling logic. */
  getEntries(): ReadonlyArray<WatchEntry> {
    return this.watches;
  }

  forceRefreshNow(): void {
    this.lastPollAt = 0;
    void this.poll();
  }

  getTreeItem(el: WatchItem): vscode.TreeItem { return el; }

  async getChildren(element?: WatchItem): Promise<WatchItem[]> {
    if (element) { return []; }   // flat list
    if (!this.manager.state.connected) {
      return [this.makeStatus('Not connected', 'circle-slash', 'click Connect first')];
    }
    if (this.watches.length === 0) {
      return [this.makeStatus(
        'No watched variables',
        'info',
        'Click ＋ in the title bar, or right-click a variable in code → Add to Watch',
      )];
    }
    return this.watches.map(w => this.makeWatchItem(w));
  }

  // ─── Watch list management ──────────────────────────────────────────────

  async addWatch(): Promise<void> {
    if (!this.manager.state.connected) {
      vscode.window.showWarningMessage('Connect first.');
      return;
    }
    const tasks = this.manager.state.tasks.map(t => t.name);
    const taskName = tasks.length === 1 ? tasks[0] :
      await vscode.window.showQuickPick(tasks.length ? tasks : ['T_ROB1'], { placeHolder: 'Pick the RAPID task' });
    if (!taskName) { return; }

    const moduleName = await vscode.window.showInputBox({
      prompt: 'Module name (e.g. MotionTest, user, BASE)',
      placeHolder: 'MotionTest',
      validateInput: v => v.trim() ? undefined : 'Module name required',
    });
    if (!moduleName) { return; }

    const symbolName = await vscode.window.showInputBox({
      prompt: 'Variable / persistent / constant name',
      placeHolder: 'counter',
      validateInput: v => v.trim() ? undefined : 'Symbol name required',
    });
    if (!symbolName) { return; }

    if (this.watches.some(w => w.task === taskName && w.module === moduleName && w.symbol === symbolName)) {
      vscode.window.showInformationMessage('That variable is already in the watch list.');
      return;
    }
    this.watches.push({ task: taskName, module: moduleName.trim(), symbol: symbolName.trim() });
    await this.persist();
    this.forceRefreshNow();
  }

  async addWatchFromSelection(task: string, moduleName: string, symbol: string): Promise<void> {
    if (this.watches.some(w => w.task === task && w.module === moduleName && w.symbol === symbol)) {
      vscode.window.showInformationMessage(`${moduleName}.${symbol} is already watched.`);
      return;
    }
    this.watches.push({ task, module: moduleName, symbol });
    await this.persist();
    this.forceRefreshNow();
  }

  async removeWatch(arg: unknown): Promise<void> {
    const entry = this.entryFromArg(arg);
    if (!entry) { return; }
    this.watches = this.watches.filter(w => !(w.task === entry.task && w.module === entry.module && w.symbol === entry.symbol));
    await this.persist();
    this._onDidChange.fire();
  }

  async clearAll(): Promise<void> {
    if (this.watches.length === 0) { return; }
    const choice = await vscode.window.showWarningMessage(
      `Remove all ${this.watches.length} watched variables?`,
      'Clear', 'Cancel',
    );
    if (choice !== 'Clear') { return; }
    this.watches = [];
    await this.persist();
    this._onDidChange.fire();
  }

  async writeValue(arg: unknown): Promise<void> {
    const entry = this.entryFromArg(arg);
    if (!entry) { return; }
    const active = this.manager.active;
    if (!active) { vscode.window.showWarningMessage('No active robot.'); return; }
    const newValue = await vscode.window.showInputBox({
      prompt: `New value for ${entry.module}.${entry.symbol}`,
      value: entry.value ?? '',
      placeHolder: 'RAPID literal — number, "string", [array], or [record]',
    });
    if (newValue === undefined) { return; }
    try {
      await active.setRapidVariable(entry.task, entry.module, entry.symbol, newValue);
      entry.value = newValue;
      entry.error = undefined;
      entry.lastUpdated = Date.now();
      this._onDidChange.fire();
      vscode.window.setStatusBarMessage(`✓ ${entry.module}.${entry.symbol} = ${newValue}`, 3000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Write failed: ${msg}`);
      Logger.error(`watch.write ${entry.module}.${entry.symbol}`, e);
    }
  }

  // ─── Polling ─────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.polling) { return; }
    if (!this.manager.state.connected) { this._onDidChange.fire(); return; }
    if (this.watches.length === 0) { this._onDidChange.fire(); return; }
    const now = Date.now();
    if (now - this.lastPollAt < 1000) {
      // Soon enough — just re-render with current cached values
      this._onDidChange.fire();
      return;
    }
    const active = this.manager.active;
    if (!active) { this._onDidChange.fire(); return; }

    this.polling = true;
    this.lastPollAt = now;
    try {
      // Read each variable in sequence so a slow controller doesn't pile up requests.
      // Five watches at ~50ms each = 250ms per cycle, well within a 1s polling window.
      for (const w of this.watches) {
        try {
          const v = await active.getRapidVariable(w.task, w.module, w.symbol);
          w.value = v;
          w.error = undefined;
          w.lastUpdated = Date.now();
        } catch (e) {
          w.error = e instanceof Error ? e.message : String(e);
          w.lastUpdated = Date.now();
        }
      }
    } finally {
      this.polling = false;
      this._onDidChange.fire();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    // Strip transient fields (value/error/lastUpdated) before storing — those
    // are recomputed on every poll and shouldn't bloat the persisted state.
    const stripped = this.watches.map(w => ({ task: w.task, module: w.module, symbol: w.symbol }));
    await this.context.globalState.update(WATCH_STATE_KEY, stripped);
  }

  private entryFromArg(arg: unknown): WatchEntry | undefined {
    if (arg && typeof arg === 'object' && 'entry' in arg) {
      return (arg as { entry: WatchEntry }).entry;
    }
    return undefined;
  }

  private makeStatus(label: string, icon: string, tooltip?: string): WatchItem {
    const item = new WatchItem(label, null);
    item.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) { item.tooltip = tooltip; }
    return item;
  }

  private makeWatchItem(w: WatchEntry): WatchItem {
    const label = `${w.module}.${w.symbol}`;
    const item = new WatchItem(label, w);
    if (w.error) {
      item.description = `⚠ ${this.shortenError(w.error)}`;
      item.iconPath = new vscode.ThemeIcon('warning');
      item.tooltip = `${w.task}.${w.module}.${w.symbol}\n\nError: ${w.error}\n\nFix: check the symbol exists in the controller and the type is readable. Right-click → Remove if obsolete.`;
    } else if (w.value !== undefined) {
      item.description = this.shortenValue(w.value);
      item.iconPath = new vscode.ThemeIcon('symbol-variable');
      const ageSec = w.lastUpdated ? Math.floor((Date.now() - w.lastUpdated) / 1000) : -1;
      item.tooltip = `${w.task}.${w.module}.${w.symbol} = ${w.value}\n\nUpdated ${ageSec}s ago.\n\nRight-click → Edit value or Remove from watch.`;
    } else {
      item.description = '…';
      item.iconPath = new vscode.ThemeIcon('sync');
      item.tooltip = `${w.task}.${w.module}.${w.symbol}\n\nReading…`;
    }
    item.contextValue = 'watchEntry';
    return item;
  }

  private shortenValue(v: string, max = 60): string {
    if (v.length <= max) { return v; }
    return v.slice(0, max - 1) + '…';
  }

  private shortenError(e: string): string {
    // Trim long stack traces / HTTP detail so the tree row stays readable.
    return e.replace(/\s+/g, ' ').slice(0, 80);
  }
}
