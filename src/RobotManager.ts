import { RwsClient } from 'abb-rws-client';
import type { RapidTask, JointTarget, RobTarget, CartesianFull, ElogMessage, FileEntry, SystemInfo, ControllerIdentity, CollisionDetectionState, RapidSymbolProperties, RapidSymbolInfo, RapidSymbolSearchParams, UiInstruction, RestartMode, Signal } from 'abb-rws-client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SESSION_FILE = path.join(os.homedir(), '.abb-rws-session');

export interface RobotState {
  connected: boolean;
  host: string;
  ctrlstate: string | null;
  opmode: string | null;
  execstate: string | null;
  speedRatio: number | null;
  /** Collision detection state — null if the option is not installed on the controller */
  coldetstate: CollisionDetectionState | null;
  tasks: RapidTask[];
  modules: string[];
  joints: JointTarget | null;
  cartesian: RobTarget | null;
  cartesianFull: CartesianFull | null;
  identity: ControllerIdentity | null;
  systemInfo: SystemInfo | null;
  eventLog: ElogMessage[];
  ioSignals: Signal[];
}

type ChangeHandler = () => void;

export class RobotManager {
  // Reuse the same client instance across connect/disconnect cycles so the
  // controller session cookie is preserved — creating a new client creates a
  // new session and the controller returns 503 while the old one is still alive.
  private client: RwsClient | null = null;
  private clientConfig: { host: string; username: string; password: string } | null = null;
  private _state: RobotState = {
    connected: false,
    host: '',
    ctrlstate: null,
    opmode: null,
    execstate: null,
    speedRatio: null,
    coldetstate: null,
    tasks: [],
    modules: [],
    joints: null,
    cartesian: null,
    cartesianFull: null,
    identity: null,
    systemInfo: null,
    eventLog: [],
    ioSignals: [],
  };

  private handlers: ChangeHandler[] = [];
  private timer: NodeJS.Timeout | null = null;

  get state(): RobotState { return this._state; }

  onDidChange(handler: ChangeHandler) {
    this.handlers.push(handler);
  }

  private notify() {
    this.handlers.forEach(h => h());
  }

  async connect(host: string, username: string, password: string): Promise<void> {
    if (this._state.connected) await this.disconnect();

    // Load saved session cookie so we reuse the same controller session slot.
    // Without this, every extension reload creates a new session and the
    // controller hits its 70-session limit (503 "Too many sessions").
    const cfg = this.clientConfig;
    const sameConfig = cfg && cfg.host === host && cfg.username === username && cfg.password === password;
    if (!this.client || !sameConfig) {
      const sessionCookie = this.loadSessionCookie(host);
      this.client = new RwsClient({ host, username, password, sessionCookie: sessionCookie ?? undefined });
      this.clientConfig = { host, username, password };
    }

    await this.client.connect();

    // Save the session cookie after successful connect for next reload
    const cookie = this.client.getSessionCookie();
    if (cookie) this.saveSessionCookie(host, cookie);

    this._state.connected = true;
    this._state.host = host;
    this.notify();

    await this.fetchAll();

    // Poll every 1 second — no WebSocket needed
    this.timer = setInterval(() => this.fetchAll(), 1000);
  }

  async disconnect(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.client) { await this.client.disconnect().catch(() => {}); }
    // Keep this.client alive so reconnect reuses the same session cookie.

