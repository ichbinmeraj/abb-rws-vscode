// L1: the 1.5.0 live checks on one controller (the design note's section 10,
// tracker item 669). Runs alone, like U4, and connects itself, because the
// first check is the connect.
//
//   1  Set Robot Mode to Watch only before the connect. The lock state is read
//      before and after a watch-only connect through a second session
//      (mastership and the RMMP privilege on RobotWare 6 and 7, the control
//      station's write access on 8), and the connect's requests come from the
//      extension's own trace: no POST, PUT or DELETE, nothing on a mastership,
//      RMMP or control-station path. Then a write, refused in Watch only and
//      naming the robot.
//   2  Program and operate. A probe module ZZ_L1 is pushed into the task (the
//      confirmation names the robot and the task); a second push is nothing to
//      push. Set Speed Ratio changed and put back (a confirmation with no task).
//   3  The base check: the module is changed through the second session, then
//      Push stops with the diff and Push anyway; Push anyway replaces it, and
//      the read-back equals the file.
//   4  Restore Module from Restore Point puts the changed copy back, and the
//      replaced one is saved first (two restore points are listed after).
//   5  A forced load failure (a file with no MODULE line, which the controller
//      refuses after unloading the module) with the restore offer: the module
//      is back as it was, and the message reports both steps.
//   6  A Latin-1 file and a UTF-16 file are refused before any request.
//   7  RobotWare 8 only, with Remote Access on: Motors On refused without Allow
//      Motion Control (the error offers it), then Allow, Motors On, Motors Off,
//      Withdraw.
//   8  Cleanup: ZZ_L1 unloaded, its files removed, every value put back, the
//      state read back against the start; the lock state at the end, after the
//      disconnect.
//
// Everything it creates carries a ZZ_L1 name. It never changes the operating
// mode, never touches virtual time, and moves nothing: the probe module has no
// motion and no main, so no pointer offer follows a load.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MOD = 'ZZ_L1';
const PROBE = [
  'MODULE ZZ_L1',
  '  ! RAPID Live 1.5.0 live check: moves nothing, has no main.',
  '  VAR num zz_l1_count := 0;',
  '  PROC ZZ_L1_LOOP()',
  '    WHILE TRUE DO',
  '      zz_l1_count := zz_l1_count + 1;',
  '      WaitTime 0.5;',
  '    ENDWHILE',
  '  ENDPROC',
  'ENDMODULE',
  '',
].join('\n');
const EDIT_MARK = '! changed through a second session, as a FlexPendant edit would';
const EDITED = PROBE.replace('  ! RAPID Live 1.5.0 live check: moves nothing, has no main.', `  ! RAPID Live 1.5.0 live check: moves nothing, has no main.\n  ${EDIT_MARK}`);
// A file the controller refuses at load. A syntax error inside a module is not one: RobotWare 7.21.4 loaded a module
// with an unbalanced parenthesis, a missing ENDMODULE and a bad declaration (probe of 2026-10-30), with errors. A file
// with no MODULE line is refused, after the module of the file's name was unloaded: the restore offer's case. The
// extension's own name check passes it (a file that declares no module goes by its file name).
const BROKEN = 'this is not RAPID at all\n';
const LATIN1 = Buffer.from(PROBE.replace('moves nothing', 'bewegt nichts, gem\xe4\xdf Plan'), 'latin1');
const UTF16 = Buffer.from(PROBE, 'utf16le');

