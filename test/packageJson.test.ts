import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// The bundled test runs from out/test/, two levels below the extension root.
const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
  contributes: {
    configuration: { properties: Record<string, { scope?: string; default?: unknown; maxItems?: number; markdownDescription?: string }> };
    commands: Array<{ command: string; title: string; category?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
  };
};
const properties = manifest.contributes.configuration.properties;

describe('robots view menus', () => {
  // `.motion`: a connected RobotWare 8 robot whose motion control may stand (its row offers Withdraw).
  const robotRows = ['robot.connected', 'robot.connected.active', 'robot.connected.motion', 'robot.connected.active.motion', 'robot.disconnected', 'robot.disconnected.active'];
  /** The `viewItem =~ /.../` regex of a when-clause. */
  const viewItemRegex = (when: string): RegExp => {
    const m = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(when);
    assert.ok(m, `a viewItem regex in "${when}"`);
    return new RegExp(m[1]);
  };

  it('Remove Robot is on every robot row (trash button and right-click), never on the "Add Robot…" row', () => {
    const entries = manifest.contributes.menus['view/item/context'].filter(m => m.command === 'abbRobot.removeRobot');
    assert.deepEqual(entries.map(e => e.group?.startsWith('inline') ? 'inline' : 'context').sort(), ['context', 'inline']);
    for (const e of entries) {
      assert.match(e.when ?? '', /view == abbRobot\.robots/);
      const re = viewItemRegex(e.when ?? '');
      for (const row of robotRows) { assert.ok(re.test(row), `${e.group}: ${row}`); }
      assert.ok(!re.test('robot.add'), `${e.group}: not on the Add Robot row`);
    }
  });

  it('a robot row\'s right-click menu has Connect or Disconnect', () => {
    const context = manifest.contributes.menus['view/item/context'].filter(m => !m.group?.startsWith('inline'));
    for (const [command, rows] of [
      ['abbRobot.connectRobot', ['robot.disconnected', 'robot.disconnected.active']],
      ['abbRobot.disconnectRobot', ['robot.connected', 'robot.connected.active', 'robot.connected.motion', 'robot.connected.active.motion']],
    ] as const) {
      const e = context.find(m => m.command === command);
      assert.ok(e, command);
      const re = viewItemRegex(e.when ?? '');
      for (const row of rows) { assert.ok(re.test(row), `${command}: ${row}`); }
      assert.ok(!re.test('robot.add'));
    }
  });

  it('the inline Connect, Disconnect and the Set Active Robot item cover every row they did, the rows with motion control too', () => {
    const items = manifest.contributes.menus['view/item/context'];
    const inline = (command: string) => items.find(m => m.command === command && m.group?.startsWith('inline'))?.when ?? '';
    const disconnect = viewItemRegex(inline('abbRobot.disconnectRobot'));
    for (const row of ['robot.connected', 'robot.connected.active', 'robot.connected.motion', 'robot.connected.active.motion']) { assert.ok(disconnect.test(row), row); }
    for (const row of ['robot.disconnected', 'robot.disconnected.active', 'robot.add']) { assert.ok(!disconnect.test(row), row); }
    assert.equal(inline('abbRobot.connectRobot'), 'viewItem == robot.disconnected || viewItem == robot.disconnected.active');
    const setActive = viewItemRegex(items.find(m => m.command === 'abbRobot.setActiveRobot')?.when ?? '');
    for (const row of ['robot.connected', 'robot.connected.motion', 'robot.disconnected']) { assert.ok(setActive.test(row), row); }
    for (const row of ['robot.connected.active', 'robot.connected.active.motion', 'robot.disconnected.active', 'robot.add']) { assert.ok(!setActive.test(row), row); }
  });

  it('the saved addresses and ranges have their commands, also in the Robots view\'s "…" menu', () => {
    const titles = new Map(manifest.contributes.commands.map(c => [c.command, `${c.category}: ${c.title}`]));
    assert.equal(titles.get('abbRobot.manageSavedAddresses'), 'ABB Robot: Manage Saved Addresses and Ranges…');
    assert.equal(titles.get('abbRobot.clearSavedAddresses'), 'ABB Robot: Remove All Saved Addresses and Ranges…');
    assert.equal(titles.get('abbRobot.removeRobot'), 'ABB Robot: Remove Robot…');
    const viewTitle = manifest.contributes.menus['view/title'].filter(m => m.when === 'view == abbRobot.robots').map(m => m.command);
    for (const command of ['abbRobot.manageSavedAddresses', 'abbRobot.clearSavedAddresses', 'abbRobot.removeRobot']) {
      assert.ok(viewTitle.includes(command), command);
    }
  });

  it('every command a menu names is contributed', () => {
    const contributed = new Set(manifest.contributes.commands.map(c => c.command));
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
      for (const e of entries) { assert.ok(contributed.has(e.command), `${menu}: ${e.command}`); }
    }
  });
});

