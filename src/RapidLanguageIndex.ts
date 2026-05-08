import * as vscode from 'vscode';
import { Logger } from './Logger';

/**
 * Workspace-wide index of RAPID symbol declarations across all `.mod`,
 * `.sys`, and `.prg` files. Powers Go-to-Definition, Document Outline,
 * and Find-References for RAPID code.
 *
 * Scope: line-based regex parsing, sufficient for ABB-shaped RAPID code
 * (declarations on their own line, single-line `!` comments). We skip
 * full grammar parsing — RAPID files are small (< 1000 lines typically)
 * and this index regenerates on save in milliseconds.
 *
 * Symbol kinds detected:
 *   - module         (`MODULE Foo`)
 *   - proc / func    (`PROC name(...)`, `FUNC type name(...)`, `LOCAL PROC ...`)
 *   - trap           (`TRAP name`)
 *   - var / pers / const   (`VAR num counter := 0;`, `PERS robtarget pHome := ...`)
 */

export type RapidSymbolKind =
  | 'module'
  | 'proc'
  | 'func'
  | 'trap'
  | 'var'
  | 'pers'
  | 'const';

export interface RapidSymbol {
  name: string;
  kind: RapidSymbolKind;
  isLocal: boolean;
  containerModule: string;
  /** Range of the entire declaration line(s) — for VS Code's outline body. */
  range: vscode.Range;
  /** Range of just the symbol name — for the symbol's selection. */
  selectionRange: vscode.Range;
  /** RAPID datatype, when applicable (vars/persistents/constants/funcs). */
  datatype?: string;
}

export class RapidLanguageIndex implements vscode.Disposable {
  /** uri.toString() → symbols defined in that file */
  private fileSymbols = new Map<string, RapidSymbol[]>();
  private watcher?: vscode.FileSystemWatcher;
  private disposables: vscode.Disposable[] = [];

