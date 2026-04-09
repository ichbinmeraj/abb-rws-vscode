import { RwsClient } from 'abb-rws-client';
import type { RapidTask, JointTarget, RobTarget } from 'abb-rws-client';
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
  tasks: RapidTask[];
  modules: string[];
  joints: JointTarget | null;
  cartesian: RobTarget | null;
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
    tasks: [],
    modules: [],
    joints: null,
    cartesian: null,
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
      execstate: null, tasks: [], modules: [], joints: null, cartesian: null,
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

  private async fetchAll(): Promise<void> {
    if (!this.client) return;
    try {
      const taskName = 'T_ROB1';
      const [ctrlstate, opmode, execstate, tasks, modules, joints, cartesian] = await Promise.all([
        this.client.getControllerState(),
        this.client.getOperationMode(),
        this.client.getRapidExecutionState(),
        this.client.getRapidTasks(),
        this.client.listModules(taskName),
        this.client.getJointPositions(),
        this.client.getCartesianPosition(),
      ]);
      Object.assign(this._state, { ctrlstate, opmode, execstate, tasks, modules, joints, cartesian });
      this.notify();
    } catch {
      await this.disconnect();
    }
  }
}
