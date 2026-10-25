import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { confirmChoice, confirmRobot, confirmWrite, heartbeatWarning, restartSideEffects, robotLabel, type ConfirmRobot, type ConfirmUi } from '../src/confirm';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

const cell: ConfirmRobot = { name: 'Cell 3', host: '10.0.5.20', port: 80, reportedName: 'Cell 3' };

/** A window double that records every dialog and answers from a script. */
function ui(answers: { modal?: (message: string, detail: string, buttons: string[]) => string | undefined; input?: (title: string, prompt: string) => string | undefined }) {
  const shown: Array<Record<string, unknown>> = [];
  const u: ConfirmUi = {
    modal: async (message, detail, buttons) => {
      shown.push({ kind: 'modal', message, detail, buttons });
      return answers.modal?.(message, detail, buttons);
    },
    input: async (title, prompt, placeHolder) => {
      shown.push({ kind: 'input', title, prompt, placeHolder });
      return answers.input?.(title, prompt);
    },
    warn: message => { shown.push({ kind: 'warn', message }); },
  };
  return { u, shown };
}

describe('robotLabel', () => {
  it('is the saved name with host and port', () => {
    assert.equal(robotLabel(cell), 'Cell 3 (10.0.5.20:80)');
  });

  it('leaves the port out when none is saved', () => {
    assert.equal(robotLabel({ name: 'Cell 3', host: '10.0.5.20' }), 'Cell 3 (10.0.5.20)');
  });

  it('adds the name the controller reports when it differs from the saved one', () => {
    assert.equal(robotLabel({ ...cell, reportedName: 'IRB1200_VC' }), "Cell 3 (10.0.5.20:80), reports itself as 'IRB1200_VC'");
    assert.equal(robotLabel({ ...cell, reportedName: null }), 'Cell 3 (10.0.5.20:80)');
    assert.equal(robotLabel({ ...cell, reportedName: undefined }), 'Cell 3 (10.0.5.20:80)');
  });
});

describe('confirmRobot', () => {
  const saved = { name: 'Cell 3', host: '10.0.0.8', port: 5466 };

  it('names the address the session is on while connected, not a saved address changed since', () => {
    // Another window changed the saved host and port; this session is still on the old controller.
    const robot = confirmRobot(saved, { connected: true, host: '10.0.0.7', port: 80 }, 'IRB1200_VC');
    assert.equal(robotLabel(robot), "Cell 3 (10.0.0.7:80), reports itself as 'IRB1200_VC'");
  });

  it('names the saved address when not connected', () => {
    assert.equal(robotLabel(confirmRobot(saved, { connected: false, host: '10.0.0.7', port: 80 }, null)), 'Cell 3 (10.0.0.8:5466)');
    assert.equal(robotLabel(confirmRobot(saved, { connected: true, host: '' }, null)), 'Cell 3 (10.0.0.8:5466)');
  });
});

