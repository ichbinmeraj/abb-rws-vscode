import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RobotManager, RwsError, type ElogMessage, type IRWSAdapter } from 'abb-rws-client';
import {
  isSemanticError, RAPID_SEMANTIC_ERROR, refusalMessage, reportsStepsDone, SEMANTIC_ERROR_HINT, semanticErrorText, stopOfferDetail,
} from '../src/refusalUi';

// The bundled client's own loadProgram and unloadModule, against an adapter stand-in that
// answers as a RobotWare 7.21.4 virtual controller did for a module named like one of its own
// symbols: the module listed as Probe#2 after the load, the move of the program pointer to
// main refused with a semantic error, and the unload by the original name refused with 403
// -1073414145, "Reason written in elog". No controller is involved.

interface Script {
  lists: string[][];
  resetFails?: RwsError;
  unloadFails?: RwsError;
  log?: ElogMessage[];
}

function adapterFor(s: Script): { adapter: IRWSAdapter; wire: string[] } {
  const wire: string[] = [];
  const adapter = {
    requestMastership: async (d: string) => { wire.push(`request ${d}`); },
    releaseMastership: async (d: string) => { wire.push(`release ${d}`); },
    getRapidExecutionState: async () => 'stopped',
    stopRapid: async () => { wire.push('stop'); },
    listModules: async (t: string) => { wire.push(`list ${t}`); return s.lists.length > 1 ? s.lists.shift()! : s.lists[0]; },
    unloadModule: async (t: string, m: string) => { wire.push(`unload ${t} ${m}`); if (s.unloadFails) { throw s.unloadFails; } },
    uploadFile: async (p: string) => { wire.push(`upload ${p}`); },
    loadModule: async (t: string, p: string) => { wire.push(`load ${t} ${p}`); },
    resetRapid: async () => { wire.push('pp to main'); if (s.resetFails) { throw s.resetFails; } },
    getEventLog: async () => { wire.push('read event log'); return s.log ?? []; },
  };
  return { adapter: adapter as unknown as IRWSAdapter, wire };
}

function managerOf(adapter: IRWSAdapter, modulesByTask: Record<string, string[]> = {}): RobotManager {
  const mgr = new RobotManager();
  const m = mgr as unknown as { adapter: IRWSAdapter; _state: Record<string, unknown> };
  m.adapter = adapter;
  Object.assign(m._state, { connected: true, modulesByTask, systemInfo: { name: 'IRB_1300', rwVersion: '7.21.4' } });
  return mgr;
}

const caught = (p: Promise<unknown>): Promise<RwsError> =>
  p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => { assert.ok(e instanceof RwsError); return e; });

// The controller's refusal of the move to main, as the client explains it (a wrong-state refusal).
const SEMANTIC_SENTENCE = "Controller 'IRB_1300' refused to set the program pointer to Main: the loaded RAPID program has semantic errors "
  + '(ABB: "Operation not allowed due to semantic error(s)"). Correct the RAPID code and load the module again.';
const semanticError = (explained = true): RwsError => new RwsError(
  explained
    ? `${SEMANTIC_SENTENCE} Controller: HTTP 400 from POST /rw/rapid/execution/resetpp, code -1073442802 (0xC004900E, SYS_CTRL_E_RAPID_SEMANTIC_ERROR).`
    : 'HTTP 400 from POST /rw/rapid/execution/resetpp (code:-1073442802 icode:-519).',
  'WRONG_MODE', 400, undefined, RAPID_SEMANTIC_ERROR, 'Semantic error',
  explained ? { kind: 'wrong-state', condition: 'controller-state', grantor: null, sentence: SEMANTIC_SENTENCE } as unknown as RwsError['refusal'] : undefined,
);

const elog = (seqnum: number, code: number, title: string, desc: string): ElogMessage => ({
  seqnum, code, msgtype: 3, timestamp: '', srcName: '', title, desc, causes: '', consequences: '', actions: '', args: [],
});

/** The text RAPID Live shows for an error, as friendlyErrorMessage builds it up to the refusal branch. */
function shown(label: string, e: RwsError): string {
  if (isSemanticError(e) && e.code !== 'INVALID_ARGUMENT') {
    return semanticErrorText(label, e.message, e.refusal ? refusalMessage(label, e.message, e.refusal, 'rw7') : undefined);
  }
  return e.refusal ? refusalMessage(label, e.message, e.refusal, 'rw7') : `${label} failed: ${e.message}`;
}

