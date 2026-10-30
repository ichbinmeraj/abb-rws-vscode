import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
// The harness files are plain CommonJS: loaded as they run, not bundled.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stubRws = require(path.join(root, 'test', 'host', 'stub-rws.js')) as { startStub(o: { ctrlType: string; logFile?: string }): Promise<Stub> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const w1 = require(path.join(root, 'test', 'host', 'stub-ext', 'w1.js')) as { WRITE_COMMANDS: string[] };

interface Stub { port: number; url: string; requests: Array<{ method: string; path: string; status: number; authed: boolean }>; writes(): Array<{ method: string; path: string }>; close(): Promise<void> }

function request(url: string, method: string, auth: boolean): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: auth ? { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` } : {} }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the stub controller of the host harness', () => {
  it('answers an unauthenticated request with a Basic challenge, like RobotWare 7 and 8, and HAL JSON with one', async () => {
    const stub = await stubRws.startStub({ ctrlType: 'real' });
    try {
      const anon = await request(`${stub.url}/rw/system`, 'GET', false);
      assert.equal(anon.status, 401);
      assert.match(String(anon.headers['www-authenticate']), /^Basic realm=/);
      const system = await request(`${stub.url}/rw/system`, 'GET', true);
      assert.equal(system.status, 200);
      assert.match(String(system.headers['content-type']), /hal\+json/);
      const state = (JSON.parse(system.body) as { state: Array<Record<string, string>> }).state[0];
      assert.equal(state._type, 'sys-system');
      assert.equal(state.rwversion, '7.21.4+417');
      const identity = (JSON.parse((await request(`${stub.url}/ctrl/identity`, 'GET', true)).body) as { state: Array<Record<string, string>> }).state[0];
      assert.equal(identity['ctrl-type'], 'REAL_CONTROLLER');
    } finally { await stub.close(); }
  });

  it('a controller that does not say its type, and a virtual one', async () => {
    for (const [ctrlType, want] of [['none', undefined], ['virtual', 'VIRTUAL_CONTROLLER']] as const) {
      const stub = await stubRws.startStub({ ctrlType });
      try {
        const identity = (JSON.parse((await request(`${stub.url}/ctrl/identity`, 'GET', true)).body) as { state: Array<Record<string, string>> }).state[0];
        assert.equal(identity['ctrl-type'], want, ctrlType);
      } finally { await stub.close(); }
    }
    await assert.rejects(stubRws.startStub({ ctrlType: 'other' }), /real, none or virtual/);
  });

  it('refuses every write with 403 and records it; the subscription is refused with 404 and is not a write; a log file gets one line per request', async () => {
    const logFile = path.join(fs.mkdtempSync(path.join(root, 'out', 'stub-')), 'stub.jsonl');
    const stub = await stubRws.startStub({ ctrlType: 'real', logFile });
    try {
      assert.equal((await request(`${stub.url}/rw/rapid/execution/start`, 'POST', true)).status, 403);
      assert.equal((await request(`${stub.url}/fileservice/$HOME/x.mod`, 'DELETE', true)).status, 403);
      assert.equal((await request(`${stub.url}/subscription`, 'POST', true)).status, 404);
      assert.equal((await request(`${stub.url}/rw/panel/opmode`, 'GET', true)).status, 200);
      assert.equal((await request(`${stub.url}/rw/nothing`, 'GET', true)).status, 404);
      assert.deepEqual(stub.writes().map(r => `${r.method} ${r.path}`), ['POST /rw/rapid/execution/start', 'DELETE /fileservice/$HOME/x.mod']);
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { method: string; path: string; status: number });
      assert.equal(lines.length, 5);
      assert.deepEqual(lines.map(l => l.status), [403, 403, 404, 200, 404]);
    } finally { await stub.close(); fs.rmSync(path.dirname(logFile), { recursive: true, force: true }); }
  });
});

describe('the W1 step and the CI host job', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

  it('W1 runs every command whose handler reaches a send wrapper, Set Robot Mode left out on purpose', () => {
    const ids = [...src.matchAll(/tracedCommand\('([^']+)'/g)].map(m => m[1]);
    const writers = ids.filter(id => {
      const start = src.indexOf(`tracedCommand('${id}'`);
      const end = src.indexOf('tracedCommand(', start + 1);
      const body = src.slice(start, end < 0 ? undefined : end);
      return /\b(sendTo|sendMotion|sendReducingTo|loadModuleFile|preflightModuleFile|pushDepsFor|requestRmmpInteractive|withdrawFor|withdrawTargetOf|allowFor|releaseOwnLocks)\(|watchProvider\.writeValue\(/.test(body);
    }).filter(id => id !== 'abbRobot.setRobotMode');
    assert.deepEqual([...w1.WRITE_COMMANDS].sort(), writers.sort());
    assert.ok(w1.WRITE_COMMANDS.length >= 55, `${w1.WRITE_COMMANDS.length} write commands`);
  });

  it('the harness starts the stub for RWS_TEST_STUB, runs W1 by default then, and fails on any write the stub saw or when no W1 step ran', () => {
    const runner = fs.readFileSync(path.join(root, 'test', 'host', 'run-commands.test.js'), 'utf8');
    assert.match(runner, /const STUB = String\(process\.env\.RWS_TEST_STUB \|\| ''\)\.toLowerCase\(\);/);
    assert.match(runner, /const stub = STUB \? await startStub\(\{ ctrlType: STUB, logFile: stubLog \}\) : null;/);
    assert.match(runner, /assert\.deepStrictEqual\(stub\.writes\(\)\.map\(r => `\$\{r\.method\} \$\{r\.path\}`\), \[\], 'a write reached the stub controller'\);/);
    assert.match(runner, /assert\.ok\(rows\.some\(r => \/\^W1 \/\.test\(r\.step\)\), 'the stub run ran no W1 step'\);/);
    const suite = fs.readFileSync(path.join(root, 'test', 'host', 'stub-ext', 'suite.js'), 'utf8');
    assert.match(suite, /if \(uOnly && tokens\.length === 1 && tokens\[0\] === 'W1'\) \{ await w1\.stepW1\(uctx\); return; \}/);
    assert.match(suite, /match\(\/U\[1-4\]\|W1\|L1\|\[A-I\]\/g\)/);
  });

  it('the CI host job runs W1 against the stub as a real controller and as one that does not say, so it no longer only skips', () => {
    const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    for (const kind of ['real', 'none']) {
      assert.match(ci, new RegExp(`RWS_TEST_ONLY: W1\\n\\s+RWS_TEST_STUB: ${kind}\\n`), kind);
    }
    assert.match(ci, /id: w1real\n/);
    assert.match(ci, /id: w1none\n/);
    assert.match(ci, /W1REAL: \$\{\{ steps\.w1real\.outcome \}\}/);
  });
});
