import * as vscode from 'vscode';
import type { MultiRobotManager } from 'abb-rws-client';

/**
 * Content provider for the `abb-controller:` URI scheme - virtual, read-only
 * documents that contain the live RAPID source of a module on the connected
 * controller.
 *
 * URI shape: `abb-controller:/{task}/{module}.mod`
 *   e.g.  abb-controller:/T_ROB1/MotionTest.mod
 *
 * Why a custom scheme:
 *  - The previous approach used `untitled:IOTest.controller.mod` which VS Code
 *    treated as a real .mod file, so the right-click "Diff with controller"
 *    fired again and tried to fetch a module called `IOTest.controller` -
 *    resulting in HTTP 400 from the controller.
 *  - A custom scheme is read-only by design (no save/edit), so users can't
 *    accidentally edit "the controller's view" thinking it's the local copy.
 *  - The `editor/context` and `explorer/context` menu `when` clauses can
 *    exclude `abb-controller:` documents so the loop can't repeat.
 */
export class ControllerSourceProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly multi: MultiRobotManager) {}

  /** Build a URI that this provider can resolve. */
  static uriFor(task: string, moduleName: string, ext: string): vscode.Uri {
    // Use a path that includes the task and module so different tasks
    // displaying the same-named module don't collide.
    return vscode.Uri.parse(`abb-controller:/${encodeURIComponent(task)}/${encodeURIComponent(moduleName)}${ext}`);
  }

  /** Force VS Code to re-fetch a previously-opened controller URI. */
  refresh(uri: vscode.Uri): void { this._onDidChange.fire(uri); }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const active = this.multi.active;
    if (!active) { return '// Not connected to a robot.\n'; }

    // Path is /<task>/<module>.<ext>
    const parts = uri.path.replace(/^\//, '').split('/');
    if (parts.length < 2) { return '// Malformed controller-source URI.\n'; }
    const task = decodeURIComponent(parts[0]);
    const fileName = decodeURIComponent(parts.slice(1).join('/'));
    let moduleName = fileName.replace(/\.(mod|sys|prg)$/i, '');
    // Defensive: strip `.controller` / `.from-controller` suffix if some
    // earlier code path slipped one in. Real RAPID module names never
    // contain a dot - the controller would 400 on `MotionTest.controller`.
    moduleName = moduleName.replace(/\.(controller|from-controller)$/i, '');

    try {
      const src = await active.getModuleSource(task, moduleName);
      return src;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `! Failed to read ${task}/${moduleName} from controller:\n!   ${msg}\n`;
    }
  }
}
