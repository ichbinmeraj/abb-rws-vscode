import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterFailedLoad, loadBullets, loadInsideSend, loadLanded, preflight, pushModule, restoreInsideSend, savedBeforeLoad, type LoadOps, type PushDeps, type Preflight } from '../src/pushFlow';
import { sendConfirmed, type ConfirmRequest, type GuardUi } from '../src/confirm';
import { controllerHash } from '../src/pushGuard';
import type { FileOrigin } from '../src/taskResolver';

const LOCAL = 'MODULE Main_T2\n  PROC main()\n  ENDPROC\nENDMODULE\n';
const CTRL = 'MODULE Main_T2\n  PROC main()\n    TPWrite "old";\n  ENDPROC\nENDMODULE\n';
// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

const notFound = Object.assign(new Error('not there'), { code: 'MODULE_NOT_FOUND' });

/** A fake of everything the flow touches, recording what happened. */
function fake(over: {
  bytes?: string; refusal?: string; controller?: string | Error; origin?: FileOrigin; answers?: Record<string, string | undefined>;
  load?: () => Promise<boolean>; reread?: () => Promise<{ text: string; changeCount: number }>; listed?: string[] | Error; restoreFails?: boolean;
  /** The task's module list as read after a load went through (the list before it is `listed`). */
  listedAfterLoad?: string[];
  /** The list read before the load fails (after it, `listedAfterLoad` answers). */
  listedBeforeFails?: boolean;
  fileName?: string;
  /** The copy as read again inside the send (finding 8); the first read's copy unless given. */
  meanwhile?: () => Promise<{ text: string; changeCount: number }>;
} = {}) {
  const log: string[] = [];
  const restorePoints: Array<{ module: string; text: string; reason: string }> = [];
  const dialogs: Array<{ message: string; detail?: string; buttons: string[] }> = [];
  const messages: string[] = [];
  let reads = 0;
  let lists = 0;
  const ui: GuardUi = {
    modal: async (message, detail, buttons) => { dialogs.push({ message, detail, buttons }); const a = over.answers?.[message.slice(0, 20)] ?? over.answers?.['*']; return a === 'first' ? buttons[0] : a; },
    input: async () => undefined,
    warn: m => { messages.push(`warn: ${m}`); },
    log: l => { log.push(l); },
    refuse: () => undefined,
  };
  const deps: PushDeps = {
    label: 'Push Current File', fileName: over.fileName ?? 'Main_T2.mod', taskName: 'T_ROB2', robotName: 'Cell1', robotLabel: 'Cell1 (192.168.125.1:443)', robotId: 'r1',
    moduleOf: text => /\bMODULE\s+(\w+)/i.exec(text)?.[1] ?? 'Main_T2',
    refusal: () => over.refusal,
    showRefusal: s => { messages.push(`refused: ${s}`); },
    readBytes: () => Buffer.from(over.bytes ?? LOCAL, 'latin1'),
    getModuleText: async () => {
      reads++;
      // 1: the preflight; 2: the read inside the send after the confirmation; 3 and later: after a failed load.
      if (reads === 2 && over.meanwhile) { return over.meanwhile(); }
      if (reads >= 3 && over.reread) { return over.reread(); }
      if (over.controller instanceof Error) { throw over.controller; }
      if (over.controller === undefined) { throw notFound; }
      return { text: over.controller, changeCount: 7 };
    },
    isNotFound: e => (e as { code?: string }).code === 'MODULE_NOT_FOUND',
    // The first list read is the one before a load; from the second on, the list after it (`listedAfterLoad`, when given).
    listModules: async () => {
      lists++;
      if (over.listed instanceof Error) { throw over.listed; }
      if (lists === 1 && over.listedBeforeFails) { throw new Error('HTTP 503'); }
      return lists >= 2 && over.listedAfterLoad ? over.listedAfterLoad : (over.listed ?? []);
    },
    origin: () => over.origin,
    writeRestorePoint: (module, ctrl, reason) => {
      if (over.restoreFails) { return undefined; }
      restorePoints.push({ module, text: ctrl.text, reason });
      return { file: `C:\\store\\${module}.mod`, nonAscii: false, at: '2026-11-20T14:31:00.000Z' };
    },
    ui: {
      modal: async (message, detail, buttons) => { dialogs.push({ message, detail, buttons }); const a = over.answers?.[message.slice(0, 20)] ?? over.answers?.['*']; return a === 'first' ? buttons[0] : a === 'second' ? buttons[1] : a; },
      warn: m => { messages.push(`warn: ${m}`); },
      info: m => { messages.push(`info: ${m}`); },
      goToLine: async (line, column) => { messages.push(`goto ${line}:${column}`); },
      showDiff: async (_text, title) => { messages.push(`diff: ${title}`); },
    },
    send: async (request, run) => {
      const ops: LoadOps = {
        load: async () => { log.push('load'); return over.load ? over.load() : true; },
        reload: async file => { log.push(`reload ${file}`); return true; },
      };
      return sendConfirmed(ui, { name: 'Cell1', host: '192.168.125.1', port: 443 }, request, () => run(ops));
    },
    errorText: e => (e instanceof Error ? e.message : String(e)),
    showError: e => { messages.push(`error: ${e instanceof Error ? e.message : String(e)}`); },
    recordBase: async (module, text) => { log.push(`base ${module} ${text.length}`); },
  };
  return { deps, log, restorePoints, dialogs, messages, reads: () => reads };
}

