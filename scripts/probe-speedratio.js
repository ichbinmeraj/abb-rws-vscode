// Find the working body shape for RWS 2.0 setSpeedRatio.
const https = require('https');
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let cookie = null;
function req(method, path, body) {
  return new Promise(resolve => {
    const headers = {
      Authorization: 'Basic ' + Buffer.from('Default User:robotics').toString('base64'),
      Accept: 'application/xhtml+xml;v=2.0',
    };
    if (cookie) { headers.Cookie = cookie; }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;v=2.0';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request({
      host: '127.0.0.1', port: 5466, path, method, headers, agent: httpsAgent, rejectUnauthorized: false,
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) {
          const ct = sc.find(c => /^(-http-session-|ABBCX|http-session)=/.test(c));
          if (ct) { cookie = ct.split(';')[0]; }
        }
        resolve({ status: res.statusCode, body: d });
      });
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (body !== undefined) { r.write(body); }
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const r0 = await req('GET', '/rw/panel/speedratio');
  await sleep(150);
  const cur = r0.body.match(/<span class="speedratio">([^<]+)<\/span>/);
  console.log(`Current speed ratio: ${cur ? cur[1] : '?'}`);

  // Try with edit mastership held first (setSpeedRatio commonly requires it)
  const m1 = await req('POST', '/rw/mastership/edit/request');
  console.log(`mastership edit: ${m1.status}`);
  await sleep(150);

  const candidates = [
    { path: '/rw/panel/speedratio', body: 'speedratio=50' },
    { path: '/rw/panel/speedratio', body: 'speed-ratio=50' },
    { path: '/rw/panel/speedratio/set', body: 'speedratio=50' },
    { path: '/rw/panel/speedratio/set', body: 'speed-ratio=50' },
    { path: '/rw/panel/speedratio?action=setspeedratio', body: 'speed-ratio=50' },
    { path: '/rw/panel/speedratio', body: 'speed-ratio=50.0' },
    { path: '/rw/panel/speedratio?ratio=50', body: '' },
    { path: '/rw/panel/speedratio', body: 'pnl-speedratio=50' },
  ];
  for (const { path, body } of candidates) {
    const r = await req('POST', path, body);
    await sleep(150);
    let detail = '';
    if (r.body) {
      const msg = r.body.match(/<span class="msg">([^<]+)<\/span>/);
      if (msg) detail = msg[1].slice(0, 80);
    }
    const ok = r.status >= 200 && r.status < 300 ? '✓' : '✗';
    console.log(`  ${ok} ${path.padEnd(50)} body="${body}" → ${r.status}${detail ? '  ' + detail : ''}`);
    if (r.status >= 200 && r.status < 300) {
      const v = await req('GET', '/rw/panel/speedratio');
      const m = v.body.match(/<span class="speedratio">([^<]+)<\/span>/);
      console.log(`         verified speed ratio = ${m ? m[1] : '?'}`);
    }
  }

  // Restore original
  if (cur) { await req('POST', '/rw/panel/speedratio', `speedratio=${cur[1]}`); }
  await req('POST', '/rw/mastership/edit/release');
  await req('GET', '/logout');
})();
