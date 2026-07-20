import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MultiRobotManager, RobotManager, setLogger } from 'abb-rws-client';
import type { RobotConfig, DiscoveredController, MdnsController } from 'abb-rws-client';
import { StatusTreeProvider } from './StatusTreeProvider';
import { MotionTreeProvider } from './MotionTreeProvider';
import { RapidTreeProvider } from './RapidTreeProvider';
import { ModulesTreeProvider } from './ModulesTreeProvider';
import { ElogTreeProvider } from './ElogTreeProvider';
import { FileExplorerProvider } from './FileExplorerProvider';
import { IoTreeProvider } from './IoTreeProvider';
import { RobotsTreeProvider } from './RobotsTreeProvider';
import { CfgTreeProvider } from './CfgTreeProvider';
import { VariableWatchProvider } from './VariableWatchProvider';
import { ControllerSourceProvider } from './ControllerSourceProvider';
import { LiveCellWebviewProvider } from './LiveCellWebviewProvider';
import { CompositeTreeProvider } from './CompositeTreeProvider';
import { TabbedProgramWebviewProvider } from './TabbedProgramWebviewProvider';
import { RapidLanguageIndex } from './RapidLanguageIndex';
import { RapidDefinitionProvider } from './RapidDefinitionProvider';
import { RapidDocumentSymbolProvider } from './RapidDocumentSymbolProvider';
import { RapidReferenceProvider } from './RapidReferenceProvider';
import { RapidInlayHintsProvider } from './RapidInlayHintsProvider';
import { PpDecoration } from './PpDecoration';
import { Logger } from './Logger';
import { RapidHoverProvider } from './RapidHoverProvider';
import { RapidCompletionProvider } from './RapidCompletionProvider';
import { RapidSignatureHelpProvider } from './RapidSignatureHelpProvider';
import { RapidCodeLensProvider } from './RapidCodeLensProvider';
import type { SignalItem } from './IoTreeProvider';
import type { Signal } from 'abb-rws-client';

let globalMulti: MultiRobotManager | undefined;
/** Set after the user confirms the first-jog safety dialog. Reset on each extension activation. */
let jogConfirmed = false;

// ─── Password secret storage ─────────────────────────────────────────────────

/** SecretStorage key for a robot's password. */
function passwordSecretKey(robotId: string): string {
  return `abbRobot.password/${robotId}`;
}

/**
 * Store a robot's password in SecretStorage. A failure is non-fatal - the
 * password still lives in the in-memory config for this session - but the
 * user is warned it won't survive a reload.
 */
async function storePasswordSecret(secrets: vscode.SecretStorage, robotId: string, password: string): Promise<void> {
  try {
    await secrets.store(passwordSecretKey(robotId), password);
  } catch (e) {
    Logger.warn(`could not write password to secure storage for ${robotId}: ${e instanceof Error ? e.message : String(e)}`);
    vscode.window.showWarningMessage('Could not save the robot password to secure storage - you may need to re-enter it after the next reload.');
  }
}

// ─── Add Robot Wizard ────────────────────────────────────────────────────────

/**
 * mDNS discovery with a safety net: returns [] when discovery fails for any
 * reason (multicast blocked, no announcements, socket errors), so callers can
 * always fall back to port scanning / manual entry.
 */
async function discoverControllersMdnsSafe(timeoutMs: number): Promise<MdnsController[]> {
  try {
    return await RobotManager.discoverControllersMdns({ timeoutMs });
  } catch (e) {
    Logger.warn(`mDNS discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** A picked discovery result - probe fields plus an optional name suggestion (mDNS announces the system name). */
type SelectedController = DiscoveredController & { suggestedName?: string };

/**
 * Full "Add Robot" flow:
 *  1. Auto-scan standard ABB addresses (127.0.0.1, 192.168.125.1) + mDNS discovery
 *  2. Present found controllers + "Enter address manually" + "How to connect?" options
 *  3. If user enters a custom IP, scan that too and show results
 *  4. Collect credentials and name, save to config (password → SecretStorage)
 */
async function runAddRobotWizard(multi: MultiRobotManager, secrets: vscode.SecretStorage): Promise<void> {
  // Phase 1 - auto-scan standard hosts and listen for mDNS announcements in parallel
  const [scanned, mdnsFound] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Scanning for ABB controllers…', cancellable: false },
    () => Promise.all([
      RobotManager.discoverControllers(),
      discoverControllersMdnsSafe(2500),
    ]),
  );

  // Phase 2 - show picker
  const selected = await showDiscoveryPicker(scanned, mdnsFound, 'Detected ABB controllers');
  if (!selected) { return; }

  // Phases 3+4 - credentials, display name, save
  await finishAddRobot(multi, secrets, selected);
}

/**
 * Final phases of the add-robot flow: collect credentials and display name,
 * persist the config (password goes to SecretStorage, never to settings),
 * then offer to connect.
 */
async function finishAddRobot(
  multi: MultiRobotManager,
  secrets: vscode.SecretStorage,
  selected: SelectedController,
): Promise<void> {
  const username = await vscode.window.showInputBox({
    title: 'Add Robot - Credentials (1/2)',
    prompt: 'RWS username',
    value: 'Admin',
    validateInput: v => v.trim() ? undefined : 'Required',
  });
  if (!username) { return; }

  const password = await vscode.window.showInputBox({
    title: 'Add Robot - Credentials (2/2)',
    prompt: 'RWS password',
    value: 'robotics',
    password: true,
  });
  if (password === undefined) { return; }

  const defaultName = selected.suggestedName ?? buildDefaultName(selected);
  const name = await vscode.window.showInputBox({
    title: 'Add Robot - Display Name',
    prompt: 'Name shown in the Robots panel',
    value: defaultName,
    validateInput: v => v.trim() ? undefined : 'Required',
  });
  if (!name) { return; }

  const config: RobotConfig = {
    id:       MultiRobotManager.newId(),
    name:     name.trim(),
    host:     selected.host,
    port:     selected.port,
    useHttps: selected.useHttps,
    username: username.trim(),
    password,
  };
  await storePasswordSecret(secrets, config.id, password);
  multi.addRobot(config);
  await saveConfigs(multi.configs);

  const connect = await vscode.window.showInformationMessage(
    `✓ Added "${config.name}"  (${selected.host}:${selected.port})`,
    'Connect Now'
  );
  if (connect === 'Connect Now') {
    vscode.commands.executeCommand('abbRobot.connectRobot', config.id);
  }
}

/** Human label for an mDNS-discovered controller, e.g. "MySystem - 192.168.125.1:443 (RWS 2.0)". */
function mdnsPickLabel(c: MdnsController): string {
  const proto = c.probableProtocol === 'rws2' ? '2.0' : c.probableProtocol === 'rws1' ? '1.0' : '?';
  return `${c.systemName} - ${c.host}:${c.port} (RWS ${proto})`;
}

/**
 * Map an mDNS hit onto connection parameters. rws2 → HTTPS/Basic, rws1 →
 * HTTP/Digest. If the announcement didn't say, probe the exact port; if even
 * that fails, let the user add with assumed defaults.
 */
async function resolveMdnsPick(c: MdnsController): Promise<SelectedController | undefined> {
  if (c.probableProtocol === 'rws2') {
    return { host: c.host, port: c.port, useHttps: true, authType: 'basic', suggestedName: c.systemName };
  }
  if (c.probableProtocol === 'rws1') {
    return { host: c.host, port: c.port, useHttps: false, authType: 'digest', suggestedName: c.systemName };
  }
  const probed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Probing ${c.host}:${c.port}…`, cancellable: false },
    () => RobotManager.probeSpecificPort(c.host, c.port),
  );
  if (probed) {
    return { host: c.host, port: c.port, useHttps: probed.useHttps, authType: probed.authType, suggestedName: c.systemName };
  }
  const fallback = await vscode.window.showWarningMessage(
    `"${c.systemName}" announced ${c.host}:${c.port} via mDNS but did not answer an RWS probe.\nAdd anyway with assumed defaults?`,
    'Add as RWS 1.0 (HTTP/Digest)', 'Add as RWS 2.0 (HTTPS/Basic)', 'Cancel',
  );
  if (fallback === 'Add as RWS 1.0 (HTTP/Digest)') {
    return { host: c.host, port: c.port, useHttps: false, authType: 'digest', suggestedName: c.systemName };
  }
  if (fallback === 'Add as RWS 2.0 (HTTPS/Basic)') {
    return { host: c.host, port: c.port, useHttps: true, authType: 'basic', suggestedName: c.systemName };
  }
  return undefined;
}

type DiscoveredItem = { label: string; description: string; detail?: string; probe: DiscoveredController };

/**
 * Show a QuickPick of discovered controllers (mDNS announcements first, then
 * port-scan hits). Always includes "Enter address manually" and "How to
 * connect?" at the bottom. If user picks manual entry, scans that host and
 * re-shows the picker.
 */
async function showDiscoveryPicker(
  found: DiscoveredController[],
  mdnsFound: MdnsController[],
  title: string,
): Promise<SelectedController | undefined> {

  type Item = vscode.QuickPickItem & {
    kind?: vscode.QuickPickItemKind;
    probe?: DiscoveredController;
    mdns?: MdnsController;
    action?: 'manual' | 'help';
  };

  // mDNS announcements carry the system name - richer than a bare port probe.
  // When both discovery paths find the same host:port, keep the mDNS entry.
  const mdnsKeys = new Set(mdnsFound.map(c => `${c.host}:${c.port}`));
  const scanOnly = found.filter(p => !mdnsKeys.has(`${p.host}:${p.port}`));
  const totalFound = mdnsFound.length + scanOnly.length;

  const mdnsItems: Item[] = mdnsFound.map(c => ({
    label:       mdnsPickLabel(c),
    description: c.rwVersion ? `RobotWare ${c.rwVersion}` : undefined,
    detail:      `Announced via mDNS - instance "${c.instanceName}"`,
    mdns: c,
  }));

  const controllerItems: Item[] = scanOnly.map(p => ({
    label:       `$(circuit-board)  ${p.host}:${p.port}`,
    description: p.authType === 'basic'
      ? 'RWS 2.0 · OmniCore · RobotWare 7 · HTTPS'
      : 'RWS 1.0 · IRC5 · RobotWare 6 · HTTP',
    detail:      `Auto-detected - port ${p.port} responded to ${p.authType === 'basic' ? 'HTTP Basic' : 'HTTP Digest'} challenge`,
    probe: p,
  }));

  const separator: Item = {
    label: '', kind: vscode.QuickPickItemKind.Separator,
  };

  const manualItem: Item = {
    label:       '$(add)  Enter address manually…',
    description: 'Specify a host that is not on the auto-scan list',
    action: 'manual',
  };

  const helpItem: Item = {
    label:       '$(question)  How do I find my controller?',
    description: 'Show connection guide for IRC5 and OmniCore',
    action: 'help',
  };

  const noneLabel: Item | undefined = totalFound === 0 ? {
    label:       '$(warning)  No controllers found automatically',
    description: 'Check network/RWS settings or enter address manually',
    kind: vscode.QuickPickItemKind.Separator,
  } : undefined;

  const items: Item[] = [
    ...(noneLabel ? [noneLabel] : []),
    ...mdnsItems,
    ...controllerItems,
    separator,
    manualItem,
    helpItem,
  ];

  const titleSuffix = totalFound > 0
    ? ` - ${totalFound} found`
    : ' - none found on standard addresses';

  const pick = await vscode.window.showQuickPick(items, {
    title: title + titleSuffix,
    placeHolder: totalFound > 0
      ? 'Select a controller to add, or enter an address manually'
      : 'No controllers found - enter address or see connection guide',
    matchOnDescription: true,
  });

  if (!pick) { return undefined; }

  if (pick.action === 'help') {
    showConnectionGuide();
    return undefined;
  }

  if (pick.mdns) {
    return resolveMdnsPick(pick.mdns);
  }

  if (pick.action === 'manual') {
    const ip = await vscode.window.showInputBox({
      title:         'Enter controller IP address or hostname',
      prompt:        'IP address, hostname, or host:port',
      value:         '192.168.125.1',
      validateInput: v => v.trim() ? undefined : 'Required',
    });
    if (!ip) { return undefined; }

    // Parse host:port if provided
    const colonIdx = ip.lastIndexOf(':');
    let manualHost = ip.trim();
    let manualPort: number | undefined;
    if (colonIdx > 0 && colonIdx < ip.length - 1) {
      const portStr = ip.slice(colonIdx + 1);
      const parsed  = parseInt(portStr, 10);
      if (!isNaN(parsed)) {
        manualHost = ip.slice(0, colonIdx).trim();
        manualPort = parsed;
      }
    }

    // If user specified an exact port, probe it to discover protocol + auth.
    // RobotStudio VCs use random ports each startup, so we can't infer from port number.
    if (manualPort !== undefined) {
      const probed = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Probing ${manualHost}:${manualPort}…`, cancellable: false },
        () => RobotManager.probeSpecificPort(manualHost, manualPort!),
      );
      if (probed) {
        return { host: manualHost, port: manualPort, useHttps: probed.useHttps, authType: probed.authType };
      }
      const fallback = await vscode.window.showWarningMessage(
        `No RWS response from ${manualHost}:${manualPort}.\nAdd anyway with assumed defaults?`,
        'Add as RWS 1.0 (HTTP/Digest)', 'Add as RWS 2.0 (HTTPS/Basic)', 'Cancel',
      );
      if (fallback === 'Add as RWS 1.0 (HTTP/Digest)') {
        return { host: manualHost, port: manualPort, useHttps: false, authType: 'digest' };
      }
      if (fallback === 'Add as RWS 2.0 (HTTPS/Basic)') {
        return { host: manualHost, port: manualPort, useHttps: true, authType: 'basic' };
      }
      return undefined;
    }

    // Scan the manually entered host
    const manualFound = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Scanning ${manualHost}…`, cancellable: false },
      () => RobotManager.detectAllControllers(manualHost),
    );
    const withHost = manualFound.map(p => ({ ...p, host: manualHost }));

    if (withHost.length === 0) {
      const retry = await vscode.window.showWarningMessage(
        `No RWS controller found at ${manualHost}.\nController may be offline or RWS may not be enabled.`,
        'Add Anyway (port 80)', 'Add Anyway (port 443)', 'Show Guide', 'Cancel'
      );
      if (retry === 'Add Anyway (port 80)') {
        return { host: manualHost, port: 80, useHttps: false, authType: 'digest' };
      }
      if (retry === 'Add Anyway (port 443)') {
        return { host: manualHost, port: 443, useHttps: true, authType: 'basic' };
      }
      if (retry === 'Show Guide') { showConnectionGuide(); }
      return undefined;
    }

    // Re-show picker with the manually-scanned results
    return showDiscoveryPicker(withHost, [], `Controllers at ${manualHost}`);
  }

  return pick.probe;
}

/** Build a sensible default name from discovered controller info. */
function buildDefaultName(p: DiscoveredController): string {
  const type = p.authType === 'basic' ? 'OmniCore' : 'IRC5';
  const local = p.host === '127.0.0.1' ? 'VC ' : '';
  return `${local}${type} (${p.host})`;
}

/** Open a virtual document with full connection guidance. */
async function showConnectionGuide(): Promise<void> {
  const guide = `# ABB Robot - Connection Guide

## How to connect

### IRC5 controllers (RobotWare 6.x - RWS 1.0)
- **Direct service cable**: plug PC into the XS7 service port on the controller cabinet.
  Default IP: \`192.168.125.1\`, port \`80\`, HTTP.
- **LAN port**: configure a static IP on your PC in the 192.168.125.x/24 subnet.
- RWS is **enabled by default** on IRC5. No configuration needed.
- Authentication: HTTP Digest (username \`Admin\`, password \`robotics\` by default - full grants).

### OmniCore controllers (RobotWare 7.x - RWS 2.0)
- **Enable RWS first** (one-time setup):
  \`FlexPendant → ☰ Menu → Configuration → Communication → Firewall Manager\`
  → enable **RobotWebServices** → restart controller.
- **Direct service cable**: same XS7 port. Default IP: \`192.168.125.1\`, port \`443\`, HTTPS.
- Authentication: HTTP Basic (same default credentials).
- **Network option**: public/WAN access requires paid option 3119-1 "RobotStudio Connect".

### RobotStudio Virtual Controllers
- RWS 1.0 VC: typically \`127.0.0.1:28447\` (HTTP)
- RWS 2.0 VC: typically \`127.0.0.1:9403\` (HTTPS)
- Find the exact port in RobotStudio: \`Controller → Properties → Communication\`

## Default credentials
| Field    | Default value   |
|----------|-----------------|
| Username | \`Admin\` |
| Password | \`robotics\`     |

## Auto-detection ports scanned
The extension probes these port/protocol combinations automatically:
| Port  | Protocol | Used by                            |
|-------|----------|------------------------------------|
| 80    | HTTP     | IRC5 real robot (standard)         |
| 443   | HTTPS    | OmniCore real robot (standard)     |
| 28447 | HTTP     | RWS 1.0 Virtual Controller         |
| 9403  | HTTPS    | RWS 2.0 Virtual Controller         |

If your controller uses a different port, use "Enter IP manually" and type \`ip:port\`
(e.g. \`192.168.1.50:8080\`).
`;
  const doc = await vscode.workspace.openTextDocument({ content: guide, language: 'markdown' });
  vscode.window.showTextDocument(doc, { preview: true });
}

// ─── Settings helpers ────────────────────────────────────────────────────────

/** A settings entry for a robot - like RobotConfig but the password field is optional (scrubbed after secret migration). */
type SavedRobotEntry = Omit<RobotConfig, 'password'> & { password?: string };

