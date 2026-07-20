import * as vscode from 'vscode';
import type { MultiRobotManager, RobotManager } from 'abb-rws-client';

/**
 * The Program panel - tabbed webview with two tabs: Modules and Watch.
 *
 * Replaces the previous CompositeTreeProvider-backed view with a custom
 * webview that has real top-of-panel tab buttons. Trade-offs vs the
 * tree-based version:
 *   ✓ Cleaner top-level UX - only one section visible at a time.
 *   ✓ Custom layouts per tab (we can use grid / cards / inline buttons
 *     in ways tree views can't).
 *   ✗ No native VS Code right-click menus on items - actions are
 *     surfaced as inline buttons on each row instead.
 *   ✗ No native tree drill-down - module → routines drill is replaced by
 *     "click a module to open its source"; routines stay accessible via
 *     CodeLens in the .mod editor and via the ABB command palette.
 *
 * State updates: the provider subscribes to `multi.onDidChange` and
 * posts a fresh snapshot to the webview on every change. The webview
 * does no fetching itself - it's a pure render surface.
 *
 * Action wiring: the webview posts `{ type: 'command', name, args }`
 * messages back to the extension; the extension dispatches via
 * `vscode.commands.executeCommand`. This means every action available
 * in the existing tree views is reachable from the webview via the
 * same command IDs - no command duplication.
 */

interface WatchEntry {
  task: string;
  module: string;
  symbol: string;
  value?: string;
  error?: string;
}

interface RoutineInfo {
  name: string;
  symtyp: string;     // 'prc' | 'fun' | 'trp'
  local: boolean;
  isPPHere?: boolean;
}

interface ModuleInfo {
  task: string;
  name: string;
  type: string;
  isPPHere: boolean;
  routines?: RoutineInfo[];   // populated when the user expands the module row
}

interface TaskInfo {
  name: string;
  type: string;            // Normal / Static / SemiStatic
  taskstate: string;
  excstate: string;
  active: boolean;
  motiontask: boolean;
  modules: ModuleInfo[];
}

interface ProgramState {
  connected: boolean;
  motors?: string;          // 'motoron' | 'motoroff' | 'guardstop' | …
  opmode?: string;
  execstate?: string;
  speed?: number;
  running: boolean;
  tasks: TaskInfo[];
  watches: WatchEntry[];
  /** When ≥2 program modules each define `PROC main()`, the controller
   *  rejects PP-to-Main with `icode:-519`. We surface this to the user
   *  proactively so they know which modules to unload. */
  mainCollisionModules?: string[];
}

