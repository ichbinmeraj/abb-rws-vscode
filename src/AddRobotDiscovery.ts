/**
 * The non-UI half of the Add Robot discovery flow: reading the discovery settings, parsing what
 * the user types, building the `findControllers` options, turning results into picker rows, and
 * the confirmation gate in front of every range scan.
 *
 * No `vscode` import and only type imports from the client, so the unit tests run under plain
 * Node. `extension.ts` owns the dialogs and passes in what this file needs (for example the
 * client's `isLocalAddress`).
 */

import type {
  DiscoveryProgress,
  FindControllersOptions,
  FindControllersResult,
  FoundController,
  ManualTarget,
} from 'abb-rws-client';

// ─── Limits (the client refuses more; these keep a saved list scannable) ─────

/** At most this many saved addresses (the client's cap on `manual`). */
export const MAX_SAVED_ADDRESSES = 16;
/** At most this many saved ranges (the client's cap on `ranges`). */
export const MAX_SAVED_RANGES = 16;
/** At most this many extra ports (the client's cap on `ports`). */
export const MAX_EXTRA_PORTS = 8;
/** The client's default cap on the addresses of one range scan. */
export const MAX_RANGE_ADDRESSES = 256;

/** The address of a controller's service port. */
export const SERVICE_ADDRESS = '192.168.125.1';

/** The plain note shown before every range scan. */
export const RANGE_IT_NOTE =
  'Scanning a range opens TCP connections to every address in it. On a company network IT can '
  + 'see these attempts, and intrusion detection may flag them.';

const IPV6_REASON = 'RobotWare does not support IPv6: enter an IPv4 address or a host name.';

// ─── Parsing what the user types ─────────────────────────────────────────────

/** What one line typed into "Add address / range" or "Enter address manually" means. */
export type ParsedAddress =
  | { kind: 'host'; host: string; port?: number; https?: boolean }
  /** `first` and `last` are the 32-bit values of the first and last address scanned. */
  | { kind: 'range'; range: string; addresses: number; first: number; last: number }
  | { kind: 'invalid'; reason: string };

/** The 32-bit value of a dotted IPv4 literal, or undefined. No leading zeros beyond one digit. */
export function parseIPv4(text: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) { return undefined; }
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part.startsWith('0')) { return undefined; }
    const n = Number(part);
    if (n > 255) { return undefined; }
    value = value * 256 + n;
  }
  return value;
}

/** Dotted form of a 32-bit IPv4 value. */
function formatIPv4(value: number): string {
  return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');
}

/** RFC 1123 host-name label. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Why `host` is not an IPv4 literal or a host name, or undefined when it is one. */
function hostProblem(host: string): string | undefined {
  if (host.length === 0) { return 'Enter an IP address or a host name.'; }
  if (parseIPv4(host) !== undefined) { return undefined; }
  if (/^[\d.]+$/.test(host)) { return `"${host}" is not a valid IPv4 address.`; }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  const labels = name.split('.');
  if (name.length === 0 || name.length > 253 || !labels.every(l => LABEL.test(l))) {
    return `"${host}" is not an IP address or a host name (letters, digits, hyphens and dots).`;
  }
  if (/^\d+$/.test(labels[labels.length - 1])) { return `"${host}" is not a valid IPv4 address.`; }
  return undefined;
}

/**
 * Parse one typed line: an IPv4 address or host name, optionally `:port`; a URL such as
 * `https://10.0.5.20:443/`; a CIDR range `10.0.5.0/24`; or a dash range `10.0.5.20-10.0.5.60`
 * (both ends in full). The port is split from the right. IPv6 is refused (RobotWare does not
 * support it). A range's `addresses` follows the client: CIDR drops the network and broadcast
 * addresses for prefixes up to /30.
 */
