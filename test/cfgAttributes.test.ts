import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writableAttributes } from '../src/cfgAttributes';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

describe('CFG attributes sent to the controller', () => {
  it('leaves out the keys a read returns as metadata, whatever their case', () => {
    const r = writableAttributes({ Name: 'ZZ_X', Label: 'a', rdonly: 'false', instanceid: '1143517132', RdOnly: 'true' });
    assert.deepEqual(r.attrs, { Name: 'ZZ_X', Label: 'a' });
    assert.deepEqual(r.removed.sort(), ['RdOnly', 'instanceid', 'rdonly']);
  });

  it('turns every value into text, as the form needs', () => {
    assert.deepEqual(writableAttributes({ Size: 23, Invert: false }).attrs, { Size: '23', Invert: 'false' });
  });

  it('changes nothing when there is nothing to remove', () => {
    const r = writableAttributes({ Name: 'x' });
    assert.deepEqual(r.attrs, { Name: 'x' });
    assert.deepEqual(r.removed, []);
  });

  it('both Create and Edit CFG Instance use it', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const create = src.slice(src.indexOf("tracedCommand('abbRobot.createCfgInstance'"), src.indexOf("tracedCommand('abbRobot.removeCfgInstance'"));
    assert.ok(create.includes('writableAttributes('));
    const save = src.slice(src.indexOf('vscode.workspace.onDidSaveTextDocument('), src.indexOf('onDidCloseTextDocument'));
    assert.ok(save.includes('writableAttributes('));
    assert.doesNotMatch(save, /k === 'rdonly'/);
  });
});