const pulled = (text: string): FileOrigin => ({ task: 'T_ROB2', hash: 'x', robotId: 'r1', at: '2026-11-20T14:02:00.000Z', ctrlHash: controllerHash(text) });

describe('the push flow: the mode first, then the bytes, the names, the fresh controller read (review findings 4 and 6)', () => {
  it('a watch-only robot is refused before any dialog, any read and any restore point', async () => {
    const f = fake({ refusal: 'Push Current File not sent: Cell1 (192.168.125.1:443) is watch-only.', controller: CTRL, origin: pulled(CTRL) });
    assert.equal(await pushModule(f.deps), undefined);
    assert.deepEqual(f.messages, ['refused: Push Current File not sent: Cell1 (192.168.125.1:443) is watch-only.']);
    assert.deepEqual(f.dialogs, []);
    assert.equal(f.reads(), 0);
    assert.deepEqual(f.restorePoints, []);
    assert.deepEqual(f.log, []);
  });

  it('a cancelled confirmation leaves no restore point and sends nothing', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': undefined } });
    assert.equal(await pushModule(f.deps), undefined);
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].message, 'Push Current File in T_ROB2 on Cell1 (192.168.125.1:443)');
    assert.deepEqual(f.restorePoints, []);
    assert.deepEqual(f.log, []);
  });

  it('a confirmed push reads the copy again, writes the restore point from it inside the send, then loads, then records the base', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' } });
    assert.deepEqual(await pushModule(f.deps), { text: LOCAL });
    assert.equal(f.reads(), 2, 'the preflight read and the read after the confirmation');
    assert.deepEqual(f.restorePoints.map(r => r.reason), ['before Push Current File of Main_T2.mod']);
    assert.deepEqual(f.log, ['write Push Current File robot=Cell1 task=T_ROB2 tier=disruptive', 'load', 'base Main_T2 ' + LOCAL.length]);
    assert.match(String(f.dialogs[0].detail), /^Task: T_ROB2\n• Replaces module Main_T2 in T_ROB2 with Main_T2\.mod \(\d+ bytes, ASCII\)\./);
    assert.match(String(f.dialogs[0].detail), /saved as a restore point before anything is sent, once this is confirmed\./);
  });

  it('whether the load replaces a module comes from a fresh read: not found means it adds, with no base check and no restore point', async () => {
    const f = fake({ controller: undefined, answers: { '*': 'first' } });
    const pre = await preflight(f.deps) as Preflight;
    assert.equal(pre.replaces, false);
    assert.equal(pre.ctrl, undefined);
    assert.match(loadBullets(pre, 'T_ROB2')[0], /^Adds module Main_T2 to T_ROB2 from Main_T2\.mod/);
    assert.deepEqual(await pushModule(f.deps), { text: LOCAL });
    assert.deepEqual(f.restorePoints, []);
    assert.equal(f.log.filter(l => l === 'load').length, 1);
  });

  it('any other read error stops before the dialog', async () => {
    const f = fake({ controller: new Error('HTTP 503'), answers: { '*': 'first' } });
    assert.equal(await pushModule(f.deps), undefined);
    assert.deepEqual(f.messages, ['error: HTTP 503']);
    assert.deepEqual(f.dialogs, []);
  });

  it('a changed controller copy stops with Show diff and Push anyway; the push anyway says so in the dialog', async () => {
    const changed = CTRL.replace('old', 'pendant edit');
    const f = fake({ controller: changed, origin: pulled(CTRL), answers: { 'Main_T2 in T_ROB2 on': 'first' } });
    assert.equal(await preflight(f.deps), undefined);
    assert.match(f.messages[0], /^diff: T_ROB2\/Main_T2 on Cell1 \(controller, read /);
    const g = fake({ controller: changed, origin: pulled(CTRL), answers: { 'Main_T2 in T_ROB2 on': 'second', '*': 'first' } });
    const pre = await preflight(g.deps) as Preflight;
    assert.equal(pre.anyway, true);
    assert.match(loadBullets(pre, 'T_ROB2').join('\n'), /Overwrites changes made on the controller since /);
  });

  it('a controller copy equal to the file is nothing to push; a mismatched file name is refused before the read', async () => {
    const f = fake({ controller: LOCAL, origin: pulled(LOCAL) });
    assert.equal(await preflight(f.deps), undefined);
    assert.match(f.messages[0], /^info: Push Current File: nothing to push\./);
    const g = fake({ bytes: 'MODULE Other\nENDMODULE\n', controller: CTRL });
    assert.equal(await preflight(g.deps), undefined);
    assert.match(g.dialogs[0].message, /declares MODULE Other, but the controller loads it as Main_T2/);
    assert.equal(g.reads(), 0);
  });
});