/**
 * Build RobotConfigs from settings + SecretStorage. Passwords come from
 * SecretStorage first ('abbRobot.password/<robotId>'); a plaintext password
 * still sitting in the setting is only a fallback (pre-migration installs, or
 * settings synced from a machine whose secrets don't travel with Settings
 * Sync). If SecretStorage is unavailable, the settings value is used as-is -
 * activation must never crash over a locked keychain.
 */
async function loadConfigs(cfg: vscode.WorkspaceConfiguration, secrets: vscode.SecretStorage): Promise<RobotConfig[]> {
  const saved = cfg.get<SavedRobotEntry[]>('robots', []);
  let entries: SavedRobotEntry[];
  if (saved.length > 0) {
    entries = saved;
  } else {
    // Backward-compatibility: migrate old single-robot settings
    const host = cfg.get<string>('host', '');
    if (!host) { return []; }
    entries = [{
      id: 'default',
      name: host,
      host,
      username: cfg.get<string>('username', 'Admin'),
      password: cfg.get<string>('password', 'robotics'),
    }];
  }
  const configs: RobotConfig[] = [];
  for (const entry of entries) {
    let password = typeof entry.password === 'string' ? entry.password : '';
    try {
      const secret = await secrets.get(passwordSecretKey(entry.id));
      if (secret !== undefined) { password = secret; }
    } catch (e) {
      Logger.warn(`secure storage unavailable while loading "${entry.name}" - using settings password: ${e instanceof Error ? e.message : String(e)}`);
    }
    configs.push({ ...entry, password });
  }
  return configs;
}

/**
 * One-time move of plaintext passwords out of the `abbRobot.robots` setting
 * (which Settings Sync uploads) into SecretStorage. The password property
 * stays in the settings schema for backward compat, but any value found there
 * is stored as a secret and removed from settings. Runs on every activation
 * and is a no-op once settings are clean. Returns how many passwords moved.
 */
async function migratePasswordsToSecrets(secrets: vscode.SecretStorage): Promise<number> {
  const cfg = vscode.workspace.getConfiguration('abbRobot');
  const inspected = cfg.inspect<SavedRobotEntry[]>('robots');
  // The extension itself only writes the Global target, but users can
  // hand-edit workspace settings - scrub whichever targets hold passwords.
  const targets: Array<{ value: SavedRobotEntry[] | undefined; target: vscode.ConfigurationTarget }> = [
    { value: inspected?.globalValue,    target: vscode.ConfigurationTarget.Global },
    { value: inspected?.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
  ];
  let migrated = 0;
  for (const { value, target } of targets) {
    if (!Array.isArray(value)) { continue; }
    const withPassword = value.filter(c => c && typeof c.id === 'string' && typeof c.password === 'string');
    if (withPassword.length === 0) { continue; }
    // Store every secret FIRST; only scrub the setting once all writes
    // succeeded, so a SecretStorage failure never loses a password.
    for (const c of withPassword) {
      await secrets.store(passwordSecretKey(c.id), c.password!);
    }
    const scrubbed = value.map(c => {
      if (!c || typeof c.id !== 'string' || typeof c.password !== 'string') { return c; }
      const { password: _password, ...rest } = c;
      return rest;
    });
    await cfg.update('robots', scrubbed, target);
    migrated += withPassword.length;
  }
  return migrated;
}

async function saveConfigs(configs: RobotConfig[]): Promise<void> {
  // Passwords never go into settings (Settings Sync would upload them in
  // plaintext) - they live in SecretStorage, keyed by robot id.
  const scrubbed = configs.map(({ password: _password, ...rest }) => rest);
  const cfg = vscode.workspace.getConfiguration('abbRobot');
  await cfg.update('robots', scrubbed, vscode.ConfigurationTarget.Global);
}

// ─── Active manager helper ────────────────────────────────────────────────────

function mgr(multi: MultiRobotManager): RobotManager {
  const m = multi.active;
  if (!m) { throw new Error('No robot selected. Add and connect a robot in the Robots panel.'); }
  return m;
}

/** Extract a robot id from a command argument that may be a string id, a TreeItem (passed by view/item/context menus), or undefined. */
function extractRobotId(arg?: unknown): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (arg && typeof arg === 'object' && 'id' in arg && typeof (arg as { id: unknown }).id === 'string') {
    return (arg as { id: string }).id;
  }
  return undefined;
}

