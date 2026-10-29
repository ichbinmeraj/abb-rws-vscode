import * as vscode from 'vscode';
import type { MultiRobotManager } from 'abb-rws-client';
import { quietTask } from './taskResolver';

/**
 * Decorates the editor at the controller's current Program Pointer (PP)
 * location. Whenever the PP of the task an open file belongs to (its
 * recorded task, or the one task that lists its module: src/taskResolver.ts)
 * is in that file, the line is highlighted and a `▶` is shown in the
 * gutter - exactly like a debugger paused at a breakpoint, except it's
 * the live RAPID interpreter on the controller.
 *
 * Subscribes to the manager's state-change event and refreshes whenever
 * the PP could have moved. A file whose task the rule cannot settle gets no
 * marker: on a multi-task system the first task's PP is not shown in it.
 */
export class PpDecoration implements vscode.Disposable {
  private readonly lineDecoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private polling = false;

  constructor(
    private readonly multi: MultiRobotManager,
    /** The task a file was pulled from (src/fileOrigins.ts), if recorded. */
    private readonly recordedTask: (fsPath: string) => string | undefined = () => undefined,
  ) {
    this.lineDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.makeArrowIcon(),
      gutterIconSize: 'contain',
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    // multi.onDidChange returns void (no unsubscribe handle); we just
    // accept that this listener lives until the extension is disposed.
    this.multi.onDidChange(() => this.refresh());
    this.disposables.push(
      this.lineDecoration,
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
    );
    void this.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
  }

  private async refresh(): Promise<void> {
    if (this.polling) { return; }
    this.polling = true;
    try {
      const editors = vscode.window.visibleTextEditors.filter(ed =>
        /\.(mod|sys|prg)$/i.test(ed.document.fileName),
      );
      if (editors.length === 0) { return; }
      if (!this.multi.state.connected || !this.multi.active) {
        for (const ed of editors) { ed.setDecorations(this.lineDecoration, []); }
        return;
      }

      // Each file's task, then one PP read per task.
      const state = this.multi.state;
      const docs = editors.map(ed => {
        const m = /\bMODULE\s+(\w+)/i.exec(ed.document.getText());
        const module = m ? m[1] : '';
        const task = module ? quietTask(state, { module, recorded: this.recordedTask(ed.document.fileName) }) : undefined;
        return { ed, module: module.toLowerCase(), task };
      });
      const active = this.multi.active;
      const pps = new Map<string, Awaited<ReturnType<typeof active.getCurrentPP>> | null>();
      for (const task of new Set(docs.map(d => d.task).filter((t): t is string => !!t))) {
        pps.set(task, await active.getCurrentPP(task).catch(() => null));
      }

      for (const { ed, module, task } of docs) {
        const pp = task ? pps.get(task) : null;
        const ppLine = pp?.row !== undefined ? Math.max(0, pp.row - 1) : -1;   // controller is 1-based, editor is 0-based
        if (pp && pp.module && pp.module.toLowerCase() === module && ppLine >= 0 && ppLine < ed.document.lineCount) {
          const range = ed.document.lineAt(ppLine).range;
          ed.setDecorations(this.lineDecoration, [{
            range,
            hoverMessage: new vscode.MarkdownString(
              `**▶ Program pointer here**\n\n` +
              `Task: ${task}\n\n` +
              `Module: ${pp.module}\n\n` +
              `Routine: ${pp.routine ?? '(unknown)'}\n\n` +
              `Row: ${pp.row}` + (pp.col !== undefined ? `, Col: ${pp.col}` : ''),
            ),
          }]);
        } else {
          ed.setDecorations(this.lineDecoration, []);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** Draw a small green right-arrow as the gutter icon. Inline SVG keeps it
   *  resolution-independent and avoids shipping a binary asset. */
  private makeArrowIcon(): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#3fb950" d="M3 2 L13 8 L3 14 Z"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  }
}