describe('the copy read again after the confirmation (review finding 8)', () => {
  it('a change while the dialog was open stops the push: no restore point, no load', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, meanwhile: async () => ({ text: CTRL.replace('old', 'pendant edit'), changeCount: 8 }) });
    assert.equal(await pushModule(f.deps), undefined);
    assert.deepEqual(f.messages, ["warn: Push Current File not sent: the controller's copy of Main_T2 in T_ROB2 changed while the dialog was open. Push again to see the new diff. Nothing was sent."]);
    assert.deepEqual(f.restorePoints, []);
    assert.ok(!f.log.includes('load'));
  });

  it('a module unloaded meanwhile, or one that appeared meanwhile, stops the push too', async () => {
    const gone = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, meanwhile: async () => { throw notFound; } });
    assert.equal(await pushModule(gone.deps), undefined);
    assert.match(gone.messages[0], /was unloaded from T_ROB2 while the dialog was open. Push again to add it. Nothing was sent.$/);
    assert.deepEqual(gone.restorePoints, []);
    const appeared = fake({ controller: undefined, answers: { '*': 'first' }, meanwhile: async () => ({ text: CTRL, changeCount: 1 }) });
    assert.equal(await pushModule(appeared.deps), undefined);
    assert.match(appeared.messages[0], /was loaded into T_ROB2 while the dialog was open. Push again to see it against your file. Nothing was sent.$/);
    assert.ok(!appeared.log.includes('load'));
  });

  it('a read that fails inside the send sends nothing and shows the error', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, meanwhile: async () => { throw new Error('HTTP 503'); } });
    assert.equal(await pushModule(f.deps), undefined);
    assert.deepEqual(f.messages, ['error: HTTP 503']);
    assert.ok(!f.log.includes('load'));
  });

  it('the restore point holds the copy read after the confirmation, not the one the dialog described', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, meanwhile: async () => ({ text: CTRL, changeCount: 9 }) });
    assert.deepEqual(await pushModule(f.deps), { text: LOCAL });
    assert.equal(f.restorePoints[0].text, CTRL);
  });
});

