import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { FindControllersOptions, FindControllersResult, FoundController } from 'abb-rws-client';
import {
  DEFAULT_SCAN_CHOICE,
  RANGE_IT_NOTE,
  controllerRows,
  credentialDefaults,
  discoveryErrorText,
  displayNotes,
  emptyResult,
  mergeResults,
  parseAddressInput,
  progressMessage,
  rangeProblem,
  rangeScanWarning,
  readDiscoverySettings,
  remoteWindowHint,
  rowStatus,
  scanWithRangeGate,
  selectionFor,
  targetScanOptions,
  unansweredSavedAddresses,
  withSavedEntry,
  wizardScanOptions,
  answeringControllers,
  clearAllWrites,
  removalWrites,
  savedEntries,
  savedEntryLabel,
} from '../src/AddRobotDiscovery';
import type { DiscoverySettings, ParsedAddress, SavedEntry } from '../src/AddRobotDiscovery';

// Addresses: RFC 5737 documentation addresses for other machines, 10.0.5.x for ranges (ranges
// must be private), 127.0.0.1 for this PC.

/** A probed RWS 2.0 virtual controller on this PC. */
function localVc(port: number, extra: Partial<FoundController> = {}): FoundController {
  return {
    key: `local:${port}`,
    host: '127.0.0.1',
    port,
    https: true,
    generation: 'rws2',
    authType: 'basic',
    probe: { host: '127.0.0.1', port, useHttps: true, authType: 'basic' },
    identified: true,
    realm: 'validusers@robapi.abb',
    sources: ['this-pc'],
    ...extra,
  };
}

/** A probed controller on another machine. */
function remote(host: string, port: number, extra: Partial<FoundController> = {}): FoundController {
  const https = port !== 80;
  return {
    key: `${host}:${port}`,
    host,
    port,
    https,
    generation: https ? 'rws2' : 'rws1',
    authType: https ? 'basic' : 'digest',
    probe: { host, port, useHttps: https, authType: https ? 'basic' : 'digest' },
    identified: true,
    realm: 'validusers@robapi.abb',
    sources: ['manual'],
    ...extra,
  };
}

/** An mDNS announcement nobody has probed. */
function announced(host: string, port: number, extra: Partial<FoundController> = {}): FoundController {
  return {
    key: `${host}:${port}`,
    host,
    port,
    https: null,
    generation: 'rws2',
    authType: null,
    probe: null,
    identified: false,
    systemName: 'Cell_7',
    sources: ['mdns'],
    ...extra,
  };
}

const settings = (over: Partial<DiscoverySettings> = {}): DiscoverySettings => ({
  manual: [{ host: '192.0.2.10' }, { host: 'robot1.example.com', port: 443 }],
  ranges: ['10.0.5.0/24'],
  ports: [8443],
  skipped: [],
  ...over,
});

const asRange = (p: ParsedAddress): Extract<ParsedAddress, { kind: 'range' }> => {
  assert.equal(p.kind, 'range');
  return p as Extract<ParsedAddress, { kind: 'range' }>;
};