// ─── Activate ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Install our VS Code-backed logger into abb-rws-client (RobotManager,
  // RwsClient, RwsClient2 - including HTTP req/res tracing - all use this).
  setLogger({
    info:  (msg)        => Logger.info(msg),
    warn:  (msg)        => Logger.warn(msg),
    error: (msg, err)   => Logger.error(msg, err),
    trace: (cat, msg, d) => Logger.trace(cat, msg, d),
    show:  () => Logger.show(),
  });
  Logger.info(`extension activated - log file: ${Logger.getLogFilePath()}`);

  // Move any plaintext passwords out of settings into SecretStorage before
  // loading configs. Failure is non-fatal - passwords stay in settings and
  // the migration retries on next activation.
  try {
    const migrated = await migratePasswordsToSecrets(context.secrets);
    if (migrated > 0) {
      vscode.window.showInformationMessage(
        `ABB Robot: moved ${migrated} robot password${migrated === 1 ? '' : 's'} from settings into VS Code secure storage. The abbRobot.robots setting no longer contains plaintext passwords.`,
      );
    }
  } catch (e) {
    Logger.warn(`password migration to secure storage failed - passwords stay in settings for now: ${e instanceof Error ? e.message : String(e)}`);
  }

  const cfg   = vscode.workspace.getConfiguration('abbRobot');
  // Schema minimum is 200 but settings.json edits bypass UI validation - clamp here too.
  const refreshIntervalMs = Math.max(200, cfg.get<number>('refreshInterval', 1000));
  // TLS verification stays off unless opted in - controllers ship self-signed certs.
  const strictTls = cfg.get<boolean>('strictTls', false);
  const multi = MultiRobotManager.fromConfigs(await loadConfigs(cfg, context.secrets), { refreshIntervalMs, strictTls });
  globalMulti = multi;

  // Route RobotManager errors (3 failed polls → auto-disconnect) through VS Code dialogs.
  // MultiRobotManager.onError installs the listener on every current and future robot.
  multi.onError(async (msg, actions) => vscode.window.showErrorMessage(msg, ...actions));

  // Providers - pass multi (satisfies the {state, onDidChange, listDirectory} shape)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = multi as any;
  const statusProvider  = new StatusTreeProvider(m);
  const motionProvider  = new MotionTreeProvider(m);
  const rapidProvider   = new RapidTreeProvider(m);
  const modulesProvider = new ModulesTreeProvider(m);
  const elogProvider    = new ElogTreeProvider(m);
  const filesProvider   = new FileExplorerProvider(m);
  const ioProvider      = new IoTreeProvider(m);
  const watchProvider   = new VariableWatchProvider(multi, context);
  const ctrlSrcProvider = new ControllerSourceProvider(multi);
  const robotsProvider  = new RobotsTreeProvider(multi);
  const cfgProvider     = new CfgTreeProvider(multi);

  // Scratch documents opened by "Edit CFG Instance", keyed by document URI.
  // Saving one writes its attributes back to the robot it was opened FROM
  // (robotId recorded at edit time) - the active robot may have changed since.
  const cfgEditTargets = new Map<string, { robotId: string; domain: string; type: string; instance: string }>();

  context.subscriptions.push(
    // ── Composite views ────────────────────────────────────────────────────
    // We expose 5 panels in the activity bar (Robots, Live Cell, Program,
    // Controller Data, Diagnostics). The three composite panels each merge
    // 2-3 of the underlying tree providers under collapsible "── Section ──"
    // headers via CompositeTreeProvider. Right-click context menus continue
    // to work because TreeItems' `contextValue` flows up unchanged.
    vscode.window.registerTreeDataProvider('abbRobot.robots', robotsProvider),
    // Program panel - tabbed webview (Modules tab + Watch tab) with real
    // top-of-panel tab buttons, replacing the previous collapsible-section
    // composite tree. Existing commands (open, push, set PP, edit watch
    // value, etc.) are reachable from inline buttons on each row.
    (() => {
      const programProvider = new TabbedProgramWebviewProvider(
        multi,
        () => watchProvider.getEntries() as Array<{ task: string; module: string; symbol: string; value?: string; error?: string }>,
      );
      programProvider.setExtensionUri(context.extensionUri);
      return vscode.window.registerWebviewViewProvider(
        TabbedProgramWebviewProvider.viewType,
        programProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
      );
    })(),
    vscode.window.registerTreeDataProvider(
      'abbRobot.controllerData',
      new CompositeTreeProvider([
        { id: 'files', label: '── Files (HOME) ──',         provider: filesProvider, icon: 'folder' },
        { id: 'io',    label: '── I/O Signals ──',          provider: ioProvider,    icon: 'circuit-board' },
        { id: 'cfg',   label: '── Configuration (CFG) ──',  provider: cfgProvider,   icon: 'gear', initiallyCollapsed: true },
      ]),
    ),
    vscode.window.registerTreeDataProvider(
      'abbRobot.diagnostics',
      new CompositeTreeProvider([
        { id: 'elog',   label: '── Recent Events ──',          provider: elogProvider,   icon: 'history' },
        { id: 'status', label: '── Status & System Info ──',   provider: statusProvider, icon: 'info', initiallyCollapsed: true },
        { id: 'motion', label: '── Motion (joints / TCP) ──',  provider: motionProvider, icon: 'symbol-numeric', initiallyCollapsed: true },
        { id: 'rapid',  label: '── RAPID extras ──',           provider: rapidProvider,  icon: 'symbol-namespace', initiallyCollapsed: true },
      ]),
    ),
    vscode.workspace.registerTextDocumentContentProvider('abb-controller', ctrlSrcProvider),
    vscode.window.registerWebviewViewProvider(
      LiveCellWebviewProvider.viewType,
      new LiveCellWebviewProvider(multi),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),

    // Polling interval and TLS strictness are fixed at connect time (RobotManager
    // options), so a changed setting only applies to managers built after it - offer a reload.
    vscode.workspace.onDidChangeConfiguration(e => {
      const changed = ['abbRobot.refreshInterval', 'abbRobot.strictTls']
        .find(key => e.affectsConfiguration(key));
      if (!changed) { return; }
      vscode.window.showInformationMessage(
        `${changed} changed - reload the window to apply it.`,
        'Reload Window',
      ).then(choice => {
        if (choice === 'Reload Window') { vscode.commands.executeCommand('workbench.action.reloadWindow'); }
      });
    }),

    // RAPID hover provider - shows ABB reference docs for instructions, functions, data types
    // when hovering over an identifier in any .mod / .sys / .prg file.
    vscode.languages.registerHoverProvider(
      [{ language: 'rapid' }, { scheme: 'file', pattern: '**/*.{mod,sys,prg,MOD,SYS,PRG}' }],
      new RapidHoverProvider(context.extensionPath, multi),
    ),

    // RAPID completion (autocomplete + snippets) - same DB. Suggests every
    // built-in instruction/function/data type plus a curated set of snippets
    // (e.g. `proc` → full PROC..ENDPROC skeleton; `MoveJ` → motion line with
    // tab-stops for ToPoint/Speed/Zone/Tool/WObj).
    vscode.languages.registerCompletionItemProvider(
      [{ language: 'rapid' }, { scheme: 'file', pattern: '**/*.{mod,sys,prg,MOD,SYS,PRG}' }],
      new RapidCompletionProvider(context.extensionPath),
    ),

    // RAPID signature help - pops a parameter list as the user fills args.
    // Fires on `(`, `,`, and ` ` (space) since instructions are space-separated.
    vscode.languages.registerSignatureHelpProvider(
      [{ language: 'rapid' }, { scheme: 'file', pattern: '**/*.{mod,sys,prg,MOD,SYS,PRG}' }],
      new RapidSignatureHelpProvider(context.extensionPath),
      '(', ',', ' ',
    ),

    // RAPID CodeLens - clickable "▶ Run this routine" / "▶ Set PP here" links above
    // every PROC/FUNC/TRAP declaration. The discoverable in-editor way to run
    // individual routines without leaving the file.
    vscode.languages.registerCodeLensProvider(
      [{ language: 'rapid' }, { scheme: 'file', pattern: '**/*.{mod,sys,prg,MOD,SYS,PRG}' }],
      new RapidCodeLensProvider(),
    ),
  );

  // ─── RAPID language server: workspace-wide symbol index + Go-to-Definition,
  // Document Outline, Find References. The shared index parses every .mod /
  // .sys / .prg in the workspace once on activation and keeps itself fresh
  // on save and (debounced) on edit.
  const rapidIndex = new RapidLanguageIndex();
  context.subscriptions.push(rapidIndex);
  void rapidIndex.start();
  const rapidSelector: vscode.DocumentSelector = [
    { language: 'rapid' },
    { scheme: 'file', pattern: '**/*.{mod,sys,prg,MOD,SYS,PRG}' },
  ];
  const inlayHints = new RapidInlayHintsProvider(multi, rapidIndex);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(rapidSelector, new RapidDefinitionProvider(rapidIndex)),
    vscode.languages.registerDocumentSymbolProvider(rapidSelector, new RapidDocumentSymbolProvider(rapidIndex)),
    vscode.languages.registerReferenceProvider(rapidSelector, new RapidReferenceProvider(rapidIndex)),
    vscode.languages.registerInlayHintsProvider(rapidSelector, inlayHints),
    inlayHints,
    new PpDecoration(multi),
  );

  // Status bar
  // Three status bar items, left-aligned, decreasing priority so they stack
  // in a natural order: connection · op-mode · exec state. When disconnected
  // only the connection pill is visible (linking to "Add Robot").
  const sbConn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
  const sbMode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  const sbExec = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sbConn.text    = '$(circuit-board) ABB';
  sbConn.tooltip = 'ABB Robot - click to add a robot';
  sbConn.command = 'abbRobot.addRobot';
  sbConn.show();
  context.subscriptions.push(sbConn, sbMode, sbExec);

  // Refresh all views on any state change
  multi.onDidChange(() => {
    statusProvider.refresh();
    motionProvider.refresh();
    rapidProvider.refresh();
    modulesProvider.refresh();
    elogProvider.refresh();
    ioProvider.refresh();
    watchProvider.refresh();
    robotsProvider.refresh();
    cfgProvider.refresh();

    const s = multi.state;
    if (!s.connected) {
      sbConn.text            = '$(circuit-board) ABB';
      sbConn.tooltip         = 'ABB Robot - no robot connected\nClick to add a robot';
      sbConn.command         = 'abbRobot.addRobot';
      sbConn.backgroundColor = undefined;
      sbMode.hide();
      sbExec.hide();
    } else {
      // Connection pill - color reflects controller state.
      const ctrlIcon = s.ctrlstate === 'motoron'  ? '$(pass)'
                     : s.ctrlstate === 'guardstop' || s.ctrlstate === 'emergencystop' ? '$(error)'
                     : '$(warning)';
      const robotName = multi.activeId ? (multi.configs.find(c => c.id === multi.activeId)?.name ?? s.host) : s.host;
      sbConn.text            = `${ctrlIcon} ${robotName ?? 'ABB'}`;
      sbConn.tooltip         = `Connected to ${s.host}\nController: ${s.ctrlstate ?? '?'}\nClick to disconnect`;
      sbConn.command         = 'abbRobot.disconnect';
      sbConn.backgroundColor = (s.ctrlstate === 'guardstop' || s.ctrlstate === 'emergencystop')
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : (s.ctrlstate !== 'motoron' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined);

      // Op-mode pill - lock icon when AUTO, unlock for manual modes.
      const modeIcon = s.opmode === 'AUTO' ? '$(lock)' : '$(unlock)';
      sbMode.text            = `${modeIcon} ${s.opmode ?? '?'}`;
      sbMode.tooltip         = `Operation mode: ${s.opmode ?? '?'}\nClick to switch (VC only)`;
      sbMode.command         = 'abbRobot.setOpMode';
      sbMode.show();

      // Exec pill - running-warning bg when RAPID is executing.
      const isRunning = s.execstate === 'running';
      sbExec.text            = isRunning ? '$(play-circle) RUNNING' : '$(circle-outline) STOPPED';
      sbExec.tooltip         = `RAPID: ${s.execstate ?? '?'}  Cycle: ${s.execCycle ?? '?'}\nClick to ${isRunning ? 'stop' : 'start'}`;
      sbExec.command         = isRunning ? 'abbRobot.stopRapid' : 'abbRobot.startRapid';
      sbExec.backgroundColor = isRunning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      sbExec.show();
    }
    vscode.commands.executeCommand('setContext', 'abbRobot.connected', s.connected);
  });

  // ─── Robot management commands ──────────────────────────────────────────────

  Logger.info(`extension activated - ${multi.configs.length} saved robot(s)`);

  /**
   * Wrap registerCommand so every invocation is traced into the log file
   * (with args + duration + outcome). Surfaces what the user clicked end-to-end.
   * Errors thrown inside the handler are logged + shown to the user.
   */
  function tracedCommand<A extends unknown[]>(
    id: string,
    handler: (...args: A) => unknown | Promise<unknown>,
  ): vscode.Disposable {
    return vscode.commands.registerCommand(id, async (...args: A) => {
      const startedAt = Date.now();
      Logger.trace('command', `→ ${id}`, { args: args.map(a => {
        if (a === null || a === undefined) { return a; }
        if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') { return a; }
        // Avoid serializing huge objects - TreeItem etc. include big icons / commands
        const o = a as Record<string, unknown>;
        return { _kind: o.constructor?.name ?? 'object', label: o.label, id: o.id, contextValue: o.contextValue };
      })});
      try {
        const result = await handler(...args);
        Logger.trace('command', `✓ ${id} (${Date.now() - startedAt}ms)`);
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        Logger.error(`command ${id} failed`, e);
        Logger.trace('command', `✗ ${id} (${Date.now() - startedAt}ms)`, { error: msg });
        vscode.window.showErrorMessage(`${id}: ${msg}`);
        throw e;
      }
    });
  }

  context.subscriptions.push(

    tracedCommand('abbRobot.showLogs', () => {
      Logger.show();
    }),
    tracedCommand('abbRobot.showLogFile', () => {
      Logger.showFile();
    }),

    tracedCommand('abbRobot.addRobot', async () => {
      await runAddRobotWizard(multi, context.secrets);
    }),

    tracedCommand('abbRobot.discoverControllers', async () => {
      const mdnsFound = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Discovering ABB controllers (mDNS)…', cancellable: false },
        () => discoverControllersMdnsSafe(2500),
      );
      if (mdnsFound.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          'No controllers announced themselves via mDNS. Controllers on other subnets do not receive multicast - use the Add Robot wizard to scan or enter an address.',
          'Add Robot…',
        );
        if (choice === 'Add Robot…') { vscode.commands.executeCommand('abbRobot.addRobot'); }
        return;
      }
      const pick = await vscode.window.showQuickPick(
        mdnsFound.map(c => ({
          label:       mdnsPickLabel(c),
          description: c.rwVersion ? `RobotWare ${c.rwVersion}` : undefined,
          detail:      `Announced via mDNS - instance "${c.instanceName}"`,
          mdns:        c,
        })),
        { title: `Discovered controllers - ${mdnsFound.length} found`, placeHolder: 'Select a controller to add', matchOnDescription: true },
      );
      if (!pick) { return; }
      const selected = await resolveMdnsPick(pick.mdns);
      if (!selected) { return; }
      await finishAddRobot(multi, context.secrets, selected);
    }),

    tracedCommand('abbRobot.removeRobot', async (arg?: unknown) => {
      const id = extractRobotId(arg) ?? multi.activeId;
      if (!id) { return; }
      const config = multi.configs.find(c => c.id === id);
      const confirm = await vscode.window.showWarningMessage(
        `Remove "${config?.name ?? id}" from the robot list?`, { modal: true }, 'Remove'
      );
      if (confirm !== 'Remove') { return; }
      multi.removeRobot(id);
      try { await context.secrets.delete(passwordSecretKey(id)); }
      catch (e) { Logger.warn(`could not delete password secret for ${id}: ${e instanceof Error ? e.message : String(e)}`); }
      await saveConfigs(multi.configs);
    }),

    tracedCommand('abbRobot.setActiveRobot', (arg?: unknown) => {
      const id = extractRobotId(arg);
      if (id) { multi.setActive(id); }
    }),

    tracedCommand('abbRobot.connectRobot', async (arg?: unknown) => {
      const targetId = extractRobotId(arg) ?? multi.activeId;
      if (!targetId) {
        vscode.commands.executeCommand('abbRobot.addRobot');
        return;
      }
      const config = multi.configs.find(c => c.id === targetId);
      if (!config) { return; }

      const savedPort = config.port;
      let lastError: unknown;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${config.host}…`, cancellable: true },
        async (progress, token) => {
          for (let attempt = 1; attempt <= 20; attempt++) {
            if (token.isCancellationRequested) { return; }
            try {
              await multi.connectRobot(targetId);
              multi.setActive(targetId);
              lastError = undefined;
              return;
            } catch (e: unknown) {
              lastError = e;
              const msg = e instanceof Error ? e.message : String(e);
              if ((msg.includes('503') || msg.toLowerCase().includes('busy')) && attempt < 20) {
                progress.report({ message: `Controller busy - retrying… (${attempt}/20)` });
                await new Promise(r => setTimeout(r, 3000));
              } else {
                // Non-busy error → fail fast
                return;
              }
            }
          }
        },
      );

      // If connect recovered a new port (RobotStudio VC restart reassigned it), persist it.
      const updated = multi.configs.find(c => c.id === targetId);
      if (lastError === undefined && updated && updated.port !== savedPort) {
        await saveConfigs(multi.configs);
        vscode.window.showInformationMessage(
          `Port for "${updated.name}" updated to ${updated.port} (was ${savedPort ?? 'auto'}).`,
        );
      }

      if (lastError !== undefined) {
        const msg = lastError instanceof Error ? lastError.message : String(lastError);
        const choice = await vscode.window.showErrorMessage(
          `Connect to "${config.name}" failed: ${msg}`,
          'Show Logs', 'Edit Robot…',
        );
        if (choice === 'Show Logs')   { vscode.commands.executeCommand('abbRobot.showLogs'); }
        if (choice === 'Edit Robot…') { vscode.commands.executeCommand('abbRobot.configure'); }
      }
    }),

    tracedCommand('abbRobot.disconnectRobot', async (arg?: unknown) => {
      const targetId = extractRobotId(arg) ?? multi.activeId;
      if (!targetId) { return; }
      await multi.disconnectRobot(targetId);
      vscode.window.showInformationMessage('Disconnected.');
    }),

    // Legacy connect/disconnect (operate on active robot)
    tracedCommand('abbRobot.configure', async () => {
      // Edit the active robot's config
      const id = multi.activeId;
      if (!id) {
        vscode.commands.executeCommand('abbRobot.addRobot');
        return;
      }
      const existing = multi.configs.find(c => c.id === id);

      const host = await vscode.window.showInputBox({ title: 'Configure Robot (1/3)', prompt: 'Host', value: existing?.host ?? '192.168.125.1' });
      if (!host) { return; }
      const username = await vscode.window.showInputBox({ title: 'Configure Robot (2/3)', prompt: 'Username', value: existing?.username ?? 'Admin' });
      if (!username) { return; }
      const password = await vscode.window.showInputBox({ title: 'Configure Robot (3/3)', prompt: 'Password', value: existing?.password ?? 'robotics', password: true });
      if (password === undefined) { return; }

      multi.updateConfig(id, { host: host.trim(), username: username.trim(), password });
      await storePasswordSecret(context.secrets, id, password);
      await saveConfigs(multi.configs);

      const connect = await vscode.window.showInformationMessage(`✓ Saved - host: ${host.trim()}`, 'Reconnect');
      if (connect === 'Reconnect') { vscode.commands.executeCommand('abbRobot.connectRobot', id); }
    }),

    tracedCommand('abbRobot.connect', async () => {
      vscode.commands.executeCommand('abbRobot.connectRobot', multi.activeId);
    }),

    tracedCommand('abbRobot.disconnect', async () => {
      vscode.commands.executeCommand('abbRobot.disconnectRobot', multi.activeId);
    }),

    // ─── RAPID control ───────────────────────────────────────────────────────

    tracedCommand('abbRobot.startRapid', async () => {
      await wrap('Starting RAPID…', () => mgr(multi).startRapid(), 'RAPID started.', multi);
    }),

    tracedCommand('abbRobot.stopRapid', async () => {
      await wrap('Stopping RAPID…', () => mgr(multi).stopRapid(), 'RAPID stopped.', multi);
    }),

    tracedCommand('abbRobot.resetRapid', async () => {
      await wrap('Resetting RAPID PP…', () => mgr(multi).resetRapid(), 'PP reset.', multi);
    }),

    tracedCommand('abbRobot.ppToMain', async () => {
      await wrap('Moving PP to Main…', () => mgr(multi).resetRapid(), '✓ PP moved to Main.', multi);
    }),

    tracedCommand('abbRobot.refresh', () => { mgr(multi).refresh().catch(() => {}); }),

    tracedCommand('abbRobot.setExecutionCycle', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: 'Once',    value: 'once'    as const, description: 'Run once then stop' },
        { label: 'Forever', value: 'forever' as const, description: 'Loop indefinitely' },
        { label: 'As Is',   value: 'asis'    as const, description: 'Keep current setting' },
      ], { title: 'Set Execution Cycle' });
      if (!choice) { return; }
      try { await mgr(multi).setExecutionCycle(choice.value); vscode.window.showInformationMessage(`Cycle: ${choice.label}`); }
      catch (e: unknown) { showError('Set cycle', e, multi); }
    }),

    // ─── Motors & speed ──────────────────────────────────────────────────────

    tracedCommand('abbRobot.motorsOn', async () => {
      try { await mgr(multi).setMotorsOn(); vscode.window.showInformationMessage('Motors ON.'); }
      catch (e: unknown) { showError('Motors On', e, multi); }
    }),

    tracedCommand('abbRobot.motorsOff', async () => {
      try { await mgr(multi).setMotorsOff(); vscode.window.showInformationMessage('Motors OFF.'); }
      catch (e: unknown) { showError('Motors Off', e, multi); }
    }),

    tracedCommand('abbRobot.setSpeedRatio', async () => {
      const current = multi.state.speedRatio ?? 100;
      const input = await vscode.window.showInputBox({
        title: 'Set Speed Ratio', prompt: '0-100 (AUTO mode only)', value: String(current),
        validateInput: v => { const n = +v; return (isNaN(n) || n < 0 || n > 100) ? 'Must be 0-100' : undefined; },
      });
      if (input === undefined) { return; }
      try { await mgr(multi).setSpeedRatio(+input); vscode.window.showInformationMessage(`Speed ratio: ${input}%`); }
      catch (e: unknown) { showError('Set speed ratio', e, multi); }
    }),

    // ─── Simulation panel (virtual controllers only) ─────────────────────────

    tracedCommand('abbRobot.simEStop', async () => {
      try { await mgr(multi).simEmergencyStop(); vscode.window.showWarningMessage('Simulated E-Stop engaged. Use "Reset Simulated E-Stop" to release.'); }
      catch (e: unknown) { showError('Simulate E-Stop', e, multi); }
    }),

    tracedCommand('abbRobot.simResetEStop', async () => {
      try { await mgr(multi).simResetEmergencyStop(); vscode.window.showInformationMessage('Simulated E-Stop released.'); }
      catch (e: unknown) { showError('Reset simulated E-Stop', e, multi); }
    }),

    tracedCommand('abbRobot.simGeneralStop', async () => {
      const engaged = multi.state.ctrlstate === 'guardstop';
      try { await mgr(multi).simGeneralStop(!engaged); vscode.window.showInformationMessage(`Simulated general stop ${engaged ? 'released' : 'engaged'}.`); }
      catch (e: unknown) { showError('Simulate general stop', e, multi); }
    }),

    tracedCommand('abbRobot.simAutoStop', async () => {
      const engaged = multi.state.ctrlstate === 'guardstop';
      try { await mgr(multi).simAutoStop(!engaged); vscode.window.showInformationMessage(`Simulated auto stop ${engaged ? 'released' : 'engaged'}.`); }
      catch (e: unknown) { showError('Simulate auto stop', e, multi); }
    }),

    tracedCommand('abbRobot.simEnableSwitch', async () => {
      const pick = await vscode.window.showQuickPick(['Press (on)', 'Release (off)'], { title: 'Simulate Enable Switch' });
      if (pick === undefined) { return; }
      try { await mgr(multi).simEnableSwitch(pick.startsWith('Press')); vscode.window.showInformationMessage(`Simulated enable switch ${pick.startsWith('Press') ? 'pressed' : 'released'}.`); }
      catch (e: unknown) { showError('Simulate enable switch', e, multi); }
    }),

    tracedCommand('abbRobot.teleportRobot', async () => {
      const mechunit = multi.state.mechunits[0] ?? 'ROB_1';
      const current = multi.state.joints;
      const seed = current ? [current.rax_1, current.rax_2, current.rax_3, current.rax_4, current.rax_5, current.rax_6].join(', ') : '0, 0, 0, 0, 0, 0';
      const input = await vscode.window.showInputBox({
        title: `Teleport ${mechunit} to joints (degrees)`,
        prompt: 'Six comma-separated joint angles',
        value: seed,
        validateInput: v => {
          const parts = v.split(',').map(s => s.trim());
          if (parts.length !== 6 || parts.some(p => isNaN(+p))) { return 'Enter six numbers separated by commas'; }
          return undefined;
        },
      });
      if (input === undefined) { return; }
      const joints = input.split(',').map(s => +s.trim());
      try { await mgr(multi).teleportMechunit(mechunit, joints); vscode.window.showInformationMessage(`Teleported ${mechunit} to [${joints.join(', ')}].`); }
      catch (e: unknown) { showError('Teleport robot', e, multi); }
    }),

    // ─── Jogging ─────────────────────────────────────────────────────────────

    tracedCommand('abbRobot.jog', async (axisIndex: number, direction: 1 | -1) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const cfg   = vscode.workspace.getConfiguration('abbRobot');
      const inc   = cfg.get<number>('jog.increment', 1);
      const speed = cfg.get<number>('jog.speed', 10);
      const mode  = cfg.get<string>('jog.mode', 'Joint') as 'Joint' | 'Cartesian';

      // Safety: confirmation on first jog of the session
      if (!jogConfirmed) {
        const confirm = await vscode.window.showWarningMessage(
          'This will move the robot. Make sure the workspace is clear and the robot is in MANR/MANF mode with motors on.',
          { modal: true },
          'I understand - Jog',
        );
        if (confirm !== 'I understand - Jog') { return; }
        jogConfirmed = true;
      }

      const axes: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
      axes[axisIndex] = direction * inc;

      try {
        await mgr(multi).jog({ mode, axes, speed });
      } catch (e: unknown) { showError('Jog', e); }
    }),

    tracedCommand('abbRobot.jogStop', async () => {
      if (!multi.state.connected) { return; }
      try {
        const cfg = vscode.workspace.getConfiguration('abbRobot');
        const mode = cfg.get<string>('jog.mode', 'Joint') as 'Joint' | 'Cartesian';
        await mgr(multi).jog({ mode, axes: [0, 0, 0, 0, 0, 0], speed: 0 });
      } catch (e: unknown) { showError('Stop jog', e); }
    }),

    tracedCommand('abbRobot.setJogIncrement', async () => {
      const cfg = vscode.workspace.getConfiguration('abbRobot');
      const cur = cfg.get<number>('jog.increment', 1);
      const mode = cfg.get<string>('jog.mode', 'Joint');
      const unit = mode === 'Joint' ? '°' : ' mm';
      const presets = mode === 'Joint'
        ? [{ label: '0.1°',  value: 0.1 }, { label: '0.5°', value: 0.5 }, { label: '1°', value: 1 }, { label: '5°', value: 5 }, { label: '10°', value: 10 }]
        : [{ label: '0.1 mm', value: 0.1 }, { label: '1 mm', value: 1 }, { label: '5 mm', value: 5 }, { label: '10 mm', value: 10 }, { label: '50 mm', value: 50 }];
      const pick = await vscode.window.showQuickPick(
        [...presets.map(p => ({ label: p.label, description: cur === p.value ? '(current)' : '', value: p.value })),
          { label: 'Custom…', description: 'Enter a value', value: -1 }],
        { title: `Jog Increment (${mode})` },
      );
      if (!pick) { return; }
      let value = pick.value;
      if (value < 0) {
        const input = await vscode.window.showInputBox({ prompt: `Increment in ${unit.trim()}`, value: String(cur), validateInput: v => isNaN(+v) || +v <= 0 ? 'Must be a positive number' : undefined });
        if (input === undefined) { return; }
        value = +input;
      }
      await cfg.update('jog.increment', value, vscode.ConfigurationTarget.Global);
    }),

    tracedCommand('abbRobot.setJogSpeed', async () => {
      const cfg = vscode.workspace.getConfiguration('abbRobot');
      const cur = cfg.get<number>('jog.speed', 10);
      const input = await vscode.window.showInputBox({
        title: 'Jog Speed',
        prompt: 'Speed percentage (0-100). Lower is safer for first tries.',
        value: String(cur),
        validateInput: v => { const n = +v; return isNaN(n) || n < 0 || n > 100 ? 'Must be 0-100' : undefined; },
      });
      if (input === undefined) { return; }
      await cfg.update('jog.speed', +input, vscode.ConfigurationTarget.Global);
    }),

    tracedCommand('abbRobot.setJogMode', async () => {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Joint',     description: 'Jog individual joints by degrees',   value: 'Joint' },
          { label: 'Cartesian', description: 'Jog tool position by mm/° in world', value: 'Cartesian' }],
        { title: 'Jog Mode' },
      );
      if (!pick) { return; }
      const cfg = vscode.workspace.getConfiguration('abbRobot');
      await cfg.update('jog.mode', pick.value, vscode.ConfigurationTarget.Global);
    }),

    // ─── New verified-endpoint commands (Phase 2.5 quick exposes) ───────────

    tracedCommand('abbRobot.showSystemDetails', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = mgr(multi);
        const [robot, license, products, energy] = await Promise.all([
          m.getRobotType(),
          m.getLicenseInfo(),
          m.listProducts(),
          m.getEnergyStats(),
        ]);
        const lines = [
          `Robot type: ${robot.type}${robot.variant ? ' (' + robot.variant + ')' : ''}`,
          `License entries: ${license.entries.length}`,
          `Installed products: ${products.length}`,
          `Energy: ${JSON.stringify(energy)}`,
        ];
        const doc = await vscode.workspace.openTextDocument({
          language: 'plaintext',
          content: '# System Details\n\n' + lines.join('\n') + '\n\n# Products\n' + products.map(p => `- ${JSON.stringify(p)}`).join('\n'),
        });
        vscode.window.showTextDocument(doc);
      } catch (e) { showError('System details', e); }
    }),

    tracedCommand('abbRobot.cfgOpenInstance', async (domain: string, type: string, instance: string) => {
      if (!multi.state.connected) { return; }
      try {
        const data = await mgr(multi).getCfgInstance(domain, type, instance);
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// ${domain} / ${type} / ${instance}\n${JSON.stringify(data, null, 2)}`,
        });
        vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('Open CFG instance', e); }
    }),

    tracedCommand('abbRobot.browseCfg', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = mgr(multi);
        const domains = await m.listCfgDomains();
        const domain = await vscode.window.showQuickPick(domains, { title: 'CFG domain' });
        if (!domain) { return; }
        const types = await m.listCfgTypes(domain);
        const type = await vscode.window.showQuickPick(types, { title: `${domain} - type` });
        if (!type) { return; }
        const instances = await m.listCfgInstances(domain, type);
        if (instances.length === 0) {
          vscode.window.showInformationMessage(`No instances under ${domain}/${type}`);
          return;
        }
        const instance = await vscode.window.showQuickPick(instances, { title: `${domain}/${type} - instance` });
        if (!instance) { return; }
        const data = await m.getCfgInstance(domain, type, instance);
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// CFG: ${domain}/${type}/${instance}\n${JSON.stringify(data, null, 2)}`,
        });
        vscode.window.showTextDocument(doc);
      } catch (e) { showError('Browse CFG', e); }
    }),

    tracedCommand('abbRobot.showProgramPointer', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const tasks = multi.state.tasks;
        const task = tasks.find(t => t.active)?.name ?? 'T_ROB1';
        const m = mgr(multi);
        const [pp, mp] = await Promise.all([m.getProgramPointer(task), m.getMotionPointer(task)]);
        vscode.window.showInformationMessage(
          `${task}:\n  PP: ${pp.module ?? '-'} / ${pp.routine ?? '-'} (row ${pp.row ?? '-'})\n  MP: ${mp.module ?? '-'} / ${mp.routine ?? '-'} (row ${mp.row ?? '-'})`,
          { modal: true },
        );
      } catch (e) { showError('Program pointer', e); }
    }),

    tracedCommand('abbRobot.showMotionInfo', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = mgr(multi);
        const [count, err, nonMotion, coldet] = await Promise.all([
          m.getMotionChangeCount(),
          m.getMotionErrorState(),
          m.getNonMotionExecution(),
          m.getCollisionPredictionMode(),
        ]);
        vscode.window.showInformationMessage(
          `Change count: ${count}\nError state: ${err.state}\nNon-motion mode: ${nonMotion ? 'ON (dry-run)' : 'OFF'}\nCollision prediction: ${coldet}`,
          { modal: true },
        );
      } catch (e) { showError('Motion info', e); }
    }),

    tracedCommand('abbRobot.showActiveToolWobj', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = mgr(multi);
        const [tool, wobj, payload] = await Promise.all([
          m.getActiveTool(), m.getActiveWobj(), m.getActivePayload(),
        ]);
        vscode.window.showInformationMessage(
          `Active tool: ${tool.name}\nActive wobj: ${wobj.name}\nActive payload: ${payload.name}`,
        );
      } catch (e) { showError('Tool/Wobj', e); }
    }),

    tracedCommand('abbRobot.listBackups', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const backups = await mgr(multi).listBackups();
        if (backups.length === 0) { vscode.window.showInformationMessage('No backups in /BACKUP'); return; }
        const items = backups.map(b => ({
          label: b.name,
          description: b.created ?? '',
        }));
        await vscode.window.showQuickPick(items, { title: `${backups.length} backup(s)`, placeHolder: 'Select to view (read-only)' });
      } catch (e) { showError('List backups', e); }
    }),

    tracedCommand('abbRobot.showVirtualTime', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = mgr(multi);
        const vt = await m.getVirtualTime();
        const action = await vscode.window.showInformationMessage(
          `Virtual time: ${vt.time}s - ${vt.running ? 'running' : 'paused'}`,
          'Pause/Resume', 'Set scale 1x', 'Set scale 10x',
        );
        if (action === 'Pause/Resume') { await m.setVirtualTimeRunning(!vt.running); }
        if (action === 'Set scale 1x')  { await m.setVirtualTimeScale(1); }
        if (action === 'Set scale 10x') { await m.setVirtualTimeScale(10); }
      } catch (e) { showError('Virtual time', e); }
    }),

    tracedCommand('abbRobot.showMechunitDetails', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = mgr(multi);
        const mu = (multi.state.mechunits[0]) ?? 'ROB_1';
        const [info, base, axes] = await Promise.all([
          m.getMechunitInfo(mu), m.getMechunitBaseFrame(mu), m.getMechunitAxes(mu),
        ]);
        const text = [
          `# Mechunit: ${mu}`,
          '',
          '## Info',
          ...Object.entries(info).map(([k, v]) => `- ${k}: ${v}`),
          '',
          '## Base frame',
          base ? `- pos: [${base.x}, ${base.y}, ${base.z}]\n- quat: [${base.q1}, ${base.q2}, ${base.q3}, ${base.q4}]` : '- (unavailable)',
          '',
          `## Axes (${axes.length})`,
          ...axes.map((a, i) => `${i + 1}: ${JSON.stringify(a)}`),
        ].join('\n');
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
        vscode.window.showTextDocument(doc);
      } catch (e) { showError('Mechunit details', e); }
    }),

    // ─── Inverse kinematics ──────────────────────────────────────────────────

    tracedCommand('abbRobot.calcIK', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }

      // Collect Cartesian target - pre-fill with current position if available
      const cur = multi.state.cartesian;
      const xIn = await vscode.window.showInputBox({ title: 'IK - Cartesian Target (1/7)', prompt: 'X (mm)', value: cur ? String(Math.round(cur.x)) : '400', validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
      if (xIn === undefined) { return; }
      const yIn = await vscode.window.showInputBox({ title: 'IK - Cartesian Target (2/7)', prompt: 'Y (mm)', value: cur ? String(Math.round(cur.y)) : '0', validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
      if (yIn === undefined) { return; }
      const zIn = await vscode.window.showInputBox({ title: 'IK - Cartesian Target (3/7)', prompt: 'Z (mm)', value: cur ? String(Math.round(cur.z)) : '600', validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
      if (zIn === undefined) { return; }
      const q1In = await vscode.window.showInputBox({ title: 'IK - Cartesian Target (4/7)', prompt: 'Q1 (quaternion)', value: cur ? String(cur.q1.toFixed(4)) : '1', validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
      if (q1In === undefined) { return; }
      const q2In = await vscode.window.showInputBox({ title: 'IK - Cartesian Target (5/7)', prompt: 'Q2 (quaternion)', value: cur ? String(cur.q2.toFixed(4)) : '0', validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
      if (q2In === undefined) { return; }
      const q3In = await vscode.window.showInputBox({ title: 'IK - Cartesian Target (6/7)', prompt: 'Q3 (quaternion)', value: cur ? String(cur.q3.toFixed(4)) : '0', validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
      if (q3In === undefined) { return; }
      const q4In = await vscode.window.showInputBox({ title: 'IK - Cartesian Target (7/7)', prompt: 'Q4 (quaternion)', value: cur ? String(cur.q4.toFixed(4)) : '0', validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
      if (q4In === undefined) { return; }

      const pos = { x: +xIn, y: +yIn, z: +zIn, q1: +q1In, q2: +q2In, q3: +q3In, q4: +q4In };

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Calculating joint angles…', cancellable: false },
        async () => {
          try {
            const seed = multi.state.joints ?? undefined;
            const j = await mgr(multi).calcJointsFromCartesian(pos, seed);
            const fmt = (v: number) => v.toFixed(2);
            const result = `J1=${fmt(j.rax_1)}°  J2=${fmt(j.rax_2)}°  J3=${fmt(j.rax_3)}°  J4=${fmt(j.rax_4)}°  J5=${fmt(j.rax_5)}°  J6=${fmt(j.rax_6)}°`;
            vscode.window.showInformationMessage(`IK Result: ${result}`, 'Copy').then(c => {
              if (c === 'Copy') { vscode.env.clipboard.writeText(result); }
            });
          } catch (e: unknown) { showError('Inverse kinematics', e); }
        },
      );
    }),

    // ─── Op mode lock/unlock ─────────────────────────────────────────────────

    tracedCommand('abbRobot.lockOpMode', async () => {
      const pin = await vscode.window.showInputBox({ title: 'Lock Operation Mode', prompt: '4-digit PIN code', validateInput: v => v.length === 4 ? undefined : 'PIN must be 4 digits' });
      if (!pin) { return; }
      const perm = await vscode.window.showQuickPick(
        [{ label: 'Temporary', value: false }, { label: 'Permanent', value: true }],
        { title: 'Lock type', placeHolder: 'Temporary or permanent lock?' }
      );
      if (!perm) { return; }
      try { await mgr(multi).lockOperationMode(pin, perm.value); vscode.window.showInformationMessage('Operation mode locked.'); }
      catch (e: unknown) { showError('Lock op mode', e); }
    }),

    tracedCommand('abbRobot.unlockOpMode', async () => {
      try { await mgr(multi).unlockOperationMode(); vscode.window.showInformationMessage('Operation mode unlocked.'); }
      catch (e: unknown) { showError('Unlock op mode', e); }
    }),

    tracedCommand('abbRobot.setOpMode', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const current = multi.state.opmode ?? '?';
      const ctrlstate = multi.state.ctrlstate ?? '?';

      // Pre-flight: guardstop blocks op-mode changes on most controllers.
      if (ctrlstate === 'guardstop' || ctrlstate === 'emergencystop') {
        vscode.window.showErrorMessage(
          `Cannot change op-mode while controller is in ${ctrlstate.toUpperCase()}.\n\n` +
          `The safety chain is open. Resolve it first:\n` +
          `  • On a VC: open the FlexPendant simulator in RobotStudio → press the deadman / reset the safety stop.\n` +
          `  • On real hardware: check the E-stop button + safety fence interlocks.\n\n` +
          `When ${ctrlstate} clears, retry.`,
          { modal: true },
        );
        return;
      }

      const pick = await vscode.window.showQuickPick(
        [
          { label: 'AUTO', detail: current === 'AUTO' ? '(already current)' : 'Production mode - full speed, motion runs from RAPID' },
          { label: 'MANR', detail: current === 'MANR' ? '(already current)' : 'Manual Reduced - 250mm/s max, deadman required (FlexPendant)' },
          { label: 'MANF', detail: current === 'MANF' ? '(already current)' : 'Manual Full - full speed in manual; rare, requires FullSpeed license' },
        ],
        { placeHolder: `Switch operation mode (currently ${current}). VC only - real hardware uses the key switch.` },
      );
      if (!pick) { return; }

      // Pre-flight: don't call the controller for a no-op transition.
      if (pick.label === current) {
        vscode.window.showInformationMessage(`Already in ${current} - nothing to change.`);
        return;
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Switching to ${pick.label}…`, cancellable: false },
          async () => mgr(multi).setOperationMode(pick.label as 'AUTO' | 'MANR' | 'MANF'),
        );
        vscode.window.showInformationMessage(`✓ Requested ${pick.label}. Check the FlexPendant simulator - the actual switch may require tapping Accept on a confirmation popup.`);
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : String(e);
        if (/timeout/i.test(raw)) {
          vscode.window.showWarningMessage(
            `The op-mode change request is still pending on the controller. ` +
            `Open the FlexPendant simulator in RobotStudio - there should be a confirmation dialog waiting for Accept/Cancel.`,
            { modal: false },
          );
          Logger.warn(`setOperationMode timed out ${pick.label} from ${current}: ${raw}`);
          return;
        }
        if (/HTTP 500/.test(raw) && /panel|opmode/i.test(raw)) {
          vscode.window.showErrorMessage(
            `Controller refused the ${pick.label} switch.\n\n` +
            `Most common causes (in order):\n` +
            `  • A confirmation dialog is pending on the FlexPendant simulator - open the pendant view in RobotStudio and Accept/Cancel any open dialog, then retry.\n` +
            `  • Op-mode is locked. Run "Unlock Operation Mode" first.\n` +
            `  • Going TO AUTO from MANR/MANF requires RMMP. Run "Request Remote Control" first; you'll get a popup on the pendant - accept it.\n` +
            `  • Real hardware: only the FlexPendant key switch can change op-mode. RWS won't help.`,
            { modal: true },
          );
          Logger.warn(`setOperationMode 500 ${pick.label} from ${current}: ${raw}`);
          return;
        }
        showError('Switch op mode', e, multi);
      }
    }),

    // ─── RAPID variables ─────────────────────────────────────────────────────

    tracedCommand('abbRobot.readVariable', async () => {
      const task   = await vscode.window.showInputBox({ title: 'Read Variable (1/3)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const module = await vscode.window.showInputBox({ title: 'Read Variable (2/3)', prompt: 'Module', value: 'user' });
      if (!module) { return; }
      const symbol = await vscode.window.showInputBox({ title: 'Read Variable (3/3)', prompt: 'Symbol name', value: 'reg1' });
      if (!symbol) { return; }
      try {
        const value = await mgr(multi).getRapidVariable(task, module, symbol);
        vscode.window.showInformationMessage(`${task}/${module}/${symbol} = ${value}`, 'Copy').then(c => {
          if (c === 'Copy') { vscode.env.clipboard.writeText(value); }
        });
      } catch (e: unknown) { showError('Read variable', e); }
    }),

    tracedCommand('abbRobot.writeVariable', async () => {
      const task   = await vscode.window.showInputBox({ title: 'Write Variable (1/4)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const module = await vscode.window.showInputBox({ title: 'Write Variable (2/4)', prompt: 'Module', value: 'user' });
      if (!module) { return; }
      const symbol = await vscode.window.showInputBox({ title: 'Write Variable (3/4)', prompt: 'Symbol name' });
      if (!symbol) { return; }
      const value  = await vscode.window.showInputBox({ title: 'Write Variable (4/4)', prompt: 'Value (RAPID syntax)' });
      if (value === undefined) { return; }
      try { await mgr(multi).setRapidVariable(task, module, symbol, value); vscode.window.showInformationMessage(`${symbol} = ${value}`); }
      catch (e: unknown) { showError('Write variable', e); }
    }),

    tracedCommand('abbRobot.readSymbolProperties', async () => {
      const task   = await vscode.window.showInputBox({ title: 'Symbol Properties (1/3)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const module = await vscode.window.showInputBox({ title: 'Symbol Properties (2/3)', prompt: 'Module', value: 'user' });
      if (!module) { return; }
      const symbol = await vscode.window.showInputBox({ title: 'Symbol Properties (3/3)', prompt: 'Symbol name' });
      if (!symbol) { return; }
      try {
        const props = await mgr(multi).getRapidSymbolProperties(task, module, symbol);
        const msg = `${task}/${module}/${symbol}\nType: ${props.symtyp}  DataType: ${props.dattyp}\nDims: ${props.ndim > 0 ? props.dim : 'scalar'}\nReadOnly: ${props.ro}  Local: ${props.local}`;
        vscode.window.showInformationMessage(msg, 'Copy').then(c => { if (c === 'Copy') { vscode.env.clipboard.writeText(JSON.stringify(props, null, 2)); } });
      } catch (e: unknown) { showError('Symbol properties', e); }
    }),

    tracedCommand('abbRobot.searchSymbols', async () => {
      const task = await vscode.window.showInputBox({ title: 'Search Symbols (1/2)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const symtyp = await vscode.window.showQuickPick(
        [{ label: 'All', value: undefined }, { label: 'Variables', value: 'var' }, { label: 'Persistents', value: 'per' }, { label: 'Constants', value: 'con' }, { label: 'Functions', value: 'fun' }, { label: 'Procedures', value: 'prc' }],
        { title: 'Search Symbols (2/2)', placeHolder: 'Filter by type' }
      );
      if (!symtyp) { return; }
      try {
        const symbols = await mgr(multi).searchRapidSymbols({ task, symtyp: symtyp.value });
        if (!symbols.length) { vscode.window.showInformationMessage(`No symbols in ${task}.`); return; }
        const doc = await vscode.workspace.openTextDocument({ content: `Found ${symbols.length} symbols in ${task}:\n\n` + symbols.map(s => `${s.symtyp.padEnd(4)} ${s.dattyp.padEnd(16)} ${s.name}`).join('\n'), language: 'plaintext' });
        vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('Symbol search', e); }
    }),

    tracedCommand('abbRobot.getUiInstruction', async () => {
      try {
        const instr = await mgr(multi).getActiveUiInstruction();
        if (!instr) { vscode.window.showInformationMessage('No active UI instruction.'); return; }
        const msg = `Instruction: ${instr.instr}\nEvent: ${instr.event}\nStack: ${instr.stack}` + (instr.msg ? `\nMessage: ${instr.msg}` : '');
        vscode.window.showInformationMessage(msg, 'Respond…').then(async c => {
          if (c !== 'Respond…') { return; }
          const uiparam = await vscode.window.showInputBox({ prompt: 'Parameter name (e.g. Result)', value: 'Result' });
          if (!uiparam) { return; }
          const value = await vscode.window.showInputBox({ prompt: 'Value to send' });
          if (value === undefined) { return; }
          try { await mgr(multi).setUiInstructionParam(instr.stack, uiparam, value); vscode.window.showInformationMessage('✓ UI instruction responded.'); }
          catch (e2: unknown) { showError('Respond to UI instruction', e2); }
        });
      } catch (e: unknown) { showError('Get UI instruction', e); }
    }),

    // ─── Module management ───────────────────────────────────────────────────

    tracedCommand('abbRobot.uploadModule', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'RAPID Module': ['mod', 'MOD'] }, title: 'Select RAPID module' });
      if (!uris?.length) { return; }
      const localPath = uris[0].fsPath;
      const fileName  = require('path').basename(localPath);
      const taskName  = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading ${fileName}…` }, async () => {
        try {
          await mgr(multi).loadProgram(localPath, taskName!);
          vscode.window.showInformationMessage(`✓ ${fileName} loaded. Press Start to run.`);
        } catch (e: unknown) {
          const err = e as Error & { ppFailed?: boolean };
          if (err.ppFailed) { vscode.window.showWarningMessage(err.message); }
          else { showError('Load module', e, multi); }
        }
      });
    }),

    // Invoked by the CodeLens "▶ Set PP here" above each routine in a .mod file.
    // Args are pre-resolved: (moduleName, routineName, kind).
    tracedCommand('abbRobot.setPPFromCodeLens', async (
      moduleName?: unknown, routineName?: unknown,
    ) => {
      if (typeof moduleName !== 'string' || typeof routineName !== 'string') {
        vscode.window.showWarningMessage('Set PP from CodeLens: missing arguments.');
        return;
      }
      if (!multi.state.connected) {
        vscode.window.showWarningMessage('Connect to a robot first, then click ▶ again.');
        return;
      }
      const active = multi.active!;
      const taskName = active.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';

      // If the module isn't loaded on the controller, offer to load THIS file first
      if (!active.state.modules.includes(moduleName)) {
        const editor = vscode.window.activeTextEditor;
        const filePath = editor?.document.fileName;
        const choice = await vscode.window.showWarningMessage(
          `Module "${moduleName}" isn't loaded on the controller yet.`,
          { modal: false },
          'Load this file first', 'Cancel',
        );
        if (choice !== 'Load this file first' || !filePath) { return; }
        try { await active.loadProgram(filePath, taskName); }
        catch (e) { showError('Load module', e, multi); return; }
      }

      try {
        await active.setPPToRoutine(taskName, moduleName, routineName);
        vscode.window.setStatusBarMessage(`✓ PP set to ${moduleName}.${routineName}`, 3000);
      } catch (e) {
        // Auto-recover from `main` collisions: if Set-PP fails with the
        // Semantic-error code, check if multiple loaded modules have a
        // `main` proc and offer to unload the conflicting one.
        if (await tryResolveMainCollision(active, taskName, moduleName, e, multi)) {
          // Retry once after the user resolves the collision
          try {
            await active.setPPToRoutine(taskName, moduleName, routineName);
            vscode.window.setStatusBarMessage(`✓ PP set to ${moduleName}.${routineName}`, 3000);
            return;
          } catch (e2) { showError('Set PP', e2, multi); return; }
        }
        showError('Set PP', e, multi);
      }
    }),

    // Invoked by the CodeLens "▶ Run this routine" above each routine.
    // Sets PP to the routine then starts execution in one click. Auto-loads
    // the module if not present, and turns motors on if needed (in AUTO).
    tracedCommand('abbRobot.runRoutineFromCodeLens', async (
      moduleName?: unknown, routineName?: unknown,
    ) => {
      if (typeof moduleName !== 'string' || typeof routineName !== 'string') {
        vscode.window.showWarningMessage('Run routine from CodeLens: missing arguments.');
        return;
      }
      if (!multi.state.connected) {
        vscode.window.showWarningMessage('Connect to a robot first, then click ▶ again.');
        return;
      }
      const active = multi.active!;
      const taskName = active.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';

      // If module isn't loaded, load THIS file
      if (!active.state.modules.includes(moduleName)) {
        const editor = vscode.window.activeTextEditor;
        const filePath = editor?.document.fileName;
        if (!filePath) {
          vscode.window.showWarningMessage(`No active editor with file path. Load ${moduleName} via the Modules panel and retry.`);
          return;
        }
        try { await active.loadProgram(filePath, taskName); }
        catch (e) { showError('Load module', e, multi); return; }
      }

      try {
        // Set PP at the chosen routine - with auto-recovery on `main` collision
        try {
          await active.setPPToRoutine(taskName, moduleName, routineName);
        } catch (e) {
          if (!(await tryResolveMainCollision(active, taskName, moduleName, e, multi))) { throw e; }
          await active.setPPToRoutine(taskName, moduleName, routineName);
        }

        // If we're in AUTO and motors are off, offer to turn them on first
        if (active.state.opmode === 'AUTO' && active.state.ctrlstate !== 'motoron') {
          const choice = await vscode.window.showInformationMessage(
            `Motors are ${active.state.ctrlstate}. Turn motors ON before starting?`,
            'Motors On', 'Cancel',
          );
          if (choice !== 'Motors On') { return; }
          try { await active.setMotorsOn(); }
          catch (e) { showError('Motors On', e, multi); return; }
          // brief pause for motors to engage
          await new Promise(r => setTimeout(r, 400));
        }

        await active.startRapid();
        vscode.window.setStatusBarMessage(`▶ Running ${moduleName}.${routineName}`, 4000);
      } catch (e) { showError('Run routine', e, multi); }
    }),

    tracedCommand('abbRobot.setPPToRoutine', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = multi.active;
      if (!active) { vscode.window.showWarningMessage('No active robot.'); return; }
      const taskName = active.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';

      // Determine module: from the right-clicked TreeItem if available, else quick-pick
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      if (!moduleName) {
        const sysMods = ['BASE', 'user', 'DPUSER', 'DPBASE'];
        const candidates = active.state.modules.filter(m => !sysMods.includes(m));
        if (candidates.length === 0) { vscode.window.showWarningMessage('No program modules loaded.'); return; }
        const pick = await vscode.window.showQuickPick(candidates, { placeHolder: 'Pick the module' });
        if (!pick) { return; }
        moduleName = pick;
      }

      // Fetch routines from the controller
      let routines: Array<{ name: string; symtyp: string; local: boolean }>;
      try {
        routines = await active.listRoutines(taskName, moduleName!);
      } catch (e) {
        showError('List routines', e, multi);
        return;
      }
      if (routines.length === 0) {
        vscode.window.showWarningMessage(`No routines found in ${moduleName}. Module may not be linked into the program.`);
        return;
      }

      // Quick-pick with the kind annotated. Sort: PROCs first (most common target), then FUNCs, then TRAPs.
      const order: Record<string, number> = { prc: 0, fun: 1, trp: 2 };
      const items = routines
        .sort((a, b) => (order[a.symtyp.toLowerCase()] ?? 9) - (order[b.symtyp.toLowerCase()] ?? 9) || a.name.localeCompare(b.name))
        .map(r => ({
          label: r.name,
          description: r.symtyp.toUpperCase() + (r.local ? ' (LOCAL)' : ''),
          detail: r.symtyp.toLowerCase() === 'prc' ? 'Procedure - runnable via Start' :
                  r.symtyp.toLowerCase() === 'fun' ? 'Function - needs args; setting PP here is unusual' :
                  r.symtyp.toLowerCase() === 'trp' ? 'Trap - interrupt handler; not normally invoked manually' :
                  '',
          name: r.name,
        }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Select routine in ${moduleName} to set PP at`,
        matchOnDescription: true,
      });
      if (!picked) { return; }

      try {
        await active.setPPToRoutine(taskName, moduleName!, picked.name);
        vscode.window.showInformationMessage(`✓ PP set to ${moduleName}.${picked.name}. Click Start to run.`);
      } catch (e: unknown) { showError('Set PP to routine', e, multi); }
    }),

    tracedCommand('abbRobot.unloadModule', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // Accept either a string module name or a TreeItem with `.label`.
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      if (!moduleName) {
        const pick = await vscode.window.showQuickPick(
          multi.state.modules.filter(m => !['BASE', 'user', 'DPUSER', 'DPBASE'].includes(m)),
          { placeHolder: 'Pick module to unload' },
        );
        if (!pick) { return; }
        moduleName = pick;
      }
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      try {
        await mgr(multi).unloadModule(taskName, moduleName);
        vscode.window.showInformationMessage(`✓ ${moduleName} unloaded.`);
      } catch (e: unknown) { showError('Unload module', e, multi); }
    }),

    // ─── Tasks ───────────────────────────────────────────────────────────────
    // Task selection controls which RAPID tasks are included in the next run.
    // For multi-task setups (T_ROB1 + T_BCKGRND, dual-arm setups, etc.).

    // ─── Remote Mastership Privilege (RMMP) ─────────────────────────────────
    // RMMP is the user-grant on top of mastership: the FlexPendant operator has
    // to approve a popup before web clients can do modifying operations. Without
    // it, mastership acquires fine but every modify op returns 403.
    tracedCommand('abbRobot.requestRmmp', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const before = await mgr(multi).getRmmpPrivilege();
        if (before === 'modify' || before === 'exclusive') {
          vscode.window.showInformationMessage(`Remote control already authorized (${before}).`);
          return;
        }
        if (before === 'unsupported') {
          vscode.window.showInformationMessage('RMMP not supported on this controller (likely RWS 1.0 with no remote-modify).');
          return;
        }
        await mgr(multi).requestRmmp('modify');
        vscode.window.showInformationMessage(
          'RMMP request sent. Open the FlexPendant - a popup is asking "Allow remote user to modify?". Tap Allow.',
          { modal: false },
        );
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : String(e);
        if (/HTTP 403/.test(raw) && /rapi_user_resource|rmmp|users\/rmmp/i.test(raw)) {
          // The 403 on POST /users/rmmp specifically means the *currently
          // logged-in user* doesn't have permission to even REQUEST RMMP.
          // This is a UAS configuration issue, not a runtime mastership issue.
          await vscode.window.showErrorMessage(
            'Cannot request remote control - the logged-in user does not have UAS grants to do so.\n\n' +
            'Common causes:\n' +
            '  • The logged-in user lacks the "Remote Login" / "Remote Control" / "Modify Current Value" grants ' +
            '(common with "Default User"; the built-in "Admin" account usually has them).\n' +
            '  • The virtual controller has no FlexPendant attached (no popup target).\n' +
            '  • The controller is in AUTO mode where RMMP may not apply - try the operation directly.\n\n' +
            'Fix: open the FlexPendant → ABB menu → Control Panel → User Authorization → Users → ' +
            'add a user with the "Remote Login" + "Modify Current Value" + "Edit RAPID" grants, ' +
            'and reconnect with that user (Configure Connection in the Status panel).',
            { modal: true },
          );
          Logger.warn(`RMMP request denied: ${raw}`);
          return;
        }
        showError('Request RMMP', e, multi);
      }
    }),

    tracedCommand('abbRobot.showRmmpStatus', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const priv = await mgr(multi).getRmmpPrivilege();
        const explain = priv === 'none' ? 'No remote-modify rights. Click "Request Remote Control" to ask the FlexPendant operator.'
                      : priv === 'pending modify' ? 'Approval pending - a popup is on the FlexPendant.'
                      : priv === 'modify'    ? 'Remote-modify granted. You can do RAPID/exec/IO writes.'
                      : priv === 'exclusive' ? 'Exclusive control granted (rare).'
                      : priv === 'unsupported' ? 'Controller does not expose RMMP.'
                      : `Unknown: ${priv}`;
        vscode.window.showInformationMessage(`RMMP: ${priv}\n\n${explain}`, { modal: true });
      } catch (e: unknown) { showError('Show RMMP', e, multi); }
    }),

    // ─── Push / Pull workflow - the git story for RAPID files ──────────────
    // The point: edit RAPID at desk, version control it in git, deploy with one
    // command. ABB's RobotStudio doesn't do this naturally - that's our niche.

    tracedCommand('abbRobot.pullAllModules', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = multi.active;
      if (!active) { vscode.window.showWarningMessage('No active robot.'); return; }
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';

      // Pick a destination folder - defaults to the workspace root if any, else asks.
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      let destFolder: vscode.Uri | undefined;
      if (wsRoot) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: `Use workspace: ${wsRoot.fsPath}`, value: wsRoot },
            { label: 'Pick a different folder…', value: undefined },
          ],
          { placeHolder: 'Where should the .mod files be saved?' },
        );
        if (!choice) { return; }
        destFolder = choice.value;
      }
      if (!destFolder) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Pull modules into this folder',
        });
        if (!picked || picked.length === 0) { return; }
        destFolder = picked[0];
      }

      // Get list of program modules (skip system mods like BASE/user)
      const sysMods = new Set(['BASE', 'user', 'DPUSER', 'DPBASE']);
      let modulesDetailed: Array<{ name: string; type: string }>;
      try { modulesDetailed = await active.listModulesDetailed(taskName); }
      catch { modulesDetailed = active.state.modules.map(n => ({ name: n, type: '' })); }
      const programMods = modulesDetailed
        .filter(m => !sysMods.has(m.name) && !/SysMod/i.test(m.type))
        .map(m => m.name);

      if (programMods.length === 0) {
        vscode.window.showInformationMessage('No program modules loaded.');
        return;
      }

      const overwrite = await vscode.window.showWarningMessage(
        `Pull ${programMods.length} module(s) into ${destFolder.fsPath}?\n` +
        programMods.map(m => `  • ${m}.mod`).join('\n') + '\n\n' +
        'Existing files with the same name will be OVERWRITTEN.',
        { modal: true }, 'Pull', 'Cancel',
      );
      if (overwrite !== 'Pull') { return; }

      const pulled: string[] = [];
      const failed: Array<{ name: string; err: string }> = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pulling ${programMods.length} modules…`, cancellable: false },
        async (progress) => {
          for (let i = 0; i < programMods.length; i++) {
            const name = programMods[i];
            progress.report({ message: `${name}.mod (${i + 1}/${programMods.length})` });
            try {
              const source = await active.getModuleSource(taskName, name);
              const filePath = vscode.Uri.joinPath(destFolder!, `${name}.mod`);
              await vscode.workspace.fs.writeFile(filePath, Buffer.from(source, 'utf8'));
              pulled.push(name);
            } catch (e) {
              failed.push({ name, err: e instanceof Error ? e.message : String(e) });
            }
          }
        },
      );

      const summary = `✓ Pulled ${pulled.length}/${programMods.length} modules into ${destFolder.fsPath}` +
        (failed.length ? `\nFailed: ${failed.map(f => `${f.name} (${f.err.slice(0, 60)})`).join(', ')}` : '');
      const action = await vscode.window.showInformationMessage(summary, 'Open Folder', 'OK');
      if (action === 'Open Folder') {
        await vscode.commands.executeCommand('revealFileInOS', destFolder);
      }
    }),

    tracedCommand('abbRobot.pushCurrentFile', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = multi.active;
      if (!active) { vscode.window.showWarningMessage('No active robot.'); return; }

      // Accept (a) explorer right-click → arg is a vscode.Uri, OR
      //         (b) editor right-click → no arg, fall back to active editor.
      let filePath: string | undefined;
      if (arg && typeof arg === 'object' && 'fsPath' in arg && typeof (arg as { fsPath: unknown }).fsPath === 'string') {
        filePath = (arg as { fsPath: string }).fsPath;
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          if (editor.document.isDirty) { await editor.document.save(); }
          filePath = editor.document.fileName;
        }
      }
      if (!filePath) { vscode.window.showWarningMessage('No file to push. Open or right-click a .mod file.'); return; }
      if (!/\.(mod|sys|prg)$/i.test(filePath)) {
        vscode.window.showWarningMessage(`Cannot push ${path.basename(filePath)} - only .mod / .sys / .prg files.`);
        return;
      }
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      // Strip legacy `.controller` / `.from-controller` suffix from the file
      // basename so the displayed module name in the progress / status
      // matches what RAPID will actually call it.
      const moduleName = path.basename(filePath, path.extname(filePath)).replace(/\.(controller|from-controller)$/i, '');

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pushing ${moduleName}${path.extname(filePath)} to ${taskName}…`, cancellable: false },
          () => active.loadProgram(filePath!, taskName),
        );
        vscode.window.showInformationMessage(`✓ Pushed ${moduleName}${path.extname(filePath)} to ${taskName}.`);
      } catch (e: unknown) { showError('Push current file', e, multi); }
    }),

    tracedCommand('abbRobot.diffWithController', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = multi.active;
      if (!active) { vscode.window.showWarningMessage('No active robot.'); return; }

      let localUri: vscode.Uri | undefined;
      if (arg && typeof arg === 'object' && 'fsPath' in arg && typeof (arg as { fsPath: unknown }).fsPath === 'string') {
        localUri = arg as vscode.Uri;
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) { localUri = editor.document.uri; }
      }
      if (!localUri) { vscode.window.showWarningMessage('No file to diff. Open or right-click a .mod file.'); return; }
      // Reject diffing a virtual controller-source doc (would be a no-op self-diff).
      if (localUri.scheme === 'abb-controller') {
        vscode.window.showInformationMessage('That tab is already the controller version. Open the local file instead.');
        return;
      }
      const filePath = localUri.fsPath;
      if (!/\.(mod|sys|prg)$/i.test(filePath)) {
        vscode.window.showWarningMessage(`Cannot diff ${path.basename(filePath)} - only .mod / .sys / .prg files.`);
        return;
      }
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      const ext = path.extname(filePath);
      // Strip any legacy `.controller` / `.from-controller` suffix the user
      // might still have on disk from earlier-version files. Real RAPID
      // module names can't contain dots - the controller 400s on them.
      const moduleName = path.basename(filePath, ext).replace(/\.(controller|from-controller)$/i, '');
      try {
        // Use the abb-controller: scheme so VS Code shows it as a virtual,
        // read-only doc - and so re-running Diff on this tab is a no-op
        // (handled by the scheme check above) instead of fetching a bogus
        // module name like "IOTest.controller".
        const remoteUri = ControllerSourceProvider.uriFor(taskName, moduleName, ext);
        // Force a fresh fetch in case the controller's copy changed since last view.
        ctrlSrcProvider.refresh(remoteUri);
        await vscode.commands.executeCommand('vscode.diff',
          remoteUri,
          localUri,
          `${moduleName}${ext}  (controller ↔ local)`,
        );
      } catch (e: unknown) { showError('Diff with controller', e, multi); }
    }),

    // ─── Module source pull - open a loaded module's RAPID text in an editor tab
    tracedCommand('abbRobot.openModuleSource', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      if (!moduleName) {
        const sysMods = ['BASE', 'user', 'DPUSER', 'DPBASE'];
        const candidates = multi.state.modules.filter(m => !sysMods.includes(m));
        if (candidates.length === 0) { vscode.window.showWarningMessage('No program modules loaded.'); return; }
        const pick = await vscode.window.showQuickPick(candidates, { placeHolder: 'Pick a loaded module to open' });
        if (!pick) { return; }
        moduleName = pick;
      }
      try {
        const source = await mgr(multi).getModuleSource(taskName, moduleName);
        await openAsScratchFile(`${moduleName}.mod`, source);
      } catch (e: unknown) { showError('Open module source', e, multi); }
    }),

    // ─── Service routine call ───────────────────────────────────────────────
    tracedCommand('abbRobot.callServiceRoutine', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      const routine = await vscode.window.showInputBox({
        prompt: 'Service routine to call (PROC name)',
        placeHolder: 'CalibBrakeCheck',
        validateInput: v => v.trim() ? undefined : 'Required',
      });
      if (!routine) { return; }
      try {
        await mgr(multi).callServiceRoutine(taskName, routine);
        vscode.window.showInformationMessage(`✓ Service routine ${routine} started.`);
      } catch (e: unknown) { showError('Call service routine', e, multi); }
    }),

    // ─── Backup / Restore ───────────────────────────────────────────────────
    tracedCommand('abbRobot.createBackup', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = await vscode.window.showInputBox({
        prompt: 'Backup name (folder created in BACKUP volume)',
        value: `Backup_${stamp}`,
        validateInput: v => v.trim() ? undefined : 'Required',
      });
      if (!name) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating backup ${name}…` }, async (p) => {
        try {
          await mgr(multi).createBackup(name);
          // Poll status - backups can take 30-90s on real hardware
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 1500));
            const s = await mgr(multi).getBackupStatus();
            if (!s.active) { break; }
            p.report({ message: `${s.phase ?? 'in progress'}… ${s.progress ?? ''}` });
          }
          vscode.window.showInformationMessage(`✓ Backup "${name}" created.`);
        } catch (e: unknown) { showError('Create backup', e, multi); }
      });
    }),

    tracedCommand('abbRobot.restoreBackup', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      let name: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      if (!name) {
        try {
          const backups = await mgr(multi).listBackups();
          if (backups.length === 0) { vscode.window.showWarningMessage('No backups found.'); return; }
          const pick = await vscode.window.showQuickPick(
            backups.map(b => ({ label: b.name, description: b.created ?? '', detail: b.size != null ? `${b.size} bytes` : '' })),
            { placeHolder: 'Pick backup to restore' },
          );
          if (!pick) { return; }
          name = pick.label;
        } catch (e) { showError('List backups', e, multi); return; }
      }
      const confirm = await vscode.window.showWarningMessage(
        `Restore backup "${name}"? The controller will REPLACE its current configuration and restart afterwards.`,
        { modal: true }, 'Restore', 'Cancel',
      );
      if (confirm !== 'Restore') { return; }
      try {
        await mgr(multi).restoreBackup(name);
        vscode.window.showInformationMessage(`✓ Restore of "${name}" initiated. Controller will restart.`);
      } catch (e: unknown) { showError('Restore backup', e, multi); }
    }),

    // ─── Forward kinematics ─────────────────────────────────────────────────
    tracedCommand('abbRobot.calcFK', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const input = await vscode.window.showInputBox({
        prompt: 'Joint angles in degrees, comma-separated (rax_1..rax_6)',
        placeHolder: '0, 0, 0, 0, 30, 0',
        validateInput: v => {
          const parts = v.split(',').map(s => +s.trim());
          if (parts.length !== 6 || parts.some(n => Number.isNaN(n))) { return 'Need exactly 6 numbers'; }
          return undefined;
        },
      });
      if (!input) { return; }
      const [j1, j2, j3, j4, j5, j6] = input.split(',').map(s => +s.trim());
      try {
        const target = await mgr(multi).calcCartesianFromJoints({
          rax_1: j1, rax_2: j2, rax_3: j3, rax_4: j4, rax_5: j5, rax_6: j6,
        });
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// FK result for joints [${input}]\n${JSON.stringify(target, null, 2)}`,
        });
        await vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('Forward kinematics', e, multi); }
    }),

    // ─── Tool / Wobj activation ─────────────────────────────────────────────
    tracedCommand('abbRobot.setActiveTool', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const tool = await vscode.window.showInputBox({ prompt: 'Tool name (existing persistent tooldata)', placeHolder: 'tool0' });
      if (!tool) { return; }
      const mu = multi.state.mechunits[0] ?? 'ROB_1';
      try { await mgr(multi).setActiveTool(mu, tool); vscode.window.showInformationMessage(`✓ Active tool: ${tool}`); }
      catch (e: unknown) { showError('Set active tool', e, multi); }
    }),

    tracedCommand('abbRobot.setActiveWobj', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const wobj = await vscode.window.showInputBox({ prompt: 'Work object name (existing persistent wobjdata)', placeHolder: 'wobj0' });
      if (!wobj) { return; }
      const mu = multi.state.mechunits[0] ?? 'ROB_1';
      try { await mgr(multi).setActiveWobj(mu, wobj); vscode.window.showInformationMessage(`✓ Active wobj: ${wobj}`); }
      catch (e: unknown) { showError('Set active wobj', e, multi); }
    }),

    // ─── CFG write ─────────────────────────────────────────────────────────
    tracedCommand('abbRobot.editCfgInstance', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const robotId = multi.activeId;
      if (!robotId) { vscode.window.showWarningMessage('No robot selected.'); return; }
      const m = mgr(multi);
      try {
        const domains = await m.listCfgDomains();
        const domain = await vscode.window.showQuickPick(domains, { placeHolder: 'Pick CFG domain' });
        if (!domain) { return; }
        const types = await m.listCfgTypes(domain);
        const type = await vscode.window.showQuickPick(types, { placeHolder: `Pick type in ${domain}` });
        if (!type) { return; }
        const instances = await m.listCfgInstances(domain, type);
        const instance = await vscode.window.showQuickPick(instances, { placeHolder: `Pick instance to edit` });
        if (!instance) { return; }
        const current = await m.getCfgInstance(domain, type, instance);
        const json = `// CFG instance: ${domain}/${type}/${instance}\n// Edit attribute values, then save (Ctrl+S) to write them back to the controller.\n${JSON.stringify(current, null, 2)}`;
        // Real file, not untitled - Ctrl+S must fire onDidSaveTextDocument for the
        // write-back below. .jsonc so the header comments don't squiggle.
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const scratchDir = wsRoot ?? path.join(require('os').homedir(), '.abb-rws-extension', 'scratch');
        fs.mkdirSync(scratchDir, { recursive: true });
        const destPath = path.join(scratchDir, `${domain}.${type}.${instance}.cfg.jsonc`.replace(/[\\/:*?"<>|]/g, '_'));
        fs.writeFileSync(destPath, json, 'utf8');
        const doc = await vscode.workspace.openTextDocument(destPath);
        await vscode.window.showTextDocument(doc, { preview: false });
        cfgEditTargets.set(doc.uri.toString(), { robotId, domain, type, instance });
      } catch (e: unknown) { showError('Edit CFG instance', e, multi); }
    }),

    // Write-back for the CFG scratch documents opened above.
    vscode.workspace.onDidSaveTextDocument(async doc => {
      const target = cfgEditTargets.get(doc.uri.toString());
      if (!target) { return; }
      // Write back to the robot the scratch file was opened from - never the
      // currently active one, which may be a different robot by now.
      const entry = multi.entries.find(e => e.id === target.robotId);
      const robotName = entry?.config.name ?? target.robotId;
      if (!entry) {
        vscode.window.showErrorMessage(
          `CFG not written - robot "${robotName}" (which this instance was opened from) is no longer in the robot list. Re-open the instance to edit it.`,
        );
        return;
      }
      if (!entry.manager.state.connected) {
        vscode.window.showWarningMessage(
          `CFG not written - "${robotName}" (which this instance was opened from) is disconnected. Reconnect it and save again.`,
        );
        return;
      }
      let attrs: Record<string, string>;
      try {
        const body = doc.getText().split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
        const parsed = JSON.parse(body) as Record<string, unknown>;
        attrs = {};
        for (const [k, v] of Object.entries(parsed)) {
          // rdonly/instanceid are instance metadata the controller reports on read; not writable attributes.
          if (k === 'rdonly' || k === 'instanceid') { continue; }
          attrs[k] = String(v);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`CFG not written - document is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      try {
        await entry.manager.setCfgInstance(target.domain, target.type, target.instance, attrs);
        vscode.window.showInformationMessage(`✓ Wrote ${target.domain}/${target.type}/${target.instance} to "${robotName}". Most CFG changes need a controller restart to take effect.`);
      } catch (e: unknown) { showError('Write CFG instance', e, multi); }
    }),
    // Stop tracking once the scratch document is closed.
    vscode.workspace.onDidCloseTextDocument(doc => { cfgEditTargets.delete(doc.uri.toString()); }),

    tracedCommand('abbRobot.createCfgInstance', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const m = mgr(multi);
      try {
        const domains = await m.listCfgDomains();
        const domain = await vscode.window.showQuickPick(domains, { placeHolder: 'Pick CFG domain' });
        if (!domain) { return; }
        const types = await m.listCfgTypes(domain);
        const type = await vscode.window.showQuickPick(types, { placeHolder: `Pick type in ${domain}` });
        if (!type) { return; }
        const instance = await vscode.window.showInputBox({ prompt: `New instance name in ${domain}/${type}` });
        if (!instance) { return; }
        const attrsJson = await vscode.window.showInputBox({
          prompt: 'Attributes as JSON object',
          placeHolder: '{"name":"X","value":"42"}',
          validateInput: v => { try { JSON.parse(v); return undefined; } catch { return 'Not valid JSON'; } },
        });
        if (!attrsJson) { return; }
        await m.createCfgInstance(domain, type, instance, JSON.parse(attrsJson));
        vscode.window.showInformationMessage(`✓ Created ${domain}/${type}/${instance}.`);
      } catch (e: unknown) { showError('Create CFG instance', e, multi); }
    }),

    tracedCommand('abbRobot.removeCfgInstance', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const m = mgr(multi);
      try {
        const domains = await m.listCfgDomains();
        const domain = await vscode.window.showQuickPick(domains, { placeHolder: 'Pick CFG domain' });
        if (!domain) { return; }
        const types = await m.listCfgTypes(domain);
        const type = await vscode.window.showQuickPick(types, { placeHolder: `Pick type in ${domain}` });
        if (!type) { return; }
        const instances = await m.listCfgInstances(domain, type);
        const instance = await vscode.window.showQuickPick(instances, { placeHolder: 'Pick instance to remove' });
        if (!instance) { return; }
        const confirm = await vscode.window.showWarningMessage(
          `Remove ${domain}/${type}/${instance}? This cannot be undone.`, { modal: true }, 'Remove', 'Cancel',
        );
        if (confirm !== 'Remove') { return; }
        await m.removeCfgInstance(domain, type, instance);
        vscode.window.showInformationMessage(`✓ Removed ${domain}/${type}/${instance}.`);
      } catch (e: unknown) { showError('Remove CFG instance', e, multi); }
    }),

    tracedCommand('abbRobot.loadCfgFile', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const filepath = await vscode.window.showInputBox({
        prompt: 'Path to .cfg file on the controller (e.g. $HOME/MOC.cfg)',
        placeHolder: '$HOME/MOC.cfg',
      });
      if (!filepath) { return; }
      const action = await vscode.window.showQuickPick(
        [
          { label: 'add', detail: 'Merge (default) - adds attributes/instances; existing ones unchanged' },
          { label: 'replace', detail: 'Overwrite - file replaces matching domain entirely' },
          { label: 'add-with-reset', detail: 'Reset domain first, then add from file' },
        ],
        { placeHolder: 'Load action' },
      );
      if (!action) { return; }
      try {
        await mgr(multi).loadCfgFile(filepath, action.label as 'add' | 'replace' | 'add-with-reset');
        vscode.window.showInformationMessage(`✓ Loaded ${filepath} (${action.label}). A controller restart is usually required.`);
      } catch (e: unknown) { showError('Load CFG file', e, multi); }
    }),

    tracedCommand('abbRobot.saveCfgFile', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const domains = await mgr(multi).listCfgDomains();
        const domain = await vscode.window.showQuickPick(domains, { placeHolder: 'Pick CFG domain to export' });
        if (!domain) { return; }
        const filepath = await vscode.window.showInputBox({
          prompt: 'Destination path on controller',
          value: `$HOME/${domain}.cfg`,
        });
        if (!filepath) { return; }
        await mgr(multi).saveCfgFile(domain, filepath);
        vscode.window.showInformationMessage(`✓ Saved ${domain} domain to ${filepath}.`);
      } catch (e: unknown) { showError('Save CFG file', e, multi); }
    }),

    // ─── DIPC ───────────────────────────────────────────────────────────────
    tracedCommand('abbRobot.dipcListQueues', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const qs = await mgr(multi).listDipcQueues();
        if (qs.length === 0) { vscode.window.showInformationMessage('No DIPC queues.'); return; }
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// DIPC queues\n${JSON.stringify(qs, null, 2)}`,
        });
        await vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('List DIPC queues', e, multi); }
    }),

    tracedCommand('abbRobot.dipcCreateQueue', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const name = await vscode.window.showInputBox({ prompt: 'Queue name', validateInput: v => v.trim() ? undefined : 'Required' });
      if (!name) { return; }
      const sizeStr = await vscode.window.showInputBox({ prompt: 'Max message bytes (optional)', validateInput: v => !v || /^\d+$/.test(v) ? undefined : 'Number or empty' });
      const countStr = await vscode.window.showInputBox({ prompt: 'Max messages (optional)', validateInput: v => !v || /^\d+$/.test(v) ? undefined : 'Number or empty' });
      try {
        await mgr(multi).createDipcQueue(name, {
          maxsize: sizeStr ? Number(sizeStr) : undefined,
          maxmessages: countStr ? Number(countStr) : undefined,
        });
        vscode.window.showInformationMessage(`✓ DIPC queue ${name} created.`);
      } catch (e: unknown) { showError('Create DIPC queue', e, multi); }
    }),

    tracedCommand('abbRobot.dipcSendMessage', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const queues = await mgr(multi).listDipcQueues().catch(() => []);
      const queue = queues.length
        ? await vscode.window.showQuickPick(queues.map(q => q.name), { placeHolder: 'Pick a queue' })
        : await vscode.window.showInputBox({ prompt: 'Queue name' });
      if (!queue) { return; }
      const type = await vscode.window.showQuickPick(['string', 'num', 'dnum', 'bool'], { placeHolder: 'Message type' });
      if (!type) { return; }
      const payload = await vscode.window.showInputBox({ prompt: `Message payload (${type})` });
      if (payload === undefined) { return; }
      try {
        await mgr(multi).sendDipcMessage(queue, payload, type as 'string' | 'num' | 'dnum' | 'bool');
        vscode.window.showInformationMessage(`✓ Sent to ${queue}: ${payload}`);
      } catch (e: unknown) { showError('Send DIPC message', e, multi); }
    }),

    tracedCommand('abbRobot.dipcReadMessage', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const queues = await mgr(multi).listDipcQueues().catch(() => []);
      const queue = queues.length
        ? await vscode.window.showQuickPick(queues.map(q => q.name), { placeHolder: 'Pick a queue' })
        : await vscode.window.showInputBox({ prompt: 'Queue name' });
      if (!queue) { return; }
      try {
        const msg = await mgr(multi).readDipcMessage(queue, 5000);
        vscode.window.showInformationMessage(msg ? `Message: ${msg.payload} (${msg.type})` : 'No message (timed out)');
      } catch (e: unknown) { showError('Read DIPC message', e, multi); }
    }),

    tracedCommand('abbRobot.dipcRemoveQueue', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const queues = await mgr(multi).listDipcQueues().catch(() => []);
      if (queues.length === 0) { vscode.window.showInformationMessage('No DIPC queues to remove.'); return; }
      const pick = await vscode.window.showQuickPick(queues.map(q => q.name), { placeHolder: 'Queue to remove' });
      if (!pick) { return; }
      try {
        await mgr(multi).removeDipcQueue(pick);
        vscode.window.showInformationMessage(`✓ Removed queue ${pick}.`);
      } catch (e: unknown) { showError('Remove DIPC queue', e, multi); }
    }),

    // ─── File volumes / compress / validation ───────────────────────────────
    tracedCommand('abbRobot.listFileVolumes', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const vols = await mgr(multi).listFileVolumes();
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: `# File volumes\n\n${vols.map(v => `- ${v}`).join('\n')}` });
        await vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('List file volumes', e, multi); }
    }),

    tracedCommand('abbRobot.compressPath', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const source = await vscode.window.showInputBox({ prompt: 'Source path on controller', placeHolder: '$HOME/MyDir' });
      if (!source) { return; }
      const dest = await vscode.window.showInputBox({ prompt: 'Destination archive path', placeHolder: '$HOME/MyDir.zip' });
      if (!dest) { return; }
      try {
        await mgr(multi).compressPath(source, dest);
        vscode.window.showInformationMessage(`✓ Compressed ${source} → ${dest}.`);
      } catch (e: unknown) { showError('Compress', e, multi); }
    }),

    tracedCommand('abbRobot.validateRapidValue', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      const datatype = await vscode.window.showInputBox({ prompt: 'RAPID datatype', placeHolder: 'num | string | bool | robtarget | …' });
      if (!datatype) { return; }
      const value = await vscode.window.showInputBox({ prompt: `Value to validate as ${datatype}`, placeHolder: '123 | "hello" | TRUE | [[1,2,3],…]' });
      if (value === undefined) { return; }
      try {
        const ok = await mgr(multi).validateRapidValue(taskName, value, datatype);
        vscode.window.showInformationMessage(ok ? `✓ Valid ${datatype} literal.` : `✗ Not a valid ${datatype} literal.`);
      } catch (e: unknown) { showError('Validate RAPID value', e, multi); }
    }),

    // ─── Variable watch ──────────────────────────────────────────────────────
    tracedCommand('abbRobot.addWatch', () => watchProvider.addWatch()),

    tracedCommand('abbRobot.addSelectionToWatch', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const selection = editor.document.getText(editor.selection).trim();
      const symbol = selection || editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active));
      if (!symbol || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) {
        vscode.window.showWarningMessage('Pick a single identifier (selection or cursor on a word).');
        return;
      }
      // Try to figure out the module from the file's MODULE declaration; fall back to file basename.
      const text = editor.document.getText();
      const m = /\bMODULE\s+(\w+)/i.exec(text);
      const moduleName = m ? m[1] : path.basename(editor.document.fileName, path.extname(editor.document.fileName));
      const taskName = multi.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      await watchProvider.addWatchFromSelection(taskName, moduleName, symbol);
      vscode.window.setStatusBarMessage(`✓ Watching ${moduleName}.${symbol}`, 3000);
    }),
    tracedCommand('abbRobot.removeWatch', (arg: unknown) => watchProvider.removeWatch(arg)),
    tracedCommand('abbRobot.writeWatchValue', (arg: unknown) => watchProvider.writeValue(arg)),
    tracedCommand('abbRobot.clearWatches', () => watchProvider.clearAll()),
    tracedCommand('abbRobot.refreshWatches', () => { watchProvider.forceRefreshNow(); }),

    tracedCommand('abbRobot.activateTask', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = extractTaskName(arg, multi.state.tasks.filter(t => !t.active).map(t => t.name));
      if (!(await taskName)) { return; }
      const name = (await taskName)!;
      try {
        await mgr(multi).activateRapidTask(name);
        vscode.window.showInformationMessage(`✓ Task ${name} activated.`);
      } catch (e: unknown) { showError('Activate task', e, multi); }
    }),

    tracedCommand('abbRobot.deactivateTask', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = extractTaskName(arg, multi.state.tasks.filter(t => t.active).map(t => t.name));
      if (!(await taskName)) { return; }
      const name = (await taskName)!;
      try {
        await mgr(multi).deactivateRapidTask(name);
        vscode.window.showInformationMessage(`✓ Task ${name} deactivated.`);
      } catch (e: unknown) { showError('Deactivate task', e, multi); }
    }),

    tracedCommand('abbRobot.activateAllTasks', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        await mgr(multi).activateAllRapidTasks();
        vscode.window.showInformationMessage('✓ All RAPID tasks activated.');
      } catch (e: unknown) { showError('Activate all tasks', e, multi); }
    }),

    tracedCommand('abbRobot.deactivateAllTasks', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        await mgr(multi).deactivateAllRapidTasks();
        vscode.window.showInformationMessage('✓ All RAPID tasks deactivated.');
      } catch (e: unknown) { showError('Deactivate all tasks', e, multi); }
    }),

    /**
     * Create a NEW RAPID task. ABB tasks aren't a runtime concept - they're
     * configured in the controller's CFG (`SYS/CAB_TASKS`) at boot. This
     * command writes the new task entry there, then prompts for a restart.
     *
     * CFG attrs (live-confirmed against OmniCore RW7.21 + IRC5 RW6.16 via
     * GET /rw/cfg/SYS/CAB_TASKS/attributes - the schema is identical on both):
     *   Name        - task name (e.g. T_BCKGRND2)
     *   Type        - 'NORMAL' | 'STATIC' | 'SEMISTATIC'
     *   TrustLevel  - 'NoSafety' (default) | 'TPSysHalt' | 'TPSysStop' | 'SysFail' | 'SysStop'
     *   Entry       - entrypoint routine ('main' usually)
     *   MotionTask  - 'TRUE' / 'FALSE'  (TRUE = controls a robot). The schema
     *     declares a bool domain FALSE/TRUE. Live-verified 2026-07-09 on RW6.16:
     *     ?action=set accepts either casing (204) and readback reports lowercase;
     *     we write the schema's casing.
     * Remaining attrs (StackSize, BindRef, Rmq*, …) keep their type defaults.
     *
     * After write + restart the task appears in `getRapidTasks()`. If you
     * want it active in the current cycle, also call activateRapidTask().
     */
    tracedCommand('abbRobot.createRapidTask', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const m = mgr(multi);

      const taskName = await vscode.window.showInputBox({
        title: 'New RAPID Task - name',
        prompt: 'Task name (e.g. T_BCKGRND2)',
        validateInput: v => /^T_[A-Za-z][A-Za-z0-9_]*$/.test(v) ? undefined : 'Task name must start with T_ and contain only letters/digits/underscore',
      });
      if (!taskName) { return; }

      const type = await vscode.window.showQuickPick(
        [
          { label: 'NORMAL',     detail: 'Standard motion task (controls a robot)' },
          { label: 'STATIC',     detail: 'Background task - runs once at boot, no automatic restart' },
          { label: 'SEMISTATIC', detail: 'Background task - auto-restarts after Stop/E-stop' },
        ],
        { placeHolder: 'Task type' },
      );
      if (!type) { return; }

      const motionTask = type.label === 'NORMAL'
        ? await vscode.window.showQuickPick(
            [{ label: 'Yes', detail: 'Task controls a mechanical unit (robot)' }, { label: 'No', detail: 'Task does not move a robot' }],
            { placeHolder: 'Motion task?' },
          )
        : { label: 'No' };
      if (!motionTask) { return; }

      const entryRoutine = await vscode.window.showInputBox({
        title: 'New RAPID Task - entry routine',
        prompt: 'PROC name to call at task start',
        value: 'main',
      });
      if (!entryRoutine) { return; }

      const trustLevel = await vscode.window.showQuickPick(
        ['NoSafety', 'TPSysHalt', 'TPSysStop', 'SysFail', 'SysStop'],
        { placeHolder: 'Trust level (advanced - leave NoSafety unless you know)' },
      );
      if (!trustLevel) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Create task "${taskName}" (${type.label})?\n\nThis writes a new instance to SYS/CAB_TASKS in CFG. ` +
        `The task will appear after the controller restarts.`,
        { modal: true }, 'Create + Plan Restart', 'Cancel',
      );
      if (confirm !== 'Create + Plan Restart') { return; }

      try {
        await m.createCfgInstance('SYS', 'CAB_TASKS', taskName, {
          Name: taskName,
          Type: type.label,
          TrustLevel: trustLevel,
          Entry: entryRoutine,
          MotionTask: motionTask.label === 'Yes' ? 'TRUE' : 'FALSE',
        });
        const restart = await vscode.window.showInformationMessage(
          `✓ Task ${taskName} written to CFG. Controller restart required to load it.`,
          'Restart Now', 'Restart Later',
        );
        if (restart === 'Restart Now') {
          await vscode.commands.executeCommand('abbRobot.restartController');
        }
      } catch (e: unknown) { showError('Create RAPID task', e, multi); }
    }),

    tracedCommand('abbRobot.downloadModule', async (moduleName: string) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      if (!moduleName) {
        moduleName = await vscode.window.showInputBox({ prompt: 'Module name (without .mod)' }) ?? '';
        if (!moduleName) { return; }
      }
      const saveUri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), `${moduleName}.mod`)), filters: { 'RAPID Module': ['mod'] } });
      if (!saveUri) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${moduleName}.mod…` }, async () => {
        try {
          const content = await mgr(multi).downloadModule(moduleName);
          fs.writeFileSync(saveUri.fsPath, content, 'utf8');
          const open = await vscode.window.showInformationMessage(`✓ ${moduleName}.mod saved.`, 'Open');
          if (open === 'Open') { vscode.window.showTextDocument(saveUri); }
        } catch (e: unknown) { showError('Download module', e); }
      });
    }),

    // ─── Controller ──────────────────────────────────────────────────────────

    tracedCommand('abbRobot.getControllerClock', async () => {
      try {
        const dt = await mgr(multi).getControllerClock();
        vscode.window.showInformationMessage(`Controller clock (UTC): ${dt}`, 'Copy', 'Set…').then(async c => {
          if (c === 'Copy') { vscode.env.clipboard.writeText(dt); }
          if (c === 'Set…') { vscode.commands.executeCommand('abbRobot.setControllerClock'); }
        });
      } catch (e: unknown) { showError('Read clock', e); }
    }),

    tracedCommand('abbRobot.setControllerClock', async () => {
      const now = new Date();
      const input = await vscode.window.showInputBox({
        title: 'Set Controller Clock',
        prompt: 'Date/time in format YYYY-MM-DD HH:MM:SS (UTC)',
        value: `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`,
        validateInput: v => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? undefined : 'Format: YYYY-MM-DD HH:MM:SS',
      });
      if (!input) { return; }
      const [datePart, timePart] = input.split(' ');
      const [Y, Mo, D]  = datePart.split('-').map(Number);
      const [H, Mi, S]  = timePart.split(':').map(Number);
      try { await mgr(multi).setControllerClock(Y, Mo, D, H, Mi, S); vscode.window.showInformationMessage('✓ Clock set.'); }
      catch (e: unknown) { showError('Set clock', e); }
    }),

    tracedCommand('abbRobot.restartController', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: 'Restart',  value: 'restart' as const, description: 'Normal restart' },
        { label: 'P-Start',  value: 'pstart'  as const, description: 'Preserve params, remove programs' },
        { label: 'I-Start',  value: 'istart'  as const, description: 'Restore original installation' },
        { label: 'B-Start',  value: 'bstart'  as const, description: 'Boot from last auto-save (crash recovery)' },
      ], { title: 'Restart Controller' });
      if (!choice) { return; }
      const confirm = await vscode.window.showWarningMessage(`${choice.label} the controller?`, { modal: true }, 'Restart');
      if (confirm !== 'Restart') { return; }
      try {
        await mgr(multi).restartController(choice.value);
        vscode.window.showInformationMessage('Restart command sent. Disconnecting…');
        await multi.disconnectRobot(multi.activeId!);
      } catch (e: unknown) { showError('Restart', e); }
    }),

    // ─── Event log ───────────────────────────────────────────────────────────

    tracedCommand('abbRobot.refreshElog', async () => {
      await mgr(multi).refreshEventLog();
      elogProvider.refresh();
    }),

    tracedCommand('abbRobot.clearEventLog', async () => {
      const c = await vscode.window.showWarningMessage('Clear event log domain 0?', { modal: true }, 'Clear');
      if (c !== 'Clear') { return; }
      try { await mgr(multi).clearEventLog(); elogProvider.refresh(); vscode.window.showInformationMessage('Event log cleared.'); }
      catch (e: unknown) { showError('Clear event log', e); }
    }),

    tracedCommand('abbRobot.clearAllEventLogs', async () => {
      const c = await vscode.window.showWarningMessage('Clear ALL event log domains?', { modal: true }, 'Clear All');
      if (c !== 'Clear All') { return; }
      try { await mgr(multi).clearAllEventLogs(); elogProvider.refresh(); vscode.window.showInformationMessage('All event logs cleared.'); }
      catch (e: unknown) { showError('Clear all logs', e); }
    }),

    // ─── File browser ────────────────────────────────────────────────────────

    tracedCommand('abbRobot.refreshFiles', () => { filesProvider.refresh(); }),

    tracedCommand('abbRobot.createDirectory', async (arg?: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // Single-prompt UX: user types the FULL path of the new directory
      // (e.g. "HOME/myfolder" or "$HOME/test/sub"); we split into parent+name
      // automatically. The previous two-step prompt confused users - they'd
      // type the new folder's name in the "parent" box and get a 404.
      let defaultPath = '$HOME/new-folder';
      const node = (arg && typeof arg === 'object' && 'node' in arg)
        ? (arg as { node: { path: string; entry: { type?: string } } }).node
        : undefined;
      if (node?.path) {
        const parent = node.entry?.type === 'dir' ? node.path : node.path.replace(/\/[^/]+$/, '');
        defaultPath = `${parent}/new-folder`;
      }
      const fullPath = await vscode.window.showInputBox({
        title: 'Create Directory',
        prompt: 'Full path of the new directory (e.g. $HOME/myfolder). Parent must already exist.',
        value: defaultPath,
        validateInput: v => v.trim() && v.includes('/') ? undefined : 'Must include the parent path (e.g. $HOME/foo)',
      });
      if (!fullPath) { return; }
      // Split: everything before the last "/" is the parent, after is the new name
      const lastSlash = fullPath.lastIndexOf('/');
      const parent = fullPath.slice(0, lastSlash);
      const name   = fullPath.slice(lastSlash + 1).trim();
      if (!name) { vscode.window.showErrorMessage('Directory name is empty'); return; }
      try { await mgr(multi).createDirectory(parent, name); vscode.window.showInformationMessage(`Directory '${name}' created in ${parent}.`); filesProvider.refresh(); }
      catch (e: unknown) { showError('Create directory', e); }
    }),

    tracedCommand('abbRobot.downloadControllerFile', async (arg: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // VS Code passes the FileItem TreeItem when invoked from the inline button or right-click menu;
      // when invoked from the item's `command` (item-click), it passes the FileNode directly.
      // Handle both shapes by checking for the wrapping `.node` property.
      const node = (arg && typeof arg === 'object' && 'node' in arg)
        ? (arg as { node: { path: string; entry: { name: string } } }).node
        : (arg as { path: string; entry: { name: string } } | undefined);
      if (!node || !node.path || !node.entry) {
        vscode.window.showWarningMessage('Right-click a file in the File Explorer panel to download it.');
        return;
      }
      const saveUri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), node.entry.name)) });
      if (!saveUri) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${node.entry.name}…` }, async () => {
        try {
          const text = await mgr(multi).readFile(node.path);
          fs.writeFileSync(saveUri.fsPath, text, 'utf8');
          const open = await vscode.window.showInformationMessage(`✓ ${node.entry.name} saved.`, 'Open');
          if (open === 'Open') { vscode.window.showTextDocument(saveUri); }
        } catch (e: unknown) { showError('Download file', e); }
      });
    }),

    tracedCommand('abbRobot.openControllerFile', async (arg: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const node = (arg && typeof arg === 'object' && 'node' in arg)
        ? (arg as { node: { path: string; entry: { name: string } } }).node
        : (arg as { path: string; entry: { name: string } } | undefined);
      if (!node || !node.path || !node.entry) {
        vscode.window.showWarningMessage('Right-click a file in the File Explorer panel to open it.');
        return;
      }
      try {
        const text = await mgr(multi).readFile(node.path);
        await openAsScratchFile(node.entry.name, text);
      } catch (e: unknown) { showError('Open controller file', e); }
    }),

    tracedCommand('abbRobot.deleteControllerFile', async (arg: unknown) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // Works for both files and directories - the RWS DELETE /fileservice/{path}
      // endpoint handles both. The contextValue (controllerFile|controllerDir) just
      // tells VS Code where to show the menu entry; the handler is the same.
      const node = (arg && typeof arg === 'object' && 'node' in arg)
        ? (arg as { node: { path: string; entry: { name: string; type?: string } } }).node
        : (arg as { path: string; entry: { name: string; type?: string } } | undefined);
      if (!node || !node.path || !node.entry) {
        vscode.window.showWarningMessage('Right-click a file or folder in the File Explorer panel to delete it.');
        return;
      }
      const isDir = node.entry.type === 'dir';
      const kind  = isDir ? 'folder' : 'file';
      const warn  = isDir
        ? `Delete folder "${node.entry.name}" and everything inside it?`
        : `Delete file "${node.entry.name}"?`;
      const c = await vscode.window.showWarningMessage(warn, { modal: true }, 'Delete');
      if (c !== 'Delete') { return; }
      try {
        await mgr(multi).deleteControllerFile(node.path);
        vscode.window.showInformationMessage(`${kind} '${node.entry.name}' deleted.`);
        filesProvider.refresh();
      } catch (e: unknown) {
        showError(`Delete ${kind}`, e);
      }
    }),

    // ─── I/O signals ─────────────────────────────────────────────────────────

    tracedCommand('abbRobot.refreshIo', async () => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refreshing I/O…' }, async () => {
        try { await mgr(multi).refreshIoSignals(); ioProvider.refresh(); }
        catch (e: unknown) { showError('Refresh I/O', e); }
      });
    }),

    tracedCommand('abbRobot.writeSignal', async (node?: SignalItem | Signal) => {
      if (!multi.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      let signalName: string | undefined, signalType: string | undefined, currentValue: string | undefined;
      if (node && typeof node === 'object' && 'signal' in node && (node as SignalItem).signal) {
        const s = (node as SignalItem).signal;
        signalName = s.name; signalType = s.type; currentValue = s.lvalue;
      } else if (node && typeof node === 'object' && 'name' in node && (node as Signal).name) {
        signalName = (node as Signal).name; signalType = (node as Signal).type; currentValue = (node as Signal).lvalue;
      } else {
        // Invoked from view title or command palette - prompt for signal name
        signalName = await vscode.window.showInputBox({ title: 'Write Signal', prompt: 'Signal name' });
        if (!signalName) { return; }
      }
      const isDigital = signalType === 'DO';
      let value: string | undefined;
      if (isDigital) {
        const pick = await vscode.window.showQuickPick([{ label: '0 - Off', value: '0' }, { label: '1 - On', value: '1' }], { placeHolder: `Current: ${currentValue ?? '?'}` });
        if (!pick) { return; }
        value = pick.value;
      } else {
        value = await vscode.window.showInputBox({ title: `Write ${signalName}`, value: currentValue, validateInput: v => isNaN(+v) ? 'Must be a number' : undefined });
        if (value === undefined) { return; }
      }
      try { await mgr(multi).writeIoSignal(signalName!, value); ioProvider.refresh(); vscode.window.showInformationMessage(`${signalName} = ${value}`); }
      catch (e: unknown) { showError('Write signal', e); }
    }),

    tracedCommand('abbRobot.toggleSignal', async (arg: unknown) => {
      if (!multi.state.connected) { return; }
      // VS Code passes the SignalItem TreeItem when clicked from the inline button;
      // unwrap to the underlying Signal. Without this the URL becomes
      // `/rw/iosystem/signals///undefined/set-value` (live-confirmed by trace logs).
      const signal: Signal | undefined = (arg && typeof arg === 'object' && 'signal' in arg)
        ? (arg as { signal: Signal }).signal
        : (arg as Signal | undefined);
      if (!signal || !signal.name) {
        vscode.window.showWarningMessage('Right-click a writable DO signal in the I/O panel to toggle it.');
        return;
      }
      try { await mgr(multi).writeIoSignal(signal.name, signal.lvalue === '1' ? '0' : '1'); ioProvider.refresh(); }
      catch (e: unknown) { showError('Toggle signal', e); }
    }),

  ); // end subscriptions.push
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map common ABB error patterns to user-actionable messages.
 * Identifies the operation + current controller state to give a clear
 * "do this to fix it" message instead of an opaque HTTP code.
 */
