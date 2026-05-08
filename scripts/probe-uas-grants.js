// Walk SYS-domain CFG looking for any setting that controls whether remote
// operations (especially op-mode change) require local FlexPendant confirmation.
//
// Strategy:
//   1. List all CFG types in SYS domain
//   2. For each type, list instances + attributes
//   3. Highlight anything matching: remote / confirm / popup / acknowledge /
//      auto / opmode / user / grant / privilege / bypass
//
// Run:  node scripts/probe-uas-grants.js

const https = require('https');
const net = require('net');

const HOST = process.env.HOST || '127.0.0.1';
const USER = process.env.RWS_USER || 'Admin';
const PASS = process.env.RWS_PASS || 'robotics';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let sessionCookie = null;
let port = Number(process.env.PORT) || 0;

function req(method, p, path, body) {
  return new Promise(resolve => {
    const headers = {
      Authorization: AUTH,
      Accept: 'application/xhtml+xml;v=2.0',
    };
    if (sessionCookie) { headers.Cookie = sessionCookie; }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;v=2.0';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request({
      host: HOST, port: p, path, method, headers, agent: httpsAgent,
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          const ct = setCookie.find(c => /^(-http-session-|ABBCX|http-session)=/.test(c));
          if (ct) { sessionCookie = ct.split(';')[0]; }
        }
        resolve({ status: res.statusCode, body: data });
      });
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (body !== undefined) { r.write(body); }
    r.end();
  });
}

function probePort(p) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: HOST, port: p, timeout: 1000 });
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

const KEYWORDS = /(remote|confirm|popup|acknowledge|auto.?grant|opmode|operation.?mode|user|grant|privilege|bypass|approve|allow|prompt|dialog)/i;

function extractListItems(xml, classPattern) {
  // Match li elements regardless of class/title attribute order.
  const items = [];
  const re = /<li([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const cls = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
    const title = (attrs.match(/title="([^"]+)"/) || [])[1] || '';
    if (classPattern.test(cls) && title) { items.push(title); }
  }
  return items;
}

function extractAttrs(xml) {
  // Each cfg attribute is: <li class="cfg-ia-t" title="ATTR"><span class="value">VAL</span></li>
  const out = {};
  // Walk li-by-li so we attach the value span to the correct attribute title.
  const re = /<li([^>]*)>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const cls = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
    if (!/cfg-ia-t/.test(cls)) { continue; }
    const title = (attrs.match(/title="([^"]+)"/) || [])[1] || '';
    if (!title) { continue; }
    const vm = m[2].match(/<span class="value">([^<]*)<\/span>/);
    out[title] = vm ? vm[1] : '';
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!port) {
    for (const p of [5466, 9403, 443, 80, 11811]) {
      if (await probePort(p)) { port = p; break; }
    }
    if (!port) { console.error('No RWS port reachable'); process.exit(1); }
  }
  console.log(`Connected to ${HOST}:${port} as ${USER}\n`);

  // List types across ALL CFG domains. UAS-related settings could live in
  // any domain (most likely SYS but let's not assume). Rate-limit ourselves
  // to ~15 req/s so we stay well under the 20/s controller cap.
  const domainsRes = await req('GET', port, '/rw/cfg');
  await sleep(80);
  const domains = extractListItems(domainsRes.body, /cfg-domain-li/);
  console.log(`CFG domains: ${domains.join(', ')}\n`);

  const interesting = [];

  for (const domain of domains) {
    // List types
    const typesRes = await req('GET', port, `/rw/cfg/${encodeURIComponent(domain)}`);
    await sleep(80);
    if (typesRes.status !== 200) {
      console.log(`  [skip] ${domain}: HTTP ${typesRes.status}`);
      continue;
    }
    const types = extractListItems(typesRes.body, /cfg-dt-li/);
    const interestingTypes = types.filter(t => KEYWORDS.test(t));
    console.log(`${domain} has ${types.length} types — interesting: ${interestingTypes.length ? interestingTypes.join(', ') : '(none in name)'}`);

    // Walk only the keyword-matching types fully (faster), but also sample
    // a couple non-matching types in case the setting is buried in a
    // generically-named instance (e.g. SYS/SYS_MISC).
    const typesToWalk = [...new Set([
      ...interestingTypes,
      ...types.filter(t => /SYS_MISC|MOTION_SUP|UAS|GRANT|USER|REMOTE|MISC|RUN_MODE/i.test(t)),
    ])];

    for (const type of typesToWalk) {
      const instRes = await req('GET', port, `/rw/cfg/${encodeURIComponent(domain)}/${encodeURIComponent(type)}`);
      await sleep(80);
      if (instRes.status !== 200) {
        console.log(`    [skip] ${domain}/${type}: HTTP ${instRes.status}`);
        continue;
      }
      const instances = extractListItems(instRes.body, /cfg-dt-instance-li/);
      console.log(`  ${domain}/${type} — ${instances.length} instance(s)`);

      for (const inst of instances) {
        const aRes = await req('GET', port, `/rw/cfg/${encodeURIComponent(domain)}/${encodeURIComponent(type)}/${encodeURIComponent(inst)}`);
        await sleep(80);
        if (aRes.status !== 200) { continue; }
        const attrs = extractAttrs(aRes.body);
        const allText = `${domain} ${type} ${inst} ` + Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(' ');
        if (KEYWORDS.test(allText)) {
          interesting.push({ domain, type, inst, attrs });
        }
      }
    }
  }

  console.log(`\n──────── ${interesting.length} potentially-relevant CFG instances ────────\n`);
  for (const { domain, type, inst, attrs } of interesting) {
    console.log(`${domain}/${type}/${inst}`);
    for (const [k, v] of Object.entries(attrs)) {
      const flag = KEYWORDS.test(`${k} ${v}`) ? ' ★' : '';
      console.log(`  ${k} = ${v}${flag}`);
    }
    console.log();
  }

  await req('GET', port, '/logout');
}

main().catch(e => { console.error(e); process.exit(1); });
