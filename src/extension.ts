import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MultiRobotManager, RobotManager, setLogger, isLocalAddress } from 'abb-rws-client';
import type {
  RobotConfig, RobotState, DiscoveredController, MdnsController, RefusalRemedy, RwsRefusal, RmmpResult,
  FindControllersOptions, FindControllersResult, FoundController, ManualTarget,
} from 'abb-rws-client';
import {
  DEFAULT_SCAN_CHOICE, MAX_RANGE_ADDRESSES, MAX_SAVED_ADDRESSES, MAX_SAVED_RANGES, SERVICE_ADDRESS,
  answeringControllers, clearAllWrites, controllerRows, credentialDefaults, discoveryErrorText, displayNotes,
  emptyResult, manualTargetKey, mergeResults, parseAddressInput, progressMessage, rangeAddressCount,
  rangeProblem, readDiscoverySettings, removalWrites, rowStatus, savedEntries, savedEntryLabel,
  scanWithRangeGate, selectionFor, targetLabel, targetScanOptions, withSavedEntry, wizardScanOptions,
} from './AddRobotDiscovery';
import type {
  DiscoverySettings, ParsedAddress, SavedEntry, SavedListWrite, SavedScope, ScanChoice, ScopedSavedValues,
} from './AddRobotDiscovery';
import {
  LEGACY_ROBOT_KEYS, PASSWORD_SECRET_PREFIX, RobotListSync, applyStoredList, legacyMigrationWrites,
  movePasswordsToSecrets, robotEntries, robotIdOfPasswordKey, saveRobotEdit, savedRobots,
  type LegacyRobotKey, type RobotListEdit, type RobotSettingsStore, type RobotsInMemory, type SaveSteps,
  type ScopedValue, type SettingsWrite, type StoredRobot,
} from './robotSettings';
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
import { callServiceRoutine, modeRefusal } from './serviceRoutine';
import { saveModuleText, moduleSaveName, MODULE_SAVE_LABEL } from './moduleDownload';
import { clockReadMessage, clockSetPrompt, clockSetDefault, clockSetDone, parseClockInput, clockWriteRefused, clockWriteRefusedMessage } from './controllerClock';
import { volumesToShow, fileVolumesText } from './fileVolumes';
import { runVirtualTimeAction, virtualTimeActionsFor, virtualTimeNotice, type VirtualTimeReading } from './virtualTime';
import {
  LAST_SEEN_KEY, addressText, connectWithRetries, differentSystemQuestion, elsewhereMessage, goneMessage, identityVerdict,
  onceAtATime, planConnect, settleConnect, withLastSeen, withoutLastSeen,
  type AttemptResult, type ConnectPlan, type LastSeen, type PlanSteps, type PortOf, type SessionNow, type SystemReading,
} from './portRecovery';
import { confirmRobot, confirmWrite, heartbeatWarning, isRapidRunning, jogNeedsAsk, opModeRequest, speedRatioRequest, virtualOnlyRequest, whileRunningRequest, restartSideEffects, robotLabel, type ConfirmRequest, type ConfirmRobot, type ConfirmUi } from './confirm';
import { isProgramRunningRefusal, isSemanticError, opModeRefusalNote, refusalButtons, refusalMessage, safetyStopName, semanticErrorText, stopOfferDetail, withNote, mastershipHolderText, writeAccessHolderText, type RobotFacts } from './refusalUi';
import {
  MOTION_CONTROL_SWITCH, MotionControlTracker, WITHDRAW_BUTTON, allowFromRefusal, confirmMotionWrite, disconnectButton, disconnectMessage,
  fixedStation, motionContextKeys, motionEntryOf, motionLineOf, noticeForEvent, remoteWindow, runAllow, runSwitchWithdraw, runWithdraw,
  sessionNow, statusBarFor, withdrawChoice, withdrawOnSwitch, withdrawPickItems,
  type AllowContext, type AllowOrigin, type AllowOutcome, type MotionEntry, type MotionNotice, type MotionUi, type WithdrawContext,
} from './motionControl';
import { jogConfirmEffects } from './jogText';
import { duplicateRobotNames, entryForArg, extractRobotId } from './robotArg';
import { RMMP_NAME, rmmpGrantedText, rmmpOutcomeText, type RmmpLevelChoice } from './rmmp';
import { CFG_LOAD_LABEL, cfgFallbackMessage, cfgLoadNextStep, loadActionDetail } from './cfgLoad';
import { withStrictTlsHint } from './strictTlsHint';
import { writableAttributes } from './cfgAttributes';
import { dipcCountPrompt, dipcMessageText, dipcSizePrompt, validateDipcCount, validateDipcSize } from './dipcQueue';
import type { SignalItem } from './IoTreeProvider';
import type { Signal } from 'abb-rws-client';

let globalMulti: MultiRobotManager | undefined;
/**
 * Runs this window's saves of the robot list and the applying of changes made elsewhere one at
 * a time (see `changeSavedRobots`, `applyStoredRobots`). Set on activation.
 */
let robotListSync: RobotListSync | undefined;
/**
 * The robots whose jog confirmation was given on the current connection, by
 * robot id. An entry is removed when that robot disconnects, so the next
 * connection asks again. Reset on each extension activation.
 */
const jogConfirmed = new Map<string, number>();

// ─── Confirmations before a write ────────────────────────────────────────────

/** One saved robot: its id, its config and the manager that talks to it. */
type RobotEntry = MultiRobotManager['entries'][number];

/** The active robot's entry, resolved once at the top of a handler so every call and dialog of it goes to the same robot. */
function activeEntry(multi: MultiRobotManager): RobotEntry {
  const entry = multi.entries.find(e => e.id === multi.activeId);
  if (!entry) { throw new Error('No robot selected. Add and connect a robot in the Robots panel.'); }
  return entry;
}

/**
 * The robot a command acts on: the one its argument names, else the active
 * one. Throws when there is none, so a row's button never falls back to a
 * different robot than the row.
 */
function entryOf(multi: MultiRobotManager, arg?: unknown): RobotEntry {
  const entry = entryForArg(multi.entries, multi.activeId ?? undefined, arg);
  if (!entry) { throw new Error('No robot selected. Add and connect a robot in the Robots panel.'); }
  return entry;
}

/** Whether this robot is still the active one (the panels show the active robot only). */
function isActiveEntry(multi: MultiRobotManager, entry: RobotEntry): boolean {
  return multi.activeId === entry.id;
}

/**
 * The robot as the confirmation dialogs name it: while connected, at the address its session is
 * on, which a saved address changed since does not move (see `confirmRobot`).
 */
function confirmRobotOf(entry: RobotEntry): ConfirmRobot {
  const s = entry.manager.state;
  return confirmRobot(
    entry.config,
    { connected: s.connected, host: s.host, port: entry.manager.currentPort },
    s.identity?.name ?? s.systemInfo?.name ?? null,
  );
}

const confirmUi: ConfirmUi = {
  modal: (message, detail, buttons) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons),
  input: (title, prompt, placeHolder) => vscode.window.showInputBox({ title, prompt, placeHolder }),
  warn: message => { void vscode.window.showWarningMessage(message); },
};

/** The RobotWare 8 heartbeat warning for a start's confirmation, as a list of zero or one line. */
function heartbeatSideEffects(entry: RobotEntry): string[] {
  const warning = heartbeatWarning(entry.manager.state.access);
  return warning ? [warning] : [];
}

/** Ask before a write to this robot (see `confirmWrite`). False means: send nothing. */
function confirm(entry: RobotEntry, request: ConfirmRequest): Promise<boolean> {
  return confirmWrite(confirmUi, confirmRobotOf(entry), request);
}

// ─── RobotWare 8 motion control ──────────────────────────────────────────────

/**
 * The robots RAPID Live allowed motion control on in this window, per robot
 * and connection, and the notices the client's withdrawals give for them (see
 * `MotionControlTracker`). Reset on each extension activation.
 */
const motionTracker = new MotionControlTracker();

/** The window the motion-control flows talk through, with refusals shown for this robot. */
function motionUiFor(entry: RobotEntry): MotionUi {
  return {
    ...confirmUi,
    info: message => { void vscode.window.showInformationMessage(message); },
    ask: (message, buttons) => vscode.window.showWarningMessage(message, ...buttons),
    refused: (label, e) => showError(label, e, entry),
  };
}

/**
 * Disconnect a robot (or remove it), marked so a failed withdrawal at the disconnect says so.
 * True when a motion-control notice was given for this disconnect (the caller then adds no
 * message of its own).
 */
async function endConnection(multi: MultiRobotManager, id: string, how: 'disconnect' | 'remove' = 'disconnect'): Promise<boolean> {
  motionTracker.beginDisconnect(id);
  let noticed = false;
  try {
    await (how === 'remove' ? multi.removeRobot(id) : multi.disconnectRobot(id));
  } finally {
    noticed = motionTracker.endDisconnect(id);
    if (how === 'remove') { motionTracker.clear(id); }
  }
  return noticed;
}

/** Every saved robot as the motion-control status bar, Withdraw and context keys read it. */
function motionEntries(multi: MultiRobotManager): MotionEntry[] {
  return multi.entries.map(e => motionEntryOf(e, motionTracker.allowedHere(e.id)));
}

function withdrawContext(entry: RobotEntry): WithdrawContext {
  return {
    ui: motionUiFor(entry),
    robot: confirmRobotOf(entry),
    tracker: motionTracker,
    disconnect: async () => { if (globalMulti) { await endConnection(globalMulti, entry.id).catch(() => undefined); } },
    log: message => Logger.info(message),
  };
}

/** Withdraw motion control on this robot (the command, a status bar click, a warning's button). */
async function withdrawFor(entry: RobotEntry): Promise<void> {
  await runWithdraw(entry, withdrawContext(entry));
}

/**
 * The robot Withdraw Motion Control acts on: the one its argument names (a Robots view row,
 * the status bar), else the one robot whose allowance may stand, else the active one; with
 * several, the one the person picks (undefined: none picked). See `withdrawChoice`.
 */
async function withdrawTargetOf(multi: MultiRobotManager, arg?: unknown): Promise<RobotEntry | undefined> {
  if (extractRobotId(arg) !== undefined) { return entryOf(multi, arg); }
  const choice = withdrawChoice(motionEntries(multi), multi.activeId);
  if (!('pick' in choice)) { return entryOf(multi, choice.id); }
  const picked = await vscode.window.showQuickPick(withdrawPickItems(choice.pick, multi.activeId), {
    title: 'Withdraw Motion Control (RobotWare 8)', placeHolder: 'The robot to withdraw motion control on',
  });
  return picked ? entryOf(multi, picked.id) : undefined;
}

/** The robot switch withdrawal, on the robot that stopped being active (held off in this release). */
async function withdrawOnSwitchFor(entry: RobotEntry, toName: string): Promise<void> {
  await runSwitchWithdraw(entry, toName, withdrawContext(entry));
}

/**
 * Allow motion control on this robot, after the person's confirmation (see
 * `runAllow`). `remedy`: the refusal's remedy, when started from a refusal.
 */
async function allowFor(entry: RobotEntry, origin: AllowOrigin, remedy?: RefusalRemedy): Promise<AllowOutcome> {
  const ctx: AllowContext = {
    ...withdrawContext(entry),
    isActive: () => globalMulti?.activeId === entry.id,
    remote: remoteWindow(vscode.env.remoteName, vscode.env.uiKind === vscode.UIKind.Web),
    forgetJogConfirmation: () => { jogConfirmed.delete(entry.id); },
    withdraw: () => withdrawFor(entry),
  };
  return runAllow(entry, origin, ctx, remedy);
}

/**
 * Ask before a start, a routine run or a jog: on RobotWare 8 the confirmation
 * carries the motion-control line, and `Allow Motion Control first…` where
 * motion control is not known to be allowed (see `confirmMotionWrite`).
 */
function confirmMotion(entry: RobotEntry, request: ConfirmRequest): Promise<boolean> {
  return confirmMotionWrite(
    confirmUi, () => confirmRobotOf(entry), request,
    () => motionLineOf(entry, motionTracker.allowedHere(entry.id)),
    () => allowFor(entry, 'start-confirmation'),
  );
}

/** Show a notice of the motion-control tracker for this robot. */
function showMotionNotice(id: string, notice: MotionNotice): void {
  const shown = notice.level === 'info'
    ? vscode.window.showInformationMessage(notice.text, ...notice.buttons)
    : vscode.window.showWarningMessage(notice.text, ...notice.buttons);
  void shown.then(async choice => {
    const entry = globalMulti?.entries.find(e => e.id === id);
    if (!choice || !entry) { return; }
    if (choice === WITHDRAW_BUTTON) { await withdrawFor(entry); }
    else if (choice === disconnectButton(entry.config.name) && globalMulti) { await endConnection(globalMulti, id).catch(() => undefined); }
  });
}

// ─── Password secret storage ─────────────────────────────────────────────────

/** SecretStorage key for a robot's password. */
function passwordSecretKey(robotId: string): string {
  return `${PASSWORD_SECRET_PREFIX}${robotId}`;
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

/** A picked discovery result - probe fields plus an optional name suggestion (the system name, when known). */
type SelectedController = DiscoveredController & { suggestedName?: string };

/** `abbRobot.strictTls`, read at scan time. */
function strictTlsSetting(): boolean {
  return vscode.workspace.getConfiguration('abbRobot').get<boolean>('strictTls', false);
}

/** The discovery settings, checked. Entries that are left out are logged. */
function loadDiscoverySettings(): DiscoverySettings {
  const cfg = vscode.workspace.getConfiguration('abbRobot');
  const settings = readDiscoverySettings({
    manual: cfg.get<unknown>('discoveryManual'),
    ranges: cfg.get<unknown>('discoveryRanges'),
    ports:  cfg.get<unknown>('discoveryPorts'),
  });
  for (const why of settings.skipped) { Logger.warn(`discovery settings: ${why}`); }
  return settings;
}

/** Write the saved addresses and ranges to the user settings (both are machine-scoped). */
async function saveDiscoveryTargets(manual: ManualTarget[], ranges: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('abbRobot');
  await cfg.update('discoveryManual', manual, vscode.ConfigurationTarget.Global);
  await cfg.update('discoveryRanges', ranges, vscode.ConfigurationTarget.Global);
}

/** Open the settings at the discovery entries. */
function openDiscoverySettings(): void {
  void vscode.commands.executeCommand('workbench.action.openSettings', 'abbRobot.discovery');
}

/** The raw values of the saved addresses and ranges in the user and the workspace settings. */
function inspectSavedLists(): Record<SavedScope, ScopedSavedValues> {
  const cfg = vscode.workspace.getConfiguration('abbRobot');
  const manual = cfg.inspect<unknown>('discoveryManual');
  const ranges = cfg.inspect<unknown>('discoveryRanges');
  return {
    global:    { manual: manual?.globalValue,    ranges: ranges?.globalValue },
    workspace: { manual: manual?.workspaceValue, ranges: ranges?.workspaceValue },
  };
}

const SAVED_SCOPE_TARGET: Record<SavedScope, vscode.ConfigurationTarget> = {
  global:    vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
};

/**
 * Write the saved-list changes. Each write is tried on its own; a failure is logged and shown.
 * Resolves false when any write failed.
 */
async function applySavedListWrites(writes: SavedListWrite[]): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('abbRobot');
  const failed: string[] = [];
  for (const w of writes) {
    try {
      await cfg.update(w.key, w.value, SAVED_SCOPE_TARGET[w.scope]);
    } catch (e) {
      const text = `abbRobot.${w.key} in the ${w.scope === 'global' ? 'user' : 'workspace'} settings: ${e instanceof Error ? e.message : String(e)}`;
      Logger.warn(`could not update ${text}`);
      failed.push(text);
    }
  }
  if (failed.length > 0) {
    void vscode.window.showErrorMessage(`Could not update ${failed.join('; ')}`, 'Open Settings')
      .then(choice => { if (choice) { openDiscoverySettings(); } });
  }
  return failed.length === 0;
}