describe('parseAddressInput', () => {
  it('reads an address, a host name and host:port (port split from the right)', () => {
    assert.deepEqual(parseAddressInput('192.0.2.10'), { kind: 'host', host: '192.0.2.10' });
    assert.deepEqual(parseAddressInput('  192.0.2.10:443 '), { kind: 'host', host: '192.0.2.10', port: 443 });
    assert.deepEqual(parseAddressInput('robot-1.example.com'), { kind: 'host', host: 'robot-1.example.com' });
    assert.deepEqual(parseAddressInput('robot-1.example.com:8443'), { kind: 'host', host: 'robot-1.example.com', port: 8443 });
    assert.deepEqual(parseAddressInput('localhost:9403'), { kind: 'host', host: 'localhost', port: 9403 });
  });

  it('reads a pasted URL, keeping its scheme', () => {
    assert.deepEqual(parseAddressInput('https://192.0.2.10:443/rw/system'), { kind: 'host', host: '192.0.2.10', port: 443, https: true });
    assert.deepEqual(parseAddressInput('http://198.51.100.7'), { kind: 'host', host: '198.51.100.7', https: false });
  });

  it('refuses IPv6 with the RobotWare reason', () => {
    for (const text of ['::1', 'fe80::1', '[::1]:443', '2001:db8::1', '[2001:db8::1]']) {
      const p = parseAddressInput(text);
      assert.equal(p.kind, 'invalid', text);
      assert.match((p as { reason: string }).reason, /RobotWare does not support IPv6/, text);
    }
  });

  it('reads CIDR ranges with the client\'s address count', () => {
    assert.deepEqual(asRange(parseAddressInput('10.0.5.0/24')).addresses, 254);
    assert.equal(asRange(parseAddressInput('10.0.5.17/24')).range, '10.0.5.0/24');
    assert.equal(asRange(parseAddressInput('10.0.5.0 / 30')).addresses, 2);
    assert.equal(asRange(parseAddressInput('10.0.5.0/31')).addresses, 2);
    assert.equal(asRange(parseAddressInput('10.0.5.7/32')).addresses, 1);
  });

  it('reads dash ranges with both ends in full', () => {
    const r = asRange(parseAddressInput('10.0.5.20 - 10.0.5.60'));
    assert.equal(r.range, '10.0.5.20-10.0.5.60');
    assert.equal(r.addresses, 41);
    assert.equal(parseAddressInput('10.0.5.60-10.0.5.20').kind, 'invalid');
    assert.equal(parseAddressInput('10.0.5.20-60').kind, 'invalid');
  });

  it('refuses malformed input', () => {
    for (const text of ['', '   ', '10.0.0.256', '10.0.0', 'robot:0', 'robot:65536', 'robot:abc', 'two words',
      '10.0.5.0/33', '10.0.5/24', 'robot_1', '-robot', 'robot.example.com/24']) {
      assert.equal(parseAddressInput(text).kind, 'invalid', JSON.stringify(text));
    }
  });
});

describe('rangeProblem', () => {
  it('accepts private, loopback and link-local ranges up to 256 addresses', () => {
    for (const text of ['10.0.5.0/24', '172.16.0.0/24', '172.31.255.0/24', '192.168.125.0/24', '127.0.0.1-127.0.0.1', '169.254.1.0/24']) {
      assert.equal(rangeProblem(asRange(parseAddressInput(text))), undefined, text);
    }
  });

  it('refuses a range above 256 addresses or outside the private blocks', () => {
    assert.match(rangeProblem(asRange(parseAddressInput('10.0.0.0/23'))) ?? '', /510 addresses/);
    for (const text of ['198.51.100.0/24', '172.32.0.0/24', '224.0.0.0/30', '9.255.255.250-10.0.0.5']) {
      assert.match(rangeProblem(asRange(parseAddressInput(text))) ?? '', /outside the private ranges/, text);
    }
  });
});

