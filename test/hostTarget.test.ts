import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

// The host harness's reading of RWS_TEST_HOST (test/host/target.js), checked
// offline. The client's live suites read the same variable and take the same
// two forms: an http(s) URL or a bare host.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { targetFrom } = require('./host/target.js') as {
  targetFrom(env: Record<string, string | undefined>): { url: string; host: string; port: number; https: boolean } | null;
};

describe('host harness: RWS_TEST_HOST', () => {
  it('is no controller when unset or blank', () => {
    assert.equal(targetFrom({}), null);
    assert.equal(targetFrom({ RWS_TEST_HOST: '' }), null);
    assert.equal(targetFrom({ RWS_TEST_HOST: '   ' }), null);
  });

  it('takes the scheme, host and port of an http(s) URL', () => {
    assert.deepEqual(targetFrom({ RWS_TEST_HOST: 'https://127.0.0.1:80' }), { url: 'https://127.0.0.1:80', host: '127.0.0.1', port: 80, https: true });
    assert.deepEqual(targetFrom({ RWS_TEST_HOST: 'http://localhost:5466/' }), { url: 'http://localhost:5466', host: 'localhost', port: 5466, https: false });
    assert.deepEqual(targetFrom({ RWS_TEST_HOST: ' HTTPS://[::1]:443 ' }), { url: 'https://[::1]:443', host: '[::1]', port: 443, https: true });
    // No port: the scheme's own. RWS_TEST_SCHEME and RWS_TEST_PORT do not change a URL.
    assert.equal(targetFrom({ RWS_TEST_HOST: 'https://127.0.0.1' })?.url, 'https://127.0.0.1:443');
    assert.equal(targetFrom({ RWS_TEST_HOST: 'http://127.0.0.1', RWS_TEST_SCHEME: 'https', RWS_TEST_PORT: '5466' })?.url, 'http://127.0.0.1:80');
  });

  it('takes a bare host with RWS_TEST_SCHEME and RWS_TEST_PORT, https and its port by default', () => {
    assert.deepEqual(targetFrom({ RWS_TEST_HOST: '127.0.0.1' }), { url: 'https://127.0.0.1:443', host: '127.0.0.1', port: 443, https: true });
    assert.equal(targetFrom({ RWS_TEST_HOST: 'localhost', RWS_TEST_SCHEME: 'http' })?.url, 'http://localhost:80');
    assert.equal(targetFrom({ RWS_TEST_HOST: '127.0.0.1', RWS_TEST_SCHEME: 'HTTP', RWS_TEST_PORT: '5466' })?.url, 'http://127.0.0.1:5466');
    assert.equal(targetFrom({ RWS_TEST_HOST: '::1', RWS_TEST_PORT: '80' })?.url, 'https://[::1]:80');
    assert.equal(targetFrom({ RWS_TEST_HOST: '[::1]' })?.host, '[::1]');
  });

  it('refuses a host with a port and no scheme, as the client\'s live suites do', () => {
    for (const raw of ['127.0.0.1:80', 'localhost:5466', '[::1]:80']) {
      assert.throws(() => targetFrom({ RWS_TEST_HOST: raw }), new RegExp(`RWS_TEST_HOST=${raw.replace(/[[\]]/g, '\\$&')} names a port without a scheme; give a host \\(127\\.0\\.0\\.1\\) or an http\\(s\\) URL \\(https://127\\.0\\.0\\.1:80\\)\\.`), raw);
    }
  });

  it('refuses another scheme, a path, a bad scheme or a bad port', () => {
    assert.throws(() => targetFrom({ RWS_TEST_HOST: 'ftp://127.0.0.1' }), /is not an http or https URL/);
    assert.throws(() => targetFrom({ RWS_TEST_HOST: 'ws://127.0.0.1:80' }), /is not an http or https URL/);
    assert.throws(() => targetFrom({ RWS_TEST_HOST: '127.0.0.1/rw' }), /is not a host the harness can read/);
    assert.throws(() => targetFrom({ RWS_TEST_HOST: 'user@127.0.0.1' }), /is not a host the harness can read/);
    assert.throws(() => targetFrom({ RWS_TEST_HOST: '127.0.0.1', RWS_TEST_SCHEME: 'ftp' }), /RWS_TEST_SCHEME=ftp is neither http nor https/);
    for (const port of ['0', '65536', 'x', '80a']) {
      assert.throws(() => targetFrom({ RWS_TEST_HOST: '127.0.0.1', RWS_TEST_PORT: port }), /is not a port \(1-65535\)/, port);
    }
  });
});