/** Remove saved addresses and ranges, each from the settings scope it lives in. Nothing else changes. */
async function removeSavedEntries(entries: SavedEntry[]): Promise<boolean> {
  const writes = removalWrites(inspectSavedLists(), entries);
  if (writes.length === 0) { return true; }
  const ok = await applySavedListWrites(writes);
  Logger.info(`discovery: removed from the saved list: ${entries.map(savedEntryLabel).join(', ')}`);
  return ok;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * "Remove All Saved Addresses and Ranges": both lists, from every scope that sets them, after a
 * modal confirmation. Saved robots, their passwords and `abbRobot.discoveryPorts` stay.
 */
async function clearSavedEntries(): Promise<boolean> {
  const writes = clearAllWrites(inspectSavedLists());
  if (writes.length === 0) {
    void vscode.window.showInformationMessage('There are no saved addresses or ranges.');
    return false;
  }
  const { manual, ranges } = loadDiscoverySettings();
  const choice = await vscode.window.showWarningMessage(
    'Remove all saved addresses and ranges?',
    {
      modal: true,
      detail: `${plural(manual.length, 'address', 'addresses')} and ${plural(ranges.length, 'range', 'ranges')} `
        + '(abbRobot.discoveryManual and abbRobot.discoveryRanges). Your saved robots, their passwords and the '
        + 'extra ports stay.',
    },
    'Remove All',
  );
  if (choice !== 'Remove All') { return false; }
  const ok = await applySavedListWrites(writes);
  if (ok) {
    Logger.info('discovery: removed all saved addresses and ranges');
    vscode.window.setStatusBarMessage('$(trash) Saved addresses and ranges removed', 4000);
  }
  return ok;
}

/**
 * "Manage Saved Addresses and Ranges": tick entries to remove them, or remove all (asks first).
 * Resolves `'settings'` when the user opened the settings instead.
 */
async function manageSavedEntries(): Promise<'settings' | undefined> {
  const settings = loadDiscoverySettings();
  const entries = savedEntries(settings);
  if (entries.length === 0 && clearAllWrites(inspectSavedLists()).length === 0) {
    void vscode.window.showInformationMessage(
      'There are no saved addresses or ranges. "Add address / range…" in Add Robot saves them.',
    );
    return undefined;
  }

  type Item = vscode.QuickPickItem & { entry: SavedEntry };
  const items: Item[] = entries.map(entry => {
    if (entry.kind === 'address') {
      return { label: `$(server)  ${savedEntryLabel(entry)}`, description: 'saved address · probed on every Add Robot scan', entry };
    }
    const n = rangeAddressCount(entry.range) ?? 0;
    return { label: `$(search)  ${entry.range}`, description: `saved range · ${plural(n, 'address', 'addresses')} · scanned only when picked`, entry };
  });
  const removeAllButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Remove all saved addresses and ranges…' };
  const settingsButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('gear'), tooltip: 'Open in Settings' };

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Saved addresses and ranges - ${entries.length}`;
  qp.placeholder = entries.length > 0
    ? 'Tick the entries to remove, then press Enter. Saved robots are not affected.'
    : 'The saved lists cannot be read: remove all, or open the settings';
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.buttons = [removeAllButton, settingsButton];
  qp.items = items;

  type Outcome = { kind: 'remove'; entries: SavedEntry[] } | { kind: 'clear' } | { kind: 'settings' } | undefined;
  const outcome = await new Promise<Outcome>(resolve => {
    let done = false;
    const finish = (o: Outcome): void => {
      if (done) { return; }
      done = true;
      resolve(o);
      qp.dispose();
    };
    qp.onDidAccept(() => {
      const picked = qp.selectedItems.map(i => i.entry);
      finish(picked.length > 0 ? { kind: 'remove', entries: picked } : undefined);
    });
    qp.onDidTriggerButton(b => finish(b === removeAllButton ? { kind: 'clear' } : { kind: 'settings' }));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });

  if (outcome?.kind === 'remove') {
    if (await removeSavedEntries(outcome.entries)) {
      vscode.window.setStatusBarMessage(`$(trash) Removed ${outcome.entries.map(savedEntryLabel).join(', ')} from the saved list`, 4000);
    }
  } else if (outcome?.kind === 'clear') {
    await clearSavedEntries();
  } else if (outcome?.kind === 'settings') {
    openDiscoverySettings();
    return 'settings';
  }
  return undefined;
}

/** Ask before a scan that includes a range: every time, modal, with the plain note about IT. */
async function confirmRangeScan(warning: { message: string; detail: string }): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(warning.message, { modal: true, detail: warning.detail }, 'Scan');
  return choice === 'Scan';
}

/**
 * Run one `findControllers` scan behind a cancellable progress notification. A scan with
 * ranges asks first. Cancel stops it; the result then holds what was found so far
 * (`aborted: true`). Resolves undefined when the user declined the range scan or the options
 * were refused (the refusal is shown; nothing was sent).
 */
async function runDiscoveryScan(title: string, options: FindControllersOptions): Promise<FindControllersResult | undefined> {
  try {
    return await scanWithRangeGate(options, {
      confirm: confirmRangeScan,
      find: async o => vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          const sub = token.onCancellationRequested(() => abort.abort());
          let lastPhase = '';
          let lastAt = 0;
          try {
            return await RobotManager.findControllers({
              ...o,
              signal: abort.signal,
              onProgress: e => {
                const now = Date.now();
                if (e.phase === lastPhase && now - lastAt < 150) { return; }
                lastPhase = e.phase;
                lastAt = now;
                progress.report({ message: progressMessage(e) });
              },
            });
          } finally {
            sub.dispose();
          }
        },
      ),
    });
  } catch (e) {
    const text = discoveryErrorText(e);
    Logger.warn(`discovery refused: ${text}`);
    // Not awaited: the picker still opens, with "Enter address manually" and the settings entry.
    void vscode.window.showErrorMessage(`Discovery: ${text}`, 'Edit Saved Addresses and Ranges')
      .then(choice => { if (choice) { openDiscoverySettings(); } });
    return undefined;
  }
}

/**
 * Full "Add Robot" flow:
 *  1. Scan this PC's listening ports (RobotStudio VCs, whatever port they got), the service
 *     address 192.168.125.1 when this PC has an address on its subnet, mDNS announcements, and
 *     the saved addresses. Never a range: ranges are scanned only when picked, after a confirm.
 *  2. Picker: the controllers found, the saved addresses and ranges, "Scan again with
 *     options…", "Add address / range…", "Enter address manually…" and the connection guide.
 *  3. Credentials and display name, saved to config (password → SecretStorage).
 */
async function runAddRobotWizard(multi: MultiRobotManager, secrets: vscode.SecretStorage): Promise<void> {
  const selected = await findAndPickController();
  if (!selected) { return; }
  await finishAddRobot(multi, secrets, selected);
}

/** What one row of the Add Robot picker does. */
type FindPickAction =
  | { kind: 'controller'; controller: FoundController }
  | { kind: 'saved-address'; target: ManualTarget }
  | { kind: 'scan-ranges'; ranges: string[] }
  | { kind: 'options' }
  | { kind: 'add' }
  | { kind: 'manual' }
  | { kind: 'manage-saved' }
  | { kind: 'help' }
  | { kind: 'note'; text: string };

/** What the Add Robot picker shows. */
interface FindView {
  controllers: FoundController[];
  notes: string[];
  settings: DiscoverySettings;
  /** The last full scan included the saved addresses. */
  savedScanned: boolean;
  /** Saved addresses probed on their own in this run (`manualTargetKey`). */
  probedSaved: Set<string>;
  /** The last scan was cancelled; the list may be incomplete. */
  aborted: boolean;
}

/** Scan, then let the user pick a controller or another way to find one. */
async function findAndPickController(): Promise<SelectedController | undefined> {
  let choice: ScanChoice = { ...DEFAULT_SCAN_CHOICE, ranges: [] };
  const view: FindView = {
    controllers: [], notes: [], settings: loadDiscoverySettings(),
    savedScanned: choice.savedAddresses, probedSaved: new Set(), aborted: false,
  };
  const remoteName = vscode.env.remoteName;
  const show = (r: FindControllersResult, replace: boolean): void => {
    view.controllers = replace ? r.controllers : mergeResults(view.controllers, r.controllers);
    const notes = displayNotes(r, remoteName);
    view.notes = replace ? notes : [...new Set([...view.notes, ...notes])];
    view.aborted = r.aborted;
  };

  show(await runDiscoveryScan(
    'Scanning for ABB controllers…',
    wizardScanOptions(choice, view.settings, { strictTls: strictTlsSetting() }),
  ) ?? emptyResult(), true);

  for (;;) {
    const action = await showFindPicker(view);
    if (!action) { return undefined; }
    switch (action.kind) {
      case 'controller': {
        const selected = await selectFoundController(action.controller, view.settings.ports);
        if (selected) { return selected; }
        break;
      }
      case 'saved-address': {
        const scanned = view.savedScanned || view.probedSaved.has(manualTargetKey(action.target));
        const answer = await vscode.window.showWarningMessage(
          `${targetLabel(action.target)} ${scanned ? 'did not answer in this scan' : 'was not part of this scan'}.`,
          { modal: true, detail: 'Probe it now, or remove it from the saved addresses (abbRobot.discoveryManual).' },
          'Probe Now', 'Remove from Saved Addresses',
        );
        if (answer === 'Probe Now') {
          view.probedSaved.add(manualTargetKey(action.target));
          const selected = await probeAndSelect(action.target, view.settings.ports);
          if (selected) { return selected; }
        } else if (answer === 'Remove from Saved Addresses') {
          await removeSavedEntries([{ kind: 'address', target: action.target }]);
          view.settings = loadDiscoverySettings();
        }
        break;
      }
      case 'scan-ranges': {
        const r = await runDiscoveryScan(
          `Scanning ${action.ranges.join(', ')}…`,
          targetScanOptions({ ranges: action.ranges }, view.settings.ports, { strictTls: strictTlsSetting() }),
        );
        if (r) { show(r, false); }
        break;
      }
      case 'options': {
        const next = await pickScanOptions(choice, view.settings);
        if (!next) { break; }
        const r = await runDiscoveryScan(
          'Scanning for ABB controllers…',
          wizardScanOptions(next, view.settings, { strictTls: strictTlsSetting() }),
        );
        if (r) {
          choice = next;
          view.savedScanned = next.savedAddresses;
          show(r, true);
        }
        break;
      }
      case 'add': {
        const entry = await addAddressOrRange(view.settings);
        view.settings = loadDiscoverySettings();
        if (!entry) { break; }
        if (entry.kind === 'host') { view.probedSaved.add(manualTargetKey(toTarget(entry))); }
        const r = entry.kind === 'host'
          ? await runDiscoveryScan(`Probing ${targetLabel(entry)}…`,
            targetScanOptions({ manual: [toTarget(entry)] }, view.settings.ports, { strictTls: strictTlsSetting() }))
          : await runDiscoveryScan(`Scanning ${entry.range}…`,
            targetScanOptions({ ranges: [entry.range] }, view.settings.ports, { strictTls: strictTlsSetting() }));
        if (r) { show(r, false); }
        break;
      }
      case 'manual': {
        const selected = await enterAddressManually(view.settings.ports);
        if (selected) { return selected; }
        break;
      }
      case 'manage-saved': {
        const opened = await manageSavedEntries();
        view.settings = loadDiscoverySettings();
        // The settings editor takes the focus, which would close the picker anyway.
        if (opened === 'settings') { return undefined; }
        break;
      }
      case 'help':
        void showConnectionGuide();
        return undefined;
      case 'note':
        // Modal, so the picker comes back as soon as the note is closed.
        await vscode.window.showInformationMessage(action.text, { modal: true });
        break;
    }
  }
}

/** One row of the Add Robot picker. `saved` is set on a saved address or range: its trash button removes it. */
type FindItem = vscode.QuickPickItem & { action?: FindPickAction; saved?: SavedEntry };

/**
 * The Add Robot picker: controllers found, notes, saved addresses and ranges, and the other ways
 * in. The trash button on a saved address or range removes it from the settings and the list is
 * redrawn in place.
 */
async function showFindPicker(view: FindView): Promise<FindPickAction | undefined> {
  const qp = vscode.window.createQuickPick<FindItem>();
  const redraw = (): void => {
    const found = controllerRows(view.controllers).length;
    qp.title = `Detected ABB controllers - ${found > 0 ? `${found} found` : 'none found'}`
      + (view.aborted ? ' (scan cancelled, the list may be incomplete)' : '');
    qp.placeholder = found > 0
      ? 'Select a controller to add, or another option'
      : 'No controllers found - add or enter an address, or see the connection guide';
    qp.items = findPickerItems(view);
  };
  qp.matchOnDescription = true;
  qp.keepScrollPosition = true;
  redraw();

  return new Promise<FindPickAction | undefined>(resolve => {
    let done = false;
    let removing = false;
    const finish = (action: FindPickAction | undefined): void => {
      if (done) { return; }
      done = true;
      resolve(action);
      qp.dispose();
    };
    qp.onDidAccept(() => {
      const action = qp.selectedItems[0]?.action;
      if (action && !removing) { finish(action); }
    });
    qp.onDidTriggerItemButton(async e => {
      const entry = e.item.saved;
      if (!entry || removing || done) { return; }
      removing = true;
      qp.busy = true;
      qp.enabled = false;
      try {
        if (await removeSavedEntries([entry])) {
          vscode.window.setStatusBarMessage(`$(trash) Removed ${savedEntryLabel(entry)} from the saved list`, 4000);
        }
        view.settings = loadDiscoverySettings();
        if (!done) { redraw(); }
      } finally {
        removing = false;
        if (!done) {
          qp.busy = false;
          qp.enabled = true;
        }
      }
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

/** The rows of the Add Robot picker for the current view. */
function findPickerItems(view: FindView): FindItem[] {
  type Item = FindItem;
  const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const removeButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove from saved' };
  const rows = controllerRows(view.controllers);
  const { manual, ranges } = view.settings;
  const items: Item[] = [];

  if (rows.length === 0) {
    items.push({
      label:       '$(warning)  No controllers found automatically',
      description: 'Check network/RWS settings, add an address or range, or see the guide',
      kind: vscode.QuickPickItemKind.Separator,
    });
  }
  for (const row of rows) {
    items.push({ label: row.label, description: row.description, detail: row.detail, action: { kind: 'controller', controller: row.controller } });
  }

  if (view.notes.length > 0) {
    items.push(separator('Notes'));
    for (const text of view.notes) {
      items.push({ label: `$(info)  ${text}`, action: { kind: 'note', text } });
    }
  }

  if (manual.length > 0 || ranges.length > 0) {
    items.push(separator('Saved addresses and ranges'));
  }
  for (const target of manual) {
    const saved: SavedEntry = { kind: 'address', target };
    const answered = answeringControllers(target, view.controllers);
    if (answered.length > 0) {
      // Picking it adds the controller that answered for it (also listed above).
      items.push({
        label:       `$(pass)  ${targetLabel(target)}`,
        description: 'saved address · answered, listed above',
        action: { kind: 'controller', controller: answered[0] },
        saved,
        buttons: [removeButton],
      });
      continue;
    }
    const scanned = view.savedScanned || view.probedSaved.has(manualTargetKey(target));
    items.push({
      label:       `$(debug-disconnect)  ${targetLabel(target)}`,
      description: scanned ? 'saved address · no answer in this scan' : 'saved address · not part of this scan',
      action: { kind: 'saved-address', target },
      saved,
      buttons: [removeButton],
    });
  }
  for (const range of ranges) {
    const n = rangeAddressCount(range) ?? 0;
    items.push({
      label:       `$(search)  Scan range ${range}…`,
      description: `saved range · ${n} address${n === 1 ? '' : 'es'} · asks first`,
      action: { kind: 'scan-ranges', ranges: [range] },
      saved: { kind: 'range', range },
      buttons: [removeButton],
    });
  }
  const allRanges = ranges.reduce((sum, r) => sum + (rangeAddressCount(r) ?? 0), 0);
  if (ranges.length > 1 && allRanges <= MAX_RANGE_ADDRESSES) {
    items.push({
      label:       '$(search)  Scan all saved ranges…',
      description: `${allRanges} addresses · asks first`,
      action: { kind: 'scan-ranges', ranges: [...ranges] },
    });
  }

  items.push(separator(''));
  items.push({
    label:       '$(settings)  Scan again with options…',
    description: `service port address ${SERVICE_ADDRESS}, mDNS, saved addresses and ranges`,
    action: { kind: 'options' },
  });
  items.push({
    label:       '$(add)  Add address / range…',
    description: 'Save an address, host:port or range for later scans',
    action: { kind: 'add' },
  });
  items.push({
    label:       '$(edit)  Enter address manually…',
    description: 'Probe one address now, without saving it',
    action: { kind: 'manual' },
  });
  if (manual.length > 0 || ranges.length > 0) {
    items.push({
      label:       '$(list-selection)  Manage saved addresses and ranges…',
      description: 'Remove some or all of them, or open the settings',
      action: { kind: 'manage-saved' },
    });
  }
  items.push({
    label:       '$(question)  How do I find my controller?',
    description: 'Show connection guide for IRC5 and OmniCore',
    action: { kind: 'help' },
  });
  return items;
}

/** A typed host as a scan target. */
function toTarget(entry: Extract<ParsedAddress, { kind: 'host' }>): ManualTarget {
  const target: ManualTarget = { host: entry.host };
  if (entry.port !== undefined) { target.port = entry.port; }
  if (entry.https !== undefined) { target.https = entry.https; }
  return target;
}

/**
 * Turn a picked result into connection parameters. A result whose login challenge is not
 * ABB's needs an explicit confirm; an mDNS-only result is probed first (its scheme is never
 * guessed from the announcement).
 */
async function selectFoundController(c: FoundController, ports: number[]): Promise<SelectedController | undefined> {
  const status = rowStatus(c);
  if (status === 'announced') {
    return probeAndSelect(
      { host: c.host, port: c.port }, ports, c.systemName,
      `"${c.systemName ?? c.host}" announced ${c.host}:${c.port} via mDNS but did not answer an RWS probe.`,
    );
  }
  if (status === 'unconfirmed') {
    const choice = await vscode.window.showWarningMessage(
      `${c.name ?? c.host}:${c.port} may not be an ABB controller.`,
      {
        modal: true,
        detail: `It asks for a login, but its challenge names "${c.realm ?? 'no realm'}" instead of `
          + 'the realm ABB controllers send ("validusers@robapi.abb"). Add it only if you know it is your controller.',
      },
      'Add Anyway',
    );
    if (choice !== 'Add Anyway') { return undefined; }
  }
  return selectionFor(c);
}

/**
 * Probe one address (cancellable; a remote host gets HTTPS first, HTTP only where HTTPS finds an
 * open port that is not TLS) and turn the answer into a selection. When nothing answers, the
 * user may still add it with a scheme they choose; nothing is guessed for them.
 */
async function probeAndSelect(
  target: ManualTarget,
  ports: number[],
  suggestedName?: string,
  noAnswerText?: string,
): Promise<SelectedController | undefined> {
  const r = await runDiscoveryScan(
    `Probing ${targetLabel(target)}…`,
    targetScanOptions({ manual: [target] }, ports, { strictTls: strictTlsSetting() }),
  );
  if (!r) { return undefined; }
  const withName = (s: SelectedController | undefined): SelectedController | undefined =>
    s && suggestedName && !s.suggestedName ? { ...s, suggestedName } : s;

  const rows = controllerRows(r.controllers).filter(row => row.status !== 'announced');
  if (rows.length === 1) { return withName(await selectFoundController(rows[0].controller, ports)); }
  if (rows.length > 1) {
    const pick = await vscode.window.showQuickPick(
      rows.map(row => ({ label: row.label, description: row.description, detail: row.detail, row })),
      { title: `Controllers at ${target.host} - ${rows.length} found`, placeHolder: 'Select a controller to add', matchOnDescription: true },
    );
    return pick ? withName(await selectFoundController(pick.row.controller, ports)) : undefined;
  }
  if (r.aborted) { return undefined; }

  const host = /^localhost\.?$/i.test(target.host) ? '127.0.0.1' : target.host;
  // The client's notes say why when a name did not resolve (or resolved to IPv6 only).
  const certNote = (r.tlsFailures.length > 0 ? '\nIts certificate is not trusted (abbRobot.strictTls is on).' : '')
    + r.notes.map(n => `\n${n}`).join('');
  if (target.port === undefined) {
    const retry = await vscode.window.showWarningMessage(
      `No RWS controller found at ${target.host}.\nController may be offline or RWS may not be enabled.${certNote}`,
      'Add Anyway (port 80, HTTP)', 'Add Anyway (port 443, HTTPS)', 'Show Guide',
    );
    if (retry === 'Add Anyway (port 80, HTTP)') {
      return withName({ host, port: 80, useHttps: false, authType: 'digest' });
    }
    if (retry === 'Add Anyway (port 443, HTTPS)') {
      return withName({ host, port: 443, useHttps: true, authType: 'basic' });
    }
    if (retry === 'Show Guide') { void showConnectionGuide(); }
    return undefined;
  }
  const fallback = await vscode.window.showWarningMessage(
    `${noAnswerText ?? `No RWS response from ${targetLabel(target)}.`}${certNote}\nAdd anyway with the scheme you choose?`,
    'Add as RWS 1.0 (HTTP/Digest)', 'Add as RWS 2.0 (HTTPS/Basic)',
  );
  if (fallback === 'Add as RWS 1.0 (HTTP/Digest)') {
    return withName({ host, port: target.port, useHttps: false, authType: 'digest' });
  }
  if (fallback === 'Add as RWS 2.0 (HTTPS/Basic)') {
    return withName({ host, port: target.port, useHttps: true, authType: 'basic' });
  }
  return undefined;
}

/** "Enter address manually": probe one typed address now, without saving it. */
async function enterAddressManually(ports: number[]): Promise<SelectedController | undefined> {
  const text = await vscode.window.showInputBox({
    title:         'Enter controller IP address or hostname',
    prompt:        'IP address, host name, or host:port. Probed once, not saved (use "Add address / range…" to keep it).',
    value:         SERVICE_ADDRESS,
    validateInput: v => {
      const p = parseAddressInput(v);
      if (p.kind === 'invalid') { return p.reason; }
      if (p.kind === 'range') { return 'This is a range: use "Add address / range…" to save and scan it.'; }
      return undefined;
    },
  });
  if (!text) { return undefined; }
  const entry = parseAddressInput(text);
  if (entry.kind !== 'host') { return undefined; }
  return probeAndSelect(toTarget(entry), ports);
}

/**
 * "Add address / range": save an address, host:port or range for later scans
 * (`abbRobot.discoveryManual` / `abbRobot.discoveryRanges`). Returns the saved entry (also when
 * it was saved already), or undefined when cancelled or the list is full.
 */
async function addAddressOrRange(settings: DiscoverySettings): Promise<Exclude<ParsedAddress, { kind: 'invalid' }> | undefined> {
  const text = await vscode.window.showInputBox({
    title:         'Add address / range',
    prompt:        'Saved for later Add Robot scans: an IP address or host name, host:port, a CIDR range '
      + '(10.0.5.0/24) or a dash range (10.0.5.20-10.0.5.60). A range is scanned only when you pick it, and you are asked first every time.',
    placeHolder:   '10.0.5.20   robot1.example.com:443   10.0.5.0/24',
    validateInput: v => {
      const p = parseAddressInput(v);
      if (p.kind === 'invalid') { return p.reason; }
      if (p.kind === 'range') { return rangeProblem(p); }
      return undefined;
    },
  });
  if (!text) { return undefined; }
  const entry = parseAddressInput(text);
  if (entry.kind === 'invalid' || (entry.kind === 'range' && rangeProblem(entry))) { return undefined; }
  const next = withSavedEntry(settings, entry);
  if (next.full) {
    const what = entry.kind === 'host' ? `${MAX_SAVED_ADDRESSES} saved addresses` : `${MAX_SAVED_RANGES} saved ranges`;
    const choice = await vscode.window.showWarningMessage(
      `At most ${what}. Remove one first: the trash button next to it in the Add Robot list, or Manage Saved Addresses and Ranges.`,
      'Manage Saved Addresses and Ranges',
    );
    if (choice) { await manageSavedEntries(); }
    return undefined;
  }
  if (next.added) { await saveDiscoveryTargets(next.manual, next.ranges); }
  return entry;
}

/** "Scan again with options…": what to scan besides this PC, which is always scanned. */
async function pickScanOptions(choice: ScanChoice, settings: DiscoverySettings): Promise<ScanChoice | undefined> {
  type OptionItem = vscode.QuickPickItem & { option: 'service' | 'mdns' | 'saved' | 'range'; range?: string };
  const items: OptionItem[] = [
    {
      label:  `Robot on the service port (${SERVICE_ADDRESS})`,
      detail: 'When not ticked, probed only if this PC has an address in 192.168.125.0/24',
      picked: choice.serviceAddress,
      option: 'service',
    },
    {
      label:  'mDNS announcements',
      detail: 'One multicast query on each IPv4 network interface; lists controllers that announce themselves',
      picked: choice.mdns,
      option: 'mdns',
    },
  ];
  if (settings.manual.length > 0) {
    items.push({
      label:  `Saved addresses (${settings.manual.length})`,
      detail: settings.manual.map(targetLabel).join(', '),
      picked: choice.savedAddresses,
      option: 'saved',
    });
  }
  for (const range of settings.ranges) {
    const n = rangeAddressCount(range) ?? 0;
    items.push({
      label:       `Range ${range}`,
      description: `${n} address${n === 1 ? '' : 'es'}`,
      detail:      'Asks before scanning. IT can see the connection attempts on a company network.',
      picked:      choice.ranges.includes(range),
      option:      'range',
      range,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title:       'Scan again - this PC is always scanned',
    placeHolder: 'Tick what to scan besides this PC',
  });
  if (!picked) { return undefined; }
  return {
    serviceAddress: picked.some(p => p.option === 'service'),
    mdns:           picked.some(p => p.option === 'mdns'),
    savedAddresses: settings.manual.length > 0 ? picked.some(p => p.option === 'saved') : choice.savedAddresses,
    ranges:         picked.filter(p => p.option === 'range' && p.range).map(p => p.range as string),
  };
}

/**
 * Final phases of the add-robot flow: collect credentials and display name,
 * persist the config (password goes to SecretStorage, never to settings),
 * then offer to connect. The factory credentials are pre-filled only for a
 * controller on this PC (a RobotStudio VC), never for another machine.
 */
async function finishAddRobot(
  multi: MultiRobotManager,
  secrets: vscode.SecretStorage,
  selected: SelectedController,
): Promise<void> {
  const onThisPc = isLocalAddress(selected.host);
  const defaults = credentialDefaults(onThisPc, selected.authType);
  const username = await vscode.window.showInputBox({
    title: 'Add Robot - Credentials (1/2)',
    prompt: 'RWS username',
    value: defaults.username,
    placeHolder: onThisPc ? undefined : 'A user on the controller',
    validateInput: v => v.trim() ? undefined : 'Required',
  });
  if (!username) { return; }

  const password = await vscode.window.showInputBox({
    title: 'Add Robot - Credentials (2/2)',
    prompt: 'RWS password',
    value: defaults.password,
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
  // The robot is listed here, then saved; a failed save takes it out again, with its password.
  try {
    await changeSavedRobots({ kind: 'add', robot: storedEntryOf(config) }, {
      inMemory: {
        apply: async () => {
          await storePasswordSecret(secrets, config.id, password);
          multi.addRobot(config);
        },
        undo: async () => {
          multi.removeRobot(config.id);
          await secrets.delete(passwordSecretKey(config.id));
        },
      },
    });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    Logger.warn(`could not save the robot list after adding ${config.id}: ${text}`);
    void vscode.window.showErrorMessage(`"${config.name}" was not added: could not save the robot list: ${text}`);
    return;
  }

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
 * Map an mDNS hit onto connection parameters by probing the announced address. The
 * announcement's protocol is only a hint and is never used as the scheme: if the probe gets no
 * answer, the user chooses the scheme.
 */
async function resolveMdnsPick(c: MdnsController): Promise<SelectedController | undefined> {
  return probeAndSelect(
    { host: c.host, port: c.port }, [], c.systemName,
    `"${c.systemName}" announced ${c.host}:${c.port} via mDNS but did not answer an RWS probe.`,
  );
}

/** Build a sensible default name from discovered controller info. */
function buildDefaultName(p: DiscoveredController): string {
  const type = p.authType === 'basic' ? 'OmniCore' : 'IRC5';
  const local = isLocalAddress(p.host) ? 'VC ' : '';
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

### OmniCore controllers (RobotWare 7.x / 8.x - RWS 2.0)
- **Enable RWS first** (one-time setup):
  \`FlexPendant → ☰ Menu → Configuration → Communication → Firewall Manager\`
  → enable **RobotWebServices** → restart controller.
- **Direct service cable**: same XS7 port. Default IP: \`192.168.125.1\`, port \`443\`, HTTPS.
- Authentication: HTTP Basic (same default credentials).
- **Network option**: public/WAN access requires paid option 3119-1 "RobotStudio Connect".

### RobotStudio Virtual Controllers
- RobotStudio picks the RWS port each time a virtual controller starts. The Add Robot scan
  reads this PC's listening ports, so it finds the VC whatever port it got.
- Find the exact port in RobotStudio: \`Controller → Properties → Communication\`, then use
  "Enter address manually" with \`127.0.0.1:<port>\`.

## Default credentials
| Field    | Default value   |
|----------|-----------------|
| Username | \`Admin\` |
| Password | \`robotics\`     |

The wizard fills these in only for a virtual controller on this PC. For a controller on
another machine, enter a user that exists on that controller.

## What the Add Robot scan probes
- **This PC**: the ports RobotStudio virtual controllers listen on, read from the operating
  system (read-only) and probed on 127.0.0.1. Nothing leaves this PC.
- **Service port address \`192.168.125.1\`**: when this PC has an address in 192.168.125.0/24,
  or when "Robot on the service port" is ticked in "Scan again with options…".
- **mDNS**: one multicast query on each IPv4 network interface, VPN adapters included,
  repeated twice in the first second.
- **Saved addresses** (\`abbRobot.discoveryManual\`) every time, and **saved ranges**
  (\`abbRobot.discoveryRanges\`) only when you pick them. A saved host name also costs one
  DNS lookup, which goes to the configured DNS server.

Another machine (the service port address, or a saved address or range address without a
port) gets these probes, each a single \`GET /rw/system\` without credentials:

| Port | Scheme | Used by |
|------|--------|---------|
| 443  | HTTPS  | OmniCore real controller (standard) |
| 80   | HTTPS  | RobotWare 8.1 virtual controllers serve HTTPS on 80 |
| 80   | HTTP   | IRC5 real controller (standard); tried only when 80 is open but not TLS |
| extra | HTTPS, then HTTP | ports in \`abbRobot.discoveryPorts\` |

A saved address with a port gets that port only. On this PC (127.0.0.1) without a port the
scan also tries the virtual-controller ports 5466, 9403, 9805, 11622 (HTTPS) and 11811,
28447 (HTTP).

## Ranges
"Add address / range…" saves a CIDR range (\`10.0.5.0/24\`) or a dash range
(\`10.0.5.20-10.0.5.60\`): private addresses only, at most 256 addresses per scan.
Scanning a range opens TCP connections to every address in it. On a company network IT can
see these attempts, and intrusion detection may flag them. The extension asks before every
range scan. Each address gets up to 3 connection attempts (443, 80 over TLS, 80 over HTTP),
plus up to 2 per extra port, at most 10 new connections per second; a /24 takes a minute or more.

## Remote windows
In a Remote - WSL, SSH or Dev Containers window the scan runs on the remote side and cannot see
virtual controllers on your PC. Use a local window, or enter the address manually.

If your controller uses a different port, use "Enter address manually" and type \`ip:port\`
(e.g. \`192.168.1.50:8080\`).
`;
  const doc = await vscode.workspace.openTextDocument({ content: guide, language: 'markdown' });
  vscode.window.showTextDocument(doc, { preview: true });
}

