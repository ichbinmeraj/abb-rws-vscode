// The controller the host harness drives, read from RWS_TEST_HOST (and, for a
// bare host, RWS_TEST_SCHEME and RWS_TEST_PORT). No `vscode`, so a unit test
// (test/hostTarget.test.ts) can check it.
//
// RWS_TEST_HOST is shared with the client's live suites (abb-rws-client
// tests/live, tests/helpers/liveHost.ts), so it takes the same two forms:
//   - an http or https URL: `https://127.0.0.1:80`, `http://localhost:5466`;
//     the harness uses its scheme, host and port (no port: the scheme's own,
//     443 or 80). The client's live suites take only its host.
//   - a bare host: `127.0.0.1`, `localhost`, `::1` or `[::1]`, or a host name.
//     The harness takes the scheme from RWS_TEST_SCHEME (`https`, the default,
//     or `http`) and the port from RWS_TEST_PORT (default the scheme's own).
// A host with a port and no scheme (`127.0.0.1:80`, `[::1]:80`) is refused, as
// the client's live suites refuse it: give the URL. Unset or blank: no
// controller (null). The client's live suites also refuse a host that is not
// this PC; the harness does not, so with such a value set the client's live
// files fail at once instead of running.

'use strict';

const FORMS = 'give a host (127.0.0.1) or an http(s) URL (https://127.0.0.1:80)';

/**
 * `{ url, host, port, https }` for the controller `env` names, or null when
 * RWS_TEST_HOST is unset or blank. `url` is `<scheme>://<host>:<port>`; `host` is
 * as a URL writes it (`[::1]` for IPv6). Throws for a value of neither form.
 */
function targetFrom(env) {
  const raw = String(env.RWS_TEST_HOST ?? '').trim();
  if (raw === '') { return null; }
  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try { url = new URL(raw); } catch { throw new Error(`RWS_TEST_HOST=${raw} is not a URL the harness can read; ${FORMS}.`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`RWS_TEST_HOST=${raw} is not an http or https URL; ${FORMS}.`);
    }
  } else {
    if (/^([^:[\]]+|\[[^\]]*\]):\d+$/.test(raw)) {
      throw new Error(`RWS_TEST_HOST=${raw} names a port without a scheme; ${FORMS}.`);
    }
    const scheme = String(env.RWS_TEST_SCHEME ?? '').trim().toLowerCase() || 'https';
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`RWS_TEST_SCHEME=${env.RWS_TEST_SCHEME} is neither http nor https.`);
    }
    const port = String(env.RWS_TEST_PORT ?? '').trim();
    if (port !== '' && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
      throw new Error(`RWS_TEST_PORT=${env.RWS_TEST_PORT} is not a port (1-65535).`);
    }
    // A bare IPv6 address goes in brackets in a URL.
    const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
    try { url = new URL(`${scheme}://${host}${port ? `:${port}` : ''}`); } catch { throw new Error(`RWS_TEST_HOST=${raw} is not a host the harness can read; ${FORMS}.`); }
    if (url.pathname !== '/' || url.search || url.hash || url.username) {
      throw new Error(`RWS_TEST_HOST=${raw} is not a host the harness can read; ${FORMS}.`);
    }
  }
  const https = url.protocol === 'https:';
  const port = Number(url.port || (https ? 443 : 80));
  return { url: `${url.protocol}//${url.hostname}:${port}`, host: url.hostname, port, https };
}

module.exports = { targetFrom };