export function parseAddressInput(input: string): ParsedAddress {
  let t = input.trim().replace(/\s*([/-])\s*/g, '$1');
  if (t.length === 0) { return { kind: 'invalid', reason: 'Enter an IP address, a host name, host:port, or a range.' }; }

  let https: boolean | undefined;
  const url = /^(https?):\/\/([^/?#]*)[/?#]?.*$/i.exec(t);
  if (url) {
    https = url[1].toLowerCase() === 'https';
    t = url[2];
  }
  if (/\s/.test(t)) { return { kind: 'invalid', reason: 'Enter one address or range, without spaces.' }; }
  if (t.startsWith('[') || (t.match(/:/g) ?? []).length > 1) { return { kind: 'invalid', reason: IPV6_REASON }; }

  if (!url && t.includes('/')) {
    const m = /^([\d.]+)\/(\d{1,2})$/.exec(t);
    const base = m ? parseIPv4(m[1]) : undefined;
    const prefix = m ? Number(m[2]) : NaN;
    if (base === undefined || !(prefix >= 0 && prefix <= 32)) {
      return { kind: 'invalid', reason: 'A CIDR range looks like 10.0.5.0/24 (IPv4, prefix 0-32).' };
    }
    const size = 2 ** (32 - prefix);
    const network = base - (base % size);
    // /31 and /32 have no network or broadcast address to drop.
    const first = prefix <= 30 ? network + 1 : network;
    const last = prefix <= 30 ? network + size - 2 : network + size - 1;
    return { kind: 'range', range: `${formatIPv4(network)}/${prefix}`, addresses: last - first + 1, first, last };
  }

  if (!url) {
    const dash = t.indexOf('-');
    const left = dash > 0 ? parseIPv4(t.slice(0, dash)) : undefined;
    if (left !== undefined) {
      const right = parseIPv4(t.slice(dash + 1));
      if (right === undefined) {
        return { kind: 'invalid', reason: 'Write both ends of a range in full, like 10.0.5.20-10.0.5.60.' };
      }
      if (left > right) { return { kind: 'invalid', reason: 'The first address of a range must not be above the last.' }; }
      return { kind: 'range', range: `${formatIPv4(left)}-${formatIPv4(right)}`, addresses: right - left + 1, first: left, last: right };
    }
  }

  let host = t;
  let port: number | undefined;
  const colon = t.lastIndexOf(':');
  if (colon >= 0) {
    host = t.slice(0, colon);
    const portText = t.slice(colon + 1);
    port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!(port >= 1 && port <= 65535)) { return { kind: 'invalid', reason: 'The port must be a number from 1 to 65535.' }; }
  }
  const problem = hostProblem(host);
  if (problem) { return { kind: 'invalid', reason: problem }; }
  return {
    kind: 'host',
    host,
    ...(port !== undefined ? { port } : {}),
    ...(https !== undefined ? { https } : {}),
  };
}

/** Number of addresses in a saved range, or undefined when the text is not a range. */
export function rangeAddressCount(range: string): number | undefined {
  const p = parseAddressInput(range);
  return p.kind === 'range' ? p.addresses : undefined;
}

/** The blocks a range may lie in (private, loopback, link-local); the client refuses anything else by default. */
const RANGE_BLOCKS: ReadonlyArray<readonly [number, number]> = ([
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16],
] as const).map(([base, bits]) => {
  const start = parseIPv4(base) ?? 0;
  return [start, start + 2 ** (32 - bits) - 1] as const;
});

/**
 * Why a parsed range cannot be saved, or undefined when it can: more addresses than one scan
 * takes, or addresses outside 10/8, 172.16/12, 192.168/16, 127/8 and 169.254/16.
 */
