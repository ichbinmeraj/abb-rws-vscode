import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MultiRobotManager } from 'abb-rws-client';
import { Logger } from './Logger';

/**
 * Hover provider for RAPID source files (.mod / .sys / .prg).
 *
 * Backed by a static JSON database extracted from ABB's
 * "RAPID Instructions, Functions and Data types" reference manual
 * (3HAC050917-001 Rev F) — 666 entries covering every documented
 * instruction, function, and data type.
 *
 * Hover behavior:
 *   - Detects the identifier under the cursor.
 *   - Looks it up case-insensitively in the database.
 *   - Renders a Markdown hover with: title, brief, formal syntax,
 *     a code-fenced example, and a kind tag.
 *
 * Returns null for unknown identifiers (user-defined symbols, comments,
 * etc.) so VS Code falls through to other providers.
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
    const raw = fs.readFileSync(p, 'utf-8');
    DB = JSON.parse(raw) as Record<string, RapidEntry>;
    Logger.info(`RAPID language DB loaded — ${Object.keys(DB).length} entries`);
    return DB;
  } catch (e) {
    Logger.error(`failed to load RAPID language DB at ${p}`, e);
    DB = {};
    return DB;
  }
}

/**
 * Cache for live-value lookups so hovering doesn't hammer the controller —
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
  ) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
    if (!range) { return null; }
    const word = document.getText(range);

    // 1. Static language DB — instructions, functions, data types
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
    const taskName = this.multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';

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
    md.appendMarkdown(`**\`${moduleName}.${symbol}\`** — _live value_\n\n`);
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
    md.appendMarkdown(`**\`${e.name}\`** — _${kindLabel}_\n\n`);

    // Brief description (one-liner from the manual's TOC)
    if (e.brief) {
      md.appendMarkdown(`${e.brief}\n\n`);
    }

    // Formal syntax pattern (if extracted)
    if (e.syntax) {
      const syntaxLines = e.syntax.split('\n').slice(0, 6).join('\n');
      md.appendCodeblock(syntaxLines, 'rapid');
    }

    // Example
    if (e.examples?.length > 0) {
      md.appendMarkdown(`**Example:**\n`);
      md.appendCodeblock(e.examples[0], 'rapid');
    }

    // Footer — credit the extension + cite the source manual.
    // ABB users may need to verify against newer manual revisions in their RobotWare version,
    // so we link out to the Developer Center landing page as well.
    md.appendMarkdown(
      `\n---\n` +
      `<small>` +
      `From **ABB Technical Reference Manual** — _RAPID Instructions, Functions and Data types_, ` +
      `[3HAC050917-001 Rev F](https://library.abb.com/r?dkey=3HAC050917-001). ` +
      `Surfaced by **RAPID Live — ABB Robotics for VS Code**.` +
      `</small>`,
    );
    md.supportHtml = true;
    return md;
  }
}