describe('confirmWrite, motion tier', () => {
  const request = { label: 'Start RAPID', tier: 'motion' as const, sideEffects: ['Starts the RAPID program from the program pointer.'] };

  it('names the robot and the side effects in a modal, then asks for the typed name', async () => {
    const { u, shown } = ui({ modal: () => 'Continue', input: () => 'Cell 3' });
    assert.equal(await confirmWrite(u, { ...cell, reportedName: 'IRB1200_VC' }, request), true);
    assert.deepEqual(shown, [
      {
        kind: 'modal',
        message: "Start RAPID on Cell 3 (10.0.5.20:80), reports itself as 'IRB1200_VC'",
        detail: 'This can move the robot.\n\n• Starts the RAPID program from the program pointer.\n\n'
          + "Nothing is sent yet. Choose Continue, then type the robot's name, Cell 3, in the next box.",
        buttons: ['Continue'],
      },
      { kind: 'input', title: 'Start RAPID on Cell 3', prompt: "Type the robot's name to send it: Cell 3", placeHolder: 'Cell 3' },
    ]);
  });

  it('a cancelled modal sends nothing and asks for no name', async () => {
    const { u, shown } = ui({ modal: () => undefined, input: () => { throw new Error('not asked'); } });
    assert.equal(await confirmWrite(u, cell, request), false);
    assert.equal(shown.length, 1);
  });

  it('a dismissed name box sends nothing, quietly', async () => {
    const { u, shown } = ui({ modal: () => 'Continue', input: () => undefined });
    assert.equal(await confirmWrite(u, cell, request), false);
    assert.deepEqual(shown.map(s => s.kind), ['modal', 'input']);
  });

  it('a name that does not match sends nothing and says so', async () => {
    // '' is Enter on an empty box (host step E1 types it too); '   ' trims to it.
    for (const typed of ['Cell3', 'cell 3', 'Cell 3 ', 'Cell 4', '', '   ']) {
      const { u, shown } = ui({ modal: () => 'Continue', input: () => typed });
      const ok = await confirmWrite(u, cell, request);
      if (typed.trim() === 'Cell 3') { assert.equal(ok, true, typed); continue; }
      assert.equal(ok, false, typed);
      assert.deepEqual(shown[2], { kind: 'warn', message: `Start RAPID not sent to Cell 3: "${typed}" is not its name.` }, typed);
    }
  });

  it('matches the typed name after trimming, and is never skipped', async () => {
    const { u, shown } = ui({ modal: () => 'Continue', input: () => '  Cell 3\t' });
    assert.equal(await confirmWrite(u, cell, request), true);
    assert.equal(await confirmWrite(u, cell, request), true);
    assert.deepEqual(shown.map(s => s.kind), ['modal', 'input', 'modal', 'input']);
  });
});

describe('confirmChoice, motion tier with a second button (RobotWare 8: Allow Motion Control first…)', () => {
  const request = { label: 'Start RAPID', tier: 'motion' as const, sideEffects: ['Starts the RAPID program.'], altButton: 'Allow Motion Control first…' };

  it('offers both buttons; the second one sends nothing and asks for no name', async () => {
    const { u, shown } = ui({ modal: () => 'Allow Motion Control first…', input: () => { throw new Error('not asked'); } });
    assert.equal(await confirmChoice(u, cell, request), 'alt');
    assert.equal(await confirmWrite(u, cell, request), false);
    assert.deepEqual((shown[0] as { buttons: string[] }).buttons, ['Continue', 'Allow Motion Control first…']);
    assert.deepEqual(shown.map(s => s.kind), ['modal', 'modal']);
  });

  it('Continue still asks for the typed name', async () => {
    const { u, shown } = ui({ modal: () => 'Continue', input: () => 'Cell 3' });
    assert.equal(await confirmChoice(u, cell, request), 'confirmed');
    assert.deepEqual(shown.map(s => s.kind), ['modal', 'input']);
  });

  it('a note stands apart from what the write does, and the end says what each button does', async () => {
    const { u, shown } = ui({ modal: () => undefined });
    await confirmChoice(u, cell, {
      ...request,
      notes: ['Motion control is not allowed from this station. RobotWare 8 refuses a start or a jog without it.'],
      altHint: 'To allow motion control first, choose "Allow Motion Control first…". It asks you to confirm both stops, then this confirmation shows again.',
    });
    assert.equal((shown[0] as { detail: string }).detail, 'This can move the robot.\n\n'
      + '• Starts the RAPID program.\n\n'
      + 'Motion control is not allowed from this station. RobotWare 8 refuses a start or a jog without it.\n\n'
      + 'Nothing is sent yet. To allow motion control first, choose "Allow Motion Control first…". It asks you to confirm both stops, then this confirmation shows again. '
      + "Otherwise choose Continue, then type the robot's name, Cell 3, in the next box.");
    // A hint without its button says nothing of it.
    const { u: u2, shown: shown2 } = ui({ modal: () => undefined });
    await confirmChoice(u2, cell, { label: 'Start RAPID', tier: 'motion', sideEffects: ['Starts the RAPID program.'], altHint: 'Never shown.' });
    assert.equal((shown2[0] as { detail: string }).detail, 'This can move the robot.\n\n• Starts the RAPID program.\n\n'
      + "Nothing is sent yet. Choose Continue, then type the robot's name, Cell 3, in the next box.");
  });
});

