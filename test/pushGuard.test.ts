import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  asciiCheck, baseVerdict, changedText, controllerHash, failureReport, hasNonAscii, moduleNameMismatch, moduleNameOfFile, normalizeLf, pruneRestorePoints, restorePointPaths,
  whenText, type RestoreFs, type RestoreMeta,
} from '../src/pushGuard';
import { FileOrigins } from '../src/fileOrigins';
import { textHash, type FileOrigin } from '../src/taskResolver';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

describe('the bytes of a module file', () => {
  it('ASCII passes, CRLF included, and the text comes back as it is', () => {
    const v = asciiCheck(Buffer.from('MODULE M\r\n  PROC main()\r\n  ENDPROC\r\nENDMODULE\r\n', 'latin1'), 'Push Current File', 'M.mod');
    assert.equal(v.ok, true);
    if (v.ok) { assert.equal(v.bytes, 47); assert.match(v.text, /^MODULE M\r\n/); }
  });

  it('a Latin-1 file is refused, naming the line, the column and the byte, with the line shown', () => {
    const v = asciiCheck(Buffer.from('MODULE M\n  ! Wert gem\xe4\xdf Plan\n  PROC main()\nENDMODULE\n', 'latin1'), 'Push Current File', 'MainT2.mod');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.why, 'non-ascii');
      assert.deepEqual(v.offenders.map(o => [o.line, o.column, o.byte]), [[2, 13, 0xe4]]);
      assert.match(v.message, /^Push Current File not sent: MainT2\.mod has a non-ASCII character on line 2, column 13 \(byte 0xE4\)\.\n2: {4}! Wert gem\\xE4\\xDF Plan\n/);
      assert.match(v.message, /RAPID Live does not send non-ASCII text to a controller: the controller reads a module file as single-byte text, so a UTF-8 character would be stored wrong \(RobotWare 6\.16, 7\.21 and 8\.2 checked on 2026-10-30\)\. Replace the character or use an ASCII spelling, then push again\. Nothing was sent\.$/);
    }
  });

  it('a UTF-8 file with ä is refused at its first byte, and at most three lines are shown', () => {
    const v = asciiCheck(Buffer.from('a\n! ä\n! ö\n! ü\n! ß\nEND\n', 'utf8'), 'Load Program from File', 'U.mod');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.offenders.length, 4);
      assert.deepEqual(v.offenders[0], { line: 2, column: 3, byte: 0xc3, text: '! \\xC3\\xA4' });
      assert.match(v.message, /line 2, column 3 \(byte 0xC3\)\.\n2:  ! \\xC3\\xA4\n3:  ! \\xC3\\xB6\n4:  ! \\xC3\\xBC \(1 more line\)\n/);
    }
  });

  it('a control byte is refused as such: a UTF-16 file without a byte order mark fails at its second byte (review finding 14)', () => {
    const v = asciiCheck(Buffer.from('MODULE M\n  PROC main()\n', 'utf16le'), 'Push Current File', 'W.mod');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.why, 'control');
      assert.deepEqual(v.offenders.map(o => [o.line, o.column, o.byte]), [[1, 2, 0x00], [2, 1, 0x00], [3, 1, 0x00]]);
      assert.equal(v.offenders[0].text, 'M\\x00O\\x00D\\x00U\\x00L\\x00E\\x00 \\x00M\\x00');
      assert.match(v.message, /^Push Current File not sent: W\.mod has a control character on line 1, column 2 \(byte 0x00\)\.\n1:  M\\x00O\\x00D/);
      assert.match(v.message, /a UTF-16 file saved without a byte order mark has a zero byte after every character, and a binary file has many\. Save the file as ASCII text, then push again\. Nothing was sent\.$/);
    }
  });

  it('every control byte but tab, LF and CR is refused, DEL too; the three pass', () => {
    for (let b = 0; b < 0x20; b++) {
      const v = asciiCheck(Buffer.from([0x4d, b, 0x4d, 0x0a]), 'Push Current File', 'C.mod');
      if (b === 0x09 || b === 0x0a || b === 0x0d) { assert.equal(v.ok, true, `byte ${b}`); continue; }
      assert.equal(v.ok, false, `byte ${b}`);
      if (!v.ok) { assert.equal(v.why, 'control'); assert.equal(v.offenders[0].byte, b); assert.equal(v.offenders[0].column, 2); }
    }
    const del = asciiCheck(Buffer.from([0x4d, 0x7f, 0x0a]), 'Push Current File', 'C.mod');
    assert.equal(del.ok, false);
    if (!del.ok) { assert.equal(del.why, 'control'); assert.match(del.message, /\(byte 0x7F\)/); }
    // A non-ASCII byte before any control byte keeps the non-ASCII wording.
    const mixed = asciiCheck(Buffer.from([0xe4, 0x0a, 0x00, 0x0a]), 'Push Current File', 'C.mod');
    if (!mixed.ok) { assert.equal(mixed.why, 'non-ascii'); assert.equal(mixed.offenders.length, 2); }
  });

  it('a lone CR ends a line, so the line named is the editor\'s, and the shown line stops there; CRLF is one line end', () => {
    const cr = asciiCheck(Buffer.from('MODULE M\r! Wert gem\xe4\xdf\r! ok\rENDMODULE\r', 'latin1'), 'Push Current File', 'R.mod');
    assert.equal(cr.ok, false);
    if (!cr.ok) {
      assert.deepEqual(cr.offenders, [{ line: 2, column: 11, byte: 0xe4, text: '! Wert gem\\xE4\\xDF' }]);
      assert.match(cr.message, /on line 2, column 11 \(byte 0xE4\)\.\n2:  ! Wert gem\\xE4\\xDF\n/);
    }
    const crlf = asciiCheck(Buffer.from('MODULE M\r\n  PROC main()\r\n  ! gem\xe4\xdf\r\nENDMODULE\r\n', 'latin1'), 'Push Current File', 'L.mod');
    assert.equal(crlf.ok, false);
    if (!crlf.ok) { assert.deepEqual(crlf.offenders.map(o => [o.line, o.column, o.text]), [[3, 8, '  ! gem\\xE4\\xDF']]); }
    const bomCr = asciiCheck(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('MODULE M\rENDMODULE\r')]), 'Push Current File', 'B.mod');
    if (!bomCr.ok) { assert.equal(bomCr.offenders[0].text, '\\xEF\\xBB\\xBFMODULE M'); }
  });

  it('a byte order mark is refused as such', () => {
    const v = asciiCheck(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('MODULE M\nENDMODULE\n')]), 'Push Current File', 'B.mod');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.why, 'bom');
      assert.match(v.message, /starts with a byte order mark \(bytes EF BB BF\)/);
      // The same single-byte rule, with the mark's own effect named (RobotWare 7 and 8 named the module "ï" on 2026-10-30).
      assert.match(v.message, /the mark becomes three characters in front of MODULE, and RobotWare 7 and 8 then name the module after the first of them\. Save the file without the byte order mark, then push again\. Nothing was sent\.$/);
    }
  });

  it('an empty or white-space-only file is refused', () => {
    for (const text of ['', ' \n\t\r\n']) {
      const v = asciiCheck(Buffer.from(text, 'latin1'), 'Push Current File', 'E.mod');
      assert.equal(v.ok, false);
      if (!v.ok) { assert.equal(v.why, 'empty'); assert.equal(v.message, 'Push Current File not sent: E.mod is empty. Nothing was sent.'); }
    }
  });
});

