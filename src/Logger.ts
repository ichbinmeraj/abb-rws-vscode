import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Diagnostic logger backed by:
 *   1. A VS Code output channel — live, scrollable in `View → Output → ABB Robot`.
 *   2. A persistent NDJSON log file — one JSON object per line, easy to share
 *      and grep. New file per session (timestamped). Old logs auto-pruned at 20.
 *
 * Use info() for ordinary lifecycle events (connect/disconnect/poll cycles),
 * warn() for recoverable issues, error() for failures the user needs to see,
 * trace() for structured debug events (HTTP req/res, command dispatches).
 *
 * The lib's `setLogger()` is called from `extension.activate()` to install
 * this implementation, so RobotManager / RwsClient / RwsClient2 calls all
 * funnel through here.
 */
class LoggerImpl {
  private channel: vscode.OutputChannel | null = null;
  private logFilePath: string;
  private fileStream: fs.WriteStream | null = null;

  constructor() {
    this.logFilePath = this.makeLogPath();
    this.pruneOldLogs();
  }

  private get ch(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('ABB Robot');
    }
    return this.channel;
  }

  private get fs(): fs.WriteStream {
    if (!this.fileStream) {
      // Append mode — write each session into a fresh file
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      this.fileStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this.fileStream.write(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        category: 'session',
        msg: '── log session started ──',
        path: this.logFilePath,
      }) + '\n');
    }
    return this.fileStream;
  }

  /** Default location: ~/.abb-rws-extension/logs/abb-rws-{YYYY-MM-DDTHH-MM-SS}.ndjson */
  private makeLogPath(): string {
    const dir = path.join(os.homedir(), '.abb-rws-extension', 'logs');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return path.join(dir, `abb-rws-${stamp}.ndjson`);
  }

  /** Keep the last 20 log files; delete older ones to avoid disk creep. */
  private pruneOldLogs(): void {
    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) { return; }
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('abb-rws-') && f.endsWith('.ndjson'))
        .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const { f } of files.slice(20)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  private ts(): string {
    const d = new Date();
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }

  private writeFile(level: string, category: string, msg: string, data?: unknown): void {
    try {
      this.fs.write(JSON.stringify({
        ts: new Date().toISOString(),
        level,
        category,
        msg,
        ...(data !== undefined ? { data } : {}),
      }) + '\n');
    } catch { /* never let logging break the app */ }
  }

  info(msg: string): void {
    this.ch.appendLine(`[${this.ts()}] ${msg}`);
    this.writeFile('info', 'app', msg);
  }

  warn(msg: string): void {
    this.ch.appendLine(`[${this.ts()}] WARN  ${msg}`);
    this.writeFile('warn', 'app', msg);
  }

  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : '';
    this.ch.appendLine(`[${this.ts()}] ERROR ${msg}${detail ? ' — ' + detail : ''}`);
    this.writeFile('error', 'app', msg, { err: detail, stack: err instanceof Error ? err.stack : undefined });
  }

  trace(category: string, msg: string, data?: unknown): void {
    // HTTP and command traces appear in the file but only category != 'http.*' shows
    // in the output channel — http traffic spam would drown out other lines.
    if (!category.startsWith('http.')) {
      this.ch.appendLine(`[${this.ts()}] ${category.padEnd(10)} ${msg}`);
    }
    this.writeFile('trace', category, msg, data);
  }

  /** Bring the output panel to front — call this when an error needs attention. */
  show(): void { this.ch.show(true); }

  /** Open the persistent log file in VS Code (for sharing with support). */
  showFile(): void {
    this.fs.cork(); // flush before opening
    setTimeout(() => {
      this.fs.uncork();
      vscode.workspace.openTextDocument(this.logFilePath).then(doc => {
        vscode.window.showTextDocument(doc, { preview: false });
      }, err => {
        vscode.window.showErrorMessage(`Could not open log file: ${err.message}`);
      });
    }, 50);
  }

  /** Path of the current session's log file. */
  getLogFilePath(): string { return this.logFilePath; }

  dispose(): void {
    this.channel?.dispose();
    this.channel = null;
    this.fileStream?.end();
    this.fileStream = null;
  }
}

export const Logger = new LoggerImpl();