export function rangeProblem(p: Extract<ParsedAddress, { kind: 'range' }>): string | undefined {
  if (p.addresses > MAX_RANGE_ADDRESSES) {
    return `${p.range} has ${p.addresses} addresses; one scan takes at most ${MAX_RANGE_ADDRESSES} (a /24).`;
  }
  if (!RANGE_BLOCKS.some(([lo, hi]) => p.first >= lo && p.last <= hi)) {
    return `${p.range} reaches outside the private ranges 10.x, 172.16-31.x, 192.168.x (and 127.x, 169.254.x).`;
  }
  return undefined;
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** The three discovery settings, checked. */
export interface DiscoverySettings {
  /** `abbRobot.discoveryManual`: hosts the Add Robot scan probes every time. */
  manual: ManualTarget[];
  /** `abbRobot.discoveryRanges`: saved ranges; scanned only when the user picks them in a run. */
  ranges: string[];
  /** `abbRobot.discoveryPorts`: extra ports for addresses without a port of their own. */
  ports: number[];
  /** Saved values that were left out, in plain words (for the log). */
  skipped: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Key that makes two saved addresses the same entry. */
export function manualTargetKey(t: ManualTarget): string {
  return `${t.host.trim().toLowerCase()}:${t.port ?? ''}`;
}

/**
 * Check the raw setting values. Malformed entries are left out (and named in `skipped`), so one
 * bad hand edit cannot make every scan fail; the lists are cut at the client's caps.
 */
export function readDiscoverySettings(raw: { manual?: unknown; ranges?: unknown; ports?: unknown }): DiscoverySettings {
  const skipped: string[] = [];
  const show = (v: unknown): string => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

  const manual: ManualTarget[] = [];
  const seenManual = new Set<string>();
  for (const entry of Array.isArray(raw.manual) ? raw.manual : []) {
    if (!isRecord(entry) || typeof entry.host !== 'string') {
      skipped.push(`abbRobot.discoveryManual: ${show(entry)} is not { "host": "...", "port"?: n, "https"?: true|false }`);
      continue;
    }
    const host = entry.host.trim();
    const problem = host.includes(':')
      ? 'a host has no ":" (the port goes in "port"; RobotWare does not support IPv6):'
      : hostProblem(host);
    if (problem) {
      skipped.push(`abbRobot.discoveryManual: ${problem} ${show(entry.host)}`);
      continue;
    }
    const target: ManualTarget = { host };
    if (entry.port !== undefined) {
      if (typeof entry.port !== 'number' || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
        skipped.push(`abbRobot.discoveryManual: port ${show(entry.port)} of ${host} is not 1-65535`);
        continue;
      }
      target.port = entry.port;
    }
    if (entry.https !== undefined) {
      if (typeof entry.https !== 'boolean') {
        skipped.push(`abbRobot.discoveryManual: "https" of ${host} must be true or false`);
        continue;
      }
      target.https = entry.https;
    }
    const key = manualTargetKey(target);
    if (seenManual.has(key)) { continue; }
    if (manual.length >= MAX_SAVED_ADDRESSES) {
      skipped.push(`abbRobot.discoveryManual: more than ${MAX_SAVED_ADDRESSES} entries; ${host} and later entries left out`);
      break;
    }
    seenManual.add(key);
    manual.push(target);
  }

  const ranges: string[] = [];
  for (const entry of Array.isArray(raw.ranges) ? raw.ranges : []) {
    const parsed = typeof entry === 'string' ? parseAddressInput(entry) : undefined;
    if (!parsed || parsed.kind !== 'range') {
      skipped.push(`abbRobot.discoveryRanges: ${show(entry)} is not a CIDR (10.0.5.0/24) or dash (10.0.5.20-10.0.5.60) range`);
      continue;
    }
    const problem = rangeProblem(parsed);
    if (problem) {
      skipped.push(`abbRobot.discoveryRanges: ${problem}`);
      continue;
    }
    if (ranges.includes(parsed.range)) { continue; }
    if (ranges.length >= MAX_SAVED_RANGES) {
      skipped.push(`abbRobot.discoveryRanges: more than ${MAX_SAVED_RANGES} entries; ${parsed.range} and later entries left out`);
      break;
    }
    ranges.push(parsed.range);
  }

  const ports: number[] = [];
  for (const entry of Array.isArray(raw.ports) ? raw.ports : []) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > 65535) {
      skipped.push(`abbRobot.discoveryPorts: ${show(entry)} is not a port from 1 to 65535`);
      continue;
    }
    if (ports.includes(entry)) { continue; }
    if (ports.length >= MAX_EXTRA_PORTS) {
      skipped.push(`abbRobot.discoveryPorts: more than ${MAX_EXTRA_PORTS} ports; ${entry} and later ports left out`);
      break;
    }
    ports.push(entry);
  }

  for (const key of ['manual', 'ranges', 'ports'] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      skipped.push(`abbRobot.discovery${key === 'manual' ? 'Manual' : key === 'ranges' ? 'Ranges' : 'Ports'} must be a list`);
    }
  }
  return { manual, ranges, ports, skipped };
}

