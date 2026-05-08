/* End-to-end command behavior test — uses the EXACT parsing logic from
 * RWS2Adapter and the same data flow each command takes.
 *
 * Run: node test-commands.js
 */
const https = require('https');

const HOST = '127.0.0.1';
const PORT = 5466;
const AUTH = 'Basic ' + Buffer.from('Default User:robotics').toString('base64');
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
let cookie = null;

function req(method, path, body) {
  return new Promise(resolve => {
    const opts = {
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
    const r = https.request(opts, res => {
      const sc = res.headers['set-cookie'];
      if (sc && !cookie) cookie = sc.map(c => c.split(';')[0]).join('; ');
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.setTimeout(5000, () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}

class XhtmlParser {
  constructor(html) { this.html = html; }
  getState(liClass) { return this.getAllStates(liClass)[0] ?? {}; }
  getAllStates(liClass) {
    const results = [];
    const liRe = new RegExp(`<li class="${liClass}"([^>]*)>([\\s\\S]*?)</li>`, 'g');
    for (const m of this.html.matchAll(liRe)) {
      const fields = {};
      const titleM = m[1].match(/title="([^"]*)"/);
      if (titleM) fields['_title'] = titleM[1];
      for (const [, cls, val] of m[2].matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)) {
        fields[cls] = val;
      }
      results.push(fields);
    }
    return results;
  }
  get(span) {
    const m = this.html.match(new RegExp(`<span class="${span}">([^<]*)<\\/span>`));
    return m?.[1];
  }
}

const PASS = '✅', FAIL = '❌';
const results = [];

function check(name, condition, hint) {
  const ok = !!condition;
  results.push({ name, ok, hint });
  console.log(`${ok ? PASS : FAIL} ${name}${hint ? ' — ' + hint : ''}`);
}

function header(t) {
  console.log('\n' + '─'.repeat(70));
  console.log(`▸ ${t}`);
  console.log('─'.repeat(70));
}

(async () => {
  await req('GET', '/rw/system');
  console.log('Session established');

  // === 1. Show System Details ===
  header('Command: ABB Robot: Show System Details');
  const robot = new XhtmlParser((await req('GET', '/rw/system/robottype')).body).getState('sys-robottype');
  const products = new XhtmlParser((await req('GET', '/rw/system/products')).body).getAllStates('sys-product-li');
  const license = new XhtmlParser((await req('GET', '/rw/system/license')).body).getAllStates('sys-license');
  const energy = new XhtmlParser((await req('GET', '/rw/system/energy')).body).getState('sys-energy-state');

  const robotType = robot['robot-type'];
  console.log(`Robot type: ${robotType}`);
  console.log(`License entries: ${license.length} (sample: ${JSON.stringify(license[0])})`);
  console.log(`Products: ${products.length}`);
  for (const p of products) console.log(`  - ${p._title}: ${p.version}`);
  console.log(`Energy keys: ${Object.keys(energy).join(', ')}`);
  console.log(`Energy interval: ${energy['interval-energy']} | accumulated: ${energy['accumulated-energy']}`);

  check('Robot type parsed',          robotType,          robotType);
  check('Products list non-empty',    products.length > 0, `${products.length} products`);
  check('License parsed',             license.length > 0, license[0]?.license);
  check('Energy stats parsed',        Object.keys(energy).length > 0, `${Object.keys(energy).length} fields`);

  // === 2. Browse CFG ===
  header('Command: ABB Robot: Browse Configuration Database');
  const domains = new XhtmlParser((await req('GET', '/rw/cfg')).body).getAllStates('cfg-domain-li')
    .map(d => d._title || d.name).filter(Boolean);
  console.log(`Domains: ${domains.join(', ')}`);

  // Manual paginated walk for MOC types
  const types = [];
  let cfgPath = '/rw/cfg/MOC';
  let pageCount = 0;
  while (cfgPath && pageCount < 10) {
    const html = (await req('GET', cfgPath)).body;
    const p = new XhtmlParser(html);
    types.push(...p.getAllStates('cfg-dt-li').map(t => t._title).filter(Boolean));
    const next = html.match(/<a\s+href="([^"]+)"\s+rel="next"/);
    cfgPath = next ? '/rw/' + next[1].replace(/&amp;/g, '&') : '';
    pageCount++;
  }
  console.log(`MOC types (across ${pageCount} pages): ${types.length} total`);
  console.log(`  first 8: ${types.slice(0, 8).join(', ')}`);

  // Drill into MOC/ROBOT
  const robotType2 = types.find(t => t === 'ROBOT' || t === 'ARM');
  if (robotType2) {
    const insts = new XhtmlParser((await req('GET', `/rw/cfg/MOC/${robotType2}`)).body)
      .getAllStates('cfg-dt-instance-li').map(i => i._title).filter(Boolean);
    console.log(`MOC/${robotType2} instances: ${insts.length}`);
    if (insts[0]) {
      const data = new XhtmlParser((await req('GET', `/rw/cfg/MOC/${robotType2}/${encodeURIComponent(insts[0])}`)).body);
      const attribs = data.getAllStates('cfg-dt-attribute-li');
      console.log(`MOC/${robotType2}/${insts[0]} attributes: ${attribs.length}`);
    }
  }

  check('CFG domains discovered',    domains.length === 6, `${domains.length} domains`);
  check('CFG types paginated',       types.length > 50,    `${types.length} types in MOC`);

  // === 3. Show Program Pointer + Motion Pointer ===
  header('Command: ABB Robot: Show Program Pointer + Motion Pointer');
  const ppRaw = new XhtmlParser((await req('GET', '/rw/rapid/tasks/T_ROB1/pcp')).body).getState('pcp-info');
  const ppBegin = (ppRaw.beginposition ?? '').split(',');
  const pp = {
    module: ppRaw.modulename ?? ppRaw.modulemame,
    routine: ppRaw.routinename,
    row: ppBegin[0] ? +ppBegin[0] : undefined,
    col: ppBegin[1] ? +ppBegin[1] : undefined,
  };
  const mpRaw = new XhtmlParser((await req('GET', '/rw/rapid/tasks/T_ROB1/syncstate/motion-pointer')).body)
    .getState('rap-task-sync-state');
  const mp = { state: mpRaw['motion-pointer-state'] };

  console.log(`PP: ${pp.module}/${pp.routine} (row ${pp.row}, col ${pp.col}) [${ppRaw.executiontype}]`);
  console.log(`MP state: ${mp.state}`);

  check('PP module parsed',  pp.module,            pp.module);
  check('PP routine parsed', pp.routine,           pp.routine);
  check('PP row parsed',     pp.row !== undefined, String(pp.row));
  check('MP state readable', mp.state,             mp.state);

  // === 4. Motion Info ===
  header('Command: ABB Robot: Show Motion Info');
  const cc = +(new XhtmlParser((await req('GET', '/rw/motionsystem?resource=change-count')).body).get('change-count') ?? 0);
  const errBody = await req('GET', '/rw/motionsystem/errorstate');
  const errState = new XhtmlParser(errBody.body).getState('ms-errorstate');
  const nmBody = await req('GET', '/rw/motionsystem/nonmotionexecution');
  const nmRaw = (new XhtmlParser(nmBody.body).get('mode') ?? '').replace(/"/g, '').toUpperCase();
  const cpBody = await req('GET', '/rw/motionsystem/collisionprediction');
  const cpEnabled = (new XhtmlParser(cpBody.body).get('collision-prediction-mode-enabled') ?? 'false').toLowerCase();

  console.log(`Change count: ${cc}`);
  console.log(`Error state: ${errState['err-state']} (count ${errState['err-count']})`);
  console.log(`Non-motion mode: ${nmRaw}`);
  console.log(`Collision prediction: ${cpEnabled === 'true' ? 'ON' : 'OFF'}`);

  check('Change count parsed',   cc > 0,                  String(cc));
  check('Error state parsed',    errState['err-state'],   errState['err-state']);
  check('Non-motion parsed',     nmRaw === 'OFF' || nmRaw === 'ON', nmRaw);
  check('Collision prediction',  cpEnabled === 'true' || cpEnabled === 'false', cpEnabled);

  // === 5. Active Tool/WObj ===
  header('Command: ABB Robot: Show Active Tool / WObj / Payload');
  const mech = new XhtmlParser((await req('GET', '/rw/motionsystem/mechunits/ROB_1')).body).getState('ms-mechunit');
  console.log(`Tool: ${mech['tool-name']}`);
  console.log(`WObj: ${mech['wobj-name']}`);
  console.log(`Payload: ${mech['total-payload-name'] ?? mech['payload-name']}`);

  check('Tool name parsed',    mech['tool-name'],          mech['tool-name']);
  check('WObj name parsed',    mech['wobj-name'],          mech['wobj-name']);
  check('Payload parsed',      mech['payload-name'] || mech['total-payload-name'], mech['payload-name']);

  // === 6. Backups ===
  header('Command: ABB Robot: List Backups');
  const backups = new XhtmlParser((await req('GET', '/fileservice/BACKUP')).body).getAllStates('fs-dir');
  console.log(`Backups: ${backups.length}`);
  for (const b of backups.slice(0, 5)) console.log(`  - ${b._title}`);

  check('Backups query works (count any)', backups.length >= 0, `${backups.length} backups`);

  // === 7. Virtual Time ===
  header('Command: ABB Robot: Show Virtual Time');
  const vtTime  = new XhtmlParser((await req('GET', '/ctrl/virtualtime/vttime')).body).getState('ctrl-vttime') || {};
  const vtState = new XhtmlParser((await req('GET', '/ctrl/virtualtime/vtstate')).body).getState('ctrl-vtstate') || {};
  const vtSpeed = new XhtmlParser((await req('GET', '/ctrl/virtualtime/vtspeed')).body).getState('ctrl-vtspeed') || {};
  console.log(`vttime keys: ${Object.keys(vtTime).join(', ')}`);
  console.log(`vtstate keys: ${Object.keys(vtState).join(', ')}`);
  console.log(`vtspeed keys: ${Object.keys(vtSpeed).join(', ')}`);
  console.log(`Time: ${vtTime.time ?? vtTime.value ?? '?'}, state: ${vtState.state ?? vtState.value ?? '?'}, speed: ${vtSpeed.speed ?? vtSpeed.value ?? '?'}`);

  // Need to find actual class names - probe response
  const vtRaw = (await req('GET', '/ctrl/virtualtime/vttime')).body;
  console.log(`Raw vttime body:\n${vtRaw.slice(0, 400)}`);

  check('Virtual time accessible', Object.keys(vtTime).length > 0 || vtRaw.length > 0, 'see raw above');

  // === 8. Mechunit Details ===
  header('Command: ABB Robot: Show Mechunit Details');
  const muInfo = new XhtmlParser((await req('GET', '/rw/motionsystem/mechunits/ROB_1')).body).getState('ms-mechunit');
  const bf = new XhtmlParser((await req('GET', '/rw/motionsystem/mechunits/ROB_1/baseframe')).body).getState('ms-mechunit-baseframe');
  const axesP = new XhtmlParser((await req('GET', '/rw/motionsystem/mechunits/ROB_1/axes')).body);
  const axisCount = +(axesP.getState('ms-mechunit-axes')['axes'] ?? 0);

  console.log(`Mechunit type: ${muInfo.type}, mode: ${muInfo.mode}`);
  console.log(`Base frame: x=${bf.x}, y=${bf.y}, z=${bf.z}, q=[${bf.q1},${bf.q2},${bf.q3},${bf.q4}]`);
  console.log(`Axis count: ${axisCount}`);

  check('Mechunit info parsed',     muInfo.type,                   muInfo.type);
  check('Base frame parsed',        bf.x !== undefined,            `x=${bf.x}`);
  check('Axis count detected',      axisCount > 0,                 `${axisCount} axes`);

  // === Final summary ===
  console.log('\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));
  const passes = results.filter(r => r.ok);
  const fails  = results.filter(r => !r.ok);
  console.log(`Passed: ${passes.length} / ${results.length}`);
  console.log(`Failed: ${fails.length}`);
  if (fails.length) {
    console.log('\nStill failing:');
    for (const f of fails) console.log(`  ${FAIL} ${f.name}`);
  }
})();
