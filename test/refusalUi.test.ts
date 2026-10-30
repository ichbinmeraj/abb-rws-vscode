import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFlexPendantApplication, isFlexPendantStation, mastershipHolderText, refusalButtons, writeAccessHolderText, type RefusalFacts } from '../src/refusalUi';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

const labels = (facts: RefusalFacts | undefined, gen: 'rw6' | 'rw7' | 'rw8' | null, code?: string) =>
  refusalButtons(facts, gen, 'Cell 3', code).map(b => `${b.action}:${b.label}`);

describe('refusalButtons', () => {
  it('offers Request Remote Control only where the client names an RMMP request, on RobotWare 6 and 7', () => {
    const rmmp: RefusalFacts = {
      kind: 'rmmp-required', condition: 'rmmp',
      remedy: { kind: 'request-rmmp', call: { method: 'requestRmmp', level: 'modify' } }, otherRemedies: [{ kind: 'do-at-pendant' }],
    };
    assert.deepEqual(labels({ ...rmmp, generation: 'rw6' }, null), ['request-rmmp:Request Remote Control']);
    assert.deepEqual(labels({ ...rmmp, generation: 'rw7' }, null), ['request-rmmp:Request Remote Control']);
    assert.deepEqual(labels({ ...rmmp, generation: null }, 'rw7'), ['request-rmmp:Request Remote Control']);
    assert.deepEqual(labels({ ...rmmp, generation: 'rw8' }, null), []);
    assert.deepEqual(labels({ ...rmmp, generation: null }, null), []);
    // A request that waits: the operator grants it at the FlexPendant, never a button.
    assert.deepEqual(labels({ kind: 'rmmp-pending', condition: 'rmmp', generation: 'rw7', remedy: { kind: 'grant-rmmp-at-pendant' } }, null), []);
    // RobotWare 7 in manual mode, a pointer move to a routine: the client names exec.
    const exec = refusalButtons({ kind: 'wrong-mode', condition: 'operating-mode', generation: 'rw7',
      remedy: { kind: 'request-rmmp', call: { method: 'requestRmmp', level: 'exec' } }, otherRemedies: [{ kind: 'do-at-pendant' }, { kind: 'mode' }] }, null, 'Cell 3');
    assert.deepEqual(exec, [{ label: 'Request Remote Control', action: 'request-rmmp', level: 'exec' }]);
  });

  it('never offers a remedy that only the FlexPendant, the holder, an administrator or the integrator can take', () => {
    const atPendant = ['remote-access-on', 'release-pendant-write-access', 'release-pendant-mastership', 'grant-rmmp-at-pendant', 'reset-safety-stop',
      'mode', 'confirm-mode-change', 'do-at-pendant', 'motors-on', 'holder-releases', 'grant-missing', 'signal-access-level', 'check-state'];
    for (const kind of atPendant) {
      for (const gen of ['rw6', 'rw7', 'rw8'] as const) {
        assert.deepEqual(labels({ kind: 'unknown', condition: 'unknown', generation: gen, remedy: { kind, detail: 'At the controller.' } }, gen), [], `${kind} ${gen}`);
      }
    }
    // A call RAPID Live does not offer as a button (motors on, stop) stays text as well.
    assert.deepEqual(labels({ kind: 'wrong-state', condition: 'motors', generation: 'rw7', remedy: { kind: 'motors-on', call: { method: 'setMotorsOn' } } }, 'rw7'), []);
    assert.deepEqual(labels({ kind: 'wrong-state', condition: 'controller-state', generation: 'rw7', remedy: { kind: 'stop-program-first', call: { method: 'stopRapid' } } }, 'rw7'), []);
  });

  it('a remedy kind it does not know is text, never a button', () => {
    const facts: RefusalFacts = { kind: 'unknown', condition: 'unknown', generation: 'rw8', remedy: { kind: 'a-later-kind', detail: 'Do the new thing.', call: { method: 'setMotorsOn' } } };
    assert.deepEqual(labels(facts, 'rw8'), []);
    assert.equal(remedyNote(facts, 'rw8'), 'Do the new thing.');
    assert.equal(refusalMessage('Start RAPID', 'Refused.', facts, 'rw8'), 'Start RAPID: Refused. Do the new thing.');
  });

  it('offers Show Holder where another client holds mastership (RobotWare 6/7) or write access (RobotWare 8)', () => {
    assert.deepEqual(labels({ kind: 'held-by-other', condition: 'mastership', generation: 'rw6' }, null), ['show-holder:Show Holder']);
    assert.deepEqual(labels({ kind: 'held-by-other', condition: 'mastership', generation: 'rw7' }, null), ['show-holder:Show Holder']);
    assert.deepEqual(labels({ kind: 'held-by-other', condition: 'write-access', generation: 'rw8' }, null), ['show-holder:Show Holder']);
    // The condition and the generation must agree: no mastership read on RobotWare 8, no write-access status on 6/7.
    assert.deepEqual(labels({ kind: 'held-by-other', condition: 'mastership', generation: 'rw8' }, null), []);
    assert.deepEqual(labels({ kind: 'held-by-other', condition: 'write-access', generation: 'rw7' }, null), []);
    assert.deepEqual(labels({ kind: 'held-by-other', condition: 'write-access', generation: null }, null), []);
  });

  it('gives every other refusal the sentence alone', () => {
    for (const kind of ['safety-state', 'grant-missing', 'remote-access-off', 'wrong-mode', 'wrong-state', 'option-missing', 'not-held', 'lost', 'unknown'] as const) {
      assert.deepEqual(labels({ kind, condition: 'unknown', generation: 'rw7' }, null), [], kind);
      assert.deepEqual(labels({ kind, condition: 'unknown', generation: 'rw8' }, null), [], kind);
    }
  });

  it('a mastership error the client did not explain, on RobotWare 6/7, offers Show Holder and the release of this tool\'s own hold, naming the robot', () => {
    assert.deepEqual(labels(undefined, 'rw7', 'MASTERSHIP_REQUIRED'), ['show-holder:Show Holder', "release-own:Release this tool's control of Cell 3"]);
    assert.deepEqual(labels(undefined, 'rw6', 'MASTERSHIP_REQUIRED'), ['show-holder:Show Holder', "release-own:Release this tool's control of Cell 3"]);
    assert.deepEqual(labels(undefined, 'rw8', 'MASTERSHIP_REQUIRED'), []);
    assert.deepEqual(labels(undefined, null, 'MASTERSHIP_REQUIRED'), []);
    assert.deepEqual(labels(undefined, 'rw7', 'NETWORK_ERROR'), []);
    assert.deepEqual(labels(undefined, 'rw7'), []);
  });
});

