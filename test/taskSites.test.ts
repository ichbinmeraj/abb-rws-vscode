import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const srcDir = path.join(root, 'src');
const ext = fs.readFileSync(path.join(srcDir, 'extension.ts'), 'utf8');

/** The body of one command's handler, up to the next registered command. */
function handler(id: string): string {
  const start = ext.indexOf(`tracedCommand('${id}'`);
  assert.ok(start >= 0, `${id} is registered`);
  const next = ext.indexOf('tracedCommand(', start + 1);
  return ext.slice(start, next < 0 ? undefined : next);
}

/** A top-level function's text, up to the next top-level declaration. */
function fn(name: string): string {
  const start = ext.search(new RegExp(`\\n(async )?function ${name}\\b`));
  assert.ok(start >= 0, `${name} is declared`);
  const next = ext.slice(start + 1).search(/\n(async function|function|const|let|type|interface|export|\/\*\*) /);
  return ext.slice(start, next < 0 ? undefined : start + 1 + next);
}

/** Source without comments, so a rule can quote what it forbids. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('no first-task fallback outside the resolver', () => {
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts') && f !== 'taskResolver.ts');

  it('no source file takes the first active task', () => {
    for (const f of files) {
      const text = code(fs.readFileSync(path.join(srcDir, f), 'utf8'));
      assert.doesNotMatch(text, /tasks\s*\.find\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.active\s*\)/, `${f} takes the first active task`);
    }
  });

  it('no source file names T_ROB1 as a default', () => {
    for (const f of files) {
      const text = code(fs.readFileSync(path.join(srcDir, f), 'utf8'));
      assert.doesNotMatch(text, /['"`]T_ROB1['"`]/, `${f} names T_ROB1`);
    }
  });
});

describe('each task site goes through the resolver', () => {
  const sites: Array<[string, RegExp]> = [
    // Writes
    ['abbRobot.uploadModule', /await taskForModule\(entry, moduleOfFile\(localPath, text\), 'Load Program from File', origins\.taskOf\(localPath\)\)/],
    ['abbRobot.pushCurrentFile', /await taskForModule\(entry, moduleOfFile\(filePath, text\), 'Push Current File', origins\.taskOf\(filePath\)\)/],
    ['abbRobot.callServiceRoutine', /await taskFor\(entry, 'Call Service Routine'\)/],
    ['abbRobot.addSelectionToWatch', /await taskForModule\(entry, moduleName, 'Add Selection to Variable Watch', origins\.taskOf\(editor\.document\.fileName\)\)/],
    // Reads
    ['abbRobot.showProgramPointer', /await taskFor\(entry, 'Show Program Pointer'\)/],
    ['abbRobot.pullAllModules', /await taskFor\(entry, 'Pull All Modules'\)/],
    ['abbRobot.diffWithController', /await taskForModule\(entry, moduleOfFile\(filePath, readText\(filePath\)\), 'Diff Current File with Controller', origins\.taskOf\(filePath\)\)/],
    ['abbRobot.validateRapidValue', /await taskFor\(entry, 'Validate RAPID Value'\)/],
  ];
  for (const [id, call] of sites) {
    it(`${id} asks the resolver and sends nothing without a task`, () => {
      const body = handler(id);
      assert.match(body, call);
      assert.match(body, /if \(!taskName\) \{ return; \}|if \(!task\) \{ return; \}/);
    });
  }

  it('the watch takes its task from the resolver, and its write names the task', () => {
    assert.match(ext, /taskFor: module => taskForModule\(activeEntry\(multi\), module, 'Add Variable to Watch'\)/);
    const watch = fs.readFileSync(path.join(srcDir, 'VariableWatchProvider.ts'), 'utf8');
    assert.match(watch, /const taskName = await this\.hooks\.taskFor\(moduleName\.trim\(\)\);\s*if \(!taskName\) \{ return; \}/);
    assert.match(watch, /label: `Write \$\{row\.module\}\.\$\{row\.symbol\} in \$\{row\.task\}`/);
    assert.match(watch, /setRapidVariable\(row\.task, row\.module, row\.symbol, newValue\)/);
  });

  it('taskForModule is the rule, and every caller waits for it and stops without a task', () => {
    assert.match(fn('taskForModule'), /return taskFor\(entry, purpose, \{ module: moduleName, recorded \}\);/);
    assert.match(fn('taskFor'), /resolveTask\(taskUi, robotLabel\(confirmRobotOf\(entry\)\), entry\.manager\.state, q, purpose\)/);
    const callers: Array<[string, RegExp]> = [
      ['abbRobot.setPPFromCodeLens', /const taskName = await taskForModule\(entry, moduleName, 'Set PP', origins\.taskOf\(lensPath\)\);\s*if \(!taskName\) \{ return; \}/],
      ['abbRobot.runRoutineFromCodeLens', /const taskName = await taskForModule\(entry, moduleName, 'Run routine', origins\.taskOf\(lensPath\)\);\s*if \(!taskName\) \{ return; \}/],
      ['abbRobot.setPPToRoutine', /taskName = await taskForModule\(entry, moduleName, 'Set PP to Routine'\); \}\s*if \(!taskName\) \{ return; \}/],
      ['abbRobot.unloadModule', /taskName = await taskForModule\(entry, moduleName, 'Unload Module'\); \}\s*if \(!taskName\) \{ return; \}/],
      ['abbRobot.openModuleSource', /taskName = await taskForModule\(entry, moduleName, 'Open Loaded Module Source'\); \}\s*if \(!taskName\) \{ return; \}/],
      ['abbRobot.viewModuleText', /taskName = await taskForModule\(entry, moduleName, 'View Module Text'\); \}\s*if \(!taskName\) \{ return; \}/],
      ['abbRobot.downloadModule', /const task = taskName \?\? await taskForModule\(entry, name, 'Download Module to File'\);\s*if \(!task\) \{ return; \}/],
    ];
    for (const [id, re] of callers) { assert.match(handler(id), re, id); }
    assert.equal((ext.match(/taskForModule\(/g) ?? []).length, 1 + 1 + callers.length + 4, 'no other taskForModule call');
  });

  it('a module list without per-task lists names no task when several are active', () => {
    assert.match(fn('loadedModules'), /const task = quietTask\(state, \{\}\);/);
  });

  it('what cannot ask (hover, inlay hints, the PP marker, the Program panel) uses the quiet rule', () => {
    for (const f of ['RapidHoverProvider.ts', 'RapidInlayHintsProvider.ts', 'PpDecoration.ts', 'TabbedProgramWebviewProvider.ts']) {
      assert.match(fs.readFileSync(path.join(srcDir, f), 'utf8'), /quietTask\((this\.multi\.)?state, /, f);
    }
  });
});

describe('the program pointer after Push and Load', () => {
  it('every loadProgram call leaves the program pointer where it is', () => {
    const calls = [...ext.matchAll(/\.loadProgram\(([^\n]*)/g)].map(m => m[1]);
    assert.equal(calls.length, 4);
    for (const c of calls) { assert.match(c, /resetPP: false/, c); }
  });

  it('Push and Load never reach resetRapid but through the separate ask', () => {
    for (const id of ['abbRobot.pushCurrentFile', 'abbRobot.uploadModule', 'abbRobot.setPPFromCodeLens', 'abbRobot.runRoutineFromCodeLens']) {
      assert.doesNotMatch(handler(id), /resetRapid/, id);
    }
    for (const id of ['abbRobot.pushCurrentFile', 'abbRobot.uploadModule']) {
      assert.match(handler(id), /offerPPToMain\(entry, text \?\? '', /, id);
    }
    const offer = fn('offerPPToMain');
    assert.match(offer, /void afterLoad\(\{/);
    assert.match(offer, /confirm: request => confirm\(entry, request\)/);
    assert.match(offer, /activeTasks\(entry\.manager\.state\)\);/);
  });

  it('Pull All and a successful Push or Load record the task and text of the file', () => {
    assert.match(handler('abbRobot.pullAllModules'), /await origins\.record\(filePath\.fsPath, taskName, source, entry\.id\);/);
    assert.match(handler('abbRobot.pushCurrentFile'), /await origins\.record\(filePath, taskName, text, entry\.id\);/);
    assert.match(handler('abbRobot.uploadModule'), /await origins\.record\(localPath, taskName, text, entry\.id\);/);
  });
});

describe('messages name the robot and the task', () => {
  it('progress and success of Push, Load and Pull All', () => {
    assert.match(handler('abbRobot.pushCurrentFile'), /const where = `\$\{taskName\} on \$\{entry\.config\.name\}`;/);
    assert.match(handler('abbRobot.pushCurrentFile'), /title: `Pushing \$\{moduleName\}\$\{path\.extname\(filePath\)\} to \$\{where\}…`/);
    assert.match(handler('abbRobot.pushCurrentFile'), /`✓ Pushed \$\{moduleName\}\$\{path\.extname\(filePath\)\} to \$\{where\}\.`/);
    assert.match(handler('abbRobot.uploadModule'), /title: `Loading \$\{fileName\} into \$\{where\}…`/);
    assert.match(handler('abbRobot.uploadModule'), /`✓ \$\{fileName\} loaded into \$\{where\}\.`/);
    assert.match(handler('abbRobot.pullAllModules'), /title: `Pulling \$\{programMods\.length\} modules from \$\{where\}…`/);
  });
});
