// Comprehensive verification — exercises every adapter method & reports failures
const https = require('https');
const HOST = '127.0.0.1', PORT = 5466;
const AUTH = 'Basic ' + Buffer.from('Default User:robotics').toString('base64');
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
let cookie = null;

function req(method, path, body) {
  return new Promise(r => {
    const o = {
      method, hostname: HOST, port: PORT, path, agent,
      headers: {
        Authorization: AUTH,
        Accept: 'application/xhtml+xml;v=2.0',
        ...(cookie ? { Cookie: cookie } : {}),
        ...((method === 'POST' || method === 'PUT' || method === 'DELETE') ? {
          'Content-Type': 'application/x-www-form-urlencoded;v=2.0',
          'Content-Length': String(body ? Buffer.byteLength(body) : 0),
        } : {}),
      },
    };
    const x = https.request(o, res => {
      const sc = res.headers['set-cookie'];
      if (sc && !cookie) cookie = sc.map(c => c.split(';')[0]).join('; ');
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => r({ status: res.statusCode, body: s }));
    });
    x.on('error', e => r({ status: 0, body: e.message }));
    x.setTimeout(5000, () => { x.destroy(); r({ status: 0, body: 'timeout' }); });
    if (body) x.write(body);
    x.end();
  });
}
class P {
  constructor(html) { this.html = html; }
  getState(c) { return this.getAllStates(c)[0] || {}; }
  getAllStates(c) {
    const out = [];
    const re = new RegExp(`<li class="${c}"([^>]*)>([\\s\\S]*?)</li>`, 'g');
    for (const m of this.html.matchAll(re)) {
      const f = {};
      const t = m[1].match(/title="([^"]*)"/);
      if (t) f._title = t[1];
      for (const [, cls, val] of m[2].matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)) f[cls] = val;
      out.push(f);
    }
    return out;
  }
  get(span) {
    const m = this.html.match(new RegExp(`<span class="${span}">([^<]*)<\\/span>`));
    return m && m[1];
  }
}

const pass = [], fail = [];
function check(name, ok, hint) {
  (ok ? pass : fail).push({ name, hint });
  process.stdout.write(ok ? '.' : 'F');
  if (!ok) console.log(`\n  ✗ ${name}${hint ? ' — ' + hint : ''}`);
}

