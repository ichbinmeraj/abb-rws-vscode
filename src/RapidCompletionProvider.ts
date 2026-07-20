import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from './Logger';

/**
 * Completion (autocomplete) + snippet provider for RAPID source files.
 *
 * Sources of suggestions:
 *   - 705 entries from the ABB Technical Reference Manual
 *     (instructions, functions, data types, structural keywords) - all surfaced.
 *   - A curated map of "snippet templates" for common instructions and
 *     control-flow constructs. Where a template exists, accepting the
 *     completion expands into a tab-stop snippet (placeholders the user
 *     tabs through). Where no template exists, the completion just inserts
 *     the bare name.
 *
 * Trigger characters: none - VS Code calls us on every word as the user types.
 * Filtering: handled by VS Code based on `label` and `filterText`.
 */

interface RapidEntry {
  kind: 'instruction' | 'function' | 'datatype' | 'keyword';
  name: string;
  brief: string;
  usage: string;
  syntax: string;
  examples: string[];
}

let DB: Record<string, RapidEntry> | null = null;

function loadDb(extensionRoot: string): Record<string, RapidEntry> {
  if (DB) { return DB; }
  const p = path.join(extensionRoot, 'resources', 'rapid-language-data.json');
  try {
    DB = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, RapidEntry>;
    Logger.info(`RAPID completion DB loaded - ${Object.keys(DB).length} entries`);
  } catch (e) {
    Logger.error(`failed to load RAPID DB at ${p}`, e);
    DB = {};
  }
  return DB;
}

/**
 * Snippet templates (TextMate $1/$2/$0 syntax) for the most-used items.
 * Indexed by lowercase name. Hand-curated - covers control flow and the
 * core motion primitives where filling argument placeholders saves real
 * typing. For everything else, completion inserts the bare name.
 */
const SNIPPETS: Record<string, string> = {
  // ── Module + routine declarations ──────────────────────────────────────
  module:    'MODULE ${1:moduleName}\n\t$0\nENDMODULE',
  proc:      'PROC ${1:name}(${2:})\n\t$0\nENDPROC',
  func:      'FUNC ${1:num} ${2:name}(${3:})\n\t$0\n\tRETURN ${4:value};\nENDFUNC',
  trap:      'TRAP ${1:name}\n\t$0\nENDTRAP',
  record:    'RECORD ${1:typeName}\n\t${2:num} ${3:field};\n\t$0\nENDRECORD',

  // ── Control flow ───────────────────────────────────────────────────────
  if:        'IF ${1:condition} THEN\n\t$0\nENDIF',
  ifelse:    'IF ${1:condition} THEN\n\t${2:; then-branch}\nELSE\n\t${3:; else-branch}\nENDIF',
  while:     'WHILE ${1:condition} DO\n\t$0\nENDWHILE',
  for:       'FOR ${1:i} FROM ${2:1} TO ${3:10} DO\n\t$0\nENDFOR',
  forstep:   'FOR ${1:i} FROM ${2:0} TO ${3:100} STEP ${4:10} DO\n\t$0\nENDFOR',
  test:      'TEST ${1:variable}\n\tCASE ${2:1}:\n\t\t$0\n\tCASE ${3:2,3}:\n\t\t\nDEFAULT:\n\t\t\nENDTEST',

  // ── Data declarations ──────────────────────────────────────────────────
  var:       'VAR ${1:num} ${2:name} := ${3:0};',
  pers:      'PERS ${1:num} ${2:name} := ${3:0};',
  const:     'CONST ${1:num} ${2:NAME} := ${3:0};',

  // ── Motion ─────────────────────────────────────────────────────────────
  movej:     'MoveJ ${1:p1}, ${2:v1000}, ${3:fine}, ${4:tool0}\\WObj:=${5:wobj0};',
  movel:     'MoveL ${1:p1}, ${2:v1000}, ${3:fine}, ${4:tool0}\\WObj:=${5:wobj0};',
  movec:     'MoveC ${1:via}, ${2:to}, ${3:v500}, ${4:fine}, ${5:tool0}\\WObj:=${6:wobj0};',
  moveabsj:  'MoveAbsJ ${1:jt}, ${2:v1000}, ${3:fine}, ${4:tool0};',
  movejsync: 'MoveJSync ${1:p1}, ${2:v1000}, ${3:fine}, ${4:tool0}, ${5:procName};',

  // ── I/O ────────────────────────────────────────────────────────────────
  setdo:     'SetDO ${1:do_name}, ${2:1};',
  reset:     'Reset ${1:do_name};',
  set:       'Set ${1:do_name};',
  pulsedo:   'PulseDO\\PLength:=${1:0.2}, ${2:do_name};',
  setgo:     'SetGO ${1:go_name}, ${2:value};',
  waitdi:    'WaitDI ${1:di_name}, ${2:1};',
  waitdo:    'WaitDO ${1:do_name}, ${2:1};',
  waituntil: 'WaitUntil ${1:condition};',
  waittime:  'WaitTime ${1:1};',

  // ── FlexPendant / messages ─────────────────────────────────────────────
  tpwrite:   'TPWrite ${1:"message"};',
  tperase:   'TPErase;',
  tpreadnum: 'TPReadNum ${1:answer}, ${2:"prompt:"};',
  tpreadfk:  'TPReadFK ${1:choice}, ${2:"header"}, ${3:"f1"}, ${4:"f2"}, stEmpty, stEmpty, stEmpty;',

  // ── Stop / error / interrupts ──────────────────────────────────────────
  stop:      'Stop;',
  exit:      'EXIT;',
  break:     'Break;',
  return:    'RETURN${1: ;}',
  retry:     'RETRY;',
  trynext:   'TRYNEXT;',
  raise:     'RAISE;',

  // ── Math / strings / clocks ────────────────────────────────────────────
  clkstart:  'ClkStart ${1:clock1};',
  clkstop:   'ClkStop ${1:clock1};',
  clkread:   'ClkRead(${1:clock1})',
  valtostr:  'ValToStr(${1:value})',
  strtoval:  'StrToVal(${1:str}, ${2:value})',
  offs:      'Offs(${1:p1}, ${2:0}, ${3:0}, ${4:0})',
  reltool:   'RelTool(${1:p1}, ${2:0}, ${3:0}, ${4:0}\\Rx:=${5:0}\\Ry:=${6:0}\\Rz:=${7:0})',
};

