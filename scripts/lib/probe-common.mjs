// Shared config + HTTP session helpers for the live test/probe scripts.
//
// Every script honors these environment variables:
//   RWS1_URL   — IRC5 / RWS 1.0 base URL, e.g. http://127.0.0.1:23308
//                (empty → the RWS 1.0 scripts fall back to port auto-detection)
//   RWS2_URL   — OmniCore / RWS 2.0 base URL (default https://127.0.0.1:5466)
//   RWS_USER   — login user  (default "Default User")
//   RWS_PASS   — password    (default "robotics")
//   HOST       — host used for defaults and port scans (default 127.0.0.1)
//
// makeSession() gives a Basic-auth session with a shared cookie jar per
// controller — RWS 2.0 counts sessions per IP (5 max), so reuse one session
// per script and GET /logout when done (session.logout()).

import https from 'node:https';
import http from 'node:http';
import net from 'node:net';

export const HOST = process.env.HOST || '127.0.0.1';
export const RWS1_URL = process.env.RWS1_URL || '';
export const RWS2_URL = process.env.RWS2_URL || `https://${HOST}:5466`;
export const RWS_USER = process.env.RWS_USER || 'Default User';
export const RWS_PASS = process.env.RWS_PASS || 'robotics';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

/** True when a TCP connect to host:port succeeds within timeoutMs. */
export function tcpPing(port, host = HOST, timeoutMs = 300) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

/**
 * Basic-auth HTTP(S) session with a cookie jar.
 *
 * @param baseUrl  string | URL — e.g. 'https://127.0.0.1:5466'
 * @param opts     { user, pass, accept, contentType, timeoutMs }
 * @returns        { url, req, logout, cookie }
 *
 * req(method, path, body, extra):
 *   - body === undefined on POST/PUT/DELETE still sends the form Content-Type
 *     with Content-Length: 0 (RWS 2.0 returns 406 without a Content-Type).
 *   - extra: { contentType, headers } per-request overrides (e.g. file upload
 *     with 'text/plain;v=2.0').
 *   - resolves { status, body, headers }; on transport errors resolves
 *     { status: 0, body: <message>, error: <message> } — never rejects.
 */
export function makeSession(baseUrl, opts = {}) {
  const url = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;
  const user = opts.user ?? RWS_USER;
  const pass = opts.pass ?? RWS_PASS;
  const accept = opts.accept ?? 'application/xhtml+xml;v=2.0';
  const defaultContentType = opts.contentType ?? 'application/x-www-form-urlencoded;v=2.0';
  const timeoutMs = opts.timeoutMs ?? 8000;
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const cookies = new Map();

  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  function req(method, path, body, extra = {}) {
    return new Promise((resolve) => {
      const headers = { Authorization: auth, Accept: accept, ...(extra.headers || {}) };
      const jar = cookieHeader();
      if (jar) { headers.Cookie = jar; }
      if (body !== undefined) {
        headers['Content-Type'] = extra.contentType || defaultContentType;
        headers['Content-Length'] = String(Buffer.byteLength(body));
      } else if (method !== 'GET') {
        headers['Content-Type'] = extra.contentType || defaultContentType;
        headers['Content-Length'] = '0';
      }
      const r = transport.request({
        host: url.hostname,
        port: Number(url.port) || (isHttps ? 443 : 80),
        path,
        method,
        headers,
        agent,
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const c of res.headers['set-cookie'] || []) {
            const [nameValue] = c.split(';');
            const eq = nameValue.indexOf('=');
            if (eq > 0) { cookies.set(nameValue.slice(0, eq).trim(), nameValue.slice(eq + 1).trim()); }
          }
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
        });
      });
      r.on('error', (e) => resolve({ status: 0, body: e.message, error: e.message }));
      r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ status: 0, body: 'timeout', error: 'timeout' }); });
      if (body !== undefined) { r.write(body); }
      r.end();
    });
  }

  return {
    url,
    req,
    logout: () => req('GET', '/logout'),
    get cookie() { return cookieHeader(); },
  };
}