/** The saved lists after adding one parsed entry. `added` is false for a duplicate or a full list. */
export function withSavedEntry(
  saved: { manual: ManualTarget[]; ranges: string[] },
  entry: ParsedAddress,
): { manual: ManualTarget[]; ranges: string[]; added: boolean; full: boolean } {
  const manual = [...saved.manual];
  const ranges = [...saved.ranges];
  if (entry.kind === 'host') {
    const target: ManualTarget = { host: entry.host };
    if (entry.port !== undefined) { target.port = entry.port; }
    if (entry.https !== undefined) { target.https = entry.https; }
    if (manual.some(m => manualTargetKey(m) === manualTargetKey(target))) { return { manual, ranges, added: false, full: false }; }
    if (manual.length >= MAX_SAVED_ADDRESSES) { return { manual, ranges, added: false, full: true }; }
    manual.push(target);
    return { manual, ranges, added: true, full: false };
  }
  if (entry.kind === 'range') {
    if (ranges.includes(entry.range)) { return { manual, ranges, added: false, full: false }; }
    if (ranges.length >= MAX_SAVED_RANGES) { return { manual, ranges, added: false, full: true }; }
    ranges.push(entry.range);
    return { manual, ranges, added: true, full: false };
  }
  return { manual, ranges, added: false, full: false };
}

/** `host` or `host:port` for display. */
export function targetLabel(t: { host: string; port?: number }): string {
  return t.port === undefined ? t.host : `${t.host}:${t.port}`;
}

// ─── Scan options ────────────────────────────────────────────────────────────

/** What the user chose for one wizard scan. This PC is always scanned. */
export interface ScanChoice {
  /** Probe 192.168.125.1 even when this PC has no address in 192.168.125.0/24 (otherwise: only then). */
  serviceAddress: boolean;
  /** Send one mDNS query and list what answers. */
  mdns: boolean;
  /** Probe the saved addresses. */
  savedAddresses: boolean;
  /** Saved ranges picked for this run. Each scan that has any asks first. */
  ranges: string[];
}

/** The first scan of the wizard: this PC, the service address when this PC is on its subnet, mDNS, the saved addresses. Never a range. */
export const DEFAULT_SCAN_CHOICE: Readonly<ScanChoice> = Object.freeze({
  serviceAddress: false,
  mdns: true,
  savedAddresses: true,
  ranges: [] as string[],
});

/** Options every wizard scan shares. */
export interface ScanExtras {
  strictTls: boolean;
  signal?: AbortSignal;
  onProgress?: (e: DiscoveryProgress) => void;
}

/** `findControllers` options for a wizard scan. Ranges come only from `choice`, never from the settings. */
export function wizardScanOptions(choice: ScanChoice, settings: DiscoverySettings, extras: ScanExtras): FindControllersOptions {
  return {
    local: true,
    serviceAddress: choice.serviceAddress ? true : 'auto',
    mdns: choice.mdns,
    manual: choice.savedAddresses ? settings.manual : [],
    ranges: [...choice.ranges],
    ports: settings.ports,
    identify: 'anonymous',
    strictTls: extras.strictTls,
    ...(extras.signal ? { signal: extras.signal } : {}),
    ...(extras.onProgress ? { onProgress: extras.onProgress } : {}),
  };
}

/** `findControllers` options for a scan of named targets only: no scan of this PC, no service address, no mDNS. */
export function targetScanOptions(
  targets: { manual?: ManualTarget[]; ranges?: string[] },
  ports: number[],
  extras: ScanExtras,
): FindControllersOptions {
  return {
    local: false,
    serviceAddress: false,
    mdns: false,
    manual: targets.manual ?? [],
    ranges: targets.ranges ?? [],
    ports,
    identify: 'anonymous',
    strictTls: extras.strictTls,
    ...(extras.signal ? { signal: extras.signal } : {}),
    ...(extras.onProgress ? { onProgress: extras.onProgress } : {}),
  };
}