  /** Fires when the index changes — providers can use this if they cache. */
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  async start(): Promise<void> {
    // Initial workspace scan
    const files = await vscode.workspace.findFiles('**/*.{mod,sys,prg,MOD,SYS,PRG}', '**/node_modules/**');
    for (const uri of files) { await this.indexFile(uri); }
    Logger.info(`RapidLanguageIndex: scanned ${files.length} RAPID files, ${this.totalSymbols()} symbols`);

    // Watch for changes
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{mod,sys,prg,MOD,SYS,PRG}');
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(uri => this.indexFile(uri)),
      this.watcher.onDidChange(uri => this.indexFile(uri)),
      this.watcher.onDidDelete(uri => this.removeFile(uri)),
      // Re-index on every save so live edits are visible immediately.
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (this.isRapidFile(doc.uri)) { this.indexDocument(doc); }
      }),
      // Index untitled / unsaved RAPID buffers as users edit them, with a
      // light debounce so we don't reparse on every keystroke.
      vscode.workspace.onDidChangeTextDocument(this.makeDebouncedReindex(300)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.fileSymbols.clear();
  }

  private isRapidFile(uri: vscode.Uri): boolean {
    return /\.(mod|sys|prg)$/i.test(uri.fsPath);
  }

  private totalSymbols(): number {
    let n = 0;
    for (const s of this.fileSymbols.values()) { n += s.length; }
    return n;
  }

  private makeDebouncedReindex(delayMs: number): (e: vscode.TextDocumentChangeEvent) => void {
    const pending = new Map<string, NodeJS.Timeout>();
    return (e) => {
      if (!this.isRapidFile(e.document.uri)) { return; }
      const key = e.document.uri.toString();
      const prev = pending.get(key);
      if (prev) { clearTimeout(prev); }
      const t = setTimeout(() => {
        pending.delete(key);
        this.indexDocument(e.document);
      }, delayMs);
      pending.set(key, t);
    };
  }

  // ─── Indexing ───────────────────────────────────────────────────────────

  async indexFile(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      this.indexText(uri, text);
    } catch (e) {
      Logger.warn(`indexFile(${uri.fsPath}): ${String(e)}`);
    }
  }

  indexDocument(doc: vscode.TextDocument): void {
    this.indexText(doc.uri, doc.getText());
  }

  private indexText(uri: vscode.Uri, text: string): void {
    const lines = text.split(/\r?\n/);
    const symbols: RapidSymbol[] = [];
    let containerModule = '';

    // Regex helpers — case-insensitive. We strip `!`-comments line-by-line first.
    const reModule = /^\s*MODULE\s+(\w+)/i;
    const reProc   = /^\s*(LOCAL\s+)?PROC\s+(\w+)\s*\(/i;
    const reFunc   = /^\s*(LOCAL\s+)?FUNC\s+(\w+)\s+(\w+)\s*\(/i;
    const reTrap   = /^\s*(LOCAL\s+)?TRAP\s+(\w+)/i;
    const reVar    = /^\s*(LOCAL\s+)?VAR\s+(\w+)\s+(\w+)/i;
    const rePers   = /^\s*(LOCAL\s+)?PERS\s+(\w+)\s+(\w+)/i;
    const reConst  = /^\s*(LOCAL\s+)?CONST\s+(\w+)\s+(\w+)/i;

    const push = (
      name: string,
      kind: RapidSymbolKind,
      isLocal: boolean,
      lineNo: number,
      lineText: string,
      datatype: string | undefined,
    ): void => {
      const idx = lineText.indexOf(name);
      const start = idx >= 0 ? idx : 0;
      symbols.push({
        name,
        kind,
        isLocal,
        containerModule,
        range: new vscode.Range(lineNo, 0, lineNo, lineText.length),
        selectionRange: new vscode.Range(lineNo, start, lineNo, start + name.length),
        datatype,
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // Strip `!`-comments (RAPID has no block comments). Be careful about
      // bangs inside string literals, but for declaration-line parsing this
      // is rare enough not to matter.
      const stripped = raw.replace(/!.*$/, '');

      let m;
      if ((m = reModule.exec(stripped))) {
        containerModule = m[1];
        push(m[1], 'module', false, i, raw, undefined);
        continue;
      }
      if ((m = reProc.exec(stripped))) {
        push(m[2], 'proc', !!m[1], i, raw, undefined);
        continue;
      }
      if ((m = reFunc.exec(stripped))) {
        // FUNC <returnType> <name>(...)
        push(m[3], 'func', !!m[1], i, raw, m[2]);
        continue;
      }
      if ((m = reTrap.exec(stripped))) {
        push(m[2], 'trap', !!m[1], i, raw, undefined);
        continue;
      }
      if ((m = reVar.exec(stripped))) {
        push(m[3], 'var', !!m[1], i, raw, m[2]);
        continue;
      }
      if ((m = rePers.exec(stripped))) {
        push(m[3], 'pers', !!m[1], i, raw, m[2]);
        continue;
      }
      if ((m = reConst.exec(stripped))) {
        push(m[3], 'const', !!m[1], i, raw, m[2]);
        continue;
      }
    }

    this.fileSymbols.set(uri.toString(), symbols);
    this._onDidChange.fire();
  }

  removeFile(uri: vscode.Uri): void {
    this.fileSymbols.delete(uri.toString());
    this._onDidChange.fire();
  }

  // ─── Lookup API used by providers ───────────────────────────────────────

  /** All symbols in one file, in source order. */
  symbolsInFile(uri: vscode.Uri): RapidSymbol[] {
    return this.fileSymbols.get(uri.toString()) ?? [];
  }

  /**
   * Find every declaration of `name` across the workspace.
   * Returns the file URIs + symbol metadata. Routine names are global within
   * a task at runtime, but at the source level a routine can only be defined
   * in one module — so most lookups return one location.
   */
  findDeclarations(name: string): Array<{ uri: vscode.Uri; symbol: RapidSymbol }> {
    const lower = name.toLowerCase();
    const results: Array<{ uri: vscode.Uri; symbol: RapidSymbol }> = [];
    for (const [key, symbols] of this.fileSymbols) {
      const uri = vscode.Uri.parse(key);
      for (const s of symbols) {
        if (s.name.toLowerCase() === lower) { results.push({ uri, symbol: s }); }
      }
    }
    return results;
  }

  /**
   * Scan every indexed file for occurrences of `name` as a standalone
   * identifier (not inside a comment or string). Returns each match as a
   * `Location`. Includes the declaration itself — VS Code de-dupes if needed.
   * Note: this re-reads each file via the open-document cache OR does a
   * fresh scan per call. For workspaces with hundreds of files we'd want to
   * pre-build a reverse index, but for typical robot-cell repos (< 50 files)
   * this is fast enough and always accurate.
   */
  async findReferences(name: string, includeDeclaration: boolean): Promise<vscode.Location[]> {
    const lower = name.toLowerCase();
    const re = new RegExp(`\\b${this.escapeForRegex(name)}\\b`, 'gi');
    const results: vscode.Location[] = [];

    // Decl set so we can optionally include/exclude declarations.
    const declRanges = new Set<string>();
    if (!includeDeclaration) {
      for (const [key, symbols] of this.fileSymbols) {
        for (const s of symbols) {
          if (s.name.toLowerCase() === lower) {
            declRanges.add(`${key}:${s.selectionRange.start.line}:${s.selectionRange.start.character}`);
          }
        }
      }
    }

    for (const [key] of this.fileSymbols) {
      const uri = vscode.Uri.parse(key);
      let text: string;
      // Prefer the live document content (reflects unsaved edits)
      const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
      if (openDoc) {
        text = openDoc.getText();
      } else {
        try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8'); }
        catch { continue; }
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        // Strip comments + strings to avoid false positives.
        const stripped = lines[i]
          .replace(/!.*$/, '')
          .replace(/"[^"]*"/g, m => ' '.repeat(m.length));
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped))) {
          const start = m.index;
          const declKey = `${key}:${i}:${start}`;
          if (!includeDeclaration && declRanges.has(declKey)) { continue; }
          results.push(new vscode.Location(uri, new vscode.Range(i, start, i, start + name.length)));
        }
      }
    }
    return results;
  }

  private escapeForRegex(s: string): string {
    return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  }
}
