#!/usr/bin/env node
/**
 * Parse the ABB RAPID reference manual PDF text dump into the signatures-only
 * JSON database the hover, completion and signature help read.
 *
 * Input:  the text dump of ABB's RAPID reference manual (`pdftotext -layout Rapid_instructions.pdf`),
 *         given as the first argument. The manual text is not kept in this repository.
 * Output: extension's resources/rapid-language-data.json
 *
 * Only structure is read from the manual: each entry's name and kind, its
 * syntax block (for the parameter list and a function's return type). The
 * database is reduced by strip-language-data.mjs before it is written, so it
 * holds kind, name, call shape, parameters with types and optional / switch
 * markers, and return type - no description, usage text or example.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripDb } from './strip-language-data.mjs';

const INPUT = process.argv[2];
if (!INPUT) { console.error('usage: node scripts/parse-rapid-manual.mjs <text dump of the RAPID reference manual>'); process.exit(1); }
const OUT   = path.resolve('resources/rapid-language-data.json');

const raw = fs.readFileSync(INPUT, 'utf-8');
const lines = raw.split('\n');

// Strip page-furniture noise: headers, footers, copyright lines, page numbers.
// Trim first - footers are column-aligned (leading spaces) and page headers
// carry a leading form feed, both of which defeat ^-anchored patterns.
// Copyright / doc-number lines share their line with the page number in the
// two-column layout, so those are substring tests.
function isNoise(line) {
  const t = line.trim();
  return /^(?:\d+\s+)?Technical reference manual/i.test(t)
      || /^Continues on next page/i.test(t)
      || /Copyright \d{4}(?:-\d{4})? ABB/i.test(t)
      || /3HAC050917-001 Revision/i.test(t)
      || /^RobotWare\s*-\s*OS/i.test(t)
      || /^Continued$/i.test(t)
      || /^Index$/i.test(t)
      || /^\d+ Instructions?$/i.test(t)
      || /^\d+ Functions?$/i.test(t)
      || /^\d+ Data types?$/i.test(t);
}

// At page breaks pdftotext merges page furniture onto content lines, either
// side ("[\Orient]        1 Instructions", "1 Instructions        See",
// "Continued        Application manual - …") - strip the furniture column,
// keep the content.
function stripPageHeader(line) {
  return line
    .replace(/\s{2,}\d+ (?:Instructions?|Functions?|Data types?)\s*$/i, '')
    .replace(/^\s*(?:\d+ (?:Instructions?|Functions?|Data types?)|Continued|RobotWare\s*-\s*OS)\s{2,}/i, '');
}

// Detect entry-start markers in the BODY (after TOC).
// Section 1: "1.1 AccSet - Reduces the acceleration"
// Section 2: "2.1 Abs - Gets the absolute value"
// Section 3: "3.1 aiotrigg - Analog I/O trigger"
function entryHeader(line, sectionNum) {
  // Use a regex that captures: section.entry, name, dash, brief
  // Names: section 1+2 use TitleCase, section 3 uses lowerCase
  const re = new RegExp(`^${sectionNum}\\.(\\d+)\\s+([A-Za-z_][\\w]*?)\\s*[---]\\s*(.+?)(?:\\s*\\.{3,}.*)?$`);
  const m = line.match(re);
  if (!m) { return null; }
  return { num: m[1], name: m[2], brief: m[3].trim() };
}

// Walk a section's body lines, returning a map: entry-name → raw text block.
// Multi-page entries have the same `1.X Name -` header reprinted on every
// page; we de-dupe those by ignoring same-name re-occurrences (the body
// continues until a DIFFERENT entry header).
function splitSection(bodyLines, sectionNum) {
  const entries = new Map();
  let cur = null;
  let curLines = [];
  for (const ln of bodyLines) {
    if (isNoise(ln)) continue;
    const h = entryHeader(ln.trim(), sectionNum);
    if (h) {
      // Same entry repeated on next page - skip, keep accumulating into cur
      if (cur && h.name === cur.name) { continue; }
      if (cur) { entries.set(cur.name, { ...cur, body: curLines.join('\n') }); }
      cur = h;
      curLines = [];
      continue;
    }
    if (cur) { curLines.push(stripPageHeader(ln)); }
  }
  if (cur) { entries.set(cur.name, { ...cur, body: curLines.join('\n') }); }
  return entries;
}

// Extract the formal "Syntax" block from an entry body.
// Pattern: lines after a "Syntax" header, continuing until next ALL-CAPS section or "Related" / "Limitations"
function extractSyntax(body) {
  const lines = body.split('\n');
  let collecting = false;
  let blockLines = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!collecting) {
      if (t === 'Syntax' || /^Syntax\s*$/.test(t)) { collecting = true; continue; }
    } else {
      // End markers: another section header (e.g. "Related information", "Limitations")
      if (/^(Related information|Limitations|Error handling|Predefined data|Components|Structure|Examples?|See also|More examples)\b/i.test(t)) {
        break;
      }
      // Skip the entry's own continuation header (e.g. "1.1 AccSet - ...")
      if (/^\d+\.\d+ +[A-Za-z]/.test(t)) continue;
      blockLines.push(t);
    }
  }
  // Clean the syntax: remove trailing empty lines, collapse internal spaces
  const cleaned = blockLines
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0)
    .join('\n');
  return cleaned;
}

// ─── Locate body sections ──────────────────────────────────────────────────

function findBody(secLine) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === secLine) { return i; }
  }
  return -1;
}

const startInstr     = findBody('1 Instructions');  // body starts at line ~1029
const startFuncs     = findBody('2 Functions');     // body starts at line ~57071
const startDataTypes = findBody('3 Data types');    // body starts at line ~77791

// Some files have multiple matches (TOC has same line); pick the second occurrence.
function findNthBody(secLine, n) {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === secLine) {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}
const sec1 = findNthBody('1 Instructions', 2);
const sec2 = findNthBody('2 Functions', 2);
const sec3 = findNthBody('3 Data types', 2);
const secEnd = lines.length;

if (sec1 < 0 || sec2 < 0 || sec3 < 0) {
  console.error('Could not locate section bodies', { sec1, sec2, sec3 });
  process.exit(1);
}

console.log(`Section 1 (Instructions): lines ${sec1}-${sec2 - 1}`);
console.log(`Section 2 (Functions):    lines ${sec2}-${sec3 - 1}`);
console.log(`Section 3 (Data types):   lines ${sec3}-${secEnd - 1}`);

const instrLines = lines.slice(sec1, sec2);
const funcLines  = lines.slice(sec2, sec3);
const dataLines  = lines.slice(sec3, secEnd);

const instr = splitSection(instrLines, 1);
const funcs = splitSection(funcLines,  2);
const datas = splitSection(dataLines,  3);

console.log(`Parsed: ${instr.size} instructions, ${funcs.size} functions, ${datas.size} data types`);

// ─── Build the database ────────────────────────────────────────────────────

const db = {};

/**
 * Parse a RAPID syntax block into a parameter list.
 * Recognized line shapes:
 *   - `[ ParamName ':=' ] < expression (KIND) of TypeName > ','`   → required positional
 *   - `[ '\' OptName ':=' < ... > ]`                                → optional named
 *   - `[ '\' Switch ]` or `[ '\' Switch ',' ]`                      → optional switch (no value)
 * Returns: [{ name, type, optional, switch, alt }] in CALL ORDER - the order
 * the arguments appear in the syntax pattern. Signature help indexes into
 * this list, so optional args must stay interleaved with the positional ones,
 * exactly where they occur in a call. `alt` marks a parameter that is an
 * alternative to the previous one (`Signal | PersBool`) - they share one
 * call slot.
 */
