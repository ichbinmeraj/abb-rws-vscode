import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MultiRobotManager } from 'abb-rws-client';
import { Logger } from './Logger';
import { quietTask } from './taskResolver';

/**
 * Hover provider for RAPID source files (.mod / .sys / .prg).
 *
 * Backed by a static JSON database of RAPID's built-in names (705 entries:
 * instructions, functions, data types and structural keywords). It holds
 * signatures only - name, kind, call shape, parameter names with their types
 * and optional / switch markers, and a function's return type - no
 * descriptions or examples (see scripts/strip-language-data.mjs).
 *
 * Hover behavior:
 *   - Detects the identifier under the cursor.
 *   - Looks it up case-insensitively in the database.
 *   - Renders a Markdown hover with: name and kind, the call shape,
 *     the parameter list with types, and the return type of a function.
 *
 * Returns null for unknown identifiers (user-defined symbols, comments,
 * etc.) so VS Code falls through to other providers.
 */

interface Parameter {
  name: string;
  type: string;
  optional?: boolean;
  switch?: boolean;
  /** Alternative to the previous parameter (`\V | \T`). */
  alt?: boolean;
}

interface RapidEntry {
  kind: 'instruction' | 'function' | 'datatype' | 'keyword';
  name: string;
  /** Neutral one-liner built from kind and return type ("RAPID function returning num"). */
  summary: string;
  /** Call shape built from the parameter list; "" when not known. */
  signature: string;
  returns?: string;
  parameters?: Parameter[];
}

/** Parameter lines shown in one hover; longer lists end with "... and N more". */
const MAX_PARAMETER_LINES = 16;

let DB: Record<string, RapidEntry> | null = null;

function loadDb(extensionRoot: string): Record<string, RapidEntry> {
  if (DB) { return DB; }
  const p = path.join(extensionRoot, 'resources', 'rapid-language-data.json');
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    DB = JSON.parse(raw) as Record<string, RapidEntry>;
    Logger.info(`RAPID language DB loaded - ${Object.keys(DB).length} entries`);
    return DB;
  } catch (e) {
    Logger.error(`failed to load RAPID language DB at ${p}`, e);
    DB = {};
    return DB;
  }
}

/**
 * Cache for live-value lookups so hovering doesn't hammer the controller -
 * the hover provider fires every time the cursor moves over a token.
 * 800 ms TTL: long enough to absorb hover-tooltip-flicker, short enough that
 * a running program's variable values look "alive".
 */
interface CachedLiveValue { value?: string; error?: string; expires: number; }
const liveValueCache = new Map<string, CachedLiveValue>();
const LIVE_TTL_MS = 800;

