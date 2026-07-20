import * as vscode from 'vscode';
import type { MultiRobotManager } from 'abb-rws-client';

/**
 * "Live Cell" panel - a compact webview-based dashboard summarizing the
 * connected robot's runtime state in one glance:
 *
 *   ┌─ Live Cell ──────────────────┐
 *   │ ● RUNNING                    │
 *   │ AUTO  ·  100%                │
 *   ├──────────────────────────────┤
 *   │ Joints                       │
 *   │  J1  0.0°    J2 -23.5°       │
 *   │  J3 32.0°    J4   0.0°       │
 *   │  J5 90.0°    J6   0.0°       │
 *   ├──────────────────────────────┤
 *   │ TCP                          │
 *   │  X 425.3   Y 0.0   Z 521.7   │
 *   │  Q [1, 0, 0, 0]              │
 *   ├──────────────────────────────┤
 *   │ Active task: T_ROB1          │
 *   │ Module: MotionTest           │
 *   │ tool: weldGun · wobj: wobj0  │
 *   └──────────────────────────────┘
 *
 * Read-only - buttons / commands stay in the existing tree views and CodeLens.
 * This is purely an at-a-glance summary that updates ~once per second via
 * the manager's onDidChange event.
 *
 * The HTML uses VS Code theme variables (`var(--vscode-foreground)` etc.)
 * so it adapts to light, dark, and high-contrast themes automatically with
 * no per-theme CSS branches.
 */

interface LiveState {
  connected: boolean;
  host?: string;
  ctrlstate?: string;
  opmode?: string;
  execstate?: string;
  speed?: number;
  joints?: { rax_1?: number; rax_2?: number; rax_3?: number; rax_4?: number; rax_5?: number; rax_6?: number };
  cartesian?: { x?: number; y?: number; z?: number; q1?: number; q2?: number; q3?: number; q4?: number };
  activeTask?: string;
  taskCount?: number;
  loadedModules?: string[];
  rwVersion?: string;
}

