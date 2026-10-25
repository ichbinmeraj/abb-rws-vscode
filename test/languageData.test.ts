import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const dataFile = path.join(root, 'resources', 'rapid-language-data.json');
const stripScript = path.join(root, 'scripts', 'strip-language-data.mjs');

interface Parameter { name: string; type: string; optional: boolean; switch?: boolean; alt?: boolean }
interface Entry {
  kind: 'instruction' | 'function' | 'datatype' | 'keyword';
  name: string;
  summary: string;
  signature: string;
  returns?: string;
  parameters?: Parameter[];
}
const db = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Record<string, Entry>;
const entries = Object.values(db);

describe('RAPID language data: signatures only', () => {
  it('keeps all 705 names, keyed by lower-case name', () => {
    assert.equal(entries.length, 705);
    for (const [key, e] of Object.entries(db)) { assert.equal(key, e.name.toLowerCase()); }
    const kinds = entries.reduce<Record<string, number>>((n, e) => { n[e.kind] = (n[e.kind] ?? 0) + 1; return n; }, {});
    assert.deepEqual(kinds, { instruction: 355, function: 209, datatype: 102, keyword: 39 });
  });

  it('has no description, usage, example or raw syntax fields', () => {
    const allowed = new Set(['kind', 'name', 'summary', 'signature', 'returns', 'parameters']);
    for (const e of entries) {
      for (const k of Object.keys(e)) { assert.ok(allowed.has(k), `${e.name}: field ${k}`); }
    }
  });

  it('summaries are built from kind and return type only', () => {
    for (const e of entries) {
      const expected = e.kind === 'instruction' ? 'RAPID instruction'
        : e.kind === 'datatype' ? 'RAPID data type'
        : e.kind === 'keyword' ? 'RAPID keyword'
        : /^RAPID operator/.test(e.summary) ? (e.returns ? `RAPID operator returning ${e.returns}` : 'RAPID operator')
        : (e.returns ? `RAPID function returning ${e.returns}` : 'RAPID function');
      assert.equal(e.summary, expected, e.name);
    }
  });

  it('no string reads like a sentence', () => {
    const visit = (v: unknown, where: string): void => {
      if (typeof v === 'string') {
        assert.ok(!v.includes('. '), `${where}: ". " in ${v.slice(0, 80)}`);
        assert.ok(!/\b[a-z]+(?:\s+[a-z]+){5,}\b/.test(v), `${where}: six lower-case words in a row in ${v.slice(0, 80)}`);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => visit(x, `${where}[${i}]`));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) { visit(x, `${where}.${k}`); }
      }
    };
    for (const e of entries) { visit(e, e.name); }
  });

  it('a signature lists every parameter, in order', () => {
    for (const e of entries) {
      if (!e.parameters?.length) { continue; }
      let at = 0;
      for (const p of e.parameters) {
        const label = p.optional ? `[${p.name}]` : p.name;
        const found = e.signature.indexOf(label, at);
        assert.ok(found >= 0, `${e.name}: ${label} in "${e.signature}"`);
        at = found + label.length;
      }
    }
  });

  it('call shapes of a few common names', () => {
    assert.equal(db.movej.signature, String.raw`MoveJ [\Conc], ToPoint [\ID], Speed [\V], Zone [\Z] [\Inpos], Tool [\WObj] [\TLoad];`);
    assert.equal(db.offs.signature, 'Offs(Point, XOffset, YOffset, ZOffset)');
    assert.equal(db.offs.returns, 'robtarget');
    assert.equal(db.waittime.signature, String.raw`WaitTime [\InPos], Time;`);
    assert.equal(db.clearpath.signature, 'ClearPath;');
    assert.equal(db.ctime.signature, 'CTime()');
    assert.equal(db.robtarget.signature, '');
    assert.equal(db.module.kind, 'keyword');
  });

  // Each parameter as `[\Name]:type` or `Name:type`, `| ` before an alternative.
  const shape = (e: Entry): string[] =>
    (e.parameters ?? []).map(p => `${p.alt ? '| ' : ''}${p.optional ? `[${p.name}]` : p.name}:${p.type}`);

  it('call shapes keep every argument of the syntax block', () => {
    assert.equal(db.itimer.signature, String.raw`ITimer [\Single] | [\SingleSafe], Time, Interrupt;`);
    assert.deepEqual(shape(db.itimer), [String.raw`[\Single]:switch`, String.raw`| [\SingleSafe]:switch`, 'Time:num', 'Interrupt:intnum']);

    assert.equal(db.isignaldi.signature, String.raw`ISignalDI [\Single] | [\SingleSafe], Signal, TriggValue, Interrupt;`);
    assert.deepEqual(shape(db.isignaldi), [String.raw`[\Single]:switch`, String.raw`| [\SingleSafe]:switch`, 'Signal:signaldi', 'TriggValue:dionum', 'Interrupt:intnum']);

    assert.equal(db.save.signature, String.raw`Save [\TaskRef] | [\TaskName], ModuleName [\FilePath] [\File];`);
    assert.deepEqual(shape(db.save), [String.raw`[\TaskRef]:taskid`, String.raw`| [\TaskName]:string`, 'ModuleName:string', String.raw`[\FilePath]:string`, String.raw`[\File]:string`]);

    assert.equal(db.dim.signature, 'Dim(ArrPar, DimNo)');
    assert.deepEqual(shape(db.dim), ['ArrPar:anytype', 'DimNo:num']);
    assert.equal(db.dim.returns, 'num');

    assert.equal(db.setdo.signature, String.raw`SetDO [\SDelay] | [\Sync], Signal, Value;`);
    assert.deepEqual(shape(db.setdo), [String.raw`[\SDelay]:num`, String.raw`| [\Sync]:switch`, 'Signal:signaldo', 'Value:dionum']);

    assert.equal(db.moveabsj.signature, String.raw`MoveAbsJ [\Conc], ToJointPos [\ID] [\NoEoffs], Speed [\V] | [\T], Zone [\Z] [\Inpos], Tool [\WObj] [\TLoad];`);
    assert.deepEqual(shape(db.moveabsj), [
      String.raw`[\Conc]:switch`, 'ToJointPos:jointtarget', String.raw`[\ID]:identno`, String.raw`[\NoEoffs]:switch`,
      'Speed:speeddata', String.raw`[\V]:num`, String.raw`| [\T]:num`,
      'Zone:zonedata', String.raw`[\Z]:num`, String.raw`[\Inpos]:stoppointdata`,
      'Tool:tooldata', String.raw`[\WObj]:wobjdata`, String.raw`[\TLoad]:loaddata`,
    ]);

    assert.equal(db.testsigndefine.signature, 'TestSignDefine Channel, SignalId, MechUnit, Axis, SampleTime;');
    assert.equal(db.triggl.signature, String.raw`TriggL [\Conc], ToPoint [\ID], Speed [\T], Trigg_1 | TriggArray [\T2] [\T3] [\T4] [\T5] [\T6] [\T7] [\T8], Zone, Tool [\Corr];`);
    assert.equal(db.incr.signature, 'Incr Name | Dname;');
    assert.equal(db.setgo.signature, String.raw`SetGO [\SDelay], Signal, Value | Dvalue;`);
  });

  it('a required argument bracketed whole, [Name := <...>], stays required', () => {
    assert.equal(db.stindgun.signature, 'STIndGun ToolName, GunPos;');
    assert.deepEqual(shape(db.stindgun), ['ToolName:string', 'GunPos:num']);

    // The manual's argument list and example pass these by name (\DoLeft:=...): optional.
    assert.equal(db.capweavesync.signature, String.raw`CapWeaveSync [\Reset] [\DoLeft] [\LevelLeft] [\DoRight] [\LevelRight];`);
    assert.deepEqual(shape(db.capweavesync), [String.raw`[\Reset]:switch`, String.raw`[\DoLeft]:signaldo`, String.raw`[\LevelLeft]:num`, String.raw`[\DoRight]:signaldo`, String.raw`[\LevelRight]:num`]);

    assert.equal(db.aliascamera.signature, 'AliasCamera CameraName | FromCamera, ToCamera;');
    assert.deepEqual(shape(db.aliascamera), ['CameraName:string', '| FromCamera:cameradev', 'ToCamera:cameradev']);

    // The manual's argument list and example 2 pass MsgArray by position: a required alternative to Message.
    assert.equal(db.uimsgwrite.signature, String.raw`UIMsgWrite Header, Message | MsgArray [\Wrap] [\Icon] [\Image] [\PersBool] | [\PersBoolName] [\AbortValue] [\UIActiveSignal];`);
    assert.deepEqual(shape(db.uimsgwrite), [
      'Header:string', 'Message:string', '| MsgArray:string', String.raw`[\Wrap]:switch`,
      String.raw`[\Icon]:icondata`, String.raw`[\Image]:string`, String.raw`[\PersBool]:bool`,
      String.raw`| [\PersBoolName]:string`, String.raw`[\AbortValue]:bool`, String.raw`[\UIActiveSignal]:signaldo`,
    ]);

    const breakTail = [
      String.raw`[\MaxTime]:num`, String.raw`[\DIBreak]:signaldi`, String.raw`[\DIPassive]:switch`,
      String.raw`[\DOBreak]:signaldo`, String.raw`[\DOPassive]:switch`, String.raw`[\PersBoolBreak]:bool`,
      String.raw`[\PersBoolPassive]:switch`, String.raw`[\BreakFlag]:errnum`, String.raw`[\UIActiveSignal]:signaldo`,
    ];
    assert.equal(db.uinumtune.signature, String.raw`UINumTune([\Header] [\Message] | [\MsgArray] [\Wrap] [\Icon], InitValue, Increment [\MinValue] [\MaxValue] [\MaxTime] [\DIBreak] [\DIPassive] [\DOBreak] [\DOPassive] [\PersBoolBreak] [\PersBoolPassive] [\BreakFlag] [\UIActiveSignal])`);
    assert.deepEqual(shape(db.uinumtune), [
      String.raw`[\Header]:string`, String.raw`[\Message]:string`, String.raw`| [\MsgArray]:string`, String.raw`[\Wrap]:switch`,
      String.raw`[\Icon]:icondata`, 'InitValue:num', 'Increment:num', String.raw`[\MinValue]:num`, String.raw`[\MaxValue]:num`,
      ...breakTail,
    ]);

    for (const e of [db.uinumentry, db.uidnumentry]) {
      assert.equal(e.signature, String.raw`${e.name}([\Header] [\Message] | [\MsgArray] [\Wrap] [\Icon] [\InitValue] [\MinValue] [\MaxValue] [\AsInteger] [\MaxTime] [\DIBreak] [\DIPassive] [\DOBreak] [\DOPassive] [\PersBoolBreak] [\PersBoolPassive] [\BreakFlag] [\UIActiveSignal])`);
      assert.deepEqual(shape(e), [
        String.raw`[\Header]:string`, String.raw`[\Message]:string`, String.raw`| [\MsgArray]:string`, String.raw`[\Wrap]:switch`,
        String.raw`[\Icon]:icondata`, String.raw`[\InitValue]:dnum`, String.raw`[\MinValue]:dnum`, String.raw`[\MaxValue]:dnum`,
        String.raw`[\AsInteger]:switch`, ...breakTail,
      ]);
    }
    assert.deepEqual([db.uinumentry.name, db.uidnumentry.name], ['UINumEntry', 'UIDnumEntry']);
  });

  it('an optional argument written without its [ or with = for :=, and a switch closed by )', () => {
    assert.equal(db.movejsync.signature, String.raw`MoveJSync ToPoint [\ID], Speed [\T], Zone, Tool [\WObj], ProcName [\TLoad];`);
    assert.deepEqual(shape(db.movejsync), [
      'ToPoint:robtarget', String.raw`[\ID]:identno`, 'Speed:speeddata', String.raw`[\T]:num`,
      'Zone:zonedata', 'Tool:tooldata', String.raw`[\WObj]:wobjdata`, 'ProcName:string', String.raw`[\TLoad]:loaddata`,
    ]);
    assert.equal(db.numtostr.signature, String.raw`NumToStr(Val, Dec [\Exp])`);
    assert.equal(db.dnumtostr.signature, String.raw`DnumToStr(Val, Dec [\Exp])`);
    assert.equal(db.dnumtonum.signature, String.raw`DnumToNum(Value [\Integer])`);
    assert.deepEqual(shape(db.dnumtonum), ['Value:dnum', String.raw`[\Integer]:switch`]);
  });

  // Every name a syntax block of the git source writes (`\Name`, `Name :=`, `Name =`) is in
  // the shipped parameter list, read without the parser of strip-language-data.mjs. The source
  // cut every syntax block at 500 characters; where the cut falls inside an argument:
  // - a name cut short (`[\ DOBr` at the end of UINumTune) is in the list under its full name,
  //   taken from the stored list;
  // - a whole name whose type was cut is listed below; the source holds no type for it and
  //   the stored list does not have it, so it is left out.
  it('every argument name in a syntax block of the git source is in the parameter list', (t) => {
    const source = /export const SOURCE = '([^']+)'/.exec(fs.readFileSync(stripScript, 'utf8'))?.[1];
    assert.ok(source, 'SOURCE in strip-language-data.mjs');
    const show = spawnSync('git', ['show', source], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (show.status !== 0) { t.skip(`git cannot read ${source} (shallow clone)`); return; }
    const src = JSON.parse(show.stdout) as Record<string, { kind: string; name: string; syntax?: string }>;

    const missing: string[] = [];
    let scanned = 0;
    for (const [key, e] of Object.entries(src)) {
      if ((e.kind !== 'instruction' && e.kind !== 'function') || !e.syntax) { continue; }
      const lines = e.syntax.replace(/['�]/g, '').split('\n').map(l => l.trim());
      const at = lines.findIndex(l => new RegExp(`^${e.name}(?!\\w)`, 'i').test(l));
      if (at < 0) { continue; }
      const own = lines.slice(at).join('\n');
      scanned += 1;

      const written = new Map<string, { name: string; end: number }>();
      for (const m of own.matchAll(/\\\s*(?:switch\s+)?([A-Za-z_]\w*)/g)) {
        written.set(m[1].toLowerCase(), { name: '\\' + m[1], end: m.index! + m[0].length });
      }
      for (const m of own.matchAll(/(?<!\\\s*)\b([A-Za-z_]\w*)\s*:?=\s*[\]<]/g)) {
        if (!written.has(m[1].toLowerCase())) { written.set(m[1].toLowerCase(), { name: m[1], end: m.index! + m[1].length }); }
      }
      const shipped = (db[key].parameters ?? []).map(p => p.name.replace(/^\\/, '').toLowerCase());
      for (const [lower, w] of written) {
        if (shipped.includes(lower)) { continue; }
        const cut = e.syntax.length === 500 && !own.slice(w.end).includes('>');
        const cutShort = cut && own.slice(w.end).trim() === '' && shipped.some(s => s.startsWith(lower));
        if (cutShort) { continue; }
        missing.push(`${key} ${w.name}${cut ? ' (type cut)' : ''}`);
      }
    }
    assert.ok(scanned > 500, `${scanned} syntax blocks`);
    assert.deepEqual(missing, [
      String.raw`movecgo \Value (type cut)`,
      String.raw`movejgo \Dvalue (type cut)`,
      String.raw`movelgo \Dvalue (type cut)`,
      String.raw`triggcheckio \Mode (type cut)`,
      String.raw`triggequip \Inhib (type cut)`,
      String.raw`triggrampao \Mode (type cut)`,
      String.raw`triggspeed \Mode (type cut)`,
    ]);
  });

  it('strip-language-data.mjs is idempotent on the shipped file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-data-test-'));
    try {
      const out = path.join(dir, 'out.json');
      const run = spawnSync(process.execPath, [stripScript, dataFile, out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(dataFile, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strip-language-data.mjs reproduces the shipped file from its git source', (t) => {
    const source = /export const SOURCE = '([^']+)'/.exec(fs.readFileSync(stripScript, 'utf8'))?.[1];
    assert.ok(source, 'SOURCE in strip-language-data.mjs');
    const show = spawnSync('git', ['show', source], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (show.status !== 0) { t.skip(`git cannot read ${source} (shallow clone)`); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-data-test-'));
    try {
      const input = path.join(dir, 'in.json');
      const out = path.join(dir, 'out.json');
      fs.writeFileSync(input, show.stdout);
      const run = spawnSync(process.execPath, [stripScript, input, out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(dataFile, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