describe('confirmWrite, declaration tier', () => {
  const confirmation = {
    title: 'Allow Motion Control on Cell 3 (10.0.5.20:80)',
    lines: ['Client line one.', 'Client line two.'],
    confirmLabel: 'Both stops are within my reach',
    typeName: true,
    typePrompt: "Type the robot's name to confirm that both stops are within your reach: Cell 3",
  };
  const request = { label: 'Allow Motion Control', tier: 'declaration' as const, sideEffects: ['RAPID Live line.'], confirmation };

  it('shows the client\'s title and lines first, then RAPID Live\'s, the client\'s button, then the client\'s name prompt', async () => {
    const { u, shown } = ui({ modal: () => 'Both stops are within my reach', input: () => 'Cell 3' });
    assert.equal(await confirmWrite(u, cell, request), true);
    assert.deepEqual(shown, [
      {
        kind: 'modal',
        message: 'Allow Motion Control on Cell 3 (10.0.5.20:80)',
        detail: 'Client line one.\n\nClient line two.\n\nRAPID Live line.\n\n'
          + 'Nothing is sent yet. Choose "Both stops are within my reach". Then type the robot\'s name, Cell 3.',
        buttons: ['Both stops are within my reach'],
      },
      { kind: 'input', title: 'Allow Motion Control on Cell 3', prompt: "Type the robot's name to confirm that both stops are within your reach: Cell 3", placeHolder: 'Cell 3' },
    ]);
  });

  it('Cancel, a dismissed box or a wrong name: nothing is confirmed', async () => {
    assert.equal(await confirmWrite(ui({ modal: () => undefined }).u, cell, request), false);
    assert.equal(await confirmWrite(ui({ modal: () => 'Both stops are within my reach', input: () => undefined }).u, cell, request), false);
    const wrong = ui({ modal: () => 'Both stops are within my reach', input: () => 'Cell 4' });
    assert.equal(await confirmWrite(wrong.u, cell, request), false);
    assert.deepEqual(wrong.shown[2], { kind: 'warn', message: 'Allow Motion Control not sent to Cell 3: "Cell 4" is not its name.' });
  });

  it('without the client\'s text or its typed name there is nothing to confirm against', async () => {
    for (const c of [undefined, { ...confirmation, typeName: false }, { ...confirmation, typePrompt: null }]) {
      const { u, shown } = ui({ modal: () => { throw new Error('not asked'); } });
      assert.equal(await confirmWrite(u, cell, { ...request, confirmation: c }), false);
      assert.deepEqual(shown, [{ kind: 'warn', message: 'Allow Motion Control not sent to Cell 3: there is no confirmation text for it.' }]);
    }
  });
});

describe('confirmWrite with no saved name', () => {
  it('refuses every tier, asks nothing, and says to give the robot a name', async () => {
    for (const tier of ['motion', 'disruptive', 'change'] as const) {
      for (const name of ['', '   ']) {
        const { u, shown } = ui({ modal: () => { throw new Error('not asked'); }, input: () => '' });
        const ok = await confirmWrite(u, { ...cell, name }, { label: 'Start RAPID', tier, sideEffects: ['x'] });
        assert.equal(ok, false, `${tier} "${name}"`);
        assert.deepEqual(shown, [{ kind: 'warn', message: 'Start RAPID not sent: this robot has no saved name. Give it a name in the Robots view (Configure), then try again.' }]);
      }
    }
  });
});

