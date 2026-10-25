import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RMMP_NAME, rmmpGrantedText, rmmpOutcomeText } from '../src/rmmp';
import { refusalButtons, type RemedyFacts } from '../src/refusalUi';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

describe('RMMP: the name, and the level the client names', () => {
  it('uses ABB\'s name, Request Manual Mode Privileges', () => {
    assert.equal(RMMP_NAME, 'Request Manual Mode Privileges (RMMP)');
  });

  it('RAPID Live keeps no rule of its own for the level: the client\'s request-rmmp remedy names it', () => {
    const rmmp = fs.readFileSync(path.join(root, 'src', 'rmmp.ts'), 'utf8');
    const ui = fs.readFileSync(path.join(root, 'src', 'refusalUi.ts'), 'utf8');
    assert.doesNotMatch(rmmp, /export function rmmpPlan/);
    assert.doesNotMatch(ui, /rmmpPlan/);
    const r = (level: 'modify' | 'exec'): RemedyFacts => ({ kind: 'request-rmmp', call: { method: 'requestRmmp', level } });
    for (const level of ['modify', 'exec'] as const) {
      const buttons = refusalButtons({ kind: 'rmmp-required', condition: 'rmmp', generation: 'rw7', remedy: r(level) }, 'rw7', 'Cell 3');
      assert.deepEqual(buttons, [{ label: 'Request Remote Control', action: 'request-rmmp', level }]);
    }
  });
});

describe('RMMP: what a grant covers', () => {
  it('says what modify covers and what it does not, instead of "retry"', () => {
    const t = rmmpGrantedText('Cell 3', 'modify', 'rw7', undefined);
    assert.match(t, /^RMMP granted on Cell 3 \(modify\)/);
    assert.match(t, /data writes/);
    assert.match(t, /loading and unloading modules/);
    assert.match(t, /does not cover moving the program pointer, PP to Main or Start/);
    assert.doesNotMatch(t, /Retry the operation/);
  });

  it('exec on RobotWare 7 adds the program pointer move to a routine; Start and PP to Main stay out', () => {
    const t = rmmpGrantedText('Cell 3', 'exec', 'rw7', undefined);
    assert.match(t, /\(exec\)/);
    assert.match(t, /program pointer to a routine/);
    assert.match(t, /PP to Main and Start stay with Auto or the FlexPendant/);
  });

  it('exec on RobotWare 6 says ABB does not say what it covers there', () => {
    // ABB's RWS 1.0 lists exec as a privilege value, with no word on what it covers.
    assert.match(rmmpGrantedText('Cell 3', 'exec', 'rw6', undefined), /does not say what exec covers on RobotWare 6/);
  });

  it('suggests trying the refused operation again only when the grant covers the level the client named for it', () => {
    assert.match(rmmpGrantedText('Cell 3', 'modify', 'rw7', { request: 'POST /rw/rapid/symbol/RAPID/T_ROB1/user/reg1/data', level: 'modify' }), /Try the refused write again/);
    assert.match(rmmpGrantedText('Cell 3', 'exec', 'rw7', { request: 'POST /rw/rapid/symbol/RAPID/T_ROB1/user/reg1/data', level: 'modify' }), /Try the refused write again/);
    assert.match(rmmpGrantedText('Cell 3', 'exec', 'rw7', { request: 'POST /rw/rapid/tasks/T_ROB1/pcp/routine', level: 'exec' }), /Try the refused pointer move again/);
    assert.doesNotMatch(rmmpGrantedText('Cell 3', 'modify', 'rw7', { request: 'POST /rw/rapid/tasks/T_ROB1/pcp/routine', level: 'exec' }), /again/);
    assert.doesNotMatch(rmmpGrantedText('Cell 3', 'modify', 'rw7', undefined), /again/);
  });

  it('after a denial the client\'s next step follows the sentence: speak to the operator first; nothing asks again', () => {
    const denied = {
      sentence: 'The operator at the FlexPendant denied the request.',
      remedy: { detail: 'The operator at the FlexPendant said no. Speak to them first; this tool never asks again on its own.' },
    };
    assert.equal(rmmpOutcomeText(denied, 'x'),
      'The operator at the FlexPendant denied the request. The operator at the FlexPendant said no. Speak to them first; this tool never asks again on its own.');
    assert.equal(rmmpOutcomeText(undefined, 'Denied.'), 'Denied.');
    assert.equal(rmmpOutcomeText({ sentence: 'Said no. Speak.', remedy: { detail: 'Speak.' } }, 'x'), 'Said no. Speak.');
    const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.ok(ext.includes('rmmpOutcomeText(result.refusal, result.detail)'));
  });
});

describe('RMMP: the controller decides the mode', () => {
  it('the extension sends the request in any mode and shows the controller refusal (ABB: RobotWare 7 takes it in MANR only)', () => {
    const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const rmmp = fs.readFileSync(path.join(root, 'src', 'rmmp.ts'), 'utf8');
    assert.doesNotMatch(ext, /rmmpModeRefusal/);
    assert.doesNotMatch(rmmp, /rmmpModeRefusal|Nothing was sent/);
  });
});

describe('RMMP: the error dialog and the commands', () => {
  it('no Request button where the client names no RMMP request (a start, PP to Main): its remedy is at the FlexPendant', () => {
    const f = { kind: 'rmmp-required' as const, condition: 'rmmp' as const, generation: 'rw7' as const };
    const atPendant = { ...f, remedy: { kind: 'do-at-pendant' }, otherRemedies: [{ kind: 'mode' }] };
    assert.deepEqual(refusalButtons({ ...atPendant, controller: { request: 'POST /rw/rapid/execution/start' } }, 'rw7', 'Cell 3'), []);
    assert.deepEqual(refusalButtons({ ...atPendant, controller: { request: 'POST /rw/rapid/execution/resetpp' } }, 'rw7', 'Cell 3'), []);
    const data = { ...f, remedy: { kind: 'request-rmmp', call: { method: 'requestRmmp' as const, level: 'modify' as const } }, otherRemedies: [{ kind: 'do-at-pendant' }] };
    assert.deepEqual(refusalButtons(data, 'rw7', 'Cell 3').map(b => `${b.action}:${b.level}`), ['request-rmmp:modify']);
    // Without a remedy (a refusal built before remedies) there is no level, so no button.
    assert.deepEqual(refusalButtons(f, 'rw7', 'Cell 3'), []);
  });

  it('the extension uses the right name, no "Remote Mastership Privilege", no MANF, no blanket retry', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.doesNotMatch(src, /Remote Mastership Privilege/);
    assert.doesNotMatch(src, /granted in manual mode only \(MANR or MANF\)/);
    assert.doesNotMatch(src, /Retry the operation/);
    assert.equal(src.includes('rmmpModeRefusal('), false);
    assert.ok(src.includes('rmmpGrantedText('));
    assert.doesNotMatch(src, /rmmpPlan\(/);
    // The button's level is the client's.
    assert.ok(src.includes('requestRmmpInteractive(entry, { level: button.level, refused: { request: refusal?.controller?.request, level: button.level } })'));
    assert.ok(src.includes('active.requestRmmp(level,'));
    assert.doesNotMatch(src, /active\.requestRmmp\('modify'/);
  });
});
