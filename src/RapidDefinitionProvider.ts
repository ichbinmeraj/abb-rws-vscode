import * as vscode from 'vscode';
import type { RapidLanguageIndex } from './RapidLanguageIndex';

/**
 * Go-to-Definition for RAPID. Ctrl+click on a routine / variable / trap name
 * jumps to its declaration (PROC, FUNC, TRAP, VAR, PERS, CONST, MODULE).
 *
 * Static-only (no language docs DB lookup) - that's the hover provider's job.
 * Here we only resolve user-defined symbols so the IDE feels native:
 *   - Routine call `testWave;` → jumps to `PROC testWave()`
 *   - Variable read `counter := counter + 1` → jumps to `VAR num counter := …`
 *   - Module reference `MODULE MotionTest` → jumps to its declaration line
 */
export class RapidDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: RapidLanguageIndex) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
    if (!range) { return null; }
    const word = document.getText(range);

    // Don't trigger on RAPID keywords / built-ins - those are documented in
    // the hover provider, not navigable to a user file.
    if (RAPID_KEYWORDS.has(word.toLowerCase())) { return null; }

    const decls = this.index.findDeclarations(word);
    if (decls.length === 0) { return null; }
    return decls.map(({ uri, symbol }) => ({
      targetUri: uri,
      targetRange: symbol.range,
      targetSelectionRange: symbol.selectionRange,
      originSelectionRange: range,
    }) as vscode.LocationLink);
  }
}

// Subset that's noisy as Go-to-Definition targets (we'd resolve them to
// nothing user-defined anyway). The hover provider handles these via the
// language-data DB.
const RAPID_KEYWORDS = new Set([
  // structural
  'module', 'endmodule', 'proc', 'endproc', 'func', 'endfunc', 'trap', 'endtrap',
  'local', 'task', 'sysmodule', 'noview', 'nostepin', 'viewonly', 'readonly',
  // type qualifiers
  'var', 'pers', 'const', 'inout',
  // control flow
  'if', 'then', 'else', 'elseif', 'endif',
  'for', 'from', 'to', 'step', 'do', 'endfor',
  'while', 'endwhile', 'test', 'case', 'default', 'endtest',
  'return', 'goto', 'label',
  'connect', 'with', 'when', 'true', 'false',
  // common type names
  'num', 'dnum', 'string', 'bool', 'byte',
  'pos', 'orient', 'pose', 'robtarget', 'jointtarget', 'tooldata', 'wobjdata',
  'speeddata', 'zonedata', 'loaddata', 'confdata', 'extjoint',
]);