function friendlyErrorMessage(label: string, e: unknown, multi?: MultiRobotManager): string {
  const raw = e instanceof Error ? e.message : String(e);
  const opmode    = multi?.state.opmode ?? '';
  const ctrlstate = multi?.state.ctrlstate ?? '';
  const isWriteOp = /speed|start|stop|motors|reset|cycle|module|load|write|toggle/i.test(label);

  if (raw.includes('HTTP 403') || raw.toLowerCase().includes('not allowed')) {
    // The most specific case: mastership is held by another user (typically the FlexPendant
    // in MANR mode, which automatically holds rapid mastership as a safety measure).
    if (raw.toLowerCase().includes('held by someone else') || raw.toLowerCase().includes('mastership')) {
      if (opmode === 'MANR' || opmode === 'MANF') {
        return `${label} blocked - in ${opmode} mode the FlexPendant holds rapid mastership for safety. Switch to AUTO mode (FlexPendant key switch) so the extension can acquire mastership, then retry.`;
      }
      return `${label} blocked - another user (likely FlexPendant) holds the required mastership. Release control on the FlexPendant or switch to AUTO mode.`;
    }
    if (isWriteOp) {
      if (opmode === 'MANR' || opmode === 'MANF') {
        return `${label} requires AUTO mode (currently ${opmode}). Switch to AUTO via the FlexPendant key switch, then retry.`;
      }
      if (ctrlstate === 'guardstop') {
        return `${label} blocked - controller is in guardstop (safety chain open). On the FlexPendant: hold the Enable button (deadman) and turn motors on locally first.`;
      }
      if (raw.toLowerCase().includes('for user')) {
        return `${label} requires Remote Control approval. Open the FlexPendant and approve the popup that asks "Allow remote user to modify?", then retry.`;
      }
    }
    if (/jog/i.test(label)) {
      return `Jog blocked - ABB safety design restricts remote jog. Use the FlexPendant for jogging.`;
    }
  }

  if (raw.includes('HTTP 400') && isWriteOp && ctrlstate !== 'motoron') {
    return `${label} requires motors on (currently ${ctrlstate || 'unknown'}). Turn motors on first.`;
  }

  if (raw.includes('HTTP 503') || raw.toLowerCase().includes('too many sessions')) {
    return `${label} failed: controller is busy or session pool is full. Wait 30 s and retry, or restart the VC.`;
  }

  // RAPID-specific patterns (each matches a specific controller error code).

  // -1073442809 = "Current execution state does not allow this operation"
  // → user clicked Start without setting PP first
  if (raw.toLowerCase().includes('current execution state does not allow') || raw.includes('-1073442809')) {
    return `${label} blocked - RAPID is in an invalid state to start. Click "PP to Main" first to set the program pointer, then Start.`;
  }

  // -1073442802 / icode -519 → Semantic error.
  // The most common cause is a `main` proc collision: two loaded modules
  // each define PROC main(), so the controller's program is in a "two main"
  // semantic error and rejects ALL PP-to-Routine calls (even to other routines).
  // Other causes: undeclared symbols in the loaded module, type mismatches.
  if (raw.includes('Semantic error') || raw.includes('icode:-519')) {
    return `${label} blocked - RAPID program has a semantic error. Most often this means two loaded modules each define PROC main(). Open the Modules panel, right-click any of the program modules, and Unload Module. Then try again.`;
  }

  // org_code -519 (without "Semantic error" prefix) → Routine not found.
  // Common after Upload Module on a module without PROC main(), or after a manual unload.
  if (raw.includes('org_code: -519') || raw.includes('-519,')) {
    return `${label} can't run - the program pointer isn't set. Click "PP to Main" first (the loaded module needs a PROC main()), or use "Set PP to routine" to point at a specific procedure.`;
  }

  // -4501 / 0xc004841d = symbol-table inconsistency, often from broken module load
  // (e.g. uploaded module has no `main` proc, or program references a non-existent module)
  if (raw.includes('-4501') || raw.includes('0xc004841d')) {
    return `${label} failed: the controller's RAPID program is in an inconsistent state. This usually happens when a loaded module has no PROC main() or has references to missing modules. Try: (1) re-upload a known-good module, OR (2) restart the VC in RobotStudio to reset the program.`;
  }

  // resetpp 404 → no program loaded / no main found
  if (/HTTP 404/.test(raw) && /resetpp/i.test(raw)) {
    return `${label} failed: no PROC main() found in any loaded module. Load a module that has 'PROC main()', or set PP to a specific routine instead.`;
  }

  // fileservice 404 "Path does not exist"
  if (/HTTP 404/.test(raw) && /Path does not exist/i.test(raw)) {
    return `${label} failed: the path you specified doesn't exist on the controller. Check the parent directory exists, then retry.`;
  }

  return `${label} failed: ${raw}`;
}

