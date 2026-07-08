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
  /** Alternative to the previous parameter (`Signal | PersBool`) — shares its call slot. */
  alt?: boolean;
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
    const { name, argsText } = found;

    const db = loadDb(this.extensionRoot);
    const entry = db[name.toLowerCase()];
    if (!entry || !entry.parameters || entry.parameters.length === 0) { return null; }

    const sig = this.toSignature(entry);
    const help = new vscode.SignatureHelp();
    help.signatures      = [sig];
    help.activeSignature = 0;
    help.activeParameter = this.computeActiveParameter(argsText, entry.parameters);
    return help;
  }

  /**
   * Map the typed argument text onto the parameter list (which is in call
   * order, optional args interleaved with the required ones).
   *
   * Optional args don't consume a positional slot — they attach with `\Name`
   * either inside a slot (`v1000\V:=200`) or as their own slot (`\Conc,`).
   * So: if the cursor sits in a `\Name` group, highlight that optional by
   * name; otherwise count the preceding *positional* slots and highlight the
   * matching required parameter.
   */
  private computeActiveParameter(argsText: string, params: Parameter[]): number {
    // Split into comma-separated slots at nesting depth 0, ignoring commas
    // inside strings. The last (possibly empty) slot is the one being typed.
    const slots: string[] = [];
    let cur = '';
    let depth = 0;
    let inStr = false;
    for (const ch of argsText) {
      if (ch === '"') { inStr = !inStr; }
      if (!inStr) {
        if (ch === '(') { depth++; }
        else if (ch === ')') { depth--; }
        else if (ch === ',' && depth === 0) { slots.push(cur); cur = ''; continue; }
      }
      cur += ch;
    }
    slots.push(cur);

    // Cursor inside an optional `\Name` group? Match it by name.
    const opt = slots[slots.length - 1].match(/\\(\w*)[^\\]*$/);
    if (opt && opt[1]) {
      const typed = opt[1].toLowerCase();
      let idx = params.findIndex(p => p.optional && p.name.slice(1).toLowerCase() === typed);
      if (idx < 0) {
        idx = params.findIndex(p => p.optional && p.name.slice(1).toLowerCase().startsWith(typed));
      }
      if (idx >= 0) { return idx; }
    }

    // Positional: slots that are pure optional args (`\Conc`) don't count.
    let pos = 0;
    for (let i = 0; i < slots.length - 1; i++) {
      if (!/^\s*\\/.test(slots[i])) { pos++; }
    }
    // Required alternatives (`Signal | PersBool`) share one call slot — only
    // the first of a group advances the slot counter.
    let group = -1;
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p.optional) { continue; }
      if (!p.alt || group < 0) {
        group++;
        if (group === pos) { return i; }
      }
    }
    return params.length - 1;
  }

  /**
   * Walk back from the cursor over the current call's args.
   * Returns the call name + the argument text typed so far.
   *
   * Examples (cursor at │):
   *   `MoveJ │`           → { name: 'MoveJ', argsText: '' }
   *   `MoveJ p1, │`       → { name: 'MoveJ', argsText: 'p1, ' }
   *   `Cos(│`             → { name: 'Cos',   argsText: '' }
   *   `Offs(p1, 0, │`     → { name: 'Offs',  argsText: 'p1, 0, ' }
   *   `MoveJ p1, Offs(p,│ → { name: 'Offs',  argsText: 'p,' } (innermost)
   */
  private findEnclosingCall(prefix: string): { name: string; argsText: string } | null {
    let depth = 0;
    let i = prefix.length - 1;
    // Walk right-to-left; track nesting until the innermost unmatched `(`.
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
          return { name: m[1], argsText: prefix.slice(i + 1) };
        }
        depth--;
      }
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
    return { name, argsText: trimmed.slice(m[0].length) };
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