describe('readDiscoverySettings', () => {
  it('keeps valid saved addresses and drops malformed ones with a reason', () => {
    const s = readDiscoverySettings({
      manual: [
        { host: '192.0.2.10' },
        { host: '192.0.2.10' },
        { host: 'Robot1.example.com', port: 443, https: true },
        { host: '::1' },
        { host: '192.0.2.11:443' },
        { host: '192.0.2.12', port: 70000 },
        { host: '192.0.2.13', https: 'yes' },
        'robot2.example.com',
        null,
      ],
    });
    assert.deepEqual(s.manual, [{ host: '192.0.2.10' }, { host: 'Robot1.example.com', port: 443, https: true }]);
    assert.equal(s.skipped.length, 6);
    assert.ok(s.skipped.every(line => line.startsWith('abbRobot.discoveryManual')));
  });

  it('cuts every list at the client\'s caps', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ host: `192.0.2.${i + 1}` }));
    const ranges = Array.from({ length: 20 }, (_, i) => `10.0.${i}.0/24`);
    const ports = Array.from({ length: 12 }, (_, i) => 8000 + i);
    const s = readDiscoverySettings({ manual: many, ranges, ports });
    assert.equal(s.manual.length, 16);
    assert.equal(s.ranges.length, 16);
    assert.equal(s.ports.length, 8);
    assert.equal(s.skipped.length, 3);
  });

  it('normalises ranges, drops duplicates, and leaves out ranges a scan would refuse', () => {
    const s = readDiscoverySettings({
      ranges: ['10.0.5.0/24', '10.0.5.17/24', 'not a range', '198.51.100.0/24', '10.0.0.0/22', 42, '10.0.6.1-10.0.6.9'],
    });
    assert.deepEqual(s.ranges, ['10.0.5.0/24', '10.0.6.1-10.0.6.9']);
    assert.equal(s.skipped.length, 4);
  });

  it('keeps ports 1-65535 once each', () => {
    assert.deepEqual(readDiscoverySettings({ ports: [8443, 8443, 0, 70000, 'x', 1.5, 9000] }).ports, [8443, 9000]);
  });

  it('treats missing or non-list values as empty', () => {
    assert.deepEqual(readDiscoverySettings({}), { manual: [], ranges: [], ports: [], skipped: [] });
    const s = readDiscoverySettings({ manual: { host: '192.0.2.10' }, ranges: '10.0.5.0/24', ports: 8443 });
    assert.deepEqual([s.manual, s.ranges, s.ports], [[], [], []]);
    assert.equal(s.skipped.length, 3);
  });
});

describe('saved entries', () => {
  it('adds an address or a range once', () => {
    const base = { manual: [{ host: '192.0.2.10' }], ranges: ['10.0.5.0/24'] };
    const added = withSavedEntry(base, parseAddressInput('robot1.example.com:443'));
    assert.deepEqual(added.manual, [{ host: '192.0.2.10' }, { host: 'robot1.example.com', port: 443 }]);
    assert.equal(added.added, true);
    assert.equal(withSavedEntry(added, parseAddressInput('ROBOT1.example.com:443')).added, false);
    const withRange = withSavedEntry(base, parseAddressInput('10.0.6.0/24'));
    assert.deepEqual(withRange.ranges, ['10.0.5.0/24', '10.0.6.0/24']);
    assert.equal(withSavedEntry(base, parseAddressInput('10.0.5.99/24')).added, false);
    assert.deepEqual(base, { manual: [{ host: '192.0.2.10' }], ranges: ['10.0.5.0/24'] }, 'input not changed');
  });

  it('reports a full list instead of growing it', () => {
    const manual = Array.from({ length: 16 }, (_, i) => ({ host: `192.0.2.${i + 1}` }));
    const ranges = Array.from({ length: 16 }, (_, i) => `10.0.${i}.0/24`);
    assert.deepEqual(withSavedEntry({ manual, ranges }, parseAddressInput('192.0.2.200')).full, true);
    assert.deepEqual(withSavedEntry({ manual, ranges }, parseAddressInput('10.1.0.0/24')).full, true);
  });

});

