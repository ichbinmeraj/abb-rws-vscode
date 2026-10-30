// What protects the controller's copy before a module file is loaded (Push
// Current File, Load Program from File, the lens load, Run routine): the parts
// that need no `vscode`, so the unit tests can state them.
//
//   1. The file is read as bytes. An empty file, and any byte at 0x80 or
//      above (a byte order mark, a Latin-1 or a UTF-8 character), is refused,
//      naming the line, the column and the byte: a controller reads a module
//      file as single-byte text, so a UTF-8 character is stored wrong (mojibake
//      in the program text on 6.16.03, 7.21.4 and 8.2.1, saved back
//      double-encoded by 7 and 8), and a byte order mark becomes part of the
//      module's name on 7 and 8 (VC probes of 2026-10-30). So is any
//      control byte other than tab, LF and CR (a UTF-16 file saved without a
//      byte order mark has a zero byte after every character, and passes a
//      UTF-8 decode): a RAPID module is plain text. Lines end at LF, CRLF or
//      a lone CR, so the line named is the one the editor shows.
//   2. The controller's copy is read (`getModuleText`, a GET) and compared
//      with the base recorded when the file was pulled: `same`, `changed` or
//      `unknown`. Changed, and unknown, stop with the diff and a "Push anyway"
//      button. A copy equal to the file is nothing to push.
//   3. The controller's copy is saved as a restore point under the extension's
//      global storage, outside any workspace, before anything is sent. If the
//      load fails after the module was unloaded, the saved copy is offered
//      back as its own confirmed write.

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { FileOrigin } from './taskResolver';

// ─── 1. The bytes ────────────────────────────────────────────────────────────

export interface AsciiOffender { line: number; column: number; byte: number; text: string }

export type AsciiVerdict =
  | { ok: true; text: string; bytes: number }
  | { ok: false; why: 'empty' | 'bom' | 'non-ascii' | 'control'; offenders: AsciiOffender[]; message: string };

/** A byte that is not plain ASCII text: at 0x80 or above, or a control byte other than tab, LF and CR. */
const isControl = (b: number): boolean => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f;