function parseParameters(syntax) {
  if (!syntax) { return []; }
  // Regex over the whole string, one pattern per shape.
  // Required pattern:
  //   [ \s* (Name) \s* ':=' ] < ... of (Type) > (with various spacing)
  // Optional named (\Name):
  //   [ \s* '\' (Name) \s* ':=' ... < ... of (Type) > ]
  // Optional switch:
  //   [ \s* '\' (Name) \s* ]   - sometimes with a quoted ',' before the `]`
  // The token between `<` and `of` varies: expression, variable, persistent,
  // "var or pers", "variable or persistent", reference - with erratic spacing.
  // Quotes around the backslash sometimes decode as U+FFFD in the text dump.
  const wrapper = String.raw`(?:expression|persistent|variable|reference|var|pers)\b`;
  const bs = String.raw`['�]?\\['�]?`;
  const requiredRe = new RegExp(String.raw`\[\s*([A-Za-z_]\w*)\s*'?:='?\s*\]\s*<\s*${wrapper}[^>]*of\s+(\w+)\s*>`, 'gi');
  const optNamedRe = new RegExp(String.raw`\[\s*${bs}\s*([A-Za-z_]\w*)\s*'?:='?\s*<\s*${wrapper}[^>]*of\s+(\w+)\s*>\s*\]`, 'gi');
  const optSwitchRe = new RegExp(String.raw`\[\s*${bs}\s*([A-Za-z_]\w*)\s*(?:','\s*)?\](?!\s*<)`, 'gi');

  // Collect every match with its position, then sort - this preserves call order.
  const found = [];
  for (const m of syntax.matchAll(requiredRe)) {
    found.push({ at: m.index, end: m.index + m[0].length, name: m[1], type: m[2], optional: false });
  }
  for (const m of syntax.matchAll(optNamedRe)) {
    found.push({ at: m.index, end: m.index + m[0].length, name: '\\' + m[1], type: m[2], optional: true });
  }
  for (const m of syntax.matchAll(optSwitchRe)) {
    found.push({ at: m.index, end: m.index + m[0].length, name: '\\' + m[1], type: 'switch', optional: true, switch: true });
  }
  found.sort((a, b) => a.at - b.at);

  const params = [];
  let prevEnd = -1;
  for (const { at, end, ...p } of found) {
    // Multi-page entries can repeat a fragment; alternatives (\V | \T) are
    // distinct names - keep first occurrence of each name only.
    if (params.some(q => q.name === p.name)) { prevEnd = end; continue; }
    // A bare `|` between this match and the previous one marks an alternative.
    // Anything besides separator characters in between (e.g. an unparsable
    // bracket group) means these are NOT adjacent alternatives.
    const between = prevEnd >= 0 ? syntax.slice(prevEnd, at) : '';
    if (between.includes('|') && /^[\s|',]*$/.test(between)) { p.alt = true; }
    params.push(p);
    prevEnd = end;
  }
  return params;
}

function addEntries(entries, kind) {
  for (const [name, e] of entries) {
    const syntax     = extractSyntax(e.body);
    const parameters = parseParameters(syntax);
    db[name.toLowerCase()] = {
      kind,
      name,
      syntax:   syntax.slice(0, 500),  // read by stripDb for the return type; not written
      parameters,
    };
  }
}

addEntries(instr, 'instruction');
addEntries(funcs, 'function');
addEntries(datas, 'datatype');

// ─── Add structural keywords not in the instruction section ────────────────
// These are RAPID syntax constructs (module/routine declarations, control flow,
// data declaration prefixes). They don't have entries in the manual's section 1
// (which covers callable instructions only) but devs hover them all the time.
// The forms are written here, not taken from the manual.
const keywords = [
  ['MODULE',     'MODULE moduleName [(SYSMODULE | NOSTEPIN | VIEWONLY | READONLY | NOVIEW)]\n  …\nENDMODULE'],
  ['ENDMODULE',  'ENDMODULE'],
  ['PROC',       'PROC name([params])\n  …\nENDPROC'],
  ['ENDPROC',    'ENDPROC'],
  ['FUNC',       'FUNC type name([params])\n  …\nENDFUNC'],
  ['ENDFUNC',    'ENDFUNC'],
  ['TRAP',       'TRAP name\n  …\nENDTRAP'],
  ['ENDTRAP',    'ENDTRAP'],
  ['RECORD',     'RECORD recordType\n  …\nENDRECORD'],
  ['ENDRECORD',  'ENDRECORD'],
  ['VAR',        'VAR num counter := 0;'],
  ['PERS',       'PERS num totalRuns := 0;'],
  ['CONST',      'CONST num maxIters := 100;'],
  ['LOCAL',      'LOCAL PROC helper()\n  …\nENDPROC'],
  ['TASK',       'TASK PERS num taskCounter := 0;'],
  ['IF',         'IF cond THEN\n  …\nELSEIF other THEN\n  …\nELSE\n  …\nENDIF'],
  ['THEN',       'IF cond THEN'],
  ['ELSE',       'ELSE'],
  ['ELSEIF',     'ELSEIF other THEN'],
  ['ENDIF',      'ENDIF'],
  ['WHILE',      'WHILE cond DO\n  …\nENDWHILE'],
  ['ENDWHILE',   'ENDWHILE'],
  ['FOR',        'FOR i FROM 1 TO 10 DO\n  …\nENDFOR'],
  ['FROM',       'FOR i FROM 1 TO 10 DO'],
  ['TO',         'FOR i FROM 1 TO 10 DO'],
  ['STEP',       'FOR i FROM 0 TO 100 STEP 10 DO'],
  ['DO',         'DO'],
  ['ENDFOR',     'ENDFOR'],
  ['TEST',       'TEST x\n  CASE 1: …\n  CASE 2,3: …\n  DEFAULT: …\nENDTEST'],
  ['CASE',       'CASE 1, 2, 3:'],
  ['DEFAULT',    'DEFAULT:'],
  ['ENDTEST',    'ENDTEST'],
  ['RETURN',     'RETURN value;'],
  ['EXIT',       'EXIT;'],
  ['STOP',       'STOP;'],
  ['ERROR',      'ERROR\n  IF ERRNO = ERR_DIVZERO THEN\n    …'],
  ['UNDO',       'UNDO\n  …'],
  ['BACKWARD',   'BACKWARD'],
  ['TRYNEXT',   'TRYNEXT;'],
  ['RETRY',     'RETRY;'],
  ['RAISE',     'RAISE;'],
  ['CONNECT',   'CONNECT intr WITH trapName;'],
  ['WITH',      'CONNECT intr WITH trapName;'],
  ['NOSTEPIN',  'MODULE m1(NOSTEPIN)'],
  ['SYSMODULE', 'MODULE myUtils(SYSMODULE)'],
  ['VIEWONLY',  'MODULE m1(VIEWONLY)'],
  ['READONLY',  'MODULE m1(READONLY)'],
  ['NOVIEW',    'MODULE m1(NOVIEW)'],
  ['TRUE',      'VAR bool flag := TRUE;'],
  ['FALSE',     'VAR bool flag := FALSE;'],
];
for (const [name, syntax] of keywords) {
  if (!db[name.toLowerCase()]) {
    db[name.toLowerCase()] = { kind: 'keyword', name, syntax };
  }
}

// ─── Write output (signatures only) ────────────────────────────────────────
const shipped = stripDb(db);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(shipped, null, 0));  // minified

const stats = fs.statSync(OUT);
console.log(`Wrote ${OUT} - ${Object.keys(shipped).length} entries, ${(stats.size / 1024).toFixed(1)} KB`);

// ─── Verify a few entries ───────────────────────────────────────────────────
const samples = ['movej', 'movel', 'waittime', 'tpwrite', 'abs', 'cos', 'robtarget', 'jointtarget', 'num'];
console.log('\n=== sample entries ===');
for (const k of samples) {
  const e = shipped[k];
  if (!e) { console.log(`  ${k}: NOT FOUND`); continue; }
  console.log(`  ${e.name} (${e.kind}): ${e.summary}`);
  if (e.signature) console.log(`    ${e.signature.split('\n')[0].slice(0, 100)}`);
}