describe('removing saved addresses and ranges', () => {
  const address = (host: string, port?: number): SavedEntry => ({ kind: 'address', target: port === undefined ? { host } : { host, port } });
  const range = (r: string): SavedEntry => ({ kind: 'range', range: r });

  it('lists the saved addresses first, then the ranges, with their display text', () => {
    const entries = savedEntries(settings());
    assert.deepEqual(entries.map(savedEntryLabel), ['192.0.2.10', 'robot1.example.com:443', '10.0.5.0/24']);
    assert.deepEqual(entries.map(e => e.kind), ['address', 'address', 'range']);
  });

  it('removes one address by host and port, and keeps the same host on another port', () => {
    const writes = removalWrites(
      { global: { manual: [{ host: '192.0.2.10' }, { host: '192.0.2.10', port: 443 }], ranges: ['10.0.5.0/24'] } },
      [address('192.0.2.10', 443)],
    );
    assert.deepEqual(writes, [{ key: 'discoveryManual', scope: 'global', value: [{ host: '192.0.2.10' }] }]);
  });

  it('matches the spelling in the settings: case and spaces of a host, a range written another way', () => {
    const writes = removalWrites(
      { global: { manual: [{ host: ' Robot1.Example.com ', port: 443, https: true }], ranges: ['10.0.5.17/24', '10.0.6.20 - 10.0.6.60'] } },
      [address('robot1.example.com', 443), range('10.0.5.0/24'), range('10.0.6.20-10.0.6.60')],
    );
    assert.deepEqual(writes, [
      { key: 'discoveryManual', scope: 'global', value: undefined },
      { key: 'discoveryRanges', scope: 'global', value: undefined },
    ]);
  });

  it('keeps every other element as it was, also ones the checks leave out, in their order', () => {
    const odd = { host: '192.0.2.99', port: 'eighty' };
    const writes = removalWrites(
      { global: { manual: [odd, { host: '192.0.2.10' }, 'not an object', { host: '192.0.2.11' }], ranges: ['198.51.100.0/24', '10.0.5.0/24'] } },
      [address('192.0.2.10'), range('10.0.5.0/24')],
    );
    assert.deepEqual(writes, [
      { key: 'discoveryManual', scope: 'global', value: [odd, 'not an object', { host: '192.0.2.11' }] },
      { key: 'discoveryRanges', scope: 'global', value: ['198.51.100.0/24'] },
    ]);
  });

  it('a malformed element on the same host is left as it was (port not a number, or out of range, or a bad https)', () => {
    const malformed = [{ host: '192.0.2.10', port: '443' }, { host: '192.0.2.10', port: 70000 }, { host: '192.0.2.10', https: 'yes' }];
    const writes = removalWrites(
      { global: { manual: [...malformed, { host: '192.0.2.10' }] } },
      [address('192.0.2.10')],
    );
    assert.deepEqual(writes, [{ key: 'discoveryManual', scope: 'global', value: malformed }]);
  });

  it('writes in the scope the entry lives in, and nowhere else', () => {
    const writes = removalWrites(
      {
        global: { manual: [{ host: '192.0.2.10' }], ranges: ['10.0.5.0/24'] },
        workspace: { manual: [{ host: '192.0.2.20' }], ranges: undefined },
      },
      [address('192.0.2.20')],
    );
    assert.deepEqual(writes, [{ key: 'discoveryManual', scope: 'workspace', value: undefined }]);
  });

  it('removes an entry from both scopes when both have it', () => {
    const writes = removalWrites(
      { global: { ranges: ['10.0.5.0/24', '10.0.7.0/24'] }, workspace: { ranges: ['10.0.5.0/24'] } },
      [range('10.0.5.0/24')],
    );
    assert.deepEqual(writes, [
      { key: 'discoveryRanges', scope: 'global', value: ['10.0.7.0/24'] },
      { key: 'discoveryRanges', scope: 'workspace', value: undefined },
    ]);
  });

  it('no write when nothing matches, a scope is unset, or a value is not a list', () => {
    assert.deepEqual(removalWrites({}, [address('192.0.2.10')]), []);
    assert.deepEqual(removalWrites({ global: { manual: 'oops', ranges: undefined } }, [address('192.0.2.10')]), []);
    assert.deepEqual(removalWrites({ global: { manual: [{ host: '192.0.2.10' }] } }, [address('192.0.2.11'), range('10.0.5.0/24')]), []);
    assert.deepEqual(removalWrites({ global: { manual: [{ host: '192.0.2.10' }] } }, []), []);
  });

  it('remove all: both lists, in every scope that sets them, also a value the checks cannot read', () => {
    const writes = clearAllWrites({
      global: { manual: [{ host: '192.0.2.10' }], ranges: 'oops' },
      workspace: { manual: undefined, ranges: ['10.0.5.0/24'] },
    });
    assert.deepEqual(writes, [
      { key: 'discoveryManual', scope: 'global', value: undefined },
      { key: 'discoveryRanges', scope: 'global', value: undefined },
      { key: 'discoveryRanges', scope: 'workspace', value: undefined },
    ]);
    assert.deepEqual(clearAllWrites({ global: {}, workspace: {} }), [], 'nothing saved: nothing written');
  });

  it('never writes anything but the two saved lists (robots, passwords and extra ports stay)', () => {
    const scopes = {
      global: { manual: [{ host: '192.0.2.10' }, { host: '192.0.2.11' }], ranges: ['10.0.5.0/24'] },
      workspace: { manual: [{ host: '192.0.2.10' }], ranges: ['10.0.5.0/24'] },
    };
    const all = [
      ...clearAllWrites(scopes),
      ...removalWrites(scopes, [address('192.0.2.10'), address('192.0.2.11'), range('10.0.5.0/24')]),
    ];
    assert.ok(all.length > 0);
    for (const w of all) { assert.ok(w.key === 'discoveryManual' || w.key === 'discoveryRanges', w.key); }
  });
});