/** The line's bytes as text, with every byte at 0x80 or above, and every control byte, written as \xNN. */
function showLine(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x0d) { continue; }
    out += b >= 0x80 || isControl(b) ? `\\x${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b);
  }
  return out;
}

/** Where the line that holds position `i` ends: the next LF or CR, or the end of the file. */
function lineEnd(bytes: Buffer, i: number): number {
  for (let j = i; j < bytes.length; j++) { if (bytes[j] === 0x0a || bytes[j] === 0x0d) { return j; } }
  return bytes.length;
}

/**
 * Check a module file's bytes. `label` is the command ("Push Current File"),
 * `fileName` the file as the message names it. Up to three offending lines are
 * shown; the first offender's line and column are what the message names.
 */
export function asciiCheck(bytes: Buffer, label: string, fileName: string): AsciiVerdict {
  if (bytes.length === 0 || bytes.every(b => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d)) {
    return { ok: false, why: 'empty', offenders: [], message: `${label} not sent: ${fileName} is empty. Nothing was sent.` };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      ok: false, why: 'bom', offenders: [{ line: 1, column: 1, byte: 0xef, text: showLine(bytes.subarray(0, Math.min(lineEnd(bytes, 0), 80))) }],
      message: `${label} not sent: ${fileName} starts with a byte order mark (bytes EF BB BF). `
        + 'The controller reads a module file as single-byte text, so the mark becomes three characters in front of MODULE, and RobotWare 7 and 8 then name the module after the first of them. '
        + 'Save the file without the byte order mark, then push again. Nothing was sent.',
    };
  }
  const offenders: AsciiOffender[] = [];
  let line = 1;
  let lineStart = 0;
  let lastLine = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a) { line++; lineStart = i + 1; continue; }
    // A lone CR ends a line too; the CR of a CRLF is part of the LF's line end.
    if (b === 0x0d) { if (bytes[i + 1] !== 0x0a) { line++; lineStart = i + 1; } continue; }
    if ((b >= 0x80 || isControl(b)) && line !== lastLine) {
      const end = lineEnd(bytes, i);
      offenders.push({ line, column: i - lineStart + 1, byte: b, text: showLine(bytes.subarray(lineStart, Math.min(end, lineStart + 120))) });
      lastLine = line;
    }
  }
  if (offenders.length === 0) { return { ok: true, text: bytes.toString('latin1'), bytes: bytes.length }; }
  const first = offenders[0];
  const shown = offenders.slice(0, 3).map(o => `${o.line}:  ${o.text}`).join('\n');
  const more = offenders.length > 3 ? ` (${offenders.length - 3} more line${offenders.length - 3 === 1 ? '' : 's'})` : '';
  const at = `on line ${first.line}, column ${first.column} (byte 0x${first.byte.toString(16).toUpperCase().padStart(2, '0')}).\n${shown}${more}\n`;
  if (isControl(first.byte)) {
    return {
      ok: false, why: 'control', offenders,
      message: `${label} not sent: ${fileName} has a control character ${at}`
        + 'A RAPID module is plain text, and a control byte means the file is not the text the controller would read: a UTF-16 file saved without a byte order mark has a zero byte after every character, and a binary file has many. '
        + 'Save the file as ASCII text, then push again. Nothing was sent.',
    };
  }
  return {
    ok: false, why: 'non-ascii', offenders,
    message: `${label} not sent: ${fileName} has a non-ASCII character ${at}`
      + 'RAPID Live does not send non-ASCII text to a controller: the controller reads a module file as single-byte text, so a UTF-8 character would be stored wrong (RobotWare 6.16, 7.21 and 8.2 checked on 2026-10-30). '
      + 'Replace the character or use an ASCII spelling, then push again. Nothing was sent.',
  };
}

/** The name the client loads a file as, and unloads first: the file name without `.mod`, `.sys` or `.prg`. */
export function moduleNameOfFile(fileName: string): string {
  return fileName.replace(/\.(mod|sys)$/i, '');
}

/**
 * The refusal when the file's declared MODULE name is not its file name,
 * exactly: the client names the module it loads, and the module it unloads
 * first, after the file, while the dialog and the base check go by the
 * declaration. With the two apart, a module the dialog never named could be
 * unloaded. Undefined when they agree (or the file declares no module).
 */
export function moduleNameMismatch(label: string, fileName: string, declared: string): string | undefined {
  const base = moduleNameOfFile(fileName);
  if (base === declared) { return undefined; }
  const ext = fileName.slice(base.length) || '.mod';
  return `${label} not sent: ${fileName} declares MODULE ${declared}, but the controller loads it as ${base} and replaces a module of that name. `
    + `Name the file ${declared}${ext} or the module ${base}, exactly as the other, then push again. Nothing was sent.`;
}

// ─── 2. The base ─────────────────────────────────────────────────────────────

/** Line endings to LF; nothing else is normalised. */
export function normalizeLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** sha256 of the LF-normalised text, hex: the hash the base compare uses on both sides. */
export function controllerHash(text: string): string {
  return createHash('sha256').update(normalizeLf(text), 'utf8').digest('hex');
}

export type BaseVerdict =
  | { kind: 'same'; recordedAt?: string }
  | { kind: 'changed'; recordedAt?: string }
  | { kind: 'unknown'; why: 'no record' | 'no controller hash' | 'other robot' | 'other task' }
  | { kind: 'nothing-to-push' };

/**
 * Whether the controller's copy is the one the file was pulled from. `same`
 * when its hash equals the recorded `ctrlHash`; `changed` when it differs;
 * `unknown` with no record, no controller hash (a record from before 1.5.0),
 * a record of another robot or of another task. A controller copy equal to
 * the local text, after LF normalisation, is nothing to push.
 *
 * Both hashes come from the module text read (`getModuleText`): it carries a
 * PERS at its declared value, where a module save (the pulled file) carries the
 * current one (VC probe J2b, 2026-10-30, on 6.16.03, 7.21.4 and 8.2.1). So a
 * PERS that moves while the program runs is not a change on the controller,
 * and the base is read with one more GET after a pull, which takes no lock.
 */
export function baseVerdict(origin: FileOrigin | undefined, robotId: string, task: string, ctrlText: string, localText: string): BaseVerdict {
  if (normalizeLf(ctrlText) === normalizeLf(localText)) { return { kind: 'nothing-to-push' }; }
  if (!origin) { return { kind: 'unknown', why: 'no record' }; }
  if (origin.robotId !== undefined && origin.robotId !== robotId) { return { kind: 'unknown', why: 'other robot' }; }
  if (origin.task !== task) { return { kind: 'unknown', why: 'other task' }; }
  if (!origin.ctrlHash) { return { kind: 'unknown', why: 'no controller hash' }; }
  return controllerHash(ctrlText) === origin.ctrlHash ? { kind: 'same', recordedAt: origin.at } : { kind: 'changed', recordedAt: origin.at };
}

/** `2026-11-20 14:02` from an ISO time, in local time; the time alone when the day is today. */
export function whenText(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) { return 'an unknown time'; }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return 'an unknown time'; }
  const two = (n: number): string => String(n).padStart(2, '0');
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${time}`;
}

/** The modal that stops a push whose base changed, or is not known. Nothing is sent by it. */
export function changedText(verdict: Extract<BaseVerdict, { kind: 'changed' | 'unknown' }>, module: string, task: string, robotLabel: string, fileName: string): { message: string; detail: string; showDiff: string; pushAnyway: string } {
  const message = verdict.kind === 'changed'
    ? `${module} in ${task} on ${robotLabel} has changed on the controller since you pulled it (${whenText(verdict.recordedAt)}).`
    : `RAPID Live has no record of pulling ${fileName} from ${task} on ${robotLabel}, so it cannot tell whether the controller's copy changed.`;
  const detail = verdict.kind === 'changed'
    ? 'Nothing was sent. The controller\'s copy differs from the one RAPID Live recorded, for example by a change at the FlexPendant.'
    : 'Nothing was sent. It differs from your file.';
  return { message, detail, showDiff: 'Show diff', pushAnyway: 'Push anyway…' };
}