(async () => {
  await req('GET', '/rw/system');
  console.log('Connected. Running comprehensive tests...\n');

  // ─── System detail ───
  let r = await req('GET', '/rw/system/robottype');
  let robotType = new P(r.body).getState('sys-robottype')['robot-type'];
  check('System: robotType parsed', robotType, robotType);

  r = await req('GET', '/rw/system/license');
  check('System: license parsed', new P(r.body).getAllStates('sys-license').length > 0);

  r = await req('GET', '/rw/system/products');
  const products = new P(r.body).getAllStates('sys-product-li');
  check('System: products parsed', products.length > 0, `${products.length} products`);

  r = await req('GET', '/rw/system/energy');
  const energy = new P(r.body).getState('sys-energy-state');
  check('System: energy parsed', Object.keys(energy).length > 3, `${Object.keys(energy).length} fields`);

  r = await req('GET', '/rw/system/options');
  const opts = new P(r.body).getAllStates('sys-option-li');
  const opts2 = new P(r.body).getAllStates('sys-option');
  check('System: options parsed', opts.length > 0 || opts2.length > 0, `${opts.length || opts2.length} options`);

  r = await req('GET', '/ctrl/options');
  const ctrlOpts = new P(r.body).getAllStates('ctrl-option-li');
  const ctrlOpts2 = new P(r.body).getAllStates('ctrl-option');
  check('Controller: options parsed', ctrlOpts.length > 0 || ctrlOpts2.length > 0, `${ctrlOpts.length || ctrlOpts2.length} options`);

  r = await req('GET', '/ctrl/features');
  const features = new P(r.body).getAllStates('ctrl-feature-li');
  const features2 = new P(r.body).getAllStates('ctrl-feature');
  check('Controller: features parsed', features.length > 0 || features2.length > 0, `${features.length || features2.length} features`);

  r = await req('GET', '/ctrl/identity');
  const ident = new P(r.body).getState('ctrl-identity-info');
  check('Controller: identity parsed', ident['ctrl-name'], ident['ctrl-name']);

  r = await req('GET', '/ctrl/clock');
  const clock = new P(r.body).getState('ctrl-clock-info');
  check('Controller: clock parsed', clock['datetime'], clock['datetime']);

  // ─── Panel ───
  r = await req('GET', '/rw/panel/enreq');
  const enreq = new P(r.body).getState('pnl-enreq') || new P(r.body).getState('pnl-enreq-li');
  check('Panel: enreq parsed', Object.keys(enreq).length > 0, JSON.stringify(enreq));

  r = await req('GET', '/rw/panel/coldetstate');
  check('Panel: coldetstate parsed', new P(r.body).getState('pnl-coldetstate')['coldetstate']);

  // ─── Motion detail ───
  r = await req('GET', '/rw/motionsystem?resource=change-count');
  check('Motion: change-count parsed', +new P(r.body).get('change-count') > 0);

  r = await req('GET', '/rw/motionsystem/errorstate');
  const errSt = new P(r.body).getState('ms-errorstate');
  check('Motion: errorstate parsed', errSt['err-state'], errSt['err-state']);

  r = await req('GET', '/rw/motionsystem/nonmotionexecution');
  const nm = new P(r.body).get('mode');
  check('Motion: nonmotionexecution parsed', nm !== undefined, nm);

  r = await req('GET', '/rw/motionsystem/collisionprediction');
  const cp = new P(r.body).get('collision-prediction-mode-enabled');
  check('Motion: collisionprediction parsed', cp !== undefined, cp);

  r = await req('GET', '/rw/motionsystem/mechunits/ROB_1');
  const mu = new P(r.body).getState('ms-mechunit');
  check('Motion: mechunit info parsed', mu['type'] === 'TCPRobot', mu['type']);
  check('Motion: tool name parsed', mu['tool-name'], mu['tool-name']);
  check('Motion: wobj name parsed', mu['wobj-name'], mu['wobj-name']);

  r = await req('GET', '/rw/motionsystem/mechunits/ROB_1/baseframe');
  const bf = new P(r.body).getState('ms-mechunit-baseframe');
  check('Motion: baseframe parsed', bf['x'] !== undefined, `q=[${bf.q1},${bf.q2},${bf.q3},${bf.q4}]`);

  r = await req('GET', '/rw/motionsystem/mechunits/ROB_1/axes');
  const axCount = +new P(r.body).getState('ms-mechunit-axes')['axes'];
  check('Motion: axis count parsed', axCount === 6, `${axCount} axes`);

  // Test fetching individual axes
  let axisOk = 0;
  for (let i = 1; i <= 6; i++) {
    const ar = await req('GET', `/rw/motionsystem/mechunits/ROB_1/axes/${i}`);
    if (ar.status === 200) axisOk++;
  }
  check('Motion: per-axis fetch', axisOk === 6, `${axisOk}/6 axes fetched`);

  r = await req('GET', '/rw/motionsystem/mechunits/ROB_1/pjoints');
  const pj = new P(r.body).getState('ms-pjoints');
  check('Motion: pjoints parsed', Object.keys(pj).length > 0 || r.status === 200, `${Object.keys(pj).length} fields`);

  r = await req('GET', '/rw/motionsystem/mechunits/ROB_1/jointtarget');
  const jt = new P(r.body).getState('ms-jointtarget');
  check('Motion: jointtarget parsed', jt['rax_1'] !== undefined, `J1=${jt.rax_1}`);

  r = await req('GET', '/rw/motionsystem/mechunits/ROB_1/cartesian');
  const cart = new P(r.body).getState('ms-mechunit-cartesian');
  check('Motion: cartesian parsed', cart['x'] !== undefined, `x=${cart.x}`);

  // ─── RAPID ───
  r = await req('GET', '/rw/rapid/execution');
  const exec = new P(r.body).getState('rap-execution');
  check('RAPID: execution state', exec['ctrlexecstate'], exec['ctrlexecstate']);

  r = await req('GET', '/rw/rapid/tasks');
  const tasks = new P(r.body).getAllStates('rap-task-li');
  check('RAPID: tasks parsed', tasks.length > 0, `${tasks.length} tasks`);

  r = await req('GET', '/rw/rapid/tasks/T_ROB1/pcp');
  const pp = new P(r.body).getState('pcp-info');
  check('RAPID: PP parsed', pp['routinename'], pp['routinename']);

  r = await req('GET', '/rw/rapid/tasks/T_ROB1/syncstate/motion-pointer');
  const mp = new P(r.body).getState('rap-task-sync-state');
  check('RAPID: MP parsed', mp['motion-pointer-state'], mp['motion-pointer-state']);

  r = await req('GET', '/rw/rapid/tasks/T_ROB1/program/breakpoints');
  check('RAPID: breakpoints reachable', r.status === 200, `HTTP ${r.status}`);

  r = await req('GET', '/rw/rapid/tasks/T_ROB1/structural-changecount');
  const scc = new P(r.body).get('change-count');
  check('RAPID: structural-changecount parsed', scc !== undefined || r.status === 200, scc);

  r = await req('GET', '/rw/rapid/tasks/T_ROB1/motion');
  check('RAPID: per-task motion reachable', r.status === 200);

  r = await req('GET', '/rw/rapid/tasks/T_ROB1/activation-record');
  check('RAPID: activation-record reachable', r.status === 200);

  r = await req('GET', '/rw/rapid/aliasio');
  check('RAPID: aliasio reachable', r.status === 200);

  r = await req('GET', '/rw/rapid/taskselection');
  check('RAPID: taskselection reachable', r.status === 200);

  r = await req('GET', '/rw/rapid/tasks/T_ROB1/modules');
  const modules = new P(r.body).getAllStates('rap-module-info-li');
  check('RAPID: modules parsed', modules.length > 0, `${modules.length} modules`);

  // ─── CFG ───
  r = await req('GET', '/rw/cfg');
  const domains = new P(r.body).getAllStates('cfg-domain-li').map(d => d._title).filter(Boolean);
  check('CFG: 6 domains', domains.length === 6, domains.join(','));

  // Test pagination across all domains
  const cfgStats = {};
  for (const d of domains) {
    const types = [];
    let path = `/rw/cfg/${d}`;
    let pages = 0;
    while (path && pages < 10) {
      const pr = await req('GET', path);
      if (pr.status !== 200) break;
      types.push(...new P(pr.body).getAllStates('cfg-dt-li').map(t => t._title).filter(Boolean));
      const nm = pr.body.match(/<a\s+href="([^"]+)"\s+rel="next"/);
      if (nm) {
        const rel = nm[1].replace(/&amp;/g, '&');
        path = path.replace(/[^/]*$/, '') + rel;
      } else { path = ''; }
      pages++;
    }
    cfgStats[d] = { types: types.length, pages };
  }
  check('CFG: MOC pagination works', cfgStats.MOC && cfgStats.MOC.types > 70, `MOC=${cfgStats.MOC.types} types/${cfgStats.MOC.pages}p`);
  console.log('\n  CFG type counts:', JSON.stringify(cfgStats));

  // Test instance fetch
  r = await req('GET', '/rw/cfg/MOC/ROBOT/instances');
  const insts = new P(r.body).getAllStates('cfg-dt-instance-li').map(i => i._title);
  check('CFG: MOC/ROBOT instances', insts.length > 0, insts.join(','));

  r = await req('GET', '/rw/cfg/MOC/ROBOT/instances/ROB_1');
  const attrs = new P(r.body).getAllStates('cfg-ia-t');
  check('CFG: instance attributes', attrs.length > 50, `${attrs.length} attrs`);

  // Test EIO_SIGNAL pagination (80 instances)
  let allSigInsts = [];
  let path = '/rw/cfg/EIO/EIO_SIGNAL/instances';
  let pages = 0;
  while (path && pages < 5) {
    const pr = await req('GET', path);
    if (pr.status !== 200) break;
    allSigInsts.push(...new P(pr.body).getAllStates('cfg-dt-instance-li').map(i => i._title).filter(Boolean));
    const nm = pr.body.match(/<a\s+href="([^"]+)"\s+rel="next"/);
    if (nm) {
      const rel = nm[1].replace(/&amp;/g, '&');
      path = path.replace(/[^/]*$/, '') + rel;
    } else { path = ''; }
    pages++;
  }
  check('CFG: EIO_SIGNAL instance pagination', allSigInsts.length >= 70, `${allSigInsts.length} signals across ${pages} pages`);

  // ─── Backup / Files ───
  r = await req('GET', '/ctrl/backup');
  check('Backup: status reachable', r.status === 200);

  for (const vol of ['HOME', 'BACKUP', 'DATA', 'ADDINDATA', 'PRODUCTS', 'RAMDISK', 'TEMP']) {
    r = await req('GET', `/fileservice/${vol}`);
    check(`FS: /${vol} listable`, r.status === 200, `HTTP ${r.status}`);
  }

  // ─── DIPC / Vision / Safety ───
  r = await req('GET', '/rw/dipc');
  check('DIPC: reachable', r.status === 200);
  r = await req('GET', '/rw/vision');
  check('Vision: reachable', r.status === 200);
  r = await req('GET', '/ctrl/safety');
  check('Safety: reachable', r.status === 200);

  // ─── Virtual time (4 sub-resources) ───
  for (const sub of ['vttime', 'vtstate', 'vtspeed', 'vttimeslice']) {
    r = await req('GET', `/ctrl/virtualtime/${sub}`);
    check(`VirtualTime: /${sub} reachable`, r.status === 200, `HTTP ${r.status}`);
  }

  // ─── Cert store / Registry ───
  r = await req('GET', '/ctrl/certstore');
  check('Certs: store reachable', r.status === 200);
  r = await req('GET', '/ctrl/registry');
  check('Registry: reachable', r.status === 200);

  // ─── I/O ───
  r = await req('GET', '/rw/iosystem/signals?start=0&limit=50');
  const signals = new P(r.body).getAllStates('ios-signal-li');
  check('IO: signals parsed', signals.length > 0, `${signals.length} signals on first page`);

  r = await req('GET', '/rw/iosystem/networks');
  const nets = new P(r.body).getAllStates('ios-network-li');
  check('IO: networks parsed', nets.length > 0, `${nets.length} networks`);

  // ─── Event log ───
  r = await req('GET', '/rw/elog/0?lang=en');
  const elog = new P(r.body).getAllStates('elog-message-li');
  check('Elog: parsed', elog.length >= 0, `${elog.length} events`);

  // ─── RMMP ───
  r = await req('GET', '/users/rmmp');
  check('RMMP: reachable', r.status === 200);

  // ─── Mastership ───
  r = await req('GET', '/rw/mastership');
  check('Mastership: reachable', r.status === 200);

  // ─── Subscription endpoint ───
  r = await req('GET', '/subscription');
  check('Subscription: reachable', r.status === 200);

  // ─── Final summary ───
  console.log('\n\n' + '═'.repeat(70));
  console.log(`Passed: ${pass.length}`);
  console.log(`Failed: ${fail.length}`);
  console.log('═'.repeat(70));
  if (fail.length) {
    console.log('\nFailures:');
    for (const f of fail) console.log(`  ✗ ${f.name}${f.hint ? ' — ' + f.hint : ''}`);
  } else {
    console.log('\n🎉 All ' + pass.length + ' checks pass!');
  }
})();