describe('the base compare', () => {
  const local = 'MODULE M\n  PROC main()\n  ENDPROC\nENDMODULE\n';
  const ctrl = 'MODULE M\r\n  PROC main()\r\n  ENDPROC\r\nENDMODULE\r\n';
  const changed = 'MODULE M\n  PROC main()\n    TPWrite "x";\n  ENDPROC\nENDMODULE\n';
  const pulled: FileOrigin = { task: 'T_ROB2', hash: textHash(local), robotId: 'r1', at: '2026-11-20T14:02:00.000Z', ctrlHash: controllerHash(ctrl) };

  it('normalises line endings only, and hashes the normalised text', () => {
    assert.equal(normalizeLf('a\r\nb\rc\n'), 'a\nb\nc\n');
    assert.equal(controllerHash(ctrl), controllerHash(local));
    assert.notEqual(controllerHash(ctrl), controllerHash(changed));
  });

  it('a controller copy equal to the file, CRLF or LF, is nothing to push', () => {
    assert.deepEqual(baseVerdict(pulled, 'r1', 'T_ROB2', ctrl, local), { kind: 'nothing-to-push' });
    assert.deepEqual(baseVerdict(undefined, 'r1', 'T_ROB2', local, local), { kind: 'nothing-to-push' });
  });

  it('same when the controller copy is the one pulled; changed when it differs', () => {
    const edited = `${local}! local edit\n`;
    assert.deepEqual(baseVerdict(pulled, 'r1', 'T_ROB2', ctrl, edited), { kind: 'same', recordedAt: '2026-11-20T14:02:00.000Z' });
    assert.deepEqual(baseVerdict(pulled, 'r1', 'T_ROB2', changed, edited), { kind: 'changed', recordedAt: '2026-11-20T14:02:00.000Z' });
  });

  it('unknown with no record, a record from before 1.5.0 (no controller hash), another robot or another task', () => {
    const edited = `${local}! local edit\n`;
    assert.deepEqual(baseVerdict(undefined, 'r1', 'T_ROB2', ctrl, edited), { kind: 'unknown', why: 'no record' });
    const old: FileOrigin = { task: 'T_ROB2', hash: textHash(local), robotId: 'r1', at: '2026-10-29T10:00:00.000Z' };
    assert.deepEqual(baseVerdict(old, 'r1', 'T_ROB2', ctrl, edited), { kind: 'unknown', why: 'no controller hash' });
    assert.deepEqual(baseVerdict(pulled, 'r2', 'T_ROB2', ctrl, edited), { kind: 'unknown', why: 'other robot' });
    assert.deepEqual(baseVerdict(pulled, 'r1', 'T_ROB1', ctrl, edited), { kind: 'unknown', why: 'other task' });
  });

  it('the stop names the module, the task, the robot and the time; the unknown variant says there is no record', () => {
    const t = changedText({ kind: 'changed', recordedAt: '2026-11-20T14:02:00.000Z' }, 'Main_T2', 'T_ROB2', 'Cell1 (192.168.125.1:443)', 'MainT2.mod');
    assert.match(t.message, /^Main_T2 in T_ROB2 on Cell1 \(192\.168\.125\.1:443\) has changed on the controller since you pulled it \(2026-11-20 \d\d:\d\d\)\.$/);
    assert.equal(t.detail, 'Nothing was sent. The controller\'s copy differs from the one RAPID Live recorded, for example by a change at the FlexPendant.');
    assert.deepEqual([t.showDiff, t.pushAnyway], ['Show diff', 'Push anyway…']);
    const u = changedText({ kind: 'unknown', why: 'no record' }, 'Main_T2', 'T_ROB2', 'Cell1 (192.168.125.1:443)', 'MainT2.mod');
    assert.equal(u.message, 'RAPID Live has no record of pulling MainT2.mod from T_ROB2 on Cell1 (192.168.125.1:443), so it cannot tell whether the controller\'s copy changed.');
    assert.equal(u.detail, 'Nothing was sent. It differs from your file.');
    assert.equal(whenText(undefined), 'an unknown time');
    assert.equal(whenText('not a time'), 'an unknown time');
    const now = new Date(2026, 10, 20, 15, 0);
    assert.equal(whenText(new Date(2026, 10, 20, 14, 2).toISOString(), now), '14:02');
    assert.equal(whenText(new Date(2026, 10, 19, 14, 2).toISOString(), now), '2026-11-19 14:02');
  });

  it('the origin store keeps the controller hash next to the text hash, and can add it to a record later', async () => {
    const data = new Map<string, unknown>();
    const origins = new FileOrigins({ get: <T,>(k: string, d: T) => (data.has(k) ? data.get(k) as T : d), update: async (k: string, v: unknown) => { data.set(k, v); } });
    const file = path.resolve('work', 'M.mod');
    await origins.record(file, 'T_ROB2', local, 'r1', '2026-11-20T14:02:00.000Z', { text: ctrl, changeCount: 7 });
    assert.deepEqual(origins.get(file), { task: 'T_ROB2', hash: textHash(local), robotId: 'r1', at: '2026-11-20T14:02:00.000Z', ctrlHash: controllerHash(ctrl), ctrlChangeCount: 7 });
    await origins.record(file, 'T_ROB2', local, 'r1', '2026-11-20T14:03:00.000Z');
    assert.equal(origins.get(file)?.ctrlHash, undefined);
    await origins.recordController(file, { text: changed });
    assert.equal(origins.get(file)?.ctrlHash, controllerHash(changed));
    assert.equal(origins.get(file)?.task, 'T_ROB2');
    await origins.recordController(path.resolve('work', 'never.mod'), { text: changed });
    assert.equal(origins.get(path.resolve('work', 'never.mod')), undefined);
  });
});