// ─── Settings helpers ────────────────────────────────────────────────────────

/**
 * A robot's config from its settings entry and SecretStorage. The password comes from
 * SecretStorage first ('abbRobot.password/<robotId>'); a plaintext password
 * still sitting in the setting is only a fallback (pre-migration installs, or
 * settings synced from a machine whose secrets don't travel with Settings
 * Sync). If SecretStorage is unavailable, the settings value is used as-is -
 * activation must never crash over a locked keychain.
 */
async function configOf(entry: StoredRobot, secrets: vscode.SecretStorage): Promise<RobotConfig> {
  let password = typeof entry.password === 'string' ? entry.password : '';
  try {
    const secret = await secrets.get(passwordSecretKey(entry.id));
    if (secret !== undefined) { password = secret; }
  } catch (e) {
    Logger.warn(`secure storage unavailable while loading "${String(entry.name)}" - using settings password: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ...(entry as unknown as RobotConfig), password };
}

/**
 * Build RobotConfigs from settings + SecretStorage (see `configOf`). Legacy single-robot
 * settings the activation could not move (migrateLegacyRobot) stand in for an empty list for
 * this session. Only a host the user set counts, never the schema default.
 */
async function loadConfigs(cfg: vscode.WorkspaceConfiguration, secrets: vscode.SecretStorage): Promise<RobotConfig[]> {
  const { robots, legacy } = inspectRobotSettings(cfg);
  const configs: RobotConfig[] = [];
  for (const entry of savedRobots(robots, legacy)) {
    configs.push(await configOf(entry, secrets));
  }
  return configs;
}

/**
 * Move plaintext passwords out of the `abbRobot.robots` setting (which Settings Sync uploads)
 * into SecretStorage (movePasswordsToSecrets). The password property stays in the settings
 * schema for backward compat, but any value found there is stored as a secret and removed from
 * the settings, in the user and the workspace settings alike. Runs on activation and on each
 * change of the setting, and writes nothing once the settings are clean. Returns how many
 * passwords moved.
 */
function migratePasswordsToSecrets(secrets: vscode.SecretStorage): Promise<number> {
  return movePasswordsToSecrets(robotSettingsStore, (id, password) => Promise.resolve(secrets.store(passwordSecretKey(id), password)));
}

/** `abbRobot.robots` and the legacy single-robot settings, in the scopes the extension writes. */
function inspectRobotSettings(cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('abbRobot')): {
  robots: ScopedValue<unknown>; legacy: Record<LegacyRobotKey, ScopedValue<unknown>>;
} {
  const scoped = (key: string): ScopedValue<unknown> => {
    const i = cfg.inspect<unknown>(key);
    return { global: i?.globalValue, workspace: i?.workspaceValue };
  };
  const legacy = Object.fromEntries(LEGACY_ROBOT_KEYS.map(k => [k, scoped(k)])) as Record<LegacyRobotKey, ScopedValue<unknown>>;
  return { robots: scoped('robots'), legacy };
}

/** Apply settings writes in order; the first failure stops the rest and is thrown. */
async function applySettingsWrites(writes: SettingsWrite[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('abbRobot');
  for (const w of writes) {
    await cfg.update(w.key, w.value, SAVED_SCOPE_TARGET[w.scope]);
  }
}

/** The robot settings as saves and applies read them: a fresh read each time, then VS Code's writes. */
const robotSettingsStore: RobotSettingsStore = {
  read: () => inspectRobotSettings(),
  write: applySettingsWrites,
};

/**
 * Once, on activation: legacy single-robot settings (abbRobot.host/username/password) become
 * robot "default" in abbRobot.robots, with its password in SecretStorage, and the legacy
 * settings are removed from every scope that sets them. The password is stored first and the
 * legacy settings are removed last, so a failure part-way loses nothing (loadConfigs still
 * reads them). Returns whether a robot was moved.
 */
async function migrateLegacyRobot(secrets: vscode.SecretStorage): Promise<boolean> {
  const { robots, legacy } = inspectRobotSettings();
  const plan = legacyMigrationWrites(robots, legacy);
  if (!plan.robot) { return false; }
  await secrets.store(passwordSecretKey(plan.robot.entry.id), plan.robot.password);
  await applySettingsWrites(plan.writes);
  return true;
}

/** A robot as `abbRobot.robots` stores it: its config without the password. */
function storedEntryOf(config: RobotConfig): StoredRobot {
  const { password: _password, ...rest } = config;
  return { ...rest };
}

/**
 * One change to the saved robot list (saveRobotEdit): the in-memory step makes it to this
 * window's robots, then the settings get it, and `afterWrite` runs once they have it. The stored
 * list is read again just before the write and only this robot's entry changes, so a robot that
 * another window, a hand edit or Settings Sync added, changed or removed since this window read
 * the list stays as the settings have it now. A failed write undoes the in-memory step and is
 * thrown, so memory and settings still agree. Passwords never go into settings (Settings Sync
 * would upload them in plaintext) - they live in SecretStorage, keyed by robot id. The list
 * goes to the scope it is read from: a workspace list overrides the user one. Runs in turn with
 * the other saves and with applying outside changes (robotListSync). Returns whether the edit's
 * robot was in the stored list: a patch of a robot removed elsewhere changes nothing, here or
 * in the settings (applying that removal drops the robot here).
 */
async function changeSavedRobots(edit: RobotListEdit, steps: SaveSteps = {}): Promise<boolean> {
  const id = edit.kind === 'add' ? edit.robot.id : edit.id;
  const save = async (): Promise<boolean> => {
    const result = await saveRobotEdit(robotSettingsStore, edit, {
      onUndoError: e => Logger.warn(`could not take back the change to robot ${id} after a failed save: ${e instanceof Error ? e.message : String(e)}`),
      ...steps,
    });
    if (result.written) {
      warnDuplicateRobotNames(robotEntries(result.written).map(r => ({ name: typeof r.name === 'string' ? r.name : '' })));
    }
    return result.found;
  };
  return robotListSync ? robotListSync.run(save) : save();
}

/** The robots a Connect (or its different-system question) is running for: one at a time per robot. */
const connectsInFlight = new Set<string>();
/** The user and password each manager's session logged in with (Connect sets it). */
const sessionLogins = new WeakMap<RobotManager, { username: string; password: string }>();
/** Sessions whose system id was not read when Connect ended: checked against the record once it is. */
const unverifiedSessions = new Map<string, { manager: RobotManager; last: LastSeen }>();

/** The robot's session, as planConnect reads it. */
function sessionOf(entry: { config: RobotConfig; manager: RobotManager }): SessionNow {
  const login = sessionLogins.get(entry.manager);
  return {
    connected: entry.manager.state.connected,
    host: entry.manager.state.host,
    port: entry.manager.currentPort,
    sameLogin: !!login && login.username === entry.config.username && login.password === entry.config.password,
  };
}

/**
 * The steps planConnect runs: probes and a scan of this PC without credentials, and the
 * moved-port question as a modal.
 */
function connectPlanSteps(
  progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, strictTls: boolean,
): PlanSteps {
  return {
    isLocal: isLocalAddress,
    answers: async (host, port) => (await RobotManager.probeSpecificPort(host, port, strictTls)) !== null,
    find: async () => {
      const r = await RobotManager.findControllers({ local: true, identify: 'anonymous', filterToVcProcesses: false, strictTls });
      return { controllers: r.controllers, notes: r.notes };
    },
    ask: async q => {
      const pick = await vscode.window.showWarningMessage(q.message, { modal: true, detail: q.detail }, ...q.choices.map(c => c.label));
      return q.choices.find(c => c.label === pick)?.controller;
    },
    cancelled: () => token.isCancellationRequested,
    report: message => progress.report({ message }),
  };
}

/** This window's robots, as applying a stored change reads and changes them. */
function robotsInMemory(multi: MultiRobotManager, secrets: vscode.SecretStorage): RobotsInMemory {
  return {
    configs: () => multi.configs,
    connected: id => multi.entries.find(e => e.id === id)?.manager.state.connected === true,
    disconnect: async id => { await endConnection(multi, id); },
    remove: id => { void endConnection(multi, id, 'remove'); },
    update: (id, fields) => multi.updateConfig(id, fields as Partial<Omit<RobotConfig, 'id'>>),
    add: async entry => multi.addRobot(await configOf(entry, secrets)),
  };
}

const APPLY_STEP_TEXT: Record<'disconnect' | 'update' | 'add', string> = {
  disconnect: 'disconnect robot %s before dropping it',
  update:     'apply the changed settings of robot %s',
  add:        'add robot %s from the settings',
};

/**
 * Apply the stored robot list to this window's robots, by id, after `abbRobot.robots` changed:
 * in another window, by a hand edit, through Settings Sync, or by this window's own save (whose
 * echo finds nothing to do). A new robot is added with its password from SecretStorage; a
 * changed one gets the stored fields; a robot the list no longer has is disconnected and
 * dropped (applyStoredList). A connected robot whose saved address or user changed stays on the
 * controller it is connected to until it reconnects: the dialogs name the session's address,
 * and a message offers Reconnect. A dropped robot's saved password stays: the window that
 * removed it deletes it, and a list moved between user and workspace settings keeps it. A
 * plaintext password written into the setting moves to SecretStorage first, as on activation.
 */
async function applyStoredRobots(multi: MultiRobotManager, secrets: vscode.SecretStorage): Promise<void> {
  const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  try {
    const moved = await migratePasswordsToSecrets(secrets);
    if (moved > 0) { Logger.info(`moved ${moved} robot password(s) from the abbRobot.robots setting into secure storage`); }
  } catch (e) {
    Logger.warn(`password migration to secure storage failed - passwords stay in settings for now: ${text(e)}`);
  }
  const result = await applyStoredList(robotSettingsStore, robotsInMemory(multi, secrets));
  for (const { id, step, error } of result.failed) {
    Logger.warn(`could not ${APPLY_STEP_TEXT[step].replace('%s', id)}: ${text(error)}`);
  }
  for (const { name } of result.removedWhileConnected) {
    void vscode.window.showInformationMessage(`"${name}" was removed from the saved robots outside this window, so it was disconnected here.`);
  }
  for (const { id, fields } of result.changedWhileConnected) {
    const entry = multi.entries.find(e => e.id === id);
    if (!entry) { continue; }
    const what = [fields.some(f => f !== 'username') ? 'address' : undefined, fields.includes('username') ? 'user' : undefined]
      .filter(Boolean).join(' and ');
    const saved = addressText(entry.config.host, entry.config.port) + (fields.includes('username') ? `, user ${entry.config.username}` : '');
    const session = addressText(entry.manager.state.host, entry.manager.currentPort);
    void vscode.window.showInformationMessage(
      `"${entry.config.name}": its saved ${what} changed outside this window (now ${saved}). It stays connected to ${session} until it reconnects.`,
      'Reconnect',
    ).then(choice => { if (choice === 'Reconnect') { void vscode.commands.executeCommand('abbRobot.connectRobot', id); } });
  }
  const { change } = result;
  if (change.add.length + change.update.length + change.remove.length > 0) {
    Logger.info(`abbRobot.robots changed outside this window: ${change.add.length} robot(s) added, ${change.update.length} changed, ${change.remove.length} removed`);
  }
}

/** Two robots with one name read the same in every dialog: warn, never block. */
function warnDuplicateRobotNames(configs: ReadonlyArray<{ name: string }>): void {
  const dups = duplicateRobotNames(configs);
  const key = dups.join('|');
  if (key && key !== lastDuplicateWarning) {
    void vscode.window.showWarningMessage(`More than one saved robot is named ${dups.map(n => '"' + n + '"').join(', ')}. Confirmations show the host too, but give each robot its own name so they are easy to tell apart.`);
  }
  lastDuplicateWarning = key;
}
let lastDuplicateWarning = '';

/** Extract a robot id from a command argument that may be a string id, a TreeItem (passed by view/item/context menus), or undefined. */

/** Ask which saved robot. Undefined when there is none or the user cancels. */
async function pickSavedRobot(multi: MultiRobotManager, title: string, placeHolder: string): Promise<string | undefined> {
  const entries = multi.entries;
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('There are no saved robots.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    entries.map(({ id, config, manager }) => ({
      label:       config.name,
      description: `${config.host}${config.port !== undefined ? `:${config.port}` : ''}`,
      detail:      [id === multi.activeId ? 'active' : undefined, manager.state.connected ? 'connected' : 'offline']
        .filter(Boolean).join(' · '),
      id,
    })),
    { title, placeHolder, matchOnDescription: true },
  );
  return pick?.id;
}

// ─── Activate ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Install our VS Code-backed logger into abb-rws-client (RobotManager,
  // RwsClient, RwsClient2 - including HTTP req/res tracing - all use this).
  // The client's unchecked-certificate warning also names abbRobot.strictTls
  // (strictTlsHint.ts).
  setLogger({
    info:  (msg)        => Logger.info(msg),
    warn:  (msg)        => Logger.warn(withStrictTlsHint(msg)),
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
  // Legacy single-robot settings become a saved robot once, then are removed. A failure leaves
  // them as they are; loadConfigs reads them for this session and the move is retried next time.
  try {
    if (await migrateLegacyRobot(context.secrets)) {
      Logger.info('moved the legacy abbRobot.host/username/password settings into abbRobot.robots and secure storage');
    }
  } catch (e) {
    Logger.warn(`moving the legacy single-robot settings failed - they stay for now: ${e instanceof Error ? e.message : String(e)}`);
  }

  const cfg   = vscode.workspace.getConfiguration('abbRobot');
  // Schema minimum is 200 but settings.json edits bypass UI validation - clamp here too.
  const refreshIntervalMs = Math.max(200, cfg.get<number>('refreshInterval', 1000));
  // TLS verification stays off unless opted in - controllers ship self-signed certs.
  const strictTls = cfg.get<boolean>('strictTls', false);
  const multi = MultiRobotManager.fromConfigs(await loadConfigs(cfg, context.secrets), { refreshIntervalMs, strictTls });
  globalMulti = multi;

  // The saved robot list is shared with other windows, hand edits and Settings Sync: a change
  // of abbRobot.robots is applied here by robot id, in turn with this window's own saves (whose
  // echo finds nothing to do), and a password another window stores is used from the robot's
  // next connect. Once now as well, for a change made while the list loaded.
  const sync = new RobotListSync(
    () => applyStoredRobots(multi, context.secrets),
    e => Logger.warn(`could not apply the changed robot list: ${e instanceof Error ? e.message : String(e)}`),
  );
  robotListSync = sync;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('abbRobot.robots')) { sync.changed(); }
    }),
    context.secrets.onDidChange(async e => {
      const id = robotIdOfPasswordKey(e.key);
      const config = id === undefined ? undefined : multi.configs.find(c => c.id === id);
      if (!id || !config) { return; }
      try {
        const secret = await context.secrets.get(e.key);
        if (secret !== undefined && secret !== config.password) { multi.updateConfig(id, { password: secret }); }
      } catch (err) {
        Logger.warn(`could not read the changed password of robot ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  sync.changed();

  // Route RobotManager errors (3 failed polls → auto-disconnect) through VS Code dialogs, robot
  // by robot (current robots here, later ones and replaced managers from onRobotChanged).
  // Reconnect runs Connect for that robot, so a port that moved meanwhile is asked about first
  // (planConnect); the client's own reconnect would look for it without asking.
  const errorsWired = new WeakSet<RobotManager>();
  const wireErrors = (id: string, manager: RobotManager): void => {
    if (errorsWired.has(manager)) { return; }
    errorsWired.add(manager);
    manager.onError(async (msg, actions) => {
      const choice = await vscode.window.showErrorMessage(msg, ...actions);
      if (choice !== 'Reconnect') { return choice; }
      void vscode.commands.executeCommand('abbRobot.connectRobot', id);
      return undefined;
    });
  };
  for (const { id, manager } of multi.entries) { wireErrors(id, manager); }
  // The system a robot connected to, recorded on this PC: the moved-port question names it, and
  // Connect compares the next connection's system with it.
  const recordLastSeen = async (id: string, reading: SystemReading | null | undefined): Promise<void> => {
    const seen = withLastSeen(context.globalState.get<Record<string, LastSeen>>(LAST_SEEN_KEY), id, reading);
    if (!seen) { return; }
    try { await context.globalState.update(LAST_SEEN_KEY, seen); }
    catch (e) { Logger.warn(`could not record the system of robot ${id}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * The robot's address answered as another system than the one it last connected to:
   * disconnect, save nothing, and ask before that controller is kept as the robot. True on a yes
   * (the reading is then recorded, and the caller connects again).
   */
  const askDifferentSystem = async (id: string, reading: SystemReading, last: LastSeen): Promise<boolean> => {
    const entry = multi.entries.find(e => e.id === id);
    if (!entry) { return false; }
    const at = { name: entry.config.name, host: entry.manager.state.host || entry.config.host, port: entry.manager.currentPort };
    Logger.warn(`"${at.name}": ${addressText(at.host, at.port)} answers as system ${reading.sysid ?? '?'}, last connected to ${last.systemId} - disconnected, asking`);
    await endConnection(multi, id).catch(() => undefined);
    const q = differentSystemQuestion(at, reading, last);
    const pick = await vscode.window.showWarningMessage(q.message, { modal: true, detail: q.detail }, q.accept);
    if (pick !== q.accept) {
      Logger.info(`"${at.name}": the controller on ${addressText(at.host, at.port)} was not kept; it stays disconnected`);
      return false;
    }
    await recordLastSeen(id, reading);
    return true;
  };

  // A jog confirmation holds for one connection: it is forgotten when that robot disconnects.
  // While Connect runs for a robot, Connect records (or asks about) what it connected to. A
  // session whose system id was not read when Connect ended is checked here once it is.
  multi.onRobotChanged(id => {
    const entry = multi.entries.find(e => e.id === id);
    if (entry) { wireErrors(id, entry.manager); }
    // A failed withdrawal held back while the session was unsettled (the client's own
    // disconnect after failed polls withdraws before its state reads disconnected): its
    // notice once the session settled, before the tracker forgets the robot.
    const settled = motionTracker.settle(id, entry ? sessionNow(entry.manager.state) : undefined);
    if (settled) { showMotionNotice(id, settled); }
    // Motion control allowed here counts for one connection: forgotten when it ended. A
    // removed robot (no entry) keeps it until its disconnect, which waits for the withdrawal.
    if (entry && !entry.manager.state.connected) { motionTracker.clear(id); }
    if (!entry?.manager.state.connected) { jogConfirmed.delete(id); unverifiedSessions.delete(id); return; }
    if (connectsInFlight.has(id)) { return; }
    const reading = entry.manager.state.systemInfo;
    const pending = unverifiedSessions.get(id);
    if (pending && pending.manager !== entry.manager) { unverifiedSessions.delete(id); }
    else if (pending) {
      const verdict = identityVerdict(pending.last, reading);
      if (verdict === 'unknown') { return; }
      unverifiedSessions.delete(id);
      if (verdict === 'different' && reading) {
        void onceAtATime(connectsInFlight, id, () => askDifferentSystem(id, reading, pending.last)).then(again => {
          if (again) { void vscode.commands.executeCommand('abbRobot.connectRobot', id); }
        });
        return;
      }
    }
    void recordLastSeen(id, reading);
  });

  // Only this robot's port and HTTPS flag change in the stored list. The connect already put
  // them in memory; a failed save puts the saved ones back there, so memory matches the settings
  // (the session stays on the port it connected to, and the dialogs name that one).
  const saveConnectedPort = async (id: string, name: string, saved: PortOf, now: { port: number; useHttps?: boolean }): Promise<void> => {
    try {
      const done = await changeSavedRobots({ kind: 'patch', id, fields: { port: now.port, useHttps: now.useHttps } }, {
        inMemory: {
          apply: () => undefined,
          undo: () => multi.updateConfig(id, { port: saved.port, useHttps: saved.useHttps }),
        },
      });
      if (done) {
        vscode.window.showInformationMessage(`Port for "${name}" updated to ${now.port} (was ${saved.port ?? 'auto'}).`);
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      Logger.warn(`could not save the new port of ${id}: ${text}`);
      void vscode.window.showWarningMessage(`Connected to "${name}" on port ${now.port}, but the new port could not be saved: ${text}`);
    }
  };

  /**
   * One Connect for a robot: planConnect decides before anything is sent with its user and
   * password, connectWithRetries connects, settleConnect decides what stays (portRecovery.ts).
   * Returns what to show once it ended, or `again` when the person kept another controller as
   * the robot (the caller connects again).
   */
  const connectOnce = async (id: string): Promise<{ again?: boolean; error?: unknown; message?: string }> => {
    const start = multi.entries.find(e => e.id === id);
    if (!start) { return {}; }
    const name = start.config.name;
    const saved: PortOf = { port: start.config.port, useHttps: start.config.useHttps };
    const last = context.globalState.get<Record<string, LastSeen>>(LAST_SEEN_KEY)?.[id];
    // Set inside the progress callback (casts keep TypeScript from narrowing them to the initial value).
    let plan = { kind: 'stop', why: 'cancelled' } as ConnectPlan;
    let result = { kind: 'cancelled' } as AttemptResult;
    let asked: PortOf = saved;
    let local = false as boolean;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${start.config.host}…`, cancellable: true },
        async (progress, token) => {
          const entry = multi.entries.find(e => e.id === id);
          if (!entry) { return; }
          plan = await planConnect(entry.config, sessionOf(entry), last, connectPlanSteps(progress, token, strictTls));
          if (plan.kind === 'stop') { return; }
          if (plan.kind !== 'keep') {
            if (plan.kind === 'chosen') { Logger.info(`"${name}": port ${saved.port} answers nothing; connecting to port ${plan.port}, as chosen`); }
            // A fresh manager has read no system id: the client has nothing to compare a
            // controller with, so it does not log in to other controllers to look for one.
            // addRobot with the robot's own id replaces its manager in place: the list keeps its order.
            await endConnection(multi, id).catch(() => undefined);
            multi.addRobot({ ...entry.config, ...(plan.kind === 'chosen' ? { port: plan.port, useHttps: plan.useHttps } : {}) });
          }
          result = await connectWithRetries({
            connect: async () => {
              const now = multi.entries.find(e => e.id === id);
              if (!now) { throw new Error(`robot "${name}" is no longer in the list`); }
              asked = { port: now.config.port, useHttps: now.config.useHttps };
              local = isLocalAddress(now.config.host);
              const login = { username: now.config.username, password: now.config.password };
              await multi.connectRobot(id);
              if (now.manager.state.connected) { sessionLogins.set(now.manager, login); }
            },
            // On this PC the address is probed again before a busy retry: a controller that
            // no longer answered meanwhile ends the retries before its user and password go anywhere else.
            answers: async () => {
              const now = multi.configs.find(c => c.id === id);
              if (!now || now.port === undefined || !isLocalAddress(now.host)) { return true; }
              return (await RobotManager.probeSpecificPort(now.host, now.port, strictTls)) !== null;
            },
            cancelled: () => token.isCancellationRequested,
            wait: ms => new Promise(r => setTimeout(r, ms)),
            report: message => progress.report({ message }),
          });
        },
      );
    } catch (e: unknown) {
      // Before the plan nothing changed; after it, what the connect left is settled below.
      if (plan.kind === 'stop') { return { error: e }; }
      result = { kind: 'failed', error: e };
    }

    if (plan.kind === 'stop') {
      if (plan.why === 'declined') {
        Logger.info(`"${name}": port ${saved.port} answers nothing; no controller found on this PC was chosen, nothing sent`);
      }
      if (!plan.message) { return {}; }
      Logger.warn(plan.message);
      const entry = multi.entries.find(e => e.id === id);
      const still = entry?.manager.state.connected
        ? ` It stays connected to ${addressText(entry.manager.state.host, entry.manager.currentPort)}.` : '';
      return { message: plan.message + still };
    }

    const entry = multi.entries.find(e => e.id === id);
    if (!entry) { return {}; }
    const outcome = settleConnect({
      plan, local, saved, asked,
      memory: { port: entry.config.port, useHttps: entry.config.useHttps },
      connected: entry.manager.state.connected,
      currentPort: entry.manager.currentPort,
      reading: entry.manager.state.systemInfo,
      last,
    });
    switch (outcome.kind) {
      case 'not-connected':
        if (outcome.restore) { multi.updateConfig(id, outcome.restore); }
        break;
      case 'elsewhere': {
        await endConnection(multi, id).catch(() => undefined);
        if (outcome.restore) { multi.updateConfig(id, outcome.restore); }
        const message = elsewhereMessage({ name, host: entry.config.host }, asked.port, outcome.port);
        Logger.warn(message);
        return { message };
      }
      case 'different':
        if (outcome.restore) { multi.updateConfig(id, outcome.restore); }
        return { again: await askDifferentSystem(id, outcome.reading, last as LastSeen) };
      case 'save':
      case 'done':
        multi.setActive(id);
        if (outcome.record) { await recordLastSeen(id, entry.manager.state.systemInfo); }
        if (outcome.verifyLater && last) { unverifiedSessions.set(id, { manager: entry.manager, last }); }
        if (outcome.kind === 'save') { await saveConnectedPort(id, name, saved, outcome); }
        break;
    }
    if (result.kind === 'failed') { return { error: result.error }; }
    if (result.kind === 'gone') {
      const message = goneMessage({ name, host: entry.config.host, port: asked.port });
      Logger.warn(message);
      return { message };
    }
    return {};
  };

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
  const watchProvider   = new VariableWatchProvider(multi, context, { confirm, showError });
  const ctrlSrcProvider = new ControllerSourceProvider(multi);
  const robotsProvider  = new RobotsTreeProvider(multi, id => motionTracker.allowedHere(id));
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

    // RAPID hover provider - shows the signature and parameter types of built-in instructions,
    // functions and data types when hovering over an identifier in any .mod / .sys / .prg file.
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
  // RobotWare 8: motion control allowed, or not known after RAPID Live allowed it; hidden otherwise.
  const sbMotion = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  sbConn.text    = '$(circuit-board) ABB';
  sbConn.tooltip = 'ABB Robot - click to add a robot';
  sbConn.command = 'abbRobot.addRobot';
  sbConn.show();
  context.subscriptions.push(sbConn, sbMode, sbExec, sbMotion);

  // The client's motion-control events: a notice for a robot RAPID Live allowed it on.
  multi.onAccessEvent((id, event) => {
    const notice = noticeForEvent(motionTracker, id, event, multi.entries.find(e => e.id === id)?.manager.state);
    if (notice) { showMotionNotice(id, notice); }
  });

  // Refresh all views on any state change
  let lastSearchOwner = multi.activeId;
  let lastActive = multi.activeId;
  multi.onDidChange(() => {
    // A pinned signal search belongs to the robot it ran against - switching
    // the active robot (or losing it) would show A's results above B's tree
    // and route pinned toggles to the wrong controller.
    if (multi.activeId !== lastSearchOwner) {
      lastSearchOwner = multi.activeId;
      ioProvider.clearSearch();
    }
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

    // RobotWare 8 motion control, every robot at once (see statusBarFor): one robot whose
    // allowance may stand, named when it is not the active one; several, counted, and the
    // click asks which one to withdraw it on.
    const motion = motionEntries(multi);
    const bar = statusBarFor(motion, multi.activeId);
    if (bar) {
      sbMotion.text            = bar.text;
      sbMotion.tooltip         = bar.tooltip;
      sbMotion.command         = { title: 'Withdraw Motion Control', command: 'abbRobot.withdrawMotionControl', arguments: bar.robotId ? [bar.robotId] : [] };
      sbMotion.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      sbMotion.show();
    } else {
      sbMotion.hide();
    }
    const keys = motionContextKeys(motion, multi.activeId);
    vscode.commands.executeCommand('setContext', 'abbRobot.activeRw8', keys.activeRw8);
    vscode.commands.executeCommand('setContext', 'abbRobot.motionControlAllowed', keys.motionControlAllowed);
    vscode.commands.executeCommand('setContext', 'abbRobot.activeFixedStation', keys.activeFixedStation);
    vscode.commands.executeCommand('setContext', 'abbRobot.motionWithdrawable', keys.motionWithdrawable);

    // A robot switch: the robot that stopped being active, when the switch withdrawal is on.
    if (multi.activeId !== lastActive) {
      const fromId = lastActive;
      lastActive = multi.activeId;
      const from = multi.entries.find(e => e.id === fromId);
      if (from && withdrawOnSwitch({
        connected: from.manager.state.connected,
        generation: from.manager.state.access?.generation ?? null,
        allowed: from.manager.state.access?.rw8?.allowMotionControl ?? null,
        allowedHere: motionTracker.allowedHere(from.id),
      }, MOTION_CONTROL_SWITCH.withdrawOnSwitch)) {
        const toName = multi.entries.find(e => e.id === multi.activeId)?.config.name ?? 'another robot';
        void withdrawOnSwitchFor(from, toName);
      }
    }
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
      // The row's trash button and context menu pass the robot. From the palette (or with
      // anything that is not a saved robot) ask which one: never guess the active robot.
      const given = extractRobotId(arg);
      const id = given !== undefined && multi.configs.some(c => c.id === given)
        ? given
        : await pickSavedRobot(multi, 'Remove Robot', 'Select the robot to remove from the list');
      if (!id) { return; }
      const config = multi.configs.find(c => c.id === id);
      if (!config) { return; }
      const where = `${config.host}${config.port !== undefined ? `:${config.port}` : ''}`;
      const confirm = await vscode.window.showWarningMessage(
        `Remove "${config.name}" from the robot list?`,
        {
          modal: true,
          detail: `${where}. Disconnects it and deletes its saved password. Saved addresses and ranges for Add Robot stay.`,
        },
        'Remove',
      );
      if (confirm !== 'Remove') { return; }
      // Only this robot leaves the stored list (robotEditPlan), and legacy single-robot settings
      // go too: an emptied list would otherwise bring the legacy robot (and its plaintext
      // password) back on reload. The robot and its saved password go only once the settings
      // no longer list it: a failed save leaves both, so the robot is still there to remove.
      try {
        await changeSavedRobots({ kind: 'remove', id }, {
          afterWrite: async () => {
            // The robot leaves the lists at once; its disconnect is waited for (on RobotWare 8 it
            // withdraws a motion-control allowance first, and the notice says how that went).
            await endConnection(multi, id, 'remove').catch(() => undefined);
            try { await context.secrets.delete(passwordSecretKey(id)); }
            catch (e) { Logger.warn(`could not delete password secret for ${id}: ${e instanceof Error ? e.message : String(e)}`); }
            const seen = withoutLastSeen(context.globalState.get<Record<string, LastSeen>>(LAST_SEEN_KEY), id);
            if (seen) {
              try { await context.globalState.update(LAST_SEEN_KEY, seen); }
              catch (e) { Logger.warn(`could not forget the system of robot ${id}: ${e instanceof Error ? e.message : String(e)}`); }
            }
          },
        });
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        Logger.warn(`could not save the robot list after removing ${id}: ${text}`);
        void vscode.window.showErrorMessage(`"${config.name}" was not removed: could not save the robot list: ${text}`);
      }
    }),

    tracedCommand('abbRobot.manageSavedAddresses', async () => {
      await manageSavedEntries();
    }),

    tracedCommand('abbRobot.clearSavedAddresses', async () => {
      await clearSavedEntries();
    }),

    tracedCommand('abbRobot.setActiveRobot', (arg?: unknown) => {
      const id = extractRobotId(arg);
      if (id) { multi.setActive(id); }
    }),

    tracedCommand('abbRobot.connectRobot', async (arg?: unknown) => {
      // The row's own id first: with no active robot a row's Connect still works.
      const targetId = extractRobotId(arg) ?? multi.activeId ?? undefined;
      if (!targetId) {
        vscode.commands.executeCommand('abbRobot.addRobot');
        return;
      }
      const config = multi.configs.find(c => c.id === targetId);
      if (!config) { return; }

      // One Connect per robot at a time: a second one (a double click, Reconnect while the row's
      // Connect runs) shows no second question and changes nothing.
      const ended = await onceAtATime(connectsInFlight, targetId, () => connectOnce(targetId));
      if (!ended) {
        Logger.info(`Connect "${config.name}": a Connect for this robot is already running`);
        return;
      }
      if (ended.again) {
        void vscode.commands.executeCommand('abbRobot.connectRobot', targetId);
        return;
      }
      if (ended.message) { void vscode.window.showWarningMessage(ended.message); }
      if (ended.error !== undefined) {
        const lastError = ended.error;
        const msg = lastError instanceof Error ? lastError.message : String(lastError);
        const choice = await vscode.window.showErrorMessage(
          `Connect to "${config.name}" failed: ${msg}`,
          'Show Logs', 'Edit Robot…',
        );
        if (choice === 'Show Logs')   { vscode.commands.executeCommand('abbRobot.showLogs'); }
        if (choice === 'Edit Robot…') { vscode.commands.executeCommand('abbRobot.configure', targetId); }
      }
    }),

    tracedCommand('abbRobot.disconnectRobot', async (arg?: unknown) => {
      const targetId = extractRobotId(arg) ?? multi.activeId ?? undefined;
      if (!targetId) { return; }
      // When the client's withdrawal gave a notice ("Disconnected <name>. Motion control was
      // withdrawn first.", or the warning that it did not go through), that notice says it;
      // otherwise this message does.
      const message = disconnectMessage(await endConnection(multi, targetId));
      if (message) { vscode.window.showInformationMessage(message); }
    }),

    // Legacy connect/disconnect (operate on active robot)
    tracedCommand('abbRobot.configure', async (arg?: unknown) => {
      // The robot the caller names (a row, a failed connect), else the active one.
      const entry = entryOf(multi, arg);
      const id = entry.id;
      if (!id) {
        vscode.commands.executeCommand('abbRobot.addRobot');
        return;
      }
      const existing = multi.configs.find(c => c.id === id);

      const host = await vscode.window.showInputBox({ title: 'Configure Robot (1/3)', prompt: 'Host', value: existing?.host ?? '192.168.125.1' });
      if (!host) { return; }
      // Factory credentials are pre-filled only for a controller on this PC (a RobotStudio VC).
      const fallback = credentialDefaults(isLocalAddress(host.trim()));
      const username = await vscode.window.showInputBox({ title: 'Configure Robot (2/3)', prompt: 'Username', value: existing?.username ?? fallback.username });
      if (!username) { return; }
      const password = await vscode.window.showInputBox({ title: 'Configure Robot (3/3)', prompt: 'Password', value: existing?.password ?? fallback.password, password: true });
      if (password === undefined) { return; }

      // Only this robot's host and username change in the stored list; its password goes to
      // secure storage, and a plaintext one left in its settings entry is dropped. A robot
      // removed outside this window meanwhile is left as it is. A failed save puts back the
      // host, user and password this window had, in memory and in secure storage.
      const secretKey = passwordSecretKey(id);
      let before: { host: string; username: string; password: string; secret?: string; secretKnown: boolean } | undefined;
      let saved: boolean;
      try {
        saved = await changeSavedRobots(
          { kind: 'patch', id, fields: { host: host.trim(), username: username.trim() }, dropPassword: true },
          {
            inMemory: {
              apply: async () => {
                const now = multi.configs.find(c => c.id === id);
                if (!now) { return; }
                before = { host: now.host, username: now.username, password: now.password, secretKnown: false };
                try { before.secret = await context.secrets.get(secretKey); before.secretKnown = true; }
                catch (e) { Logger.warn(`could not read the saved password of ${id} before changing it: ${e instanceof Error ? e.message : String(e)}`); }
                multi.updateConfig(id, { host: host.trim(), username: username.trim(), password });
                await storePasswordSecret(context.secrets, id, password);
              },
              undo: async () => {
                if (!before) { return; }
                multi.updateConfig(id, { host: before.host, username: before.username, password: before.password });
                if (!before.secretKnown) { return; }
                if (before.secret === undefined) { await context.secrets.delete(secretKey); }
                else { await context.secrets.store(secretKey, before.secret); }
              },
            },
          },
        );
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        Logger.warn(`could not save the robot list after configuring ${id}: ${text}`);
        void vscode.window.showErrorMessage(`"${entry.config.name}" was not changed: could not save the robot list: ${text}`);
        return;
      }
      if (!saved) {
        void vscode.window.showWarningMessage(`"${entry.config.name}" is no longer in the saved robots (it was removed outside this window), so nothing was saved.`);
        return;
      }

      const connect = await vscode.window.showInformationMessage(`✓ Saved - host: ${host.trim()}`, 'Reconnect');
      if (connect === 'Reconnect') { vscode.commands.executeCommand('abbRobot.connectRobot', id); }
    }),

    tracedCommand('abbRobot.connect', async () => {
      const entry = activeEntry(multi);
      vscode.commands.executeCommand('abbRobot.connectRobot', entry.id);
    }),

    tracedCommand('abbRobot.disconnect', async () => {
      const entry = activeEntry(multi);
      vscode.commands.executeCommand('abbRobot.disconnectRobot', entry.id);
    }),

    // ─── RAPID control ───────────────────────────────────────────────────────

    tracedCommand('abbRobot.startRapid', async () => {
      const entry = activeEntry(multi);
      const ok = await confirmMotion(entry, {
        label: 'Start RAPID', tier: 'motion',
        sideEffects: [
          'Starts the RAPID program from the program pointer; the robot moves as the program says.',
          ...heartbeatSideEffects(entry),
        ],
      });
      if (!ok) { return; }
      await wrap('Starting RAPID…', () => entry.manager.startRapid(), 'RAPID started.', entry);
    }),

    // RobotWare 8: allow motion control on the active robot after the person confirms
    // both stops are within reach (typed name); withdraw it at once, like Stop.
    tracedCommand('abbRobot.allowMotionControl', async () => {
      await allowFor(activeEntry(multi), 'palette');
    }),

    // The robot named (a Robots view row, the status bar), else the one robot whose allowance
    // may stand, else the active one; with several, the person picks (see withdrawTargetOf).
    tracedCommand('abbRobot.withdrawMotionControl', async (arg?: unknown) => {
      const target = await withdrawTargetOf(multi, arg);
      if (target) { await withdrawFor(target); }
    }),

    tracedCommand('abbRobot.stopRapid', async () => {
      const entry = activeEntry(multi);
      await wrap('Stopping RAPID…', () => entry.manager.stopRapid(), 'RAPID stopped.', entry);
    }),

    tracedCommand('abbRobot.resetRapid', async () => {
      const entry = activeEntry(multi);
      await wrap('Resetting RAPID PP…', () => entry.manager.resetRapid(), 'PP reset.', entry);
    }),

    tracedCommand('abbRobot.ppToMain', async () => {
      const entry = activeEntry(multi);
      await wrap('Moving PP to Main…', () => entry.manager.resetRapid(), '✓ PP moved to Main.', entry);
    }),

    tracedCommand('abbRobot.refresh', () => { activeEntry(multi).manager.refresh().catch(() => {}); }),

    tracedCommand('abbRobot.setExecutionCycle', async () => {
      const entry = activeEntry(multi);
      const choice = await vscode.window.showQuickPick([
        { label: 'Once',    value: 'once'    as const, description: 'Run once then stop' },
        { label: 'Forever', value: 'forever' as const, description: 'Loop indefinitely' },
        { label: 'As Is',   value: 'asis'    as const, description: 'Keep current setting' },
      ], { title: 'Set Execution Cycle' });
      if (!choice) { return; }
      try { await entry.manager.setExecutionCycle(choice.value); vscode.window.showInformationMessage(`Cycle: ${choice.label}`); }
      catch (e: unknown) { showError('Set cycle', e, entry); }
    }),

    // ─── Motors & speed ──────────────────────────────────────────────────────

    tracedCommand('abbRobot.motorsOn', async () => {
      const entry = activeEntry(multi);
      const ok = await confirm(entry, {
        label: 'Motors On', tier: 'motion',
        sideEffects: ['Turns the motors on; the robot can move as soon as RAPID starts or a jog is sent.'],
      });
      if (!ok) { return; }
      try { await entry.manager.setMotorsOn(); vscode.window.showInformationMessage('Motors ON.'); }
      catch (e: unknown) { showError('Motors On', e, entry); }
    }),

    tracedCommand('abbRobot.motorsOff', async () => {
      const entry = activeEntry(multi);
      try { await entry.manager.setMotorsOff(); vscode.window.showInformationMessage('Motors OFF.'); }
      catch (e: unknown) { showError('Motors Off', e, entry); }
    }),

    tracedCommand('abbRobot.setSpeedRatio', async () => {
      const entry = activeEntry(multi);
      const current = entry.manager.state.speedRatio ?? 100;
      const input = await vscode.window.showInputBox({
        title: 'Set Speed Ratio', prompt: '0-100 (AUTO mode only)', value: String(current),
        validateInput: v => { const n = +v; return (isNaN(n) || n < 0 || n > 100) ? 'Must be 0-100' : undefined; },
      });
      if (input === undefined) { return; }
      if (!await confirm(entry, speedRatioRequest(current, +input, isRapidRunning(entry.manager.state.execstate)))) { return; }
      try { await entry.manager.setSpeedRatio(+input); vscode.window.showInformationMessage(`Speed ratio: ${input}%`); }
      catch (e: unknown) { showError('Set speed ratio', e, entry); }
    }),

    // ─── Simulation panel (virtual controllers only) ─────────────────────────

    tracedCommand('abbRobot.simEStop', async () => {
      const entry = activeEntry(multi);
      if (!await confirm(entry, virtualOnlyRequest('Simulate E-Stop', ['Engages a simulated emergency stop: the motors drop and RAPID stops.']))) { return; }
      try { await entry.manager.simEmergencyStop(); vscode.window.showWarningMessage('Simulated E-Stop engaged. Use "Reset Simulated E-Stop" to release.'); }
      catch (e: unknown) { showError('Simulate E-Stop', e, entry); }
    }),

    tracedCommand('abbRobot.simResetEStop', async () => {
      const entry = activeEntry(multi);
      if (!await confirm(entry, virtualOnlyRequest('Reset simulated E-Stop', ['Releases the simulated emergency stop.']))) { return; }
      try { await entry.manager.simResetEmergencyStop(); vscode.window.showInformationMessage('Simulated E-Stop released.'); }
      catch (e: unknown) { showError('Reset simulated E-Stop', e, entry); }
    }),

    tracedCommand('abbRobot.simGeneralStop', async () => {
      const entry = activeEntry(multi);
      const engaged = entry.manager.state.ctrlstate === 'guardstop';
      if (!await confirm(entry, virtualOnlyRequest(`Simulate general stop (${engaged ? 'release' : 'engage'})`, [`${engaged ? 'Releases' : 'Engages'} a simulated general stop.`]))) { return; }
      try { await entry.manager.simGeneralStop(!engaged); vscode.window.showInformationMessage(`Simulated general stop ${engaged ? 'released' : 'engaged'}.`); }
      catch (e: unknown) { showError('Simulate general stop', e, entry); }
    }),

    tracedCommand('abbRobot.simAutoStop', async () => {
      const entry = activeEntry(multi);
      const engaged = entry.manager.state.ctrlstate === 'guardstop';
      if (!await confirm(entry, virtualOnlyRequest(`Simulate auto stop (${engaged ? 'release' : 'engage'})`, [`${engaged ? 'Releases' : 'Engages'} a simulated auto stop.`]))) { return; }
      try { await entry.manager.simAutoStop(!engaged); vscode.window.showInformationMessage(`Simulated auto stop ${engaged ? 'released' : 'engaged'}.`); }
      catch (e: unknown) { showError('Simulate auto stop', e, entry); }
    }),

    tracedCommand('abbRobot.simEnableSwitch', async () => {
      const entry = activeEntry(multi);
      const pick = await vscode.window.showQuickPick(['Press (on)', 'Release (off)'], { title: 'Simulate Enable Switch' });
      if (pick === undefined) { return; }
      if (!await confirm(entry, virtualOnlyRequest(`Simulate enable switch (${pick.startsWith('Press') ? 'press' : 'release'})`, ['Presses or releases the simulated enable switch; a pressed one lets manual motion run.']))) { return; }
      try { await entry.manager.simEnableSwitch(pick.startsWith('Press')); vscode.window.showInformationMessage(`Simulated enable switch ${pick.startsWith('Press') ? 'pressed' : 'released'}.`); }
      catch (e: unknown) { showError('Simulate enable switch', e, entry); }
    }),

    tracedCommand('abbRobot.teleportRobot', async () => {
      const entry = activeEntry(multi);
      const mechunit = entry.manager.state.mechunits[0] ?? 'ROB_1';
      const current = entry.manager.state.joints;
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
      if (!await confirm(entry, virtualOnlyRequest(`Teleport ${mechunit}`, [`Moves ${mechunit} at once to joints [${joints.join(', ')}], without a motion.`]))) { return; }
      try { await entry.manager.teleportMechunit(mechunit, joints); vscode.window.showInformationMessage(`Teleported ${mechunit} to [${joints.join(', ')}].`); }
      catch (e: unknown) { showError('Teleport robot', e, entry); }
    }),

    // ─── Jogging ─────────────────────────────────────────────────────────────

    tracedCommand('abbRobot.jog', async (axisIndex: number, direction: 1 | -1) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const cfg   = vscode.workspace.getConfiguration('abbRobot');
      const inc   = cfg.get<number>('jog.increment', 1);
      const speed = cfg.get<number>('jog.speed', 10);
      const mode  = cfg.get<string>('jog.mode', 'Joint') as 'Joint' | 'Cartesian';

      // The typed-name confirmation, once per robot and connection (the map
      // forgets a robot when it disconnects).
      if (jogNeedsAsk(jogConfirmed.get(entry.id), inc)) {
        const ok = await confirmMotion(entry, {
          label: 'Jog', tier: 'motion',
          sideEffects: jogConfirmEffects(inc),
        });
        if (!ok) { return; }
        jogConfirmed.set(entry.id, inc);
      }

      const axes: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
      axes[axisIndex] = direction * inc;

      try {
        await entry.manager.jog({ mode, axes, speed });
      } catch (e: unknown) {
        // Refused for motion control: the next jog asks again, with the motion-control line.
        if (refusalOf(e)?.kind === 'motion-control-off') { jogConfirmed.delete(entry.id); }
        showError('Jog', e, entry);
      }
    }),

    tracedCommand('abbRobot.setJogIncrement', async () => {
      const cfg = vscode.workspace.getConfiguration('abbRobot');
      const cur = cfg.get<number>('jog.increment', 1);
      // The axis value sent with each click: ABB documents it without a unit, so no unit is named.
      const presets = [0.1, 0.5, 1, 5, 10].map(v => ({ label: String(v), value: v }));
      const pick = await vscode.window.showQuickPick(
        [...presets.map(p => ({ label: p.label, description: cur === p.value ? '(current)' : '', value: p.value })),
          { label: 'Custom…', description: 'Enter a value', value: -1 }],
        { title: 'Jog axis value (no unit; one jog step per click)' },
      );
      if (!pick) { return; }
      let value = pick.value;
      if (value < 0) {
        const input = await vscode.window.showInputBox({ prompt: 'Axis value sent with each click (no unit; the button sets the sign)', value: String(cur), validateInput: v => isNaN(+v) || +v <= 0 ? 'Must be a positive number' : undefined });
        if (input === undefined) { return; }
        value = +input;
      }
      await cfg.update('jog.increment', value, vscode.ConfigurationTarget.Global);
    }),

    tracedCommand('abbRobot.setJogSpeed', async () => {
      const cfg = vscode.workspace.getConfiguration('abbRobot');
      const cur = cfg.get<number>('jog.speed', 10);
      const input = await vscode.window.showInputBox({
        title: 'Jog Speed (not sent)',
        prompt: 'Kept for compatibility: ABB\'s jog form has no speed field, so this changes nothing on the controller (0-100).',
        value: String(cur),
        validateInput: v => { const n = +v; return isNaN(n) || n < 0 || n > 100 ? 'Must be 0-100' : undefined; },
      });
      if (input === undefined) { return; }
      await cfg.update('jog.speed', +input, vscode.ConfigurationTarget.Global);
    }),

    tracedCommand('abbRobot.setJogMode', async () => {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Joint',     description: 'Axis labels J1-J6',                   value: 'Joint' },
          { label: 'Cartesian', description: 'Axis labels X, Y, Z, Rx, Ry, Rz',     value: 'Cartesian' }],
        { title: 'Jog Mode (not sent: the controller jogs in the mode of the unit selected for jogging)' },
      );
      if (!pick) { return; }
      const cfg = vscode.workspace.getConfiguration('abbRobot');
      await cfg.update('jog.mode', pick.value, vscode.ConfigurationTarget.Global);
    }),

    // ─── New verified-endpoint commands (Phase 2.5 quick exposes) ───────────

    tracedCommand('abbRobot.showSystemDetails', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = entry.manager;
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
      } catch (e) { showError('System details', e, entry); }
    }),

    tracedCommand('abbRobot.cfgOpenInstance', async (domain: string, type: string, instance: string) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { return; }
      try {
        const data = await entry.manager.getCfgInstance(domain, type, instance);
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// ${domain} / ${type} / ${instance}\n${JSON.stringify(data, null, 2)}`,
        });
        vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('Open CFG instance', e, entry); }
    }),

    tracedCommand('abbRobot.browseCfg', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = entry.manager;
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
      } catch (e) { showError('Browse CFG', e, entry); }
    }),

    tracedCommand('abbRobot.showProgramPointer', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const tasks = entry.manager.state.tasks;
        const task = tasks.find(t => t.active)?.name ?? 'T_ROB1';
        const m = entry.manager;
        const [pp, mp] = await Promise.all([m.getProgramPointer(task), m.getMotionPointer(task)]);
        vscode.window.showInformationMessage(
          `${task}:\n  PP: ${pp.module ?? '-'} / ${pp.routine ?? '-'} (row ${pp.row ?? '-'})\n  MP: ${mp.module ?? '-'} / ${mp.routine ?? '-'} (row ${mp.row ?? '-'})`,
          { modal: true },
        );
      } catch (e) { showError('Program pointer', e, entry); }
    }),

    tracedCommand('abbRobot.showMotionInfo', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = entry.manager;
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
      } catch (e) { showError('Motion info', e, entry); }
    }),

    tracedCommand('abbRobot.showActiveToolWobj', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = entry.manager;
        const [tool, wobj, payload] = await Promise.all([
          m.getActiveTool(), m.getActiveWobj(), m.getActivePayload(),
        ]);
        vscode.window.showInformationMessage(
          `Active tool: ${tool.name}\nActive wobj: ${wobj.name}\nActive payload: ${payload.name}`,
        );
      } catch (e) { showError('Tool/Wobj', e, entry); }
    }),

    tracedCommand('abbRobot.listBackups', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const backups = await entry.manager.listBackups();
        if (backups.length === 0) { vscode.window.showInformationMessage('No backups in /BACKUP'); return; }
        const items = backups.map(b => ({
          label: b.name,
          description: b.created ?? '',
        }));
        await vscode.window.showQuickPick(items, { title: `${backups.length} backup(s)`, placeHolder: 'Select to view (read-only)' });
      } catch (e) { showError('List backups', e, entry); }
    }),

    tracedCommand('abbRobot.showVirtualTime', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = entry.manager;
        // Shows time, speed and state; offers the speed actions only. There is
        // no pause or resume over RWS; use RobotStudio's Simulation tab.
        const vt = await m.getVirtualTime() as VirtualTimeReading;
        // RobotWare 6: the state only, with the sentence that RAPID Live does not set it, and no action; nothing is sent.
        const gen = generationOf(entry.manager.state);
        const action = await vscode.window.showInformationMessage(virtualTimeNotice(vt, gen), ...virtualTimeActionsFor(gen));
        if (action === undefined) { return; }
        if (!await confirm(entry, virtualOnlyRequest(action, ['Changes how fast the virtual clock runs, and with it every program and motion on the virtual controller.']))) { return; }
        await runVirtualTimeAction(m, action, gen);
      } catch (e) { showError('Virtual time', e, entry); }
    }),

    tracedCommand('abbRobot.showMechunitDetails', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const m = entry.manager;
        const mu = (entry.manager.state.mechunits[0]) ?? 'ROB_1';
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
      } catch (e) { showError('Mechunit details', e, entry); }
    }),

    // ─── Inverse kinematics ──────────────────────────────────────────────────

    tracedCommand('abbRobot.calcIK', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }

      // Collect Cartesian target - pre-fill with current position if available
      const cur = entry.manager.state.cartesian;
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
            const seed = entry.manager.state.joints ?? undefined;
            const j = await entry.manager.calcJointsFromCartesian(pos, seed);
            const fmt = (v: number) => v.toFixed(2);
            const result = `J1=${fmt(j.rax_1)}°  J2=${fmt(j.rax_2)}°  J3=${fmt(j.rax_3)}°  J4=${fmt(j.rax_4)}°  J5=${fmt(j.rax_5)}°  J6=${fmt(j.rax_6)}°`;
            vscode.window.showInformationMessage(`IK Result: ${result}`, 'Copy').then(c => {
              if (c === 'Copy') { vscode.env.clipboard.writeText(result); }
            });
          } catch (e: unknown) { showError('Inverse kinematics', e, entry); }
        },
      );
    }),

    // ─── Op mode lock/unlock ─────────────────────────────────────────────────

    tracedCommand('abbRobot.lockOpMode', async () => {
      const entry = activeEntry(multi);
      const pin = await vscode.window.showInputBox({ title: 'Lock Operation Mode', prompt: '4-digit PIN code', validateInput: v => v.length === 4 ? undefined : 'PIN must be 4 digits' });
      if (!pin) { return; }
      const perm = await vscode.window.showQuickPick(
        [{ label: 'Temporary', value: false }, { label: 'Permanent', value: true }],
        { title: 'Lock type', placeHolder: 'Temporary or permanent lock?' }
      );
      if (!perm) { return; }
      const ok = await confirm(entry, {
        label: 'Lock Operation Mode', tier: 'disruptive',
        sideEffects: [
          `Locks the operation mode selector ${perm.value ? 'permanently' : 'temporarily'} with this PIN.`,
          'The mode cannot be changed until the selector is unlocked with the same PIN.',
        ],
      });
      if (!ok) { return; }
      try { await entry.manager.lockOperationMode(pin, perm.value); vscode.window.showInformationMessage('Operation mode locked.'); }
      catch (e: unknown) { showError('Lock op mode', e, entry); }
    }),

    tracedCommand('abbRobot.unlockOpMode', async () => {
      const entry = activeEntry(multi);
      // The controller's unlock form requires the PIN the lock set (RW 6.16,
      // 7.21.4, 8.2.1); the client refuses a call without one.
      const pin = await vscode.window.showInputBox({ title: 'Unlock Operation Mode', prompt: 'The 4-digit PIN the lock was set with', validateInput: v => v.length === 4 ? undefined : 'PIN must be 4 digits' });
      if (!pin) { return; }
      const ok = await confirm(entry, {
        label: 'Unlock Operation Mode', tier: 'disruptive',
        sideEffects: ['Unlocks the operation mode selector; the mode can be changed again.'],
      });
      if (!ok) { return; }
      try { await entry.manager.unlockOperationMode(pin); vscode.window.showInformationMessage('Operation mode unlocked.'); }
      catch (e: unknown) { showError('Unlock op mode', e, entry); }
    }),

    tracedCommand('abbRobot.setOpMode', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const current = entry.manager.state.opmode ?? '?';
      // A guard stop or an emergency stop does not hold the switch back: it is
      // sent in every controller state and the controller decides. Its refusal
      // is shown with the client's sentence, plus where the Reset is on
      // RobotWare 8 (opModeRefusalNote).
      const ctrlstate = entry.manager.state.ctrlstate;
      const stopName = safetyStopName(ctrlstate);
      const stopped = stopName ? ` The controller is in ${stopName}; it decides whether to switch.` : '';

      const pick = await vscode.window.showQuickPick(
        [
          { label: 'AUTO', detail: current === 'AUTO' ? '(already current)' : 'Production mode - full speed, motion runs from RAPID' },
          { label: 'MANR', detail: current === 'MANR' ? '(already current)' : 'Manual Reduced - 250mm/s max, deadman required (FlexPendant)' },
          { label: 'MANF', detail: current === 'MANF' ? '(already current)' : 'Manual Full - full speed in manual; rare, requires FullSpeed license' },
        ],
        { placeHolder: `Switch operation mode (currently ${current}). VC only - real hardware uses the key switch.${stopped}` },
      );
      if (!pick) { return; }

      // Pre-flight: don't call the controller for a no-op transition.
      if (pick.label === current) {
        vscode.window.showInformationMessage(`Already in ${current} - nothing to change.`);
        return;
      }

      if (!await confirm(entry, opModeRequest(current, pick.label))) { return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Switching to ${pick.label}…`, cancellable: false },
          async () => entry.manager.setOperationMode(pick.label as 'AUTO' | 'MANR' | 'MANF'),
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
        // Anything else is the client's refusal (write access on RobotWare 8,
        // a locked selector, a switch waiting at the FlexPendant, a safety
        // stop) or the controller's own answer; shown as it is, bound to this
        // robot, with where the Reset is on RobotWare 8 in a safety stop.
        showError('Switch op mode', e, entry, opModeRefusalNote(ctrlstate, generationOf(entry.manager.state), raw));
      }
    }),

    // ─── RAPID variables ─────────────────────────────────────────────────────

    tracedCommand('abbRobot.readVariable', async () => {
      const entry = activeEntry(multi);
      const task   = await vscode.window.showInputBox({ title: 'Read Variable (1/3)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const module = await vscode.window.showInputBox({ title: 'Read Variable (2/3)', prompt: 'Module', value: 'user' });
      if (!module) { return; }
      const symbol = await vscode.window.showInputBox({ title: 'Read Variable (3/3)', prompt: 'Symbol name', value: 'reg1' });
      if (!symbol) { return; }
      try {
        const value = await entry.manager.getRapidVariable(task, module, symbol);
        vscode.window.showInformationMessage(`${task}/${module}/${symbol} = ${value}`, 'Copy').then(c => {
          if (c === 'Copy') { vscode.env.clipboard.writeText(value); }
        });
      } catch (e: unknown) { showError('Read variable', e, entry); }
    }),

    tracedCommand('abbRobot.writeVariable', async () => {
      const entry = activeEntry(multi);
      const task   = await vscode.window.showInputBox({ title: 'Write Variable (1/4)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const module = await vscode.window.showInputBox({ title: 'Write Variable (2/4)', prompt: 'Module', value: 'user' });
      if (!module) { return; }
      const symbol = await vscode.window.showInputBox({ title: 'Write Variable (3/4)', prompt: 'Symbol name' });
      if (!symbol) { return; }
      const value  = await vscode.window.showInputBox({ title: 'Write Variable (4/4)', prompt: 'Value (RAPID syntax)' });
      if (value === undefined) { return; }
      try { await entry.manager.setRapidVariable(task, module, symbol, value); vscode.window.showInformationMessage(`${symbol} = ${value}`); }
      catch (e: unknown) { showError('Write variable', e, entry); }
    }),

    tracedCommand('abbRobot.readSymbolProperties', async () => {
      const entry = activeEntry(multi);
      const task   = await vscode.window.showInputBox({ title: 'Symbol Properties (1/3)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const module = await vscode.window.showInputBox({ title: 'Symbol Properties (2/3)', prompt: 'Module', value: 'user' });
      if (!module) { return; }
      const symbol = await vscode.window.showInputBox({ title: 'Symbol Properties (3/3)', prompt: 'Symbol name' });
      if (!symbol) { return; }
      try {
        const props = await entry.manager.getRapidSymbolProperties(task, module, symbol);
        const msg = `${task}/${module}/${symbol}\nType: ${props.symtyp}  DataType: ${props.dattyp}\nDims: ${props.ndim > 0 ? props.dim : 'scalar'}\nReadOnly: ${props.ro}  Local: ${props.local}`;
        vscode.window.showInformationMessage(msg, 'Copy').then(c => { if (c === 'Copy') { vscode.env.clipboard.writeText(JSON.stringify(props, null, 2)); } });
      } catch (e: unknown) { showError('Symbol properties', e, entry); }
    }),

    tracedCommand('abbRobot.searchSymbols', async () => {
      const entry = activeEntry(multi);
      const task = await vscode.window.showInputBox({ title: 'Search Symbols (1/2)', prompt: 'Task', value: 'T_ROB1' });
      if (!task) { return; }
      const symtyp = await vscode.window.showQuickPick(
        [{ label: 'All', value: undefined }, { label: 'Variables', value: 'var' }, { label: 'Persistents', value: 'per' }, { label: 'Constants', value: 'con' }, { label: 'Functions', value: 'fun' }, { label: 'Procedures', value: 'prc' }],
        { title: 'Search Symbols (2/2)', placeHolder: 'Filter by type' }
      );
      if (!symtyp) { return; }
      try {
        const symbols = await entry.manager.searchRapidSymbols({ task, symtyp: symtyp.value });
        if (!symbols.length) { vscode.window.showInformationMessage(`No symbols in ${task}.`); return; }
        const doc = await vscode.workspace.openTextDocument({ content: `Found ${symbols.length} symbols in ${task}:\n\n` + symbols.map(s => `${s.symtyp.padEnd(4)} ${s.dattyp.padEnd(16)} ${s.name}`).join('\n'), language: 'plaintext' });
        vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('Symbol search', e, entry); }
    }),

    tracedCommand('abbRobot.getUiInstruction', async () => {
      const entry = activeEntry(multi);
      try {
        const instr = await entry.manager.getActiveUiInstruction();
        if (!instr) { vscode.window.showInformationMessage('No active UI instruction.'); return; }
        const msg = `Instruction: ${instr.instr}\nEvent: ${instr.event}\nStack: ${instr.stack}` + (instr.msg ? `\nMessage: ${instr.msg}` : '');
        const c = await vscode.window.showInformationMessage(msg, 'Respond…');
        if (c !== 'Respond…') { return; }
        const uiparam = await vscode.window.showInputBox({ prompt: 'Parameter name (a TPReadNum takes TPAnswer, not Result)', value: 'TPAnswer' });
        if (!uiparam) { return; }
        const value = await vscode.window.showInputBox({ prompt: 'Value to send' });
        if (value === undefined) { return; }
        // The answer lets the waiting RAPID instruction go on, so the program
        // continues from there: a motion-tier write.
        const ok = await confirm(entry, {
          label: 'Answer UI instruction', tier: 'motion',
          sideEffects: [
            `Sends ${uiparam} = ${value} to the ${instr.instr} instruction waiting in the program; the program continues and the robot moves as it says.`,
            ...(uiparam === 'TPAnswer' ? [`Then sends TPCompleted = TRUE, which ends the wait.`] : []),
          ],
        });
        if (!ok) { return; }
        try {
          await entry.manager.setUiInstructionParam(instr.stack, uiparam, value);
          // The client documents the answer as TPAnswer, then TPCompleted = TRUE (RW 6.16.03, 2026-10-13).
          if (uiparam === 'TPAnswer') { await entry.manager.setUiInstructionParam(instr.stack, 'TPCompleted', 'TRUE'); }
          vscode.window.showInformationMessage('✓ UI instruction responded.');
        }
        catch (e2: unknown) { showError('Respond to UI instruction', e2, entry); }
      } catch (e: unknown) { showError('Get UI instruction', e, entry); }
    }),

    // ─── Module management ───────────────────────────────────────────────────

    tracedCommand('abbRobot.uploadModule', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'RAPID Module': ['mod', 'MOD'] }, title: 'Select RAPID module' });
      if (!uris?.length) { return; }
      const localPath = uris[0].fsPath;
      const fileName  = require('path').basename(localPath);
      const taskName  = entry.manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading ${fileName}…` }, async () => {
        try {
          // A failed step (for one, the module loaded but the program pointer
          // not moved) fails the call; its message says which step and what
          // was already done.
          const r = await withStopOffer('Load module', stop => entry.manager.loadProgram(localPath, taskName!, { stopIfRunning: stop }), entry);
          if (r === CANCELLED) { return; }
          vscode.window.showInformationMessage(`✓ ${fileName} loaded. Press Start to run.`);
        } catch (e: unknown) {
          showError('Load module', e, entry);
        }
      });
    }),

    // Invoked by the CodeLens "▶ Set PP here" above each routine in a .mod file.
    // Args are pre-resolved: (moduleName, routineName, kind).
    tracedCommand('abbRobot.setPPFromCodeLens', async (
      moduleName?: unknown, routineName?: unknown, _kind?: unknown, lensFile?: unknown,
    ) => {
      // The lens's own document, read before any prompt: the active editor can change while one is open.
      const lensPath = typeof lensFile === 'string' && lensFile ? lensFile : vscode.window.activeTextEditor?.document.fileName;
      const entry = activeEntry(multi);
      if (typeof moduleName !== 'string' || typeof routineName !== 'string') {
        vscode.window.showWarningMessage('Set PP from CodeLens: missing arguments.');
        return;
      }
      if (!entry.manager.state.connected) {
        vscode.window.showWarningMessage('Connect to a robot first, then click ▶ again.');
        return;
      }
      const active = entry.manager;
      const taskName = taskForModule(active.state, moduleName);

      // If the module isn't loaded on the controller, offer to load THIS file first
      if (!isModuleLoaded(active.state, moduleName)) {
        const filePath = lensPath;
        const choice = await vscode.window.showWarningMessage(
          `Module "${moduleName}" isn't loaded on ${robotLabel(confirmRobotOf(entry))} yet.`,
          { modal: false },
          'Load this file first', 'Cancel',
        );
        if (choice !== 'Load this file first' || !filePath) { return; }
        try {
          if (await withStopOffer('Load module', stop => active.loadProgram(filePath, taskName, { stopIfRunning: stop }), entry) === CANCELLED) { return; }
        } catch (e) { showError('Load module', e, entry); return; }
      }

      try {
        if (await withStopOffer('Set PP', stop => active.setPPToRoutine(taskName, moduleName, routineName, { stopIfRunning: stop }), entry) === CANCELLED) { return; }
        vscode.window.setStatusBarMessage(`✓ PP set to ${moduleName}.${routineName}`, 3000);
      } catch (e) {
        // Auto-recover from `main` collisions: if Set-PP fails with the
        // Semantic-error code, check if multiple loaded modules have a
        // `main` proc and offer to unload the conflicting one.
        if (await tryResolveMainCollision(active, taskName, moduleName, e, entry)) {
          // Retry once after the user resolves the collision
          try {
            await active.setPPToRoutine(taskName, moduleName, routineName);
            vscode.window.setStatusBarMessage(`✓ PP set to ${moduleName}.${routineName}`, 3000);
            return;
          } catch (e2) { showError('Set PP', e2, entry); return; }
        }
        showError('Set PP', e, entry);
      }
    }),

    // Invoked by the CodeLens "▶ Run this routine" above each routine.
    // Sets PP to the routine then starts execution in one click. Auto-loads
    // the module if not present, and turns motors on if needed (in AUTO).
    tracedCommand('abbRobot.runRoutineFromCodeLens', async (
      moduleName?: unknown, routineName?: unknown, _kind?: unknown, lensFile?: unknown,
    ) => {
      if (typeof moduleName !== 'string' || typeof routineName !== 'string') {
        vscode.window.showWarningMessage('Run routine from CodeLens: missing arguments.');
        return;
      }
      const entry = activeEntry(multi);
      const active = entry.manager;
      if (!active.state.connected) {
        vscode.window.showWarningMessage('Connect to a robot first, then click ▶ again.');
        return;
      }
      const taskName = taskForModule(active.state, moduleName);

      // One typed confirmation covers everything the click does: the load,
      // the pointer move, the motors and the start. The list says which of
      // them apply on this robot right now.
      const needsLoad = !isModuleLoaded(active.state, moduleName);
      const filePath = typeof lensFile === 'string' && lensFile ? lensFile : vscode.window.activeTextEditor?.document.fileName;
      if (needsLoad && !filePath) {
        vscode.window.showWarningMessage(`No active editor with file path. Load ${moduleName} via the Modules panel and retry.`);
        return;
      }
      const needsMotors = active.state.opmode === 'AUTO' && active.state.ctrlstate !== 'motoron';
      // Reads before the dialog: which other loaded modules define main. If the
      // controller refuses the pointer move because two do, exactly these are
      // the ones that can be unloaded, and the dialog says so.
      const mainHolders = (await modulesWithMain(active, taskName)).filter(m => m !== moduleName);
      const ok = await confirmMotion(entry, {
        label: `Run ${moduleName}.${routineName}`, tier: 'motion',
        sideEffects: [
          ...(needsLoad ? [`Loads ${moduleName} from the open file into task ${taskName}.`] : []),
          `Sets the program pointer of ${taskName} to ${moduleName}.${routineName}.`,
          ...(mainHolders.length ? [`Unloads ${mainHolders.join(' or ')} if the controller refuses the pointer move because it also declares PROC main().`] : []),
          ...(needsMotors ? [`Turns the motors on (they are ${active.state.ctrlstate ?? 'off'}).`] : []),
          'Starts RAPID there; the robot moves as the routine says.',
          ...heartbeatSideEffects(entry),
        ],
      });
      if (!ok) { return; }

      // If module isn't loaded, load THIS file
      if (needsLoad && filePath) {
        try {
          if (await withStopOffer('Load module', stop => active.loadProgram(filePath, taskName, { stopIfRunning: stop }), entry) === CANCELLED) { return; }
        } catch (e) { showError('Load module', e, entry); return; }
      }

      try {
        // Set PP at the chosen routine - with auto-recovery on `main` collision.
        // The client no longer stops a running program on its own: the user
        // is asked first.
        try {
          if (await withStopOffer('Run routine', stop => active.setPPToRoutine(taskName, moduleName, routineName, { stopIfRunning: stop }), entry) === CANCELLED) { return; }
        } catch (e) {
          if (!(await tryResolveMainCollision(active, taskName, moduleName, e, entry, mainHolders))) { throw e; }
          await active.setPPToRoutine(taskName, moduleName, routineName);
        }

        // Motors on only when the confirmation listed it.
        if (needsMotors) {
          try { await active.setMotorsOn(); }
          catch (e) { showError('Motors On', e, entry); return; }
          // brief pause for motors to engage
          await new Promise(r => setTimeout(r, 400));
        }

        await active.startRapid();
        vscode.window.setStatusBarMessage(`▶ Running ${moduleName}.${routineName}`, 4000);
      } catch (e) { showError('Run routine', e, entry); }
    }),

    tracedCommand('abbRobot.setPPToRoutine', async (arg?: unknown, taskArg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = entry.manager;
      if (!active) { vscode.window.showWarningMessage('No active robot.'); return; }

      // Determine module: from the Program panel row (name + task) if available, else quick-pick
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      let taskName: string | undefined = typeof taskArg === 'string' && taskArg ? taskArg : undefined;
      if (!moduleName) {
        const picked = await pickLoadedModule(active.state, 'Pick the module');
        if (picked === null) { vscode.window.showWarningMessage('No program modules loaded.'); return; }
        if (!picked) { return; }
        moduleName = picked.name;
        taskName = picked.task;
      }
      if (!taskName) { taskName = taskForModule(active.state, moduleName); }

      // Fetch routines from the controller
      let routines: Array<{ name: string; symtyp: string; local: boolean }>;
      try {
        routines = await active.listRoutines(taskName, moduleName!);
      } catch (e) {
        showError('List routines', e, entry);
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

      const ppAsk = whileRunningRequest('Set PP to routine', isRapidRunning(active.state.execstate), [`Moves the program pointer to ${moduleName}.${picked.name}.`]);
      if (ppAsk && !await confirm(entry, ppAsk)) { return; }
      try {
        if (await withStopOffer('Set PP to routine', stop => active.setPPToRoutine(taskName!, moduleName!, picked.name, { stopIfRunning: stop }), entry) === CANCELLED) { return; }
        vscode.window.showInformationMessage(`✓ PP set to ${moduleName}.${picked.name}. Click Start to run.`);
      } catch (e: unknown) { showError('Set PP to routine', e, entry); }
    }),

    tracedCommand('abbRobot.unloadModule', async (arg?: unknown, taskArg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // Accept a string module name (plus the owning task from the Program
      // panel row) or a TreeItem with `.label`.
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      let taskName: string | undefined = typeof taskArg === 'string' && taskArg ? taskArg : undefined;
      if (!moduleName) {
        const picked = await pickLoadedModule(entry.manager.state, 'Pick module to unload');
        if (picked === null) { vscode.window.showWarningMessage('No program modules loaded.'); return; }
        if (!picked) { return; }
        moduleName = picked.name;
        taskName = picked.task;
      }
      if (!taskName) { taskName = taskForModule(entry.manager.state, moduleName); }
      const unloadAsk = whileRunningRequest('Unload module', isRapidRunning(entry.manager.state.execstate), [`Unloads ${moduleName} from ${taskName}.`]);
      if (unloadAsk && !await confirm(entry, unloadAsk)) { return; }
      try {
        const tn = taskName, mn = moduleName;
        if (await withStopOffer('Unload module', stop => entry.manager.unloadModule(tn, mn, { stopIfRunning: stop }), entry) === CANCELLED) { return; }
        vscode.window.showInformationMessage(`✓ ${moduleName} unloaded.`);
      } catch (e: unknown) { showError('Unload module', e, entry); }
    }),

    // ─── Tasks ───────────────────────────────────────────────────────────────
    // Task selection controls which RAPID tasks are included in the next run.
    // For multi-task setups (T_ROB1 + T_BCKGRND, dual-arm setups, etc.).

    // ─── Request Manual Mode Privileges (RMMP) ──────────────────────────────
    // RMMP (RobotWare 6/7) is the manual-mode counterpart of a mastership
    // request: the operator at the FlexPendant grants it. The client waits for
    // the operator and reports the outcome. RobotWare 8 has no RMMP.
    tracedCommand('abbRobot.requestRmmp', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // The request is sent in any mode and the controller decides (ABB: RobotWare 7 takes it in MANR only); its refusal is shown.
      const gen = generationOf(entry.manager.state);
      // Which level: modify for data and module writes; exec, RobotWare 7 only, for a program pointer move to a routine.
      const items: Array<{ label: string; description: string; level: RmmpLevelChoice }> = [
        { label: 'modify', description: 'RAPID data writes, loading and unloading modules, other changes that need mastership', level: 'modify' },
        ...(gen === 'rw8' ? [] : [{ label: 'exec', description: gen === 'rw7' ? 'also moving the program pointer to a routine (ABB: RMMP_Exe)' : 'not yet sent on RobotWare 6; ABB does not say what exec covers there', level: 'exec' as const }]),
      ];
      const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: RMMP_NAME, placeHolder: 'Which privilege to ask the operator for' });
      if (!pick) { return; }
      await requestRmmpInteractive(entry, { level: pick.level });
    }),

    tracedCommand('abbRobot.showRmmpStatus', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const priv = await entry.manager.getRmmpPrivilege();
        const rw8 = generationOf(entry.manager.state) === 'rw8';
        // The controller's own words for a waiting request are "pending modify"
        // and "pending exec"; shown as "pending (modify)" and "pending (exec)".
        const shown = priv === 'pending modify' ? 'pending (modify)' : priv === 'pending exec' ? 'pending (exec)' : priv;
        const explain = priv === 'none' ? 'No remote-modify rights. In manual mode, run "Request Remote Control" and have the operator grant it at the FlexPendant.'
                      : priv === 'pending modify' ? 'Approval pending - a request for modify is waiting at the FlexPendant.'
                      : priv === 'pending exec' ? 'Approval pending - a request for exec is waiting at the FlexPendant.'
                      : priv === 'modify'    ? 'Remote-modify granted to this session.'
                      : priv === 'exec'      ? 'Remote execution privilege granted to this session.'
                      : priv === 'unsupported' ? (rw8
                          ? 'RobotWare 8 has no RMMP. Remote writes need control-station write access: Remote Access on at the FlexPendant.'
                          : 'Controller does not expose RMMP.')
                      : `Unknown: ${priv}`;
        vscode.window.showInformationMessage(`RMMP on ${entry.config.name}: ${shown}\n\n${explain}`, { modal: true });
      } catch (e: unknown) { showError('Show RMMP', e, entry); }
    }),

    // ─── Push / Pull workflow - the git story for RAPID files ──────────────
    // The point: edit RAPID at desk, version control it in git, deploy with one
    // command. ABB's RobotStudio doesn't do this naturally - that's our niche.

    tracedCommand('abbRobot.pullAllModules', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = entry.manager;
      if (!active) { vscode.window.showWarningMessage('No active robot.'); return; }
      const taskName = entry.manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';

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
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = entry.manager;
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
      const taskName = entry.manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      // Strip legacy `.controller` / `.from-controller` suffix from the file
      // basename so the displayed module name in the progress / status
      // matches what RAPID will actually call it.
      const moduleName = path.basename(filePath, path.extname(filePath)).replace(/\.(controller|from-controller)$/i, '');

      try {
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pushing ${moduleName}${path.extname(filePath)} to ${taskName}…`, cancellable: false },
          () => withStopOffer('Push current file', stop => active.loadProgram(filePath!, taskName, { stopIfRunning: stop }), entry),
        );
        if (r === CANCELLED) { return; }
        vscode.window.showInformationMessage(`✓ Pushed ${moduleName}${path.extname(filePath)} to ${taskName}.`);
      } catch (e: unknown) { showError('Push current file', e, entry); }
    }),

    tracedCommand('abbRobot.diffWithController', async (arg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = entry.manager;
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
      const taskName = entry.manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
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
      } catch (e: unknown) { showError('Diff with controller', e, entry); }
    }),

    // ─── Module source pull - open a loaded module's RAPID text in an editor tab
    tracedCommand('abbRobot.openModuleSource', async (arg?: unknown, taskArg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      let taskName: string | undefined = typeof taskArg === 'string' && taskArg ? taskArg : undefined;
      if (!moduleName) {
        const picked = await pickLoadedModule(entry.manager.state, 'Pick a loaded module to open');
        if (picked === null) { vscode.window.showWarningMessage('No program modules loaded.'); return; }
        if (!picked) { return; }
        moduleName = picked.name;
        taskName = picked.task;
      }
      if (!taskName) { taskName = taskForModule(entry.manager.state, moduleName); }
      try {
        const source = await entry.manager.getModuleSource(taskName, moduleName);
        await openAsScratchFile(`${moduleName}.mod`, source);
      } catch (e: unknown) {
        // Reading a module's text is a write on the controller: it writes the
        // module to a file on the controller and deletes it afterwards, so
        // it needs the same access as any write.
        showError('Open module source', e, entry, refusalOf(e)
          ? 'Opening a module writes the module to a file on the controller and deletes it afterwards, so it needs write access like any other write.'
          : undefined);
      }
    }),

    // ─── Module text with change count - the optimistic-concurrency handle ──
    tracedCommand('abbRobot.viewModuleText', async (arg?: unknown, taskArg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      let taskName: string | undefined = typeof taskArg === 'string' && taskArg ? taskArg : undefined;
      if (!moduleName) {
        const picked = await pickLoadedModule(entry.manager.state, 'Pick a module to view', true);
        if (picked === null) { vscode.window.showWarningMessage('No modules loaded.'); return; }
        if (!picked) { return; }
        moduleName = picked.name;
        taskName = picked.task;
      }
      if (!taskName) { taskName = taskForModule(entry.manager.state, moduleName); }
      try {
        const { text, changeCount } = await entry.manager.getModuleText(taskName, moduleName);
        await openAsScratchFile(`${moduleName}.mod`, text);
        vscode.window.setStatusBarMessage(`${moduleName}: controller change count ${changeCount}`, 8000);
      // 'View RAPID text', not 'View module text': the isWriteOp heuristic in
      // friendlyErrorMessage keys on 'module' and would give write-op advice
      // (motors on, AUTO mode) for what is a pure read.
      } catch (e: unknown) { showError('View RAPID text', e, entry); }
    }),

    // ─── Service routine call ───────────────────────────────────────────────
    tracedCommand('abbRobot.callServiceRoutine', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const active = entry.manager;
      const taskName = entry.manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      try {
        // RWS has no operation that calls a service routine (the resource is a
        // GET listing; the client's callServiceRoutine throws before sending).
        // A service routine runs by setting the program pointer to it and
        // starting; the start stays with the user, as every motion start does.
        // The pointer moves through setPPToServiceRoutine, which reads the
        // operating mode and the listing first; the controller decides the
        // mode, except that the client holds the move back on RobotWare 8 in
        // Auto.
        await callServiceRoutine(active, taskName, {
          pick: items => vscode.window.showQuickPick(items, { title: 'Service routine', placeHolder: 'Set the program pointer to…' }),
          info: m => { vscode.window.showInformationMessage(m); },
          warn: m => { vscode.window.showWarningMessage(m); },
          movePointer: async run => {
            const ask = whileRunningRequest('Set PP to service routine', isRapidRunning(entry.manager.state.execstate), ['Moves the program pointer to a service routine.']);
            if (ask && !await confirm(entry, ask)) { return false; }
            return await withStopOffer('Set PP to service routine', run, entry) !== CANCELLED;
          },
        });
      } catch (e: unknown) {
        // A mode refusal (the controller's own, or the client's hold on RobotWare 8
        // in Auto) carries its sentence: shown as it is.
        const notManual = modeRefusal(e);
        if (notManual) { vscode.window.showWarningMessage(notManual); return; }
        showError('Call service routine', e, entry);
      }
    }),

    // ─── Backup / Restore ───────────────────────────────────────────────────
    tracedCommand('abbRobot.createBackup', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = await vscode.window.showInputBox({
        prompt: 'Backup name (folder created in BACKUP volume)',
        value: `Backup_${stamp}`,
        validateInput: v => v.trim() ? undefined : 'Required',
      });
      if (!name) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating backup ${name}…` }, async (p) => {
        try {
          await entry.manager.createBackup(name);
          // Poll the backup state - backups can take 30-90 s on real hardware.
          // The state still reads "Backup Ready" from the previous backup for a
          // moment after the 202, so idle counts only once a busy reading was
          // seen (or after the first four polls, for a backup too quick to see).
          let seenBusy = false;
          let failed: string | undefined;
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 1500));
            const s = await entry.manager.getBackupStatus() as { active: boolean; phase?: string; failed?: boolean };
            if (s.failed) { failed = s.phase || 'unknown state'; break; }
            if (s.active) { seenBusy = true; p.report({ message: `${s.phase ?? 'in progress'}…` }); continue; }
            if (seenBusy || i >= 3) { break; }
          }
          if (failed) { throw new Error(`The controller reports the backup state "${failed}".`); }
          vscode.window.showInformationMessage(`✓ Backup "${name}" created.`);
        } catch (e: unknown) { showError('Create backup', e, entry); }
      });
    }),

    tracedCommand('abbRobot.restoreBackup', async (arg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      let name: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      if (!name) {
        try {
          const backups = await entry.manager.listBackups();
          if (backups.length === 0) { vscode.window.showWarningMessage('No backups found.'); return; }
          const pick = await vscode.window.showQuickPick(
            backups.map(b => ({ label: b.name, description: b.created ?? '', detail: b.size != null ? `${b.size} bytes` : '' })),
            { placeHolder: 'Pick backup to restore' },
          );
          if (!pick) { return; }
          name = pick.label;
        } catch (e) { showError('List backups', e, entry); return; }
      }
      const ok = await confirm(entry, {
        label: `Restore backup "${name}"`, tier: 'disruptive',
        sideEffects: [
          'Replaces the controller\'s configuration and programs with the backup.',
          'Keeps the backup on the controller: the restore asks the controller not to delete it.',
          'The controller restarts afterwards; the connection drops until it is back.',
        ],
      });
      if (!ok) { return; }
      try {
        await entry.manager.restoreBackup(name);
        vscode.window.showInformationMessage(`✓ Restore of "${name}" initiated. Controller will restart.`);
      } catch (e: unknown) { showError('Restore backup', e, entry); }
    }),

    // ─── Forward kinematics ─────────────────────────────────────────────────
    tracedCommand('abbRobot.calcFK', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
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
        const target = await entry.manager.calcCartesianFromJoints({
          rax_1: j1, rax_2: j2, rax_3: j3, rax_4: j4, rax_5: j5, rax_6: j6,
        });
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// FK result for joints [${input}]\n${JSON.stringify(target, null, 2)}`,
        });
        await vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('Forward kinematics', e, entry); }
    }),

    // ─── Tool / Wobj activation ─────────────────────────────────────────────
    tracedCommand('abbRobot.setActiveTool', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const tool = await vscode.window.showInputBox({ prompt: 'Tool name (existing persistent tooldata)', placeHolder: 'tool0' });
      if (!tool) { return; }
      const mu = entry.manager.state.mechunits[0] ?? 'ROB_1';
      try { await entry.manager.setActiveTool(mu, tool); vscode.window.showInformationMessage(`✓ Active tool: ${tool}`); }
      catch (e: unknown) { showError('Set active tool', e, entry); }
    }),

    tracedCommand('abbRobot.setActiveWobj', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const wobj = await vscode.window.showInputBox({ prompt: 'Work object name (existing persistent wobjdata)', placeHolder: 'wobj0' });
      if (!wobj) { return; }
      const mu = entry.manager.state.mechunits[0] ?? 'ROB_1';
      try { await entry.manager.setActiveWobj(mu, wobj); vscode.window.showInformationMessage(`✓ Active wobj: ${wobj}`); }
      catch (e: unknown) { showError('Set active wobj', e, entry); }
    }),

    // ─── CFG write ─────────────────────────────────────────────────────────
    tracedCommand('abbRobot.editCfgInstance', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const robotId = entry.id;
      if (!robotId) { vscode.window.showWarningMessage('No robot selected.'); return; }
      const m = entry.manager;
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
      } catch (e: unknown) { showError('Edit CFG instance', e, entry); }
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
        // rdonly and instanceid are instance metadata the controller reports on a read, not attributes to write.
        attrs = writableAttributes(parsed).attrs;
      } catch (e) {
        vscode.window.showErrorMessage(`CFG not written - document is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const ok = await confirm(entry, {
        label: `Write ${target.domain}/${target.type}/${target.instance}`, tier: 'change',
        sideEffects: [
          `Writes ${Object.keys(attrs).length} attribute${Object.keys(attrs).length === 1 ? '' : 's'} of the instance to the controller.`,
          'Most CFG changes need a controller restart to take effect.',
        ],
      });
      if (!ok) { return; }
      try {
        await entry.manager.setCfgInstance(target.domain, target.type, target.instance, attrs);
        vscode.window.showInformationMessage(`✓ Wrote ${target.domain}/${target.type}/${target.instance} to "${robotName}". Most CFG changes need a controller restart to take effect.`);
      } catch (e: unknown) { showError('Write CFG instance', e, entry); }
    }),
    // Stop tracking once the scratch document is closed.
    vscode.workspace.onDidCloseTextDocument(doc => { cfgEditTargets.delete(doc.uri.toString()); }),

    tracedCommand('abbRobot.createCfgInstance', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const m = entry.manager;
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
        // A read returns rdonly and instanceid next to the attributes; a copy of one must not send them.
        const { attrs, removed } = writableAttributes(JSON.parse(attrsJson) as Record<string, unknown>);
        await m.createCfgInstance(domain, type, instance, attrs);
        vscode.window.showInformationMessage(`✓ Created ${domain}/${type}/${instance}.${removed.length ? ` Left out ${removed.join(', ')}: the controller reports them on a read; they are not attributes to write.` : ''}`);
      } catch (e: unknown) { showError('Create CFG instance', e, entry); }
    }),

    tracedCommand('abbRobot.removeCfgInstance', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const m = entry.manager;
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
        const ok = await confirm(entry, {
          label: `Remove CFG instance ${domain}/${type}/${instance}`, tier: 'disruptive',
          sideEffects: [
            `Deletes the instance ${instance} of ${domain}/${type} from the controller's configuration. It cannot be undone.`,
            'Most configuration changes take effect after a controller restart.',
          ],
        });
        if (!ok) { return; }
        await m.removeCfgInstance(domain, type, instance);
        vscode.window.showInformationMessage(`✓ Removed ${domain}/${type}/${instance}.`);
      } catch (e: unknown) { showError('Remove CFG instance', e, entry); }
    }),

    tracedCommand('abbRobot.loadCfgFile', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const filepath = await vscode.window.showInputBox({
        prompt: 'Path to .cfg file on the controller (e.g. $HOME/MOC.cfg)',
        placeHolder: '$HOME/MOC.cfg',
      });
      if (!filepath) { return; }
      const action = await vscode.window.showQuickPick(
        [
          { label: 'add', detail: loadActionDetail('add') },
          { label: 'replace', detail: loadActionDetail('replace') },
          { label: 'add-with-reset', detail: loadActionDetail('add-with-reset') },
        ],
        { placeHolder: 'Load action' },
      );
      if (!action) { return; }
      const ok = await confirm(entry, {
        label: CFG_LOAD_LABEL, tier: 'disruptive',
        sideEffects: [
          `Loads ${filepath} into the configuration (${action.label}): ${action.detail}.`,
          'Most configuration changes take effect after a controller restart.',
        ],
      });
      if (!ok) { return; }
      try {
        await entry.manager.loadCfgFile(filepath, action.label as 'add' | 'replace' | 'add-with-reset');
        vscode.window.showInformationMessage(`✓ Loaded ${filepath} (${action.label}). A controller restart is usually required.`);
      } catch (e: unknown) { showError(CFG_LOAD_LABEL, e, entry, cfgLoadNextStep(e)); }
    }),

    tracedCommand('abbRobot.saveCfgFile', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const domains = await entry.manager.listCfgDomains();
        const domain = await vscode.window.showQuickPick(domains, { placeHolder: 'Pick CFG domain to export' });
        if (!domain) { return; }
        const filepath = await vscode.window.showInputBox({
          prompt: 'Destination path on controller',
          value: `$HOME/${domain}.cfg`,
        });
        if (!filepath) { return; }
        await entry.manager.saveCfgFile(domain, filepath);
        vscode.window.showInformationMessage(`✓ Saved ${domain} domain to ${filepath}.`);
      } catch (e: unknown) { showError('Save CFG file', e, entry); }
    }),

    // ─── DIPC ───────────────────────────────────────────────────────────────
    tracedCommand('abbRobot.dipcListQueues', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const qs = await entry.manager.listDipcQueues();
        if (qs.length === 0) { vscode.window.showInformationMessage('No DIPC queues.'); return; }
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// DIPC queues\n${JSON.stringify(qs, null, 2)}`,
        });
        await vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('List DIPC queues', e, entry); }
    }),

    tracedCommand('abbRobot.dipcCreateQueue', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const name = await vscode.window.showInputBox({ prompt: 'Queue name', validateInput: v => v.trim() ? undefined : 'Required' });
      if (!name) { return; }
      // ABB: the queue size is required, the message size optional on RWS 2.0 and
      // required on RWS 1.0; no defaults are documented, so none are sent.
      const gen = generationOf(entry.manager.state);
      const countStr = await vscode.window.showInputBox({ title: 'DIPC queue size', prompt: dipcCountPrompt(), validateInput: validateDipcCount });
      if (countStr === undefined) { return; }
      const sizeStr = await vscode.window.showInputBox({ title: 'DIPC message size', prompt: dipcSizePrompt(gen), validateInput: v => validateDipcSize(v, gen) });
      if (sizeStr === undefined) { return; }
      try {
        await entry.manager.createDipcQueue(name, {
          maxsize: sizeStr.trim() ? Number(sizeStr) : undefined,
          maxmessages: Number(countStr),
        });
        vscode.window.showInformationMessage(`✓ DIPC queue ${name} created.`);
      } catch (e: unknown) { showError('Create DIPC queue', e, entry); }
    }),

    tracedCommand('abbRobot.dipcSendMessage', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const queues = await entry.manager.listDipcQueues().catch(() => []);
      const queue = queues.length
        ? await vscode.window.showQuickPick(queues.map(q => q.name), { placeHolder: 'Pick a queue' })
        : await vscode.window.showInputBox({ prompt: 'Queue name' });
      if (!queue) { return; }
      const type = await vscode.window.showQuickPick(['string', 'num', 'dnum', 'bool'], { placeHolder: 'Message type' });
      if (!type) { return; }
      const payload = await vscode.window.showInputBox({ prompt: `Message payload (${type})` });
      if (payload === undefined) { return; }
      try {
        await entry.manager.sendDipcMessage(queue, payload, type as 'string' | 'num' | 'dnum' | 'bool');
        vscode.window.showInformationMessage(`✓ Sent to ${queue}: ${payload}`);
      } catch (e: unknown) { showError('Send DIPC message', e, entry); }
    }),

    tracedCommand('abbRobot.dipcReadMessage', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const queues = await entry.manager.listDipcQueues().catch(() => []);
      const queue = queues.length
        ? await vscode.window.showQuickPick(queues.map(q => q.name), { placeHolder: 'Pick a queue' })
        : await vscode.window.showInputBox({ prompt: 'Queue name' });
      if (!queue) { return; }
      try {
        const msg = await entry.manager.readDipcMessage(queue, 5000);
        vscode.window.showInformationMessage(dipcMessageText(msg));
      } catch (e: unknown) { showError('Read DIPC message', e, entry); }
    }),

    tracedCommand('abbRobot.dipcRemoveQueue', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const queues = await entry.manager.listDipcQueues().catch(() => []);
      if (queues.length === 0) { vscode.window.showInformationMessage('No DIPC queues to remove.'); return; }
      const pick = await vscode.window.showQuickPick(queues.map(q => q.name), { placeHolder: 'Queue to remove' });
      if (!pick) { return; }
      try {
        await entry.manager.removeDipcQueue(pick);
        vscode.window.showInformationMessage(`✓ Removed queue ${pick}.`);
      } catch (e: unknown) { showError('Remove DIPC queue', e, entry); }
    }),

    // ─── File volumes / compress / validation ───────────────────────────────
    tracedCommand('abbRobot.listFileVolumes', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        const vols = volumesToShow(generationOf(entry.manager.state), await entry.manager.listFileVolumes());
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: fileVolumesText(vols) });
        await vscode.window.showTextDocument(doc);
      } catch (e: unknown) { showError('List file volumes', e, entry); }
    }),

    tracedCommand('abbRobot.compressPath', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const source = await vscode.window.showInputBox({ prompt: 'Source path on controller', placeHolder: '$HOME/MyDir' });
      if (!source) { return; }
      const dest = await vscode.window.showInputBox({ prompt: 'Destination archive path', placeHolder: '$HOME/MyDir.zip' });
      if (!dest) { return; }
      try {
        // The controller answers 202 and writes the archive in a job after that.
        await entry.manager.compressPath(source, dest);
        vscode.window.showInformationMessage(`✓ Compress started on the controller: ${source} → ${dest}. The archive is there when the job ends.`);
      } catch (e: unknown) { showError('Compress', e, entry); }
    }),

    tracedCommand('abbRobot.validateRapidValue', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = entry.manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      const datatype = await vscode.window.showInputBox({ prompt: 'RAPID datatype', placeHolder: 'num | string | bool | robtarget | …' });
      if (!datatype) { return; }
      const value = await vscode.window.showInputBox({ prompt: `Value to validate as ${datatype}`, placeHolder: '123 | "hello" | TRUE | [[1,2,3],…]' });
      if (value === undefined) { return; }
      try {
        const ok = await entry.manager.validateRapidValue(taskName, value, datatype);
        vscode.window.showInformationMessage(ok ? `✓ Valid ${datatype} literal.` : `✗ Not a valid ${datatype} literal.`);
      } catch (e: unknown) { showError('Validate RAPID value', e, entry); }
    }),

    // ─── Variable watch ──────────────────────────────────────────────────────
    tracedCommand('abbRobot.addWatch', () => watchProvider.addWatch()),

    tracedCommand('abbRobot.addSelectionToWatch', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
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
      const taskName = entry.manager.state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
      await watchProvider.addWatchFromSelection(taskName, moduleName, symbol);
      vscode.window.setStatusBarMessage(`✓ Watching ${moduleName}.${symbol}`, 3000);
    }),
    tracedCommand('abbRobot.removeWatch', (arg: unknown) => watchProvider.removeWatch(arg)),
    tracedCommand('abbRobot.writeWatchValue', (arg: unknown) => watchProvider.writeValue(arg)),
    tracedCommand('abbRobot.clearWatches', () => watchProvider.clearAll()),
    tracedCommand('abbRobot.refreshWatches', () => { watchProvider.forceRefreshNow(); }),

    tracedCommand('abbRobot.activateTask', async (arg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = extractTaskName(arg, entry.manager.state.tasks.filter(t => !t.active).map(t => t.name));
      if (!(await taskName)) { return; }
      const name = (await taskName)!;
      try {
        await entry.manager.activateRapidTask(name);
        vscode.window.showInformationMessage(`✓ Task ${name} activated.`);
      } catch (e: unknown) { showError('Activate task', e, entry); }
    }),

    tracedCommand('abbRobot.deactivateTask', async (arg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const taskName = extractTaskName(arg, entry.manager.state.tasks.filter(t => t.active).map(t => t.name));
      if (!(await taskName)) { return; }
      const name = (await taskName)!;
      try {
        await entry.manager.deactivateRapidTask(name);
        vscode.window.showInformationMessage(`✓ Task ${name} deactivated.`);
      } catch (e: unknown) { showError('Deactivate task', e, entry); }
    }),

    tracedCommand('abbRobot.activateAllTasks', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        await entry.manager.activateAllRapidTasks();
        vscode.window.showInformationMessage('✓ All RAPID tasks activated.');
      } catch (e: unknown) { showError('Activate all tasks', e, entry); }
    }),

    tracedCommand('abbRobot.deactivateAllTasks', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      try {
        await entry.manager.deactivateAllRapidTasks();
        vscode.window.showInformationMessage('✓ All RAPID tasks deactivated.');
      } catch (e: unknown) { showError('Deactivate all tasks', e, entry); }
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
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const m = entry.manager;

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

      const createOk = await confirm(entry, {
        label: `Create RAPID task ${taskName}`, tier: 'disruptive',
        sideEffects: [
          `Writes a new ${type.label} task instance to SYS/CAB_TASKS in the configuration.`,
          'The task appears only after the controller restarts.',
        ],
      });
      if (!createOk) { return; }

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
          // This robot, not whichever is active by now.
          await vscode.commands.executeCommand('abbRobot.restartController', entry.id);
        }
      } catch (e: unknown) { showError('Create RAPID task', e, entry); }
    }),

    tracedCommand('abbRobot.downloadModule', async (arg?: unknown, taskArg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      let moduleName: string | undefined =
        (typeof arg === 'string') ? arg :
        (arg && typeof arg === 'object' && 'label' in arg && typeof (arg as { label: unknown }).label === 'string')
          ? (arg as { label: string }).label : undefined;
      let taskName: string | undefined = typeof taskArg === 'string' && taskArg ? taskArg : undefined;
      if (!moduleName) {
        const picked = await pickLoadedModule(entry.manager.state, 'Pick a module to save', true);
        if (picked === null) { vscode.window.showWarningMessage('No modules loaded.'); return; }
        if (!picked) { return; }
        moduleName = picked.name;
        taskName = picked.task;
      }
      const name = moduleName;
      const task = taskName ?? taskForModule(entry.manager.state, name);
      const fileName = moduleSaveName(name);
      const saveUri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), fileName)), filters: { 'RAPID Module': ['mod'] } });
      if (!saveUri) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Saving ${fileName}…` }, async () => {
        try {
          // The loaded module's text, read as View Module Text reads it - not a
          // file in $HOME (a system module such as BASE has none there).
          await saveModuleText(entry.manager, task, name, text => fs.writeFileSync(saveUri.fsPath, text, 'utf8'));
          const open = await vscode.window.showInformationMessage(`✓ ${fileName} saved.`, 'Open');
          if (open === 'Open') { vscode.window.showTextDocument(saveUri); }
        } catch (e: unknown) { showError(MODULE_SAVE_LABEL, e, entry); }
      });
    }),

    // ─── Controller ──────────────────────────────────────────────────────────

    tracedCommand('abbRobot.getControllerClock', async (arg?: unknown) => {
      const entry = entryOf(multi, arg);
      try {
        const dt = await entry.manager.getControllerClock();
        vscode.window.showInformationMessage(clockReadMessage(dt), 'Copy', 'Set…').then(async c => {
          if (c === 'Copy') { vscode.env.clipboard.writeText(dt); }
          if (c === 'Set…') { vscode.commands.executeCommand('abbRobot.setControllerClock', entry.id); }
        });
      } catch (e: unknown) { showError('Read clock', e, entry); }
    }),

    tracedCommand('abbRobot.setControllerClock', async (arg?: unknown) => {
      const entry = entryOf(multi, arg);
      const input = await vscode.window.showInputBox({
        title: 'Set Controller Clock',
        prompt: clockSetPrompt(),
        value: clockSetDefault(new Date()),
        validateInput: v => parseClockInput(v) ? undefined : 'Format: YYYY-MM-DD HH:MM:SS',
      });
      if (!input) { return; }
      const parts = parseClockInput(input);
      if (!parts) { return; }
      try { await entry.manager.setControllerClock(...parts); vscode.window.showInformationMessage(clockSetDone(input)); }
      catch (e: unknown) { showError('Set clock', e, entry); }
    }),

    tracedCommand('abbRobot.restartController', async (arg?: unknown) => {
      const entry = entryOf(multi, arg);
      const choice = await vscode.window.showQuickPick([
        { label: 'Restart',  value: 'restart' as const, description: 'Normal restart' },
        { label: 'P-Start',  value: 'pstart'  as const, description: 'Preserve params, remove programs' },
        { label: 'I-Start',  value: 'istart'  as const, description: 'Restore original installation' },
        { label: 'B-Start',  value: 'bstart'  as const, description: 'Boot from last auto-save (crash recovery)' },
      ], { title: 'Restart Controller' });
      if (!choice) { return; }
      const ok = await confirm(entry, {
        label: choice.label, tier: 'disruptive',
        sideEffects: restartSideEffects(choice.value),
      });
      if (!ok) { return; }
      try {
        await entry.manager.restartController(choice.value);
        vscode.window.showInformationMessage('Restart command sent. Disconnecting…');
        await endConnection(multi, entry.id);
      } catch (e: unknown) { showError('Restart', e, entry); }
    }),

    // ─── Event log ───────────────────────────────────────────────────────────

    tracedCommand('abbRobot.refreshElog', async () => {
      const entry = activeEntry(multi);
      await entry.manager.refreshEventLog();
      elogProvider.refresh();
    }),

    tracedCommand('abbRobot.clearEventLog', async () => {
      const entry = activeEntry(multi);
      const ok = await confirm(entry, {
        label: 'Clear event log', tier: 'disruptive',
        sideEffects: ['Deletes the messages of event log domain 0 (the common log) on the controller. They cannot be read back afterwards.'],
      });
      if (!ok) { return; }
      try { await entry.manager.clearEventLog(); elogProvider.refresh(); vscode.window.showInformationMessage('Event log cleared.'); }
      catch (e: unknown) { showError('Clear event log', e, entry); }
    }),

    tracedCommand('abbRobot.clearAllEventLogs', async () => {
      const entry = activeEntry(multi);
      const ok = await confirm(entry, {
        label: 'Clear all event logs', tier: 'disruptive',
        sideEffects: ['Deletes the messages of every event log domain on the controller. They cannot be read back afterwards.'],
      });
      if (!ok) { return; }
      try { await entry.manager.clearAllEventLogs(); elogProvider.refresh(); vscode.window.showInformationMessage('All event logs cleared.'); }
      catch (e: unknown) { showError('Clear all logs', e, entry); }
    }),

    tracedCommand('abbRobot.exportEventLog', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const domPick = await vscode.window.showQuickPick(
        [
          { label: 'Domain 0 - common log', value: '0' },
          { label: 'Other domain number…', value: 'ask' },
        ],
        { title: 'Export Event Log (1/2)', placeHolder: 'Which domain?' },
      );
      if (!domPick) { return; }
      let domain = 0;
      if (domPick.value === 'ask') {
        const d = await vscode.window.showInputBox({
          title: 'Event log domain', value: '1',
          validateInput: v => /^\d+$/.test(v.trim()) ? undefined : 'Whole number',
        });
        if (d === undefined) { return; }
        domain = Number(d.trim());
      }
      const fmt = await vscode.window.showQuickPick(
        [{ label: 'JSON', value: 'json' }, { label: 'CSV', value: 'csv' }],
        { title: 'Export Event Log (2/2)', placeHolder: 'File format' },
      );
      if (!fmt) { return; }
      try {
        const log = await entry.manager.getEventLog(domain);
        if (!log.length) { vscode.window.showInformationMessage(`Event log domain ${domain} is empty.`); return; }
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(require('os').homedir(), `eventlog-domain${domain}.${fmt.value}`)),
        });
        if (!saveUri) { return; }
        const content = fmt.value === 'json' ? JSON.stringify(log, null, 2) : elogCsv(log);
        fs.writeFileSync(saveUri.fsPath, content, 'utf8');
        const open = await vscode.window.showInformationMessage(`✓ ${log.length} event-log entries exported.`, 'Open');
        if (open === 'Open') { vscode.window.showTextDocument(saveUri); }
      } catch (e: unknown) { showError('Export event log', e, entry); }
    }),

    // ─── File browser ────────────────────────────────────────────────────────

    tracedCommand('abbRobot.refreshFiles', () => { filesProvider.refresh(); }),

    tracedCommand('abbRobot.createDirectory', async (arg?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
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
      try { await entry.manager.createDirectory(parent, name); vscode.window.showInformationMessage(`Directory '${name}' created in ${parent}.`); filesProvider.refresh(); }
      catch (e: unknown) { showError('Create directory', e, entry); }
    }),

    tracedCommand('abbRobot.downloadControllerFile', async (arg: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
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
          const text = await entry.manager.readFile(node.path);
          fs.writeFileSync(saveUri.fsPath, text, 'utf8');
          const open = await vscode.window.showInformationMessage(`✓ ${node.entry.name} saved.`, 'Open');
          if (open === 'Open') { vscode.window.showTextDocument(saveUri); }
        } catch (e: unknown) { showError('Download file', e, entry); }
      });
    }),

    tracedCommand('abbRobot.openControllerFile', async (arg: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      const node = (arg && typeof arg === 'object' && 'node' in arg)
        ? (arg as { node: { path: string; entry: { name: string } } }).node
        : (arg as { path: string; entry: { name: string } } | undefined);
      if (!node || !node.path || !node.entry) {
        vscode.window.showWarningMessage('Right-click a file in the File Explorer panel to open it.');
        return;
      }
      try {
        const text = await entry.manager.readFile(node.path);
        await openAsScratchFile(node.entry.name, text);
      } catch (e: unknown) { showError('Open controller file', e, entry); }
    }),

    tracedCommand('abbRobot.deleteControllerFile', async (arg: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
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
      const ok = await confirm(entry, {
        label: `Delete ${kind} "${node.entry.name}"`, tier: 'disruptive',
        sideEffects: [isDir
          ? `Deletes the folder ${node.path} and everything inside it from the controller.`
          : `Deletes the file ${node.path} from the controller.`],
      });
      if (!ok) { return; }
      try {
        await entry.manager.deleteControllerFile(node.path);
        vscode.window.showInformationMessage(`${kind} '${node.entry.name}' deleted.`);
        filesProvider.refresh();
      } catch (e: unknown) {
        showError(`Delete ${kind}`, e, entry);
      }
    }),

    tracedCommand('abbRobot.renameControllerFile', async (arg: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // Same TreeItem/FileNode unwrap as delete; rename works for files AND
      // directories (the client's renameFile keeps the parent dir unchanged).
      const node = (arg && typeof arg === 'object' && 'node' in arg)
        ? (arg as { node: { path: string; entry: { name: string; type?: string } } }).node
        : (arg as { path: string; entry: { name: string; type?: string } } | undefined);
      if (!node || !node.path || !node.entry) {
        vscode.window.showWarningMessage('Right-click a file or folder in the File Explorer panel to rename it.');
        return;
      }
      const kind = node.entry.type === 'dir' ? 'folder' : 'file';
      const newName = await vscode.window.showInputBox({
        title: `Rename ${kind}`,
        value: node.entry.name,
        prompt: 'New name (stays in the same directory)',
        validateInput: v => !v.trim() ? 'Name is empty'
          : (v.includes('/') || v.includes('\\')) ? 'Name only - rename cannot move between folders'
          : undefined,
      });
      if (!newName || newName === node.entry.name) { return; }
      try {
        await entry.manager.renameFile(node.path, newName);
        vscode.window.showInformationMessage(`${kind} renamed to '${newName}'.`);
        filesProvider.refresh();
      } catch (e: unknown) { showError(`Rename ${kind}`, e, entry); }
    }),

    // ─── I/O signals ─────────────────────────────────────────────────────────

    tracedCommand('abbRobot.refreshIo', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refreshing I/O…' }, async () => {
        try { await entry.manager.refreshIoSignals(); ioProvider.refresh(); }
        catch (e: unknown) { showError('Refresh I/O', e, entry); }
      });
    }),

    tracedCommand('abbRobot.writeSignal', async (node?: SignalItem | Signal) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
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
      const ok = await confirm(entry, {
        label: `Write ${signalName}`, tier: 'change',
        sideEffects: [`Sets the signal ${signalName} to ${value}${currentValue !== undefined ? ` (now ${currentValue})` : ''}. Whatever the signal drives sees the new value at once.`],
      });
      if (!ok) { return; }
      try { await entry.manager.writeIoSignal(signalName!, value); ioProvider.refresh(); vscode.window.showInformationMessage(`${signalName} = ${value}`); }
      catch (e: unknown) { showError('Write signal', e, entry); }
    }),

    // Also the one-click toggle of a DO in the I/O tree (IoTreeProvider).
    tracedCommand('abbRobot.toggleSignal', async (arg: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { return; }
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
      const next = signal.lvalue === '1' ? '0' : '1';
      const ok = await confirm(entry, {
        label: `Toggle ${signal.name}`, tier: 'change',
        sideEffects: [`Sets the signal ${signal.name} from ${signal.lvalue} to ${next}. Whatever the signal drives sees the new value at once.`],
      });
      if (!ok) { return; }
      try {
        await entry.manager.writeIoSignal(signal.name, next);
        // Keep the caller's Signal object honest: pinned search rows hold a
        // fixed copy that the state refresh never touches, and the NEXT
        // toggle computes its write from this very lvalue.
        signal.lvalue = next;
        ioProvider.refresh();
      }
      catch (e: unknown) { showError('Toggle signal', e, entry); }
    }),

    tracedCommand('abbRobot.searchSignals', async (prefillDevice?: unknown) => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // The controller does the filtering (signal-search endpoint), so this
      // finds signals the polled snapshot may not even contain. A device name
      // can be passed programmatically (the device-search command does this).
      const device = typeof prefillDevice === 'string' ? prefillDevice : undefined;
      // The controller matches the name as a case-insensitive PREFIX, not a
      // substring: "do8" does not find IIO_do8, "IIO_do" does. Live-verified
      // 2026-09-27 on RW 6.16, 7.21 and 8.1.1, base and extended search alike;
      // the same on the newer RW 7.21.4 and 8.2.1 builds (2026-09-29: "Mode",
      // "do8" and "*" all return 0, "Auto" returns only the names starting
      // with it).
      const name = await vscode.window.showInputBox({
        title: device ? `Search Signals on ${device}` : 'Search Signals (server-side)',
        prompt: 'Name prefix - the controller matches names that START with this (case-insensitive), no wildcards',
        // Live-verified: '*' is literal on the controller and matches NOTHING.
        validateInput: v => v.includes('*') ? 'Prefix match - * is literal on the controller and matches nothing' : undefined,
      });
      if (name === undefined) { return; }
      const typePick = await vscode.window.showQuickPick(
        [
          { label: 'All types', value: undefined as string | undefined },
          ...['DI', 'DO', 'AI', 'AO', 'GI', 'GO'].map(t => ({ label: t, value: t as string | undefined })),
        ],
        { placeHolder: 'Filter by signal type' },
      );
      if (!typePick) { return; }
      try {
        const criteria: { name?: string; device?: string; type?: string } = {};
        if (name.trim()) { criteria.name = name.trim(); }
        if (device) { criteria.device = device; }
        if (typePick.value) { criteria.type = typePick.value; }
        if (Object.keys(criteria).length === 0) {
          // Not a controller rule: an empty signal search is accepted and
          // returns EVERY signal (live-verified 2026-09-27 on RW 6.16, 7.21 and
          // 8.1.1, again 2026-09-29 on RW 7.21.4 and 8.2.1). RWS 2.0 pages it
          // at 100, but the page boundary was seen on RW 8.1.1 only (141
          // signals: 100 rows plus a next link, then 41); the other OmniCore
          // VCs held fewer than 100 (RW 7.21.0: 64 signals on 2026-09-27; the
          // RW 7.21.4 build: 65 and the RW 8.2.1 build: 94 on 2026-09-29), so
          // their empty searches fit in one page and paging on those builds is
          // unobserved, not absent. Pinning the whole list at the top of the
          // I/O tree is useless, so the guard stays - the message just must not
          // blame the controller.
          vscode.window.showWarningMessage('Give a name or pick a type - an empty search would list every signal; use the I/O tree for that.');
          return;
        }
        const results = await entry.manager.searchSignals(criteria);
        // The I/O panel shows the active robot: results that arrive after a switch belong to the robot that ran the search, so they are not pinned under the new one.
        if (!isActiveEntry(multi, entry)) {
          vscode.window.showInformationMessage(`${results.length} signal(s) matched on ${entry.config.name}; not pinned because the active robot changed. Make ${entry.config.name} active and search again to pin them.`);
          return;
        }
        const label = [criteria.name, criteria.type, device].filter(Boolean).join(' · ') || 'all';
        ioProvider.setSearch(results, label);
        vscode.window.showInformationMessage(`${results.length} signal(s) matched - pinned at the top of the I/O panel.`);
      } catch (e: unknown) { showError('Signal search', e, entry); }
    }),

    tracedCommand('abbRobot.clearSignalSearch', () => { ioProvider.clearSearch(); }),

    tracedCommand('abbRobot.searchIoDevices', async () => {
      const entry = activeEntry(multi);
      if (!entry.manager.state.connected) { vscode.window.showWarningMessage('Connect first.'); return; }
      // How the device search matches its name field (prefix, whole value,
      // substring, wildcards) has not been verified live, so the prompt does
      // not claim a rule. The signal search's name is a prefix match and its
      // '*' matches nothing (see above); the device search is a different
      // query-action and was never sent a wildcard, so nothing is said here.
      const name = await vscode.window.showInputBox({
        title: 'Search I/O Devices',
        prompt: 'Device name - optional if you pick a state next',
      });
      if (name === undefined) { return; }
      const statePick = await vscode.window.showQuickPick(
        [
          { label: 'Any state', value: undefined as ('enabled' | 'disabled' | 'unknown') | undefined },
          { label: 'enabled', value: 'enabled' as const },
          { label: 'disabled', value: 'disabled' as const },
          { label: 'unknown', value: 'unknown' as const },
        ],
        { placeHolder: 'Filter by logical state' },
      );
      if (!statePick) { return; }
      try {
        const criteria: { name?: string; lstate?: 'enabled' | 'disabled' | 'unknown' } = {};
        if (name.trim()) { criteria.name = name.trim(); }
        if (statePick.value) { criteria.lstate = statePick.value; }
        if (Object.keys(criteria).length === 0) {
          // Unlike the signal search, the controller's device search DOES
          // refuse an empty criteria set: 400 "device name (or) device lstate
          // is needed" (live-verified 2026-08-11 on RW 6.16 and RW 7.21, as
          // recorded in the client's paths/io.ts; no RW 8.x build is recorded
          // for this endpoint - neither the 2026-09-27 nor the 2026-09-29 pass
          // sent it), and the client throws INVALID_ARGUMENT before it even
          // hits the wire on every version, which is what the user sees.
          vscode.window.showWarningMessage('Give a name or pick a state - the controller refuses an empty device search (name or state is required).');
          return;
        }
        const devices = await entry.manager.searchIoDevices(criteria);
        if (!devices.length) { vscode.window.showInformationMessage('No I/O devices matched.'); return; }
        const pick = await vscode.window.showQuickPick(
          devices.map(d => ({ label: d.name, description: `${d.network} · ${d.lstate}/${d.pstate} · ${d.address}`, device: d })),
          { placeHolder: `${devices.length} device(s) - pick one to search its signals` },
        );
        if (!pick) { return; }
        await vscode.commands.executeCommand('abbRobot.searchSignals', pick.device.name);
      } catch (e: unknown) { showError('Device search', e, entry); }
    }),

  ); // end subscriptions.push
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The slice of RobotState the module/task helpers below need. */
type ModuleState = {
  modules: string[];
  tasks: Array<{ name: string; active: boolean }>;
  modulesByTask?: Record<string, string[]>;
};

/**
 * MultiMove controllers run several active tasks, each with its own module
 * set (state.modulesByTask). Resolve which task a module belongs to: an
 * explicit task wins, then the first task that lists the module, then the
 * primary active task (which is the whole story on single-task systems).
 */
function taskForModule(state: ModuleState, moduleName: string, explicit?: unknown): string {
  if (typeof explicit === 'string' && explicit) { return explicit; }
  for (const [task, mods] of Object.entries(state.modulesByTask ?? {})) {
    if (mods.includes(moduleName)) { return task; }
  }
  return state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
}

/** Every loaded module across all active tasks, tagged with its task. */
function loadedModules(state: ModuleState): Array<{ task: string; name: string }> {
  const byTask = state.modulesByTask ?? {};
  if (Object.keys(byTask).length === 0) {
    const task = state.tasks.find(t => t.active)?.name ?? 'T_ROB1';
    return state.modules.map(name => ({ task, name }));
  }
  return Object.entries(byTask).flatMap(([task, mods]) => mods.map(name => ({ task, name })));
}

function isModuleLoaded(state: ModuleState, moduleName: string): boolean {
  return loadedModules(state).some(m => m.name === moduleName);
}

const SYSTEM_MODULES = new Set(['BASE', 'user', 'DPUSER', 'DPBASE']);

/**
 * Quick-pick a loaded module. Returns null when there is nothing to pick,
 * undefined when the user cancelled. Shows the owning task when more than
 * one task has modules (MultiMove), since the same name can live in both.
 */
async function pickLoadedModule(state: ModuleState, placeHolder: string, includeSystem = false): Promise<{ task: string; name: string } | null | undefined> {
  const all = loadedModules(state).filter(m => includeSystem || !SYSTEM_MODULES.has(m.name));
  if (all.length === 0) { return null; }
  const multiTask = new Set(all.map(m => m.task)).size > 1;
  const pick = await vscode.window.showQuickPick(
    all.map(m => ({ label: m.name, description: multiTask ? m.task : undefined, module: m })),
    { placeHolder },
  );
  return pick?.module;
}

/**
 * CSV for event-log export - quotes escaped, one line per entry, and cells
 * that a spreadsheet would evaluate as a formula (=, +, @, or a non-numeric
 * leading -) get a leading apostrophe so controller-originated text cannot
 * execute on open (CSV injection).
 */
function elogCsv(log: Array<{ seqnum?: number; timestamp?: string; msgtype?: number | string; code?: number; title?: string; desc?: string; srcName?: string; causes?: string; consequences?: string; actions?: string }>): string {
  const esc = (v: unknown) => {
    let s = String(v ?? '');
    if (/^[=+@]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) { s = `'${s}`; }
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = log.map(m => [m.seqnum, m.timestamp, m.msgtype, m.code, m.srcName, m.title, m.desc, m.causes, m.consequences, m.actions].map(esc).join(','));
  return ['seqnum,timestamp,msgtype,code,srcName,title,desc,causes,consequences,actions', ...rows].join('\n');
}