describe('scan options', () => {
  it('the first wizard scan: this PC, service address only on its subnet, mDNS, saved addresses, never a saved range', () => {
    const o = wizardScanOptions({ ...DEFAULT_SCAN_CHOICE, ranges: [] }, settings(), { strictTls: false });
    assert.equal(o.local, true);
    assert.equal(o.serviceAddress, 'auto');
    assert.equal(o.mdns, true);
    assert.deepEqual(o.manual, settings().manual);
    assert.deepEqual(o.ranges, [], 'saved ranges are not scanned unless picked');
    assert.deepEqual(o.ports, [8443]);
    assert.equal(o.identify, 'anonymous');
    assert.equal(o.strictTls, false);
    assert.equal(o.loopbackOnly, undefined);
    assert.equal(o.credentials, undefined, 'discovery never logs in');
  });

  it('follows the ticks: service port, mDNS off, saved addresses off, a picked range, strictTls', () => {
    const o = wizardScanOptions(
      { serviceAddress: true, mdns: false, savedAddresses: false, ranges: ['10.0.5.0/24'] },
      settings(), { strictTls: true },
    );
    assert.equal(o.serviceAddress, true);
    assert.equal(o.mdns, false);
    assert.deepEqual(o.manual, []);
    assert.deepEqual(o.ranges, ['10.0.5.0/24']);
    assert.equal(o.strictTls, true);
  });

  it('a target scan sends nothing but the named targets', () => {
    const signal = new AbortController().signal;
    const o = targetScanOptions({ manual: [{ host: '192.0.2.10', port: 443 }] }, [8443], { strictTls: false, signal });
    assert.equal(o.local, false);
    assert.equal(o.serviceAddress, false);
    assert.equal(o.mdns, false);
    assert.deepEqual(o.manual, [{ host: '192.0.2.10', port: 443 }]);
    assert.deepEqual(o.ranges, []);
    assert.equal(o.signal, signal);
  });
});

describe('range warning gate', () => {
  const result = emptyResult();

  it('a scan without ranges runs without asking', async () => {
    let asked = 0;
    let ran = 0;
    const r = await scanWithRangeGate(wizardScanOptions({ ...DEFAULT_SCAN_CHOICE, ranges: [] }, settings(), { strictTls: false }), {
      confirm: async () => { asked++; return true; },
      find: async () => { ran++; return result; },
    });
    assert.equal(r, result);
    assert.deepEqual([asked, ran], [0, 1]);
  });

  it('a declined range scan sends nothing', async () => {
    let ran = 0;
    const r = await scanWithRangeGate(targetScanOptions({ ranges: ['10.0.5.0/24'] }, [], { strictTls: false }), {
      confirm: async () => false,
      find: async () => { ran++; return result; },
    });
    assert.equal(r, undefined);
    assert.equal(ran, 0);
  });

  it('asks on every range scan, with the IT note and the address count', async () => {
    const warnings: Array<{ message: string; detail: string }> = [];
    const seen: FindControllersOptions[] = [];
    const deps = {
      confirm: async (w: { message: string; detail: string }) => { warnings.push(w); return true; },
      find: async (o: FindControllersOptions): Promise<FindControllersResult> => { seen.push(o); return result; },
    };
    await scanWithRangeGate(targetScanOptions({ ranges: ['10.0.5.0/24'] }, [], { strictTls: false }), deps);
    await scanWithRangeGate(targetScanOptions({ ranges: ['10.0.5.0/24'] }, [], { strictTls: false }), deps);
    assert.equal(warnings.length, 2, 'no "don\'t ask again"');
    assert.equal(seen.length, 2);
    assert.ok(warnings[0].detail.includes(RANGE_IT_NOTE));
    assert.match(warnings[0].detail, /10\.0\.5\.0\/24 \(254 addresses\)/);
    assert.match(warnings[0].message, /10\.0\.5\.0\/24/);
  });

  it('the warning sums several ranges', () => {
    const w = rangeScanWarning(['10.0.5.0/24', '10.0.6.1-10.0.6.2']);
    assert.match(w.message, /2 ranges \(256 addresses\)/);
    assert.match(w.detail, /company network IT can see these attempts/);
  });
});

