// Workspace trust check: what VS Code does with RAPID Live in a Restricted Mode
// workspace (design 6.10). Starts a real VS Code with a fresh profile, the local
// .vsix installed, a folder that is NOT trusted (the trust prompt is turned off,
// so the window opens in Restricted Mode), and a tiny probe extension
// (test/host/trust-ext) that declares support for untrusted workspaces and
// reports whether RAPID Live is active there and which of its commands are
// registered. Prints the result as JSON and writes it to test/host/last-trust.json.
//
//   node test/host/trust-check.js          (npm run package first; VSCODE_EXE as in run-commands.test.js)
//
// Nothing connects to a controller: no robot is saved in the profile.

'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

function vscodePaths() {
  if (process.env.VSCODE_EXE) {
    const exe = process.env.VSCODE_EXE;
    const beside = path.join(path.dirname(exe), 'bin', process.platform === 'win32' ? 'code.cmd' : 'code');
    return { exe, cli: process.env.VSCODE_CLI || (process.platform === 'win32' || fs.existsSync(beside) ? beside : 'code') };
  }
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code');
    return { exe: path.join(dir, 'Code.exe'), cli: path.join(dir, 'bin', 'code.cmd') };
  }
  return { exe: 'code', cli: 'code' };
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_') || k === 'ELECTRON_NO_ATTACH_CONSOLE') { delete env[k]; }
  }
  return env;
}

async function main() {
  const { exe, cli } = vscodePaths();
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const vsix = process.env.RWS_TEST_VSIX || path.join(REPO, `abb-rws-${version}.vsix`);
  if (!fs.existsSync(vsix)) { throw new Error(`${vsix} not found: run npm run package first`); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-live-trust-'));
  const userData = path.join(work, 'user');
  const extDir = path.join(work, 'ext');
  const folder = path.join(work, 'ws');
  const out = path.join(work, 'result.json');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.mkdirSync(extDir); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'Sample.mod'), 'MODULE Sample\n  PROC main()\n  ENDPROC\nENDMODULE\n');
  try {
    const inst = spawnSync(`"${cli}"`, ['--extensions-dir', `"${extDir}"`, '--user-data-dir', `"${userData}"`, '--install-extension', `"${vsix}"`],
      { shell: true, env: childEnv(), encoding: 'utf8', timeout: 180000 });
    if (inst.status !== 0) { throw new Error(`install failed: ${inst.stdout}${inst.stderr}`); }
    // Workspace trust on, no prompt: an unknown folder opens in Restricted Mode.
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.enabled': true,
      'security.workspace.trust.startupPrompt': 'never',
      'security.workspace.trust.untrustedFiles': 'open',
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
      'workbench.startupEditor': 'none',
    }, null, 2));
    const args = [folder,
      `--extensionDevelopmentPath=${path.join(__dirname, 'trust-ext')}`,
      `--extensionTestsPath=${path.join(__dirname, 'trust-ext', 'suite.js')}`,
      `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`,
      '--skip-welcome', '--skip-release-notes', '--new-window',
      ...String(process.env.RWS_TEST_VSCODE_ARGS || '').split(/\s+/).filter(Boolean)];
    let output = '';
    const code = await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { env: childEnv({ TRUSTCHECK_OUT: out }), stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => { output += d; });
      child.stderr.on('data', d => { output += d; });
      child.on('error', reject);
      child.on('exit', c => resolve(c));
    });
    if (!fs.existsSync(out)) { throw new Error(`the host wrote no result (exit ${code}); its output ended:\n${output.slice(-3000)}`); }
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    result.vsix = path.basename(vsix);
    result.checkedAt = new Date().toISOString();
    fs.writeFileSync(path.join(__dirname, 'last-trust.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