/**
 * The refusal an error from the client carries (`RwsError.refusal`): what is
 * missing, who can supply it and a whole sentence for a person. Absent for
 * errors that are not refusals (a missing resource, a network failure).
 */
function refusalOf(e: unknown): RwsRefusal | undefined {
  const r = (e as { refusal?: unknown } | null | undefined)?.refusal;
  return r && typeof r === 'object' && typeof (r as RwsRefusal).sentence === 'string' ? r as RwsRefusal : undefined;
}

/** The RobotWare generation of a robot's session, once known. */
function generationOf(state?: RobotState): 'rw6' | 'rw7' | 'rw8' | null {
  return state?.access?.generation ?? null;
}

const STOP_AND_CONTINUE = 'Stop Program and Continue';
const CANCELLED: unique symbol = Symbol('cancelled');

/**
 * Run a write that may be refused while the program runs. The client sends it
 * and the controller decides; when it is refused for that reason, ask the user
 * whether to stop the program; only on a yes is it made again with
 * `stopIfRunning: true`. Any other error is rethrown.
 */
async function withStopOffer<T>(what: string, fn: (stopIfRunning: boolean) => Promise<T>, entry: RobotEntry): Promise<T | typeof CANCELLED> {
  try {
    return await fn(false);
  } catch (e) {
    if (!isProgramRunningRefusal(e)) { throw e; }
    const choice = await vscode.window.showWarningMessage(
      `${what} on ${robotLabel(confirmRobotOf(entry))}: the RAPID program is running. Stop the program first?`,
      { modal: true, detail: stopOfferDetail(e) },
      STOP_AND_CONTINUE,
    );
    if (choice !== STOP_AND_CONTINUE) { return CANCELLED; }
    return await fn(true);
  }
}