// ─── 3. The restore point ────────────────────────────────────────────────────

export interface RestoreMeta {
  robotId: string;
  robotName: string;
  host: string;
  task: string;
  module: string;
  /** The file the saved copy is kept as. */
  file: string;
  changeCount?: number;
  /** `controllerHash` of the text. */
  hash: string;
  at: string;
  reason: string;
  nonAscii: boolean;
}

/** A name that is safe as a folder name on every platform. */
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_');

/** `<root>/restore-points/<robotId>/<task>/<yyyymmddThhmmssZ>/`, the module's file inside it, and `restore.json` next to it. */
export function restorePointPaths(root: string, robotId: string, task: string, module: string, ext: string, at: Date): { dir: string; file: string; meta: string } {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dir = path.join(root, 'restore-points', safeName(robotId), safeName(task), stamp);
  return { dir, file: path.join(dir, `${safeName(module)}${ext || '.mod'}`), meta: path.join(dir, 'restore.json') };
}

/** Whether the controller's text has a character above 0x7F, or a control character other than tab, LF and CR: the saved copy cannot be reloaded by RAPID Live yet, so the offer is withheld. */
export function hasNonAscii(text: string): boolean {
  return /[^\x09\x0a\x0d\x20-\x7e]/.test(text);
}

/** The file system the retention reads (`node:fs` in the extension, a fake in the tests). */
export interface RestoreFs {
  list(dir: string): string[];
  isDir(p: string): boolean;
  size(file: string): number;
  remove(dir: string): void;
  readMeta(file: string): RestoreMeta | undefined;
}

/**
 * Retention: the newest 20 per robot, task and module, and never more than
 * 100 MB in all; the oldest go first. Returns the directories removed.
 */
/**
 * `spare`: the directory of the point being restored right now. The restore
 * saves the live module as a new point first, which could push the chosen
 * point past the twenty kept (or over the byte cap) before the load reads it;
 * the spare counts as the newest point, so it is never removed.
 */
export function pruneRestorePoints(root: string, fs: RestoreFs, keep: number = 20, maxBytes: number = 100 * 1024 * 1024, spare?: string): string[] {
  const base = path.join(root, 'restore-points');
  if (!fs.isDir(base)) { return []; }
  const points: Array<{ dir: string; key: string; size: number; stamp: string }> = [];
  for (const robot of fs.list(base)) {
    const robotDir = path.join(base, robot);
    if (!fs.isDir(robotDir)) { continue; }
    for (const task of fs.list(robotDir)) {
      const taskDir = path.join(robotDir, task);
      if (!fs.isDir(taskDir)) { continue; }
      for (const stamp of fs.list(taskDir)) {
        const dir = path.join(taskDir, stamp);
        if (!fs.isDir(dir)) { continue; }
        const meta = fs.readMeta(path.join(dir, 'restore.json'));
        const size = fs.list(dir).reduce((n, f) => n + fs.size(path.join(dir, f)), 0);
        points.push({ dir, key: `${robot}/${task}/${meta?.module ?? '?'}`, size, stamp });
      }
    }
  }
  points.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  const spareAt = spare === undefined ? -1 : points.findIndex(p => path.resolve(p.dir) === path.resolve(spare));
  if (spareAt > 0) { points.unshift(...points.splice(spareAt, 1)); }
  const removed: string[] = [];
  const perKey = new Map<string, number>();
  let total = 0;
  for (const p of points) {
    const n = (perKey.get(p.key) ?? 0) + 1;
    perKey.set(p.key, n);
    if (n > keep) { removed.push(p.dir); continue; }
    total += p.size;
  }
  for (let i = points.length - 1; i >= 0 && total > maxBytes; i--) {
    if (removed.includes(points[i].dir)) { continue; }
    removed.push(points[i].dir);
    total -= points[i].size;
  }
  for (const dir of removed) { fs.remove(dir); }
  return removed;
}

/** The closing message of a push whose load failed, with what happened to the restore. */
export function failureReport(label: string, fileName: string, task: string, robotLabel: string, reason: string, restore: 'reloaded' | 'declined' | 'withheld' | 'not-needed' | { failed: string }): string {
  const head = `${label} of ${fileName} to ${task} on ${robotLabel} failed: ${reason}`;
  const tail = restore === 'reloaded' ? 'Restore: the saved copy was reloaded.'
    : restore === 'declined' ? 'Restore: not reloaded (declined).'
    : restore === 'withheld' ? 'Restore: the saved copy contains non-ASCII characters and cannot be reloaded by RAPID Live yet; it is kept on disk.'
    : restore === 'not-needed' ? 'The module is still loaded as it was; nothing was lost.'
    : `Restore: failed: ${restore.failed}`;
  return `${head} ${tail}`;
}
