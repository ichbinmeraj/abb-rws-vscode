#!/usr/bin/env node
/**
 * Parse the ABB RAPID reference manual PDF text dump into a JSON database.
 *
 * Input:  scripts/rapid.txt (output of `pdftotext -layout Rapid_instructions.pdf`)
 * Output: extension's resources/rapid-language-data.json
 *
 * Each entry captures:
 *   - kind: 'instruction' | 'function' | 'datatype'
 *   - name
 *   - brief (one-line description from TOC heading)
 *   - usage (multi-paragraph explanation)
 *   - syntax (formal syntax pattern)
 *   - examples (code samples)
 *   - related (See Also pointers)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const INPUT = 'scripts/rapid.txt';
const OUT   = path.resolve('resources/rapid-language-data.json');

const raw = fs.readFileSync(INPUT, 'utf-8');
const lines = raw.split('\n');

// Strip page-furniture noise: headers, footers, copyright lines, page numbers.
function isNoise(line) {
  return /^Technical reference manual - RAPID/i.test(line)
      || /^Continues on next page/i.test(line)
      || /^© Copyright \d{4}-\d{4} ABB/i.test(line)
      || /^.\s*Copyright \d{4}-\d{4} ABB/i.test(line)
      || /^3HAC050917-001 Revision/i.test(line)
      || /^RobotWare\s*-\s*OS/i.test(line)
      || /^Continued$/i.test(line)
      || /^Index$/i.test(line)
      || /^\d+ Instructions?$/i.test(line)
      || /^\d+ Functions?$/i.test(line)
      || /^\d+ Data types?$/i.test(line);
}

// Detect entry-start markers in the BODY (after TOC).
// Section 1: "1.1 AccSet - Reduces the acceleration"
// Section 2: "2.1 Abs - Gets the absolute value"
// Section 3: "3.1 aiotrigg - Analog I/O trigger"
function entryHeader(line, sectionNum) {
  // Use a regex that captures: section.entry, name, dash, brief
  // Names: section 1+2 use TitleCase, section 3 uses lowerCase
  const re = new RegExp(`^${sectionNum}\\.(\\d+)\\s+([A-Za-z_][\\w]*?)\\s*[-–—]\\s*(.+?)(?:\\s*\\.{3,}.*)?$`);
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
      // Same entry repeated on next page — skip, keep accumulating into cur
      if (cur && h.name === cur.name) { continue; }
      if (cur) { entries.set(cur.name, { ...cur, body: curLines.join('\n') }); }
      cur = h;
      curLines = [];
      continue;
    }
    if (cur) { curLines.push(ln); }
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

// Extract "brief" usage paragraph (the first 1-3 sentences of explanation)
function extractUsage(body) {
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !isNoise(l));
  // Look for the first paragraph after "Usage" or just take first few non-header lines
  let usage = [];
  let inUsage = false;
  for (let i = 0; i < lines.length && usage.length < 8; i++) {
    const t = lines[i];
    if (/^Usage\b/.test(t)) {
      inUsage = true;
      // Sometimes "Usage <text>" has the first sentence inline
      const inline = t.replace(/^Usage\s+/, '');
      if (inline && inline !== 'Usage') { usage.push(inline); }
      continue;
    }
    if (inUsage) {
      // Stop at next section
      if (/^(Basic examples?|Example|Arguments?|Syntax|Related|Limitations|Predefined|Components|Structure)\b/.test(t)) {
        break;
      }
      usage.push(t);
    }
  }
  // If no "Usage" header found, fall back to first few text lines
  if (usage.length === 0) {
    for (const t of lines) {
      if (/^(Example|Arguments?|Syntax|Components|Structure)\b/.test(t)) break;
      usage.push(t);
      if (usage.length >= 4) break;
    }
  }
  return usage.join(' ').replace(/\s+/g, ' ').trim();
}

// Extract examples — short code-like blocks (lines starting with the entry name, or in indented blocks)
function extractExamples(body, entryName) {
  const lines = body.split('\n');
  const examples = [];
  // Look for lines that contain "<entryName> ..." with semicolon, typical RAPID pattern
  const exRe = new RegExp(`\\b${entryName}\\b[^;]*;`, 'g');
  for (const ln of lines) {
    const matches = ln.match(exRe);
    if (matches) {
      for (const m of matches) {
        const cleaned = m.trim();
        if (cleaned.length > entryName.length + 2 && !examples.includes(cleaned)) {
          examples.push(cleaned);
          if (examples.length >= 3) break;
        }
      }
    }
    if (examples.length >= 3) break;
  }
  return examples;
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
 *   - `[ '\'OptName ':=' < ... > ]`                                 → optional named
 *   - `[ '\'Switch ]`                                               → optional switch (no value)
 * Returns: [{ name, type, optional, switch }]
 */
