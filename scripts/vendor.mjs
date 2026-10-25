#!/usr/bin/env node
/**
 * `npm run vendor`: packs the client checked out beside this repo (../abb-rws-client)
 * into vendor/, the tarball package.json's `file:` pin names.
 *
 * - Makes vendor/ (a fresh clone has none: its tarballs are gitignored).
 * - Installs the client's dependencies first when it has no node_modules, since its
 *   prepack checks the installed tree, builds and runs its tests.
 * - Refuses when the client's version is not the one the pin names, and removes any
 *   other client tarball from vendor/, so `npm ci` installs exactly the pinned one.
 * - With CLIENT_INTEGRITY set (CI sets the lock's, .github/workflows/ci.yml), refuses a
 *   packed tarball whose sha512 is another: a client tag that packs to another tarball
 *   than the one the lock was made from fails here, naming both, not later in `npm ci`.
 *
 * Options: --client <dir> (default ../abb-rws-client); --check prints the tarball
 * path it would produce and exits, without packing; --verify checks the pinned
 * tarball already in vendor/ against CLIENT_INTEGRITY, without a client or a pack.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const client = path.resolve(root, opt('--client') ?? path.join('..', 'abb-rws-client'));

function fail(message) {
  console.error(`vendor: ${message}`);
  process.exit(1);
}

/** With CLIENT_INTEGRITY set, refuses `file` unless its sha512, in the lock's form, is that one. */
function checkIntegrity(file) {
  const want = (process.env.CLIENT_INTEGRITY ?? '').trim();
  if (!want) return;
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (!fs.existsSync(file)) fail(`no ${rel} to check against CLIENT_INTEGRITY`);
  const got = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
  if (got !== want) {
    fail(`${rel} is ${got}, but CLIENT_INTEGRITY (the lock's) is ${want}: the client checked out packs to another tarball than the one the lock was made from`);
  }
  console.log(`vendor: ${rel} matches CLIENT_INTEGRITY`);
}

if (args.includes('--verify')) {
  const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['abb-rws-client'];
  const m = /^file:(vendor\/abb-rws-client-[^/]+\.tgz)$/.exec(pinned ?? '');
  if (!m) fail(`package.json pins ${pinned}, not a vendor/ tarball`);
  if (!(process.env.CLIENT_INTEGRITY ?? '').trim()) fail('--verify needs CLIENT_INTEGRITY');
  checkIntegrity(path.join(root, m[1]));
  process.exit(0);
}

const clientPkgPath = path.join(client, 'package.json');
if (!fs.existsSync(clientPkgPath)) {
  fail(`no client at ${client}. Clone abb-rws-client beside this repo, at the tag matching the pin.`);
}
const clientPkg = JSON.parse(fs.readFileSync(clientPkgPath, 'utf8'));
if (clientPkg.name !== 'abb-rws-client') fail(`${client} holds ${clientPkg.name}, not abb-rws-client`);

const tarball = `abb-rws-client-${clientPkg.version}.tgz`;
const pin = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['abb-rws-client'];
if (pin !== `file:vendor/${tarball}`) {
  fail(`the client at ${client} packs to ${tarball}, but package.json pins ${pin}. Check out the client tag that matches the pin.`);
}

if (args.includes('--check')) {
  console.log(`vendor/${tarball}`);
  process.exit(0);
}

const npm = (cwd, npmArgs) => {
  console.log(`vendor: npm ${npmArgs.join(' ')} (in ${cwd})`);
  // shell: npm is npm.cmd on Windows; every argument here is fixed or a plain path.
  const command = ['npm', ...npmArgs.map(a => (a.includes(' ') ? `"${a}"` : a))].join(' ');
  const r = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`npm ${npmArgs[0]} failed (exit ${r.status})`);
};

const vendor = path.join(root, 'vendor');
fs.mkdirSync(vendor, { recursive: true });
for (const f of fs.readdirSync(vendor)) {
  if (/^abb-rws-client-.*\.tgz$/.test(f) && f !== tarball) fs.rmSync(path.join(vendor, f));
}

if (!fs.existsSync(path.join(client, 'node_modules'))) npm(client, ['ci']);
npm(client, ['pack', '--pack-destination', vendor]);

if (!fs.existsSync(path.join(vendor, tarball))) fail(`npm pack wrote no vendor/${tarball}`);
console.log(`vendor: wrote vendor/${tarball}`);
checkIntegrity(path.join(vendor, tarball));
