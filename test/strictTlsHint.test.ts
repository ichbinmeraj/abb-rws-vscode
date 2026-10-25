import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLogger } from 'abb-rws-client';
// Not part of the client's exports: the bundled client's own function, so the test
// sees the line it logs. esbuild bundles it with the same Logger as the import above.
import { resetUnverifiedTlsWarnings, warnUnverifiedTls } from '../node_modules/abb-rws-client/dist/tlsTrust.js';
import { STRICT_TLS_HINT, withStrictTlsHint } from '../src/strictTlsHint';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');

/** What the bundled client logs at warn level while `run` runs. */
function warnings(run: () => void): string[] {
  const out: string[] = [];
  setLogger({ info: () => {}, warn: msg => out.push(msg), error: () => {}, trace: () => {}, show: () => {} });
  try { run(); } finally { setLogger({ info: () => {}, warn: () => {}, error: () => {}, trace: () => {}, show: () => {} }); }
  return out;
}

describe('the unchecked-certificate warning names abbRobot.strictTls', () => {
  it('adds the setting to the line the bundled client logs, once, at its end', () => {
    resetUnverifiedTlsWarnings();
    const [line, ...more] = warnings(() => warnUnverifiedTls('10.0.0.5', 443));
    assert.equal(more.length, 0);
    assert.match(line, /^TLS: the certificate of https:\/\/10\.0\.0\.5:443 is not checked/);
    const shown = withStrictTlsHint(line);
    assert.equal(shown, `${line} ${STRICT_TLS_HINT}`);
    assert.match(shown, /abbRobot\.strictTls/);
    assert.equal(shown.split('abbRobot.strictTls').length - 1, 1);
  });

  it('matches the line for a host name and an IPv6 address too', () => {
    resetUnverifiedTlsWarnings();
    const lines = warnings(() => { warnUnverifiedTls('Cell-3.example', 443); warnUnverifiedTls('fe80::1', 8443); });
    assert.equal(lines.length, 2);
    for (const line of lines) { assert.equal(withStrictTlsHint(line), `${line} ${STRICT_TLS_HINT}`); }
  });

  it('leaves every other message as it is', () => {
    for (const msg of [
      'listAllSignals failed: controller busy; the signal table is read again in 5 s',
      'TLS: something else',
      'note: TLS: the certificate of https://10.0.0.5:443 is not checked (strictTls is off)',
      '',
    ]) {
      assert.equal(withStrictTlsHint(msg), msg);
    }
  });

  it('is what the logger RAPID Live installs in the client passes on for warn', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.match(src, /setLogger\(\{[^}]*warn:\s*\(msg\)\s*=>\s*Logger\.warn\(withStrictTlsHint\(msg\)\)/);
  });
});