describe('Restore Module from Restore Point saves the module loaded now first (review finding 13)', () => {
  const ops = (f: ReturnType<typeof fake>, loaded = true) => ({ load: async () => { f.log.push('load'); return loaded; }, reload: async () => true });

  it('a loaded module is saved as a restore point of its own, then the saved copy is loaded', async () => {
    const f = fake({ controller: 'MODULE Main_T2\n! pendant edit\nENDMODULE\n' });
    assert.equal(await restoreInsideSend(f.deps, 'Main_T2', ops(f)), 'done');
    assert.deepEqual(f.restorePoints, [{ module: 'Main_T2', text: 'MODULE Main_T2\n! pendant edit\nENDMODULE\n', reason: 'before the restore of Main_T2' }]);
    assert.deepEqual(f.log, ['load']);
  });

  it('no module of that name loaded: nothing to save, the saved copy is loaded', async () => {
    const f = fake({ controller: undefined });
    assert.equal(await restoreInsideSend(f.deps, 'Main_T2', ops(f)), 'done');
    assert.deepEqual(f.restorePoints, []);
    assert.deepEqual(f.log, ['load']);
  });

  it('a read that fails, or a restore point that cannot be written, sends nothing; a load cancelled at the stop offer is cancelled', async () => {
    const failed = fake({ controller: new Error('HTTP 503') });
    assert.equal(await restoreInsideSend(failed.deps, 'Main_T2', ops(failed)), 'cancelled');
    assert.deepEqual(failed.messages, ['error: HTTP 503']);
    assert.deepEqual(failed.log, []);
    const noPoint = fake({ controller: CTRL, restoreFails: true });
    assert.equal(await restoreInsideSend(noPoint.deps, 'Main_T2', ops(noPoint)), 'cancelled');
    assert.deepEqual(noPoint.log, []);
    const stopped = fake({ controller: CTRL });
    assert.equal(await restoreInsideSend(stopped.deps, 'Main_T2', ops(stopped, false)), 'cancelled');
    assert.equal(stopped.restorePoints.length, 1, 'the save comes before the offer');
  });

  it('the command runs it inside the deps\' send and loads nothing itself', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.restoreModule'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.match(body, /const deps = pushDepsFor\(entry, meta\.task, meta\.file, `Restore module \$\{meta\.module\}`, 'Restoring'\);/);
    assert.match(body, /deps\.send\(\{[\s\S]*?\}, ops => restoreInsideSend\(deps, meta\.module, ops\)\)/);
    assert.match(body, /is replaced, after it is saved as a restore point of its own\./);
    assert.doesNotMatch(body, /loadProgram\(/);
  });
});

