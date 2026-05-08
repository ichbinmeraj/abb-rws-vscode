import * as vscode from 'vscode';
import type { RobotManager, MultiRobotManager } from 'abb-rws-client';
import { Logger } from './Logger';

/**
 * Modules panel — shows the controller's loaded program in a hierarchical tree.
 *
 * Structure:
 *   Status row              (Mode / Motors / Cycle)
 *   ── Actions ──
 *   • Motors On/Off
 *   • Load Program from File…
 *   • Start / Stop Program
 *   • PP to Main
 *   ── Loaded Modules ──    (one item per loaded module)
 *   • 📄 MotionTest          (ProgMod, has main)        ← expandable
 *     • ▶ main               [PP HERE]                  ← current routine highlighted
 *     • ▶ testWave
 *     • ▶ testJoints
 *     • …
 *   • 📄 TestMotion          (ProgMod, has main)  ⚠ collision
 *     • ▶ main
 *     • …
 *   • 🔧 BASE                (SysMod)                   ← system modules muted
 *   • 🔧 user                (SysMod)
 *
 * "Loaded" = in the controller's runtime memory (= will execute when started).
 * Files on disk are shown in a SEPARATE panel ($HOME File Explorer).
 * Unloading a module removes it from runtime ONLY; the .mod file on disk
 * is untouched (verified live).
 *
 * Right-click a module → Set PP to Routine, Unload Module.
 * Right-click a routine → Set PP at this routine + Run.
 * The CodeLens above each routine in a .mod file does the same thing inline.
 */

type TaskNode = {
  kind: 'task';
  name: string;            // 'T_ROB1' | 'T_BCKGRND' | …
  type: string;            // 'Normal' | 'Static' | 'SemiStatic' (background)
  taskstate: string;       // 'started' | 'stopped'
  excstate: string;        // 'running' | 'stopped' | 'ready' | …
  active: boolean;         // included in current task selection
  motiontask: boolean;     // controls a robot
};

type ModuleNode = {
  kind: 'module';
  task: string;            // owning task — needed because module names can repeat across tasks
  name: string;
  type: string;            // 'ProgMod' | 'SysMod' | … from controller
  hasMain: boolean;
  collision: boolean;      // multiple loaded modules each have `main`
  isPPHere: boolean;       // PP currently in this module
};

type RoutineNode = {
  kind: 'routine';
  task: string;
  module: string;
  name: string;
  symtyp: string;          // 'prc' | 'fun' | 'trp'
  isPPHere: boolean;
  local: boolean;
};

type StatusNode = { kind: 'status'; label: string; description: string; icon: string; tooltip?: string };
type ActionNode = { kind: 'action'; label: string; description: string; icon: string; command?: vscode.Command; tooltip?: string };
type SectionNode = { kind: 'section'; label: string };

type Node = StatusNode | ActionNode | SectionNode | TaskNode | ModuleNode | RoutineNode;

class TreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    state: vscode.TreeItemCollapsibleState,
    public readonly node: Node,
  ) {
    super(label, state);
  }
}