function parseParameters(syntax) {
  if (!syntax) { return []; }
  const params = [];
  // Walk segments separated by `,` at the top level — but `,` may be inside `[]`,
  // so split on `[` boundaries instead. Each `[ ... ]` block (or unbracketed segment)
  // is one parameter.
  // Easier: regex over the whole string.
  // Required pattern:
  //   [ \s* (Name) \s* ':=' ... < ... of (Type) > ] (with various spacing)
  // Optional named (\Name):
  //   [ \s* '\\' (Name) \s* ':=' ... < ... of (Type) > ]
  // Optional switch:
  //   [ \s* '\\' (Name) \s* ]
  // The token between `<` and `of` can be any of: expression, persistent, variable, switch.
  // Wrapper words also vary in spacing/quoting across the manual.
  const requiredRe = /\[\s*([A-Za-z_]\w*)\s*'?:='?\s*\]\s*<\s*(?:expression|persistent|variable)[^>]*of\s+(\w+)\s*>/gi;
  const optNamedRe = /\[\s*'?\\'?([A-Za-z_]\w*)\s*'?:='?\s*<\s*(?:expression|persistent|variable)[^>]*of\s+(\w+)\s*>\s*\]/gi;
  const optSwitchRe = /\[\s*'?\\'?([A-Za-z_]\w*)\s*\](?!\s*<)/gi;

  // First sweep: optional named args
  for (const m of syntax.matchAll(optNamedRe)) {
    params.push({ name: '\\' + m[1], type: m[2], optional: true });
  }
  // Then required positional
  for (const m of syntax.matchAll(requiredRe)) {
    params.push({ name: m[1], type: m[2], optional: false });
  }
  // Then optional switches (no value)
  for (const m of syntax.matchAll(optSwitchRe)) {
    // Skip ones we already matched as optional named
    if (params.some(p => p.name === '\\' + m[1])) { continue; }
    params.push({ name: '\\' + m[1], type: 'switch', optional: true, switch: true });
  }
  return params;
}