describe('the FlexPendant as a holder: the two forms seen', () => {
  it('isFlexPendantStation takes RobotWare 8\'s station FlexPendant, in any case, and no other name', () => {
    for (const name of ['FlexPendant', 'FLEXPENDANT', 'flexpendant', ' FlexPendant ']) {
      assert.equal(isFlexPendantStation(name), true, name);
    }
    for (const name of ['TPU', 'tpu', 'RAPID Live', 'FlexPendant 2', 'Flex Pendant', '', null, undefined]) {
      assert.equal(isFlexPendantStation(name), false, String(name));
    }
  });

  it('isFlexPendantApplication takes RobotWare 7\'s application TPU, in any case, and no other name', () => {
    for (const name of ['TPU', 'tpu', ' TPU ']) {
      assert.equal(isFlexPendantApplication(name), true, name);
    }
    for (const name of ['FlexPendant', 'RobotStudio', 'TPU2', '', null, undefined]) {
      assert.equal(isFlexPendantApplication(name), false, String(name));
    }
  });
});

describe('mastershipHolderText (RobotWare 6/7)', () => {
  it('names the FlexPendant for a local hold by TPU', () => {
    assert.equal(mastershipHolderText('Cell 3', { mastership: 'local', application: 'TPU', uid: '42' }),
      'Cell 3: domain=edit (rapid) | mastership=local | held-by=the FlexPendant | uid=42');
  });

  it('names any other holder by its application, and a remote TPU is not the FlexPendant', () => {
    assert.equal(mastershipHolderText('Cell 3', { mastership: 'remote', application: 'RobotStudio', uid: '7' }),
      'Cell 3: domain=edit (rapid) | mastership=remote | held-by=RobotStudio | uid=7');
    assert.equal(mastershipHolderText('Cell 3', { mastership: 'remote', application: 'TPU' }),
      'Cell 3: domain=edit (rapid) | mastership=remote | held-by=TPU');
    assert.equal(mastershipHolderText('Cell 3', { mastership: 'local' }), 'Cell 3: domain=edit (rapid) | mastership=local');
    assert.equal(mastershipHolderText('Cell 3', { mastership: 'nomaster' }), 'Cell 3: domain=edit (rapid) | mastership=nomaster');
  });
});