describe('the restore point', () => {
  it('lives under the global storage, per robot, task and time, named for the module', () => {
    const p = restorePointPaths('C:\\store', 'robot-1', 'T_ROB2', 'Main_T2', '.mod', new Date('2026-11-20T14:31:05.123Z'));
    assert.equal(p.dir, path.join('C:\\store', 'restore-points', 'robot-1', 'T_ROB2', '20261120T143105Z'));
    assert.equal(p.file, path.join(p.dir, 'Main_T2.mod'));
    assert.equal(p.meta, path.join(p.dir, 'restore.json'));
    assert.equal(restorePointPaths('s', 'a/b', 'T:1', 'M*', '', new Date(0)).file, path.join('s', 'restore-points', 'a_b', 'T_1', '19700101T000000Z', 'M_.mod'));
  });

  it('a controller copy with non-ASCII characters is saved but not offered back', () => {
    assert.equal(hasNonAscii('MODULE M\nENDMODULE\n'), false);
    assert.equal(hasNonAscii('! gemäß\n'), true);
    assert.equal(hasNonAscii('M\x00O\x00\n'), true, 'a control character withholds the reload too');
    assert.equal(hasNonAscii('a\tb\r\nc\n'), false);
  });

  it('the point being restored is spared: the restore of the oldest of 20 removes the next oldest, not the chosen one (slice 5, fix 1)', () => {
    const removed: string[] = [];
    const base = path.join('s', 'restore-points');
    const stamp = (n: number): string => `202611${String(1 + Math.floor(n / 24)).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}0000Z`;
    // 21 points of A: the 20 kept before the restore, plus the one the restore just wrote (the newest).
    const dirs = new Map<string, { module: string; size: number }>();
    for (let i = 0; i < 21; i++) { dirs.set(path.join(base, 'r1', 'T_ROB1', stamp(i)), { module: 'A', size: 1000 }); }
    const fsLike: RestoreFs = {
      list: dir => {
        if (dir === base) { return ['r1']; }
        if (dir === path.join(base, 'r1')) { return ['T_ROB1']; }
        if (dir === path.join(base, 'r1', 'T_ROB1')) { return [...dirs.keys()].map(d => path.basename(d)); }
        return dirs.has(dir) ? ['A.mod', 'restore.json'] : [];
      },
      isDir: p => p === base || p === path.join(base, 'r1') || p === path.join(base, 'r1', 'T_ROB1') || dirs.has(p),
      size: f => (path.basename(f) === 'restore.json' ? 100 : dirs.get(path.dirname(f))?.size ?? 0),
      remove: dir => { removed.push(dir); },
      readMeta: f => { const d = dirs.get(path.dirname(f)); return d ? { module: d.module } as RestoreMeta : undefined; },
    };
    const oldest = path.join(base, 'r1', 'T_ROB1', stamp(0));
    // Without a spare the oldest goes; with the oldest spared, the one after it goes and the chosen point stays on disk.
    assert.deepEqual(pruneRestorePoints('s', fsLike), [oldest]);
    removed.length = 0;
    assert.deepEqual(pruneRestorePoints('s', fsLike, undefined, undefined, oldest), [path.join(base, 'r1', 'T_ROB1', stamp(1))]);
    assert.ok(!removed.includes(oldest));
    // The byte cap spares it too: the chosen point counts as the newest.
    for (const d of dirs.keys()) { dirs.set(d, { module: 'A', size: 6 * 1024 * 1024 }); }
    removed.length = 0;
    const gone = pruneRestorePoints('s', fsLike, undefined, undefined, oldest);
    assert.ok(gone.length > 1 && !gone.includes(oldest), `${gone.length} removed under the cap, the chosen one kept`);
  });

  it('keeps the newest 20 per robot, task and module, and at most 100 MB in all', () => {
    const removed: string[] = [];
    const dirs = new Map<string, { module: string; size: number }>();
    const base = path.join('s', 'restore-points');
    const stamp = (n: number): string => `202611${String(1 + Math.floor(n / 24)).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}0000Z`;
    // 25 small points of A, newer than 5 large points of B (30 MB each).
    for (let i = 0; i < 25; i++) { dirs.set(path.join(base, 'r1', 'T_ROB1', stamp(100 + i)), { module: 'A', size: 1000 }); }
    for (let i = 0; i < 5; i++) { dirs.set(path.join(base, 'r1', 'T_ROB1', stamp(i)), { module: 'B', size: 30 * 1024 * 1024 }); }
    const fsLike: RestoreFs = {
      list: dir => {
        if (dir === base) { return ['r1']; }
        if (dir === path.join(base, 'r1')) { return ['T_ROB1']; }
        if (dir === path.join(base, 'r1', 'T_ROB1')) { return [...dirs.keys()].map(d => path.basename(d)); }
        return dirs.has(dir) ? ['M.mod', 'restore.json'] : [];
      },
      isDir: p => p === base || p === path.join(base, 'r1') || p === path.join(base, 'r1', 'T_ROB1') || dirs.has(p),
      size: f => (path.basename(f) === 'restore.json' ? 100 : dirs.get(path.dirname(f))?.size ?? 0),
      remove: dir => { removed.push(dir); },
      readMeta: f => { const d = dirs.get(path.dirname(f)); return d ? { module: d.module } as RestoreMeta : undefined; },
    };
    const gone = pruneRestorePoints('s', fsLike);
    assert.deepEqual(gone, removed);
    // The 5 oldest of A (25 kept at 20), then the oldest points of all until 100 MB: the B points are the oldest, 150 MB, so the two oldest go.
    const goneA = gone.filter(d => dirs.get(d)?.module === 'A');
    const goneB = gone.filter(d => dirs.get(d)?.module === 'B');
    assert.equal(goneA.length, 5);
    assert.deepEqual(goneA.map(d => path.basename(d)).sort(), [100, 101, 102, 103, 104].map(stamp));
    assert.equal(goneB.length, 2);
    assert.deepEqual(goneB.map(d => path.basename(d)).sort(), [0, 1].map(stamp));
  });

  it('the closing message states the push and the restore', () => {
    const head = 'Push Current File of MainT2.mod to T_ROB2 on Cell1 (192.168.125.1:443) failed: the load was refused.';
    assert.equal(failureReport('Push Current File', 'MainT2.mod', 'T_ROB2', 'Cell1 (192.168.125.1:443)', 'the load was refused.', 'reloaded'), `${head} Restore: the saved copy was reloaded.`);
    assert.equal(failureReport('Push Current File', 'MainT2.mod', 'T_ROB2', 'Cell1 (192.168.125.1:443)', 'the load was refused.', 'declined'), `${head} Restore: not reloaded (declined).`);
    assert.match(failureReport('Push Current File', 'MainT2.mod', 'T_ROB2', 'Cell1', 'x.', { failed: 'no session' }), /Restore: failed: no session$/);
    assert.match(failureReport('Push Current File', 'MainT2.mod', 'T_ROB2', 'Cell1', 'x.', 'not-needed'), /still loaded as it was; nothing was lost\.$/);
    assert.match(failureReport('Push Current File', 'MainT2.mod', 'T_ROB2', 'Cell1', 'x.', 'withheld'), /cannot be reloaded by RAPID Live yet; it is kept on disk\.$/);
  });
});

