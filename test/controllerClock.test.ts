import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { clockReadMessage, clockSetPrompt, clockSetDefault, clockSetDone, parseClockInput } from '../src/controllerClock';

describe('Controller clock labels', () => {
  it('shows what the controller answered without calling it UTC', () => {
    const m = clockReadMessage('2026-01-02 T 03:04:05');
    assert.match(m, /^Controller clock: 2026-01-02 T 03:04:05/);
    assert.doesNotMatch(m.split('\n')[0], /UTC/);
  });

  it('says ABB documents UTC and that a virtual controller answers the PC\'s local time', () => {
    const m = clockReadMessage('2026-01-02 T 03:04:05');
    assert.match(m, /ABB documents the value as UTC/);
    assert.match(m, /virtual controller/i);
    assert.match(m, /local time/i);
  });

  it('the set prompt says the typed values go to the controller unchanged', () => {
    const p = clockSetPrompt();
    assert.match(p, /YYYY-MM-DD HH:MM:SS/);
    assert.match(p, /sent exactly as typed/i);
    assert.match(p, /UTC/);
  });

  it('prefills the UTC time, because that is the time ABB documents for Set', () => {
    assert.equal(clockSetDefault(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '2026-01-02 03:04:05');
  });

  it('parses the typed value into the six numbers the client sends', () => {
    assert.deepEqual(parseClockInput('2026-01-02 03:04:05'), [2026, 1, 2, 3, 4, 5]);
    assert.equal(parseClockInput('02.01.2026 03:04'), undefined);
  });

  it('confirms with the value that was sent, not a bare "Clock set"', () => {
    assert.equal(clockSetDone('2026-01-02 03:04:05'), '✓ Clock set to 2026-01-02 03:04:05 (sent as typed; ABB documents the clock as UTC).');
  });
});

import { clockWriteRefused, clockWriteRefusedMessage } from '../src/controllerClock';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Set Controller Clock: the controller does not take a clock write', () => {
  it('recognises the 405 on PUT /ctrl/clock', () => {
    assert.equal(clockWriteRefused(new Error('Set clock failed: HTTP 405 from PUT /ctrl/clock (HTTP method not supported by resource -1073414144 -1)')), true);
    assert.equal(clockWriteRefused(new Error('HTTP 405 from POST /rw/cfg')), false);
    assert.equal(clockWriteRefused(new Error('HTTP 400 from PUT /ctrl/clock')), false);
  });

  it('says a virtual controller does not accept a clock write, and that nothing changed', () => {
    const m = clockWriteRefusedMessage('Set clock', true);
    assert.match(m, /^Set clock: this virtual controller does not accept a clock write/);
    assert.match(m, /405/);
    assert.match(m, /ABB lists the clock write for real controllers only/);
    assert.match(m, /nothing was changed/i);
  });

  it('for a real or unknown controller it states the 405 and does not blame the virtual controller', () => {
    const m = clockWriteRefusedMessage('Set clock', false);
    assert.match(m, /answered 405/);
    assert.doesNotMatch(m, /virtual controller does not accept/);
  });

  it('the error text uses it, with the controller type from the state', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
    assert.ok(src.includes('clockWriteRefused(e)'));
    assert.ok(src.includes('clockWriteRefusedMessage(label,'));
  });
});