export class RapidCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly extensionRoot: string) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const db = loadDb(this.extensionRoot);
    // Skip completions inside comments and strings (cheap heuristic).
    const lineText = document.lineAt(position.line).text.slice(0, position.character);
    if (this.isInsideStringOrComment(lineText)) { return []; }

    const items: vscode.CompletionItem[] = [];
    for (const e of Object.values(db)) {
      items.push(this.toCompletion(e));
    }
    return items;
  }

  private toCompletion(e: RapidEntry): vscode.CompletionItem {
    const item = new vscode.CompletionItem(e.name, this.kindFor(e.kind));
    item.detail = `${this.kindLabel(e.kind)} - ${e.brief}`;

    // Hover-style documentation
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${e.name}** - _${this.kindLabel(e.kind)}_\n\n${e.brief}\n\n`);
    if (e.syntax) {
      md.appendCodeblock(e.syntax.split('\n').slice(0, 4).join('\n'), 'rapid');
    }
    if (e.examples?.length) {
      md.appendCodeblock(e.examples[0], 'rapid');
    }
    item.documentation = md;

    // Snippet expansion if we have a template
    const tmpl = SNIPPETS[e.name.toLowerCase()];
    if (tmpl) {
      item.insertText = new vscode.SnippetString(tmpl);
      item.kind = vscode.CompletionItemKind.Snippet;
      // Sort snippets above plain identifiers when names tie
      item.sortText = `0_${e.name}`;
    } else {
      item.insertText = e.name;
      item.sortText = `1_${e.name}`;
    }

    return item;
  }

  private kindFor(kind: RapidEntry['kind']): vscode.CompletionItemKind {
    switch (kind) {
      case 'instruction': return vscode.CompletionItemKind.Method;
      case 'function':    return vscode.CompletionItemKind.Function;
      case 'datatype':    return vscode.CompletionItemKind.Class;
      case 'keyword':     return vscode.CompletionItemKind.Keyword;
    }
  }

  private kindLabel(kind: RapidEntry['kind']): string {
    switch (kind) {
      case 'instruction': return 'Instruction';
      case 'function':    return 'Function';
      case 'datatype':    return 'Data type';
      case 'keyword':     return 'Keyword';
    }
  }

  /**
   * Cheap test: are we currently inside a `!`-comment or a `"`-string?
   * RAPID's only line-comment is `!`; strings are plain `"…"`.
   * Doesn't handle multi-line strings (RAPID doesn't really have them).
   */
  private isInsideStringOrComment(linePrefix: string): boolean {
    const commentAt = linePrefix.indexOf('!');
    if (commentAt >= 0) {
      // A `!` after an even number of `"` quotes is a comment.
      const before = linePrefix.slice(0, commentAt);
      if ((before.match(/"/g) ?? []).length % 2 === 0) { return true; }
    }
    const quotes = (linePrefix.match(/"/g) ?? []).length;
    return quotes % 2 === 1;
  }
}
