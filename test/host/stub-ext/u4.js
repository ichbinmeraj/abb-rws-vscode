// U4: the extension's write commands in AUTO, one controller.
//
// Everything it creates carries a ZZ_ACC name and is removed again; every value
// it changes is put back (speed ratio, execution cycle, motors, the digital
// output, the clock is set to the value just read). It never changes the
// operating mode, never touches virtual time, and writes nothing that cannot be
// undone. Confirmations are answered by script and recorded with the other
// dialogs. A RobotWare 8 controller is only written to while Remote Access is on
// (`externalControlEnabled`); otherwise the step reports it is waiting.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Variables do not share the module's name (RAPID names ignore case).
const PROBE_MOD = [
  'MODULE ZZ_ACC',
  '  ! Host harness probe: counts, moves nothing.',
  '  VAR num zz_count := 0;',
  '  PROC main()',
  '    WHILE TRUE DO',
  '      zz_count := zz_count + 1;',
  '      WaitTime 0.2;',
  '    ENDWHILE',
  '  ENDPROC',
  'ENDMODULE',
  '',
].join('\n');

const MOD = 'ZZ_ACC';
const SYM = 'zz_count';
const CYCLE_LABEL = { once: 'Once', forever: 'Forever', asis: 'As Is' };

async function stepU4(ctx) {
  const { vscode, env, result, run, readerFor, setStep, withResponder } = ctx;
  const nap = ctx.sleep;
  const robotName = env.HOSTTEST_ROBOT_NAME || 'Host test';
  const u4 = result.u4 = { rows: [], cleanup: [], notes: [], original: {}, final: {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-live-u4-'));
  const probeFile = path.join(tmp, `${MOD}.mod`);
  fs.writeFileSync(probeFile, PROBE_MOD);

  setStep('U4 setup');
  const reader = await readerFor();
  const rm = reader.manager;
  const tryRead = async (label, fn) => { try { return await fn(); } catch (e) { u4.notes.push(`${label}: ${e && e.message ? String(e.message).slice(0, 160) : e}`); return undefined; } };
  const fresh = async () => { try { await rm.refresh(); } catch { /* the state read below says what it says */ } return rm.state; };
  const gen = rm.state.access && rm.state.access.generation;
  u4.generation = gen;

  // A RobotWare 8 controller is written to only with Remote Access on.
  if (gen === 'rw8') {
    const w = await tryRead('getWriteAccessStatus', () => rm.getWriteAccessStatus());
    u4.writeAccess = w ? { held: w.held, heldByName: w.heldByName, externalControlEnabled: w.externalControlEnabled } : null;
    if (!w || w.externalControlEnabled !== true) {
      u4.waiting = `Remote Access is off on this controller (externalControlEnabled ${w ? w.externalControlEnabled : 'unknown'}); nothing was written`;
      await reader.close();
      return;
    }
  }

  const task = (rm.state.tasks.find(t => t.active) || rm.state.tasks[0] || { name: 'T_ROB1' }).name;
  const s0 = await fresh();
  Object.assign(u4.original, { speedRatio: s0.speedRatio, execCycle: s0.execCycle, ctrlstate: s0.ctrlstate, opmode: s0.opmode, execstate: s0.execstate, modules: [...s0.modules] });
  if (s0.modules.includes(MOD)) { u4.abort = `${MOD} is already loaded; nothing was written`; await reader.close(); return; }
  if (s0.execstate === 'running') { u4.abort = 'RAPID is running; nothing was written'; await reader.close(); return; }
  const guard = s0.ctrlstate === 'guardstop' || s0.ctrlstate === 'emergencystop';
  u4.guard = guard;

  // What to use on this controller.
  const pickVolume = async names => {
    for (const v of names) { const l = await tryRead(`listDirectory ${v}`, () => rm.listDirectory(v)); if (Array.isArray(l)) { return v; } }
    return undefined;
  };
  const tempVol = await pickVolume(['TEMP', '$TEMP']);
  const backupVol = await pickVolume(['BACKUP', '$BACKUP']);
  const dos = await tryRead('searchSignals DO', () => rm.searchSignals({ name: 'ZZ_PROBE_DO', type: 'DO' })) || [];
  const doSig = dos.find(s => s.name === 'ZZ_PROBE_DO1') || dos[0];
  const doName = doSig && doSig.name;
  const doOriginal = doSig && doSig.lvalue;
  u4.original.signal = doSig ? { name: doName, lvalue: doOriginal } : null;
  let template;
  for (const n of (await tryRead('listCfgInstances', () => rm.listCfgInstances('EIO', 'EIO_SIGNAL')) || []).filter(n => /^ZZ_/.test(n))) {
    const a = await tryRead(`getCfgInstance ${n}`, () => rm.getCfgInstance('EIO', 'EIO_SIGNAL', n));
    if (a && (!template || a.Device === '')) { template = a; if (a.Device === '') { break; } }
  }
  u4.setup = { task, tempVol, backupVol, signal: doName, cfgTemplate: template ? template.Name : null, guardStop: guard };

  // ── helpers ──
  const typed = (kind, p) => {
    if (kind === 'warning' && p.modal && (p.buttons || []).includes('Continue')) { return 'Continue'; }
    if (kind === 'inputBox' && /^Type the robot's name/.test(p.prompt || '')) { return robotName; }
    return undefined;
  };
  const button = (kind, p) => (kind === 'warning' && p.modal && (p.buttons || []).length ? p.buttons[0] : undefined);
  const labelOf = i => (typeof i === 'string' ? i : i.label);
  const find = (items, label) => items.find(i => labelOf(i) === label);
  const row = (id, name, okDetail) => u4.rows.push({ row: id, name, ...okDetail });
  /** Run one command, wait a moment, then judge it by reading the controller back. */
  const act = async (id, name, command, responder, args, check, opts = {}) => {
    const s = await run(name, command, responder, args);
    await nap(opts.settle !== undefined ? opts.settle : 800);
    let c;
    try { c = check ? await check() : { ok: true, detail: '' }; } catch (e) { c = { ok: false, detail: `read-back threw: ${e && e.message ? e.message : e}` }; }
    row(id, name, { ok: !!c.ok, detail: c.detail || '', expectRefusal: opts.expectRefusal ? opts.expectRefusal.source : undefined, why: opts.why, threw: s.ok === false ? s.thrown : undefined });
    return c;
  };
  const skip = (id, name, why) => {
    u4.rows.push({ row: id, name, skipped: why });
    result.steps.push({ name, command: '(skipped)', start: new Date().toISOString(), end: new Date().toISOString(), ok: true });
  };
  const ppOf = async () => tryRead('getProgramPointer', () => rm.getProgramPointer(task));
  const readCount = async () => Number(await rm.getRapidVariable(task, MOD, SYM));
  const same = (a, b) => `${a}` === `${b}`;
  const recursiveDelete = async p => {
    const list = await tryRead(`listDirectory ${p}`, () => rm.listDirectory(p));
    if (Array.isArray(list)) { for (const e of list) { await recursiveDelete(`${p}/${e.name}`); } }
    await tryRead(`delete ${p}`, () => rm.deleteControllerFile(p));
  };

  let loaded = false;
  try {
    // #19 Load Program from File: the probe module, pointer at its main.
    await act('#19', 'U4 #19 uploadModule', 'abbRobot.uploadModule', (kind) => (kind === 'openDialog' ? probeFile : undefined), [],
      async () => {
        const s = await fresh();
        loaded = s.modules.includes(MOD);
        const pp = await ppOf();
        return { ok: loaded && pp && pp.module === MOD && /main/i.test(pp.routine || ''), detail: `modules ${s.modules.join(',')}; program pointer ${pp ? `${pp.module}/${pp.routine}` : 'unset'}` };
      }, { settle: 1500 });

    if (!loaded) {
      for (const [id, n] of [['#35', 'resetRapid'], ['#36', 'ppToMain'], ['#37', 'setPPToRoutine'], ['#38', 'setPPFromCodeLens'], ['#23', 'setExecutionCycle'],
        ['#26', 'setSpeedRatio'], ['#24', 'motorsOn'], ['#21', 'startRapid'], ['#22', 'stopRapid'], ['#25', 'motorsOff'], ['#43', 'writeWatchValue'], ['#47', 'writeVariable']]) {
        skip(id, `U4 ${id} ${n}`, `the probe module did not load (#19)`);
      }
    } else {
      // #35, #36 PP to Main; #37, #38 Set PP to routine.
      await act('#35', 'U4 #35 resetRapid', 'abbRobot.resetRapid', null, [], async () => {
        const pp = await ppOf(); return { ok: pp && pp.module === MOD && /main/i.test(pp.routine || ''), detail: `program pointer ${pp ? `${pp.module}/${pp.routine}` : 'unset'}` };
      });
      await act('#36', 'U4 #36 ppToMain', 'abbRobot.ppToMain', null, [], async () => {
        const pp = await ppOf(); return { ok: pp && pp.module === MOD && /main/i.test(pp.routine || ''), detail: `program pointer ${pp ? `${pp.module}/${pp.routine}` : 'unset'}` };
      });
      await act('#37', 'U4 #37 setPPToRoutine', 'abbRobot.setPPToRoutine',
        (kind, p) => (kind === 'quickPick' ? p.items.find(i => /main/i.test(i.label || i.name || '')) : undefined), [MOD, task],
        async () => { const pp = await ppOf(); return { ok: pp && pp.module === MOD && /main/i.test(pp.routine || ''), detail: `program pointer ${pp ? `${pp.module}/${pp.routine}` : 'unset'}` }; });
      await act('#38', 'U4 #38 setPPFromCodeLens', 'abbRobot.setPPFromCodeLens', null, [MOD, 'main'],
        async () => { const pp = await ppOf(); return { ok: pp && pp.module === MOD && /main/i.test(pp.routine || ''), detail: `program pointer ${pp ? `${pp.module}/${pp.routine}` : 'unset'}` }; });

      // #23 Set Execution Cycle: change it, read back, restore.
      const cyc0 = u4.original.execCycle;
      const cycNew = cyc0 === 'once' ? 'forever' : 'once';
      await act('#23', 'U4 #23 setExecutionCycle', 'abbRobot.setExecutionCycle', (kind, p) => (kind === 'quickPick' ? find(p.items, CYCLE_LABEL[cycNew]) : undefined), [],
        async () => { const s = await fresh(); return { ok: s.execCycle === cycNew, detail: `cycle ${cyc0} -> ${s.execCycle}` }; });
      if (CYCLE_LABEL[cyc0]) {
        await act('#23', 'U4 #23 restore cycle', 'abbRobot.setExecutionCycle', (kind, p) => (kind === 'quickPick' ? find(p.items, CYCLE_LABEL[cyc0]) : undefined), [],
          async () => { const s = await fresh(); return { ok: s.execCycle === cyc0, detail: `cycle back to ${s.execCycle}` }; });
      }

      // #26 Set Speed Ratio: change it, read back, restore.
      const sp0 = u4.original.speedRatio;
      const spNew = sp0 === 50 ? 40 : 50;
      await act('#26', 'U4 #26 setSpeedRatio', 'abbRobot.setSpeedRatio', (kind, p) => (kind === 'inputBox' ? String(spNew) : button(kind, p)), [],
        async () => { const s = await fresh(); return { ok: s.speedRatio === spNew, detail: `speed ${sp0} -> ${s.speedRatio}` }; });
      if (sp0 !== null && sp0 !== undefined) {
        await act('#26', 'U4 #26 restore speed', 'abbRobot.setSpeedRatio', (kind, p) => (kind === 'inputBox' ? String(sp0) : button(kind, p)), [],
          async () => { const s = await fresh(); return { ok: s.speedRatio === sp0, detail: `speed back to ${s.speedRatio}` }; });
      }

      // #24 Motors On, #21 Start, #22 Stop, #25 Motors Off. In a guard stop the
      // controller refuses the first two and the dialog is the finding.
      const refuseGuard = guard ? /guard stop|Reset|safety|motors/i : undefined;
      await act('#24', 'U4 #24 motorsOn', 'abbRobot.motorsOn', typed, [],
        async () => { const s = await fresh(); return guard ? { ok: s.ctrlstate !== 'motoron', detail: `controller state ${s.ctrlstate} (was ${u4.original.ctrlstate})` } : { ok: s.ctrlstate === 'motoron', detail: `controller state ${s.ctrlstate}` }; },
        { expectRefusal: refuseGuard, why: 'the controller is in a guard stop', settle: 1500 });
      await act('#21', 'U4 #21 startRapid', 'abbRobot.startRapid', typed, [],
        async () => {
          const s = await fresh();
          if (guard) { return { ok: s.execstate !== 'running', detail: `execution ${s.execstate}` }; }
          if (s.execstate !== 'running') { return { ok: false, detail: `execution ${s.execstate}` }; }
          const a = await readCount(); await nap(1200); const b = await readCount();
          return { ok: b > a, detail: `execution running; ${SYM} ${a} -> ${b}` };
        }, { expectRefusal: refuseGuard, why: 'the controller is in a guard stop', settle: 1500 });
      await act('#22', 'U4 #22 stopRapid', 'abbRobot.stopRapid', null, [],
        async () => { const s = await fresh(); return { ok: s.execstate === 'stopped', detail: `execution ${s.execstate}` }; }, { settle: 1500 });
      await act('#25', 'U4 #25 motorsOff', 'abbRobot.motorsOff', null, [],
        async () => { const s = await fresh(); return { ok: s.ctrlstate !== 'motoron', detail: `controller state ${s.ctrlstate}` }; }, { settle: 1500 });

      // #43 Edit Watched Value, #47 Write RAPID Variable (RAPID stopped).
      const entry = { task, module: MOD, symbol: SYM, value: '0' };
      await act('#43', 'U4 #43 writeWatchValue', 'abbRobot.writeWatchValue', (kind, p) => (kind === 'inputBox' ? '7' : button(kind, p)), [{ entry }],
        async () => { const v = await rm.getRapidVariable(task, MOD, SYM); return { ok: Number(v) === 7, detail: `${SYM} = ${v}` }; });
      await act('#47', 'U4 #47 writeVariable', 'abbRobot.writeVariable', (kind, p) => {
        if (kind !== 'inputBox') { return undefined; }
        const t = p.title || '';
        return /1\/4/.test(t) ? task : /2\/4/.test(t) ? MOD : /3\/4/.test(t) ? SYM : '0';
      }, [], async () => { const v = await rm.getRapidVariable(task, MOD, SYM); return { ok: Number(v) === 0, detail: `${SYM} = ${v}` }; });
    }

    // #52 Write Signal, #53 Toggle Signal on the probe output.
    if (doName) {
      const on = doOriginal === '1' ? '0' : '1';
      const readDo = async () => ((await rm.searchSignals({ name: doName, type: 'DO' })).find(s => s.name === doName) || {}).lvalue;
      await act('#52', 'U4 #52 writeSignal', 'abbRobot.writeSignal',
        (kind, p) => (kind === 'quickPick' ? find(p.items, on === '1' ? '1 - On' : '0 - Off') : button(kind, p)), [{ name: doName, type: 'DO', lvalue: doOriginal }],
        async () => { const v = await readDo(); return { ok: v === on, detail: `${doName} ${doOriginal} -> ${v}` }; });
      await act('#53', 'U4 #53 toggleSignal', 'abbRobot.toggleSignal', button, [{ name: doName, type: 'DO', value: on, lvalue: on }],
        async () => { const v = await readDo(); return { ok: v === doOriginal, detail: `${doName} ${on} -> ${v}` }; });
    } else {
      skip('#52', 'U4 #52 writeSignal', 'no ZZ_PROBE_DO output on this controller');
      skip('#53', 'U4 #53 toggleSignal', 'no ZZ_PROBE_DO output on this controller');
    }

    // #68 Create Directory, #69 Rename, #71 Compress, #67 Delete under TEMP.
    if (tempVol) {
      const dir = `${tempVol}/ZZ_ACC_DIR`, dir2 = `${tempVol}/ZZ_ACC_DIR2`, zip = `${tempVol}/ZZ_ACC_DIR2.zip`;
      const has = async (vol, name) => { const l = await rm.listDirectory(vol); return l.some(e => e.name === name); };
      await act('#68', 'U4 #68 createDirectory', 'abbRobot.createDirectory', (kind) => (kind === 'inputBox' ? dir : undefined), [],
        async () => ({ ok: await has(tempVol, 'ZZ_ACC_DIR'), detail: `${dir} listed` }));
      await act('#69', 'U4 #69 renameControllerFile', 'abbRobot.renameControllerFile', (kind) => (kind === 'inputBox' ? 'ZZ_ACC_DIR2' : undefined),
        [{ node: { path: dir, entry: { name: 'ZZ_ACC_DIR', type: 'dir' } } }],
        async () => ({ ok: (await has(tempVol, 'ZZ_ACC_DIR2')) && !(await has(tempVol, 'ZZ_ACC_DIR')), detail: `${dir} -> ${dir2}` }));
      await act('#71', 'U4 #71 compressPath', 'abbRobot.compressPath', (kind, p) => (kind === 'inputBox' ? (/Source/.test(p.prompt || '') ? dir2 : zip) : undefined), [],
        async () => ({ ok: await has(tempVol, 'ZZ_ACC_DIR2.zip'), detail: `${zip} listed` }));
      await act('#67', 'U4 #67 deleteControllerFile (archive)', 'abbRobot.deleteControllerFile', button, [{ node: { path: zip, entry: { name: 'ZZ_ACC_DIR2.zip', type: 'file' } } }],
        async () => ({ ok: !(await has(tempVol, 'ZZ_ACC_DIR2.zip')), detail: `${zip} gone` }));
      await act('#67', 'U4 #67 deleteControllerFile (folder)', 'abbRobot.deleteControllerFile', button, [{ node: { path: dir2, entry: { name: 'ZZ_ACC_DIR2', type: 'dir' } } }],
        async () => ({ ok: !(await has(tempVol, 'ZZ_ACC_DIR2')), detail: `${dir2} gone` }));
    } else {
      for (const [id, n] of [['#68', 'createDirectory'], ['#69', 'renameControllerFile'], ['#71', 'compressPath'], ['#67', 'deleteControllerFile']]) {
        skip(id, `U4 ${id} ${n}`, 'no TEMP volume could be listed');
      }
    }

    // #78-#82 DIPC with a ZZ_ queue.
    const queue = 'ZZ_ACC_Q';
    const queues = async () => ((await rm.listDipcQueues()) || []).map(q => q.name);
    const pickQueue = (kind, p) => (kind === 'quickPick' ? find(p.items, queue) : kind === 'inputBox' ? queue : undefined);
    await act('#78', 'U4 #78 dipcListQueues', 'abbRobot.dipcListQueues', null, [], async () => ({ ok: true, detail: `${(await queues()).length} queue(s)` }));
    // The queue size box is required: an empty answer is refused by the box and nothing is created.
    await act('#79', 'U4 #79 dipcCreateQueue (queue size left empty)', 'abbRobot.dipcCreateQueue', (kind, p) => {
      if (kind !== 'inputBox') { return undefined; }
      return /Queue name/.test(p.prompt || '') ? queue : /Queue size/.test(p.prompt || '') ? '' : undefined;
    }, [], async () => {
      const refused = result.ui.some(x => x.step === 'U4 #79 dipcCreateQueue (queue size left empty)' && x.kind === 'answer' && x.refusedBy);
      return { ok: refused && !(await queues()).includes(queue), detail: `the box refused the empty size: ${refused}; queues ${(await queues()).join(',') || 'none'}` };
    });
    await act('#79', 'U4 #79 dipcCreateQueue', 'abbRobot.dipcCreateQueue', (kind, p) => {
      if (kind !== 'inputBox') { return undefined; }
      return /Queue name/.test(p.prompt || '') ? queue : /Queue size/.test(p.prompt || '') ? '5' : /Largest message/.test(p.prompt || '') ? '128' : undefined;
    }, [], async () => ({ ok: (await queues()).includes(queue), detail: `queues ${(await queues()).join(',') || 'none'}` }));
    await act('#80', 'U4 #80 dipcSendMessage', 'abbRobot.dipcSendMessage', (kind, p) => {
      if (kind === 'quickPick' && /queue/i.test((p.opts && p.opts.placeHolder) || '')) { return find(p.items, queue); }
      if (kind === 'quickPick') { return find(p.items, 'string'); }
      if (kind === 'inputBox' && /payload/i.test(p.prompt || '')) { return 'hello'; }
      return kind === 'inputBox' ? queue : undefined;
    }, [], async () => ({ ok: true, detail: 'sent "hello" as string' }));
    await act('#81', 'U4 #81 dipcReadMessage', 'abbRobot.dipcReadMessage', pickQueue, [], async () => ({ ok: true, detail: 'read from the queue' }), { settle: 1500 });
    await act('#82', 'U4 #82 dipcRemoveQueue', 'abbRobot.dipcRemoveQueue', pickQueue, [],
      async () => ({ ok: !(await queues()).includes(queue), detail: `queues ${(await queues()).join(',') || 'none'}` }));

    // #77 Save Domain to .cfg, #76 Load it back (add), #74 Create, #73 Edit, #75 Remove.
    if (tempVol) {
      const cfgFile = `${tempVol}/ZZ_ACC_EIO.cfg`;
      const has = async (vol, name) => (await rm.listDirectory(vol)).some(e => e.name === name);
      const mmcFile = `${tempVol}/ZZ_ACC_MMC.cfg`;
      const saveLoad = async (id, domain, file) => {
        await act(id, `U4 ${id} saveCfgFile (${domain})`, 'abbRobot.saveCfgFile', (kind, p) => (kind === 'quickPick' ? find(p.items, domain) : kind === 'inputBox' ? file : undefined), [],
          async () => ({ ok: await has(tempVol, file.split('/').pop()), detail: `${file} listed` }), { settle: 1500 });
        await act(id === '#77' ? '#76' : '#76b', `U4 ${id === '#77' ? '#76' : '#76b'} loadCfgFile (${domain}, add)`, 'abbRobot.loadCfgFile',
          (kind, p) => (kind === 'inputBox' ? file : kind === 'quickPick' ? find(p.items, 'add') : button(kind, p)), [],
          async () => ({ ok: true, detail: `${file} loaded with add` }),
          // A file saved from this controller holds instances that already exist: the controller refuses it.
          { settle: 2500, expectRefusal: /already exists on the controller|file contains errors/, why: 'the saved file holds instances whose names already exist, or the controller finds errors in it' });
      };
      const domains = (await tryRead('listCfgDomains', () => rm.listCfgDomains())) || [];
      if (domains.includes('MMC')) { await saveLoad('#77', 'MMC', mmcFile); } else { skip('#77', 'U4 #77 saveCfgFile (MMC)', 'no MMC domain'); skip('#76', 'U4 #76 loadCfgFile (MMC, add)', 'no MMC domain'); }
      // The EIO domain, saved and loaded back: kept as its own row, since the controller has refused this load.
      await saveLoad('#77b', 'EIO', cfgFile);
    } else {
      skip('#77', 'U4 #77 saveCfgFile', 'no TEMP volume could be listed');
      skip('#76', 'U4 #76 loadCfgFile', 'no TEMP volume could be listed');
    }
    const inst = 'ZZ_ACC_DO9';
    if (template) {
      // The attributes exactly as a read returned them (rdonly and instanceid included): the extension leaves those out.
      const attrs = { ...template, Name: inst, Device: '', DeviceMap: '', rdonly: 'false', instanceid: '1143517132' };
      const exists = async () => (await rm.listCfgInstances('EIO', 'EIO_SIGNAL')).includes(inst);
      const pick = (kind, p) => {
        if (kind !== 'quickPick') { return undefined; }
        const ph = (p.opts && p.opts.placeHolder) || '';
        return /domain/i.test(ph) ? find(p.items, 'EIO') : /type/i.test(ph) ? find(p.items, 'EIO_SIGNAL') : find(p.items, inst);
      };
      await act('#74', 'U4 #74 createCfgInstance', 'abbRobot.createCfgInstance', (kind, p) => {
        if (kind === 'inputBox' && /instance name/i.test(p.prompt || '')) { return inst; }
        if (kind === 'inputBox') { return JSON.stringify(attrs); }
        return pick(kind, p);
      }, [], async () => ({ ok: await exists(), detail: `EIO/EIO_SIGNAL/${inst} listed` }));
      // #73: open it, change Label, save with Ctrl+S (the confirmation is answered).
      await act('#73', 'U4 #73 editCfgInstance', 'abbRobot.editCfgInstance', pick, [], async () => {
        const doc = vscode.workspace.textDocuments.find(d => /\.cfg\.jsonc$/.test(d.fileName) && d.fileName.includes(inst));
        if (!doc) { return { ok: false, detail: 'the instance did not open as a .cfg.jsonc document' }; }
        const lines = doc.getText().split(/\r?\n/);
        const body = lines.filter(l => !l.trim().startsWith('//')).join('\n');
        const parsed = JSON.parse(body);
        parsed.Label = 'acceptance';
        const text = `${lines.filter(l => l.trim().startsWith('//')).join('\n')}\n${JSON.stringify(parsed, null, 2)}`;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
        const s = await withResponder('U4 #73 save CFG instance (Ctrl+S)', button, async () => {
          await doc.save();
          await nap(2500);
        });
        const a = await rm.getCfgInstance('EIO', 'EIO_SIGNAL', inst);
        return { ok: a.Label === 'acceptance' && s.ok !== false, detail: `Label "${template.Label || ''}" -> "${a.Label}"` };
      }, { settle: 500 });
      await act('#75', 'U4 #75 removeCfgInstance', 'abbRobot.removeCfgInstance', (kind, p) => {
        // The confirmation names the robot and has the helper's one button ("Continue on <name>").
        if (kind === 'warning' && p.modal && (p.buttons || []).length) { return p.buttons[0]; }
        return pick(kind, p);
      }, [], async () => ({ ok: !(await exists()), detail: `EIO/EIO_SIGNAL/${inst} gone` }));
      if (tempVol) {
        await act('#67', 'U4 #67 deleteControllerFile (MMC cfg file)', 'abbRobot.deleteControllerFile', button,
          [{ node: { path: `${tempVol}/ZZ_ACC_MMC.cfg`, entry: { name: 'ZZ_ACC_MMC.cfg', type: 'file' } } }],
          async () => ({ ok: !(await rm.listDirectory(tempVol)).some(e => e.name === 'ZZ_ACC_MMC.cfg'), detail: 'ZZ_ACC_MMC.cfg gone' }));
        await act('#67', 'U4 #67 deleteControllerFile (cfg file)', 'abbRobot.deleteControllerFile', button,
          [{ node: { path: `${tempVol}/ZZ_ACC_EIO.cfg`, entry: { name: 'ZZ_ACC_EIO.cfg', type: 'file' } } }],
          async () => ({ ok: !(await rm.listDirectory(tempVol)).some(e => e.name === 'ZZ_ACC_EIO.cfg'), detail: 'ZZ_ACC_EIO.cfg gone' }));
      }
    } else {
      for (const [id, n] of [['#74', 'createCfgInstance'], ['#73', 'editCfgInstance'], ['#75', 'removeCfgInstance']]) {
        skip(id, `U4 ${id} ${n}`, 'no ZZ_ EIO_SIGNAL instance to model a new one on');
      }
    }

    // #61 Create Backup (deleted afterwards).
    const bk = 'ZZ_ACC_BK';
    await act('#61', 'U4 #61 createBackup', 'abbRobot.createBackup', (kind, p) => (kind === 'inputBox' && /Backup name/i.test(p.prompt || '') ? bk : undefined), [],
      async () => ({ ok: ((await rm.listBackups()) || []).some(b => b.name === bk), detail: `backups ${((await rm.listBackups()) || []).map(b => b.name).slice(-4).join(',')}` }),
      { settle: 1000 });

    // #20 Unload Module, then #14 Push (loads it again); the cleanup unloads it.
    if (loaded) {
      await act('#20', 'U4 #20 unloadModule', 'abbRobot.unloadModule', null, [MOD, task],
        async () => { const s = await fresh(); return { ok: !s.modules.includes(MOD), detail: `modules ${s.modules.join(',')}` }; }, { settle: 1200 });
      await act('#14', 'U4 #14 pushCurrentFile', 'abbRobot.pushCurrentFile', null, [vscode.Uri.file(probeFile)],
        async () => { const s = await fresh(); return { ok: s.modules.includes(MOD), detail: `modules ${s.modules.join(',')}` }; }, { settle: 1500 });
    }

    // #108 Read Controller Clock, #109 Set it to the value just read.
    let clockRead;
    await act('#108', 'U4 #108 getControllerClock', 'abbRobot.getControllerClock', null, [],
      async () => { clockRead = await rm.getControllerClock(); return { ok: !!clockRead, detail: `clock ${clockRead}` }; });
    if (clockRead) {
      const typedClock = String(clockRead).replace(/\s*T\s*/, ' ').replace(/Z$/, '').slice(0, 19);
      await act('#109', 'U4 #109 setControllerClock', 'abbRobot.setControllerClock', (kind) => (kind === 'inputBox' ? typedClock : undefined), [],
        async () => { const now = await rm.getControllerClock(); return { ok: true, detail: `set to "${typedClock}"; read back ${now}` }; },
        { expectRefusal: /clock|virtual|not (allowed|supported)|refus/i, why: 'ABB: a virtual controller refuses the clock set' });
    }
  } finally {
    // Put everything back and remove what was made, whatever happened above.
    setStep('U4 cleanup');
    const c = u4.cleanup;
    try {
      let s = await fresh();
      if (s.execstate === 'running') { await run('U4 cleanup stop', 'abbRobot.stopRapid', null); await nap(1000); s = await fresh(); c.push('RAPID was running: stopped'); }
      if (s.ctrlstate === 'motoron') { await run('U4 cleanup motors off', 'abbRobot.motorsOff', null); await nap(1000); c.push('motors were on: turned off'); }
      s = await fresh();
      const sp0 = u4.original.speedRatio;
      if (sp0 !== null && sp0 !== undefined && s.speedRatio !== sp0) {
        await run('U4 cleanup speed', 'abbRobot.setSpeedRatio', (kind) => (kind === 'inputBox' ? String(sp0) : undefined)); await nap(800); c.push(`speed set back to ${sp0}`);
      }
      const cyc0 = u4.original.execCycle;
      if (CYCLE_LABEL[cyc0] && s.execCycle !== cyc0) {
        await run('U4 cleanup cycle', 'abbRobot.setExecutionCycle', (kind, p) => (kind === 'quickPick' ? find(p.items, CYCLE_LABEL[cyc0]) : undefined)); await nap(800); c.push(`cycle set back to ${cyc0}`);
      }
      if (doName) {
        const v = ((await tryRead('read DO', () => rm.searchSignals({ name: doName, type: 'DO' })) || []).find(x => x.name === doName) || {}).lvalue;
        if (v !== undefined && v !== doOriginal) {
          await run('U4 cleanup signal', 'abbRobot.writeSignal', (kind, p) => (kind === 'quickPick' ? find(p.items, doOriginal === '1' ? '1 - On' : '0 - Off') : button(kind, p)), [{ name: doName, type: 'DO', lvalue: v }]);
          c.push(`${doName} set back to ${doOriginal}`);
        }
      }
      if ((await fresh()).modules.includes(MOD)) { await run('U4 cleanup unload', 'abbRobot.unloadModule', null, [MOD, task]); await nap(1000); c.push(`${MOD} unloaded`); }
      // The load stages the file in a controller folder: look for leftovers of ours.
      for (const vol of [tempVol, '$HOME', 'HOME'].filter(Boolean)) {
        const l = await tryRead(`listDirectory ${vol}`, () => rm.listDirectory(vol));
        for (const e of Array.isArray(l) ? l : []) {
          if (/^ZZ_ACC/i.test(e.name)) { await recursiveDelete(`${vol}/${e.name}`); c.push(`left over ${vol}/${e.name} deleted`); }
        }
      }
      const qs = (await tryRead('listDipcQueues', () => rm.listDipcQueues())) || [];
      for (const q of qs.filter(x => /^ZZ_ACC/.test(x.name))) { await tryRead('removeDipcQueue', () => rm.removeDipcQueue(q.name)); c.push(`left over DIPC queue ${q.name} removed`); }
      if ((await tryRead('listCfgInstances', () => rm.listCfgInstances('EIO', 'EIO_SIGNAL')) || []).includes('ZZ_ACC_DO9')) {
        await tryRead('removeCfgInstance', () => rm.removeCfgInstance('EIO', 'EIO_SIGNAL', 'ZZ_ACC_DO9')); c.push('left over EIO_SIGNAL ZZ_ACC_DO9 removed');
      }
      if (backupVol) {
        const l = await tryRead(`listDirectory ${backupVol}`, () => rm.listDirectory(backupVol));
        for (const e of Array.isArray(l) ? l : []) {
          if (e.name === 'ZZ_ACC_BK') { await recursiveDelete(`${backupVol}/${e.name}`); c.push(`backup ${e.name} deleted`); }
        }
      }
      // The watch list is the workspace's own; clear it if the step added one.
      await run('U4 cleanup watches', 'abbRobot.clearWatches', (kind, p) => (kind === 'warning' ? 'Clear' : undefined));
      const f = await fresh();
      Object.assign(u4.final, { speedRatio: f.speedRatio, execCycle: f.execCycle, ctrlstate: f.ctrlstate, opmode: f.opmode, execstate: f.execstate, modules: [...f.modules] });
      if (doName) {
        u4.final.signal = { name: doName, lvalue: ((await tryRead('read DO', () => rm.searchSignals({ name: doName, type: 'DO' })) || []).find(x => x.name === doName) || {}).lvalue };
      }
      const pp = await ppOf();
      u4.final.programPointer = pp ? `${pp.module || ''}/${pp.routine || ''}` : 'unset';
      u4.final.backups = ((await tryRead('listBackups', () => rm.listBackups())) || []).filter(b => /^ZZ_ACC/.test(b.name)).map(b => b.name);
    } catch (e) {
      u4.cleanup.push(`cleanup threw: ${e && e.message ? e.message : e}`);
    }
    await reader.close();
  }
}

module.exports = { stepU4, PROBE_MOD };