function addEntries(entries, kind) {
  for (const [name, e] of entries) {
    const syntax     = extractSyntax(e.body);
    const usage      = extractUsage(e.body);
    const examples   = extractExamples(e.body, name);
    const parameters = parseParameters(syntax);
    db[name.toLowerCase()] = {
      kind,
      name,
      brief:    e.brief,
      usage:    usage.slice(0, 1500),  // cap to keep JSON small
      syntax:   syntax.slice(0, 500),
      examples: examples.slice(0, 3),
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
const keywords = [
  ['MODULE',     'Module declaration', 'Begins a RAPID module.', 'MODULE moduleName [(SYSMODULE | NOSTEPIN | VIEWONLY | READONLY | NOVIEW)]\n  …\nENDMODULE'],
  ['ENDMODULE',  'Module end',         'Closes a MODULE block.', 'ENDMODULE'],
  ['PROC',       'Procedure declaration', 'Begins a procedure (callable, no return value).', 'PROC name([params])\n  …\nENDPROC'],
  ['ENDPROC',    'Procedure end',      'Closes a PROC block.', 'ENDPROC'],
  ['FUNC',       'Function declaration', 'Begins a function (callable, returns a typed value).', 'FUNC type name([params])\n  …\nENDFUNC'],
  ['ENDFUNC',    'Function end',       'Closes a FUNC block.', 'ENDFUNC'],
  ['TRAP',       'Trap routine declaration', 'Begins an interrupt-handler routine.', 'TRAP name\n  …\nENDTRAP'],
  ['ENDTRAP',    'Trap end',           'Closes a TRAP block.', 'ENDTRAP'],
  ['RECORD',     'Record declaration', 'Defines a composite (struct-like) data type.', 'RECORD recordType\n  …\nENDRECORD'],
  ['ENDRECORD',  'Record end',         'Closes a RECORD block.', 'ENDRECORD'],
  ['VAR',        'Variable declaration', 'Declares a variable. Reset to its initial value when the program is started.', 'VAR num counter := 0;'],
  ['PERS',       'Persistent variable declaration', 'Declares a persistent variable — value survives program restarts.', 'PERS num totalRuns := 0;'],
  ['CONST',      'Constant declaration', 'Declares a compile-time constant.', 'CONST num maxIters := 100;'],
  ['LOCAL',      'Local scope modifier', 'Marks a routine or data as local to the module (not exported).', 'LOCAL PROC helper()\n  …\nENDPROC'],
  ['TASK',       'Task scope modifier', 'Declares task-private persistent data.', 'TASK PERS num taskCounter := 0;'],
  ['IF',         'If statement',       'Conditional execution.', 'IF cond THEN\n  …\nELSEIF other THEN\n  …\nELSE\n  …\nENDIF'],
  ['THEN',       'Then keyword',       'Body of an IF / ELSEIF clause.', 'IF cond THEN'],
  ['ELSE',       'Else keyword',       'Fallback branch in IF.', 'ELSE'],
  ['ELSEIF',     'Else-if keyword',    'Additional condition in IF chain.', 'ELSEIF other THEN'],
  ['ENDIF',      'If end',             'Closes an IF block.', 'ENDIF'],
  ['WHILE',      'While loop',         'Repeats while a condition is true.', 'WHILE cond DO\n  …\nENDWHILE'],
  ['ENDWHILE',   'While end',          'Closes a WHILE block.', 'ENDWHILE'],
  ['FOR',        'For loop',           'Numeric range loop.', 'FOR i FROM 1 TO 10 DO\n  …\nENDFOR'],
  ['FROM',       'For range start',    'First value in a FOR loop.', 'FOR i FROM 1 TO 10 DO'],
  ['TO',         'For range end',      'Last value in a FOR loop.', 'FOR i FROM 1 TO 10 DO'],
  ['STEP',       'For step',           'Increment between iterations.', 'FOR i FROM 0 TO 100 STEP 10 DO'],
  ['DO',         'Loop body keyword',  'Begins the body of a WHILE / FOR loop.', 'DO'],
  ['ENDFOR',     'For end',            'Closes a FOR block.', 'ENDFOR'],
  ['TEST',       'Test statement',     'Multi-way branch on a single value.', 'TEST x\n  CASE 1: …\n  CASE 2,3: …\n  DEFAULT: …\nENDTEST'],
  ['CASE',       'Case clause',        'Branch in a TEST statement.', 'CASE 1, 2, 3:'],
  ['DEFAULT',    'Default clause',     'Fallback branch in TEST.', 'DEFAULT:'],
  ['ENDTEST',    'Test end',           'Closes a TEST block.', 'ENDTEST'],
  ['RETURN',     'Return',             'Exits the current routine; in FUNC, returns a value.', 'RETURN value;'],
  ['EXIT',       'Exit',               'Stops program execution permanently. PP must be reset to restart.', 'EXIT;'],
  ['STOP',       'Stop',               'Stops program execution; can be resumed.', 'STOP;'],
  ['ERROR',      'Error handler',      'Begins a routine-level error handler.', 'ERROR\n  IF ERRNO = ERR_DIVZERO THEN\n    …'],
  ['UNDO',       'Undo handler',       'Cleanup code executed when execution leaves the routine abnormally.', 'UNDO\n  …'],
  ['BACKWARD',   'Backward handler',   'Code to run when stepping backward through the routine.', 'BACKWARD'],
  ['TRYNEXT',   'Try next',           'Inside ERROR: skip the offending instruction and continue.', 'TRYNEXT;'],
  ['RETRY',     'Retry',              'Inside ERROR: re-execute the failed instruction.', 'RETRY;'],
  ['RAISE',     'Raise error',        'Re-raise the current error to the caller.', 'RAISE;'],
  ['CONNECT',   'Connect interrupt',  'Bind a signal/condition to a TRAP routine.', 'CONNECT intr WITH trapName;'],
  ['WITH',      'With clause',        'Used in CONNECT: WITH trapName.', 'CONNECT intr WITH trapName;'],
  ['NOSTEPIN',  'NoStepIn flag',      'Module attribute: routines cannot be stepped into.', 'MODULE m1(NOSTEPIN)'],
  ['SYSMODULE', 'SysModule flag',     'Module attribute: marks as system module — survives Reset RAPID.', 'MODULE myUtils(SYSMODULE)'],
  ['VIEWONLY',  'ViewOnly flag',      'Module attribute: read-only.', 'MODULE m1(VIEWONLY)'],
  ['READONLY',  'ReadOnly flag',      'Module attribute: data is constant.', 'MODULE m1(READONLY)'],
  ['NOVIEW',    'NoView flag',        'Module attribute: source not displayable.', 'MODULE m1(NOVIEW)'],
  ['TRUE',      'Boolean literal',    'Boolean constant.', 'VAR bool flag := TRUE;'],
  ['FALSE',     'Boolean literal',    'Boolean constant.', 'VAR bool flag := FALSE;'],
];
for (const [name, brief, usage, syntax] of keywords) {
  if (!db[name.toLowerCase()]) {
    db[name.toLowerCase()] = { kind: 'keyword', name, brief, usage, syntax, examples: [] };
  }
}

// ─── Write output ──────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(db, null, 0));  // minified

const stats = fs.statSync(OUT);
console.log(`Wrote ${OUT} — ${Object.keys(db).length} entries, ${(stats.size / 1024).toFixed(1)} KB`);

// ─── Verify a few entries ───────────────────────────────────────────────────
const samples = ['movej', 'movel', 'waittime', 'tpwrite', 'abs', 'cos', 'robtarget', 'jointtarget', 'num'];
console.log('\n=== sample entries ===');
for (const k of samples) {
  const e = db[k];
  if (!e) { console.log(`  ${k}: NOT FOUND`); continue; }
  console.log(`  ${e.name} (${e.kind}): ${e.brief.slice(0, 60)}`);
  if (e.syntax) console.log(`    syntax: ${e.syntax.split('\n')[0].slice(0, 80)}`);
  if (e.examples?.length) console.log(`    e.g.:   ${e.examples[0].slice(0, 80)}`);
}