describe('the editor is saved before a load from its file (review finding 17)', () => {
  const doc = (isDirty: boolean, saved = true) => { const log: string[] = []; return { d: { isDirty, save: async () => { log.push('save'); return saved; } }, log }; };
  const warnings: string[] = [];
  const warn = (m: string) => { warnings.push(m); };

  it('nothing to save: no editor, or one that is not dirty', async () => {
    assert.equal(await savedBeforeLoad(undefined, 'Set PP', 'Main_T2.mod', warn), true);
    const clean = doc(false);
    assert.equal(await savedBeforeLoad(clean.d, 'Set PP', 'Main_T2.mod', warn), true);
    assert.deepEqual(clean.log, []);
    assert.deepEqual(warnings, []);
  });

  it('a dirty editor is saved, and the load goes on only when the save went through', async () => {
    const saved = doc(true);
    assert.equal(await savedBeforeLoad(saved.d, 'Run routine', 'Main_T2.mod', warn), true);
    assert.deepEqual(saved.log, ['save']);
    assert.deepEqual(warnings, []);
    const declined = doc(true, false);
    assert.equal(await savedBeforeLoad(declined.d, 'Run routine', 'Main_T2.mod', warn), false);
    assert.deepEqual(warnings, ['Run routine not sent: Main_T2.mod has unsaved changes that were not saved. Save the file, then try again. Nothing was sent.']);
  });

  it('Push, Load Program from File and both lens loads run it before the preflight, through one document lookup', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const handler = (id: string): string => { const start = src.indexOf(`tracedCommand('${id}'`); assert.ok(start >= 0, id); return src.slice(start, src.indexOf('tracedCommand(', start + 1)); };
    assert.match(src, /const documentOf = \(filePath: string\): vscode\.TextDocument \| undefined => \{/);
    assert.match(src, /savedBeforeLoad\(documentOf\(filePath\), label, path\.basename\(filePath\), m => \{ vscode\.window\.showWarningMessage\(m\); \}\)/);
    assert.match(handler('abbRobot.pushCurrentFile'), /if \(!\(await savedFirst\(filePath, 'Push Current File'\)\)\) \{ return; \}/);
    assert.doesNotMatch(handler('abbRobot.pushCurrentFile'), /document\.save\(\)/);
    assert.match(handler('abbRobot.uploadModule'), /if \(!\(await savedFirst\(localPath, 'Load Program from File'\)\)\) \{ return; \}/);
    for (const [id, label] of [['abbRobot.setPPFromCodeLens', 'Set PP'], ['abbRobot.runRoutineFromCodeLens', 'Run routine']]) {
      const body = handler(id);
      const save = body.indexOf(`savedFirst(filePath, '${label}')`);
      const pre = body.indexOf('pushDepsFor(entry, taskName, filePath');
      assert.ok(save >= 0 && pre > save, `${id}: the save comes before the preflight`);
    }
  });
});

describe('a load the controller takes without loading the named module (live finding on RobotWare 6.16, 2026-10-30)', () => {
  it('the named module gone after a load that went through is a failed load: the stray module is named, and the saved copy is offered back', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, listed: ['BASE', 'Main_T2'], listedAfterLoad: ['BASE', 'this'], reread: async () => { throw notFound; } });
    assert.equal(await pushModule(f.deps), undefined);
    const offer = f.dialogs.find(d => / failed: /.test(d.message));
    assert.ok(offer, 'the failure flow ran');
    assert.match(offer.message, /failed: the controller took Main_T2\.mod, but no module Main_T2 is loaded in T_ROB2 afterwards \(it loaded this instead\)$/);
    assert.deepEqual(offer.buttons, ['Reload the saved copy…', 'Leave it']);
    assert.ok(f.log.includes('reload C:\\store\\Main_T2.mod'), 'the saved copy was reloaded');
    assert.ok(!f.log.some(l => /^base /.test(l)), 'no base recorded for a load that did not land');
  });

  it('the module listed after the load under its exact name is done; a list that cannot be read after the load is not held against it', async () => {
    const listed = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, listed: ['BASE', 'Main_T2'], listedAfterLoad: ['BASE', 'Main_T2'] });
    assert.deepEqual(await pushModule(listed.deps), { text: LOCAL });
    const unread = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, listed: new Error('HTTP 503') });
    assert.deepEqual(await pushModule(unread.deps), { text: LOCAL });
    assert.deepEqual(unread.dialogs.filter(d => / failed: /.test(d.message)), []);
  });
});

