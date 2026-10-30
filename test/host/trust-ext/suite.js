// Runs inside the VS Code extension host (--extensionTestsPath), in a Restricted
// Mode window: is RAPID Live there, active, with its commands registered?
'use strict';
const vscode = require('vscode');
const fs = require('node:fs');

const EXT_ID = 'merajsafari.abb-rws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.run = async function run() {
  const result = { trusted: vscode.workspace.isTrusted, extensionFound: false, active: false, activationError: null, abbCommands: 0, sample: [] };
  try {
    // Give the host a moment to settle which extensions it enabled.
    await sleep(3000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    result.extensionFound = !!ext;
    if (ext) {
      result.version = ext.packageJSON.version;
      result.capabilities = ext.packageJSON.capabilities || null;
      try { await ext.activate(); result.active = ext.isActive; }
      catch (e) { result.activationError = e && e.message ? e.message : String(e); }
    }
    const commands = await vscode.commands.getCommands(true);
    const abb = commands.filter(c => c.startsWith('abbRobot.'));
    result.abbCommands = abb.length;
    result.sample = abb.slice(0, 5);
    // A read command that needs no robot: does it run, or does VS Code refuse it?
    try { await vscode.commands.executeCommand('abbRobot.showLogs'); result.showLogs = 'ran'; }
    catch (e) { result.showLogs = `refused: ${e && e.message ? e.message : String(e)}`; }
  } catch (e) {
    result.fatal = e && e.stack ? e.stack : String(e);
  }
  fs.writeFileSync(process.env.TRUSTCHECK_OUT, JSON.stringify(result, null, 2));
};