export class LiveCellWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'abbRobot.liveCell';
  private view?: vscode.WebviewView;

  constructor(private readonly multi: MultiRobotManager) {
    // Push state to the webview on every manager change. The provider
    // outlives any single view instance - when the user collapses then
    // re-expands the panel, resolveWebviewView re-fires and we reattach.
    multi.onDidChange(() => this.postState());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml(view.webview.cspSource);
    view.onDidDispose(() => { this.view = undefined; });
    this.postState();
  }

  private postState(): void {
    if (!this.view) { return; }
    const s = this.multi.state;
    const active = this.multi.active;
    const state: LiveState = {
      connected: s.connected,
      host: s.host,
      ctrlstate: s.ctrlstate ?? undefined,
      opmode: s.opmode ?? undefined,
      execstate: s.execstate ?? undefined,
      speed: s.speedRatio ?? undefined,
      joints: s.joints ?? undefined,
      cartesian: s.cartesian ?? undefined,
      activeTask: s.tasks.find(t => t.active)?.name,
      taskCount: s.tasks.length,
      loadedModules: s.modules,
      rwVersion: s.systemInfo?.rwVersion,
    };
    void this.view.webview.postMessage({ type: 'state', data: state });
    // Suppress unused-var warning; `active` is reserved for future per-robot
    // extras (tool, wobj - currently in state.modules collateral).
    void active;
  }

  private renderHtml(cspSource: string): string {
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    body {
      margin: 0;
      padding: 8px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
    }
    .banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-radius: 4px;
      margin-bottom: 8px;
      font-weight: 600;
      letter-spacing: 0.3px;
      color: var(--vscode-statusBarItem-prominentForeground);
      background: var(--vscode-statusBarItem-prominentBackground);
    }
    .banner.connected.running {
      background: var(--vscode-statusBarItem-warningBackground);
      color: var(--vscode-statusBarItem-warningForeground);
    }
    .banner.connected.guardstop,
    .banner.connected.emergencystop {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    }
    .banner.disconnected {
      opacity: 0.6;
    }
    .banner-state { font-size: 13px; }
    .banner-mode  { font-size: 11px; opacity: 0.85; font-weight: 500; }

    .section {
      margin-top: 12px;
    }
    .section-title {
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      padding: 0 2px;
    }

    .joints {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }
    .joint {
      padding: 6px 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-textBlockQuote-background));
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 3px;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .joint-name {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      letter-spacing: 0.5px;
    }
    .joint-val {
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    .joint-val.dimmed { color: var(--vscode-descriptionForeground); }

    .tcp {
      padding: 6px 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-textBlockQuote-background));
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      line-height: 1.6;
    }
    .tcp .label {
      color: var(--vscode-descriptionForeground);
      width: 12px;
      display: inline-block;
    }

    .meta {
      font-size: 12px;
      line-height: 1.6;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
    }
    .meta-row .k { color: var(--vscode-descriptionForeground); }

    .footer {
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .dot.green  { background: var(--vscode-charts-green, #3fb950); }
    .dot.orange { background: var(--vscode-charts-orange, #d18616); }
    .dot.red    { background: var(--vscode-charts-red, #f85149); }
    .dot.gray   { background: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div id="banner" class="banner disconnected">
    <span class="banner-state"><span class="dot gray"></span><span id="state-label">NOT CONNECTED</span></span>
    <span class="banner-mode" id="mode-label"></span>
  </div>

  <div class="section">
    <div class="section-title">Joints (degrees)</div>
    <div class="joints">
      <div class="joint"><span class="joint-name">J1</span><span class="joint-val dimmed" id="j1">-</span></div>
      <div class="joint"><span class="joint-name">J2</span><span class="joint-val dimmed" id="j2">-</span></div>
      <div class="joint"><span class="joint-name">J3</span><span class="joint-val dimmed" id="j3">-</span></div>
      <div class="joint"><span class="joint-name">J4</span><span class="joint-val dimmed" id="j4">-</span></div>
      <div class="joint"><span class="joint-name">J5</span><span class="joint-val dimmed" id="j5">-</span></div>
      <div class="joint"><span class="joint-name">J6</span><span class="joint-val dimmed" id="j6">-</span></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">TCP position (mm) + quaternion</div>
    <div class="tcp" id="tcp">
      <div><span class="label">X</span> <span id="tcp-x">-</span> &nbsp; <span class="label">Y</span> <span id="tcp-y">-</span> &nbsp; <span class="label">Z</span> <span id="tcp-z">-</span></div>
      <div><span class="label">Q</span> <span id="tcp-q">-</span></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Active task</div>
    <div class="meta">
      <div class="meta-row"><span class="k">Task</span><span id="task">-</span></div>
      <div class="meta-row"><span class="k">Modules</span><span id="modules">-</span></div>
      <div class="meta-row"><span class="k">RobotWare</span><span id="rw">-</span></div>
    </div>
  </div>

  <div class="footer" id="footer-host">-</div>

  <script>
    const $ = (id) => document.getElementById(id);
    const fmt = (n, decimals = 1) => (typeof n === 'number' ? n.toFixed(decimals) : '-');

    function setJoint(id, n) {
      const el = $(id);
      if (typeof n === 'number') {
        el.textContent = fmt(n) + '°';
        el.classList.remove('dimmed');
      } else {
        el.textContent = '-';
        el.classList.add('dimmed');
      }
    }

    function paintBanner(state) {
      const banner = $('banner');
      banner.className = 'banner';
      if (!state.connected) {
        banner.classList.add('disconnected');
        $('state-label').innerHTML = '<span class="dot gray"></span>NOT CONNECTED';
        $('mode-label').textContent = '';
        return;
      }
      banner.classList.add('connected');
      const exec = (state.execstate || '').toLowerCase();
      const ctrl = (state.ctrlstate || '').toLowerCase();
      let dotClass = 'gray', label = exec.toUpperCase() || '-';
      if (ctrl === 'guardstop' || ctrl === 'emergencystop') {
        banner.classList.add(ctrl);
        dotClass = 'red';
        label = ctrl.replace(/-/g, ' ').toUpperCase();
      } else if (exec === 'running') {
        banner.classList.add('running');
        dotClass = 'green';
        label = '● RUNNING';
      } else if (ctrl === 'motoron') {
        dotClass = 'green';
        label = exec.toUpperCase() || 'READY';
      } else {
        dotClass = 'orange';
        label = (ctrl || 'UNKNOWN').toUpperCase();
      }
      $('state-label').innerHTML = '<span class="dot ' + dotClass + '"></span>' + label;
      const speed = (typeof state.speed === 'number') ? state.speed + '%' : '';
      const mode  = state.opmode || '';
      $('mode-label').textContent = [mode, speed].filter(Boolean).join(' · ');
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || msg.type !== 'state') return;
      const s = msg.data;

      paintBanner(s);

      // Joints
      const j = s.joints || {};
      setJoint('j1', j.rax_1);
      setJoint('j2', j.rax_2);
      setJoint('j3', j.rax_3);
      setJoint('j4', j.rax_4);
      setJoint('j5', j.rax_5);
      setJoint('j6', j.rax_6);

      // TCP
      const c = s.cartesian || {};
      $('tcp-x').textContent = fmt(c.x);
      $('tcp-y').textContent = fmt(c.y);
      $('tcp-z').textContent = fmt(c.z);
      const q = [c.q1, c.q2, c.q3, c.q4].map(v => typeof v === 'number' ? v.toFixed(3) : '-');
      $('tcp-q').textContent = '[' + q.join(', ') + ']';

      // Meta
      $('task').textContent    = s.activeTask ? (s.activeTask + (s.taskCount > 1 ? ' (' + s.taskCount + ' tasks)' : '')) : '-';
      $('modules').textContent = s.loadedModules && s.loadedModules.length ? s.loadedModules.join(', ') : '-';
      $('rw').textContent      = s.rwVersion || '-';

      // Footer
      $('footer-host').textContent = s.connected ? ('Connected to ' + (s.host || '?')) : 'No robot connected';
    });
  </script>
</body>
</html>`;
  }
}