export class TabbedProgramWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'abbRobot.program';
  private view?: vscode.WebviewView;

  /** Per-module routine cache, keyed by `${task}:${module}`. Cleared when
   *  the loaded-modules-set rotates so stale routines don't linger. */
  private routineCache = new Map<string, RoutineInfo[]>();
  private lastModulesKey = '';
  private inflight = new Set<string>();

  constructor(
    private readonly multi: MultiRobotManager,
    private readonly getWatches: () => WatchEntry[],
  ) {
    multi.onDidChange(() => {
      const key = this.multi.state.modules.slice().sort().join('|');
      if (key !== this.lastModulesKey) {
        this.routineCache.clear();
        this.lastModulesKey = key;
        // Eagerly fetch routines for every program module so we can detect
        // a `main`-collision early (≥2 modules with PROC main → PP-to-Main
        // fails with `icode:-519`). Skip system modules (BASE / user / …
        // never define a user-meaningful main).
        void this.eagerFetchRoutinesForCollisionCheck();
      }
      this.postState();
    });
  }

  /** Set by the extension on registration so we can build asWebviewUri paths. */
  private extensionUri?: vscode.Uri;

  setExtensionUri(uri: vscode.Uri): void { this.extensionUri = uri; }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // Allow loading the codicon font + css from media/codicons/
      localResourceRoots: this.extensionUri ? [vscode.Uri.joinPath(this.extensionUri, 'media')] : undefined,
    };
    view.webview.html = this.renderHtml(view.webview);
    view.onDidDispose(() => { this.view = undefined; });

    view.webview.onDidReceiveMessage((msg: { type: string; name?: string; args?: unknown[]; task?: string; module?: string }) => {
      if (msg.type === 'command' && typeof msg.name === 'string') {
        // Dispatch through VS Code's command system. Every existing command
        // (push, open, run, set PP, edit watch, …) works here unchanged.
        void vscode.commands.executeCommand(msg.name, ...(msg.args ?? []));
        return;
      }
      if (msg.type === 'expandModule' && msg.task && msg.module) {
        void this.fetchRoutinesFor(msg.task, msg.module);
        return;
      }
    });

    void this.postState();
  }

  /** Background: fetch routines for every loaded program module so the
   *  collision check has data without the user needing to expand each.
   *  Best-effort - failures are silent (cache stores empty list). */
  private async eagerFetchRoutinesForCollisionCheck(): Promise<void> {
    const active = this.multi.active;
    if (!active) { return; }
    const taskName = this.multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
    const sysmods = new Set(['BASE', 'user', 'DPUSER', 'DPBASE']);
    const programMods = this.multi.state.modules.filter(m => !sysmods.has(m));
    for (const mod of programMods) {
      const key = `${taskName}:${mod}`;
      if (this.routineCache.has(key) || this.inflight.has(key)) { continue; }
      this.inflight.add(key);
      try {
        const rs = await active.listRoutines(taskName, mod);
        this.routineCache.set(key, rs.map(r => ({ name: r.name, symtyp: r.symtyp, local: r.local })));
      } catch {
        this.routineCache.set(key, []);
      } finally {
        this.inflight.delete(key);
      }
    }
    // Re-post once eager fetch is done so the warning appears.
    this.postState();
  }

  /** Fetch routines for one module on demand and post a fresh state. */
  private async fetchRoutinesFor(task: string, module: string): Promise<void> {
    const key = `${task}:${module}`;
    if (this.inflight.has(key)) { return; }
    if (this.routineCache.has(key)) { this.postState(); return; }
    const active = this.multi.active;
    if (!active) { return; }
    this.inflight.add(key);
    try {
      const rs = await active.listRoutines(task, module);
      this.routineCache.set(key, rs.map(r => ({ name: r.name, symtyp: r.symtyp, local: r.local })));
    } catch {
      this.routineCache.set(key, []);
    } finally {
      this.inflight.delete(key);
      this.postState();
    }
  }

  /** Force a fresh post - called when the watch list mutates outside the
   *  manager-state cycle (add / remove / edit). */
  refresh(): void { void this.postState(); }

  private postState(): void {
    if (!this.view) { return; }
    const s = this.multi.state;
    const sysModuleNames = new Set(['BASE', 'user', 'DPUSER', 'DPBASE']);

    // Pull the full per-task module list. listModulesDetailed is async, but
    // we already keep state.modules as a coarse snapshot. For UI purposes
    // we use the flat coarse list since rich type info is shown in the
    // Live Cell + Diagnostics panels anyway.
    // Group modules under their owning task. The poller only reports modules
    // for the active task; inactive-task headers show but with a placeholder
    // "(activate task to see modules)" message.
    const tasks: TaskInfo[] = s.tasks.map(t => {
      const modules: ModuleInfo[] = [];
      if (t.active) {
        for (const m of s.modules) {
          const routines = this.routineCache.get(`${t.name}:${m}`);
          modules.push({
            task: t.name,
            name: m,
            type: sysModuleNames.has(m) ? 'SysMod' : 'ProgMod',
            isPPHere: false,
            routines,
          });
        }
      }
      return {
        name: t.name,
        type: t.type,
        taskstate: t.taskstate,
        excstate: t.excstate,
        active: t.active,
        motiontask: t.motiontask,
        modules,
      };
    });
    // Sort: motion task first, then active, then alpha
    tasks.sort((a, b) => {
      if (a.motiontask !== b.motiontask) { return a.motiontask ? -1 : 1; }
      if (a.active !== b.active) { return a.active ? -1 : 1; }
      return a.name.localeCompare(b.name);
    });

    // Detect main-collision: ≥2 modules with a non-local PROC named `main`.
    // Uses the routine cache populated by eagerFetchRoutinesForCollisionCheck.
    const modulesWithMain: string[] = [];
    for (const t of tasks) {
      if (!t.active) { continue; }
      for (const m of t.modules) {
        const rs = this.routineCache.get(`${t.name}:${m.name}`);
        if (rs && rs.some(r => r.name.toLowerCase() === 'main' && r.symtyp.toLowerCase() === 'prc' && !r.local)) {
          modulesWithMain.push(m.name);
        }
      }
    }
    const mainCollisionModules = modulesWithMain.length >= 2 ? modulesWithMain : undefined;

    const state: ProgramState = {
      connected: s.connected,
      motors: s.ctrlstate ?? undefined,
      opmode: s.opmode ?? undefined,
      execstate: s.execstate ?? undefined,
      speed: s.speedRatio ?? undefined,
      running: s.execstate === 'running',
      tasks,
      watches: this.getWatches(),
      mainCollisionModules,
    };
    void this.view.webview.postMessage({ type: 'state', data: state });
  }

  private renderHtml(webview: vscode.Webview): string {
    const cspSource = webview.cspSource;
    // Codicon font + CSS - shipped at media/codicons/. asWebviewUri rewrites
    // the file:// path so the webview's CSP-restricted iframe can load it.
    const codiconCssUri = this.extensionUri
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'))
      : undefined;
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  ${codiconCssUri ? `<link rel="stylesheet" href="${codiconCssUri}" />` : ''}
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }

    /* Tab strip */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-tab-border, var(--vscode-panel-border, transparent));
      background: var(--vscode-editorGroupHeader-tabsBackground, transparent);
    }
    .tab {
      flex: 0 0 auto;
      padding: 8px 14px;
      font-size: 12px;
      cursor: pointer;
      color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground));
      background: var(--vscode-tab-inactiveBackground, transparent);
      border-bottom: 2px solid transparent;
      user-select: none;
    }
    .tab:hover {
      color: var(--vscode-tab-hoverForeground, var(--vscode-foreground));
      background: var(--vscode-tab-hoverBackground, transparent);
    }
    .tab.active {
      color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
      background: var(--vscode-tab-activeBackground, transparent);
      border-bottom-color: var(--vscode-focusBorder, currentColor);
    }
    .tab-count {
      font-size: 10px;
      opacity: 0.7;
      margin-left: 4px;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .tab-content { display: none; padding: 8px; }
    .tab-content.active { display: block; }

    /* Status banner */
    .status-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      border-radius: 3px;
      margin-bottom: 8px;
      font-size: 11px;
      letter-spacing: 0.3px;
      color: var(--vscode-statusBarItem-prominentForeground);
      background: var(--vscode-statusBarItem-prominentBackground);
    }
    .status-banner.running {
      background: var(--vscode-statusBarItem-warningBackground);
      color: var(--vscode-statusBarItem-warningForeground);
    }
    .status-banner.guardstop {
      background: var(--vscode-inputValidation-errorBackground);
    }
    .status-banner .dot {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
      background: var(--vscode-charts-green, #3fb950);
    }
    .status-banner.guardstop .dot { background: var(--vscode-charts-red, #f85149); }
    .status-banner.disconnected .dot { background: var(--vscode-descriptionForeground); }

    /* Codicon helper - sizing + alignment */
    .codicon { font-size: 14px; vertical-align: middle; line-height: 1; }
    .codicon-sm { font-size: 12px; }
    .icon-blue   { color: var(--vscode-charts-blue, currentColor); }
    .icon-purple { color: var(--vscode-charts-purple, currentColor); }
    .icon-yellow { color: var(--vscode-charts-yellow, currentColor); }
    .icon-muted  { color: var(--vscode-descriptionForeground); }

    /* Action buttons row */
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 10px;
    }
    .actions button {
      flex: 0 0 auto;
      padding: 4px 10px;
      font-size: 11px;
      font-family: inherit;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      cursor: pointer;
    }
    .actions button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .actions button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .actions button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .actions button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* State-tinted toggle buttons. The .on / .running / .auto modifiers
       light each up so the user knows the current state at a glance. */
    .actions button.on,
    .actions button.running {
      color: var(--vscode-statusBarItem-warningForeground, var(--vscode-button-foreground));
      background: var(--vscode-statusBarItem-warningBackground, var(--vscode-button-background));
    }
    .actions button.on .codicon,
    .actions button.running .codicon { color: inherit; }
    .actions button.off { opacity: 0.85; }
    .actions button.auto {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .actions button.manual {
      color: var(--vscode-statusBarItem-warningForeground, var(--vscode-button-foreground));
      background: var(--vscode-statusBarItem-warningBackground, var(--vscode-button-background));
    }
    .actions button.error {
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-button-foreground));
      background: var(--vscode-inputValidation-errorBackground);
    }

    /* Section heading */
    .section-title {
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin: 12px 0 4px 2px;
    }

    /* Item rows */
    .row {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 2px;
      cursor: default;
      gap: 8px;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row .icon {
      flex: 0 0 16px;
      font-family: codicon;
      color: var(--vscode-icon-foreground);
    }
    .row .label {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row .desc {
      flex: 0 0 auto;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: 4px;
    }
    .row .row-actions {
      flex: 0 0 auto;
      display: none;
      gap: 2px;
    }
    .row:hover .row-actions { display: flex; }
    .row .row-actions button {
      padding: 2px 6px;
      font-size: 10px;
      font-family: inherit;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .row .row-actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .empty {
      text-align: center;
      padding: 16px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .empty button {
      display: inline-block;
      margin-top: 8px;
      padding: 4px 10px;
      font-size: 11px;
      font-family: inherit;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }

    .module-row .type-badge {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 2px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* Module group: header row + collapsible routines list underneath */
    .module-group { margin-bottom: 2px; }
    .module-group .twisty {
      display: inline-block;
      width: 14px;
      text-align: center;
      color: var(--vscode-icon-foreground);
      cursor: pointer;
      user-select: none;
    }
    .module-group .routines {
      display: none;
      margin-left: 22px;
    }
    .module-group.expanded .routines { display: block; }
    .module-group.expanded .twisty::before { content: '▾'; }
    .module-group:not(.expanded) .twisty::before { content: '▸'; }

    .routine-row {
      display: flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 2px;
      gap: 8px;
    }
    .routine-row:hover { background: var(--vscode-list-hoverBackground); }
    .routine-row .icon { font-size: 12px; flex: 0 0 14px; text-align: center; }
    .routine-row .icon.prc { color: var(--vscode-charts-blue, #4eaeff); }
    .routine-row .icon.fun { color: var(--vscode-charts-purple, #b87fff); }
    .routine-row .icon.trp { color: var(--vscode-charts-yellow, #d4ad34); }
    .routine-row .label { flex: 1 1 auto; }
    .routine-row .kind {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      flex: 0 0 auto;
    }
    .routine-row .row-actions {
      display: none;
      gap: 2px;
    }
    .routine-row:hover .row-actions { display: flex; }
    .routine-row .row-actions button {
      padding: 1px 6px;
      font-size: 10px;
      font-family: inherit;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .routine-row .row-actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .routines-loading,
    .routines-empty {
      padding: 4px 22px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    /* Section header with right-side action button */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin: 12px 2px 4px;
    }
    .section-header .title {
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .section-header button {
      padding: 2px 8px;
      font-size: 11px;
      font-family: inherit;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .section-header button:hover { background: var(--vscode-button-hoverBackground); }

    /* Task group */
    .task-group { margin-top: 4px; }
    .task-row {
      display: flex;
      align-items: center;
      padding: 5px 8px;
      gap: 8px;
      cursor: pointer;
      border-radius: 2px;
      background: var(--vscode-editorWidget-background, transparent);
      margin-bottom: 1px;
    }
    .task-row:hover { background: var(--vscode-list-hoverBackground); }
    .task-row .twisty {
      display: inline-block;
      width: 12px;
      text-align: center;
      color: var(--vscode-icon-foreground);
      user-select: none;
    }
    .task-group.expanded .twisty::before { content: '▾'; }
    .task-group:not(.expanded) .twisty::before { content: '▸'; }
    .task-row .icon {
      font-size: 13px;
      color: var(--vscode-charts-blue, currentColor);
    }
    .task-row.inactive .icon { color: var(--vscode-descriptionForeground); }
    .task-row .name {
      font-weight: 600;
      flex: 0 0 auto;
    }
    .task-row .meta {
      flex: 1 1 auto;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .task-row .row-actions {
      display: none;
      gap: 2px;
    }
    .task-row:hover .row-actions { display: flex; }
    .task-row .row-actions button {
      padding: 2px 8px;
      font-size: 10px;
      font-family: inherit;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .task-row .row-actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .task-modules { display: none; margin-left: 18px; }
    .task-group.expanded .task-modules { display: block; }
    .task-empty {
      padding: 6px 22px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    /* Warning banner - shown above the modules list when the controller is
       in a state that will reject a common operation (e.g. main-collision
       blocking PP-to-Main). */
    .warning-banner {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      margin: 8px 0;
      border-radius: 3px;
      font-size: 11px;
      line-height: 1.4;
      background: var(--vscode-inputValidation-warningBackground, var(--vscode-statusBarItem-warningBackground));
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-statusBarItem-warningForeground));
      border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
    }
    .warning-banner .codicon { font-size: 16px; flex: 0 0 auto; margin-top: 1px; }
    .warning-banner .body { flex: 1 1 auto; }
    .warning-banner .title { font-weight: 600; margin-bottom: 2px; }
    .warning-banner .module-list {
      font-family: var(--vscode-editor-font-family);
      margin-top: 2px;
      opacity: 0.9;
    }

    .watch-value {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-charts-green, var(--vscode-foreground));
    }
    .watch-value.error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" data-tab="modules">Modules <span class="tab-count" id="count-modules">0</span></div>
    <div class="tab"        data-tab="watch">Watch  <span class="tab-count" id="count-watch">0</span></div>
  </div>

  <!-- ── MODULES ── -->
  <div id="tab-modules" class="tab-content active">
    <div id="status-banner" class="status-banner disconnected">
      <span><span class="dot"></span><span id="banner-state">NOT CONNECTED</span></span>
      <span id="banner-mode"></span>
    </div>

    <div class="actions">
      <button id="btn-motors"   data-state="off"     title="Toggle motors on/off"><span class="codicon codicon-zap"></span> <span id="btn-motors-label">Motors</span></button>
      <button id="btn-exec"     data-state="stopped" title="Start / Stop RAPID execution"><span id="btn-exec-icon" class="codicon codicon-play"></span> <span id="btn-exec-label">Start</span></button>
      <button id="btn-pp-main"  title="Reset program pointer to main"><span class="codicon codicon-debug-restart"></span> PP to Main</button>
      <button id="btn-opmode"   title="Switch operation mode (VC only)"><span id="btn-opmode-icon" class="codicon codicon-lock"></span> <span id="btn-opmode-label">Mode</span></button>
      <button id="btn-speed"    title="Set speed ratio (0-100%)"><span class="codicon codicon-dashboard"></span> <span id="btn-speed-label">Speed</span></button>
      <button id="btn-load" class="primary"><span class="codicon codicon-cloud-upload"></span> Load Program…</button>
    </div>

    <div class="section-header">
      <span class="title">Tasks &amp; Modules</span>
      <button id="btn-new-task" title="Create a new RAPID task in CFG (requires controller restart)">+ New Task</button>
    </div>
    <div id="warning-area"></div>
    <div id="modules-list">
      <div class="empty">No tasks reported yet.</div>
    </div>
  </div>

  <!-- ── WATCH ── -->
  <div id="tab-watch" class="tab-content">
    <div class="actions">
      <button id="btn-add-watch" class="primary">+ Add Variable</button>
      <button id="btn-refresh-watch">Refresh</button>
      <button id="btn-clear-watch">Clear All</button>
    </div>
    <div id="watch-list">
      <div class="empty">
        No watched variables.
        <br/><br/>
        <button id="btn-add-watch-empty">+ Add Variable</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    // ── Tab switching ────────────────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        $('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // ── Action buttons ──────────────────────────────────────────────────
    function cmd(name, ...args) {
      vscode.postMessage({ type: 'command', name, args });
    }
    // Static actions
    $('btn-load').onclick     = () => cmd('abbRobot.uploadModule');
    $('btn-pp-main').onclick  = () => cmd('abbRobot.ppToMain');
    $('btn-opmode').onclick   = () => cmd('abbRobot.setOpMode');
    $('btn-speed').onclick    = () => cmd('abbRobot.setSpeedRatio');

    // Toggle buttons - onclick set per state in updateActionButtons().
    $('btn-motors').onclick = () => {
      // The data-state attribute reflects the LATEST poll; we send the
      // OPPOSITE command. The button briefly stays in the prior state
      // until the next poll updates it.
      const state = $('btn-motors').dataset.state;
      cmd(state === 'on' ? 'abbRobot.motorsOff' : 'abbRobot.motorsOn');
    };
    $('btn-exec').onclick = () => {
      const state = $('btn-exec').dataset.state;
      cmd(state === 'running' ? 'abbRobot.stopRapid' : 'abbRobot.startRapid');
    };

    function updateActionButtons(s) {
      // Motors toggle - green/warning when ON, muted when OFF.
      const motorsBtn = $('btn-motors');
      const motorsState = (s.motors || '').toLowerCase();
      const motorsOn = motorsState === 'motoron';
      motorsBtn.dataset.state = motorsOn ? 'on' : 'off';
      motorsBtn.className = motorsOn ? 'on' :
                            (motorsState === 'guardstop' || motorsState === 'emergencystop') ? 'error' :
                            'off';
      $('btn-motors-label').textContent = motorsOn ? 'Motors ON' :
                                           motorsState === 'guardstop' ? 'Guard Stop' :
                                           motorsState === 'emergencystop' ? 'E-Stop' :
                                           'Motors OFF';

      // Exec toggle - running shows Stop+warning bg; stopped shows Start.
      const execBtn = $('btn-exec');
      const isRunning = !!s.running;
      execBtn.dataset.state = isRunning ? 'running' : 'stopped';
      execBtn.className = isRunning ? 'running' : '';
      $('btn-exec-icon').className = 'codicon ' + (isRunning ? 'codicon-debug-stop' : 'codicon-play');
      $('btn-exec-label').textContent = isRunning ? 'Stop' : 'Start';

      // Op-mode - lock for AUTO (blue), unlock for MAN* (warning).
      const opmodeBtn = $('btn-opmode');
      const opmode = s.opmode || '';
      const isAuto = opmode === 'AUTO';
      opmodeBtn.className = !s.connected ? '' : (isAuto ? 'auto' : 'manual');
      $('btn-opmode-icon').className = 'codicon ' + (isAuto ? 'codicon-lock' : 'codicon-unlock');
      $('btn-opmode-label').textContent = opmode || 'Mode';

      // Speed - current ratio + warning tint when below 30%.
      const speedBtn = $('btn-speed');
      const speed = (typeof s.speed === 'number') ? s.speed : null;
      $('btn-speed-label').textContent = speed !== null ? speed + '%' : 'Speed';
      speedBtn.className = (speed !== null && speed < 30) ? 'manual' : '';

      // Disable the lot when not connected.
      const allBtns = ['btn-motors', 'btn-exec', 'btn-pp-main', 'btn-opmode', 'btn-speed', 'btn-load'];
      for (const id of allBtns) { $(id).disabled = !s.connected; }
    }
    $('btn-add-watch').onclick    = () => cmd('abbRobot.addWatch');
    $('btn-add-watch-empty').onclick = () => cmd('abbRobot.addWatch');
    $('btn-refresh-watch').onclick = () => cmd('abbRobot.refreshWatches');
    $('btn-clear-watch').onclick  = () => cmd('abbRobot.clearWatches');
    $('btn-new-task').onclick     = () => cmd('abbRobot.createRapidTask');

    // ── Render functions ────────────────────────────────────────────────
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function paintBanner(s) {
      const b = $('status-banner');
      b.className = 'status-banner';
      const mLabel = $('banner-state');
      const mode  = $('banner-mode');
      if (!s.connected) {
        b.classList.add('disconnected');
        mLabel.textContent = 'NOT CONNECTED';
        mode.textContent = '';
        return;
      }
      const motors = (s.motors || '').toLowerCase();
      const exec   = (s.execstate || '').toLowerCase();
      if (motors === 'guardstop' || motors === 'emergencystop') {
        b.classList.add('guardstop');
        mLabel.textContent = motors.replace(/-/g, ' ').toUpperCase();
      } else if (s.running) {
        b.classList.add('running');
        mLabel.textContent = '● RUNNING';
      } else {
        mLabel.textContent = (exec || motors || 'READY').toUpperCase();
      }
      const speedStr = (typeof s.speed === 'number') ? s.speed + '%' : '';
      mode.textContent = [s.opmode || '', speedStr].filter(Boolean).join(' · ');
    }

    /** Track which module rows are user-expanded so a refresh doesn't collapse them. */
    const expandedModules = new Set();

    function routineHtml(task, modName, r) {
      const kindLabel = r.symtyp === 'prc' ? 'PROC'
                      : r.symtyp === 'fun' ? 'FUNC'
                      : r.symtyp === 'trp' ? 'TRAP' : r.symtyp.toUpperCase();
      const kindClass = r.symtyp.toLowerCase();
      const localTag = r.local ? ' · LOCAL' : '';
      const runBtn = r.symtyp === 'prc'
        ? '<button data-act="run-routine" data-task="' + escapeHtml(task) + '" data-mod="' + escapeHtml(modName) + '" data-name="' + escapeHtml(r.name) + '"><span class="codicon codicon-play"></span> Run</button>'
        : '';
      return '<div class="routine-row">' +
        '<span class="codicon ' +
          (r.symtyp === 'prc' ? 'codicon-symbol-method icon-blue'
           : r.symtyp === 'fun' ? 'codicon-symbol-function icon-purple'
           : 'codicon-symbol-event icon-yellow') +
        '"></span>' +
        '<span class="label">' + escapeHtml(r.name) + '</span>' +
        '<span class="kind">' + kindLabel + localTag + '</span>' +
        '<span class="row-actions">' +
          runBtn +
          '<button data-act="setpp-routine" data-task="' + escapeHtml(task) + '" data-mod="' + escapeHtml(modName) + '" data-name="' + escapeHtml(r.name) + '">Set PP</button>' +
        '</span>' +
      '</div>';
    }

    /** Track which task headers + module rows are user-expanded. */
    const expandedTasks = new Set();

    function moduleRowHtml(m, expanded) {
      const sys = m.type === 'SysMod';
      const iconColor = sys ? 'var(--vscode-descriptionForeground)' : 'inherit';
      let routinesHtml = '';
      if (expanded) {
        if (Array.isArray(m.routines)) {
          if (m.routines.length === 0) {
            routinesHtml = '<div class="routines-empty">(no routines visible)</div>';
          } else {
            routinesHtml = m.routines.map(r => routineHtml(m.task, m.name, r)).join('');
          }
        } else {
          routinesHtml = '<div class="routines-loading">Loading routines…</div>';
        }
      }
      return \`
        <div class="module-group \${expanded ? 'expanded' : ''}" data-task="\${escapeHtml(m.task)}" data-mod="\${escapeHtml(m.name)}">
          <div class="row module-row">
            <span class="twisty"></span>
            <span class="codicon \${sys ? 'codicon-gear icon-muted' : 'codicon-symbol-class icon-blue'}"></span>
            <span class="label">\${escapeHtml(m.name)}</span>
            <span class="type-badge">\${escapeHtml(m.type)}</span>
            <span class="row-actions">
              <button data-act="open"   data-name="\${escapeHtml(m.name)}">Open</button>
              \${sys ? '' : \`
                <button data-act="setpp"  data-name="\${escapeHtml(m.name)}">Set PP</button>
                <button data-act="unload" data-name="\${escapeHtml(m.name)}">Unload</button>
              \`}
            </span>
          </div>
          <div class="routines">\${routinesHtml}</div>
        </div>
      \`;
    }

    function renderTasks(tasks) {
      const root = $('modules-list');
      // Total module count for the tab badge - sum across active tasks
      const totalModules = tasks.reduce((n, t) => n + (t.active ? t.modules.length : 0), 0);
      $('count-modules').textContent = totalModules;

      if (tasks.length === 0) {
        root.innerHTML = '<div class="empty">No tasks reported. (Connect to a controller to populate.)</div>';
        return;
      }

      root.innerHTML = tasks.map(t => {
        // Default: motion task expanded; everything else collapsed.
        // User toggles override via expandedTasks set.
        const userToggled = expandedTasks.has('!' + t.name);   // explicit collapse
        const userExpanded = expandedTasks.has(t.name);
        const expanded = userExpanded || (!userToggled && t.motiontask && t.active);
        const stateBadge = t.excstate === 'running' ? '● running'
                          : t.excstate === 'stopped' ? '◌ stopped'
                          : t.excstate === 'ready'   ? '◌ ready'
                          : (t.excstate || t.taskstate || '');
        const kind = t.motiontask ? 'motion' : (t.type || '').toLowerCase();
        const meta = [kind, stateBadge, t.active ? '' : 'inactive'].filter(Boolean).join(' · ');
        const moduleListHtml = t.active
          ? (t.modules.length > 0
              ? t.modules.map(m => moduleRowHtml(m, expandedModules.has(m.task + ':' + m.name))).join('')
              : '<div class="task-empty">(no modules loaded)</div>')
          : '<div class="task-empty">(activate task to see modules)</div>';

        return \`
          <div class="task-group \${expanded ? 'expanded' : ''}" data-task="\${escapeHtml(t.name)}">
            <div class="task-row \${t.active ? '' : 'inactive'}">
              <span class="twisty"></span>
              <span class="codicon \${t.motiontask ? 'codicon-rocket icon-blue' : 'codicon-circle icon-muted'}"></span>
              <span class="name">\${escapeHtml(t.name)}</span>
              <span class="meta">\${escapeHtml(meta)}</span>
              <span class="row-actions">
                \${t.active
                  ? '<button data-act="task-deactivate" data-name="' + escapeHtml(t.name) + '">Deactivate</button>'
                  : '<button data-act="task-activate"   data-name="' + escapeHtml(t.name) + '">Activate</button>'}
              </span>
            </div>
            <div class="task-modules">\${moduleListHtml}</div>
          </div>
        \`;
      }).join('');

      // Wire task header twisty / row click → toggle
      root.querySelectorAll('.task-group').forEach(group => {
        const taskName = group.dataset.task;
        const onToggle = (e) => {
          if (e.target.closest('button[data-act]')) return;
          const wasExpanded = group.classList.contains('expanded');
          if (wasExpanded) {
            group.classList.remove('expanded');
            expandedTasks.delete(taskName);
            expandedTasks.add('!' + taskName);
          } else {
            group.classList.add('expanded');
            expandedTasks.add(taskName);
            expandedTasks.delete('!' + taskName);
          }
        };
        group.querySelector('.task-row .twisty').addEventListener('click', onToggle);
        group.querySelector('.task-row .name').addEventListener('click', onToggle);
      });

      // Task action buttons (activate / deactivate) → call commands with the task name
      root.querySelectorAll('.task-row button[data-act]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const name = btn.dataset.name;
          if (btn.dataset.act === 'task-activate')   cmd('abbRobot.activateTask',   name);
          if (btn.dataset.act === 'task-deactivate') cmd('abbRobot.deactivateTask', name);
        });
      });

      // Wire module twisty / row click → toggle module expansion (lazy fetch routines)
      root.querySelectorAll('.module-group').forEach(group => {
        const moduleKey = group.dataset.task + ':' + group.dataset.mod;
        const onToggle = (e) => {
          if (e.target.closest('button[data-act]')) return;
          if (group.classList.contains('expanded')) {
            expandedModules.delete(moduleKey);
            group.classList.remove('expanded');
            const r = group.querySelector('.routines');
            if (r) r.innerHTML = '';
          } else {
            expandedModules.add(moduleKey);
            group.classList.add('expanded');
            const m = findModule(group.dataset.task, group.dataset.mod);
            if (!m || !Array.isArray(m.routines)) {
              vscode.postMessage({ type: 'expandModule', task: group.dataset.task, module: group.dataset.mod });
              const r = group.querySelector('.routines');
              if (r) r.innerHTML = '<div class="routines-loading">Loading routines…</div>';
            }
          }
        };
        group.querySelector('.module-row .twisty').addEventListener('click', onToggle);
        group.querySelector('.module-row .label').addEventListener('click', onToggle);
      });

      // Module action buttons
      root.querySelectorAll('.module-row button[data-act]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const name = btn.dataset.name;
          const act = btn.dataset.act;
          if (act === 'open')   cmd('abbRobot.openModuleSource', name);
          if (act === 'setpp')  cmd('abbRobot.setPPToRoutine', name);
          if (act === 'unload') cmd('abbRobot.unloadModule', name);
        });
      });

      // Routine action buttons
      root.querySelectorAll('.routine-row button[data-act]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const act = btn.dataset.act;
          const mod = btn.dataset.mod;
          const name = btn.dataset.name;
          if (act === 'run-routine')   cmd('abbRobot.runRoutineFromCodeLens', mod, name);
          if (act === 'setpp-routine') cmd('abbRobot.setPPFromCodeLens',     mod, name);
        });
      });
    }

    function findModule(task, name) {
      for (const t of (currentTasks || [])) {
        if (t.name === task) return t.modules.find(m => m.name === name);
      }
      return null;
    }

    function renderWarnings(s) {
      const root = $('warning-area');
      const collisions = s.mainCollisionModules;
      if (!collisions || collisions.length < 2) {
        root.innerHTML = '';
        return;
      }
      root.innerHTML =
        '<div class="warning-banner">' +
          '<span class="codicon codicon-warning"></span>' +
          '<div class="body">' +
            '<div class="title">Two or more modules define <code>PROC main()</code></div>' +
            'While this collision exists, <strong>PP-to-Main and Set-PP fail</strong> with semantic-error code -519. ' +
            'Unload all but one to resolve.' +
            '<div class="module-list">Conflict: ' + collisions.map(m => escapeHtml(m)).join(' · ') + '</div>' +
          '</div>' +
        '</div>';
    }

    let currentTasks = [];

    // (legacy renderModules and currentModules removed - Tasks group is the new layout.)

    function renderWatches(ws) {
      const root = $('watch-list');
      $('count-watch').textContent = ws.length;
      if (ws.length === 0) {
        root.innerHTML = '<div class="empty">No watched variables.<br/><br/><button id="btn-add-watch-empty2">+ Add Variable</button></div>';
        const b = $('btn-add-watch-empty2');
        if (b) b.onclick = () => cmd('abbRobot.addWatch');
        return;
      }
      root.innerHTML = ws.map((w, i) => {
        const valHtml = w.error
          ? '<span class="watch-value error"><span class="codicon codicon-warning"></span> ' + escapeHtml(w.error.slice(0, 60)) + '</span>'
          : (w.value !== undefined
              ? '<span class="watch-value">' + escapeHtml(String(w.value).slice(0, 80)) + '</span>'
              : '<span class="watch-value">…</span>');
        return \`
          <div class="row" data-idx="\${i}">
            <span class="codicon codicon-symbol-variable icon-blue"></span>
            <span class="label">\${escapeHtml(w.module)}.\${escapeHtml(w.symbol)}</span>
            \${valHtml}
            <span class="row-actions">
              <button data-act="edit"   data-idx="\${i}">Edit</button>
              <button data-act="remove" data-idx="\${i}">Remove</button>
            </span>
          </div>
        \`;
      }).join('');
      root.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const idx = Number(btn.dataset.idx);
          const w = currentWatches[idx];
          if (!w) return;
          // The existing commands take a TreeItem-like arg with .entry;
          // we synthesize that shape so the same handler resolves the watch.
          const arg = { entry: w };
          if (btn.dataset.act === 'edit')   cmd('abbRobot.writeWatchValue', arg);
          if (btn.dataset.act === 'remove') cmd('abbRobot.removeWatch', arg);
        });
      });
    }

    let currentWatches = [];

    window.addEventListener('message', e => {
      const m = e.data;
      if (m?.type !== 'state') return;
      const s = m.data;
      paintBanner(s);
      updateActionButtons(s);
      renderWarnings(s);
      currentTasks = s.tasks || [];
      renderTasks(currentTasks);
      currentWatches = s.watches || [];
      renderWatches(currentWatches);
    });

    // Initial paint - show disabled state until first state arrives.
    updateActionButtons({ connected: false });
  </script>
</body>
</html>`;
  }
}
