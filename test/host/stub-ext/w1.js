// W1: every write command against the stub controller (test/host/stub-rws.js),
// which answers as a real controller (HOSTTEST_STUB=real) or as one that does
// not say what it is (none). RAPID Live is then watch-only on it: the step runs
// each write command with every dialog answered and every box filled, and the
// verdicts check that no POST, PUT or DELETE reached the stub, that the
// refusals named the robot, and that no write trace line was logged.
//
// Runs inside the VS Code extension host, called from suite.js; never with the
// write steps A-I, and never against a controller.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { SAMPLE_MOD } = require('./acceptance.js');

/**
 * The commands that write to a controller (their handlers reach a send
 * wrapper), in the order they run. Set Robot Mode is left out on purpose: it
 * is not a controller write, and confirming it would switch the robot out of
 * Watch only. test/hostStub.test.ts keeps this list equal to the source.
 */
const WRITE_COMMANDS = [
  'abbRobot.startRapid', 'abbRobot.allowMotionControl', 'abbRobot.withdrawMotionControl', 'abbRobot.stopRapid',
  'abbRobot.resetRapid', 'abbRobot.ppToMain', 'abbRobot.setExecutionCycle', 'abbRobot.motorsOn', 'abbRobot.motorsOff',
  'abbRobot.setSpeedRatio', 'abbRobot.simEStop', 'abbRobot.simResetEStop', 'abbRobot.simGeneralStop', 'abbRobot.simAutoStop',
  'abbRobot.simEnableSwitch', 'abbRobot.teleportRobot', 'abbRobot.jog', 'abbRobot.showVirtualTime', 'abbRobot.lockOpMode',
  'abbRobot.unlockOpMode', 'abbRobot.setOpMode', 'abbRobot.writeVariable', 'abbRobot.getUiInstruction', 'abbRobot.restoreModule',
  'abbRobot.uploadModule', 'abbRobot.setPPFromCodeLens', 'abbRobot.runRoutineFromCodeLens', 'abbRobot.setPPToRoutine',
  'abbRobot.unloadModule', 'abbRobot.requestRmmp', 'abbRobot.pushCurrentFile', 'abbRobot.callServiceRoutine',
  'abbRobot.createBackup', 'abbRobot.restoreBackup', 'abbRobot.setActiveTool', 'abbRobot.setActiveWobj',
  'abbRobot.editCfgInstance', 'abbRobot.createCfgInstance', 'abbRobot.removeCfgInstance', 'abbRobot.loadCfgFile',
  'abbRobot.saveCfgFile', 'abbRobot.dipcCreateQueue', 'abbRobot.dipcSendMessage', 'abbRobot.dipcReadMessage', 'abbRobot.dipcRemoveQueue',
  'abbRobot.compressPath', 'abbRobot.writeWatchValue', 'abbRobot.activateTask', 'abbRobot.deactivateTask',
  'abbRobot.activateAllTasks', 'abbRobot.deactivateAllTasks', 'abbRobot.createRapidTask', 'abbRobot.setControllerClock',
  'abbRobot.restartController', 'abbRobot.clearEventLog', 'abbRobot.clearAllEventLogs', 'abbRobot.createDirectory',
  'abbRobot.deleteControllerFile', 'abbRobot.renameControllerFile', 'abbRobot.writeSignal', 'abbRobot.toggleSignal',
  'abbRobot.searchIoDevices',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The answers of a person who confirms everything and fills every box, except the two buttons that would leave Watch only or the robot. */
function answerAll(robotName, samplePath, folder) {
  return (kind, p) => {
    if (kind === 'warning' || kind === 'info' || kind === 'error') {
      const safe = (p.buttons || []).filter(b => !/Program and operate|^Disconnect /.test(b));
      return safe[0];
    }
    if (kind === 'inputBox') {
      const t = `${p.title || ''} ${p.prompt || ''} ${p.placeHolder || ''}`;
      if (/Type the robot's name/.test(p.prompt || '')) { return robotName; }
      if (/PIN/i.test(t)) { return '4711'; }
      if (/YYYY-MM-DD/.test(t)) { return '2026-10-30 12:00:00'; }
      if (/joint|degrees/i.test(t)) { return '0, 0, 0, 0, 0, 0'; }
      if (/0-100/.test(t)) { return '50'; }
      if (/JSON/.test(t)) { return '{"name":"x"}'; }
      if (/queue size|message size|messages/i.test(t)) { return '10'; }
      if (/\bTask\b/.test(t)) { return 'T_ROB1'; }
      if (/\bModule\b/.test(t)) { return 'user'; }
      if (/Symbol|Variable/.test(t)) { return 'reg1'; }
      if (/path|directory|Destination|archive|file/i.test(t)) { return p.value || '$HOME/zz_stub_probe'; }
      return p.value || 'zz_stub';
    }
    if (kind === 'quickPick' || kind === 'createQuickPick') { return (p.items || [])[0]; }
    if (kind === 'openDialog') { return samplePath; }
    if (kind === 'saveDialog') { return path.join(folder, 'zz_stub_save.mod'); }
    return undefined;
  };
}

/** Arguments that take a command past its own input checks, so the dialog, or the refusal, is reached. */
function argsFor(id, { vscode, robotId, samplePath }) {
  const node = { path: '$HOME/zz_stub.txt', entry: { name: 'zz_stub.txt', type: 'file' } };
  const signal = { name: 'ZZ_DO1', type: 'DO', lvalue: '0', access: 'ReadWrite' };
  switch (id) {
    case 'abbRobot.jog': return [0, 1];
    case 'abbRobot.activateTask': case 'abbRobot.deactivateTask': return ['T_ROB1'];
    case 'abbRobot.setPPToRoutine': case 'abbRobot.unloadModule': return ['user', 'T_ROB1'];
    case 'abbRobot.runRoutineFromCodeLens': case 'abbRobot.setPPFromCodeLens': return ['Acceptance_Sample', 'main', 'proc', samplePath];
    case 'abbRobot.pushCurrentFile': return [vscode.Uri.file(samplePath)];
    case 'abbRobot.writeSignal': case 'abbRobot.toggleSignal': return [{ signal }];
    case 'abbRobot.deleteControllerFile': case 'abbRobot.renameControllerFile': return [{ node }];
    case 'abbRobot.restartController': case 'abbRobot.setControllerClock': return [robotId];
    case 'abbRobot.writeWatchValue': return [{ entry: { task: 'T_ROB1', module: 'user', symbol: 'reg1', value: '1', robotId } }];
    default: return [];
  }
}

async function stepW1(ctx) {
  const { env, run, result, setStep, sleep: wait, vscode } = ctx;
  const robotId = env.HOSTTEST_ROBOT_ID;
  const robotName = env.HOSTTEST_ROBOT_NAME || 'Host test';
  const mode = env.HOSTTEST_STUB || 'real';
  const folder = env.HOSTTEST_FOLDER || process.cwd();
  const samplePath = path.join(folder, 'Acceptance_Sample.mod');
  fs.writeFileSync(samplePath, SAMPLE_MOD, 'utf8');
  result.w1 = { mode, identityRead: false, askOnce: null, commands: [] };

  // Connect. A robot with no mode record that answers as real (or does not say) is asked
  // once at the end of the connect, with no answer preselected: the real run chooses
  // Watch only, the none run dismisses the question (which leaves it watch-only too).
  await run('W1 connect', 'abbRobot.connectRobot', (kind, p) => {
    if (kind === 'warning' && p.modal && /How should RAPID Live treat/.test(p.text || '')) {
      result.w1.askOnce = { text: p.text, detail: p.detail, buttons: p.buttons, answered: mode === 'real' ? 'Watch only' : null };
      return mode === 'real' ? (p.buttons || []).find(b => b === 'Watch only') : undefined;
    }
    return undefined;
  }, [robotId]);

  // The identity is read on the client's slow refresh; the stub's log shows when.
  const logFile = env.HOSTTEST_STUB_LOG;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let text = '';
    try { text = fs.readFileSync(logFile, 'utf8'); } catch { /* not written yet */ }
    if (/"path":"\/ctrl\/identity"/.test(text)) { result.w1.identityRead = true; break; }
    await (wait || sleep)(500);
  }
  await (wait || sleep)(1500);

  const respond = answerAll(robotName, samplePath, folder);
  for (const id of WRITE_COMMANDS) {
    const s = await run(`W1 ${id}`, id, respond, argsFor(id, { vscode, robotId, samplePath }));
    result.w1.commands.push({ id, ok: s.ok, thrown: s.thrown });
  }

  setStep('W1 disconnect');
  await run('W1 disconnect', 'abbRobot.disconnectRobot', null, [robotId]);
}

module.exports = { WRITE_COMMANDS, stepW1, answerAll, argsFor };