describe('writeAccessHolderText (RobotWare 8)', () => {
  it('names the holding station, and never an id; the FlexPendant by that name', () => {
    assert.equal(writeAccessHolderText('Cell 3', { held: true, heldByMe: false, heldByName: 'FlexPendant', externalControlEnabled: true }),
      'Cell 3: write access is held by the FlexPendant.');
    assert.equal(writeAccessHolderText('Cell 3', { held: true, heldByMe: false, heldByName: 'Station 7', externalControlEnabled: true }),
      "Cell 3: write access is held by the station 'Station 7'.");
    // A station named TPU has not been seen: named as the controller gives it.
    assert.equal(writeAccessHolderText('Cell 3', { held: true, heldByMe: false, heldByName: 'TPU', externalControlEnabled: true }),
      "Cell 3: write access is held by the station 'TPU'.");
    // While the FlexPendant holds it, RobotWare 8 reads Remote Access off.
    assert.equal(writeAccessHolderText('Cell 3', { held: true, heldByMe: false, heldByName: 'FlexPendant', externalControlEnabled: false }),
      'Cell 3: write access is held by the FlexPendant. Remote Access is off at the FlexPendant, so no remote station can take it.');
    assert.equal(writeAccessHolderText('Cell 3', { held: true, heldByMe: true, heldByName: 'RAPID Live', externalControlEnabled: true }),
      "Cell 3: write access is held by this tool's own station, 'RAPID Live'.");
    assert.equal(writeAccessHolderText('Cell 3', { held: true, heldByMe: null, heldByName: null, externalControlEnabled: null }),
      'Cell 3: write access is held; the controller names no station.');
  });

  it('says when nothing holds it, and when the controller did not say', () => {
    assert.equal(writeAccessHolderText('Cell 3', { held: false, heldByMe: false, heldByName: null, externalControlEnabled: true }),
      'Cell 3: no station holds write access.');
    assert.equal(writeAccessHolderText('Cell 3', { held: null, heldByMe: null, heldByName: null, externalControlEnabled: null }),
      'Cell 3: the controller did not say whether write access is held.');
  });

  it('adds that Remote Access is off when the controller says so', () => {
    assert.equal(writeAccessHolderText('Cell 3', { held: false, heldByMe: false, heldByName: null, externalControlEnabled: false }),
      'Cell 3: no station holds write access. Remote Access is off at the FlexPendant, so no remote station can take it.');
  });
});

