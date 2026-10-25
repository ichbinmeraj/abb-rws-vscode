import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveModuleText, MODULE_SAVE_LABEL, moduleSaveName, type ModuleTextReader } from '../src/moduleDownload';

describe('Download Module to File', () => {
  it('saves the text of the loaded module, read the way View Module Text reads it', async () => {
    const calls: Array<[string, string]> = [];
    const reader: ModuleTextReader = {
      async getModuleText(task, module) { calls.push([task, module]); return { text: 'MODULE BASE\nENDMODULE\n', changeCount: 7 }; },
    };
    let written = '';
    const n = await saveModuleText(reader, 'T_ROB1', 'BASE', text => { written = text; });
    assert.deepEqual(calls, [['T_ROB1', 'BASE']]);
    assert.equal(written, 'MODULE BASE\nENDMODULE\n');
    assert.equal(n, written.length);
  });

  it('writes nothing when the read fails, and passes the controller\'s error on', async () => {
    const reader: ModuleTextReader = { async getModuleText() { throw new Error('HTTP 404 from GET /rw/rapid/tasks/T_ROB1/modules/NOPE'); } };
    let wrote = false;
    await assert.rejects(saveModuleText(reader, 'T_ROB1', 'NOPE', () => { wrote = true; }), /HTTP 404.*NOPE/);
    assert.equal(wrote, false);
  });

  it('names the file after the module and does not send the file-path advice', () => {
    assert.equal(moduleSaveName('BASE'), 'BASE.mod');
    // The label reaches friendlyErrorMessage: a 404 there must not read as a bad parent directory.
    assert.doesNotMatch(MODULE_SAVE_LABEL, /parent|directory/i);
    assert.doesNotMatch(MODULE_SAVE_LABEL, /module/i); // the isWriteOp heuristic keys on 'module'
  });
});

describe('Download Module to File wiring', () => {
  it('the command in extension.ts goes through saveModuleText and never reads a $HOME file', () => {
    const src = fs.readFileSync(path.join(path.resolve(__dirname, '..', '..'), 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.downloadModule'");
    const body = src.slice(start, src.indexOf('// ─── Controller ───', start));
    assert.ok(body.includes('saveModuleText('));
    assert.ok(!body.includes('manager.downloadModule'));
  });
});
