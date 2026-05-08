import * as vscode from 'vscode';

/**
 * CodeLens provider for RAPID source files.
 *
 * Renders clickable annotations above every routine declaration
 * (PROC, FUNC, TRAP). Each routine gets two lenses:
 *
 *     ▶ Run this routine        ▶ Set PP here
 *     PROC mainSinglePass()
 *
 * Clicking a lens invokes a command that sets the program pointer at the
 * routine and (for ▶ Run) immediately starts execution. Module name comes
 * from a `MODULE <name>` declaration at the top of the file (or falls back
 * to the file's base name without extension).
 *
 * Why a CodeLens (vs. the tree-panel button alone):
 *   - inline, immediately discoverable
 *   - works while you're EDITING the file — no tree navigation
 *   - visually anchors PP-to-Routine to the code, which is the right place
 */

export class RapidCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  /** Re-emit lenses when the user types — VS Code calls provideCodeLenses again on each fire. */
  refresh(): void { this._onDidChange.fire(); }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const moduleName = this.detectModuleName(document);
    const lenses: vscode.CodeLens[] = [];

    // Routine declaration regex: optional LOCAL, then PROC/FUNC <type>/TRAP, then name, then `(`
    // FUNC has a return-type token in between, so we capture it loosely.
    //   LOCAL PROC name(           → kind=PROC, name
    //   PROC name(                 → kind=PROC, name
    //   FUNC num name(             → kind=FUNC, name
    //   LOCAL FUNC robtarget name( → kind=FUNC, name
    //   TRAP name                  → kind=TRAP, name (no parens)
    const routineRe = /^\s*(?:LOCAL\s+)?(?:(PROC)\s+(\w+)\s*\(|(FUNC)\s+\w+\s+(\w+)\s*\(|(TRAP)\s+(\w+))/i;

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text;
      // Skip comment-only lines
      if (text.trim().startsWith('!')) { continue; }
      const m = text.match(routineRe);
      if (!m) { continue; }
      const kind = (m[1] || m[3] || m[5]).toUpperCase() as 'PROC' | 'FUNC' | 'TRAP';
      const name = m[2] || m[4] || m[6];
      // Anchor lenses to the routine's name token (precise) — fall back to start-of-line
      const idx = text.indexOf(name, text.search(/\S/));
      const range = idx >= 0
        ? new vscode.Range(i, idx, i, idx + name.length)
        : new vscode.Range(i, 0, i, text.length);

      // ▶ Run — set PP at this routine + start
      const runLens = new vscode.CodeLens(range, {
        title: kind === 'TRAP' ? '▶ (TRAP — interrupt handler, not directly runnable)' : '▶ Run this routine',
        command: kind === 'TRAP' ? '' : 'abbRobot.runRoutineFromCodeLens',
        arguments: [moduleName, name, kind],
      });
      lenses.push(runLens);

      if (kind !== 'TRAP') {
        // ▶ Set PP — just set, don't start
        const ppLens = new vscode.CodeLens(range, {
          title: '▶ Set PP here',
          command: 'abbRobot.setPPFromCodeLens',
          arguments: [moduleName, name, kind],
        });
        lenses.push(ppLens);
      }
    }

    return lenses;
  }

  /**
   * Detect the module name from the file:
   *   1. `MODULE <name>` declaration in the first ~30 lines.
   *   2. Fall back to file basename without `.mod`/`.sys`/`.prg` extension.
   *
   * The module name is what the controller knows it as once loaded.
   * If the user renamed the file but the MODULE declaration says something
   * else, the controller's view (and PP target) follows the declaration.
   */
  private detectModuleName(document: vscode.TextDocument): string {
    const scan = Math.min(30, document.lineCount);
    for (let i = 0; i < scan; i++) {
      const text = document.lineAt(i).text;
      if (text.trim().startsWith('!')) { continue; }
      const m = text.match(/^\s*MODULE\s+(\w+)/i);
      if (m) { return m[1]; }
    }
    // Fallback to basename
    const fileName = document.fileName.split(/[\\/]/).pop() ?? 'Module';
    return fileName.replace(/\.(mod|sys|prg)$/i, '');
  }
}