describe('the extension hands the push flow its deps, with the loads inside the send', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const deps = src.slice(src.indexOf('const pushDepsFor = ('), src.indexOf('const watchProvider'));

  it('the four load paths go through src/pushFlow.ts: Push and Load through pushModule, the lens and Run routine through preflight then loadInsideSend', () => {
    for (const id of ['abbRobot.pushCurrentFile', 'abbRobot.uploadModule']) {
      const start = src.indexOf(`tracedCommand('${id}'`);
      const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
      assert.match(body, /await loadModuleFile\(entry, taskName, /, id);
    }
    assert.match(deps, /pushModule\(pushDepsFor\(entry, taskName, filePath, label, progress\)\)/);
    for (const id of ['abbRobot.setPPFromCodeLens', 'abbRobot.runRoutineFromCodeLens']) {
      const start = src.indexOf(`tracedCommand('${id}'`);
      const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
      assert.match(body, /const pre = (lens|run)Deps \? await preflight\((lens|run)Deps\) : undefined;\s*if \(needsLoad && !pre\) \{ return; \}/, id);
      const dialogAt = Math.min(...['sendMotion(entry, {', 'sendTo(entry, request'].map(s => body.indexOf(s)).filter(i => i >= 0));
      assert.ok(body.indexOf('await preflight(') < dialogAt, `${id}: the preflight comes before the dialog`);
      assert.match(body, /const step = await loadInsideSend\((lens|run)Deps, pre, \{\s*load: async \(\) => \(await withStopOffer\('Load module', stop => active\.loadProgram\(filePath, taskName, \{ stopIfRunning: stop, resetPP: false \}\), entry\)\) !== CANCELLED,/, id);
    }
  });

  it('the deps read the file as bytes, read the controller copy fresh, write the restore point under the storage root, and define the loads inside sendTo', () => {
    assert.match(deps, /readBytes: \(\) => fs\.readFileSync\(filePath\),/);
    assert.match(deps, /getModuleText: \(task, module\) => entry\.manager\.getModuleText\(task, module\),/);
    // The retention spares the file's own folder: the chosen point's for a restore.
    assert.match(deps, /writeRestorePoint: \(module, ctrl, reason\) => writeRestorePoint\(entry, taskName, module, path\.extname\(filePath\), ctrl, reason, path\.dirname\(filePath\)\),/);
    assert.match(src, /pruneRestorePoints\(restoreRoot, restoreFs, undefined, undefined, spare\);/);
    // The base after a pull is the module text read too (a PERS at its declared value), never the pulled file's text.
    assert.match(src, /origins\.recordController\(filePath, await entry\.manager\.getModuleText\(task, moduleName\)\)/);
    assert.match(deps, /isNotFound: e => [\s\S]*?code === 'MODULE_NOT_FOUND' \|\| code === 'RESOURCE_NOT_FOUND'/);
    assert.match(deps, /send: \(request, run\) => sendTo\(entry, request, \(\) => \{[\s\S]*?entry\.manager\.loadProgram\(file, taskName, \{ stopIfRunning: stop, resetPP: false \}\)[\s\S]*?return run\(\{ load: \(\) => withLoad\(filePath, label\), reload: file => withLoad\(file, 'Restore module'\) \}\);/);
    assert.match(deps, /refusal: \(\) => guard\.refuse\?\.\(label, robot\),/);
    assert.match(deps, /vscode\.diff/);
  });

  it('Restore Module from Restore Point is a command that runs the same confirmed write', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    assert.ok(manifest.contributes.commands.some(c => c.command === 'abbRobot.restoreModule' && c.title === 'Restore Module from Restore Point…'));
    const start = src.indexOf("tracedCommand('abbRobot.restoreModule'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.match(body, /deps\.send\(\{\s*label: `Restore module \$\{meta\.module\}`, tier: 'disruptive', taskApplies: true, task: meta\.task,/);
    // The load is the deps' (built on the saved copy's file); the handler loads nothing itself (review finding 13).
    assert.match(body, /const deps = pushDepsFor\(entry, meta\.task, meta\.file, `Restore module \$\{meta\.module\}`, 'Restoring'\);/);
    assert.match(body, /ops => restoreInsideSend\(deps, meta\.module, ops\)/);
    assert.doesNotMatch(body, /loadProgram\(/);
  });
});

describe('the file name and the declared module name (review finding 1)', () => {
  it('the client names the module after the file: the declaration must be the same, exactly', () => {
    assert.equal(moduleNameOfFile('Main_T2.mod'), 'Main_T2');
    assert.equal(moduleNameOfFile('BASE.SYS'), 'BASE');
    assert.equal(moduleNameOfFile('prog.prg'), 'prog.prg'); // a .prg keeps its extension, as the client names it; the push refuses .prg before this
    assert.equal(moduleNameOfFile('Main_T2.controller.mod'), 'Main_T2.controller');
    assert.equal(moduleNameMismatch('Push Current File', 'Main_T2.mod', 'Main_T2'), undefined);
    assert.equal(moduleNameMismatch('Push Current File', 'Foo.mod', 'Bar'),
      'Push Current File not sent: Foo.mod declares MODULE Bar, but the controller loads it as Foo and replaces a module of that name. Name the file Bar.mod or the module Foo, exactly as the other, then push again. Nothing was sent.');
    // A case-only difference is a difference: the client's unload test is case-sensitive, and the controller then loads a second copy under another name.
    assert.match(moduleNameMismatch('Push Current File', 'mainmodule.mod', 'MainModule') ?? '', /^Push Current File not sent: mainmodule\.mod declares MODULE MainModule, but the controller loads it as mainmodule/);
    assert.match(moduleNameMismatch('Load Program from File', 'Main_T2.controller.mod', 'Main_T2') ?? '', /Name the file Main_T2\.mod or the module Main_T2\.controller/);
  });

  it('the preflight refuses the mismatch before any controller read', () => {
    const flow = fs.readFileSync(path.join(root, 'src', 'pushFlow.ts'), 'utf8');
    const at = flow.indexOf('const mismatch = moduleNameMismatch(d.label, d.fileName, moduleName);');
    assert.ok(at > 0, 'the preflight checks the names');
    assert.ok(at < flow.indexOf('d.getModuleText(d.taskName, moduleName)'), 'before the controller read');
    assert.match(flow, /if \(mismatch\) \{ await d\.ui\.modal\(mismatch, undefined, \[\]\); return undefined; \}/);
  });
});
