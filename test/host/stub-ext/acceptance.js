// The read-only acceptance steps of the host harness (U1, U2, U3). They run inside the
// VS Code extension host, called from suite.js, and never mix with the write
// steps A-I: no command that writes to a controller is run here, and virtual
// time is only read. Each step records what it did in `result` (dialogs,
// documents, files, selections); test/host/verdicts.js turns that into verdicts.
//
//   U1  language features and command registration, no controller
//   U2  the robot list: Add Robot (scan list), Discover Controllers, Manage Saved
//       Addresses, Set as Active Robot, Configure (cancelled), Remove Robot, and
//       the settings JSON (no password)
//   U3  per controller: the extension's read commands, then Refresh,
//       Disconnect (suite.js) and the checks after it (stepU3After)

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The controller files step U3 opens in the editor (#66): text, by extension. */
const TEXT_FILE = /\.(mod|sys|prg|cfg|txt|log|xml|json|csv|md|ini|cmd)$/i;

// A small RAPID module: a main, a procedure with a parameter, a call to it.
const SAMPLE_MOD = [
  'MODULE Acceptance_Sample',
  '  CONST num maxCount := 3;',
  '  PERS num counter := 0;',
  '  VAR robtarget pHome;',
  '',
  '  PROC main()',
  '    Home;',
  '    FOR i FROM 1 TO maxCount DO',
  '      Work i;',
  '    ENDFOR',
  '  ENDPROC',
  '',
  '  PROC Home()',
  '    MoveAbsJ [[0,0,0,0,30,0],[9E9,9E9,9E9,9E9,9E9,9E9]], v1000, fine, tool0;',
  '  ENDPROC',
  '',
  '  PROC Work(num n)',
  '    counter := counter + n;',
  '    TPWrite "n=" \\Num:=n;',
  '  ENDPROC',
  'ENDMODULE',
  '',
].join('\n');

// A module with an unfinished instruction, for completion and signature help.
const COMPLETION_MOD = [
  'MODULE Acceptance_Completion',
  '  PROC p()',
  '    MoveA',
  '    MoveL pHome, ',
  '  ENDPROC',
  'ENDMODULE',
  '',
].join('\n');

const textOf = h => (h.contents || []).map(c => (typeof c === 'string' ? c : c.value || '')).join(' ');
const labelOf = i => (typeof i.label === 'string' ? i.label : (i.label && i.label.label) || '');

// ── U1: language features and registered commands, no controller ──
async function stepU1(ctx) {
  const { vscode, env, result, exec, setStep, ext } = ctx;
  setStep('U1 language');
  const s = { name: 'U1 language', command: '(language providers, command registry)', start: new Date().toISOString() };
  result.steps.push(s);
  const u1 = result.u1 = { checks: [] };
  const check = (id, ok, detail) => u1.checks.push({ id, ok: !!ok, detail });
  try {
    const folder = env.HOSTTEST_FOLDER;
    const sample = path.join(folder, 'Acceptance_Sample.mod');
    const compl = path.join(folder, 'Acceptance_Completion.mod');
    fs.writeFileSync(sample, SAMPLE_MOD);
    fs.writeFileSync(compl, COMPLETION_MOD);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
    await vscode.window.showTextDocument(doc);
    const cdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(compl));
    u1.languageId = doc.languageId;
    check('languageId', doc.languageId === 'rapid', `.mod opens as "${doc.languageId}"`);
    await sleep(2500); // the workspace index builds after the open

    const at = (d, needle, delta = 0) => d.positionAt(d.getText().indexOf(needle) + delta);

    const hovers = await exec('vscode.executeHoverProvider', doc.uri, at(doc, 'MoveAbsJ', 2));
    const hoverText = (hovers || []).map(textOf).join(' ').replace(/\s+/g, ' ').trim();
    check('hover', hovers && hovers.length > 0 && /MoveAbsJ/i.test(hoverText), `${(hovers || []).length} hover(s); "${hoverText.slice(0, 160)}"`);

    const completions = await exec('vscode.executeCompletionItemProvider', cdoc.uri, at(cdoc, 'MoveA', 5));
    const items = (completions && completions.items) || [];
    const labels = items.map(labelOf);
    check('completion', labels.some(l => /^MoveAbsJ$/i.test(l)), `${items.length} item(s) after "MoveA"; first: ${labels.slice(0, 6).join(', ')}`);

    const sig = await exec('vscode.executeSignatureHelpProvider', cdoc.uri, at(cdoc, 'MoveL pHome, ', 'MoveL pHome, '.length), ' ');
    const sigs = (sig && sig.signatures) || [];
    check('signatureHelp', sigs.length > 0, `${sigs.length} signature(s); "${sigs[0] ? String(sigs[0].label).slice(0, 140) : ''}"`);

    const symbols = await exec('vscode.executeDocumentSymbolProvider', doc.uri);
    const flat = [];
    const walk = list => { for (const x of list || []) { flat.push(x.name); walk(x.children); } };
    walk(symbols);
    check('documentSymbols', ['main', 'Home', 'Work'].every(n => flat.includes(n)), `${flat.length} symbol(s): ${flat.slice(0, 12).join(', ')}`);

    const defs = await exec('vscode.executeDefinitionProvider', doc.uri, at(doc, 'Work i', 1));
    const def = (defs || [])[0];
    const defUri = def && (def.targetUri || def.uri);
    const defRange = def && (def.targetRange || def.range);
    check('definition', defUri && /Acceptance_Sample\.mod$/.test(defUri.fsPath) && defRange && defRange.start.line === doc.getText().split('\n').findIndex(l => /PROC Work/.test(l)),
      defRange ? `Work -> line ${defRange.start.line + 1}` : 'no definition');

    const refs = await exec('vscode.executeReferenceProvider', doc.uri, at(doc, 'PROC Work', 'PROC '.length + 1));
    check('references', (refs || []).length >= 2, `${(refs || []).length} reference(s) to Work`);

    const lenses = await exec('vscode.executeCodeLensProvider', doc.uri);
    const titles = (lenses || []).map(l => (l.command && l.command.title) || '(unresolved)');
    check('codeLens', (lenses || []).length > 0, `${(lenses || []).length} lens(es): ${[...new Set(titles)].slice(0, 5).join(' | ')}`);

    // Every contributed command is registered (after activation).
    const contributed = (ext.packageJSON.contributes.commands || []).map(c => c.command);
    const registered = new Set(await exec('__getCommands'));
    const missing = contributed.filter(c => !registered.has(c));
    u1.commands = { contributed: contributed.length, missing };
    check('commands', missing.length === 0, `${contributed.length} contributed, ${missing.length} not registered${missing.length ? `: ${missing.join(', ')}` : ''}`);
  } catch (e) {
    check('exception', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
  }
  s.ok = true;
  s.end = new Date().toISOString();
}

// ── U2: the robot list ──
async function stepU2(ctx) {
  const { env, result, run, exec } = ctx;
  const port = Number(new URL(env.HOSTTEST_BASE_URL).port);
  const settingsFile = path.join(env.HOSTTEST_USER_DATA, 'User', 'settings.json');
  const robots = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['abbRobot.robots'] || []; } catch { return null; }
  };
  const u2 = result.u2 = { port, scanList: [] };
  const baseIds = [env.HOSTTEST_ROBOT_ID, env.HOSTTEST_ROBOT_ID_2];
  u2.before = robots();

  // #1 Add Robot: the VC is picked from the scan list, the factory user is kept.
  await run('U2 addRobot', 'abbRobot.addRobot', (kind, p) => {
    if (kind === 'createQuickPick') {
      u2.scanList = p.items.filter(i => i.kind !== -1 && i.label).map(i => ({ label: i.label, description: i.description, detail: i.detail }));
      u2.pickerTitle = p.title;
      return p.items.find(i => i.action && i.action.kind === 'controller' && new RegExp(`:${port}$`).test(i.label));
    }
    if (kind === 'inputBox') {
      if (/Credentials \(1\/2\)/.test(p.title || '')) { u2.userPrefill = p.value; return p.value; }
      if (/Credentials \(2\/2\)/.test(p.title || '')) { u2.passwordPrefilled = !!p.value; return p.value; }
      if (/Display Name/.test(p.title || '')) { u2.suggestedName = p.value; return `Acceptance ${port}`; }
    }
    return undefined;
  });
  const afterAdd = robots() || [];
  const added = afterAdd.find(r => !baseIds.includes(r.id));
  u2.added = added ? { id: added.id, name: added.name, host: added.host, port: added.port, useHttps: added.useHttps, username: added.username, hasPassword: 'password' in added } : null;

  // #2 Discover Controllers (mDNS): "none found" is a valid result.
  await run('U2 discoverControllers', 'abbRobot.discoverControllers', () => undefined);

  // #3 Manage Saved Addresses and Ranges: open, cancel.
  await run('U2 manageSavedAddresses', 'abbRobot.manageSavedAddresses', () => undefined);

  // #6 Set as Active Robot with two entries, shown by the robot the Connect (active)
  // command then connects (the command's own trace line names its id); #10, #11.
  await run('U2 setActive second', 'abbRobot.setActiveRobot', null, [env.HOSTTEST_ROBOT_ID_2]);
  await run('U2 connect active (second)', 'abbRobot.connect', null);
  await sleep(4000); // the command returns before the connect has finished
  await run('U2 disconnect active (second)', 'abbRobot.disconnect', null);
  await run('U2 setActive first', 'abbRobot.setActiveRobot', null, [env.HOSTTEST_ROBOT_ID]);
  await run('U2 connect active (first)', 'abbRobot.connect', null);
  await sleep(4000);
  await run('U2 disconnect active (first)', 'abbRobot.disconnect', null);

  // #7 Configure Active Robot: cancel at the first box; nothing may change.
  const beforeConfigure = JSON.stringify(robots());
  await run('U2 configure cancel', 'abbRobot.configure', () => undefined);
  u2.configureUnchanged = JSON.stringify(robots()) === beforeConfigure;

  // #5 Remove Robot on the throwaway entry the wizard added.
  if (added) {
    await run('U2 removeRobot', 'abbRobot.removeRobot', (kind, p) =>
      (kind === 'warning' && p.modal && p.buttons.includes('Remove') ? 'Remove' : undefined), [added.id]);
  } else {
    u2.removeSkipped = 'Add Robot added no entry';
  }
  const final = robots();
  u2.after = final;
  u2.removed = !!added && Array.isArray(final) && !final.some(r => r.id === added.id);
  u2.passwordsInSettings = Array.isArray(final) ? final.filter(r => 'password' in r).map(r => r.id) : null;
  u2.ids = { first: env.HOSTTEST_ROBOT_ID, second: env.HOSTTEST_ROBOT_ID_2, added: added ? added.id : null };
  void exec;
}