describe('picker rows', () => {
  it('maps a virtual controller on this PC', () => {
    const [row] = controllerRows([localVc(9403, { systemName: 'Cell_1', rwVersion: '7.21.4', isVirtual: true })]);
    assert.equal(row.status, 'ready');
    assert.match(row.label, /Cell_1 - 127\.0\.0\.1:9403/);
    assert.equal(row.description, 'RWS 2.0 · OmniCore · RobotWare 7.21.4 · HTTPS · virtual controller');
    assert.equal(row.detail, 'Found via this PC');
  });

  it('one row per key: a local VC seen twice appears once', () => {
    const rows = controllerRows([localVc(9403), localVc(9403, { sources: ['this-pc', 'mdns'] }), remote('192.0.2.10', 80)]);
    assert.deepEqual(rows.map(r => r.key), ['local:9403', '192.0.2.10:80']);
    assert.equal(rows[1].description, 'RWS 1.0 · IRC5 · RobotWare 6 · HTTP');
  });

  it('an mDNS-only entry is "announced": no scheme, probed when picked', () => {
    const c = announced('192.0.2.20', 443);
    const [row] = controllerRows([c]);
    assert.equal(row.status, 'announced');
    assert.equal(row.description, 'announced as RWS 2.0 · OmniCore');
    assert.match(row.detail, /not probed yet/);
    assert.equal(selectionFor(c), undefined, 'never a guessed scheme');
  });

  it('a login challenge from another realm is "unconfirmed" and says so', () => {
    const c = remote('192.0.2.30', 443, { identified: false, realm: 'Printer' });
    const [row] = controllerRows([c]);
    assert.equal(rowStatus(c), 'unconfirmed');
    assert.match(row.detail, /Not confirmed as ABB/);
    assert.match(row.detail, /"Printer"/);
  });

  it('a selection keeps the typed name, saves localhost as 127.0.0.1, and takes the scheme from the probe', () => {
    const named = remote('192.0.2.10', 443, { name: 'robot1.example.com', systemName: 'Line_3' });
    assert.deepEqual(selectionFor(named), { host: 'robot1.example.com', port: 443, useHttps: true, authType: 'basic', suggestedName: 'Line_3' });
    const viaLocalhost = localVc(9403, { name: 'localhost' });
    assert.equal(selectionFor(viaLocalhost)?.host, '127.0.0.1');
    const irc5 = remote('192.0.2.11', 80);
    assert.deepEqual(selectionFor(irc5), { host: '192.0.2.11', port: 80, useHttps: false, authType: 'digest' });
  });

  it('merging a later scan: a probed entry replaces an mDNS-only one, sources are combined, order kept', () => {
    const merged = mergeResults(
      [localVc(9403), announced('192.0.2.20', 443)],
      [remote('192.0.2.20', 443, { sources: ['range'] }), remote('192.0.2.21', 443, { sources: ['range'] })],
    );
    assert.deepEqual(merged.map(c => c.key), ['local:9403', '192.0.2.20:443', '192.0.2.21:443']);
    assert.notEqual(merged[1].probe, null);
    assert.deepEqual(merged[1].sources, ['range', 'mdns']);
  });
});