const norm = t => String(t || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');

async function stepL1(ctx) {
  const { vscode, env, result, run, readerFor, setStep, withResponder } = ctx;
  const nap = ctx.sleep;
  const robotId = env.HOSTTEST_ROBOT_ID;
  const robotName = env.HOSTTEST_ROBOT_NAME || 'Host test';
  const l1 = result.l1 = { rows: [], cleanup: [], notes: [], original: {}, final: {}, locks: {}, windows: {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-live-l1-'));
  const probeFile = path.join(tmp, `${MOD}.mod`);
  const editedFile = path.join(tmp, 'edited', `${MOD}.mod`);
  fs.mkdirSync(path.dirname(editedFile));
  fs.writeFileSync(probeFile, PROBE);
  fs.writeFileSync(editedFile, EDITED);

  // ── the second session: reads, the lock state, and the "pendant edit" ──
  setStep('L1 setup');
  const reader = await readerFor();
  const rm = reader.manager;
  const tryRead = async (label, fn) => { try { return await fn(); } catch (e) { l1.notes.push(`${label}: ${e && e.message ? String(e.message).slice(0, 160) : e}`); return undefined; } };
  const fresh = async () => { try { await rm.refresh(); } catch { /* the state read below says what it says */ } return rm.state; };
  const gen = rm.state.access && rm.state.access.generation;
  l1.generation = gen;
  /** The lock state as the second session reads it: what any client may hold on this controller right now. */
  const lockState = async () => {
    if (gen === 'rw8') {
      const w = await tryRead('getWriteAccessStatus', () => rm.getWriteAccessStatus());
      return w ? { kind: 'write-access', held: w.held, heldByMe: w.heldByMe, heldByName: w.heldByName, externalControlEnabled: w.externalControlEnabled } : { kind: 'write-access', error: 'not read' };
    }
    const out = { kind: 'mastership' };
    for (const domain of ['rapid', 'cfg', 'motion']) {
      const m = await tryRead(`getMastershipStatus ${domain}`, () => rm.getMastershipStatus(domain));
      out[domain] = m ? `${m.mastership}${m.application ? ` (${m.application})` : ''}${m.uid ? ` uid ${m.uid}` : ''}` : 'not read';
    }
    out.rmmp = await tryRead('getRmmpPrivilege', () => rm.getRmmpPrivilege());
    return out;
  };
  const task = (rm.state.tasks.find(t => t.active) || rm.state.tasks[0] || { name: 'T_ROB1' }).name;
  const s0 = await fresh();
  Object.assign(l1.original, { speedRatio: s0.speedRatio, ctrlstate: s0.ctrlstate, opmode: s0.opmode, execstate: s0.execstate, modules: [...s0.modules] });
  l1.task = task;
  if (s0.modules.includes(MOD)) { l1.abort = `${MOD} is already loaded; nothing was written`; await reader.close(); return; }
  if (s0.execstate === 'running') { l1.abort = 'RAPID is running; nothing was written'; await reader.close(); return; }
  l1.locks.before = await lockState();
  const ppOf = async () => tryRead('getProgramPointer', () => rm.getProgramPointer(task));
  const pp0 = await ppOf();
  l1.original.programPointer = pp0 ? `${pp0.module || ''}/${pp0.routine || ''}` : 'unset';

  // ── responders ──
  const robotLabelRe = new RegExp(`^${robotName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`);
  const labelOf = i => (typeof i === 'string' ? i : i.label);
  const pickTask = p => (p.items || []).find(i => labelOf(i) === task || new RegExp(`^${task}\\b`).test(labelOf(i)));
  /** The modal's first button that goes on (never the one that switches the mode from a refusal, never a Disconnect). */
  const modalGo = p => (p.buttons || []).find(b => /^(Continue on |Write to |Continue$|Push anyway|Reload the saved copy|Watch only on |Program and operate on |Withdraw$|Both stops are within my reach$)/.test(b));
  const confirm = (kind, p) => {
    if (kind === 'warning' && p.modal) { return modalGo(p); }
    if (kind === 'inputBox' && /^Type the robot's name/.test(p.prompt || '')) { return robotName; }
    if (kind === 'quickPick') { return pickTask(p); }
    return undefined;
  };
  const modalOnly = (kind, p) => (kind === 'warning' && p.modal ? modalGo(p) : undefined);
  /** Set Robot Mode: the modal, and the robot picker if the command shows one. */
  const modeAnswer = (kind, p) => (kind === 'quickPick' ? (p.items || []).find(i => labelOf(i).includes(robotName)) : modalOnly(kind, p));
  const row = (id, name, okDetail) => l1.rows.push({ row: id, name, ...okDetail });
  /** Run one command, wait, then judge it by reading the controller back. */
  const act = async (id, name, command, responder, args, check, opts = {}) => {
    const s = await run(name, command, responder, args);
    await nap(opts.settle !== undefined ? opts.settle : 1000);
    let c;
    try { c = check ? await check() : { ok: true, detail: '' }; } catch (e) { c = { ok: false, detail: `read-back threw: ${e && e.message ? e.message : e}` }; }
    row(id, name, { ok: !!c.ok, detail: c.detail || '', expectRefusal: opts.expectRefusal ? opts.expectRefusal.source : undefined, why: opts.why, threw: s.ok === false ? s.thrown : undefined });
    return c;
  };
  const skip = (id, name, why) => {
    l1.rows.push({ row: id, name, skipped: why });
    result.steps.push({ name, command: '(skipped)', start: new Date().toISOString(), end: new Date().toISOString(), ok: true });
  };
  const uiOf = name => result.ui.filter(u => u.step === name);
  const textOf = async () => { const t = await tryRead('getModuleText', () => rm.getModuleText(task, MOD)); return t ? norm(t.text) : undefined; };
  const loaded = async () => (await fresh()).modules.includes(MOD);

  let connected = false;
  try {
    // ── 1. Watch only, then the connect ──
    await act('1a', 'L1 set watch', 'abbRobot.setRobotMode', modeAnswer, [robotId, 'watch'], async () => {
      const said = uiOf('L1 set watch').some(u => u.kind === 'info' && /^Watch only on /.test(u.text || ''));
      return { ok: said, detail: said ? 'Watch only recorded before the connect' : 'no "Watch only on" message' };
    }, { settle: 300 });
    const connect = await run('L1 watch connect', 'abbRobot.connectRobot', null, [robotId]);
    connected = !uiOf('L1 watch connect').some(u => u.kind === 'error');
    l1.windows.connect = { start: connect.start, end: connect.end };
    // A quiet window after the connect: the slow reads, the polling, and nothing else.
    const idle = await withResponder('L1 watch idle', () => undefined, () => nap(6000));
    l1.windows.idle = { start: idle.start, end: idle.end };
    l1.locks.afterWatchConnect = await lockState();
    row('1b', 'L1 watch connect', { ok: connected, detail: connected ? `connected; locks before ${JSON.stringify(l1.locks.before)}; after ${JSON.stringify(l1.locks.afterWatchConnect)}` : 'the connect failed' });
    if (!connected) { l1.abort = 'the connect failed'; return; }
    await act('1c', 'L1 watch refusal', 'abbRobot.motorsOff', null, [], async () => {
      const refusal = uiOf('L1 watch refusal').find(u => u.kind === 'warning' && /not sent: .* is watch-only\./.test(u.text || ''));
      const s = await fresh();
      return { ok: !!refusal && refusal.text.includes(`${robotName} (`), detail: refusal ? `refused: ${refusal.text}` : `no watch-only refusal shown (controller state ${s.ctrlstate})` };
    }, { settle: 300 });

    // ── 2. Program and operate; the probe module; a value write ──
    await act('2a', 'L1 set operate', 'abbRobot.setRobotMode', modeAnswer, [robotId, 'operate'], async () => {
      const said = uiOf('L1 set operate').some(u => u.kind === 'info' && /^Program and operate on /.test(u.text || ''));
      return { ok: said, detail: said ? 'Program and operate recorded' : 'no "Program and operate on" message' };
    }, { settle: 300 });
    l1.locks.afterOperate = await lockState();
    await act('2b', 'L1 push new', 'abbRobot.pushCurrentFile', confirm, [vscode.Uri.file(probeFile)], async () => {
      const text = await textOf();
      const modal = uiOf('L1 push new').find(u => u.kind === 'warning' && u.modal);
      const named = !!modal && modal.text === `Push Current File in ${task} on ` + (modal.text.split(' on ')[1] || '') && robotLabelRe.test(modal.text.split(' on ')[1] || '');
      return { ok: text === norm(PROBE) && named, detail: `${text === norm(PROBE) ? `${MOD} loaded as pushed` : `${MOD} text differs or is absent`}; dialog: ${modal ? modal.text : 'none'}` };
    }, { settle: 1500 });
    await act('2c', 'L1 push same', 'abbRobot.pushCurrentFile', confirm, [vscode.Uri.file(probeFile)], async () => {
      const info = uiOf('L1 push same').find(u => u.kind === 'info' && /nothing to push/.test(u.text || ''));
      const modal = uiOf('L1 push same').find(u => u.kind === 'warning' && u.modal);
      return { ok: !!info && !modal, detail: info ? info.text : `no "nothing to push" message${modal ? `; a dialog was shown: ${modal.text}` : ''}` };
    }, { settle: 500 });
    const sp0 = l1.original.speedRatio;
    const spNew = sp0 === 50 ? 40 : 50;
    await act('2d', 'L1 speed ratio', 'abbRobot.setSpeedRatio', (kind, p) => (kind === 'inputBox' ? String(spNew) : modalOnly(kind, p)), [],
      async () => { const s = await fresh(); const modal = uiOf('L1 speed ratio').find(u => u.kind === 'warning' && u.modal); return { ok: s.speedRatio === spNew, detail: `speed ${sp0} -> ${s.speedRatio}; dialog: ${modal ? modal.text : 'none'}` }; });
    if (sp0 !== null && sp0 !== undefined) {
      await act('2d', 'L1 speed ratio back', 'abbRobot.setSpeedRatio', (kind, p) => (kind === 'inputBox' ? String(sp0) : modalOnly(kind, p)), [],
        async () => { const s = await fresh(); return { ok: s.speedRatio === sp0, detail: `speed back to ${s.speedRatio}` }; });
    }

    // ── 3. The base check ──
    setStep('L1 pendant edit');
    const editStep = { name: 'L1 pendant edit', command: '(second session: loadProgram of the edited file)', start: new Date().toISOString() };
    result.steps.push(editStep);
    try { await rm.loadProgram(editedFile, task, { resetPP: false }); editStep.ok = true; } catch (e) { editStep.ok = false; editStep.thrown = e && e.message ? e.message : String(e); }
    editStep.end = new Date().toISOString();
    await nap(1500);
    const edited = await textOf();
    row('3a', 'L1 pendant edit', { ok: edited === norm(EDITED), detail: edited === norm(EDITED) ? 'the controller copy now carries the edit' : `the edit did not land: ${editStep.thrown || 'text differs'}` });
    await act('3b', 'L1 push changed', 'abbRobot.pushCurrentFile', confirm, [vscode.Uri.file(probeFile)], async () => {
      const stop = uiOf('L1 push changed').find(u => u.kind === 'warning' && u.modal && /has changed on the controller since you pulled it/.test(u.text || ''));
      const text = await textOf();
      return { ok: !!stop && (stop.buttons || []).includes('Push anyway…') && text === norm(PROBE), detail: `${stop ? `stopped: ${stop.text} [${(stop.buttons || []).join(' / ')}]` : 'no changed-on-controller stop'}; after Push anyway the copy ${text === norm(PROBE) ? 'equals the file' : 'differs from the file'}` };
    }, { settle: 1500 });

    // ── 4. Restore Module from Restore Point ──
    await act('4a', 'L1 restore', 'abbRobot.restoreModule', (kind, p) => (kind === 'quickPick' ? (p.items || []).find(i => labelOf(i) === `${MOD} in ${task}`) : modalOnly(kind, p)), [], async () => {
      const text = await textOf();
      const modal = uiOf('L1 restore').find(u => u.kind === 'warning' && u.modal);
      return { ok: text === norm(EDITED), detail: `${text === norm(EDITED) ? 'the changed copy is back' : 'the copy is not the saved one'}; dialog: ${modal ? modal.text : 'none'}` };
    }, { settle: 1500 });
    await act('4b', 'L1 restore list', 'abbRobot.restoreModule', () => undefined, [], async () => {
      const pick = uiOf('L1 restore list').find(u => u.kind === 'quickPick');
      const n = pick ? (pick.items || []).filter(i => labelOf(i) === `${MOD} in ${task}`).length : 0;
      return { ok: n >= 2, detail: `${n} restore point(s) of ${MOD} listed (the push's and the restore's own)` };
    }, { settle: 300 });

    // ── 5. A forced load failure with the restore offer ──
    fs.writeFileSync(probeFile, BROKEN);
    await act('5a', 'L1 broken load', 'abbRobot.pushCurrentFile', confirm, [vscode.Uri.file(probeFile)], async () => {
      const text = await textOf();
      const back = text === norm(EDITED);
      const failed = uiOf('L1 broken load').find(u => u.kind === 'warning' && u.modal && / failed: /.test(u.text || ''));
      const report = uiOf('L1 broken load').filter(u => u.kind === 'warning' && !u.modal).map(u => u.text).pop();
      const stillThere = uiOf('L1 broken load').some(u => /still loaded as it was; nothing was lost/.test(u.text || ''));
      return { ok: back && (!!failed || stillThere), detail: `${back ? `${MOD} is back as it was` : `${MOD} is ${text === undefined ? 'absent' : 'changed'}`}; ${failed ? `offer: ${failed.text}` : stillThere ? 'the controller kept the module (no offer needed)' : 'no failure dialog'}; report: ${report || 'none'}` };
    }, { settle: 2000 });

    // ── 6. Refused before any request: the copy on the controller is whatever it is, and stays so ──
    const textBefore6 = await textOf();
    fs.writeFileSync(probeFile, LATIN1);
    await act('6a', 'L1 non-ascii', 'abbRobot.pushCurrentFile', confirm, [vscode.Uri.file(probeFile)], async () => {
      const w = uiOf('L1 non-ascii').find(u => u.kind === 'warning' && /has a non-ASCII character on line/.test(u.text || ''));
      const modal = uiOf('L1 non-ascii').find(u => u.kind === 'warning' && u.modal && /^Push Current File in/.test(u.text || ''));
      const same = (await textOf()) === textBefore6;
      return { ok: !!w && !modal && same, detail: `${w ? w.text.split('\n')[0] : 'no non-ASCII refusal'}; the controller copy ${same ? 'unchanged' : 'changed'}` };
    }, { settle: 300 });
    fs.writeFileSync(probeFile, UTF16);
    await act('6b', 'L1 utf-16', 'abbRobot.pushCurrentFile', confirm, [vscode.Uri.file(probeFile)], async () => {
      const w = uiOf('L1 utf-16').find(u => u.kind === 'warning' && /has a control character on line/.test(u.text || ''));
      const modal = uiOf('L1 utf-16').find(u => u.kind === 'warning' && u.modal && /^Push Current File in/.test(u.text || ''));
      const same = (await textOf()) === textBefore6;
      return { ok: !!w && !modal && same, detail: `${w ? w.text.split('\n')[0] : 'no control-character refusal'}; the controller copy ${same ? 'unchanged' : 'changed'}` };
    }, { settle: 300 });
    fs.writeFileSync(probeFile, PROBE);

    // ── 7. RobotWare 8: Motors On through the motion flow ──
    if (gen === 'rw8') {
      const w = l1.locks.afterOperate;
      if (!w || w.externalControlEnabled !== true) {
        skip('7', 'L1 motors (RobotWare 8)', `Remote Access is off on this controller (externalControlEnabled ${w ? w.externalControlEnabled : 'unknown'})`);
      } else if (s0.ctrlstate === 'motoron') {
        skip('7', 'L1 motors (RobotWare 8)', 'the motors are on already; nothing to turn on and put back');
      } else {
        // In a guard stop the controller refuses Motors On for the Reset it needs at the FlexPendant (the thumb button in
        // Auto), before and after Allow Motion Control: the motion-control refusal cannot be seen then, and the rows say so.
        const guard = s0.ctrlstate === 'guardstop' || s0.ctrlstate === 'emergencystop';
        const guardRe = /press Reset|guard stop|safety stop|CONTROLLER_STATE_REJECT/i;
        const guardWhy = `the controller is in ${s0.ctrlstate}: Reset at the FlexPendant is needed before the motors can go on, so the motion-control refusal is not seen on this run`;
        const motion = (kind, p) => {
          if (kind === 'warning' && p.modal) { return (p.buttons || []).find(b => b === 'Continue') || modalGo(p); }
          if (kind === 'inputBox' && /^Type the robot's name/.test(p.prompt || '')) { return robotName; }
          return undefined;
        };
        await act('7a', 'L1 motors on refused', 'abbRobot.motorsOn', motion, [], async () => {
          const s = await fresh();
          const err = uiOf('L1 motors on refused').find(u => u.kind === 'error');
          const refusedRight = !!err && (guard ? guardRe.test(err.text || '') : (err.buttons || []).includes('Allow Motion Control…'));
          return { ok: s.ctrlstate !== 'motoron' && refusedRight, detail: `controller state ${s.ctrlstate}; ${err ? `error: ${err.text.slice(0, 220)} [${(err.buttons || []).join(' / ')}]` : 'no error dialog'}` };
        }, { settle: 1500, expectRefusal: guard ? guardRe : /motion control/i, why: guard ? guardWhy : 'motion control is not allowed from this station yet' });
        await act('7b', 'L1 allow motion control', 'abbRobot.allowMotionControl', motion, [], async () => {
          const info = uiOf('L1 allow motion control').find(u => u.kind === 'info' && /allowed/i.test(u.text || ''));
          return { ok: !!info, detail: info ? info.text : 'no "allowed" message' };
        }, { settle: 1500 });
        await act('7c', 'L1 motors on', 'abbRobot.motorsOn', motion, [], async () => {
          const s = await fresh();
          if (guard) { const err = uiOf('L1 motors on').find(u => u.kind === 'error'); return { ok: s.ctrlstate !== 'motoron' && !!err && guardRe.test(err.text || ''), detail: `controller state ${s.ctrlstate}; ${err ? `error: ${err.text.slice(0, 220)}` : 'no error dialog'}` }; }
          return { ok: s.ctrlstate === 'motoron', detail: `controller state ${s.ctrlstate}` };
        }, { settle: 2000, expectRefusal: guard ? guardRe : undefined, why: guard ? guardWhy : undefined });
        await act('7d', 'L1 motors off', 'abbRobot.motorsOff', null, [], async () => {
          const s = await fresh(); return { ok: s.ctrlstate !== 'motoron', detail: `controller state ${s.ctrlstate}` };
        }, { settle: 2000 });
        await act('7e', 'L1 withdraw', 'abbRobot.withdrawMotionControl', modalOnly, [robotId], async () => {
          const info = uiOf('L1 withdraw').find(u => ['info', 'warning'].includes(u.kind) && /withdr/i.test(u.text || ''));
          return { ok: !!info, detail: info ? info.text : 'no withdrawal message' };
        }, { settle: 1500 });
      }
    }
  } finally {
    // ── 8. Cleanup, whatever happened above ──
    setStep('L1 cleanup');
    const c = l1.cleanup;
    try {
      fs.writeFileSync(probeFile, PROBE);
      let s = await fresh();
      if (s.execstate === 'running') { await run('L1 cleanup stop', 'abbRobot.stopRapid', null); await nap(1000); c.push('RAPID was running: stopped'); }
      if (s.ctrlstate === 'motoron' && l1.original.ctrlstate !== 'motoron') { await run('L1 cleanup motors off', 'abbRobot.motorsOff', null); await nap(1500); c.push('motors were on: turned off'); }
      s = await fresh();
      const sp0 = l1.original.speedRatio;
      if (sp0 !== null && sp0 !== undefined && s.speedRatio !== sp0) {
        await run('L1 cleanup speed', 'abbRobot.setSpeedRatio', (kind, p) => (kind === 'inputBox' ? String(sp0) : modalOnly(kind, p))); await nap(800); c.push(`speed set back to ${sp0}`);
      }
      if (await loaded()) { await run('L1 cleanup unload', 'abbRobot.unloadModule', confirm, [MOD, task]); await nap(3000); c.push(`${MOD} unloaded`); }
      // The second session's module list can lag one poll behind: read it again before a second unload.
      if (await loaded() && await loaded()) { await tryRead('unloadModule', () => rm.unloadModule(task, MOD)); await nap(1000); c.push(`${MOD} unloaded through the second session`); }
      // The load stages the file in a controller folder: look for leftovers of ours.
      for (const vol of ['TEMP', '$TEMP', '$HOME', 'HOME']) {
        const l = await tryRead(`listDirectory ${vol}`, () => rm.listDirectory(vol));
        for (const e of Array.isArray(l) ? l : []) {
          if (/^ZZ_L1/i.test(e.name)) { await tryRead(`delete ${vol}/${e.name}`, () => rm.deleteControllerFile(`${vol}/${e.name}`)); c.push(`left over ${vol}/${e.name} deleted`); }
        }
      }
      // Only the stray modules the extension's own failure messages named ("it loaded X instead": RobotWare 6.16 loaded
      // the no-MODULE file as a module named "this") are unloaded, each behind its own confirmation. Nothing else that
      // may be on a shared controller is touched, whether or not it appeared during the run.
      const named = new Set();
      for (const u of result.ui) {
        if (!/^L1 /.test(u.step)) { continue; }
        for (const m of String(u.text || '').matchAll(/\(it loaded ([^)]+) instead\)/g)) { for (const n of m[1].split(',')) { named.add(n.trim()); } }
      }
      const present = (await fresh()).modules;
      for (const m of [...named].filter(x => present.includes(x) && !l1.original.modules.includes(x))) {
        await run(`L1 cleanup unload ${m}`, 'abbRobot.unloadModule', confirm, [m, task]); await nap(2500); c.push(`${m} unloaded (the failure message named it)`);
      }
      const f = await fresh();
      Object.assign(l1.final, { speedRatio: f.speedRatio, ctrlstate: f.ctrlstate, opmode: f.opmode, execstate: f.execstate, modules: [...f.modules] });
      const pp = await ppOf();
      l1.final.programPointer = pp ? `${pp.module || ''}/${pp.routine || ''}` : 'unset';
    } catch (e) {
      c.push(`cleanup threw: ${e && e.message ? e.message : e}`);
    }
    if (connected) {
      await run('L1 disconnect', 'abbRobot.disconnectRobot', null, [robotId]);
      await nap(1500);
      l1.locks.end = await lockState();
    }
    await reader.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder */ }
  }
}

module.exports = { stepL1, PROBE, EDITED, EDIT_MARK };