/** The confirmation text shown before a scan that includes ranges. */
export function rangeScanWarning(ranges: string[]): { message: string; detail: string } {
  const lines = ranges.map(r => {
    const n = rangeAddressCount(r);
    return n === undefined ? `• ${r}` : `• ${r} (${n} address${n === 1 ? '' : 'es'})`;
  });
  const total = ranges.reduce((sum, r) => sum + (rangeAddressCount(r) ?? 0), 0);
  return {
    message: ranges.length === 1
      ? `Scan the range ${ranges[0]}?`
      : `Scan ${ranges.length} ranges (${total} addresses)?`,
    detail: `${lines.join('\n')}\n\n${RANGE_IT_NOTE}\n\nEach address gets up to 3 connection attempts `
      + '(443, 80 over TLS, 80 over HTTP), plus up to 2 per extra port, at most 10 new connections per second. '
      + `At most ${MAX_RANGE_ADDRESSES} addresses per scan.`,
  };
}

/**
 * Run a scan, asking first whenever it includes a range (every time; no "don't ask again").
 * Resolves undefined when the user declines; then nothing is sent.
 */
export async function scanWithRangeGate(
  options: FindControllersOptions,
  deps: {
    confirm: (warning: { message: string; detail: string }) => Promise<boolean>;
    find: (options: FindControllersOptions) => Promise<FindControllersResult>;
  },
): Promise<FindControllersResult | undefined> {
  const ranges = options.ranges ?? [];
  if (ranges.length > 0 && !(await deps.confirm(rangeScanWarning(ranges)))) { return undefined; }
  return deps.find(options);
}

/** A result with nothing in it (a scan that could not start). */
export function emptyResult(): FindControllersResult {
  return {
    controllers: [],
    aborted: false,
    localScan: { status: 'skipped', attempts: [], vcFilter: 'off', sweep: false },
    environment: { wsl: false },
    tlsFailures: [],
    unmatchedCredentials: [],
    notes: [],
  };
}

/** A progress line for the notification. */
export function progressMessage(e: DiscoveryProgress): string {
  const found = e.found > 0 ? ` - ${e.found} found` : '';
  switch (e.phase) {
    case 'local-scan': return 'reading this PC\'s listening ports…';
    case 'sweep': return `checking ports on this PC (${e.total})…${found}`;
    case 'mdns': return `listening for mDNS answers…${found}`;
    case 'probe': return `${e.probed}/${e.total} probes${found}`;
    case 'identify': return `reading controller names…${found}`;
    case 'done': return `done${found}`;
  }
  return '';
}

/** The client's refusal text without its function-name prefix. */
export function discoveryErrorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^findControllers:\s*/, '');
}

// ─── Results to picker rows ──────────────────────────────────────────────────

/**
 * - `'ready'`: probed, and the login challenge is ABB's (or a login worked).
 * - `'unconfirmed'`: answered with a login challenge from someone else; adding needs a confirm.
 * - `'announced'`: an mDNS announcement only; probed when picked, its scheme is never guessed.
 */
export type RowStatus = 'ready' | 'unconfirmed' | 'announced';

/** One controller row of the picker. */
export interface ControllerRow {
  key: string;
  label: string;
  description: string;
  detail: string;
  status: RowStatus;
  controller: FoundController;
}

const SOURCE_WORDS: Record<string, string> = {
  'this-pc': 'this PC',
  'service-address': `the service port address (${SERVICE_ADDRESS})`,
  manual: 'an address you entered or saved',
  range: 'a saved range',
  mdns: 'mDNS',
};

/** The status of one result. */
export function rowStatus(c: FoundController): RowStatus {
  if (!c.probe) { return 'announced'; }
  return c.identified ? 'ready' : 'unconfirmed';
}