describe('what counts as landed after a load (slice 5, fix 2)', () => {
  it('the exact name, and no numbered name beside it', () => {
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', ['BASE', 'Main_T2'], ['BASE', 'Main_T2']), { landed: true });
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', ['BASE'], ['BASE', 'Main_T2']), { landed: true });
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', undefined, ['BASE', 'Main_T2', 'Other#2']), { landed: true }, 'a numbered name of another module, with no list before, is not this load\'s');
  });

  it('another case is not the module: the client unloads only an exact match, so the old module stays and the copy lands renamed', () => {
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', ['BASE', 'main_t2'], ['BASE', 'main_t2', 'Main_T2#2']),
      { landed: false, why: 'no module Main_T2 is loaded in T_ROB2 afterwards (it loaded Main_T2#2 instead), and main_t2 is still there under another case' });
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', ['BASE', 'Main_T2'], ['BASE', 'Main_T2', 'Main_T2#2']),
      { landed: false, why: 'Main_T2 is listed in T_ROB2, but Main_T2#2 landed beside it: the old module stayed and the new copy got a numbered name' });
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', ['BASE', 'Main_T2'], ['BASE', 'this']),
      { landed: false, why: 'no module Main_T2 is loaded in T_ROB2 afterwards (it loaded this instead)' });
  });

  it('with no list before the load, no stray name is guessed, except a numbered name of this module', () => {
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', undefined, ['BASE', 'this']), { landed: false, why: 'no module Main_T2 is loaded in T_ROB2 afterwards' });
    assert.deepEqual(loadLanded('Main_T2', 'T_ROB2', undefined, ['BASE', 'Main_T2#2']), { landed: false, why: 'no module Main_T2 is loaded in T_ROB2 afterwards (it loaded Main_T2#2 instead)' });
  });

  it('the push: a list that failed before the load does not spoil the message; a numbered name is a failed load with the offer', async () => {
    const unread = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, listedBeforeFails: true, listedAfterLoad: ['BASE', 'this'], reread: async () => { throw notFound; } });
    assert.equal(await pushModule(unread.deps), undefined);
    const offer = unread.dialogs.find(d => / failed: /.test(d.message));
    assert.ok(offer);
    assert.match(offer.message, /failed: the controller took Main_T2\.mod, but no module Main_T2 is loaded in T_ROB2 afterwards$/);
    const numbered = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, listed: ['BASE', 'Main_T2'], listedAfterLoad: ['BASE', 'Main_T2', 'Main_T2#2'] });
    assert.equal(await pushModule(numbered.deps), undefined);
    assert.ok(numbered.dialogs.some(d => /Main_T2#2 landed beside it/.test(d.message)) || numbered.messages.some(m => /Main_T2#2 landed beside it/.test(m)), 'the failure flow names the numbered module');
    assert.ok(!numbered.log.some(l => /^base /.test(l)), 'no base recorded');
  });

  it('a .prg file is refused before any read: a program, not a module', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, fileName: 'Main_T2.prg' });
    assert.equal(await pushModule(f.deps), undefined);
    assert.deepEqual(f.messages, ['warn: Push Current File not sent: Main_T2.prg is a program file. RAPID Live loads modules (.mod and .sys). Load a program from RobotStudio or the FlexPendant. Nothing was sent.']);
    assert.equal(f.reads(), 0);
    assert.deepEqual(f.dialogs, []);
  });

  it('the restore reads back too: a reload that landed renamed is reported, not called reloaded', async () => {
    const f = fake({ controller: CTRL, listed: ['BASE', 'Main_T2'], listedAfterLoad: ['BASE', 'Main_T2', 'Main_T2#2'] });
    const ops = { load: async () => { f.log.push('load'); return true; }, reload: async () => true };
    assert.equal(await restoreInsideSend(f.deps, 'Main_T2', ops), 'failed');
    assert.deepEqual(f.messages, ['warn: Push Current File: the saved copy was loaded, but Main_T2 is listed in T_ROB2, but Main_T2#2 landed beside it: the old module stayed and the new copy got a numbered name. Nothing else was changed.']);
    const fine = fake({ controller: CTRL, listed: ['BASE', 'Main_T2'], listedAfterLoad: ['BASE', 'Main_T2'] });
    assert.equal(await restoreInsideSend(fine.deps, 'Main_T2', { load: async () => true, reload: async () => true }), 'done');
  });
});

