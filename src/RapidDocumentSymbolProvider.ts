import * as vscode from 'vscode';
import type { RapidLanguageIndex, RapidSymbol, RapidSymbolKind } from './RapidLanguageIndex';

/**
 * Document outline for RAPID files. Powers VS Code's Outline panel,
 * breadcrumbs at the top of the editor, and "Go to Symbol in File…"
 * (Ctrl+Shift+O).
 *
 * Hierarchy: each `MODULE` becomes a top-level node, with all its routines
 * and data declarations nested underneath. Local symbols are shown with
 * `(local)` in the description so they're visually distinct.
 */
export class RapidDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly index: RapidLanguageIndex) {}

  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    // Always re-index the current document so unsaved edits are reflected.
    this.index.indexDocument(document);
    const symbols = this.index.symbolsInFile(document.uri);
    if (symbols.length === 0) { return []; }

    // Build a tree: modules at the root, everything else under them.
    const moduleNodes = new Map<string, vscode.DocumentSymbol>();
    const orphans: vscode.DocumentSymbol[] = [];

    for (const s of symbols) {
      const sym = this.toVsCodeSymbol(s);
      if (s.kind === 'module') {
        moduleNodes.set(s.name, sym);
      } else if (s.containerModule && moduleNodes.has(s.containerModule)) {
        moduleNodes.get(s.containerModule)!.children.push(sym);
      } else {
        orphans.push(sym);
      }
    }
    return [...moduleNodes.values(), ...orphans];
  }

  private toVsCodeSymbol(s: RapidSymbol): vscode.DocumentSymbol {
    const detail = [
      s.isLocal ? '(local)' : '',
      s.datatype ? `: ${s.datatype}` : '',
    ].filter(Boolean).join(' ');
    return new vscode.DocumentSymbol(
      s.name,
      detail,
      mapKind(s.kind),
      s.range,
      s.selectionRange,
    );
  }
}

function mapKind(k: RapidSymbolKind): vscode.SymbolKind {
  switch (k) {
    case 'module':  return vscode.SymbolKind.Module;
    case 'proc':    return vscode.SymbolKind.Method;
    case 'func':    return vscode.SymbolKind.Function;
    case 'trap':    return vscode.SymbolKind.Event;
    case 'var':     return vscode.SymbolKind.Variable;
    case 'pers':    return vscode.SymbolKind.Field;
    case 'const':   return vscode.SymbolKind.Constant;
  }
}