/** One picker row per controller, in the client's order, the first entry kept for a repeated key. */
export function controllerRows(controllers: FoundController[]): ControllerRow[] {
  const seen = new Set<string>();
  const rows: ControllerRow[] = [];
  for (const c of controllers) {
    if (seen.has(c.key)) { continue; }
    seen.add(c.key);
    const status = rowStatus(c);
    const where = `${c.name ?? c.host}:${c.port}`;
    const label = `$(circuit-board)  ${c.systemName ? `${c.systemName} - ${where}` : where}`;

    const parts: string[] = [];
    const generation = c.generation === 'rws2' ? 'RWS 2.0 · OmniCore' : c.generation === 'rws1' ? 'RWS 1.0 · IRC5' : undefined;
    // An mDNS-only entry's generation is the announcement's guess, so it is shown as one.
    if (generation) { parts.push(status === 'announced' ? `announced as ${generation}` : generation); }
    if (c.rwVersion) { parts.push(`RobotWare ${c.rwVersion}`); }
    else if (c.generation === 'rws1' && status !== 'announced') { parts.push('RobotWare 6'); }
    else if (c.generation === 'rws2' && status !== 'announced') { parts.push('RobotWare 7 or 8'); }
    if (c.https === true) { parts.push('HTTPS'); }
    if (c.https === false) { parts.push('HTTP'); }
    if (c.isVirtual) { parts.push('virtual controller'); }

    const via = `Found via ${c.sources.map(s => SOURCE_WORDS[s] ?? s).join(', ')}`;
    const detail = status === 'unconfirmed'
      ? `$(warning) Not confirmed as ABB: its login challenge names "${c.realm ?? 'no realm'}", not the one ABB controllers send. ${via}`
      : status === 'announced'
        ? `Announced via mDNS, not probed yet: picking it probes ${c.host}:${c.port} first`
        : via;
    rows.push({ key: c.key, label, description: parts.join(' · '), detail, status, controller: c });
  }
  return rows;
}

/**
 * The results of an earlier and a later scan in one list, one entry per key. A probed entry
 * wins over an mDNS-only one; sources are combined. Earlier entries keep their place.
 */
export function mergeResults(earlier: FoundController[], later: FoundController[]): FoundController[] {
  const out = earlier.map(c => ({ ...c, sources: [...c.sources] }));
  for (const c of later) {
    const i = out.findIndex(o => o.key === c.key);
    if (i < 0) { out.push({ ...c, sources: [...c.sources] }); continue; }
    const kept = !out[i].probe && c.probe ? { ...c, sources: [...c.sources] } : out[i];
    const other = kept === out[i] ? c : out[i];
    for (const s of other.sources) { if (!kept.sources.includes(s)) { kept.sources.push(s); } }
    out[i] = kept;
  }
  return out;
}

/** What `finishAddRobot` needs from a picked controller. */
export interface PickedController {
  host: string;
  port: number;
  useHttps: boolean;
  authType: 'digest' | 'basic';
  suggestedName?: string;
}

/** The host to save for a result: the name the user typed, else the address (`localhost` saved as 127.0.0.1). */
export function hostToSave(c: Pick<FoundController, 'host' | 'name'>): string {
  return c.name && !/^localhost\.?$/i.test(c.name) ? c.name : c.host;
}

/** Connection parameters of a probed result; undefined for an mDNS-only entry (probe it first). */
export function selectionFor(c: FoundController): PickedController | undefined {
  if (!c.probe) { return undefined; }
  return {
    host: hostToSave(c),
    port: c.probe.port,
    useHttps: c.probe.useHttps,
    authType: c.probe.authType,
    ...(c.systemName ? { suggestedName: c.systemName } : {}),
  };
}

/**
 * The results that answer for one saved address: found through an entered or saved address on
 * the same host (address, typed name, or a folded address; `localhost` and 127.x match any entry
 * on this PC) and, when the saved entry has a port, on that port.
 */