describe('bundled client pin', () => {
  const pin = manifest.dependencies['abb-rws-client'];
  const m = /^file:vendor\/abb-rws-client-(\d+\.\d+\.\d+)\.tgz$/.exec(pin ?? '');

  it('is a vendored tarball, the single tarball in vendor/', () => {
    assert.ok(m, `pin ${pin}`);
    assert.deepEqual(fs.readdirSync(path.join(root, 'vendor')).filter(f => f.endsWith('.tgz')), [`abb-rws-client-${m[1]}.tgz`]);
  });

  it('the lock and node_modules hold that tarball, whose version names the discovery User-Agent', () => {
    assert.ok(m);
    const version = m[1];
    const tarball = fs.readFileSync(path.join(root, 'vendor', `abb-rws-client-${version}.tgz`));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>;
    };
    assert.equal(lock.version, manifest.version, 'the lock carries the extension version');
    assert.equal(lock.packages['']?.dependencies?.['abb-rws-client'], pin);
    const entry = lock.packages['node_modules/abb-rws-client'];
    assert.equal(entry?.version, version);
    assert.equal(entry?.resolved, pin);
    assert.equal(entry?.integrity, `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`);
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'package.json'), 'utf8')) as { version: string };
    assert.equal(installed.version, version, 'npm install after changing the pin');
    // The client fixes its version at its own build time; the bundle carries it into the probes' User-Agent.
    const versionJs = fs.readFileSync(path.join(root, 'node_modules', 'abb-rws-client', 'dist', 'version.js'), 'utf8');
    assert.match(versionJs, new RegExp(`CLIENT_VERSION = '${version.replace(/\./g, '\\.')}'`));
  });
});

describe('npm run vendor', () => {
  // A fresh clone has no vendor/ (its tarballs are gitignored); the script makes it, packs
  // the sibling client into it, and names the tarball after the client's version.
  const script = path.join(root, 'scripts', 'vendor.mjs');
  const fakeClient = (version: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-test-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'abb-rws-client', version }));
    return dir;
  };
  const run = (client: string) => spawnSync(process.execPath, [script, '--check', '--client', client], { encoding: 'utf8' });

  it('runs scripts/vendor.mjs', () => {
    assert.equal((manifest as unknown as { scripts: Record<string, string> }).scripts.vendor, 'node scripts/vendor.mjs');
  });

  it('produces the tarball the file: pin names', () => {
    const pinned = /^file:vendor\/(abb-rws-client-(\d+\.\d+\.\d+)\.tgz)$/.exec(manifest.dependencies['abb-rws-client'] ?? '');
    assert.ok(pinned);
    const r = run(fakeClient(pinned[2]));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `vendor/${pinned[1]}`);
  });

  it('refuses a client whose version the pin does not name', () => {
    const r = run(fakeClient('9.9.9'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /abb-rws-client-9\.9\.9\.tgz/);
  });

  it('--verify checks the pinned tarball against CLIENT_INTEGRITY, as CI does after packing', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string }> };
    const integrity = lock.packages['node_modules/abb-rws-client']?.integrity ?? '';
    const verify = (value: string | undefined) => spawnSync(process.execPath, [script, '--verify'], {
      encoding: 'utf8', env: { ...process.env, CLIENT_INTEGRITY: value },
    });
    const same = verify(integrity);
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /matches CLIENT_INTEGRITY/);
    const other = verify('sha512-AAAA');
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /packs to another tarball than the one the lock was made from/);
    assert.notEqual(verify('').status, 0, '--verify without CLIENT_INTEGRITY');
  });
});

describe('discovery settings in package.json', () => {
  const keys = ['abbRobot.discoveryManual', 'abbRobot.discoveryRanges', 'abbRobot.discoveryPorts'];

  it('are machine-scoped, so a workspace (for example a cloned repository) cannot plant an address or a range', () => {
    for (const key of keys) {
      assert.ok(properties[key], `${key} is contributed`);
      assert.equal(properties[key].scope, 'machine', key);
    }
  });

  it('start empty, so nothing beyond this PC is scanned until the user adds it', () => {
    for (const key of keys) {
      assert.deepEqual(properties[key].default, [], key);
    }
  });

  it('carry the client\'s caps and the plain note about range scans', () => {
    assert.equal(properties['abbRobot.discoveryManual'].maxItems, 16);
    assert.equal(properties['abbRobot.discoveryRanges'].maxItems, 16);
    assert.equal(properties['abbRobot.discoveryPorts'].maxItems, 8);
    assert.match(properties['abbRobot.discoveryRanges'].markdownDescription ?? '', /IT can see these attempts/);
  });
});

describe('the commands that write', () => {
  // The tier map in test/confirm.test.ts names the commands that ask before a write;
  // each is contributed, and the ones the views offer with one click have their titles.
  const confirmTest = fs.readFileSync(path.join(root, 'test', 'confirm.test.ts'), 'utf8');
  const asking = [...confirmTest.matchAll(/'(abbRobot\.\w+)': '(motion|disruptive|change)'/g)].map(m => m[1]);
  const contributed = new Set(manifest.contributes.commands.map(c => c.command));

  it('every command that asks before a write is contributed', () => {
    assert.ok(asking.length >= 15, `${asking.length} commands ask`);
    for (const id of asking) { assert.ok(contributed.has(id), id); }
  });

  it('the one-click writes keep their titles: the I/O tree toggle and the CodeLens run', () => {
    const titles = new Map(manifest.contributes.commands.map(c => [c.command, c.title]));
    assert.equal(titles.get('abbRobot.toggleSignal'), 'Toggle Signal');
    assert.ok(titles.has('abbRobot.runRoutineFromCodeLens'));
    assert.ok(titles.has('abbRobot.startRapid'));
  });

  it('Start RAPID stays on the status bar and in the palette; the confirmation is the gate', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    assert.match(src, /'abbRobot\.startRapid'/);
    assert.doesNotMatch(src, /abbRobot\.confirm\w*/, 'no setting turns a confirmation off');
    assert.equal(Object.keys(properties).filter(k => /confirm/i.test(k)).length, 0);
  });
});
