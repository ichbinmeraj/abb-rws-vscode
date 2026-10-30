import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WEBVIEW_COMMANDS, isWebviewCommand } from '../src/webviewCommands';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const provider = fs.readFileSync(path.join(root, 'src', 'TabbedProgramWebviewProvider.ts'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string }> } };

describe('the Program view runs a fixed list of commands', () => {
  it('the list is exactly the ids the page posts through cmd(…)', () => {
    // Every id literal inside a cmd(…) call: plain, or the two of a conditional (motors, start and stop).
    const posted = [...new Set([...provider.matchAll(/\bcmd\(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/'(abbRobot\.[A-Za-z]+)'/g)].map(x => x[1])))].sort();
    assert.ok(posted.length >= 20, `${posted.length} ids posted`);
    assert.deepEqual([...WEBVIEW_COMMANDS].sort(), posted);
    assert.equal(new Set(WEBVIEW_COMMANDS).size, WEBVIEW_COMMANDS.length, 'no id twice');
  });

  it('the page posts commands through cmd(…) only, and nothing else posts a command message', () => {
    // The page's own posts (`vscode.postMessage`); the provider's posts to the page go the other way.
    const posts = [...provider.matchAll(/vscode\.postMessage\(\{ type: '([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(posts.sort(), ['command', 'expandModule']);
    assert.match(provider, /function cmd\(name, \.\.\.args\) \{\s*vscode\.postMessage\(\{ type: 'command', name, args \}\);/);
  });

  it('every id in the list is a contributed command', () => {
    const contributed = new Set(manifest.contributes.commands.map(c => c.command));
    assert.deepEqual(WEBVIEW_COMMANDS.filter(id => !contributed.has(id)), []);
  });

  it('the provider dispatches only what the list allows, and logs the rest', () => {
    assert.match(provider, /if \(msg\.type === 'command' && isWebviewCommand\(msg\.name, msg\.args\)\) \{[\s\S]*?const args: unknown\[\] = Array\.isArray\(msg\.args\) \? msg\.args : \[\];\s*void vscode\.commands\.executeCommand\(msg\.name, \.\.\.args\);/);
    assert.match(provider, /if \(msg\.type === 'command'\) \{\s*Logger\.warn\(`the Program view asked for a command it may not run: \$\{String\(msg\.name\)\}`\);/);
    assert.equal((provider.match(/executeCommand\(/g) ?? []).length, 1, 'one dispatch');
    assert.match(provider, /import \{ isWebviewCommand \} from '\.\/webviewCommands';/);
  });

  it('the routine buttons pass the row\'s task, with no file, so the handler never takes the editor\'s file for it (review finding 3)', () => {
    assert.match(provider, /cmd\('abbRobot\.runRoutineFromCodeLens', mod, name, 'proc', '', btn\.dataset\.task\)/);
    assert.match(provider, /cmd\('abbRobot\.setPPFromCodeLens',\s+mod, name, 'proc', '', btn\.dataset\.task\)/);
    assert.equal(isWebviewCommand('abbRobot.runRoutineFromCodeLens', ['MainT2', 'main', 'proc', '', 'T_ROB2']), true);
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    for (const id of ['abbRobot.setPPFromCodeLens', 'abbRobot.runRoutineFromCodeLens']) {
      const start = src.indexOf(`tracedCommand('${id}'`);
      const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
      assert.match(body, /const explicitTask = typeof taskArg === 'string' && taskArg \? taskArg : undefined;/, id);
      assert.match(body, /const lensPath = typeof lensFile === 'string' && lensFile \? lensFile : explicitTask \? undefined : vscode\.window\.activeTextEditor\?\.document\.fileName;/, id);
    }
  });

  it('allows a listed id with up to five scalar arguments', () => {
    assert.equal(isWebviewCommand('abbRobot.ppToMain', undefined), true);
    assert.equal(isWebviewCommand('abbRobot.ppToMain', []), true);
    assert.equal(isWebviewCommand('abbRobot.activateTask', ['T_ROB2']), true);
    assert.equal(isWebviewCommand('abbRobot.setPPToRoutine', ['MainT2', 'T_ROB2']), true);
    assert.equal(isWebviewCommand('abbRobot.runRoutineFromCodeLens', ['MainT2', 'main']), true);
  });

  it('refuses an unlisted id, a non-string name, too many arguments, and an object where a scalar is due', () => {
    assert.equal(isWebviewCommand('abbRobot.restartController', []), false);
    assert.equal(isWebviewCommand('workbench.action.terminal.sendSequence', [{ text: 'rm -rf' }]), false);
    assert.equal(isWebviewCommand(undefined, []), false);
    assert.equal(isWebviewCommand(42, []), false);
    assert.equal(isWebviewCommand('abbRobot.ppToMain', ['a', 'b', 'c', 'd', 'e', 'f']), false);
    assert.equal(isWebviewCommand('abbRobot.ppToMain', 'not a list'), false);
    assert.equal(isWebviewCommand('abbRobot.activateTask', [{ name: 'T_ROB2' }]), false);
    assert.equal(isWebviewCommand('abbRobot.unloadModule', ['M', null]), false);
  });

  it('the two watch-row commands take the one row object with scalar fields, and nothing else', () => {
    const row = { entry: { task: 'T_ROB1', module: 'user', symbol: 'reg1', value: '3', robotId: 'r1', lastUpdated: 1, error: undefined } };
    assert.equal(isWebviewCommand('abbRobot.writeWatchValue', [row]), true);
    assert.equal(isWebviewCommand('abbRobot.removeWatch', [row]), true);
    assert.equal(isWebviewCommand('abbRobot.writeWatchValue', []), false);
    assert.equal(isWebviewCommand('abbRobot.writeWatchValue', [row, row]), false);
    assert.equal(isWebviewCommand('abbRobot.writeWatchValue', ['T_ROB1']), false);
    assert.equal(isWebviewCommand('abbRobot.writeWatchValue', [{ entry: { task: 'T_ROB1', module: 'user' } }]), false);
    assert.equal(isWebviewCommand('abbRobot.writeWatchValue', [{ entry: { task: 'T_ROB1', module: 'user', symbol: 'reg1', nested: { a: 1 } } }]), false);
    assert.equal(isWebviewCommand('abbRobot.writeWatchValue', [{ entry: { task: 'T_ROB1', module: 'user', symbol: 'reg1' }, extra: 1 }]), false);
    assert.equal(isWebviewCommand('abbRobot.addWatch', [row]), false, 'a scalar-argument command takes no row');
  });
});