describe('the error path in extension.ts', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

  it('showError, friendlyErrorMessage and wrap take the robot entry, never the multi-robot manager', () => {
    assert.match(src, /function showError\(label: string, e: unknown, entry\?: RobotEntry/);
    assert.match(src, /function friendlyErrorMessage\(label: string, e: unknown, state\?: RobotState/);
    assert.match(src, /async function wrap\(title: string, fn: \(\) => Promise<void>, successMsg: string, entry\?: RobotEntry\)/);
    assert.doesNotMatch(src, /showError\([^)]*,\s*multi\)/);
    assert.doesNotMatch(src, /wrap\([^;]*,\s*multi\);/);
  });

  it('the dialog text starts with the robot label of the entry, and a note is added once', () => {
    assert.ok(src.includes("const friendly = withNote((entry ? `${robotLabel(confirmRobotOf(entry))}: ` : '') + friendlyErrorMessage(label, e, state, robot), note)"));
    assert.doesNotMatch(src, /const RW8_RESET_HINT/);
  });

  it('the buttons come from refusalButtons and act on that entry', () => {
    assert.match(src, /refusalButtons\(refusal, gen, entry\.config\.name, code, robot\)/);
    assert.doesNotMatch(src, /'Force-Release'/);
    assert.match(src, /getWriteAccessStatus\(\)/);
  });

  it('classifies a refusal before any message pattern; the 403 and 400 guesses are gone, the plain hints stay', () => {
    const start = src.indexOf('function friendlyErrorMessage(');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    assert.ok(body.indexOf('refusalOf(e)') < body.indexOf('HTTP 503'));
    assert.doesNotMatch(body, /HTTP 403|not allowed|held by someone else|HTTP 400|isWriteOp/);
    for (const hint of ['HTTP 503', 'resetpp', 'Path does not exist', '-1073442809', '-4501']) { assert.ok(body.includes(hint), hint); }
  });

  it('Switch Operation Mode keeps the pending-at-the-pendant note and has no regex block of its own', () => {
    const start = src.indexOf("tracedCommand('abbRobot.setOpMode'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.match(body, /timeout/i);
    assert.doesNotMatch(body, /HTTP 500/);
    assert.match(body, /showError\('Switch op mode', e, entry, opModeRefusalNote\(ctrlstate, generationOf\(entry\.manager\.state\), raw\)\)/);
  });

  it('Switch Operation Mode is sent in a guard stop or an emergency stop: the controller decides', () => {
    const start = src.indexOf("tracedCommand('abbRobot.setOpMode'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    // No local refusal before the quick pick: the only returns before the send
    // are not connected, a cancelled pick and the same mode; a cancelled
    // confirmation sends nothing inside the wrapper.
    assert.doesNotMatch(body, /Cannot change op-mode/);
    assert.doesNotMatch(body, /ctrlstate === 'guardstop'|ctrlstate === 'emergencystop'/);
    const send = body.indexOf('entry.manager.setOperationMode(');
    assert.ok(send > 0);
    const returns = body.slice(0, send).match(/return;/g) ?? [];
    assert.equal(returns.length, 3);
    assert.match(body.slice(0, send), /sendTo\(entry, opModeRequest\(current, pick\.label\), \(\) => vscode\.window\.withProgress\(/);
  });

  it('Open Module Source says a file is written and deleted on the controller', () => {
    const start = src.indexOf("tracedCommand('abbRobot.openModuleSource'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.match(body, /writes the module to a file on the controller and deletes it/);
  });

  it('Compress says the job started: the controller answers 202 and writes the archive after that', () => {
    const start = src.indexOf("tracedCommand('abbRobot.compressPath'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.match(body, /Compress started on the controller: \$\{source\} → \$\{dest\}\. The archive is there when the job ends\./);
    assert.doesNotMatch(body, /✓ Compressed/);
  });

  it('Show Remote-Control Status shows "pending (exec)"', () => {
    assert.match(src, /'pending \(exec\)'/);
  });

  it('Request Remote Control from the palette sends the request in any mode: the controller decides', () => {
    const start = src.indexOf("tracedCommand('abbRobot.requestRmmp'");
    const body = src.slice(start, src.indexOf('tracedCommand(', start + 1));
    assert.ok(body.indexOf('requestRmmpInteractive(') >= 0);
    assert.equal(body.includes('rmmpModeRefusal('), false);
    assert.doesNotMatch(body, /opmode/);
  });
});

import { isProgramRunningRefusal, stopOfferDetail } from '../src/refusalUi';

describe('the stop offer when a write is refused while RAPID runs', () => {
  const refusal = (extra: Record<string, unknown> = {}) => ({
    kind: 'wrong-state', condition: 'controller-state', grantor: 'this-tool', missing: 'a stopped RAPID program', ...extra,
  });

  it('knows the refusal the client raised itself, and the controller\'s refusal it explains (it carries an HTTP status)', () => {
    assert.equal(isProgramRunningRefusal({ refusal: refusal(), message: 'x' }), true);
    assert.equal(isProgramRunningRefusal({ refusal: refusal(), httpStatus: 400, message: 'x' }), true);
  });

  it('leaves every other refusal and error alone', () => {
    assert.equal(isProgramRunningRefusal({ refusal: refusal({ grantor: 'pendant-operator' }) }), false);
    assert.equal(isProgramRunningRefusal({ refusal: refusal({ missing: 'a manual operating mode' }) }), false);
    assert.equal(isProgramRunningRefusal({ refusal: refusal({ kind: 'held-by-other' }) }), false);
    assert.equal(isProgramRunningRefusal(new Error('network')), false);
    assert.equal(isProgramRunningRefusal(undefined), false);
  });

  it('a 404, a bad file or a holder of access while the program runs gets no stop offer', () => {
    // The client explains as "program running" only a state or mode refusal of the step that changes the program;
    // these keep their own kind and code, so the dialog's question never appears for them.
    const notFound = { code: 'RESOURCE_NOT_FOUND', httpStatus: 404, message: 'loadProgram: the module file was not found on the controller' };
    assert.equal(isProgramRunningRefusal(notFound), false);
    assert.equal(isProgramRunningRefusal({ ...notFound, refusal: { kind: 'unknown', condition: 'none', grantor: null, missing: 'a path that exists' } }), false);
    assert.equal(isProgramRunningRefusal({ code: 'INVALID_ARGUMENT', httpStatus: 400, refusal: { kind: 'invalid-argument', condition: 'argument', grantor: 'this-tool', missing: 'a loadable module file' } }), false);
    assert.equal(isProgramRunningRefusal({ code: 'MASTERSHIP_REQUIRED', httpStatus: 403, refusal: { kind: 'held-by-other', condition: 'mastership', grantor: 'other-client', missing: 'the mastership held by another client' } }), false);
  });

  it('the detail does not claim nothing was changed when the call reports steps done before the refusal', () => {
    assert.match(stopOfferDetail({ message: 'loadProgram: refused. Nothing was changed on the controller before it.' }), /Nothing was changed/);
    const partial = stopOfferDetail({ message: 'loadProgram could not load. Done before it: unloaded the old module ZZ from T_ROB1.' });
    assert.doesNotMatch(partial, /Nothing was changed/);
    assert.match(partial, /what was done before the refusal/i);
    assert.match(partial, /stopped only if you choose/);
  });

  it('the extension uses the shared predicate and detail', () => {
    const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.doesNotMatch(ext, /function isProgramRunningRefusal\(/);
    assert.ok(ext.includes('stopOfferDetail(e)'));
  });
});

describe('the UI instruction answer', () => {
  it('asks for TPAnswer, not Result, and ends the wait with TPCompleted', () => {
    const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = ext.indexOf("tracedCommand('abbRobot.getUiInstruction'");
    const body = ext.slice(start, ext.indexOf('tracedCommand(', start + 1));
    assert.match(body, /value: 'TPAnswer'/);
    assert.doesNotMatch(body, /value: 'Result'/);
    assert.match(body, /'TPCompleted', 'TRUE'/);
    assert.match(body, /Then sends TPCompleted = TRUE/);
  });
});

import { inSafetyStop, opModeRefusalNote, RW8_RESET_HINT, safetyStopName, withNote } from '../src/refusalUi';

describe('a refused operating-mode switch', () => {
  it('a guard stop and an emergency stop are safety stops; the other states are not', () => {
    assert.equal(inSafetyStop('guardstop'), true);
    assert.equal(inSafetyStop('emergencystop'), true);
    for (const s of ['motoron', 'motoroff', 'init', 'sysfail', '', null, undefined]) { assert.equal(inSafetyStop(s), false, String(s)); }
    assert.equal(safetyStopName('guardstop'), 'guard stop');
    assert.equal(safetyStopName('emergencystop'), 'emergency stop');
    assert.equal(safetyStopName('motoron'), undefined);
  });

  it('on RobotWare 8 in a safety stop, the note says where the Reset is', () => {
    assert.equal(opModeRefusalNote('guardstop', 'rw8'), RW8_RESET_HINT);
    assert.equal(opModeRefusalNote('emergencystop', 'rw8'), RW8_RESET_HINT);
    assert.match(RW8_RESET_HINT, /thumb button/);
  });

  it('adds no note outside a safety stop or on RobotWare 6 and 7: the client\'s sentence stands alone', () => {
    assert.equal(opModeRefusalNote('motoron', 'rw8'), undefined);
    assert.equal(opModeRefusalNote('motoroff', 'rw8'), undefined);
    assert.equal(opModeRefusalNote(undefined, 'rw8'), undefined);
    assert.equal(opModeRefusalNote('guardstop', 'rw7'), undefined);
    assert.equal(opModeRefusalNote('guardstop', 'rw6'), undefined);
    assert.equal(opModeRefusalNote('guardstop', null), undefined);
  });

  it('adds no note when the client\'s sentence already says where the Reset is', () => {
    const said = 'Someone at the cell must clear the cause of the safety stop and reset it (RobotWare 8: the Reset / thumb button on the FlexPendant in Auto).';
    assert.equal(opModeRefusalNote('guardstop', 'rw8', said), undefined);
    assert.equal(opModeRefusalNote('guardstop', 'rw8', 'Switching the operating mode was refused.'), RW8_RESET_HINT);
  });

  it('the note follows the message once, also when the client\'s sentence already carries it', () => {
    const sentence = 'Cell 3 (10.0.5.20:80): Switch op mode: the controller is in guard stop.';
    assert.equal(withNote(sentence, RW8_RESET_HINT), `${sentence} ${RW8_RESET_HINT}`);
    assert.equal(withNote(`${sentence} ${RW8_RESET_HINT}`, RW8_RESET_HINT), `${sentence} ${RW8_RESET_HINT}`);
    assert.equal(withNote(sentence, undefined), sentence);
    assert.equal(withNote(sentence, ''), sentence);
  });
});

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RwsClient2, RwsError } from 'abb-rws-client';
import { ALLOW_MOTION_CONTROL_BUTTON, FIXED_STATION_NEXT_STEP, MOTION_CONTROL_OFF_NEXT_STEP, refusalMessage, refusalNextStep, remedyNote } from '../src/refusalUi';

// RobotWare 8 refuses a RAPID start, and a jog, from a station that has not made the
// motion-control declaration: 403 with -1073435864. The body is the one an 8.2.1 virtual
// controller answered to POST /rw/rapid/execution/start, as the vendored client's own test
// holds it. A loopback stub answers it here; no controller is involved.
const MOTION_CONTROL_REFUSED = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="https://127.0.0.1:80/"/></head>'
  + '<body><div class="status"><span class="code">-1073435864</span><span class="msg">rws_resource_rapid_execution.cpp[1458] Unspecified Error '
  + 'code:-1073435864 icode:-1073435864</span></div></body></html>';

async function refusedStart(): Promise<{ error: RwsError; wire: string[] }> {
  const wire: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      wire.push(`${req.method} ${req.url}`);
      if (req.url === '/rw/system') {
        res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' });
        res.end('{"_links":{"base":{"href":"https://x/"}},"state":[{"_type":"sys-system","_title":"system","rwversion":"8.2.1+1023"}]}');
        return;
      }
      if (req.url?.startsWith('/rw/mastership')) { res.writeHead(410); res.end(); return; }
      if (req.method === 'POST' && /^\/rw\/rapid\/execution\/start(\?|$)/.test(req.url ?? '')) {
        res.writeHead(403, { 'Content-Type': 'application/xhtml+xml;v=2.0' });
        res.end(MOTION_CONTROL_REFUSED);
        return;
      }
      res.writeHead(204); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const client = new RwsClient2(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'u', 'p');
    await client.connect();
    const error = await client.startRapid().then(() => { throw new Error('expected the start to be refused'); }, (e: unknown) => e);
    assert.ok(error instanceof RwsError);
    return { error, wire };
  } finally { server.close(); }
}

describe('RobotWare 8: a start or a jog refused because motion control is not allowed', () => {
  it('keeps the client\'s reason, offers Allow Motion Control from its remedy, and adds RAPID Live\'s next step', async () => {
    const { error, wire } = await refusedStart();
    const refusal = error.refusal!;
    assert.equal(refusal.kind, 'motion-control-off');
    // The client's sentence names no method; its remedy names the call, for a person's confirmation.
    assert.match(error.message, /motion control is not allowed for this control station/);
    assert.doesNotMatch(refusal.sentence, /setAllowMotionControl/);
    assert.equal(refusal.remedy?.kind, 'declare-motion-control');
    assert.deepEqual(refusal.remedy?.call, { method: 'setAllowMotionControl', allow: true });
    assert.equal(refusal.remedy?.safetyDeclaration, true);
    assert.ok(refusal.otherRemedies?.some(r => r.kind === 'do-at-pendant'), 'the FlexPendant stays the other way');
    assert.deepEqual(refusalButtons(refusal, 'rw8', 'Cell 3'), [{ label: ALLOW_MOTION_CONTROL_BUTTON, action: 'declare-motion-control' }]);
    const text = refusalMessage('Starting RAPID', error.message, refusal, 'rw8');
    assert.ok(text.startsWith(`Starting RAPID: ${error.message}`), 'the client\'s message is kept whole');
    assert.ok(text.endsWith(` ${MOTION_CONTROL_OFF_NEXT_STEP}`), 'RAPID Live\'s next step follows it');
    assert.equal(text.split(MOTION_CONTROL_OFF_NEXT_STEP).length, 2, 'the step is added once');
    // Nothing allows motion control along the way.
    // The client reads the allowance after it registers; nothing allows it.
    assert.ok(!wire.some(w => /^POST .*allowmotioncontrol/i.test(w)), wire.join('\n'));
  });

  it('the next step names Allow Motion Control and the FlexPendant, on one line', () => {
    assert.equal(MOTION_CONTROL_OFF_NEXT_STEP,
      'To start or jog from here, choose Allow Motion Control and confirm both stops are within your reach. Or start or jog from the FlexPendant.');
    assert.doesNotMatch(MOTION_CONTROL_OFF_NEXT_STEP, /setAllowMotionControl|\n/);
  });

  it('the Allow button is on RobotWare 8 only: from the remedy, from an other remedy, and from the kind with a client without remedies', () => {
    const declare = { kind: 'declare-motion-control', call: { method: 'setAllowMotionControl' as const, allow: true as const } };
    const primary: RefusalFacts = { kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8', remedy: declare, otherRemedies: [{ kind: 'do-at-pendant' }] };
    // The jog refused after a reading of not allowed: check first; allowing is another way.
    const other: RefusalFacts = { kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8',
      remedy: { kind: 'check-state', detail: 'The controller did not say why it refused.' }, otherRemedies: [declare, { kind: 'do-at-pendant' }] };
    const bare: RefusalFacts = { kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8' };
    for (const facts of [primary, other, bare]) {
      assert.deepEqual(labels(facts, 'rw8'), [`declare-motion-control:${ALLOW_MOTION_CONTROL_BUTTON}`]);
      for (const gen of ['rw6', 'rw7'] as const) { assert.deepEqual(labels({ ...facts, generation: gen }, gen), [], gen); }
    }
    // A remedy that names another kind with the call is not the Allow button.
    assert.deepEqual(labels({ kind: 'unknown', condition: 'unknown', generation: 'rw8', remedy: { kind: 'none-known' } }, 'rw8'), []);
    // The jog's own next step comes first, then the button's.
    assert.equal(refusalMessage('Jog', 'Cell 3 refused to jog.', other, 'rw8'),
      `Jog: Cell 3 refused to jog. The controller did not say why it refused. ${MOTION_CONTROL_OFF_NEXT_STEP}`);
  });

  it('a robot that registers as a fixed control station: no Allow button, and the next step names the FlexPendant only', async () => {
    const fixed = { fixedStation: true };
    const { error } = await refusedStart();
    const refusal = error.refusal!;
    // The client names allowing motion control for every RobotWare 8 refusal of this kind, whatever the station.
    assert.equal(refusal.remedy?.kind, 'declare-motion-control');
    assert.deepEqual(refusalButtons(refusal, 'rw8', 'Cell 3', undefined, fixed), []);
    assert.equal(refusalNextStep(refusal, 'rw8', fixed), FIXED_STATION_NEXT_STEP);
    const text = refusalMessage('Starting RAPID', error.message, refusal, 'rw8', fixed);
    assert.ok(text.endsWith(` ${FIXED_STATION_NEXT_STEP}`), text);
    assert.doesNotMatch(text, /choose Allow Motion Control/);
    // The jog refused after a read of not allowed: its own next step stays in the sentence; no button, so no note apart.
    const declare = { kind: 'declare-motion-control', call: { method: 'setAllowMotionControl' as const, allow: true as const } };
    const jog: RefusalFacts = { kind: 'motion-control-off', condition: 'motion-control', generation: 'rw8',
      remedy: { kind: 'check-state', detail: 'The controller did not say why it refused.' }, otherRemedies: [declare, { kind: 'do-at-pendant' }] };
    assert.deepEqual(refusalButtons(jog, 'rw8', 'Cell 3', undefined, fixed), []);
    assert.equal(remedyNote(jog, 'rw8', fixed), undefined);
    assert.equal(refusalMessage('Jog', 'Cell 3 refused to jog.', jog, 'rw8', fixed), `Jog: Cell 3 refused to jog. ${FIXED_STATION_NEXT_STEP}`);
    // Without the setting, as before.
    assert.deepEqual(refusalButtons(refusal, 'rw8', 'Cell 3', undefined, { fixedStation: false }), [{ label: ALLOW_MOTION_CONTROL_BUTTON, action: 'declare-motion-control' }]);
    assert.equal(refusalNextStep(refusal, 'rw8', {}), MOTION_CONTROL_OFF_NEXT_STEP);
    // Other refusals of such a robot keep their buttons.
    const held: RefusalFacts = { kind: 'held-by-other', condition: 'write-access', generation: 'rw8', remedy: { kind: 'holder-releases' } };
    assert.deepEqual(refusalButtons(held, 'rw8', 'Cell 3', undefined, fixed), [{ label: 'Show Holder', action: 'show-holder' }]);
  });

  it('rmmp-denied says to speak to the operator first, before the Request button', () => {
    const denied: RefusalFacts = { kind: 'rmmp-denied', condition: 'rmmp', generation: 'rw7',
      remedy: { kind: 'grant-rmmp-at-pendant', detail: 'The operator at the FlexPendant said no. Speak to them first; this tool never asks again on its own.' },
      otherRemedies: [{ kind: 'request-rmmp', call: { method: 'requestRmmp', level: 'modify' } }] };
    assert.deepEqual(labels(denied, 'rw7'), ['request-rmmp:Request Remote Control']);
    const text = refusalMessage('Request RMMP', 'Denied.', denied, 'rw7');
    assert.equal(text, 'Request RMMP: Denied. The operator at the FlexPendant said no. Speak to them first; this tool never asks again on its own.');
  });

  it('a jog refused the same way gets the same step; other refusals get none', () => {
    const jog = { kind: 'motion-control-off', grantor: 'this-tool', generation: 'rw8' as const };
    const sentence = 'Cell 3 refused to jog: motion control is not allowed for this control station.';
    assert.equal(refusalMessage('Jog', sentence, jog, 'rw8'), `Jog: ${sentence} ${MOTION_CONTROL_OFF_NEXT_STEP}`);
    for (const kind of ['rmmp-required', 'held-by-other', 'safety-state', 'wrong-mode', 'grant-missing', 'unknown']) {
      assert.equal(refusalNextStep({ kind, generation: 'rw8' }), undefined, kind);
      assert.equal(refusalMessage('Jog', sentence, { kind, grantor: 'this-tool', generation: 'rw8' }, 'rw8'), `Jog: ${sentence}`, kind);
    }
    assert.equal(refusalNextStep(undefined), undefined);
    assert.equal(refusalNextStep({ kind: 'motion-control-off', generation: 'rw7' }), undefined);
  });

  it('keeps the RobotWare 8 Reset note for a safety stop, unless the message already says where the Reset is', () => {
    const safety = { kind: 'safety-state', grantor: 'cell-safety', generation: 'rw8' as const };
    assert.equal(refusalMessage('Motors on', 'refused.', safety, 'rw8'), `Motors on: refused. ${RW8_RESET_HINT}`);
    assert.equal(refusalMessage('Motors on', 'press the thumb button.', safety, 'rw8'), 'Motors on: press the thumb button.');
    assert.equal(refusalMessage('Motors on', 'refused.', { ...safety, generation: 'rw7' as const }, 'rw7'), 'Motors on: refused.');
  });

  it('friendlyErrorMessage builds the refusal text with refusalMessage', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf('function friendlyErrorMessage(');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    assert.match(body, /if \(refusal\) \{[\s\S]*?return refusalMessage\(label, raw, refusal, gen, robot\);/);
  });

  it('the Allow button runs the Allow command for the robot that refused, with nothing retried; a fixed station gets neither button nor step', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = src.indexOf('function showError(');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    assert.match(body, /const robot: RobotFacts = \{ fixedStation: entry \? fixedStation\(entry\) : false \};/);
    assert.match(body, /friendlyErrorMessage\(label, e, state, robot\)/);
    assert.match(body, /refusalButtons\(refusal, gen, entry\.config\.name, code, robot\)/);
    assert.match(body, /case 'declare-motion-control': \{[\s\S]*?const allow = allowFromRefusal\(refusal, label\);\s*await allowFor\(entry, allow\.origin, allow\.remedy\);\s*return;/);
    assert.doesNotMatch(body, /startRapid\(|jog\(/);
  });
});
