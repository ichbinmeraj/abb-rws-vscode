// A stub RWS 2.0 controller for the host harness: enough of RobotWare 7's
// answers for the client to connect and poll, and a record of every request,
// so a run can show that no write left the extension. Not a controller: every
// write (POST, PUT, DELETE) is refused with 403 and recorded, and the
// subscription is refused, so the client polls.
//
// What a controller looks like to the client's port probe: an unauthenticated
// request is answered 401 with a Basic challenge (RobotWare 7 and 8 answer
// `Basic realm="validusers@robapi.abb"`); with any Authorization header the
// request is answered. Bodies are HAL JSON, the representation the client
// asks for: `{"_links":{"base":{"href":…}},"state":[{"_type":…}]}`.
//
//   const stub = await startStub({ ctrlType: 'real', logFile });   // 'real' | 'none' | 'virtual'
//   stub.url, stub.requests, await stub.close()
//
// `ctrlType` is what /ctrl/identity reports as ctrl-type: REAL_CONTROLLER,
// no ctrl-type at all, or VIRTUAL_CONTROLLER. Every request is appended to
// `logFile` as one JSON line, so the suite inside the VS Code host can see
// when the client has read the identity.

'use strict';
const fs = require('node:fs');
const http = require('node:http');

const CTRL_TYPES = { real: 'REAL_CONTROLLER', none: undefined, virtual: 'VIRTUAL_CONTROLLER' };

function hal(type, fields, title = type) {
  return JSON.stringify({ _links: { base: { href: 'http://stub/' } }, state: [{ _type: type, _title: title, ...fields }] });
}

/**
 * The reads the client's connect and polling send, answered like a RobotWare
 * 7.21.4 virtual controller at rest. The joint and cartesian reads must answer:
 * the client's poll treats their 404 as a lost controller and disconnects.
 */
function answersFor(ctrlType) {
  const identity = { 'ctrl-name': 'STUB_RWS', ...(ctrlType ? { 'ctrl-type': ctrlType } : {}) };
  const zero = fields => Object.fromEntries(fields.map(f => [f, '0']));
  return {
    '/rw/system': hal('sys-system', { name: 'STUB_RWS', rwversion: '7.21.4+417', sysid: '{0a0a0a0a-1b1b-2c2c-3d3d-4e4e4e4e4e4e}', starttm: '2026-10-30 10:00:00' }),
    '/ctrl/identity': hal('ctrl-identity-info', identity),
    '/rw/rapid/execution': hal('rap-execution', { ctrlexecstate: 'stopped', cycle: 'forever' }),
    '/rw/panel/opmode': hal('pnl-opmode', { opmode: 'AUTO' }),
    '/rw/panel/ctrl-state': hal('pnl-ctrlstate', { ctrlstate: 'motoroff' }),
    '/rw/panel/speedratio': hal('pnl-speedratio', { speedratio: '100' }),
    '/rw/rapid/tasks': hal('rap-task-li', { name: 'T_ROB1', type: 'normal', taskstate: 'linked', excstate: 'stopped', active: 'On', motiontask: 'TRUE' }, 'T_ROB1'),
    '/rw/rapid/tasks/T_ROB1/modules': hal('rap-module-info-li', { name: 'user', type: 'SysMod' }, 'user'),
    '/rw/motionsystem/mechunits': hal('ms-mechunit-li', { name: 'ROB_1', mode: 'Activated' }, 'ROB_1'),
    '/rw/motionsystem/mechunits/ROB_1/jointtarget': hal('ms-jointtarget', zero(['rax_1', 'rax_2', 'rax_3', 'rax_4', 'rax_5', 'rax_6', 'eax_a', 'eax_b', 'eax_c', 'eax_d', 'eax_e', 'eax_f'])),
    '/rw/motionsystem/mechunits/ROB_1/cartesian': hal('ms-mechunit-cartesian', { ...zero(['x', 'y', 'z', 'q2', 'q3', 'q4', 'cf1', 'cf4', 'cf6', 'cfx']), q1: '1' }),
  };
}

exports.CTRL_TYPES = CTRL_TYPES;

exports.startStub = async function startStub({ ctrlType = 'real', logFile } = {}) {
  if (!(ctrlType in CTRL_TYPES)) { throw new Error(`ctrlType ${ctrlType}: real, none or virtual`); }
  const answers = answersFor(CTRL_TYPES[ctrlType]);
  const requests = [];
  const record = entry => {
    requests.push(entry);
    if (logFile) { try { fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); } catch { /* the record in memory stands */ } }
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = String(req.url || '').split('?')[0];
      const authed = !!req.headers.authorization;
      const entry = { ts: new Date().toISOString(), method: req.method, path: String(req.url || ''), authed, status: 0 };
      const answer = (status, body, type) => {
        entry.status = status;
        record(entry);
        res.writeHead(status, body ? { 'Content-Type': type || 'application/hal+json;v=2.0' } : {});
        res.end(body || '');
      };
      if (!authed) { res.setHeader('WWW-Authenticate', 'Basic realm="validusers@robapi.abb"'); return answer(401, 'Unauthorized', 'text/plain'); }
      if (req.method === 'POST' && path === '/subscription') { return answer(404, '{}'); }
      if (req.method !== 'GET') { return answer(403, '{"_embedded":{"status":{"code":403,"msg":"the stub refuses every write"}}}'); }
      const body = answers[path];
      return body ? answer(200, body) : answer(404, '{}');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    /**
     * Requests that would change a controller: everything but GET, apart from the
     * subscription the client sets up and the searches, which RWS 2.0 takes as a
     * POST with the query in the body (symbol search, I/O device and signal
     * search): reads on the wire, refused here like every POST.
     */
    writes: () => requests.filter(r => r.method !== 'GET' && !(r.method === 'POST' && (r.path === '/subscription' || /search/.test(r.path)))),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
};