export class ModulesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChange = new vscode.EventEmitter<TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  /**
   * Routines keyed by `${task}:${module}` — fetched lazily on first expand,
   * persisted across refreshes (clearing every poll-tick race-conditioned with
   * VS Code's getChildren(moduleItem) reads).
   */
  private routinesByModule = new Map<string, Array<{ name: string; symtyp: string; local: boolean }>>();
  /** Modules per task — `${task}` → list, with type info for collision/sysmod detection. */
  private modulesByTask = new Map<string, Array<{ name: string; type: string }>>();
  /** Per-task signature ("MotionTest|user") for change detection — only refetch routines when the per-task module set changes. */
  private lastModulesKeyByTask = new Map<string, string>();
  /** Per-task PP location for the "PP HERE" marker. */
  private currentPPByTask = new Map<string, { module?: string; routine?: string }>();
  /** Single-flight guards keyed by task. */
  private fetchingRoutinesByTask = new Set<string>();
  private fetchingMetaByTask = new Set<string>();

  private routineKey(task: string, module: string): string { return `${task}:${module}`; }

  constructor(private manager: MultiRobotManager) {}

  /**
   * Get the active RobotManager — that's where listRoutines / listModulesDetailed /
   * getCurrentPP live. We were previously calling these on the MultiRobotManager
   * which proxies state but NOT these methods → silent throw → empty cache.
   */
  private get active(): RobotManager | undefined { return this.manager.active ?? undefined; }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: TreeItem): vscode.TreeItem { return el; }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    const { connected } = this.manager.state;
    Logger.trace('tree', `getChildren connected=${connected} kind=${element?.node.kind ?? 'root'} name=${(element?.node as { name?: string })?.name ?? '-'}`);
    if (!connected) {
      return [this.makeItem({ kind: 'status', label: 'Not connected', description: 'click Connect first', icon: 'circle-slash' })];
    }

    // ROUTINES — children of a ModuleNode
    if (element && element.node.kind === 'module') {
      const moduleNode = element.node;
      const taskName = moduleNode.task;
      const moduleName = moduleNode.name;
      const key = this.routineKey(taskName, moduleName);
      const routines = this.routinesByModule.get(key);
      Logger.trace('tree', `module=${taskName}.${moduleName} cached=${routines === undefined ? 'no' : `yes(${routines.length})`}`);
      if (routines === undefined) {
        this.fetchRoutinesForModule(taskName, moduleName);
        return [this.makeItem({ kind: 'status', label: 'Loading routines…', description: '', icon: 'sync' })];
      }
      if (routines.length === 0) {
        return [this.makeItem({ kind: 'status', label: '(no routines visible — try unloading then reloading the module)', description: '', icon: 'info' })];
      }
      const pp = this.currentPPByTask.get(taskName) ?? {};
      return routines.map(r => this.makeItem({
        kind: 'routine',
        task: taskName,
        module: moduleName,
        name: r.name,
        symtyp: r.symtyp,
        local: r.local,
        isPPHere: pp.module === moduleName && pp.routine === r.name,
      }));
    }

    // MODULES — children of a TaskNode
    if (element && element.node.kind === 'task') {
      const taskName = element.node.name;
      await this.refreshTaskMeta(taskName);
      await this.maybeRefetchRoutines(taskName);
      const mods = this.modulesByTask.get(taskName) ?? [];
      const pp = this.currentPPByTask.get(taskName) ?? {};
      const sysTypes = new Set(['SysMod', 'sysmod', 'SysMod NoStepIn', 'SysMod ViewOnly', 'SysMod ReadOnly']);
      const modulesWithMain = new Set<string>();
      for (const m of mods) {
        const rs = this.routinesByModule.get(this.routineKey(taskName, m.name)) ?? [];
        if (rs.some(r => r.name.toLowerCase() === 'main')) { modulesWithMain.add(m.name); }
      }
      const collision = modulesWithMain.size >= 2;
      const out: TreeItem[] = [];
      if (collision) {
        out.push(this.makeItem({
          kind: 'status',
          label: '⚠ Two or more modules define PROC main()',
          description: 'unload all but one to fix Set-PP errors',
          icon: 'warning',
          tooltip: `Modules with main(): ${[...modulesWithMain].join(', ')}\n\nWhile this collision exists, the controller rejects ALL Set-PP calls with "Semantic error".\nRight-click a module below → Unload Module.`,
        }));
      }
      if (mods.length === 0) {
        out.push(this.makeItem({ kind: 'status', label: 'No modules loaded in this task', description: '', icon: 'info' }));
        return out;
      }
      const sorted = [...mods].sort((a, b) => {
        const aSys = sysTypes.has(a.type) ? 1 : 0;
        const bSys = sysTypes.has(b.type) ? 1 : 0;
        if (aSys !== bSys) { return aSys - bSys; }
        return a.name.localeCompare(b.name);
      });
      for (const m of sorted) {
        const rs = this.routinesByModule.get(this.routineKey(taskName, m.name)) ?? [];
        const hasMain = rs.some(r => r.name.toLowerCase() === 'main');
        out.push(this.makeItem({
          kind: 'module',
          task: taskName,
          name: m.name,
          type: m.type,
          hasMain,
          collision: hasMain && collision,
          isPPHere: pp.module === m.name,
        }));
      }
      return out;
    }

    // ROOT — Status row + Actions + Tasks list
    const items: TreeItem[] = [];
    const { execstate, ctrlstate, opmode, execCycle, tasks } = this.manager.state;
    const isRunning = execstate === 'running';
    const motorOn = ctrlstate === 'motoron';
    const isAuto = opmode === 'AUTO';

    // Status row
    items.push(this.makeItem({
      kind: 'status',
      label: isRunning ? '● RUNNING' : motorOn ? `Ready (${opmode})` : `Motors ${ctrlstate ?? '?'}`,
      description: `cycle: ${execCycle ?? '?'}`,
      icon: isRunning ? 'play-circle' : motorOn ? 'check' : 'warning',
      tooltip: `Controller state: ${ctrlstate}\nOperation mode: ${opmode}\nExecution: ${execstate}\nCycle: ${execCycle}`,
    }));

    // Actions
    items.push(this.makeItem({ kind: 'section', label: '── Actions ──' }));
    if (motorOn) {
      items.push(this.makeItem({
        kind: 'action', label: 'Motors Off', description: '', icon: 'debug-stop',
        command: { title: 'Motors Off', command: 'abbRobot.motorsOff' },
      }));
    } else if (isAuto) {
      items.push(this.makeItem({
        kind: 'action', label: 'Motors On', description: 'AUTO mode', icon: 'zap',
        command: { title: 'Motors On', command: 'abbRobot.motorsOn' },
      }));
    } else {
      items.push(this.makeItem({
        kind: 'action', label: 'Enable Motors on FlexPendant', description: opmode ?? '?', icon: 'warning',
        tooltip: 'Switch to AUTO on the FlexPendant first',
      }));
    }
    items.push(this.makeItem({
      kind: 'action', label: 'Load Program from File…', description: 'pick a .mod file', icon: 'cloud-upload',
      command: { title: 'Load', command: 'abbRobot.uploadModule' },
    }));
    if (isRunning) {
      items.push(this.makeItem({
        kind: 'action', label: 'Stop Program', description: '', icon: 'debug-stop',
        command: { title: 'Stop', command: 'abbRobot.stopRapid' },
      }));
    } else {
      items.push(this.makeItem({
        kind: 'action', label: 'Start Program', description: motorOn && isAuto ? 'from current PP' : 'need motors + AUTO', icon: 'play',
        command: motorOn && isAuto ? { title: 'Start', command: 'abbRobot.startRapid' } : undefined,
      }));
      items.push(this.makeItem({
        kind: 'action', label: 'PP to Main', description: '', icon: 'debug-restart',
        command: { title: 'PP to Main', command: 'abbRobot.ppToMain' },
      }));
    }

    // Tasks section — one node per RAPID task
    items.push(this.makeItem({ kind: 'section', label: '── Tasks ──' }));
    if (!this.active) {
      Logger.warn('tree: no active RobotManager');
      items.push(this.makeItem({ kind: 'status', label: 'No robot active', description: 'connect from the Robots panel', icon: 'circle-slash' }));
      return items;
    }
    if (tasks.length === 0) {
      items.push(this.makeItem({ kind: 'status', label: 'No RAPID tasks reported', description: 'still connecting?', icon: 'sync' }));
      return items;
    }
    // Sort: motion tasks first (T_ROB1 etc), then background/static.
    const sortedTasks = [...tasks].sort((a, b) => {
      if (a.motiontask !== b.motiontask) { return a.motiontask ? -1 : 1; }
      if (a.active !== b.active) { return a.active ? -1 : 1; }
      return a.name.localeCompare(b.name);
    });
    for (const t of sortedTasks) {
      items.push(this.makeItem({
        kind: 'task',
        name: t.name,
        type: t.type,
        taskstate: t.taskstate,
        excstate: t.excstate,
        active: t.active,
        motiontask: t.motiontask,
      }));
    }
    return items;
  }

  /** Refresh modules + PP for one task. Single-flight per task. Idempotent on calls. */
  private async refreshTaskMeta(taskName: string): Promise<void> {
    if (this.fetchingMetaByTask.has(taskName)) { return; }
    const active = this.active;
    if (!active) { return; }
    this.fetchingMetaByTask.add(taskName);
    try {
      try {
        const mods = await active.listModulesDetailed(taskName);
        this.modulesByTask.set(taskName, mods);
        Logger.trace('tree', `${taskName}.listModulesDetailed count=${mods.length} mods=${mods.map(m => `${m.name}(${m.type})`).join(',')}`);
      } catch (e) {
        // fallback for non-active tasks: state.modules is the active task's only
        const fallback = active.state.modules.map(n => ({ name: n, type: '' }));
        this.modulesByTask.set(taskName, fallback);
        Logger.warn(`tree.${taskName}.listModulesDetailed failed: ${String(e)} fallback=${fallback.length}`);
      }
      try {
        const pp = (await active.getCurrentPP(taskName)) ?? {};
        this.currentPPByTask.set(taskName, pp);
      } catch { this.currentPPByTask.set(taskName, {}); }
    } finally {
      this.fetchingMetaByTask.delete(taskName);
    }
  }

  /** If this task's module-set has changed, refetch routines for each program module. */
  private async maybeRefetchRoutines(taskName: string): Promise<void> {
    const active = this.active;
    if (!active) { return; }
    const mods = this.modulesByTask.get(taskName) ?? [];
    const sysTypes = new Set(['SysMod', 'sysmod', 'SysMod NoStepIn', 'SysMod ViewOnly', 'SysMod ReadOnly']);
    const programMods = mods.filter(m => !sysTypes.has(m.type)).map(m => m.name).sort();
    const key = programMods.join('|');
    const lastKey = this.lastModulesKeyByTask.get(taskName) ?? '';
    if (key === lastKey) { return; }
    if (this.fetchingRoutinesByTask.has(taskName)) { return; }
    this.fetchingRoutinesByTask.add(taskName);
    this.lastModulesKeyByTask.set(taskName, key);
    // Drop stale entries
    for (const k of [...this.routinesByModule.keys()]) {
      if (k.startsWith(`${taskName}:`)) {
        const m = k.slice(taskName.length + 1);
        if (!programMods.includes(m)) { this.routinesByModule.delete(k); }
      }
    }
    Logger.info(`tree.${taskName}.routineFetch start count=${programMods.length} modules=[${programMods.join(',')}]`);
    try {
      for (const name of programMods) {
        try {
          const rs = await active.listRoutines(taskName, name);
          this.routinesByModule.set(this.routineKey(taskName, name), rs);
          Logger.info(`tree.${taskName}.routineFetch ${name}: ${rs.length} routines [${rs.map(r => r.name).join(',')}]`);
        } catch (e) {
          this.routinesByModule.set(this.routineKey(taskName, name), []);
          Logger.warn(`tree.${taskName}.routineFetch ${name}: FAILED ${String(e)}`);
        }
      }
    } finally {
      this.fetchingRoutinesByTask.delete(taskName);
    }
    this._onDidChange.fire();
  }

  // ─── Lazy single-module routine fetch ─────────────────────────────────────

  /** Map of in-flight per-module fetches — prevents duplicate parallel fetches. */
  private moduleFetchInFlight = new Map<string, Promise<void>>();

  /**
   * Kick off a fetch for one module's routines. Idempotent: if a fetch is
   * already in flight for this module, returns the existing promise.
   * Fires onDidChange when the fetch completes so the tree re-renders.
   */
  private fetchRoutinesForModule(taskName: string, moduleName: string): Promise<void> {
    const key = this.routineKey(taskName, moduleName);
    const existing = this.moduleFetchInFlight.get(key);
    if (existing) { return existing; }
    const p = (async () => {
      const active = this.active;
      if (!active) {
        this.routinesByModule.set(key, []);
        return;
      }
      try {
        const rs = await active.listRoutines(taskName, moduleName);
        this.routinesByModule.set(key, rs);
        Logger.info(`tree.fetchOne ${taskName}.${moduleName}: ${rs.length} routines [${rs.map(r => r.name).join(',')}]`);
      } catch (e) {
        this.routinesByModule.set(key, []);
        Logger.warn(`tree.fetchOne ${taskName}.${moduleName}: FAILED ${String(e)}`);
      } finally {
        this.moduleFetchInFlight.delete(key);
        this._onDidChange.fire();
      }
    })();
    this.moduleFetchInFlight.set(key, p);
    return p;
  }

  // ─── Item rendering ───────────────────────────────────────────────────────

  private makeItem(node: Node): TreeItem {
    let label = '';
    let description = '';
    let icon = 'circle-outline';
    let iconColor: string | undefined;
    let tooltip: string | undefined;
    let command: vscode.Command | undefined;
    let collapsibleState = vscode.TreeItemCollapsibleState.None;
    let contextValue: string | undefined;

    switch (node.kind) {
      case 'status':
      case 'section':
      case 'action': {
        label = node.label;
        if (node.kind !== 'section') {
          description = node.description ?? '';
          icon = (node as StatusNode | ActionNode).icon;
          tooltip = (node as StatusNode | ActionNode).tooltip;
          // Color status/action icons by the icon name itself so the visual
          // grammar stays consistent (warning → orange, play* → green, etc.).
          iconColor = icon === 'warning' || icon === 'sync'   ? 'charts.orange'
                    : icon === 'error' || icon === 'circle-slash' ? 'errorForeground'
                    : icon === 'play-circle' || icon === 'play' || icon === 'check' || icon === 'pass' ? 'charts.green'
                    : icon === 'zap' ? 'charts.yellow'
                    : icon === 'cloud-upload' || icon === 'debug-restart' ? 'charts.blue'
                    : undefined;
        }
        if (node.kind === 'action') { command = node.command; }
        break;
      }
      case 'task': {
        label = node.name;
        const exec = node.excstate;
        const stateBadge = exec === 'running' ? '● running'
                         : exec === 'stopped' ? '◌ stopped'
                         : exec === 'ready'   ? '◌ ready'
                         : exec || node.taskstate;
        const kind = node.motiontask ? 'motion' : node.type === 'Normal' ? 'normal' : node.type.toLowerCase();
        description = `${kind} • ${stateBadge}` + (node.active ? '' : ' • inactive');
        icon = node.motiontask
          ? (exec === 'running' ? 'play-circle' : 'rocket')
          : 'symbol-misc';
        iconColor = !node.active                 ? 'descriptionForeground'
                  : exec === 'running'           ? 'charts.green'
                  : node.motiontask              ? 'charts.blue'
                  : 'descriptionForeground';
        contextValue = node.active ? 'rapidTaskActive' : 'rapidTaskInactive';
        tooltip = `Task: ${node.name}\n` +
                  `Type: ${node.type}\n` +
                  `Motion task: ${node.motiontask ? 'yes (controls a robot)' : 'no (background/static)'}\n` +
                  `Active: ${node.active ? 'yes — included in current task selection' : 'no — excluded from current cycle'}\n` +
                  `Task state: ${node.taskstate}\n` +
                  `Execution: ${node.excstate}\n\n` +
                  `Expand to see modules loaded in this task.\n` +
                  `Right-click for activate/deactivate.`;
        collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        break;
      }
      case 'module': {
        label = node.name;
        description = node.type
          + (node.hasMain ? ' • has main' : '')
          + (node.isPPHere ? ' • PP here' : '');
        const sysTypes = ['SysMod', 'sysmod'];
        const isSys = sysTypes.includes(node.type);
        icon = isSys ? 'gear' : 'file-code';
        iconColor = node.collision ? 'errorForeground'
                  : node.isPPHere  ? 'charts.blue'
                  : isSys          ? 'descriptionForeground'
                  : undefined;
        contextValue = isSys ? 'systemModule' : 'programModule';
        tooltip = `${node.name} (${node.type || 'unknown type'})\n` +
                  `Loaded in ${node.task}.\n` +
                  (node.hasMain ? '✓ Defines PROC main()\n' : '') +
                  (node.collision ? '⚠ Conflicts with another module that also has main\n' : '') +
                  (node.isPPHere ? '▶ Program pointer is currently in this module\n' : '') +
                  '\nRight-click → Set PP to Routine / Unload Module.\n' +
                  'Unload removes the module from controller runtime; the file on disk is preserved.';
        collapsibleState = isSys
          ? vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Collapsed;
        break;
      }
      case 'routine': {
        label = node.name;
        const kindLabel = node.symtyp === 'prc' ? 'PROC' : node.symtyp === 'fun' ? 'FUNC' : node.symtyp === 'trp' ? 'TRAP' : node.symtyp.toUpperCase();
        description = kindLabel + (node.local ? ' • LOCAL' : '') + (node.isPPHere ? ' • ▶ PP HERE' : '');
        icon = node.isPPHere ? 'debug-stackframe' :
               node.symtyp === 'prc' ? 'symbol-method' :
               node.symtyp === 'fun' ? 'symbol-function' :
               'zap';
        iconColor = node.isPPHere   ? 'charts.blue'
                  : node.local      ? 'descriptionForeground'
                  : undefined;
        contextValue = 'routine';
        tooltip = `${kindLabel} ${node.module}.${node.name}` +
                  (node.local ? '\nLocal — only visible inside this module.' : '') +
                  (node.isPPHere ? '\n\nProgram pointer is currently here.' : '') +
                  '\n\nTo run this routine: open the .mod file and click "▶ Run this routine" CodeLens above the PROC.';
        // No click-to-run on the tree — too easy to trigger accidentally.
        // Routines are run via the CodeLens ▶ in the .mod file editor (explicit, intentional).
        break;
      }
    }

    const item = new TreeItem(label, collapsibleState, node);
    item.description = description;
    item.iconPath = iconColor
      ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(iconColor))
      : new vscode.ThemeIcon(icon);
    if (tooltip) { item.tooltip = tooltip; }
    if (command) { item.command = command; }
    if (contextValue) { item.contextValue = contextValue; }
    return item;
  }
}