describe('a load that ended in a semantic error after the controller renamed the module', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-live-load-'));
    file = path.join(dir, 'Probe.mod');
    fs.writeFileSync(file, 'MODULE Probe\n  VAR num probe := 0;\n  PROC main()\n  ENDPROC\nENDMODULE\n');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps the client\'s report, which names the module as the controller loaded it, and adds the PROC main() hint', async () => {
    const { adapter } = adapterFor({ lists: [['BASE'], ['BASE', 'Probe#2']], resetFails: semanticError() });
    const e = await caught(managerOf(adapter).loadProgram(file, 'T_ROB1'));
    assert.equal(isSemanticError(e), true);
    assert.equal(reportsStepsDone(e.message), true);
    const text = shown('Load module', e);
    assert.ok(text.startsWith(`Load module: ${e.message}`), text);
    assert.match(text, /loaded module Probe into T_ROB1 as Probe#2, the name the controller gave it \(unload it by that name\)/);
    assert.ok(text.endsWith(` ${SEMANTIC_ERROR_HINT}`), text);
    assert.doesNotMatch(text, /blocked/);
    // The stop offer's detail does not claim that nothing was changed.
    assert.doesNotMatch(stopOfferDetail(e), /Nothing was changed/);
  });

  it('keeps the report also when the client did not explain the controller\'s answer', async () => {
    const { adapter } = adapterFor({ lists: [['BASE'], ['BASE', 'Probe#2']], resetFails: semanticError(false) });
    const e = await caught(managerOf(adapter).loadProgram(file, 'T_ROB1'));
    const text = shown('Load module', e);
    assert.equal(text, `Load module failed: ${e.message} ${SEMANTIC_ERROR_HINT}`);
    assert.match(text, /as Probe#2, the name the controller gave it/);
  });

  it('a semantic error with no report of steps keeps the hint alone, as before', () => {
    const text = semanticErrorText('Set PP', 'Semantic error. code:-1073442802 icode:-519.');
    assert.match(text, /^Set PP blocked - RAPID program has a semantic error\. Most often this means two loaded modules each define PROC main\(\)\./);
    assert.equal(semanticErrorText('Load module', 'x Done before it: uploaded a.mod.'), `Load module failed: x Done before it: uploaded a.mod. ${SEMANTIC_ERROR_HINT}`);
  });
});

describe('an unload refused with its reason in the event log', () => {
  const reasonInLog = (): RwsError =>
    new RwsError('HTTP 403 from POST /rw/rapid/tasks/T_ROB1/unloadmod', 'UNKNOWN', 403, undefined, -1073414145, 'Reason written in elog code:-1073414145 icode:-1');

  it('shows the client\'s sentence with the newest event-log message, also when that message speaks of a semantic error', async () => {
    const log = [elog(9, 40192, 'Semantic error', 'Semantic error(s) in task T_ROB1.')];
    const { adapter, wire } = adapterFor({ lists: [['BASE', 'Probe#2']], unloadFails: reasonInLog(), log });
    const e = await caught(managerOf(adapter, { T_ROB1: ['BASE', 'Probe#2'] }).unloadModule('T_ROB1', 'Probe'));
    assert.equal(e.controllerCode, -1073414145);
    assert.match(e.message, /semantic error/i);
    // The controller's code decides: this refusal is not a semantic error.
    assert.equal(isSemanticError(e), false);
    const text = shown('Unload module', e);
    assert.ok(text.startsWith(`Unload module: ${e.message}`), text);
    assert.match(text, /refused to unload module Probe from T_ROB1 and wrote its reason in the event log/);
    assert.match(text, /The newest event-log message, which may not be about this unload, is 40192 "Semantic error"/);
    assert.match(text, /The task lists the module as Probe#2, the name the controller gave it on load; unload it by that name\./);
    assert.doesNotMatch(text, /blocked|gave no reason/);
    // One unload and one event-log read; nothing else is sent.
    assert.deepEqual(wire.filter(w => w.startsWith('unload') || w === 'read event log'), ['unload T_ROB1 Probe', 'read event log']);
  });

  it('an error without the controller\'s code is still read from its text', () => {
    assert.equal(isSemanticError(new Error('HTTP 400 (code:-1073442802 icode:-519)')), true);
    assert.equal(isSemanticError(new Error('Operation not allowed due to semantic error(s)')), true);
    assert.equal(isSemanticError(new RwsError('x', 'UNKNOWN', 400, undefined, RAPID_SEMANTIC_ERROR)), true);
    assert.equal(isSemanticError(new RwsError('semantic error(s)', 'UNKNOWN', 400, undefined, -1073442809)), false);
    assert.equal(isSemanticError(new Error('network')), false);
  });

  it('extension.ts uses the shared predicate and text', () => {
    const src = fs.readFileSync(path.join(path.resolve(__dirname, '..', '..'), 'src', 'extension.ts'), 'utf8');
    assert.doesNotMatch(src, /function isSemanticError\(/);
    assert.match(src, /return semanticErrorText\(label, raw, refusal \? refusalMessage\(label, raw, refusal, gen, robot\) : undefined\);/);
  });
});
