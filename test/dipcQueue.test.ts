import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dipcCountPrompt, dipcSizePrompt, validateDipcCount, validateDipcSize } from '../src/dipcQueue';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

describe('DIPC: Create Queue prompts (ABB: queue size required 1-32767; message size 1-448, required on RWS 1.0 at 1-444)', () => {
  it('the queue size box is required and bounded', () => {
    assert.match(dipcCountPrompt(), /required/);
    assert.match(dipcCountPrompt(), /1 to 32767/);
    assert.equal(validateDipcCount(''), 'Required: the controller refuses a queue without a size');
    assert.equal(validateDipcCount('0'), 'A whole number from 1 to 32767');
    assert.equal(validateDipcCount('32768'), 'A whole number from 1 to 32767');
    assert.equal(validateDipcCount('abc'), 'A whole number from 1 to 32767');
    assert.equal(validateDipcCount('5'), undefined);
    assert.equal(validateDipcCount('32767'), undefined);
  });

  it('the message size is optional on RobotWare 7 and 8, required on RobotWare 6, with its own limit', () => {
    assert.match(dipcSizePrompt('rw7'), /optional/);
    assert.match(dipcSizePrompt('rw8'), /1 to 448/);
    assert.match(dipcSizePrompt('rw6'), /required/);
    assert.match(dipcSizePrompt('rw6'), /1 to 444/);
    assert.equal(validateDipcSize('', 'rw7'), undefined);
    assert.equal(validateDipcSize('', 'rw8'), undefined);
    assert.equal(validateDipcSize('', 'rw6'), 'Required on RobotWare 6');
    assert.equal(validateDipcSize('449', 'rw7'), 'A whole number from 1 to 448');
    assert.equal(validateDipcSize('445', 'rw6'), 'A whole number from 1 to 444');
    assert.equal(validateDipcSize('128', 'rw6'), undefined);
    assert.equal(validateDipcSize('0', 'rw7'), 'A whole number from 1 to 448');
  });

  it('the command uses them and no longer marks the size boxes "(optional)"', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf("tracedCommand('abbRobot.dipcCreateQueue'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.ok(body.includes('dipcCountPrompt()'));
    assert.ok(body.includes('dipcSizePrompt('));
    assert.ok(body.includes('validateInput: validateDipcCount'));
    assert.doesNotMatch(body, /Max messages \(optional\)/);
  });
});

import { dipcMessageText } from '../src/dipcQueue';

describe('DIPC: Read Message text', () => {
  it('shows a data type when the controller returns one', () => {
    assert.equal(dipcMessageText({ payload: '42', type: 'num' }), 'Message: 42 (num)');
  });

  it('does not present the controller\'s message kind as the data type', () => {
    const t = dipcMessageText({ payload: 'hello', type: 'IPC_SEND' });
    assert.match(t, /^Message: hello /);
    assert.match(t, /message kind IPC_SEND/);
    assert.match(t, /does not return the data type/);
    assert.doesNotMatch(t, /\(IPC_SEND\)/);
  });

  it('says there is no message when the read timed out', () => {
    assert.equal(dipcMessageText(null), 'No message (timed out)');
  });

  it('the command uses it', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.ok(src.includes('dipcMessageText(msg)'));
  });
});