function showError(label: string, e: unknown, multi?: MultiRobotManager) {
  // Log into the trace file so the trace reflects what the user saw,
  // even when the error was caught/handled gracefully (won't propagate to tracedCommand).
  // Captures both the RAW error (for diagnosis) and the FRIENDLY message
  // (so we can verify the user-facing text matches what was actually shown).
  const friendly = friendlyErrorMessage(label, e, multi);
  const raw      = e instanceof Error ? e.message : String(e);
  Logger.trace('error.shown', label, {
    friendly,
    raw,
    httpStatus:  (e as { httpStatus?: number })?.httpStatus,
    rwsCode:     (e as { code?: string })?.code,
    rwsDetail:   (e as { rwsDetail?: string })?.rwsDetail?.slice(0, 300),
    opmode:      multi?.state.opmode,
    ctrlstate:   multi?.state.ctrlstate,
    execstate:   multi?.state.execstate,
  });
  Logger.error(label, e);

  // Mastership-style errors: the user is in AUTO + has motors on but a write
  // op got 403. Three buttons:
  //   • Request Remote Control → the most common fix (RMMP popup on FlexPendant)
  //   • Show Holder            → diagnostic; prints who holds the lock
  //   • Force-Release          → release any stale lock we still own
  const isMastershipError = /mastership|held by someone else|RMMP|not allowed for user/i.test(raw)
    || (raw.includes('HTTP 403') && /rapid|edit|motion|mastership|pcp|pp\/|exec/i.test(raw.toLowerCase()));
  if (isMastershipError && multi?.active) {
    void vscode.window.showErrorMessage(friendly, 'Request Remote Control', 'Show Holder', 'Force-Release').then(async choice => {
      if (!choice) { return; }
      const active = multi.active!;
      try {
        if (choice === 'Request Remote Control') {
          const before = await active.getRmmpPrivilege().catch(() => 'unknown');
          if (before === 'modify' || before === 'exclusive') {
            vscode.window.showInformationMessage(
              `RMMP is already ${before} - but the operation still failed. ` +
              `The 403 likely has a different cause: another client holds rapid mastership, motors are off, op-mode is locked, ` +
              `or the user lacks a specific UAS grant for this operation.`,
              { modal: false },
            );
            return;
          }
          if (before === 'unsupported') {
            vscode.window.showInformationMessage('RMMP is not supported on this controller (likely RWS 1.0).');
            return;
          }
          try {
            await active.requestRmmp('modify');
            vscode.window.showInformationMessage(
              'RMMP request sent. Open the FlexPendant - a popup is asking "Allow remote user to modify?". Tap Allow, then retry the operation.',
              { modal: false },
            );
          } catch (rmmpErr) {
            const raw = rmmpErr instanceof Error ? rmmpErr.message : String(rmmpErr);
            if (/HTTP 403/.test(raw)) {
              vscode.window.showErrorMessage(
                'Cannot request RMMP - the logged-in user lacks the grant.\n\n' +
                'On the FlexPendant: ABB menu → Control Panel → User Authorization. ' +
                'Add a user with "Remote Login", "Modify Current Value", "Edit RAPID" grants, then reconnect with that user.',
                { modal: true },
              );
            } else {
              vscode.window.showErrorMessage(`RMMP request failed: ${raw}`);
            }
            Logger.warn(`requestRmmp inline failed: ${raw}`);
          }
          return;
        }
        const status = await active.getMastershipStatus('rapid');
        if (!status) {
          vscode.window.showInformationMessage('Mastership status query is not supported on this controller.');
          return;
        }
        const detail = `domain=edit (rapid) | mastership=${status.mastership}` +
                       (status.application ? ` | held-by=${status.application}` : '') +
                       (status.uid ? ` | uid=${status.uid}` : '');
        if (choice === 'Show Holder') {
          vscode.window.showInformationMessage(detail, { modal: true });
        } else if (choice === 'Force-Release') {
          try {
            await active.releaseMastershipAll();
            vscode.window.showInformationMessage(`Released our mastership. Status was: ${detail}. Now retry your operation.`);
          } catch (releaseErr) {
            vscode.window.showWarningMessage(
              `Cannot force-release: the controller refused. ${detail}\n\n` +
              `The holder needs to release it themselves (FlexPendant: Release button in controller settings; another web client: close that session).`,
              { modal: true },
            );
            Logger.warn(`force-release failed: ${String(releaseErr)}`);
          }
        }
      } catch (queryErr) {
        Logger.warn(`mastership-error helper failed: ${String(queryErr)}`);
        vscode.window.showWarningMessage(`Mastership helper failed: ${String(queryErr)}`);
      }
    });
    return;
  }

  vscode.window.showErrorMessage(friendly);
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

/**
 * Pull a file's content into a real file with its proper name + extension,
 * then open it. Used by "Open Module Source" and "Open Controller File" so
 * the resulting editor tab is a real `.mod`/`.sys`/`.prg` file (not an
 * "Untitled-N" doc) - which means Push, Diff, language server, and inlay
 * hints all work without special-casing.
 *
 * Location preference:
 *   1. The current workspace root if there is one (so it sits with the
 *      user's other code; they can git-commit it).
 *   2. A scratch folder at `~/.abb-rws-extension/scratch/` otherwise.
 *
 * Collision handling: if the destination already has a file with the same
 * name we ASK the user - open the existing local copy, overwrite with the
 * controller's version, or cancel. We deliberately do NOT silently rename
 * to `.controller.mod` because that creates an invalid RAPID module name
 * and breaks downstream Push/Diff (controller rejects module name with
 * a dot in it).
 */
async function openAsScratchFile(name: string, content: string): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const scratchDir = wsRoot ?? path.join(require('os').homedir(), '.abb-rws-extension', 'scratch');
  fs.mkdirSync(scratchDir, { recursive: true });
  const destPath = path.join(scratchDir, name);

  if (fs.existsSync(destPath)) {
    const choice = await vscode.window.showInformationMessage(
      `${name} already exists at ${destPath}.`,
      { modal: false },
      'Open Local',
      'Overwrite with Controller Version',
      'Cancel',
    );
    if (!choice || choice === 'Cancel') { return; }
    if (choice === 'Overwrite with Controller Version') {
      fs.writeFileSync(destPath, content, 'utf8');
    }
    // Either way (open local or overwrite-and-open), open the destPath.
  } else {
    fs.writeFileSync(destPath, content, 'utf8');
  }
  const doc = await vscode.workspace.openTextDocument(destPath);
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Resolve a task name from a tree-item arg (which has `.label` set to the task name)
 * OR fall back to a quick-pick from `candidates`. Returns undefined if user cancelled.
 */
async function extractTaskName(arg: unknown, candidates: string[]): Promise<string | undefined> {
  if (typeof arg === 'string') { return arg; }
  if (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string') {
    return (arg as { label: string }).label;
  }
  if (candidates.length === 0) { vscode.window.showWarningMessage('No matching tasks.'); return undefined; }
  if (candidates.length === 1) { return candidates[0]; }
  return vscode.window.showQuickPick(candidates, { placeHolder: 'Pick a task' });
}

/**
 * Detect and offer to resolve a "two `main` procs" semantic-error collision.
 *
 * RAPID rejects PP-to-Routine with `icode:-519 "Semantic error"` when more
 * than one loaded module defines `PROC main()` - even when the user is
 * trying to set PP to a different routine entirely. This breaks the natural
 * "load my new module + run a routine" workflow because the controller's
 * default Module1 (or a previously-loaded test module) already has main.
 *
 * Strategy: only fire if the failing error matches the semantic-error code.
 * Then: enumerate all program modules with a `main` proc; if exactly two
 * (current and one other), offer a one-click "Unload <other>" action. If
 * three or more, show a quick-pick of which to unload.
 *
 * Returns true if the collision was resolved (caller should retry the
 * original op). Returns false if not a collision, user cancelled, or
 * resolution failed - caller should surface the original error.
 */
async function tryResolveMainCollision(
  robot: import('abb-rws-client').RobotManager,
  taskName: string,
  currentModule: string,
  err: unknown,
  multi?: MultiRobotManager,
): Promise<boolean> {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/Semantic error|icode:-519/.test(msg)) { return false; }

  // Find every loaded program module that defines `main`
  const sysMods = new Set(['BASE', 'user', 'DPUSER', 'DPBASE']);
  const loaded = robot.state.modules.filter(m => !sysMods.has(m));
  const withMain: string[] = [];
  for (const m of loaded) {
    try {
      const routines = await robot.listRoutines(taskName, m);
      if (routines.some(r => r.name.toLowerCase() === 'main')) { withMain.push(m); }
    } catch { /* skip - module might be in a state we can't query */ }
  }
  if (withMain.length < 2) { return false; }   // not a main collision after all

  const others = withMain.filter(m => m !== currentModule);
  let toUnload: string | undefined;

  if (others.length === 1) {
    const choice = await vscode.window.showWarningMessage(
      `Two modules each define PROC main(): "${currentModule}" and "${others[0]}". ` +
      `RAPID needs exactly one. Unload "${others[0]}"?`,
      { modal: false }, 'Unload', 'Cancel',
    );
    if (choice !== 'Unload') { return false; }
    toUnload = others[0];
  } else {
    const pick = await vscode.window.showQuickPick(
      withMain.map(m => ({ label: m, description: m === currentModule ? '(current - keep)' : 'unload this one' })),
      { placeHolder: `${withMain.length} modules have PROC main(). Pick one to UNLOAD.` },
    );
    if (!pick || pick.label === currentModule) { return false; }
    toUnload = pick.label;
  }

  try {
    await robot.unloadModule(taskName, toUnload);
    vscode.window.setStatusBarMessage(`✓ Unloaded "${toUnload}" - retrying…`, 3000);
    return true;
  } catch (e) {
    showError(`Unload ${toUnload}`, e, multi);
    return false;
  }
}

async function wrap(title: string, fn: () => Promise<void>, successMsg: string, multi?: MultiRobotManager) {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
    try { await fn(); vscode.window.showInformationMessage(successMsg); }
    catch (e: unknown) { showError(title.replace('…', ''), e, multi); }
  });
}

// ─── Deactivate ──────────────────────────────────────────────────────────────

export async function deactivate() {
  if (globalMulti) {
    for (const { id } of globalMulti.entries) {
      await globalMulti.disconnectRobot(id).catch(() => {});
    }
    globalMulti = undefined;
  }
}