export function answeringControllers(saved: ManualTarget, controllers: FoundController[]): FoundController[] {
  const lc = (s: string | undefined): string => (s ?? '').trim().toLowerCase().replace(/\.$/, '');
  const host = lc(saved.host);
  const onThisPc = host === 'localhost' || host.startsWith('127.');
  return controllers.filter(c => {
    if (!c.sources.includes('manual')) { return false; }
    const addresses = [{ host: c.host, port: c.port }, ...(c.addresses ?? []).map(a => ({ host: a.host, port: a.port }))];
    return addresses.some(a => {
      const sameHost = lc(a.host) === host || lc(c.name) === host || (onThisPc && c.key.startsWith('local:'));
      return sameHost && (saved.port === undefined || a.port === saved.port);
    });
  });
}

/** Saved addresses that no result answers for (see `answeringControllers`). */
export function unansweredSavedAddresses(saved: ManualTarget[], controllers: FoundController[]): ManualTarget[] {
  return saved.filter(m => answeringControllers(m, controllers).length === 0);
}

// ─── Removing saved addresses and ranges ─────────────────────────────────────

/** One saved address or saved range, as the picker shows it. */
export type SavedEntry =
  | { kind: 'address'; target: ManualTarget }
  | { kind: 'range'; range: string };

/** The saved entries of the checked settings: the addresses first, then the ranges. */
export function savedEntries(settings: Pick<DiscoverySettings, 'manual' | 'ranges'>): SavedEntry[] {
  return [
    ...settings.manual.map((target): SavedEntry => ({ kind: 'address', target })),
    ...settings.ranges.map((range): SavedEntry => ({ kind: 'range', range })),
  ];
}

/** Display text of a saved entry: `host`, `host:port` or the range. */
export function savedEntryLabel(entry: SavedEntry): string {
  return entry.kind === 'address' ? targetLabel(entry.target) : entry.range;
}

/** A settings scope the two saved lists can have a value in (`WorkspaceConfiguration.inspect`). */
export type SavedScope = 'global' | 'workspace';

/** The raw values of `abbRobot.discoveryManual` and `abbRobot.discoveryRanges` in one scope; undefined when the scope does not set it. */
export interface ScopedSavedValues {
  manual?: unknown;
  ranges?: unknown;
}

/**
 * One settings write. `key` is only ever one of the two saved lists: removing saved entries never
 * touches `abbRobot.robots`, the passwords in secure storage or `abbRobot.discoveryPorts`.
 * `value` undefined removes the setting from that scope (its default is the empty list).
 */
export interface SavedListWrite {
  key: 'discoveryManual' | 'discoveryRanges';
  scope: SavedScope;
  value: unknown[] | undefined;
}

const SAVED_SCOPES: readonly SavedScope[] = ['global', 'workspace'];

/**
 * Whether a raw `abbRobot.discoveryManual` element is the saved address with this key. Only a
 * well-formed element can match (readDiscoverySettings' rules): one with a port that is not a
 * whole number from 1 to 65535, or an "https" that is not true or false, is left as it is.
 */
function isSavedAddress(raw: unknown, key: string): boolean {
  if (!isRecord(raw) || typeof raw.host !== 'string') { return false; }
  if (raw.port !== undefined
    && (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)) { return false; }
  if (raw.https !== undefined && typeof raw.https !== 'boolean') { return false; }
  const port = raw.port as number | undefined;
  return manualTargetKey({ host: raw.host, ...(port !== undefined ? { port } : {}) }) === key;
}

/** Whether a raw `abbRobot.discoveryRanges` element is this range (in any spelling the picker folds to it). */
function isSavedRange(raw: unknown, range: string): boolean {
  if (typeof raw !== 'string') { return false; }
  const p = parseAddressInput(raw);
  return p.kind === 'range' && p.range === range;
}

/**
 * The writes that remove `entries`, in every scope whose list holds one of them. All other
 * elements stay as they were and in their order, also ones the checks leave out; a scope without
 * a match gets no write. A list left empty is removed from its scope.
 */
