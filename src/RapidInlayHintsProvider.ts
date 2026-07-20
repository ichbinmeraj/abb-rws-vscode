import * as vscode from 'vscode';
import type { MultiRobotManager } from 'abb-rws-client';
import type { RapidLanguageIndex } from './RapidLanguageIndex';

/**
 * Inlay hints that show LIVE controller values next to RAPID variable
 * declarations. When connected, you see something like:
 *
 *   VAR num counter := 0;          → 12
 *   PERS robtarget pHome := […];   → [[100,200,…],…]
 *   CONST string moduleVersion := "1.2";
 *
 * The hints are pulled from the controller in the background with a short
 * cache; the editor view updates within a few seconds as values change on
 * the running robot. This is what makes "RAPID Live" actually feel live
 * inside the editor - RobotStudio doesn't have an equivalent.
 *
 * Implementation:
 *  - We re-use the workspace symbol index to know which lines have decls.
 *  - We fetch values lazily when a range comes into view (VS Code calls
 *    `provideInlayHints` with the visible range).
 *  - Per-symbol TTL cache (1.5s) avoids hammering the controller during
 *    rapid scrolling.
 *  - Failures are cached too so unreadable symbols don't get re-tried on
 *    every viewport change.
 *  - The provider fires its own onDidChange every 1.5s while connected
 *    so VS Code re-asks for hints - this is what makes the values appear
 *    to update without user interaction.
 */

interface CachedValue { value?: string; error?: string; expires: number; }
const cache = new Map<string, CachedValue>();
const TTL_MS = 1500;

export class RapidInlayHintsProvider implements vscode.InlayHintsProvider, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this._onDidChange.event;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly multi: MultiRobotManager,
    private readonly index: RapidLanguageIndex,
  ) {
    // Tick the change event periodically while connected so VS Code re-asks
    // for hints and the visible values appear "alive."
    this.timer = setInterval(() => {
      if (this.multi.state.connected) { this._onDidChange.fire(); }
    }, TTL_MS);
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); }
  }

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    if (!this.multi.state.connected || !this.multi.active) { return []; }

    // Make sure the index has fresh symbols for this doc (in case of unsaved edits).
    this.index.indexDocument(document);
    const symbols = this.index.symbolsInFile(document.uri);

    // Filter to data-declarations within the visible range.
    const dataKinds = new Set(['var', 'pers', 'const']);
    const visible = symbols.filter(s =>
      dataKinds.has(s.kind) &&
      s.range.start.line >= range.start.line &&
      s.range.start.line <= range.end.line,
    );
    if (visible.length === 0) { return []; }

    const taskName = this.multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
    const hints: vscode.InlayHint[] = [];

    for (const sym of visible) {
      if (token.isCancellationRequested) { break; }
      const live = await this.lookupLive(taskName, sym.containerModule, sym.name);
      if (!live || live.error) { continue; }
      if (live.value === undefined) { continue; }

      // Place the hint at the END of the declaration line so it doesn't shift
      // user code horizontally. VS Code renders it as faded gray text inline.
      const lineEnd = document.lineAt(sym.range.start.line).range.end;
      const display = this.formatValue(live.value);
      const hint = new vscode.InlayHint(lineEnd, ` → ${display}`, vscode.InlayHintKind.Type);
      hint.paddingLeft = true;
      hint.tooltip = new vscode.MarkdownString(
        `**${sym.containerModule}.${sym.name}** - live from ${taskName}\n\n` +
        '```rapid\n' + live.value + '\n```',
      );
      hints.push(hint);
    }
    return hints;
  }

  private async lookupLive(task: string, moduleName: string, symbol: string): Promise<CachedValue | null> {
    const key = `${task}:${moduleName}:${symbol}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expires > now) { return cached; }
    const active = this.multi.active;
    if (!active) { return null; }
    try {
      const value = await active.getRapidVariable(task, moduleName, symbol);
      const fresh: CachedValue = { value, expires: now + TTL_MS };
      cache.set(key, fresh);
      return fresh;
    } catch (e) {
      // Cache failures with a longer TTL so unreadable symbols don't hit the
      // controller every refresh tick.
      const fresh: CachedValue = { error: e instanceof Error ? e.message : String(e), expires: now + TTL_MS * 4 };
      cache.set(key, fresh);
      return fresh;
    }
  }

  /** Compact one-line display of a RAPID value. Strip outer brackets when long. */
  private formatValue(raw: string): string {
    const single = raw.replace(/\s+/g, ' ').trim();
    if (single.length <= 50) { return single; }
    return single.slice(0, 47) + '…';
  }
}