describe('confirmWrite, disruptive tier', () => {
  const request = {
    label: 'Restart', tier: 'disruptive' as const,
    sideEffects: ['RAPID stops and the controller restarts.', 'The connection drops until it is back.'],
  };

  it('lists the side effects and offers one button naming the robot', async () => {
    const { u, shown } = ui({ modal: (_m, _d, buttons) => buttons[0] });
    assert.equal(await confirmWrite(u, cell, request), true);
    assert.deepEqual(shown, [{
      kind: 'modal',
      message: 'Restart on Cell 3 (10.0.5.20:80)',
      detail: '• RAPID stops and the controller restarts.\n• The connection drops until it is back.',
      buttons: ['Continue on Cell 3'],
    }]);
  });

  it('a dismissed modal sends nothing', async () => {
    const { u } = ui({ modal: () => undefined });
    assert.equal(await confirmWrite(u, cell, request), false);
  });
});

describe('confirmWrite, change tier', () => {
  const request = { label: 'Toggle signal', tier: 'change' as const, sideEffects: ['DO_1 changes from 0 to 1.'] };

  it('is one acknowledgement naming the robot', async () => {
    const { u, shown } = ui({ modal: (_m, _d, buttons) => buttons[0] });
    assert.equal(await confirmWrite(u, cell, request), true);
    assert.deepEqual(shown, [{
      kind: 'modal',
      message: 'Toggle signal on Cell 3 (10.0.5.20:80)',
      detail: '• DO_1 changes from 0 to 1.',
      buttons: ['Write to Cell 3'],
    }]);
  });

  it('a dismissed modal sends nothing', async () => {
    const { u } = ui({ modal: () => undefined });
    assert.equal(await confirmWrite(u, cell, request), false);
  });
});