/**
 * The message for an error on one robot. An error the client explains
 * (`RwsError.refusal`) is shown with the client's own sentence - the missing
 * condition, who can supply it and the controller's answer - and that
 * decides first. The patterns below are hints for errors that are not
 * refusals (a busy controller, a missing program pointer, a missing path);
 * nothing here guesses a refusal from a status code or the robot's state.
 */
function friendlyErrorMessage(label: string, e: unknown, state?: RobotState, robot: RobotFacts = {}): string {
  const raw = e instanceof Error ? e.message : String(e);
  const gen = generationOf(state);

  const refusal = refusalOf(e);

  // -1073442802 / icode -519 → Semantic error on a program pointer move or a
  // start. The most common cause is a `main` proc collision: two loaded
  // modules each define PROC main(), so the controller's program is in a
  // "two main" semantic error and rejects ALL PP-to-Routine calls (even to
  // other routines). The client explains it as a refusal too, but its
  // sentence cannot know about the second main; this one can. A load that
  // ended this way reports what it did first (and the name the controller
  // gave the module); semanticErrorText keeps that report. A value write
  // refused this way is a type mismatch, which the client types
  // INVALID_ARGUMENT - that one keeps the client's own text.
  if (isSemanticError(e) && (e as { code?: string })?.code !== 'INVALID_ARGUMENT') {
    return semanticErrorText(label, raw, refusal ? refusalMessage(label, raw, refusal, gen, robot) : undefined);
  }

  if (refusal) {
    // The client's message is the sentence followed by the controller detail;
    // RAPID Live adds its own note where it has one (see refusalMessage).
    return refusalMessage(label, raw, refusal, gen, robot);
  }

  // The two configuration codes with no refusal from the client: RAPID Live's own
  // sentence. The bundled client explains both, so its sentence above comes first.
  const cfgOwn = cfgFallbackMessage(label, e);
  if (cfgOwn) { return cfgOwn; }

  // A clock write answered 405: a virtual controller does not take it.
  if (clockWriteRefused(e)) { return clockWriteRefusedMessage(label, /virtual/i.test(state?.identity?.type ?? '')); }

  if (raw.includes('HTTP 503') || raw.toLowerCase().includes('too many sessions')) {
    return `${label} failed: controller is busy or session pool is full. Wait 30 s and retry, or restart the VC.`;
  }

  // RAPID-specific patterns (each matches a specific controller error code).

  // -1073442809 = "Current execution state does not allow this operation"
  // → user clicked Start without setting PP first
  if (raw.toLowerCase().includes('current execution state does not allow') || raw.includes('-1073442809')) {
    return `${label} blocked - RAPID is in an invalid state to start. Click "PP to Main" first to set the program pointer, then Start.`;
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

/**
 * Show an error from one robot. `entry` is the robot the call went to,
 * resolved by the handler before it sent anything: the message reads that
 * robot's state and every button acts on that robot, whichever one is active
 * by the time the dialog is answered. `note` is added after the message,
 * unless the message already carries it.
 */
function showError(label: string, e: unknown, entry?: RobotEntry, note?: string) {
  const state = entry?.manager.state;
  // A robot that registers as a fixed control station gets no Allow Motion Control: the
  // message names the FlexPendant and no button offers it.
  const robot: RobotFacts = { fixedStation: entry ? fixedStation(entry) : false };
  // Log into the trace file so the trace reflects what the user saw,
  // even when the error was caught/handled gracefully (won't propagate to tracedCommand).
  // Captures both the RAW error (for diagnosis) and the FRIENDLY message
  // (so we can verify the user-facing text matches what was actually shown).
  // The dialog names the robot first, so the operator sees which one refused.
  const friendly = withNote((entry ? `${robotLabel(confirmRobotOf(entry))}: ` : '') + friendlyErrorMessage(label, e, state, robot), note);
  const raw      = e instanceof Error ? e.message : String(e);
  const refusal  = refusalOf(e);
  const code     = (e as { code?: string } | null | undefined)?.code;
  Logger.trace('error.shown', label, {
    friendly,
    raw,
    httpStatus:  (e as { httpStatus?: number })?.httpStatus,
    rwsCode:     code,
    rwsDetail:   (e as { rwsDetail?: string })?.rwsDetail?.slice(0, 300),
    controllerCode: (e as { controllerCode?: number })?.controllerCode,
    refusalKind: refusal?.kind,
    grantor:     refusal?.grantor,
    robot:       entry?.config.name,
    opmode:      state?.opmode,
    ctrlstate:   state?.ctrlstate,
    execstate:   state?.execstate,
  });
  Logger.error(label, e);

  if (!entry) { vscode.window.showErrorMessage(friendly); return; }

  // Buttons follow the refusal the client explained, never a guess from the
  // message text (see refusalButtons), and act on this entry's robot.
  const gen = generationOf(state);
  const buttons = refusalButtons(refusal, gen, entry.config.name, code, robot);
  void vscode.window.showErrorMessage(friendly, ...buttons.map(b => b.label)).then(async choice => {
    const button = buttons.find(b => b.label === choice);
    if (!button) { return; }
    switch (button.action) {
      case 'declare-motion-control': {
        // The Allow command for the robot that refused; the person runs the refused command again.
        const allow = allowFromRefusal(refusal, label);
        await allowFor(entry, allow.origin, allow.remedy);
        return;
      }
      case 'request-rmmp':
        if (button.level) { await requestRmmpInteractive(entry, { level: button.level, refused: { request: refusal?.controller?.request, level: button.level } }); }
        return;
      case 'show-holder': await showAccessHolder(entry); return;
      case 'release-own': await releaseOwnLocks(entry); return;
    }
  });
}

/** Release the locks this tool's own session holds on that robot; never another holder's. */
async function releaseOwnLocks(entry: RobotEntry): Promise<void> {
  try {
    await entry.manager.releaseMastershipAll();
    vscode.window.showInformationMessage(`Released this tool's own locks on ${entry.config.name}. Now retry the operation.`);
  } catch (releaseErr) {
    vscode.window.showWarningMessage(
      `${entry.config.name} refused the release. A hold by another client or the FlexPendant can only be released there.`,
      { modal: true },
    );
    Logger.warn(`release of this tool's locks on ${entry.config.name} failed: ${String(releaseErr)}`);
  }
}

/**
 * Show who holds the access on that robot: RAPID (edit) mastership on
 * RobotWare 6/7, the control-station write access on RobotWare 8 (the
 * station's name only; its id is never shown). The FlexPendant is named "the
 * FlexPendant" on both, for RobotWare 7's `TPU` and RobotWare 8's station
 * `FlexPendant` alike.
 */
async function showAccessHolder(entry: RobotEntry): Promise<void> {
  const name = entry.config.name;
  try {
    if (generationOf(entry.manager.state) === 'rw8') {
      const status = await entry.manager.getWriteAccessStatus();
      vscode.window.showInformationMessage(writeAccessHolderText(name, status), { modal: true });
      return;
    }
    const status = await entry.manager.getMastershipStatus('rapid');
    if (!status) {
      vscode.window.showInformationMessage(`${name} does not answer a mastership status query.`);
      return;
    }
    vscode.window.showInformationMessage(mastershipHolderText(name, status), { modal: true });
  } catch (queryErr) {
    Logger.warn(`access holder read on ${name} failed: ${String(queryErr)}`);
    vscode.window.showWarningMessage(`Could not read who holds the access on ${name}: ${queryErr instanceof Error ? queryErr.message : String(queryErr)}`);
  }
}

/**
 * Ask for RMMP (Request Manual Mode Privileges, RobotWare 6/7) and wait for the operator at the
 * FlexPendant. The client polls the request and resolves with the outcome;
 * the notification can be cancelled, which withdraws the request.
 * RobotWare 8 has no RMMP: write access comes from Remote Access at the
 * FlexPendant, so nothing is sent there.
 *
 * `level` is the palette's pick, or the level the client's `request-rmmp`
 * remedy names for a refused operation (the error dialog's button); `refused`
 * is that operation (`METHOD /path` and its level), for what the grant message
 * says.
 */
async function requestRmmpInteractive(entry: RobotEntry, opts: { level: RmmpLevelChoice; refused?: { request?: string; level: RmmpLevelChoice } }): Promise<void> {
  const active = entry.manager;
  const gen = generationOf(active.state);
  if (gen === 'rw8') {
    vscode.window.showInformationMessage(
      `${entry.config.name} runs RobotWare 8, which has no RMMP. Remote writes need control-station write access, which the operator allows by turning on Remote Access at the FlexPendant.`,
    );
    return;
  }
  const level: RmmpLevelChoice = opts.level;
  let before: string;
  try { before = await active.getRmmpPrivilege(); }
  catch (e) { showError('Read RMMP', e, entry); return; }
  if (before === 'exec' || (before === 'modify' && level === 'modify')) {
    vscode.window.showInformationMessage(`Remote control is already granted to this session on ${entry.config.name} (${before}). ${rmmpGrantedText(entry.config.name, before, gen, opts.refused)}`);
    return;
  }
  if (before === 'unsupported') {
    vscode.window.showInformationMessage('This controller does not offer RMMP.');
    return;
  }
  let result: RmmpResult;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Requesting ${level} privileges (RMMP) on ${entry.config.name}`, cancellable: true },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return active.requestRmmp(level, {
          signal: ac.signal,
          onPending: () => progress.report({ message: 'waiting for the operator to grant it at the FlexPendant…' }),
        });
      },
    );
  } catch (e) {
    showError('Request RMMP', e, entry);
    return;
  }
  switch (result.outcome) {
    case 'granted':
      vscode.window.showInformationMessage(rmmpGrantedText(entry.config.name, result.privilege ?? level, gen, opts.refused));
      break;
    case 'denied':
    case 'expired':
      // The client's next step after the sentence: after a denial, speak to the operator first.
      // Nothing asks again on its own.
      vscode.window.showWarningMessage(rmmpOutcomeText(result.refusal, result.detail));
      break;
    case 'cancelled':
      vscode.window.showInformationMessage('RMMP request cancelled; the request at the FlexPendant was withdrawn.');
      break;
    case 'held-lower':
      // This session holds modify and exec was asked for: nothing was sent.
      vscode.window.showWarningMessage(result.detail);
      break;
  }
}

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
/** The loaded program modules of a task that define `main` (reads only). */
async function modulesWithMain(robot: RobotManager, taskName: string): Promise<string[]> {
  const sysMods = new Set(['BASE', 'user', 'DPUSER', 'DPBASE']);
  const withMain: string[] = [];
  for (const m of robot.state.modules.filter(x => !sysMods.has(x))) {
    try {
      const routines = await robot.listRoutines(taskName, m);
      if (routines.some(r => r.name.toLowerCase() === 'main')) { withMain.push(m); }
    } catch { /* skip - module might be in a state we can't query */ }
  }
  return withMain;
}

/**
 * `approved`: modules a confirmation the user already answered named as the
 * ones that would be unloaded; a single such module is unloaded without
 * asking again.
 */
async function tryResolveMainCollision(
  robot: import('abb-rws-client').RobotManager,
  taskName: string,
  currentModule: string,
  err: unknown,
  entry: RobotEntry,
  approved: string[] = [],
): Promise<boolean> {
  if (!isSemanticError(err)) { return false; }

  // Find every loaded program module that defines `main`
  const withMain = await modulesWithMain(robot, taskName);
  if (withMain.length < 2) { return false; }   // not a main collision after all

  const others = withMain.filter(m => m !== currentModule);
  let toUnload: string | undefined;

  if (others.length === 1 && approved.includes(others[0])) {
    toUnload = others[0];
  } else if (others.length === 1) {
    const choice = await vscode.window.showWarningMessage(
      `On ${robotLabel(confirmRobotOf(entry))}: two modules each define PROC main(): "${currentModule}" and "${others[0]}". ` +
      `RAPID needs exactly one. Unload "${others[0]}"?`,
      { modal: false }, 'Unload', 'Cancel',
    );
    if (choice !== 'Unload') { return false; }
    toUnload = others[0];
  } else {
    const pick = await vscode.window.showQuickPick(
      withMain.map(m => ({ label: m, description: m === currentModule ? '(current - keep)' : 'unload this one' })),
      { placeHolder: `${entry.config.name}: ${withMain.length} modules have PROC main(). Pick one to UNLOAD.` },
    );
    if (!pick || pick.label === currentModule) { return false; }
    toUnload = pick.label;
  }

  try {
    const mod = toUnload;
    if (await withStopOffer(`Unload ${mod}`, stop => robot.unloadModule(taskName, mod, { stopIfRunning: stop }), entry) === CANCELLED) { return false; }
    vscode.window.setStatusBarMessage(`✓ Unloaded "${toUnload}" - retrying…`, 3000);
    return true;
  } catch (e) {
    showError(`Unload ${toUnload}`, e, entry);
    return false;
  }
}

async function wrap(title: string, fn: () => Promise<void>, successMsg: string, entry?: RobotEntry) {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
    try { await fn(); vscode.window.showInformationMessage(successMsg); }
    catch (e: unknown) { showError(title.replace('…', ''), e, entry); }
  });
}

// ─── Deactivate ──────────────────────────────────────────────────────────────

export async function deactivate() {
  robotListSync = undefined;
  // Every robot at once: each sends its RobotWare 8 motion-control withdrawal as its first
  // request, so all of them go out before any slow step of any robot's teardown. The window is
  // closing, so no notices; the extension log has the client's lines.
  motionTracker.closing = true;
  if (globalMulti) {
    await globalMulti.disconnectAll().catch(() => {});
    globalMulti = undefined;
  }
}