export function removalWrites(scopes: Partial<Record<SavedScope, ScopedSavedValues>>, entries: SavedEntry[]): SavedListWrite[] {
  const addressKeys = entries.filter(e => e.kind === 'address').map(e => manualTargetKey((e as Extract<SavedEntry, { kind: 'address' }>).target));
  const ranges = entries.filter(e => e.kind === 'range').map(e => (e as Extract<SavedEntry, { kind: 'range' }>).range);
  const writes: SavedListWrite[] = [];
  for (const scope of SAVED_SCOPES) {
    const values = scopes[scope];
    if (!values) { continue; }
    const lists = [
      { key: 'discoveryManual' as const, raw: values.manual, drop: (v: unknown) => addressKeys.some(k => isSavedAddress(v, k)) },
      { key: 'discoveryRanges' as const, raw: values.ranges, drop: (v: unknown) => ranges.some(r => isSavedRange(v, r)) },
    ];
    for (const { key, raw, drop } of lists) {
      if (!Array.isArray(raw)) { continue; }
      const kept = raw.filter(v => !drop(v));
      if (kept.length === raw.length) { continue; }
      writes.push({ key, scope, value: kept.length > 0 ? kept : undefined });
    }
  }
  return writes;
}

/**
 * The writes that remove every saved address and range: both lists are removed from each scope
 * that sets them, also a value the checks cannot read. Nothing else is written.
 */
export function clearAllWrites(scopes: Partial<Record<SavedScope, ScopedSavedValues>>): SavedListWrite[] {
  const writes: SavedListWrite[] = [];
  for (const scope of SAVED_SCOPES) {
    const values = scopes[scope];
    if (!values) { continue; }
    if (values.manual !== undefined) { writes.push({ key: 'discoveryManual', scope, value: undefined }); }
    if (values.ranges !== undefined) { writes.push({ key: 'discoveryRanges', scope, value: undefined }); }
  }
  return writes;
}

// ─── Notes ───────────────────────────────────────────────────────────────────

/**
 * A hint for a window whose extension host runs elsewhere (Remote - WSL, SSH, Dev Containers,
 * Codespaces): discovery runs there, not on the PC that shows the window.
 */
export function remoteWindowHint(remoteName: string | undefined): string | undefined {
  if (!remoteName) { return undefined; }
  if (remoteName === 'wsl') {
    return 'This window runs inside WSL: RobotStudio virtual controllers on Windows may not be visible from here. '
      + 'Open the folder in a local window, or enter 127.0.0.1:<port> if WSL shares localhost with Windows.';
  }
  return `This window runs on a remote host (${remoteName}): the scan runs there and cannot see RobotStudio `
    + 'virtual controllers on your PC. Enter the controller\'s address instead.';
}

/** The notes the picker shows: the remote-window hint first, then the result's own notes and certificate failures. */
export function displayNotes(result: FindControllersResult, remoteName: string | undefined): string[] {
  const hint = remoteWindowHint(remoteName);
  const notes = hint ? [hint] : [];
  for (const n of result.notes) {
    if (hint && remoteName === 'wsl' && /^Running inside WSL/.test(n)) { continue; }
    if (!notes.includes(n)) { notes.push(n); }
  }
  if (result.tlsFailures.length > 0) {
    const list = result.tlsFailures.map(f => `${f.host}:${f.port}`).join(', ');
    notes.push(`Certificate not trusted (abbRobot.strictTls is on), so these were not probed: ${list}`);
  }
  return notes;
}

/**
 * Credentials to pre-fill: the factory defaults of a RobotStudio virtual controller on this PC,
 * nothing for another machine. `authType` is how the controller answered the probe: `digest` is
 * RWS 1.0 (IRC5, RobotWare 6), `basic` is RWS 2.0 (OmniCore, RobotWare 7 and 8). Undefined when
 * it is not known yet (Configure Robot, where only an address is typed).
 */
export function credentialDefaults(onThisPc: boolean, authType?: 'digest' | 'basic'): { username: string; password: string } {
  if (!onThisPc) { return { username: '', password: '' }; }
  // An RWS 2.0 VC has "Admin", whose grants the write commands need; an RW 6 VC has no "Admin".
  // "Default User" exists on every VC, so it is the default whenever the generation is unknown.
  return { username: authType === 'basic' ? 'Admin' : 'Default User', password: 'robotics' };
}