describe('the write commands in extension.ts', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  /** The source of one tracedCommand handler. */
  const handler = (id: string): string => {
    const start = src.indexOf(`tracedCommand('${id}'`);
    assert.ok(start >= 0, id);
    const end = src.indexOf('tracedCommand(', start + 1);
    return src.slice(start, end < 0 ? src.length : end);
  };
  const tiers: Record<string, 'motion' | 'disruptive' | 'change'> = {
    'abbRobot.startRapid': 'motion',
    'abbRobot.runRoutineFromCodeLens': 'motion',
    'abbRobot.motorsOn': 'motion',
    'abbRobot.getUiInstruction': 'motion',
    'abbRobot.jog': 'motion',
    'abbRobot.lockOpMode': 'disruptive',
    'abbRobot.unlockOpMode': 'disruptive',
    'abbRobot.loadCfgFile': 'disruptive',
    'abbRobot.removeCfgInstance': 'disruptive',
    'abbRobot.restartController': 'disruptive',
    'abbRobot.restoreBackup': 'disruptive',
    'abbRobot.clearEventLog': 'disruptive',
    'abbRobot.clearAllEventLogs': 'disruptive',
    'abbRobot.deleteControllerFile': 'disruptive',
    'abbRobot.toggleSignal': 'change',
    'abbRobot.writeSignal': 'change',
  };

  it('each one asks through confirmWrite with its tier and resolves its robot entry once at the top', () => {
    for (const [id, tier] of Object.entries(tiers)) {
      const body = handler(id);
      // Start RAPID, Run Routine and Jog ask through confirmMotion: on RobotWare 8 it adds the motion-control line.
      assert.match(body, new RegExp(`confirm(Motion)?\\(entry, \\{[\\s\\S]*?tier: '${tier}'`), `${id}: ${tier}`);
      assert.match(body, /const entry = (activeEntry\(multi\)|entryOf\(multi, arg\));/, `${id}: resolves its entry`);
      assert.doesNotMatch(body, /mgr\(multi\)|multi\.active\b/, `${id}: uses entry.manager, never the active robot at send time`);
    }
  });

  it('the CFG write-back on save asks with the change tier on the robot the instance was opened from', () => {
    const start = src.indexOf('vscode.workspace.onDidSaveTextDocument(');
    const body = src.slice(start, src.indexOf('onDidCloseTextDocument', start));
    assert.match(body, /confirm\(entry, \{[\s\S]*?tier: 'change'/);
    assert.match(body, /entry\.manager\.setCfgInstance\(/);
  });

  it('Run routine asks once for everything it does; the motors offer is folded into that confirmation', () => {
    const body = handler('abbRobot.runRoutineFromCodeLens');
    assert.equal((body.match(/confirm(Motion)?\(entry/g) ?? []).length, 1);
    assert.match(body, /confirmMotion\(entry, \{/);
    assert.doesNotMatch(body, /Turn motors ON before starting/);
  });

  it('Run routine lists the motors and a possible unload in its dialog, and does nothing the dialog did not list', () => {
    const body = handler('abbRobot.runRoutineFromCodeLens');
    assert.ok(body.includes('modulesWithMain(active, taskName)'));
    assert.ok(body.includes("Unloads ${mainHolders.join(' or ')} if the controller refuses"));
    assert.ok(body.includes('tryResolveMainCollision(active, taskName, moduleName, e, entry, mainHolders)'));
    assert.ok(body.includes('if (needsMotors) {'));
    assert.ok(!body.includes("opmode === 'AUTO' && active.state.ctrlstate !== 'motoron') {"));
  });

  it('jog asks once per robot and connection, never through a module-global flag', () => {
    assert.doesNotMatch(src, /let jogConfirmed\b/);
    assert.match(src, /jogConfirmed = new Map</);
  });

  it('offers no Stop Jog: one click is one jog step, so there is no jog in progress to stop', () => {
    const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const motion = fs.readFileSync(path.join(root, 'src', 'MotionTreeProvider.ts'), 'utf8');
    assert.ok(!src.includes('abbRobot.jogStop'));
    assert.ok(!manifest.includes('abbRobot.jogStop'));
    assert.ok(!motion.includes('abbRobot.jogStop'));
    assert.match(motion, /JOG_STEP_TOOLTIP/);
  });

  it('Restore Backup says the backup is kept, and never asks the client to delete it', () => {
    const body = handler('abbRobot.restoreBackup');
    assert.ok(body.includes("'Keeps the backup on the controller: the restore asks the controller not to delete it.'"));
    // The vendored client sends ABB's delete-dir as false unless deleteBackup is asked for.
    assert.match(body, /entry\.manager\.restoreBackup\(name\);/);
    assert.doesNotMatch(body, /deleteBackup/);
  });

  it('the one-click toggle in the I/O tree goes through the toggle command, which asks', () => {
    const io = fs.readFileSync(path.join(root, 'src', 'IoTreeProvider.ts'), 'utf8');
    assert.match(io, /command: 'abbRobot\.toggleSignal'/);
    assert.doesNotMatch(io, /writeIoSignal\(/);
  });
});

describe('heartbeatWarning', () => {
  it('warns on RobotWare 8 when the HeartBeat is enforced, with the timeout when it is known', () => {
    assert.equal(heartbeatWarning({ generation: 'rw8', watchdog: { enforced: true, timeoutMs: 2000 } }),
      'The controller requires the station that holds write access to send a periodic heartbeat while RAPID runs. RobotWare 8 offers no RWS way to send it, so RAPID may stop after 2000 ms.');
    assert.equal(heartbeatWarning({ generation: 'rw8', watchdog: { enforced: true, timeoutMs: null } }),
      'The controller requires the station that holds write access to send a periodic heartbeat while RAPID runs. RobotWare 8 offers no RWS way to send it, so RAPID may stop after the HeartBeat timeout.');
  });

  it('says nothing when it is not enforced, not read, or not RobotWare 8', () => {
    assert.equal(heartbeatWarning({ generation: 'rw8', watchdog: { enforced: false, timeoutMs: 2000 } }), undefined);
    assert.equal(heartbeatWarning({ generation: 'rw8', watchdog: { enforced: null, timeoutMs: null } }), undefined);
    assert.equal(heartbeatWarning({ generation: 'rw8', watchdog: null }), undefined);
    assert.equal(heartbeatWarning({ generation: 'rw7', watchdog: { enforced: true, timeoutMs: 2000 } }), undefined);
    assert.equal(heartbeatWarning(undefined), undefined);
  });

  it('Start RAPID and Run routine add it to their confirmation', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    for (const id of ['abbRobot.startRapid', 'abbRobot.runRoutineFromCodeLens']) {
      const start = src.indexOf(`tracedCommand('${id}'`);
      const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
      assert.ok(body.includes('...heartbeatSideEffects(entry)'), id);
    }
    assert.ok(src.includes('heartbeatWarning(entry.manager.state.access)'));
  });
});

describe('restart side effects', () => {
  it('say what each mode does to programs and configuration', () => {
    const text = (m: 'restart' | 'pstart' | 'istart' | 'bstart') => restartSideEffects(m).join(' ');
    assert.match(text('restart'), /programs and configuration are kept/);
    assert.match(text('pstart'), /removes the modules and programs loaded by hand/);
    assert.match(text('pstart'), /System parameters are not affected/);
    assert.match(text('istart'), /original installation/);
    assert.match(text('istart'), /programs and configuration are lost/);
    assert.match(text('bstart'), /last auto-saved state/);
    for (const m of ['restart', 'pstart', 'istart', 'bstart'] as const) {
      assert.match(text(m), /RAPID stops; the connection drops until the controller is back\./);
    }
  });

  it('the Restart command builds its list from them; the jog confirmation is the shared wording; the module note only on refusals', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.ok(src.includes('sideEffects: restartSideEffects(choice.value)'));
    assert.ok(src.includes('sideEffects: jogConfirmEffects(inc)'));
    const start = src.indexOf("tracedCommand('abbRobot.openModuleSource'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.ok(body.includes("showError('Open module source', e, entry, refusalOf(e)"));
  });
});

describe('handlers resolve their robot once', () => {
  it('no command handler reads the multi-robot manager state or active robot; each uses its entry', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const offenders: string[] = [];
    let id = '';
    let body: string[] = [];
    const flush = () => {
      if (!id) { return; }
      const text = body.join('\n');
      // Connect and Disconnect take the row's id from their argument first and fall back to the active id.
      const argFirst = id === 'abbRobot.connectRobot' || id === 'abbRobot.disconnectRobot';
      if (/multi\.(state|active|activeId)\b/.test(text) && !(argFirst && /extractRobotId\(arg\) \?\? multi\.activeId/.test(text))) { offenders.push(id); }
      else if (/entry\./.test(text) && !/const entry = (activeEntry\(multi\)|entryOf\(multi, arg\));/.test(text)) { offenders.push(`${id} (no entry)`); }
    };
    for (const line of src.split('\n')) {
      const m = /^    tracedCommand\('([^']+)'/.exec(line);
      if (m) { flush(); id = m[1]; body = [line]; }
      else if (id) { body.push(line); }
      if (id && /^    \}\),?$/.test(line)) { flush(); id = ''; body = []; }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('Edit Watched Value is bound to the row\'s robot', () => {
  const provider = fs.readFileSync(path.join(root, 'src', 'VariableWatchProvider.ts'), 'utf8');
  const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const body = (src: string, start: string, end: string): string => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start) + 1));

  it('the poll records the robot each value was read from, and the write goes to that robot', () => {
    assert.ok(provider.includes('robotId?: string'));
    assert.ok(body(provider, 'private async poll()', 'private async persist()').includes('w.robotId = entry.id'));
    const write = body(provider, 'async writeValue(', 'private async poll()');
    assert.ok(write.includes('this.hooks.confirm(target'));
    assert.ok(write.includes('target.manager.setRapidVariable('));
    assert.doesNotMatch(write, /this\.manager\.active(?![A-Za-z])/);
  });

  it('the extension hands the provider its confirmation and its bound error dialog', () => {
    assert.ok(ext.includes('new VariableWatchProvider(multi, context, { confirm, showError })'));
  });
});

describe('error dialogs in the write handlers', () => {
  it('every showError in a confirming handler passes the entry, so the dialog is bound to that robot', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf('context.subscriptions.push(');
    const body = src.slice(start);
    const unbound = [...body.matchAll(/showError\(([^;]*?), (e2?)\);/g)].map(m => m[0]);
    assert.deepEqual(unbound, []);
  });
});
