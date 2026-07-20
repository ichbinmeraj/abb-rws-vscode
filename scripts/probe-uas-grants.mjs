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

// Env: RWS2_URL RWS_USER RWS_PASS HOST PORT (see scripts/lib/probe-common.mjs)
import { HOST, makeSession, tcpPing, sleep } from './lib/probe-common.mjs';

const USER = process.env.RWS_USER || 'Admin';

let session = null;
const req = (method, _port, path, body) => session.req(method, path, body);

async function resolveBase() {
  if (process.env.RWS2_URL) { return new URL(process.env.RWS2_URL); }
  if (process.env.PORT) { return new URL(`https://${HOST}:${process.env.PORT}`); }
  for (const p of [5466, 9403, 443, 80, 11811]) {
    if (await tcpPing(p, HOST, 1000)) { return new URL(`https://${HOST}:${p}`); }
  }
  return null;
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

async function main() {
  const base = await resolveBase();
  if (!base) { console.error('No RWS port reachable'); process.exit(1); }
  session = makeSession(base, { user: USER });
  const port = Number(base.port);
  console.log(`Connected to ${base.host} as ${USER}\n`);

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
    console.log(`${domain} has ${types.length} types - interesting: ${interestingTypes.length ? interestingTypes.join(', ') : '(none in name)'}`);

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
      console.log(`  ${domain}/${type} - ${instances.length} instance(s)`);

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

  await session.logout();
}

main().catch(e => { console.error(e); process.exit(1); });
