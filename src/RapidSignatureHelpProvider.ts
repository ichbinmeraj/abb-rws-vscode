import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from './Logger';

/**
 * Signature help provider for RAPID source files.
 *
 * When the user is in the middle of typing a call — e.g. `MoveJ │` after the
 * space, or `Cos(│)` after the open paren, or `MoveJ p1, │` after a comma —
 * we show a popup listing the parameters with their types, with the current
 * argument highlighted.
 *
 * Trigger characters: `(`, `,`, ` ` (space). RAPID has two call shapes —
 * function calls use `(args)`, instructions use space-separated args — so
 * we accept both.
 *
 * Backed by the same JSON DB as the hover and completion providers (705
 * entries from ABB Technical Reference 3HAC050917-001 Rev F).
 */

interface Parameter {
  name: string;
  type: string;
  optional?: boolean;
  switch?: boolean;
}

interface RapidEntry {
  kind: 'instruction' | 'function' | 'datatype' | 'keyword';
  name: string;
  brief: string;
  syntax: string;
  parameters?: Parameter[];
}

let DB: Record<string, RapidEntry> | null = null;

function loadDb(extensionRoot: string): Record<string, RapidEntry> {
  if (DB) { return DB; }
  const p = path.join(extensionRoot, 'resources', 'rapid-language-data.json');
  try {
    DB = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, RapidEntry>;
  } catch (e) {
    Logger.error(`failed to load RAPID DB`, e);
    DB = {};
  }
  return DB;
}

export class RapidSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly extensionRoot: string) {}

  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.SignatureHelp> {
    const lineText = document.lineAt(position.line).text.slice(0, position.character);
    if (this.isInsideStringOrComment(lineText)) { return null; }

    // Find the call we're inside: walk back from cursor over the current
    // call's argument-list, until we reach the call name.
    const found = this.findEnclosingCall(lineText);
    if (!found) { return null; }
    const { name, argIndex } = found;

    const db = loadDb(this.extensionRoot);
    const entry = db[name.toLowerCase()];
    if (!entry || !entry.parameters || entry.parameters.length === 0) { return null; }

    const sig = this.toSignature(entry);
    const help = new vscode.SignatureHelp();
    help.signatures      = [sig];
    help.activeSignature = 0;
    help.activeParameter = Math.min(argIndex, entry.parameters.length - 1);
    return help;
  }

  /**
   * Walk back from the cursor over the current call's args.
   * Returns the call name + the zero-based index of the current argument.
   *
   * Examples (cursor at │):
   *   `MoveJ │`           → { name: 'MoveJ', argIndex: 0 }
   *   `MoveJ p1, │`       → { name: 'MoveJ', argIndex: 1 }
   *   `Cos(│`             → { name: 'Cos',   argIndex: 0 }
   *   `Offs(p1, 0, │`     → { name: 'Offs',  argIndex: 2 }
   *   `MoveJ p1, Offs(p,│ → { name: 'Offs',  argIndex: 1 } (innermost)
   */
  private findEnclosingCall(prefix: string): { name: string; argIndex: number } | null {
    let depth = 0;
    let argIndex = 0;
    let i = prefix.length - 1;
    // Walk right-to-left; track nesting and count commas at the OUTERMOST level.
    while (i >= 0) {
      const ch = prefix[i];
      if (ch === ')') { depth++; }
      else if (ch === '(') {
        if (depth === 0) {
          // We found an unmatched `(` — the function call's opening paren.
          // The token before it is the function name.
          const before = prefix.slice(0, i).trimEnd();
          const m = before.match(/([A-Za-z_]\w*)\s*$/);
          if (!m) { return null; }
          return { name: m[1], argIndex };
        }
        depth--;
      }
      else if (ch === ',' && depth === 0) { argIndex++; }
      else if (ch === ';' && depth === 0) { return null; }  // before this is unrelated
      i--;
    }
    // No `(` found at depth 0 → check for an instruction (space-separated args).
    // Pattern: [whitespace] <Name> <space> <args...>
    // The "name" must be the first identifier on the (logical) line.
    // Trim leading whitespace and look at the first word.
    const trimmed = prefix.replace(/^\s+/, '');
    const m = trimmed.match(/^([A-Za-z_]\w*)\s+/);
    if (!m) { return null; }
    const name = m[1];
    // Only treat as instruction if the name is in our DB AND has parameters AND is an instruction
    // (avoid treating arbitrary identifiers like variable names as calls).
    const db = loadDb(this.extensionRoot);
    const entry = db[name.toLowerCase()];
    if (!entry || entry.kind !== 'instruction' || !entry.parameters?.length) { return null; }
    // Re-count commas at depth 0 in the args-portion only
    const args = trimmed.slice(m[0].length);
    argIndex = 0;
    let d = 0;
    for (const ch of args) {
      if (ch === '(') d++;
      else if (ch === ')') d--;
      else if (ch === ',' && d === 0) argIndex++;
    }
    return { name, argIndex };
  }

  private toSignature(e: RapidEntry): vscode.SignatureInformation {
    const params = e.parameters ?? [];
    const paramLabels = params.map(p =>
      p.optional ? `[${p.name}]` : p.name,
    );
    const callShape = e.kind === 'function'
      ? `${e.name}(${paramLabels.join(', ')})`
      : `${e.name} ${paramLabels.join(', ')}`;
    const sig = new vscode.SignatureInformation(callShape);
    sig.documentation = new vscode.MarkdownString(e.brief);
    sig.parameters = params.map(p => {
      const label = p.optional ? `[${p.name}]` : p.name;
      const info  = new vscode.ParameterInformation(label);
      const tDoc  = p.switch ? '(switch — no value)' : `\`${p.type}\``;
      info.documentation = new vscode.MarkdownString(`**${p.name}** : ${tDoc}${p.optional ? ' _(optional)_' : ''}`);
      return info;
    });
    return sig;
  }

  /** Same heuristic as the completion provider. */
  private isInsideStringOrComment(linePrefix: string): boolean {
    const commentAt = linePrefix.indexOf('!');
    if (commentAt >= 0) {
      const before = linePrefix.slice(0, commentAt);
      if ((before.match(/"/g) ?? []).length % 2 === 0) { return true; }
    }
    const quotes = (linePrefix.match(/"/g) ?? []).length;
    return quotes % 2 === 1;
  }
}