export class RapidHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly extensionRoot: string,
    private readonly multi?: MultiRobotManager,
    /** The task a file was pulled from (src/fileOrigins.ts), if recorded. */
    private readonly recordedTask: (fsPath: string) => string | undefined = () => undefined,
  ) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
    if (!range) { return null; }
    const word = document.getText(range);

    // 1. Static language DB - instructions, functions, data types
    const db = loadDb(this.extensionRoot);
    const entry = db[word.toLowerCase()];
    if (entry) { return new vscode.Hover(this.render(entry), range); }

    // 2. Fall through to live-value lookup if we're connected.
    // Only attempt for plausible variable identifiers (not just any word).
    if (!this.multi || !this.multi.state.connected || !this.multi.active) { return null; }
    if (!/^[a-zA-Z_][\w]*$/.test(word)) { return null; }
    if (token.isCancellationRequested) { return null; }

    const moduleName = this.detectModuleName(document);
    if (!moduleName) { return null; }
    // No live value when the rule cannot settle the file's task: a value read
    // from another task's variable of the same name would mislead.
    const taskName = quietTask(this.multi.state, { module: moduleName, recorded: this.recordedTask(document.fileName) });
    if (!taskName) { return null; }

    const live = await this.lookupLiveValue(taskName, moduleName, word);
    if (token.isCancellationRequested) { return null; }
    if (!live || (live.error && /not.*found|undefined|does not exist/i.test(live.error))) { return null; }
    return new vscode.Hover(this.renderLive(taskName, moduleName, word, live), range);
  }

  /** Pull "MODULE Foo" from the file header; fall back to filename basename. */
  private detectModuleName(document: vscode.TextDocument): string | null {
    const m = /\bMODULE\s+(\w+)/i.exec(document.getText());
    if (m) { return m[1]; }
    const base = path.basename(document.fileName, path.extname(document.fileName));
    return base || null;
  }

  /** Fetch the variable value from the controller, with TTL cache. */
  private async lookupLiveValue(task: string, module: string, symbol: string): Promise<CachedLiveValue | null> {
    const key = `${task}:${module}:${symbol}`;
    const now = Date.now();
    const cached = liveValueCache.get(key);
    if (cached && cached.expires > now) { return cached; }
    const active = this.multi?.active;
    if (!active) { return null; }
    try {
      const value = await active.getRapidVariable(task, module, symbol);
      const fresh: CachedLiveValue = { value, expires: now + LIVE_TTL_MS };
      liveValueCache.set(key, fresh);
      return fresh;
    } catch (e) {
      // Cache the failure too so we don't retry every hover-tick.
      const fresh: CachedLiveValue = { error: e instanceof Error ? e.message : String(e), expires: now + LIVE_TTL_MS };
      liveValueCache.set(key, fresh);
      return fresh;
    }
  }

  private renderLive(task: string, moduleName: string, symbol: string, live: CachedLiveValue): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = true;
    md.appendMarkdown(`**\`${moduleName}.${symbol}\`** - _live value_\n\n`);
    if (live.value !== undefined) {
      const trimmed = live.value.length > 200 ? live.value.slice(0, 200) + '…' : live.value;
      md.appendCodeblock(trimmed, 'rapid');
      md.appendMarkdown(`<small>Read live from ${task} on the connected controller.</small>`);
    } else if (live.error) {
      md.appendMarkdown(`_Could not read:_ ${this.shortenError(live.error)}\n`);
    }
    return md;
  }

  private shortenError(e: string): string {
    return e.replace(/\s+/g, ' ').slice(0, 120);
  }

  /** Build a Markdown hover string for one DB entry. */
  private render(e: RapidEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;

    // Title row: name + kind badge
    const kindLabel = e.kind === 'instruction' ? 'Instruction'
                    : e.kind === 'function'    ? 'Function'
                    : e.kind === 'keyword'     ? 'Keyword'
                    : 'Data type';
    md.appendMarkdown(`**\`${e.name}\`** - _${kindLabel}_\n\n`);

    // Call shape (built from the parameter list, not quoted from a manual)
    if (e.signature) {
      md.appendCodeblock(e.signature.split('\n').slice(0, 8).join('\n'), 'rapid');
    } else {
      md.appendMarkdown(`${e.summary}\n\n`);
    }

    // Parameters: name, type, optional / switch / alternative markers
    const params = e.parameters ?? [];
    if (params.length > 0) {
      const lines = params.slice(0, MAX_PARAMETER_LINES).map((p, i) => {
        const type = p.switch ? 'switch' : `\`${p.type}\``;
        const marks = [
          p.optional ? 'optional' : '',
          p.alt && i > 0 ? `or ${params[i - 1].name}` : '',
        ].filter(Boolean);
        return `- \`${p.name}\` ${type}${marks.length ? ` _(${marks.join(', ')})_` : ''}`;
      });
      if (params.length > MAX_PARAMETER_LINES) {
        lines.push(`- ... and ${params.length - MAX_PARAMETER_LINES} more`);
      }
      md.appendMarkdown(lines.join('\n') + '\n\n');
    }

    // Return type of a function
    if (e.returns) {
      md.appendMarkdown(`Returns \`${e.returns}\`\n\n`);
    }

    // Footer - the hover carries signatures only; point to ABB's manual for the rest.
    md.appendMarkdown(
      `\n---\n` +
      `<small>` +
      `Signatures only. For descriptions see ABB's _RAPID Instructions, Functions and Data types_ ` +
      `manual ([3HAC050917-001](https://library.abb.com/r?dkey=3HAC050917-001)).` +
      `</small>`,
    );
    md.supportHtml = true;
    return md;
  }
}