describe('saved addresses that did not answer', () => {
  it('matches by address, typed name, this PC and port', () => {
    const saved = [
      { host: '192.0.2.10' },
      { host: '192.0.2.11', port: 443 },
      { host: 'robot1.example.com' },
      { host: 'localhost' },
      { host: '192.0.2.12' },
    ];
    const found = [
      remote('192.0.2.10', 443),
      remote('192.0.2.11', 80),
      remote('192.0.2.40', 443, { name: 'robot1.example.com' }),
      localVc(9403, { sources: ['this-pc', 'manual'] }),
      announced('192.0.2.12', 443),
    ];
    assert.deepEqual(unansweredSavedAddresses(saved, found), [{ host: '192.0.2.11', port: 443 }, { host: '192.0.2.12' }]);
  });

  it('an answered saved address points at the result that answered for it', () => {
    const found = [remote('192.0.2.10', 443), remote('192.0.2.40', 443, { name: 'robot1.example.com' }), localVc(9403, { sources: ['this-pc', 'manual'] })];
    assert.deepEqual(answeringControllers({ host: 'robot1.example.com' }, found).map(c => c.key), ['192.0.2.40:443']);
    assert.deepEqual(answeringControllers({ host: '127.0.0.1', port: 9403 }, found).map(c => c.key), ['local:9403']);
    assert.deepEqual(answeringControllers({ host: '192.0.2.10', port: 80 }, found), []);
    assert.deepEqual(answeringControllers({ host: '192.0.2.10' }, [remote('192.0.2.10', 443, { sources: ['range'] })]), [], 'only a result found through a saved or entered address');
  });
});

describe('notes', () => {
  const wslNote = 'Running inside WSL: RobotStudio VCs on Windows may not be visible from here.';

  it('a WSL window shows its hint once, not twice', () => {
    const notes = displayNotes({ ...emptyResult(), environment: { wsl: true }, notes: [wslNote, 'other note'] }, 'wsl');
    assert.equal(notes.length, 2);
    assert.match(notes[0], /inside WSL/);
    assert.equal(notes[1], 'other note');
  });

  it('other remote windows get their own hint; a local window none', () => {
    assert.match(remoteWindowHint('ssh-remote') ?? '', /remote host \(ssh-remote\)/);
    assert.equal(remoteWindowHint(undefined), undefined);
    assert.deepEqual(displayNotes({ ...emptyResult(), notes: ['a'] }, undefined), ['a']);
  });

  it('certificate failures are listed, never dropped', () => {
    const notes = displayNotes({ ...emptyResult(), tlsFailures: [{ host: '192.0.2.10', port: 443, error: 'self-signed' }] }, undefined);
    assert.match(notes[0], /192\.0\.2\.10:443/);
  });
});

describe('small helpers', () => {
  it('factory credentials only for this PC, per generation', () => {
    assert.deepEqual(credentialDefaults(true, 'basic'), { username: 'Admin', password: 'robotics' });
    assert.deepEqual(credentialDefaults(true, 'digest'), { username: 'Default User', password: 'robotics' });
    assert.deepEqual(credentialDefaults(true), { username: 'Default User', password: 'robotics' });
    assert.deepEqual(credentialDefaults(false, 'basic'), { username: '', password: '' });
    assert.deepEqual(credentialDefaults(false), { username: '', password: '' });
  });

  it('progress and refusal texts', () => {
    assert.equal(progressMessage({ phase: 'probe', probed: 3, total: 10, found: 1 }), '3/10 probes - 1 found');
    assert.equal(progressMessage({ phase: 'local-scan', probed: 0, total: 0, found: 0 }), 'reading this PC\'s listening ports…');
    assert.equal(
      discoveryErrorText(new Error('findControllers: ranges[0]: has 510 addresses, above maxRangeHosts 256. Nothing was sent.')),
      'ranges[0]: has 510 addresses, above maxRangeHosts 256. Nothing was sent.',
    );
  });
});
