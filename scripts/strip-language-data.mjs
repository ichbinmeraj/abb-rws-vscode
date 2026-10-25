#!/usr/bin/env node
/**
 * Reduce the RAPID language database to signatures only.
 *
 * Hover, completion and signature help show, per RAPID instruction, function
 * and data type: its name, its kind, its call shape, its parameters with their
 * types and optional / switch markers, and the return type of a function.
 * No description, usage text or example is kept.
 *
 * Input: a database as written by parse-rapid-manual.mjs
 *   { kind, name, brief, usage, syntax, examples, parameters }
 * or one this script already reduced (running it again changes nothing).
 * Without arguments the input is read from git: the database file as of
 * commit 0c4e49d (SOURCE below), the last version that still has the syntax
 * blocks. Only its syntax blocks and parameter lists are read; the syntax
 * text stays in the git history and is not written to the output, and no
 * copy of it is kept in the tree. test/languageData.test.ts checks that the
 * shipped file is reproduced exactly from it when the commit is in the clone.
 *
 * Parameters: the syntax block of every instruction and function is parsed
 * again (parseParameters below), because the stored list often misses
 * arguments. The parsed list replaces the stored one when it holds every
 * stored name and more. Otherwise (the syntax block was cut at 500
 * characters, so its tail is missing) the stored list is kept and each name
 * only the parsed list has is inserted after the parameter it follows in the
 * syntax block.
 * Output, per entry:
 *   kind        'instruction' | 'function' | 'datatype' | 'keyword'
 *   name        as spelled in RAPID
 *   summary     one neutral line built from kind and return type only
 *               ("RAPID instruction", "RAPID function returning num", ...)
 *   signature   call shape built from the parameter list, e.g.
 *               "MoveJ [\Conc], ToPoint [\ID], Speed [\V], ...;" or
 *               "Offs(Point, XOffset, YOffset, ZOffset)"; a written form for
 *               statements and operators (IF, FOR, AND, ...); "" when the
 *               call shape is not known
 *   returns     return type of a function, when known
 *   parameters  [{ name, type, optional, switch?, alt? }] in call order
 *
 * usage: node scripts/strip-language-data.mjs
 *          reads SOURCE from git, writes resources/rapid-language-data.json
 *        node scripts/strip-language-data.mjs in.json [out.json]
 *          reads a file; out.json defaults to in.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The database before it was reduced, as `git show` names it. The file is the
 * same at every commit from 0c4e49d up to the one that reduced it.
 */
export const SOURCE = '0c4e49d769c39b4f085044973eac5947170c6da3:resources/rapid-language-data.json';

/** Written forms for statements and operators, which have no parameter list. */
const FORMS = {
  // Statements (kind 'instruction')
  if:       { signature: 'IF condition THEN\n  ...\n[ELSEIF condition THEN\n  ...]\n[ELSE\n  ...]\nENDIF' },
  for:      { signature: 'FOR i FROM start TO end [STEP step] DO\n  ...\nENDFOR' },
  while:    { signature: 'WHILE condition DO\n  ...\nENDWHILE' },
  test:     { signature: 'TEST value\n  CASE value1, value2:\n    ...\n  [DEFAULT:\n    ...]\nENDTEST' },
  connect:  { signature: 'CONNECT interrupt WITH trapRoutine;' },
  goto:     { signature: 'GOTO label;' },
  label:    { signature: 'label:' },
  comment:  { signature: '! text' },
  proccall: { signature: 'procedureName [arguments];' },
  raise:    { signature: 'RAISE [errorNumber];' },
  return:   { signature: 'RETURN [value];' },
  // Operators (kind 'function')
  and:      { signature: 'bool AND bool', returns: 'bool', operator: true },
  or:       { signature: 'bool OR bool',  returns: 'bool', operator: true },
  xor:      { signature: 'bool XOR bool', returns: 'bool', operator: true },
  not:      { signature: 'NOT bool',      returns: 'bool', operator: true },
  div:      { signature: 'num DIV num\ndnum DIV dnum', operator: true },
  mod:      { signature: 'num MOD num\ndnum MOD dnum', operator: true },
};

/**
 * Entries whose Syntax block disagrees with the same page's argument list and
 * examples. The argument list and the examples win: each listed argument is
 * set to the form they show. Keys are entry keys; values map a parameter name
 * (as parsed) to its corrected name and optional flag.
 */
const OVERRIDES = {
  capweavesync: {
    DoLeft:     { name: '\\DoLeft',     optional: true },
    LevelLeft:  { name: '\\LevelLeft',  optional: true },
    DoRight:    { name: '\\DoRight',    optional: true },
    LevelRight: { name: '\\LevelRight', optional: true },
  },
  uinumentry:  { Message: { name: '\\Message', optional: true } },
  uidnumentry: { Message: { name: '\\Message', optional: true } },
  uinumtune:   { Message: { name: '\\Message', optional: true } },
  uimsgwrite:  { '\\MsgArray': { name: 'MsgArray', optional: false } },
};

function applyOverrides(key, parameters) {
  const o = OVERRIDES[key];
  if (!o || !parameters) { return parameters; }
  return parameters.map(p => (o[p.name] ? { ...p, ...o[p.name] } : p));
}