// ── U3: the read commands, one controller ──
async function stepU3(ctx) {
  const { vscode, env, result, run, readerFor, setStep, sleep: nap } = ctx;
  const u3 = result.u3 = { selections: {}, errors: [], expect: {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-live-acceptance-'));
  u3.tmp = tmp;
  const sel = u3.selections;

  // What to read comes from the controller itself, through a reader session of
  // the client that is closed again before the first step.
  setStep('U3 selections');
  const reader = await readerFor();
  try {
    const rm = reader.manager;
    const tryRead = async (label, fn) => { try { return await fn(); } catch (e) { u3.errors.push(`${label}: ${e && e.message ? String(e.message).slice(0, 160) : e}`); return undefined; } };
    const t = (rm.state.tasks || []).find(x => x.active) || (rm.state.tasks || [])[0];
    sel.task = t ? t.name : 'T_ROB1';
    sel.generation = rm.state.access && rm.state.access.generation;
    const mods = await tryRead('listModulesDetailed', () => rm.listModulesDetailed(sel.task)) || [];
    sel.modules = mods.map(m => m.name);
    sel.programModule = (mods.find(m => !['BASE', 'user', 'DPUSER', 'DPBASE'].includes(m.name) && !/SysMod/i.test(m.type)) || {}).name || null;
    sel.moduleForSource = sel.programModule || (mods.find(m => m.name === 'BASE') || mods[0] || {}).name || null;
    for (const [mod, sym] of [['BASE', 'tool0'], ['BASE', 'wobj0'], ['BASE', 'load0']]) {
      const v = await tryRead(`getRapidVariable ${mod}/${sym}`, () => rm.getRapidVariable(sel.task, mod, sym));
      if (v !== undefined) { sel.symbol = { module: mod, name: sym }; break; }
    }
    const dos = await tryRead('searchSignals DO', () => rm.searchSignals({ type: 'DO' })) || [];
    sel.signalPrefix = dos.length ? dos[0].name.slice(0, Math.min(4, dos[0].name.length)) : null;
    sel.signalCount = dos.length;
    const devices = await tryRead('listAllIoDevices', () => rm.listAllIoDevices()) || [];
    sel.devicePrefix = devices.length ? devices[0].name.slice(0, Math.min(4, devices[0].name.length)) : null;
    for (const vol of ['HOME', '$HOME', 'TEMP', '$TEMP', 'BACKUP', '$BACKUP']) {
      const list = await tryRead(`listDirectory ${vol}`, () => rm.listDirectory(vol)) || [];
      // A text file: Open Controller File opens anything else through VS Code's own viewer.
      const f = list.find(e => e.type !== 'dir' && e.name && TEXT_FILE.test(e.name));
      if (f) { sel.file = { path: `${vol}/${f.name}`, name: f.name }; break; }
    }
    const domains = await tryRead('listCfgDomains', () => rm.listCfgDomains()) || [];
    sel.cfgDomain = domains.includes('SYS') ? 'SYS' : domains[0];
    if (sel.cfgDomain) {
      for (const type of (await tryRead('listCfgTypes', () => rm.listCfgTypes(sel.cfgDomain)) || [])) {
        const inst = await tryRead(`listCfgInstances ${type}`, () => rm.listCfgInstances(sel.cfgDomain, type)) || [];
        if (inst.length) { sel.cfgType = type; sel.cfgInstance = inst[0]; break; }
      }
    }
    const roster = await tryRead('listBackups', () => rm.listBackups()) || [];
    sel.backups = roster.length;
  } finally {
    await reader.close();
  }

  const expect = (name, e) => { u3.expect[name] = e; };
  const pickByLabel = label => (kind, p) => (kind === 'quickPick' ? p.items.find(i => (typeof i === 'string' ? i : i.label) === label) : undefined);
  const first = (kind, p) => (kind === 'quickPick' ? p.items[0] : undefined);
  const task = sel.task;
  const sym = sel.symbol || { module: 'BASE', name: 'tool0' };

  // #57 Refresh Event Log
  expect('U3 #57 refreshElog', { rows: ['#57'], request: '^GET /rw/elog' });
  await run('U3 #57 refreshElog', 'abbRobot.refreshElog', null);

  // #60 Export Event Log: domain 0, JSON, save to the temp folder.
  const elogFile = path.join(tmp, 'eventlog-domain0.json');
  expect('U3 #60 exportEventLog', { rows: ['#60'], file: elogFile, dialog: 'is empty', any: true });
  await run('U3 #60 exportEventLog', 'abbRobot.exportEventLog', (kind, p) => {
    if (kind === 'quickPick') {
      const wanted = /Domain 0/.test(JSON.stringify(p.items)) ? 'Domain 0 - common log' : 'JSON';
      return p.items.find(i => i.label === wanted) || p.items.find(i => i.label === 'JSON');
    }
    if (kind === 'saveDialog') { return elogFile; }
    return undefined;
  });

  // #64 Refresh File Browser, #70 List File Volumes
  // The tree re-reads only while its view is expanded; the harness has no visible view,
  // so no request is expected here.
  expect('U3 #64 refreshFiles', { rows: ['#64'], partial: 'the file tree re-reads only while its view is visible; the reads it makes are covered by #65, #66 and #70' });
  await run('U3 #64 refreshFiles', 'abbRobot.refreshFiles', null);
  // RWS 1.0 shows the controller's volumes ($HOME, $TEMP, $BACKUP), not the PC drives a VC lists.
  expect('U3 #70 listFileVolumes', { rows: ['#70'], document: sel.generation === 'rw6'
    ? '# File volumes\\s+- \\$HOME\\s+- \\$TEMP\\s+- \\$BACKUP'
    : '# File volumes[\\s\\S]*- HOME' });
  await run('U3 #70 listFileVolumes', 'abbRobot.listFileVolumes', null);

  // #65 Download File, #66 Open in Editor: one small file of HOME / TEMP / BACKUP.
  if (sel.file) {
    const node = () => ({ node: { path: sel.file.path, entry: { name: sel.file.name, type: 'file' } } });
    const dl = path.join(tmp, `download-${sel.file.name}`);
    expect('U3 #65 downloadControllerFile', { rows: ['#65'], file: dl, dialog: 'saved\\.' });
    await run('U3 #65 downloadControllerFile', 'abbRobot.downloadControllerFile', (kind) => (kind === 'saveDialog' ? dl : undefined), [node()]);
    expect('U3 #66 openControllerFile', { rows: ['#66'], document: '.' });
    await run('U3 #66 openControllerFile', 'abbRobot.openControllerFile', null, [node()]);
  } else {
    expect('U3 #65 downloadControllerFile', { rows: ['#65', '#66'], skipped: 'no file in HOME, TEMP or BACKUP to download' });
    result.steps.push({ name: 'U3 #65 downloadControllerFile', command: '(skipped)', start: new Date().toISOString(), end: new Date().toISOString(), ok: true });
  }

  // #51 Refresh I/O, #54 Search Signals, #56 Search I/O Devices
  expect('U3 #51 refreshIo', { rows: ['#51'], request: '^GET /rw/iosystem' });
  await run('U3 #51 refreshIo', 'abbRobot.refreshIo', null);
  if (sel.signalPrefix) {
    expect('U3 #54 searchSignals', { rows: ['#54'], dialog: 'signal\\(s\\) matched' });
    await run('U3 #54 searchSignals', 'abbRobot.searchSignals', (kind, p) =>
      (kind === 'inputBox' ? sel.signalPrefix : kind === 'quickPick' ? p.items.find(i => i.label === 'DO') : undefined));
  }
  if (sel.devicePrefix) {
    expect('U3 #56 searchIoDevices', { rows: ['#56'], dialog: 'signal\\(s\\) matched|No I/O devices matched' });
    await run('U3 #56 searchIoDevices', 'abbRobot.searchIoDevices', (kind, p, st) => {
      if (kind === 'inputBox' && /Search I\/O Devices/.test(p.title || '')) { return sel.devicePrefix; }
      if (kind === 'quickPick' && /Filter by logical state/.test((p.opts && p.opts.placeHolder) || '')) { return p.items.find(i => i.label === 'Any state'); }
      if (kind === 'quickPick') { return p.items[0]; }
      if (kind === 'inputBox') { return ''; }
      void st;
      return undefined;
    });
  }

  // Variables: #40 Add Watch, #45 Refresh Watches, #46 Read, #48 Properties, #49 Search, #50 Validate
  expect('U3 #40 addWatch', { rows: ['#40'], request: '^GET /rw/rapid/symbol' });
  await run('U3 #40 addWatch', 'abbRobot.addWatch', (kind, p) => {
    if (kind === 'quickPick') { return p.items.find(i => (typeof i === 'string' ? i : i.label) === task); }
    if (kind === 'inputBox' && /Module name/.test(p.prompt || '')) { return sym.module; }
    if (kind === 'inputBox') { return sym.name; }
    return undefined;
  });
  await nap(1500);
  expect('U3 #45 refreshWatches', { rows: ['#45'], request: '^GET /rw/rapid/symbol' });
  await run('U3 #45 refreshWatches', 'abbRobot.refreshWatches', null);
  await nap(1500);
  expect('U3 #46 readVariable', { rows: ['#46'], dialog: `${task}/${sym.module}/${sym.name} = ` });
  await run('U3 #46 readVariable', 'abbRobot.readVariable', (kind, p) =>
    (kind === 'inputBox' ? ({ Task: task, Module: sym.module, 'Symbol name': sym.name })[p.prompt] : undefined));
  expect('U3 #48 readSymbolProperties', { rows: ['#48'], dialog: sym.name });
  await run('U3 #48 readSymbolProperties', 'abbRobot.readSymbolProperties', (kind, p) =>
    (kind === 'inputBox' ? ({ Task: task, Module: sym.module, 'Symbol name': sym.name })[p.prompt] : undefined));
  expect('U3 #49 searchSymbols', { rows: ['#49'], document: 'symbols in', dialog: 'No symbols in', any: true });
  await run('U3 #49 searchSymbols', 'abbRobot.searchSymbols', (kind, p) =>
    (kind === 'inputBox' ? task : kind === 'quickPick' ? p.items[0] : undefined));
  expect('U3 #50 validateRapidValue', { rows: ['#50'], dialog: 'Valid num literal' });
  await run('U3 #50 validateRapidValue', 'abbRobot.validateRapidValue', (kind, p) =>
    (kind === 'inputBox' ? (/datatype/i.test(p.prompt || '') ? 'num' : '123') : undefined));

  // #39 PP show, #83 #84 #85 motion shows, #88 FK, #89 IK, #96 RMMP status, #107 system, #108 clock
  expect('U3 #39 showProgramPointer', { rows: ['#39'], dialog: '.' });
  await run('U3 #39 showProgramPointer', 'abbRobot.showProgramPointer', null);
  expect('U3 #83 showMotionInfo', { rows: ['#83'], dialog: '.' });
  await run('U3 #83 showMotionInfo', 'abbRobot.showMotionInfo', null);
  expect('U3 #84 showActiveToolWobj', { rows: ['#84'], dialog: '.' });
  await run('U3 #84 showActiveToolWobj', 'abbRobot.showActiveToolWobj', null);
  expect('U3 #85 showMechunitDetails', { rows: ['#85'], document: '.' });
  await run('U3 #85 showMechunitDetails', 'abbRobot.showMechunitDetails', null);
  expect('U3 #88 calcFK', { rows: ['#88'], document: 'FK result' });
  await run('U3 #88 calcFK', 'abbRobot.calcFK', (kind) => (kind === 'inputBox' ? '0, 0, 0, 0, 30, 0' : undefined));
  expect('U3 #89 calcIK', { rows: ['#89'], dialog: 'IK Result' });
  await run('U3 #89 calcIK', 'abbRobot.calcIK', (kind, p) => (kind === 'inputBox' ? p.value : undefined));
  expect('U3 #96 showRmmpStatus', { rows: ['#96'], dialog: 'RMMP' });
  await run('U3 #96 showRmmpStatus', 'abbRobot.showRmmpStatus', null);
  expect('U3 #107 showSystemDetails', { rows: ['#107'], document: '.' });
  await run('U3 #107 showSystemDetails', 'abbRobot.showSystemDetails', null);
  // The value is shown as the controller gave it and is not called UTC: a VC answers the PC's local time.
  expect('U3 #108 getControllerClock', { rows: ['#108'], dialog: '^Controller clock: \\d{4}-\\d\\d-\\d\\d T \\d\\d:\\d\\d:\\d\\d\\nABB documents the value as UTC; a virtual controller answers' });
  await run('U3 #108 getControllerClock', 'abbRobot.getControllerClock', null);

  // #72 Browse CFG
  if (sel.cfgDomain && sel.cfgType) {
    expect('U3 #72 browseCfg', { rows: ['#72'], document: '.' });
    await run('U3 #72 browseCfg', 'abbRobot.browseCfg', (kind, p) => {
      if (kind !== 'quickPick') { return undefined; }
      const want = /domain/i.test(p.opts.title || '') && !/type|instance/i.test(p.opts.title || '') ? sel.cfgDomain
        : /type/i.test(p.opts.title || '') ? sel.cfgType : sel.cfgInstance;
      return p.items.find(i => (typeof i === 'string' ? i : i.label) === want) || p.items[0];
    });
  }

  // RAPID sync reads: #13 Pull All Modules (into the temp folder), #15 Diff, #16 Open Source, #17 View Text, #18 Download Module
  const pullDir = path.join(tmp, 'pull');
  fs.mkdirSync(pullDir);
  expect('U3 #13 pullAllModules', { rows: ['#13'], dialog: 'Pulled \\d+/\\d+ modules|No program modules loaded', dir: pullDir });
  await run('U3 #13 pullAllModules', 'abbRobot.pullAllModules', (kind, p) => {
    if (kind === 'quickPick') { return p.items.find(i => i.label === 'Pick a different folder…'); }
    if (kind === 'openDialog') { return pullDir; }
    if (kind === 'warning' && p.modal && p.buttons.includes('Pull')) { return 'Pull'; }
    return undefined;
  });
  const mod = sel.moduleForSource;
  if (mod) {
    const local = path.join(tmp, `${mod}.mod`);
    fs.writeFileSync(local, `MODULE ${mod}\nENDMODULE\n`);
    expect('U3 #15 diffWithController', { rows: ['#15'], command: 'vscode.diff' });
    await run('U3 #15 diffWithController', 'abbRobot.diffWithController', null, [vscode.Uri.file(local)]);
    expect('U3 #16 openModuleSource', { rows: ['#16'], document: '.' });
    await run('U3 #16 openModuleSource', 'abbRobot.openModuleSource', (kind, p) =>
      (kind === 'info' && /already exists/.test(p.text) ? 'Overwrite with Controller Version' : undefined), [mod, task]);
    expect('U3 #17 viewModuleText', { rows: ['#17'], document: '.' });
    await run('U3 #17 viewModuleText', 'abbRobot.viewModuleText', (kind, p) =>
      (kind === 'info' && /already exists/.test(p.text) ? 'Overwrite with Controller Version' : undefined), [mod, task]);
    const dlm = path.join(tmp, `download-${mod}.mod`);
    // Download Module saves the loaded module's text (the read View Module Text uses), system modules included.
    expect('U3 #18 downloadModule', { rows: ['#18'], file: dlm, fileText: `MODULE\\s+${mod}\\b`, dialog: 'saved\\.' });
    await run('U3 #18 downloadModule', 'abbRobot.downloadModule', (kind) => (kind === 'saveDialog' ? dlm : undefined), [mod]);
  } else {
    expect('U3 #15 diffWithController', { rows: ['#15', '#16', '#17', '#18'], skipped: 'the controller lists no module to read' });
  }

  // #62 List Backups
  expect('U3 #62 listBackups', { rows: ['#62'], dialog: 'No backups', quickPick: 'backup\\(s\\)', any: true });
  await run('U3 #62 listBackups', 'abbRobot.listBackups', () => undefined);

  // #12 Refresh
  expect('U3 #12 refresh', { rows: ['#12'], request: '^GET /rw/' });
  await run('U3 #12 refresh', 'abbRobot.refresh', null);
  await nap(1500);
}

// After the generic disconnect step (#9): the controller answers with fresh
// credentials, and no RAPID Live session is left (RobotWare 6/7: nobody holds
// RAPID mastership; RobotWare 8: write access is not held by this extension's
// station, which registers as "abb-rws-client").
async function stepU3After(ctx) {
  const { result, readerFor, getSystem, env, setStep } = ctx;
  setStep('U3 after disconnect');
  const after = result.u3after = {};
  after.systemStatus = await getSystem(env.HOSTTEST_BASE_URL, env.HOSTTEST_USER, env.HOSTTEST_PASS);
  let reader;
  try {
    reader = await readerFor();
    const rm = reader.manager;
    const gen = rm.state.access && rm.state.access.generation;
    after.generation = gen;
    if (gen === 'rw8') {
      const w = await rm.getWriteAccessStatus();
      after.writeAccess = { held: w.held, heldByMe: w.heldByMe, heldByName: w.heldByName };
    } else {
      const m = await rm.getMastershipStatus('rapid');
      after.mastership = m ? { mastership: m.mastership, application: m.application || null, uid: m.uid ? 'present' : null } : null;
    }
  } catch (e) {
    after.error = e && e.message ? String(e.message).slice(0, 200) : String(e);
  } finally {
    if (reader) { await reader.close(); }
  }
}

module.exports = { stepU1, stepU2, stepU3, stepU3After, SAMPLE_MOD, COMPLETION_MOD };