    this._state = {
      connected: false, host: '', ctrlstate: null, opmode: null,
      execstate: null, speedRatio: null, coldetstate: null, tasks: [], modules: [],
      joints: null, cartesian: null, cartesianFull: null,
      identity: null, systemInfo: null, eventLog: [], ioSignals: [],
    };
    this.notify();
  }

  async refresh(): Promise<void> {
    await this.fetchAll();
  }

  async startRapid(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.startRapid();
  }

  async stopRapid(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.stopRapid();
  }

  async resetRapid(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.resetRapid();
  }

  async setSpeedRatio(ratio: number): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.setSpeedRatio(ratio);
    this._state.speedRatio = ratio;
    this.notify();
  }

  /**
   * Turn motors on. Requires AUTO mode and holds RAPID mastership momentarily.
   */
  async setMotorsOn(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.requestMastership('rapid');
    try {
      await this.client.setControllerState('motoron');
    } finally {
      await this.client.releaseMastership('rapid').catch(() => {});
    }
  }

  /**
   * Turn motors off. Holds RAPID mastership momentarily.
   */
  async setMotorsOff(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.requestMastership('rapid');
    try {
      await this.client.setControllerState('motoroff');
    } finally {
      await this.client.releaseMastership('rapid').catch(() => {});
    }
  }

  async getRapidVariable(task: string, module: string, symbol: string): Promise<string> {
    if (!this.client) throw new Error('Not connected');
    return this.client.getRapidVariable(task, module, symbol);
  }

  async setRapidVariable(task: string, module: string, symbol: string, value: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.setRapidVariable(task, module, symbol, value);
  }

  async listDirectory(remotePath: string): Promise<FileEntry[]> {
    if (!this.client) throw new Error('Not connected');
    return this.client.listDirectory(remotePath);
  }

  async deleteControllerFile(remotePath: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.deleteFile(remotePath);
  }

  async refreshEventLog(): Promise<void> {
    if (!this.client) return;
    try {
      this._state.eventLog = await this.client.getEventLog(0, 'en');
      this.notify();
    } catch { /* non-fatal */ }
  }

  async clearEventLog(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.clearEventLog(0);
    this._state.eventLog = [];
    this.notify();
  }

  async getRapidSymbolProperties(task: string, module: string, symbol: string): Promise<RapidSymbolProperties> {
    if (!this.client) throw new Error('Not connected');
    return this.client.getRapidSymbolProperties(task, module, symbol);
  }

  async setExecutionCycle(cycle: 'once' | 'forever' | 'asis'): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.setExecutionCycle(cycle);
  }

  async createDirectory(parentPath: string, dirName: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.createDirectory(parentPath, dirName);
  }

  async copyControllerFile(sourcePath: string, destPath: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.copyFile(sourcePath, destPath);
  }

  async restartController(mode: RestartMode): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.restartController(mode);
  }

  async getControllerClock(): Promise<string> {
    if (!this.client) throw new Error('Not connected');
    const clock = await this.client.getControllerClock();
    return clock.datetime;
  }

  async getActiveUiInstruction(): Promise<UiInstruction | null> {
    if (!this.client) throw new Error('Not connected');
    return this.client.getActiveUiInstruction();
  }

  async searchRapidSymbols(params: RapidSymbolSearchParams): Promise<RapidSymbolInfo[]> {
    if (!this.client) throw new Error('Not connected');
    return this.client.searchRapidSymbols(params);
  }

  /**
   * Fetch all I/O signals from the controller (paginated) and update state.
   * Signals are fetched via the flat /rw/iosystem/signals endpoint.
   */
  async refreshIoSignals(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const PAGE = 100;
    let start = 0;
    const all: Signal[] = [];
    while (true) {
      const page = await this.client.listAllSignals(start, PAGE);
      all.push(...page);
      if (page.length < PAGE) break;
      start += PAGE;
    }
    this._state.ioSignals = all;
    this.notify();
  }

  /**
   * Write a value to an I/O signal using the flat signal endpoint.
   * Works for DO (use '0'/'1'), AO (use numeric string), GO (use integer string).
   */
  async writeIoSignal(name: string, value: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    // Pass empty network/device to use the flat /rw/iosystem/signals/{name}?action=set path
    await this.client.writeSignal('', '', name, value);
    // Update value in local state immediately for instant UI feedback
    const sig = this._state.ioSignals.find(s => s.name === name);
    if (sig) {
      sig.lvalue = value;
      sig.value  = value;
      this.notify();
    }
  }

  /**
   * Full "load program" sequence — mirrors the FlexPendant workflow:
   * 1. Unload all existing program modules (keep system ones)
   * 2. Upload the new .mod file to the controller filesystem
   * 3. Load it into the task
   * 4. PP to Main (reset program pointer)
   * 5. Refresh module list
   */
  async loadProgram(localFilePath: string, taskName: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');

    // 1. Unload all existing non-system modules
    const systemModules = ['user', 'BASE', 'DPUSER', 'DPBASE'];
    const current = await this.client.listModules(taskName);
    for (const mod of current) {
      if (!systemModules.includes(mod)) {
        await this.client.unloadModule(taskName, mod).catch(() => {/* ignore if already gone */});
      }
    }

    // 2. Upload file to controller filesystem
    const content = fs.readFileSync(localFilePath, 'utf8');
    const fileName = path.basename(localFilePath);
    const remotePath = `$HOME/${fileName}`;
    await this.client.uploadModule(remotePath, content);

    // 3. Load into task
    await this.client.loadModule(taskName, remotePath, true);

    // 4. Refresh state
    const modules = await this.client.listModules(taskName);
    this._state.modules = modules;
    this.notify();

    // 5. PP to Main — may fail if the module has no procedure named "main"
    await this.client.resetRapid().catch((e: unknown) => {
      // Attach as a non-fatal warning so the caller can show it
      throw Object.assign(
        new Error(`Module loaded but PP to Main failed: ${e instanceof Error ? e.message : String(e)}\n\nCheck that your module has a PROC main() or do PP to Main manually.`),
        { ppFailed: true },
      );
    });
  }

  /** @deprecated use loadProgram */
  async uploadAndLoad(localFilePath: string, taskName: string): Promise<void> {
    return this.loadProgram(localFilePath, taskName);
  }

  /**
   * Download a module from the controller and save it to a local file.
   * Returns the content string so the caller can write it anywhere.
   */
  async downloadModule(moduleName: string): Promise<string> {
    if (!this.client) throw new Error('Not connected');
    const remotePath = `$HOME/${moduleName}.mod`;
    return this.client.readFile(remotePath);
  }

  private loadSessionCookie(host: string): string | null {
    try {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      return (data[host] as string) ?? null;
    } catch { return null; }
  }

  private saveSessionCookie(host: string, cookie: string): void {
    try {
      let data: Record<string, string> = {};
      try { data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { /* new file */ }
      data[host] = cookie;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(data), 'utf8');
    } catch { /* non-fatal */ }
  }

  private fetchCount = 0;

  private async fetchAll(): Promise<void> {
    if (!this.client) return;
    try {
      const taskName = 'T_ROB1';
      const [ctrlstate, opmode, execstate, speedRatio, tasks, modules, joints, cartesianFull] = await Promise.all([
        this.client.getControllerState(),
        this.client.getOperationMode(),
        this.client.getRapidExecutionState(),
        this.client.getSpeedRatio(),
        this.client.getRapidTasks(),
        this.client.listModules(taskName),
        this.client.getJointPositions(),
        this.client.getCartesianFull(),
      ]);
      // Derive cartesian from cartesianFull (same data, different type)
      const cartesian = { x: cartesianFull.x, y: cartesianFull.y, z: cartesianFull.z,
        q1: cartesianFull.q1, q2: cartesianFull.q2, q3: cartesianFull.q3, q4: cartesianFull.q4 };
      Object.assign(this._state, { ctrlstate, opmode, execstate, speedRatio, tasks, modules, joints, cartesian, cartesianFull });

      // Collision detection — fetched with core state but silently ignored if option not installed
      const coldetstate = await this.client.getCollisionDetectionState().catch(() => null);
      this._state.coldetstate = coldetstate;

      // Fetch identity and event log less frequently (every 30s ≈ every 30 poll cycles)
      this.fetchCount++;
      if (this.fetchCount === 1 || this.fetchCount % 30 === 0) {
        const [identity, systemInfo, eventLog] = await Promise.all([
          this.client.getControllerIdentity().catch(() => null),
          this.client.getSystemInfo().catch(() => null),
          this.client.getEventLog(0, 'en').catch(() => [] as import('abb-rws-client').ElogMessage[]),
        ]);
        if (identity) this._state.identity = identity;
        if (systemInfo) this._state.systemInfo = systemInfo;
        this._state.eventLog = eventLog;
      }

      // Fetch I/O signals every 5s (every 5 poll cycles) to stay under rate limit
      if (this.fetchCount === 1 || this.fetchCount % 5 === 0) {
        const PAGE = 100;
        let start = 0;
        const all: Signal[] = [];
        try {
          while (true) {
            const page = await this.client.listAllSignals(start, PAGE);
            all.push(...page);
            if (page.length < PAGE) break;
            start += PAGE;
          }
          this._state.ioSignals = all;
        } catch { /* non-fatal */ }
      }

      this.notify();
    } catch {
      await this.disconnect();
    }
  }
}
