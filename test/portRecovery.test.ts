import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MultiRobotManager, type FoundController } from 'abb-rws-client';
import { unverifiedPortQuestion, unverifiedWriteRefusal } from '../src/portRecovery';
import {
  LAST_SEEN_KEY, connectWithRetries, differentSystemQuestion, elsewhereMessage, foundControllerText, goneMessage,
  identityVerdict, lastSeenText, movedPortCandidates, movedPortQuestion, noAnswerMessage, onceAtATime, planConnect,
  savedProtocol, settleConnect, withLastSeen, withoutLastSeen,
  type AfterConnect, type ConnectTarget, type MovedPortQuestion, type PlanSteps, type SessionNow,
} from '../src/portRecovery';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const extensionSrc = (): string => fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

/** The source of one function or command in extension.ts, up to the next one. */
function sliceOf(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} not found`);
  const stop = src.indexOf(end, at + start.length);
  return src.slice(at, stop < 0 ? undefined : stop);
}

/** A probed controller on this PC. RWS 2.0 (HTTPS, Basic) unless told otherwise. */
function local(port: number, extra: Partial<FoundController> = {}, rws1 = false): FoundController {
  return {
    key: `local:${port}`,
    host: '127.0.0.1',
    port,
    https: !rws1,
    generation: rws1 ? 'rws1' : 'rws2',
    authType: rws1 ? 'digest' : 'basic',
    probe: { host: '127.0.0.1', port, useHttps: !rws1, authType: rws1 ? 'digest' : 'basic' },
    identified: true,
    realm: 'validusers@robapi.abb',
    sources: ['this-pc'],
    ...extra,
  };
}

const CELL_A = { systemId: '6f2b6c1e-0000-4000-8000-000000000001', systemName: 'Cell_A', rwVersion: '7.21.4+417' };

describe('moved port: the controllers that could be the robot', () => {
  it('reads the protocol from the saved HTTPS flag', () => {
    assert.equal(savedProtocol(true), 'rws2');
    assert.equal(savedProtocol(false), 'rws1');
    assert.equal(savedProtocol(undefined), undefined);
  });

  it('keeps probed ABB controllers of the robot\'s protocol on another port, and nothing else', () => {
    const keep = local(5470, { systemName: 'Cell_A', rwVersion: '7.21.4+417' });
    const found = [
      local(5466),                                                  // the saved port itself
      keep,
      local(50959, {}, true),                                       // the other protocol
      local(5480, { identified: false, realm: 'other realm' }),    // a login challenge that is not ABB's
      local(5490, { probe: null, https: null, sources: ['mdns'] }), // announced, never probed
    ];
    assert.deepEqual(movedPortCandidates(found, { port: 5466, useHttps: true }), [keep]);
    assert.deepEqual(movedPortCandidates(found, { port: 5466, useHttps: false }).map(c => c.port), [50959]);
  });

  it('keeps both protocols when the robot has no saved HTTPS flag', () => {
    const found = [local(5470), local(50959, {}, true)];
    assert.deepEqual(movedPortCandidates(found, { port: 5466 }).map(c => c.port), [5470, 50959]);
  });

  it('finds nothing in an empty scan', () => {
    assert.deepEqual(movedPortCandidates([], { port: 5466, useHttps: true }), []);
  });
});

describe('moved port: the question', () => {
  const robot = { name: 'R1', host: '127.0.0.1', port: 5466 };

  it('names the saved robot, its address, and the controller found (name, RobotWare, address)', () => {
    const c = local(5470, { systemName: 'Cell_A', rwVersion: '7.21.4+417' });
    const q = movedPortQuestion(robot, [c]);
    assert.equal(q.message, '"R1" does not answer on 127.0.0.1:5466. Connect it to the controller found on this PC?');
    assert.match(q.detail, /^Found 127\.0\.0\.1:5470: Cell_A, RobotWare 7\.21\.4\+417\.$/m);
    assert.deepEqual(q.choices.map(x => x.label), ['Connect to port 5470']);
    assert.equal(q.choices[0].controller, c);
  });

  it('shows the address Connect will use: the robot\'s saved host with the port found', () => {
    const q = movedPortQuestion({ ...robot, host: 'localhost' }, [local(5470)]);
    assert.match(q.detail, /^Found localhost:5470: /m);
    assert.doesNotMatch(q.detail, /127\.0\.0\.1/);
  });

  it('says why it asks, that the password goes only to the chosen controller, and that Cancel sends nothing', () => {
    const q = movedPortQuestion(robot, [local(5470)]);
    assert.match(q.detail, /cannot tell which controller this is without logging in, so it asks first\./);
    assert.match(q.detail, /The user and password of "R1" are sent only to the controller you choose, and its new port is saved once it connects\. Cancel sends nothing\./);
  });

  it('offers one button per controller when several answer', () => {
    const q = movedPortQuestion(robot, [local(5470), local(5480)]);
    assert.equal(q.message, '"R1" does not answer on 127.0.0.1:5466. Connect it to one of the 2 controllers found on this PC?');
    assert.deepEqual(q.choices.map(x => x.label), ['Connect to port 5470', 'Connect to port 5480']);
    assert.equal(q.detail.split('\n').filter(l => l.startsWith('Found ')).length, 2);
  });

  it('shows what the robot last connected to, when this PC has a record of it', () => {
    assert.match(movedPortQuestion(robot, [local(5470)], CELL_A).detail, /^"R1" last connected to Cell_A, RobotWare 7\.21\.4\+417\.$/m);
    assert.doesNotMatch(movedPortQuestion(robot, [local(5470)]).detail, /last connected/);
    assert.equal(lastSeenText({ systemId: 'abc' }), 'system abc');
  });

  it('a controller with no name read on this PC still gets its RobotWare generation and address', () => {
    assert.equal(foundControllerText(local(50959, {}, true)), '127.0.0.1:50959: name not known, RobotWare 6');
    assert.equal(foundControllerText(local(5470)), '127.0.0.1:5470: name not known, RobotWare 7 or 8');
  });
});

describe('moved port: what a robot last connected to, kept on this PC', () => {
  const info = { name: 'Cell_A', rwVersion: '7.21.4+417', sysid: CELL_A.systemId };

  it('records the system id, name and RobotWare by robot id, and keeps the other robots', () => {
    const other = { systemId: 'other' };
    assert.deepEqual(withLastSeen({ r2: other }, 'r1', info), { r2: other, r1: CELL_A });
  });

  it('writes nothing when the reading has no system id or is the one recorded', () => {
    assert.equal(withLastSeen(undefined, 'r1', null), undefined);
    assert.equal(withLastSeen(undefined, 'r1', { name: 'Cell_A' }), undefined);
    const once = withLastSeen(undefined, 'r1', info);
    assert.ok(once);
    assert.equal(withLastSeen(once, 'r1', info), undefined);
    assert.ok(withLastSeen(once, 'r1', { ...info, sysid: 'another' }));
  });

  it('forgets a removed robot, and writes nothing for a robot it never recorded', () => {
    assert.deepEqual(withoutLastSeen({ r1: { systemId: 'a' }, r2: { systemId: 'b' } }, 'r1'), { r2: { systemId: 'b' } });
    assert.equal(withoutLastSeen({ r2: { systemId: 'b' } }, 'r1'), undefined);
    assert.equal(withoutLastSeen(undefined, 'r1'), undefined);
  });

  it('compares system ids without braces, case or spaces; a reading with no id cannot be compared yet', () => {
    assert.equal(identityVerdict(undefined, { sysid: 'x' }), 'first');
    assert.equal(identityVerdict(CELL_A, { sysid: ` {${CELL_A.systemId.toUpperCase()}} ` }), 'same');
    assert.equal(identityVerdict(CELL_A, { sysid: 'another' }), 'different');
    assert.equal(identityVerdict(CELL_A, { name: 'Cell_A' }), 'unknown');
    assert.equal(identityVerdict(CELL_A, null), 'unknown');
  });

  it('lives in the extension\'s global state, not in the synced robot list', () => {
    assert.equal(LAST_SEEN_KEY, 'abbRobot.lastSeenControllers');
    const src = extensionSrc();
    assert.match(src, /context\.globalState\.update\(LAST_SEEN_KEY, seen\)/);
    assert.doesNotMatch(src, /expectedSystemId/);
  });
});

// ─── Connect, run with fakes ─────────────────────────────────────────────────

/** Fake planConnect steps: which ports answer a probe, what the scan finds, what the person picks. */
function fakeSteps(o: {
  answering?: number[];
  found?: FoundController[];
  notes?: string[];
  findThrows?: Error;
  pick?: (q: MovedPortQuestion) => FoundController | undefined;
  /** Ports that stop answering once the question was answered. */
  goneAfterAsk?: number[];
  cancelAfterFind?: boolean;
} = {}) {
  const calls: string[] = [];
  const questions: MovedPortQuestion[] = [];
  let asked = false;
  let cancelled = false;
  const steps: PlanSteps = {
    isLocal: h => h === '127.0.0.1' || h === 'localhost',
    answers: async (host, port) => {
      calls.push(`probe ${host}:${port}`);
      return (o.answering ?? []).includes(port) && !(asked && (o.goneAfterAsk ?? []).includes(port));
    },
    find: async () => {
      calls.push('find');
      if (o.cancelAfterFind) { cancelled = true; }
      if (o.findThrows) { throw o.findThrows; }
      return { controllers: o.found ?? [], notes: o.notes ?? [] };
    },
    ask: async q => {
      calls.push('ask');
      questions.push(q);
      asked = true;
      return o.pick?.(q);
    },
    cancelled: () => cancelled,
    report: () => undefined,
  };
  return { steps, calls, questions };
}

const R1: ConnectTarget = { name: 'R1', host: '127.0.0.1', port: 5466, useHttps: true };
const OFF: SessionNow = { connected: false, host: '', sameLogin: false };

describe('Connect: what it does before anything is sent with the robot\'s user and password', () => {
  it('a saved port that answers: connect there on a fresh manager, with no scan and no question', async () => {
    const f = fakeSteps({ answering: [5466, 5470], found: [local(5470)] });
    assert.deepEqual(await planConnect(R1, OFF, CELL_A, f.steps), { kind: 'saved' });
    assert.deepEqual(f.calls, ['probe 127.0.0.1:5466']);
  });

  it('a robot connected to its saved address with its saved login keeps its session; nothing is probed', async () => {
    const f = fakeSteps();
    const on: SessionNow = { connected: true, host: '127.0.0.1', port: 5466, sameLogin: true };
    assert.deepEqual(await planConnect(R1, on, CELL_A, f.steps), { kind: 'keep' });
    assert.deepEqual(f.calls, []);
  });

  it('a connected robot whose saved port changed gets the same checks as one that is not connected', async () => {
    const on: SessionNow = { connected: true, host: '127.0.0.1', port: 5470, sameLogin: true };
    const alive = fakeSteps({ answering: [5466] });
    assert.deepEqual(await planConnect(R1, on, CELL_A, alive.steps), { kind: 'saved' });
    assert.deepEqual(alive.calls, ['probe 127.0.0.1:5466']);
    // The saved port answers nothing: it asks, and Cancel leaves the session as it is.
    const dead = fakeSteps({ answering: [5470], found: [local(5470)] });
    assert.deepEqual(await planConnect(R1, on, CELL_A, dead.steps), { kind: 'stop', why: 'declined' });
    assert.deepEqual(dead.calls, ['probe 127.0.0.1:5466', 'find', 'ask']);
  });

  it('a connected robot whose saved host or login changed is connected again, not kept', async () => {
    const f = fakeSteps({ answering: [5466] });
    const otherLogin: SessionNow = { connected: true, host: '127.0.0.1', port: 5466, sameLogin: false };
    assert.deepEqual(await planConnect(R1, otherLogin, undefined, f.steps), { kind: 'saved' });
    const otherHost: SessionNow = { connected: true, host: '192.0.2.10', port: 5466, sameLogin: true };
    assert.deepEqual(await planConnect(R1, otherHost, undefined, f.steps), { kind: 'saved' });
  });

  it('a robot on another machine, or saved without a port, connects to its saved address with no probe here', async () => {
    const f = fakeSteps();
    assert.deepEqual(await planConnect({ ...R1, host: '192.0.2.10', port: 443 }, OFF, CELL_A, f.steps), { kind: 'saved' });
    assert.deepEqual(await planConnect({ ...R1, port: undefined }, OFF, CELL_A, f.steps), { kind: 'saved' });
    assert.deepEqual(f.calls, []);
  });

  it('the scan cannot run: stop, name the robot and its address, send nothing', async () => {
    const f = fakeSteps({ findThrows: new Error('invalid options') });
    const plan = await planConnect(R1, OFF, CELL_A, f.steps);
    assert.deepEqual(plan, {
      kind: 'stop', why: 'no-answer',
      message: '"R1" does not answer on 127.0.0.1:5466, and this PC could not be searched for it (invalid options). Nothing was sent.',
    });
    assert.deepEqual(f.calls, ['probe 127.0.0.1:5466', 'find']);
  });

  it('no other controller of its protocol answers: stop, send nothing, and pass on what the scan said', async () => {
    const note = 'Could not list this PC\'s listening ports (netstat failed); virtual controllers on this PC were not searched.';
    const f = fakeSteps({
      found: [local(5466), local(50959, {}, true), local(5480, { identified: false, realm: 'other realm' })],
      notes: [note],
    });
    const plan = await planConnect(R1, OFF, CELL_A, f.steps);
    assert.equal(plan.kind, 'stop');
    assert.equal(plan.kind === 'stop' && plan.why, 'no-answer');
    assert.equal(plan.kind === 'stop' && plan.message,
      `"R1" does not answer on 127.0.0.1:5466, and no other controller of its protocol answers on this PC. Nothing was sent. ${note}`);
    assert.deepEqual(f.calls, ['probe 127.0.0.1:5466', 'find']);
  });

  it('Cancel in the question: stop, nothing else probed or sent', async () => {
    const f = fakeSteps({ found: [local(5470)], answering: [5470] });
    assert.deepEqual(await planConnect(R1, OFF, CELL_A, f.steps), { kind: 'stop', why: 'declined' });
    assert.deepEqual(f.calls, ['probe 127.0.0.1:5466', 'find', 'ask']);
  });

  it('Cancel on the progress during the scan: stop before any question', async () => {
    const f = fakeSteps({ found: [local(5470)], cancelAfterFind: true });
    assert.deepEqual(await planConnect(R1, OFF, CELL_A, f.steps), { kind: 'stop', why: 'cancelled' });
    assert.ok(!f.calls.includes('ask'));
  });

  it('a yes: the chosen controller is probed again on the address shown, then connected on its port', async () => {
    const robot = { ...R1, host: 'localhost' };
    const f = fakeSteps({ found: [local(5470), local(5480)], answering: [5470, 5480], pick: q => q.choices[1].controller });
    assert.deepEqual(await planConnect(robot, OFF, CELL_A, f.steps), { kind: 'chosen', port: 5480, useHttps: true });
    assert.deepEqual(f.calls, ['probe localhost:5466', 'find', 'ask', 'probe localhost:5480']);
  });

  it('a yes for a controller that no longer answered while the question was open: stop, send nothing', async () => {
    const f = fakeSteps({ found: [local(5470)], answering: [5470], goneAfterAsk: [5470], pick: q => q.choices[0].controller });
    assert.deepEqual(await planConnect(R1, OFF, CELL_A, f.steps), {
      kind: 'stop', why: 'no-answer',
      message: '"R1": nothing answers on 127.0.0.1:5470 now, so nothing was sent. Connect again to look for it.',
    });
  });

  it('a controller found with the system id the robot last connected to is still asked about', async () => {
    const same = local(5470, { systemId: CELL_A.systemId, systemName: 'Cell_A' });
    const f = fakeSteps({ found: [same], answering: [5470] });
    assert.deepEqual(await planConnect(R1, OFF, CELL_A, f.steps), { kind: 'stop', why: 'declined' });
    assert.equal(f.questions.length, 1);
    assert.match(f.questions[0].detail, /"R1" last connected to Cell_A/);
  });

  it('a robot that never connected on this PC is asked about with no "last connected" line', async () => {
    const f = fakeSteps({ found: [local(5470)], answering: [5470] });
    await planConnect(R1, OFF, undefined, f.steps);
    assert.equal(f.questions.length, 1);
    assert.doesNotMatch(f.questions[0].detail, /last connected/);
  });

  it('the "nothing answers" message says "no other controller" when the robot\'s protocol is not saved', () => {
    assert.equal(noAnswerMessage({ name: 'R1', host: '127.0.0.1', port: 5466 }, { notes: [] }),
      '"R1" does not answer on 127.0.0.1:5466, and no other controller answers on this PC. Nothing was sent.');
  });
});

describe('Connect: the attempts', () => {
  function attempts(o: { errors?: unknown[]; answering?: boolean[]; cancelAt?: number } = {}) {
    const calls: string[] = [];
    let n = 0;
    let probes = 0;
    const steps = {
      connect: async () => {
        n++;
        calls.push(`connect ${n}`);
        const e = o.errors?.[n - 1];
        if (e !== undefined) { throw e; }
      },
      answers: async () => { calls.push('probe'); return o.answering?.[probes++] ?? true; },
      cancelled: () => o.cancelAt !== undefined && n >= o.cancelAt,
      wait: async (ms: number) => { calls.push(`wait ${ms}`); },
      report: () => undefined,
    };
    return { steps, calls };
  }

  it('connects once when the controller answers', async () => {
    const a = attempts();
    assert.deepEqual(await connectWithRetries(a.steps), { kind: 'connected' });
    assert.deepEqual(a.calls, ['connect 1']);
  });

  it('a busy controller is probed again before each retry', async () => {
    const a = attempts({ errors: [new Error('HTTP 503'), new Error('controller busy')] });
    assert.deepEqual(await connectWithRetries(a.steps), { kind: 'connected' });
    assert.deepEqual(a.calls, ['connect 1', 'wait 3000', 'probe', 'connect 2', 'wait 3000', 'probe', 'connect 3']);
  });

  it('a busy controller that answers nothing any more ends the retries: nothing more is sent', async () => {
    const a = attempts({ errors: [new Error('HTTP 503')], answering: [false] });
    assert.deepEqual(await connectWithRetries(a.steps), { kind: 'gone' });
    assert.deepEqual(a.calls, ['connect 1', 'wait 3000', 'probe']);
  });

  it('another error ends the attempts at once', async () => {
    const e = new Error('401 Unauthorized');
    const a = attempts({ errors: [e] });
    assert.deepEqual(await connectWithRetries(a.steps), { kind: 'failed', error: e });
    assert.deepEqual(a.calls, ['connect 1']);
  });

  it('Cancel before an attempt sends nothing; Cancel after a busy attempt reports that attempt\'s error', async () => {
    const before = attempts({ cancelAt: 0 });
    assert.deepEqual(await connectWithRetries(before.steps), { kind: 'cancelled' });
    assert.deepEqual(before.calls, []);
    const busy = new Error('HTTP 503');
    const after = attempts({ errors: [busy], cancelAt: 1 });
    assert.deepEqual(await connectWithRetries(after.steps), { kind: 'failed', error: busy });
  });

  it('stops after the last attempt', async () => {
    const busy = new Error('HTTP 503');
    const a = attempts({ errors: [busy, busy, busy] });
    assert.deepEqual(await connectWithRetries(a.steps, 3), { kind: 'failed', error: busy });
    assert.equal(a.calls.filter(c => c.startsWith('connect')).length, 3);
  });
});

describe('Connect: what stays once the connect returned', () => {
  const base: AfterConnect = {
    plan: { kind: 'saved' }, local: true,
    saved: { port: 5466, useHttps: true }, asked: { port: 5466, useHttps: true }, memory: { port: 5466, useHttps: true },
    connected: true, currentPort: 5466, reading: { name: 'Cell_A', sysid: CELL_A.systemId }, last: CELL_A,
  };
  const chosen = { kind: 'chosen', port: 5470, useHttps: true } as const;

  it('the saved address, same system as last time: record it, nothing to save', () => {
    assert.deepEqual(settleConnect(base), { kind: 'done', record: true, verifyLater: false });
  });

  it('a robot that never connected on this PC: record what it connected to', () => {
    assert.deepEqual(settleConnect({ ...base, last: undefined }), { kind: 'done', record: true, verifyLater: false });
  });

  it('the saved address answers as another system: disconnect and ask, nothing saved or recorded', () => {
    const reading = { name: 'Cell_B', sysid: 'another' };
    assert.deepEqual(settleConnect({ ...base, reading }), { kind: 'different', reading });
  });

  it('no system id read yet: nothing recorded now, checked once it is read', () => {
    assert.deepEqual(settleConnect({ ...base, reading: null }), { kind: 'done', record: false, verifyLater: true });
    assert.deepEqual(settleConnect({ ...base, reading: null, last: undefined }), { kind: 'done', record: true, verifyLater: false });
  });

  it('a chosen port that connected is saved and its system recorded, whatever the robot connected to before', () => {
    const at = { ...base, plan: chosen, asked: { port: 5470, useHttps: true }, memory: { port: 5470, useHttps: true }, currentPort: 5470,
      reading: { sysid: 'another' } };
    assert.deepEqual(settleConnect(at), { kind: 'save', port: 5470, useHttps: true, record: true, verifyLater: false });
  });

  it('a chosen port that did not connect is not kept: memory goes back to the saved port', () => {
    const at = { ...base, plan: chosen, asked: { port: 5470, useHttps: true }, memory: { port: 5470, useHttps: true }, connected: false };
    assert.deepEqual(settleConnect(at), { kind: 'not-connected', restore: { port: 5466, useHttps: true } });
  });

  it('a port changed outside this window during a failed connect is kept', () => {
    const at = { ...base, plan: chosen, asked: { port: 5470, useHttps: true }, memory: { port: 5999, useHttps: true }, connected: false };
    assert.deepEqual(settleConnect(at), { kind: 'not-connected' });
    assert.deepEqual(settleConnect({ ...base, memory: { port: 5999, useHttps: true }, connected: false }), { kind: 'not-connected' });
  });

  it('on this PC, a session on another port than the one asked for is dropped and nothing is saved', () => {
    // The saved port no longer answered during the connect and another controller answered.
    const moved = { ...base, currentPort: 5480, memory: { port: 5480, useHttps: true } };
    assert.deepEqual(settleConnect(moved), { kind: 'elsewhere', port: 5480, restore: { port: 5466, useHttps: true } });
    // The same after a yes: memory goes back to the saved port, not the chosen one.
    const afterYes = { ...moved, plan: chosen, asked: { port: 5470, useHttps: true } };
    assert.deepEqual(settleConnect(afterYes), { kind: 'elsewhere', port: 5480, restore: { port: 5466, useHttps: true } });
  });

  it('another machine: a port the client found on the robot\'s own host is saved once its system matches', () => {
    const remote = { ...base, local: false, saved: { port: 443, useHttps: true }, asked: { port: 443, useHttps: true },
      memory: { port: 8443, useHttps: true }, currentPort: 8443 };
    assert.deepEqual(settleConnect(remote), { kind: 'save', port: 8443, useHttps: true, record: true, verifyLater: false });
    const reading = { sysid: 'another' };
    assert.deepEqual(settleConnect({ ...remote, reading }), { kind: 'different', reading, restore: { port: 443, useHttps: true } });
  });

  it('a robot saved without a port keeps the port the client found, as before', () => {
    const auto = { ...base, saved: {}, asked: {}, memory: { port: 5466, useHttps: true } };
    assert.deepEqual(settleConnect(auto), { kind: 'save', port: 5466, useHttps: true, record: true, verifyLater: false });
  });

  it('a kept session changes nothing', () => {
    assert.deepEqual(settleConnect({ ...base, plan: { kind: 'keep' }, reading: { sysid: 'another' } }), { kind: 'done', record: false, verifyLater: false });
  });
});

describe('Connect: the messages', () => {
  it('another system on the saved address: names the robot, the address, the system there and the one last seen', () => {
    const q = differentSystemQuestion({ name: 'R1', host: '127.0.0.1', port: 5466 }, { name: 'Cell_B', rwVersion: '8.2.1', sysid: 'b' }, CELL_A);
    assert.equal(q.message, '"R1" answers on 127.0.0.1:5466 as another controller than last time. Keep this controller as "R1"?');
    assert.equal(q.detail, [
      'On 127.0.0.1:5466: Cell_B, RobotWare 8.2.1.',
      '"R1" last connected to Cell_A, RobotWare 7.21.4+417.',
      'RAPID Live disconnected it and saved nothing.',
      'Connect to this controller connects again and takes it as "R1" from now on. Cancel leaves it disconnected.',
    ].join('\n'));
    assert.equal(q.accept, 'Connect to this controller');
  });

  it('two systems with one name are told apart by their system ids', () => {
    const q = differentSystemQuestion({ name: 'R1', host: '127.0.0.1', port: 5466 }, { name: 'Cell_A', sysid: 'b' }, CELL_A);
    assert.match(q.detail, /^On 127\.0\.0\.1:5466: Cell_A \(system id b\)\.$/m);
    assert.match(q.detail, new RegExp(`last connected to Cell_A, RobotWare 7\\.21\\.4\\+417 \\(system id ${CELL_A.systemId}\\)\\.`));
  });

  it('the session that landed on another port, and the retries that stopped, name the robot and its address', () => {
    assert.equal(elsewhereMessage({ name: 'R1', host: '127.0.0.1' }, 5466, 5480),
      '"R1" no longer answered on 127.0.0.1:5466 during the connect, and another controller on this PC answered on port 5480. '
      + 'RAPID Live disconnected from it and saved nothing. Connect again to look for "R1".');
    assert.equal(goneMessage({ name: 'R1', host: '127.0.0.1', port: 5466 }),
      'Connect to "R1" stopped: nothing answers on 127.0.0.1:5466 now. Connect again to look for it.');
  });
});

describe('Connect: one at a time per robot', () => {
  it('two Connects for one robot ask once; the second does nothing', async () => {
    const running = new Set<string>();
    const f = fakeSteps({ found: [local(5470)], answering: [5470] });
    let answer!: (c: FoundController | undefined) => void;
    f.steps.ask = q => { f.calls.push('ask'); f.questions.push(q); return new Promise(r => { answer = r; }); };
    const first = onceAtATime(running, 'r1', () => planConnect(R1, OFF, CELL_A, f.steps));
    const second = await onceAtATime(running, 'r1', () => planConnect(R1, OFF, CELL_A, f.steps));
    assert.equal(second, undefined);
    // Let the first reach its question, then answer it.
    while (!answer) { await new Promise(r => setImmediate(r)); }
    answer(undefined);
    assert.deepEqual(await first, { kind: 'stop', why: 'declined' });
    assert.equal(f.calls.filter(c => c === 'ask').length, 1);
    assert.equal(running.size, 0);
  });

  it('other robots run alongside, and a robot is free again once its Connect ended, also after an error', async () => {
    const running = new Set<string>();
    let release!: () => void;
    const slow = onceAtATime(running, 'r1', () => new Promise<string>(r => { release = () => r('r1'); }));
    assert.equal(await onceAtATime(running, 'r2', async () => 'r2'), 'r2');
    release();
    assert.equal(await slow, 'r1');
    await assert.rejects(onceAtATime(running, 'r1', async () => { throw new Error('boom'); }));
    assert.equal(await onceAtATime(running, 'r1', async () => 'again'), 'again');
  });
});

describe('Connect: the command runs the flow above', () => {
  const body = (): string => sliceOf(extensionSrc(), 'const connectOnce = async', '\n  };\n');

  it('the command runs one Connect per robot at a time', () => {
    const cmd = sliceOf(extensionSrc(), "tracedCommand('abbRobot.connectRobot'", 'tracedCommand(');
    assert.match(cmd, /onceAtATime\(connectsInFlight, targetId, \(\) => connectOnce\(targetId\)\)/);
    assert.doesNotMatch(cmd, /multi\.connectRobot/);
  });

  it('plans before it connects, and a stop ends it before any manager is replaced or connected', () => {
    const fn = body();
    const plan = fn.indexOf('plan = await planConnect(');
    const stop = fn.indexOf("if (plan.kind === 'stop') { return; }");
    const fresh = fn.indexOf('multi.addRobot(');
    const connect = fn.indexOf('await multi.connectRobot(id)');
    assert.ok(plan >= 0 && plan < stop && stop < fresh && fresh < connect);
  });

  it('every connect but a kept session runs on a fresh manager, with the chosen port when there is one', () => {
    assert.match(body(), /if \(plan\.kind !== 'keep'\) \{[\s\S]*?await endConnection\(multi, id\)[\s\S]*?multi\.addRobot\(\{ \.\.\.entry\.config, \.\.\.\(plan\.kind === 'chosen' \? \{ port: plan\.port, useHttps: plan\.useHttps \} : \{\}\) \}\);/);
  });

  it('the probes and the scan send no credentials', () => {
    const steps = sliceOf(extensionSrc(), 'function connectPlanSteps(', '\n}\n');
    assert.match(steps, /RobotManager\.probeSpecificPort\(host, port, strictTls\)/);
    assert.match(steps, /RobotManager\.findControllers\(\{ local: true, identify: 'anonymous', filterToVcProcesses: false, strictTls \}\)/);
    assert.doesNotMatch(steps, /with-credentials|credentials:|password/);
  });

  it('a session that landed on another port or another system is disconnected; nothing is saved for it', () => {
    const fn = body();
    assert.match(fn, /case 'elsewhere': \{\n\s*await endConnection\(multi, id\)/);
    assert.match(fn, /case 'different':[\s\S]*?askDifferentSystem\(id, outcome\.reading/);
    const ask = sliceOf(extensionSrc(), 'const askDifferentSystem = async', '\n  };\n');
    assert.ok(ask.indexOf('await endConnection(multi, id)') < ask.indexOf('showWarningMessage('));
  });

  it('the Reconnect button of a lost connection runs Connect for that robot, never the client\'s own reconnect', () => {
    const src = extensionSrc();
    assert.doesNotMatch(src, /multi\.onError\(/);
    const wire = sliceOf(src, 'const wireErrors = ', '\n  };\n');
    assert.match(wire, /if \(choice !== 'Reconnect'\) \{ return choice; \}/);
    assert.match(wire, /executeCommand\('abbRobot\.connectRobot', id\);\n\s*return undefined;/);
    assert.match(src, /for \(const \{ id, manager \} of multi\.entries\) \{ wireErrors\(id, manager\); \}/);
    assert.match(src, /if \(entry\) \{ wireErrors\(id, entry\.manager\); \}/);
  });
});

describe('Connect: the client gives a robot a fresh manager in place', () => {
  const config = (id: string, port: number) => ({ id, name: id, host: '127.0.0.1', port, useHttps: true, username: 'u', password: 'p' });

  it('addRobot with a saved robot\'s id replaces its manager and config, and the list keeps its order', () => {
    const multi = MultiRobotManager.fromConfigs([config('r1', 5466), config('r2', 5480)]);
    multi.setActive('r1');
    const before = multi.entries.find(e => e.id === 'r1')!.manager;
    multi.addRobot(config('r1', 5470));
    assert.deepEqual(multi.entries.map(e => e.id), ['r1', 'r2']);
    const after = multi.entries.find(e => e.id === 'r1')!;
    assert.notEqual(after.manager, before);
    assert.equal(after.config.port, 5470);
    assert.equal(multi.activeId, 'r1');
    assert.equal(multi.active, after.manager);
  });
});

describe('a scanned port the controller has not confirmed (tracker 573)', () => {
  it('the question names the robot, the port, the robot last seen, and says writes are held and nothing is sent', () => {
    const q = unverifiedPortQuestion('Cell 3', 5470, { systemId: '{abc}', systemName: 'IRB1200_VC', rwVersion: '7.21.4' });
    assert.equal(q.message, 'Save port 5470 for "Cell 3"?');
    assert.equal(q.button, 'Save port 5470');
    assert.match(q.detail, /found by scanning this PC\. The controller did not say its system id, so RAPID Live cannot confirm it is the one last seen \(IRB1200_VC \(system id \{abc\}\)\)\. Writes to it are held back until the controller confirms it\. Nothing is sent by this choice\.$/);
    assert.match(unverifiedPortQuestion('Cell 3', 80, { systemId: '{abc}' }).detail, /last seen \(system \{abc\}\)/);
  });

  it('the refusal names the robot and the way back', () => {
    assert.equal(unverifiedWriteRefusal('Start RAPID', 'Cell 3 (127.0.0.1:5470)'),
      'Start RAPID not sent: Cell 3 (127.0.0.1:5470) answered on a port RAPID Live found by scanning, and the controller has not confirmed its system id yet. Connect again once it has, or check the robot\'s address.');
  });

  it('the connect asks before saving such a port, holds writes through the refusal hook, and lets go once a reading confirms or the session ends', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.match(src, /if \(outcome\.verifyLater && last\) \{[\s\S]*?unverifiedPorts\.add\(id\);\s*const q = unverifiedPortQuestion\(name, outcome\.port, last\);[\s\S]*?=== q\.button\) \{ await saveConnectedPort\(id, name, saved, outcome\); \}/);
    assert.match(src, /if \(unverifiedPorts\.has\(entry\.id\)\) \{ return unverifiedWriteRefusal\(label, robotLabel\(confirmRobotOf\(entry\)\)\); \}/);
    assert.match(src, /unverifiedSessions\.delete\(id\); unverifiedPorts\.delete\(id\); return; \}/);
    assert.match(src, /unverifiedSessions\.delete\(id\);\s*unverifiedPorts\.delete\(id\);\s*if \(verdict === 'different' && reading\)/);
  });
});