describe('after a failed load (review finding 7)', () => {
  const failing = { load: async () => { throw new Error('the load was refused'); } };

  it('still loaded as it was: nothing was lost, no offer', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, ...failing });
    assert.equal(await pushModule(f.deps), undefined);
    assert.equal(f.dialogs.length, 1);
    assert.match(f.messages[0], /failed: the load was refused The module is still loaded as it was; nothing was lost\.$/);
  });

  it('gone: the saved copy is offered back as its own confirmed write, and both steps are reported', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, ...failing, reread: async () => { throw notFound; } });
    assert.equal(await pushModule(f.deps), undefined);
    assert.equal(f.dialogs.length, 3);
    assert.match(String(f.dialogs[1].detail), /^The module Main_T2 is no longer loaded in T_ROB2\. RAPID Live saved the controller's copy at /);
    assert.equal(f.dialogs[2].message, 'Restore module Main_T2 in T_ROB2 on Cell1 (192.168.125.1:443)');
    assert.deepEqual(f.log.filter(l => l.startsWith('reload')), ['reload C:\\store\\Main_T2.mod']);
    assert.match(f.messages[f.messages.length - 1], /Restore: the saved copy was reloaded\.$/);
    assert.equal(f.restorePoints.length, 1, 'no second restore point for an absent module');
  });

  it('present but changed: the offer says it replaces the loaded module, and that one is saved first', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, ...failing, reread: async () => ({ text: 'MODULE Main_T2\n! new\nENDMODULE\n', changeCount: 9 }) });
    assert.equal(await pushModule(f.deps), undefined);
    assert.match(String(f.dialogs[1].detail), /is loaded in T_ROB2, but not as it was before the push\./);
    assert.match(String(f.dialogs[2].detail), /It replaces the module loaded there now, which is saved as a restore point first\./);
    assert.deepEqual(f.restorePoints.map(r => r.reason), ['before Push Current File of Main_T2.mod', 'before the restore of Main_T2']);
    assert.equal(f.restorePoints[1].text, 'MODULE Main_T2\n! new\nENDMODULE\n');
  });

  it('read failed: the saved copy is named and nothing is offered; a list without the module counts as gone', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, ...failing, reread: async () => { throw new Error('HTTP 503'); }, listed: new Error('no list') });
    assert.equal(await pushModule(f.deps), undefined);
    assert.equal(f.dialogs.length, 1);
    assert.match(f.messages[0], /could not be read back \(HTTP 503\).*The saved copy is at C:\\store\\Main_T2\.mod\.$/);
    const g = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, ...failing, reread: async () => { throw new Error('HTTP 503'); }, listed: ['BASE', 'user'] });
    assert.equal(await pushModule(g.deps), undefined);
    assert.match(String(g.dialogs[1].detail), /^The module Main_T2 is no longer loaded in T_ROB2\./);
  });

  it('the failure flow for an added module shows the error as it is', async () => {
    const f = fake({ controller: undefined, answers: { '*': 'first' }, ...failing });
    assert.equal(await pushModule(f.deps), undefined);
    assert.deepEqual(f.messages, ['error: the load was refused']);
  });

  it('a restore point that cannot be written sends nothing', async () => {
    const f = fake({ controller: CTRL, origin: pulled(CTRL), answers: { '*': 'first' }, restoreFails: true });
    const pre = await preflight(f.deps) as Preflight;
    const step = await loadInsideSend(f.deps, pre, { load: async () => { f.log.push('load'); return true; }, reload: async () => true });
    assert.equal(step, 'cancelled');
    assert.deepEqual(f.log, []);
    void afterFailedLoad;
  });
});