const TYPE_NAME = /^[A-Za-z_]\w*$/;

/** Return type of a function, read from the type name its syntax block states. */
function returnType(syntax) {
  const m = /with (?:a )?return value of (?:the )?(?:data )?type:?\s*([A-Za-z_]\w*)/i.exec(syntax);
  return m && TYPE_NAME.test(m[1]) ? m[1] : undefined;
}

/**
 * The syntax block from the line that starts with the entry's own name, with
 * the quotes around literal tokens removed (`'\'`, `':='`, `';'` and the
 * U+FFFD that some quotes decoded to). null when no line starts with the name
 * (the block belongs to another entry, or is not a syntax block at all).
 */
function ownSyntax(name, syntax) {
  if (!syntax) { return null; }
  const lines = syntax.replace(/['�]/g, '').split('\n').map(l => l.trim());
  const head = new RegExp(`^${name}(?!\\w)`, 'i');
  const at = lines.findIndex(l => head.test(l));
  return at < 0 ? null : lines.slice(at).join('\n');
}

/** `Name;` / `Name()` when the syntax block shows a call without arguments. */
function noArgumentForm(e, own) {
  if (!own) { return null; }
  const rest = own.slice(e.name.length);
  if (e.kind === 'function' && /^\s*\(\s*\)/.test(rest)) { return `${e.name}()`; }
  if (e.kind === 'instruction' && /^\s*;/.test(rest)) { return `${e.name};`; }
  return null;
}

/**
 * Parameter list from a syntax block, with the quotes already removed.
 * `any type` is accepted as a type and `array {*}` before the access mode.
 * A name written with a backslash is optional; any other name is required:
 *   [Name :=] <... of T>      required, its name may be left out
 *   [Name := <... of T>]      required (the manual brackets the whole argument)
 *   Name := <... of T>        required
 *   [\Name := <... of T>]     optional; also with `=` for `:=` or no `[`
 *   [\Name]                   switch; also `[\Name` closed by a function's `)`
 * An argument after `|` is an alternative to the one before it.
 */
function parseParameters(own) {
  const wrapper = String.raw`(?:array|expression|persistent|variable|reference|var|pers)\b`;
  const type = String.raw`(any\s*type|\w+)`;
  const required = new RegExp(String.raw`\[\s*([A-Za-z_]\w*)\s*:?=\s*\]\s*<\s*${wrapper}[^>]*?of\s+${type}\s*>`, 'gi');
  const reqNamed = new RegExp(String.raw`(?:\[\s*)?(?<!\\\s*)\b([A-Za-z_]\w*)\s*:?=\s*<\s*${wrapper}[^>]*?of\s+${type}\s*>\s*,?\s*\]?`, 'gi');
  const optNamed = new RegExp(String.raw`(?:\[\s*)?\\\s*([A-Za-z_]\w*)\s*:?=\s*\]?\s*<\s*${wrapper}[^>]*?of\s+${type}\s*>\s*,?\s*\]?`, 'gi');
  const optSwitch = new RegExp(String.raw`\[\s*\\\s*(?:switch\s+)?([A-Za-z_]\w*)\s*,?\s*(?:\]|(?=\)))(?!\s*<)`, 'gi');
  const typeName = t => t.replace(/\s+/g, '').toLowerCase() === 'anytype' ? 'anytype' : t;

  const found = [];
  for (const m of own.matchAll(required)) {
    found.push({ at: m.index, end: m.index + m[0].length, name: m[1], type: typeName(m[2]), optional: false });
  }
  for (const m of own.matchAll(reqNamed)) {
    found.push({ at: m.index, end: m.index + m[0].length, name: m[1], type: typeName(m[2]), optional: false });
  }
  for (const m of own.matchAll(optNamed)) {
    found.push({ at: m.index, end: m.index + m[0].length, name: '\\' + m[1], type: typeName(m[2]), optional: true });
  }
  for (const m of own.matchAll(optSwitch)) {
    found.push({ at: m.index, end: m.index + m[0].length, name: '\\' + m[1], type: 'switch', optional: true, switch: true });
  }
  found.sort((a, b) => a.at - b.at);

  const params = [];
  let prevEnd = -1;
  for (const { at, end, ...p } of found) {
    if (at < prevEnd) { continue; }  // overlapping match of another shape
    if (params.some(q => q.name === p.name)) { prevEnd = end; continue; }
    const between = prevEnd >= 0 ? own.slice(prevEnd, at) : '';
    if (between.includes('|') && /^[\s|,]*$/.test(between)) { p.alt = true; }
    params.push(p);
    prevEnd = end;
  }
  return params;
}

/**
 * The parameter list to keep, from the stored one and the one parsed again
 * from the syntax block: the parsed list when it holds every stored name and
 * more; otherwise the stored list with each name only the parsed list has
 * inserted after the parameter it follows in the parsed list.
 */
function withParsed(stored, parsed) {
  const parsedNames = new Set(parsed.map(p => p.name));
  if (parsed.length > stored.length && stored.every(p => parsedNames.has(p.name))) { return parsed; }
  const merged = [...stored];
  let after = -1;
  for (const p of parsed) {
    const at = merged.findIndex(q => q.name === p.name);
    if (at >= 0) { after = at; continue; }
    merged.splice(after + 1, 0, p);
    after += 1;
  }
  return merged;
}

/**
 * Call shape from a parameter list. A required argument opens a new
 * comma-separated slot; an optional one attaches to the slot it follows;
 * an alternative (`alt`) is joined with `|`.
 *   MoveJ [\Conc], ToPoint [\ID], Speed [\V], Zone [\Z] [\Inpos], Tool [\WObj] [\TLoad];
 *   ClkRead(Clock [\HighRes])
 */
export function callShape(kind, name, params) {
  const slots = [];
  let cur = [];
  for (const p of params) {
    const label = p.optional ? `[${p.name}]` : p.name;
    if (p.alt && cur.length) { cur.push('|', label); continue; }
    if (!p.optional && cur.length) { slots.push(cur); cur = []; }
    cur.push(label);
  }
  if (cur.length) { slots.push(cur); }
  const args = slots.map(s => s.join(' ')).join(', ');
  return kind === 'function' ? `${name}(${args})` : `${name}${args ? ' ' + args : ''};`;
}

function summaryFor(kind, returns, operator) {
  if (operator) { return returns ? `RAPID operator returning ${returns}` : 'RAPID operator'; }
  switch (kind) {
    case 'instruction': return 'RAPID instruction';
    case 'function':    return returns ? `RAPID function returning ${returns}` : 'RAPID function';
    case 'datatype':    return 'RAPID data type';
    case 'keyword':     return 'RAPID keyword';
    default:            return 'RAPID';
  }
}

function cleanParameter(p) {
  const q = { name: p.name, type: p.type, optional: !!p.optional };
  if (p.switch) { q.switch = true; }
  if (p.alt) { q.alt = true; }
  return q;
}

/** One entry, reduced. */
export function stripEntry(e) {
  const key = e.name.toLowerCase();
  const form = e.kind === 'instruction' || e.kind === 'function' ? FORMS[key] : undefined;
  const fromParser = typeof e.syntax === 'string';
  let parameters = Array.isArray(e.parameters) ? e.parameters.map(cleanParameter) : undefined;
  let signature;
  let returns = typeof e.returns === 'string' ? e.returns : undefined;

  if (e.kind === 'keyword') {
    // Keyword forms are written in parse-rapid-manual.mjs itself.
    signature = fromParser ? e.syntax : (e.signature ?? '');
  } else if (form) {
    signature = form.signature;
    returns = form.returns;
  } else if (!fromParser) {
    signature = e.signature ?? '';
  } else {
    if (e.kind === 'function') { returns = returnType(e.syntax); }
    const own = ownSyntax(e.name, e.syntax);
    if (e.kind !== 'datatype' && own) {
      const parsed = parseParameters(own);
      if (parsed.length) { parameters = withParsed(parameters ?? [], parsed).map(cleanParameter); }
    }
    parameters = applyOverrides(key, parameters);
    if (e.kind === 'datatype') {
      signature = '';
    } else if (parameters && parameters.length) {
      signature = callShape(e.kind, e.name, parameters);
    } else {
      signature = noArgumentForm(e, own) ?? '';
    }
  }

  const out = { kind: e.kind, name: e.name, summary: summaryFor(e.kind, returns, form?.operator) };
  out.signature = signature;
  if (returns) { out.returns = returns; }
  if (parameters) { out.parameters = parameters; }
  return out;
}

/** The whole database, reduced; keys and their order unchanged. */
export function stripDb(db) {
  const out = {};
  for (const [key, e] of Object.entries(db)) { out[key] = stripEntry(e); }
  return out;
}

/** SOURCE as text, read with `git show` in the repository at `root`; null when git cannot read it. */
function readSource(root) {
  const run = spawnSync('git', ['show', SOURCE], { cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

// ─── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let label, text, output;
  if (process.argv[2]) {
    const input = path.resolve(process.argv[2]);
    label = path.relative(process.cwd(), input);
    text = fs.readFileSync(input, 'utf-8');
    output = path.resolve(process.argv[3] ?? input);
  } else {
    label = `git show ${SOURCE}`;
    text = readSource(ROOT);
    if (text === null) {
      console.error(`git cannot read ${SOURCE}; fetch the full history (a shallow clone does not have it).`);
      process.exit(1);
    }
    output = path.join(ROOT, 'resources', 'rapid-language-data.json');
  }
  const db = JSON.parse(text);
  const stripped = stripDb(db);
  fs.writeFileSync(output, JSON.stringify(stripped, null, 0));
  const after = fs.statSync(output).size;
  const n = Object.keys(stripped).length;
  const withSig = Object.values(stripped).filter(e => e.signature).length;
  console.log(`${label} (${Buffer.byteLength(text)} bytes, ${Object.keys(db).length} entries)`);
  console.log(`  -> ${path.relative(process.cwd(), output)} (${after} bytes, ${n} entries, ${withSig} with a signature)`);
}
