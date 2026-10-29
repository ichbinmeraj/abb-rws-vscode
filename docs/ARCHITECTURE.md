# abb-rws-vscode - Architecture

> "RAPID Live for ABB Robots" (`package.json` id `merajsafari.abb-rws`; this map is a
> 2026-07 snapshot of **v0.9.2**). A GUI + RAPID language server over the
> `abb-rws-client` library, connecting to live IRC5 (RWS 1.0) and OmniCore (RWS 2.0)
> controllers. Bundled with esbuild into a single `dist/extension.js`.

Produced by a full read of every source, manifest, doc, and test-script file on
2026-07-02. Line numbers refer to that snapshot. Claims marked **(inferred)** were not
directly verified.

---

## 1. Overview

The extension is a thin-ish GUI layer plus a from-scratch RAPID language server. All
controller access flows through **one** `MultiRobotManager` (from `abb-rws-client`); the
extension itself does **no** polling - the client library polls and the extension reacts
to `multi.onDidChange`.

```
                          extension.ts  (activate: 2,723 lines)
   ┌──────────────┬─────────────┬──────────────┬───────────────┬──────────────┐
   │ 5 activity-  │ ~97 commands │ status bar   │ RAPID language│ Logger →     │
   │ bar views    │ (abbRobot.*) │ (3 pills)    │ features (13) │ setLogger()  │
   └──────┬───────┴──────┬──────┴──────────────┴───────┬───────┴──────────────┘
          │              │                             │
   ┌──────┴───────┐  ┌───┴──────────────┐      ┌───────┴────────────┐
   │ tree/webview │  │ MultiRobotManager │      │ RapidLanguageIndex  │
   │ providers    │──│      (multi)      │      │ + 705-entry JSON DB │
   └──────────────┘  └───────┬──────────┘      └────────────────────┘
                             │ multi.active → RobotManager
                     ┌───────┴────────┐
                     │  abb-rws-client │  (file: tarball dependency)
                     └────────────────┘
```

Key seam: providers that only render state get `multi` typed as `any` (the
**multi-as-any seam**, `extension.ts:371-379`); providers that call *methods* must go
through `multi.active` (a `RobotManager`), because `MultiRobotManager` proxies `state`
and `listDirectory` but not the ~120 other methods. Calling a manager method directly on
`multi` compiles (it's `any`) but throws at runtime - a bug that has bitten this codebase
before (`ModulesTreeProvider.ts:107-111`, `CHANGELOG.md:176`).

---

## 2. The `contributes` block

### Views - 5 panels in one activity-bar container (`abbRobot`)

| View id | Kind | Backed by | Notes |
|---|---|---|---|
| `abbRobot.robots` | tree | `RobotsTreeProvider` | multi-robot roster + "Add Robot…" |
| `abbRobot.liveCell` | webview | `LiveCellWebviewProvider` | read-only at-a-glance dashboard |
| `abbRobot.program` | webview | `TabbedProgramWebviewProvider` | tabbed: Modules + Watch |
| `abbRobot.controllerData` | tree | `CompositeTreeProvider([files, io, cfg])` | merged under `── Section ──` headers |
| `abbRobot.diagnostics` | tree | `CompositeTreeProvider([elog, status, motion, rapid])` | merged |

Wiring is `extension.ts:385-431`. `viewsWelcome` provides empty-state content for all 5,
gated on the `abbRobot.connected` context key (`package.json:780-805`).

### Commands - 97 in the manifest (`package.json:163-743`)

All prefixed `abbRobot.`, category "ABB Robot". Grouped: robot management (add/remove/
connect/disconnect/setActive/configure), RAPID execution (start/stop/resetRapid/ppToMain/
setPPToRoutine/setExecutionCycle), modules (upload/unload/open/download/pullAll/push/diff),
tasks (activate/deactivate ± all, createRapidTask), watch (add/remove/clear/edit/refresh),
RMMP (requestRmmp/showRmmpStatus), service+backup, kinematics (calcIK/calcFK), tool/wobj,
CFG (edit/create/remove/load/save/browse), DIPC (5), files, panel (motorsOn/Off/speed/
lockOpMode/unlockOpMode/setOpMode), variables, diagnostics, jog (5), I/O, clock/restart.
`extension.ts` registers ~90 handlers; a few (`abbRobot.jog`, `cfgOpenInstance`,
`setPPFromCodeLens`, `runRoutineFromCodeLens`) are programmatic-only and still appear in
the palette (no `commandPalette` menu gating).

### Configuration (`package.json:79-161`)

`abbRobot.robots` (array of `{id,name,host,username,password}` - **passwords in plaintext
settings, no SecretStorage**), legacy single-robot `abbRobot.host/username/password`,
`abbRobot.refreshInterval` (default 1000 ms, min 200), and `abbRobot.jog.increment/speed/
mode`. Discovery: `abbRobot.discoveryManual` (saved addresses), `abbRobot.discoveryRanges`
(saved ranges, scanned only when picked, after a confirm) and `abbRobot.discoveryPorts`, all
`"scope": "machine"` so workspace settings cannot set them.

### Menus (`package.json:870-1155`)

`editor/context` + `editor/title` + `explorer/context` for push/diff/add-to-watch on
`.mod/.sys/.prg` (excluding the read-only `abb-controller` scheme); `view/title`
per-view action buttons; `view/item/context` keyed on `contextValue` strings
(`robot.connected[.active]`, `programModule`, `systemModule`, `controllerFile`,
`controllerDir`, `signalWritable`, `rapidTaskActive/Inactive`, `watchEntry`).

### Languages / grammar / snippets / walkthroughs

RAPID language for `.mod/.sys/.prg` with `language-configuration.json`, TextMate grammar
`syntaxes/rapid.tmLanguage.json`, 20 snippets (`snippets/rapid.json`), and one 5-step
walkthrough `rapidLiveQuickStart` (add → connect → open → push → watch).

### Activation

`activationEvents: []` - VS Code ≥1.74 auto-generates activation from contributed
commands/views. There is **no** `onLanguage:rapid` event, so language features may not
activate on merely opening a `.mod` file until a command/view is used **(open question -
see §8)**.

---

## 3. Activation lifecycle (`extension.ts:350-549`)

1. `setLogger(Logger)` - routes all `abb-rws-client` logging (including HTTP wire traces)
   into the extension's `Logger` (`extension.ts:353-360`).
2. `MultiRobotManager.fromConfigs(loadConfigs(cfg))` - built from `abbRobot.robots`;
   `migrateLegacyRobot` first moves legacy single-robot settings (a host the user set) into
   `abbRobot.robots` as id `default`, its password into SecretStorage, then removes the legacy
   settings (`src/robotSettings.ts`); `loadConfigs` reads them only if that move failed.
   Stored in module-level `globalMulti`. The list is shared with other windows, hand edits
   and Settings Sync: every save (`changeSavedRobots`, over `saveRobotEdit`) reads the stored
   list again and changes only its own robot by id, and undoes its in-memory step when the
   settings write fails; a change of `abbRobot.robots` is applied to `multi` by id
   (`applyStoredRobots`, over `applyStoredList`), one at a time with the saves
   (`RobotListSync`). Both take the settings and the robots as arguments, so
   `test/robotSettings.test.ts` runs them in node. A connected robot keeps the address it
   connected to: the confirmations name the session's address (`confirmRobot`).
3. `multi.onError(...)` - surfaces the client's "3 failed polls → auto-disconnect" as VS
   Code dialogs (L366-368).
4. Provider construction (L371-383). Seven providers receive `const m = multi as any`
   (status/motion/rapid/modules/elog/files/io); the rest get typed `multi`.
5. View + language-feature + status-bar registration (L385-498).
6. `void rapidIndex.start()` - fire-and-forget workspace `.mod` scan (L470-472).
7. `multi.onDidChange` master handler refreshes all 9 providers + status bar + the
   `abbRobot.connected` context key (L501-549).
8. One giant `context.subscriptions.push(...)` of every command (L587-2383).

`deactivate()` (L2716-2723) disconnects every robot, swallowing errors.

---

## 4. Module map

### Entry point
- **`extension.ts`** (2,723) - everything in §3, all command handlers, and the shared
  helpers: `friendlyErrorMessage` (ABB-error-code knowledge base, L2393-2472), `showError`
  (mastership/RMMP recovery dialogs, L2474-2574), `tracedCommand` wrapper (L560-585),
  `tryResolveMainCollision` (two-main `-519` auto-recovery, L2655-2705), `openAsScratchFile`
  (controller text → real workspace file, L2597-2621).
- **`AddRobotDiscovery.ts`** - the non-UI half of the Add Robot flow (no `vscode` import):
  discovery settings, address/range parsing, `findControllers` options, the confirm gate
  before every range scan, result → picker rows, and the settings writes that remove saved
  addresses and ranges (per scope, only the two saved lists). Unit-tested under `test/`.

### Tree providers (`src/*TreeProvider.ts`, `FileExplorerProvider.ts`)
| Provider | Renders | Manager access | Async client calls |
|---|---|---|---|
| `RobotsTreeProvider` | robot roster | typed `multi` (roster/state) | none (sync) |
| `StatusTreeProvider` | ctrl state rows | `multi as any` (reads `.state`) | none |
| `MotionTreeProvider` | joints/TCP/jog block | `multi as any` (reads `.state`) | none (actions via commands) |
| `RapidTreeProvider` | PP-to-main + task list | `multi as any` (reads `.state`) | none |
| `ElogTreeProvider` | event log | `multi as any` (reads `.state`) | none |
| `IoTreeProvider` | signals grouped DI/DO/… | `multi as any` (reads `.state`) | none |
| `FileExplorerProvider` | `$HOME` file tree | `multi as any` | **`listDirectory` directly on the injected manager** (L63) |
| `CfgTreeProvider` | CFG domain→type→instance | typed `multi`, via `.active` | `listCfg*` on `.active` |
| `VariableWatchProvider` | watch list + polling | typed `multi`, via `.active` | `getRapidVariable`/`setRapidVariable` on `.active` |
| `ModulesTreeProvider` | tasks→modules→routines | `multi as any`, via `.active` | **dead - constructed, never registered (§7)** |
| `CompositeTreeProvider` | merges N providers under headers | - | delegates to children |

### Webviews & decorations
- `TabbedProgramWebviewProvider` (1,118) - the Program panel. Tabs Modules + Watch; inline
  HTML string with CSP; message protocol `{type:'command',name,args}` →
  `executeCommand`, `{type:'expandModule'}` → routine fetch. Per-`${task}:${module}`
  routine cache; proactive two-main `-519` collision banner. Only the **active** task
  shows modules (`L192-198`).
- `LiveCellWebviewProvider` (344) - read-only dashboard; posts state on `onDidChange`,
  never posts back. (Header mockup advertises tool/wobj that isn't rendered - dead
  `active` var, L88-90.)
- `ControllerSourceProvider` (61) - `TextDocumentContentProvider` for the read-only
  `abb-controller:` URI scheme; `uriFor(task,module,ext)` builds the virtual URI so
  Diff-with-Controller has a stable read-only target.
- `PpDecoration` (98) - live program-pointer gutter arrow + line highlight; matches the
  editor's first `MODULE <name>` to `pp.module`; **issues a `getCurrentPP` HTTP call on
  every `onDidChange` and every editor focus change** (L44-58).
- `Logger` (144) - dual sink: VS Code output channel "ABB Robot" + per-session NDJSON at
  `~/.abb-rws-extension/logs/` (pruned to newest 20); HTTP-category traces go to the file
  only, not the visible channel (L109-113).

### RAPID language features (`src/Rapid*.ts` + data)
| File | Provides | Data source |
|---|---|---|
| `RapidLanguageIndex` (290) | workspace symbol index (regex) | `.mod/.sys/.prg` files |
| `RapidCompletionProvider` (198) | completion + ~60 snippets | 705-entry JSON DB |
| `RapidHoverProvider` (185) | hover signature (tier 1) + **live value** (tier 2) | JSON DB + live `getRapidVariable` |
| `RapidSignatureHelpProvider` (168) | parameter popup | JSON DB `parameters[]` |
| `RapidInlayHintsProvider` (126) | **live values** ` → 12` after decls (1.5 s) | live `getRapidVariable` + index |
| `RapidCodeLensProvider` (101) | ▶ Run / ▶ Set PP per routine | own regex scan |
| `RapidDefinitionProvider` (60) | go-to-definition | index |
| `RapidReferenceProvider` (26) | find references | index |
| `RapidDocumentSymbolProvider` (67) | outline | index |
| `scripts/parse-rapid-manual.mjs` | generates `resources/rapid-language-data.json` | `pdftotext` dump of ABB manual |
| `scripts/strip-language-data.mjs` | reduces the JSON DB to signatures only (re-runnable) | the JSON DB as of commit `0c4e49d`, read with `git show` |

The static DB (`resources/rapid-language-data.json`, 220 KB, 705 entries = 355
instructions + 209 functions + 102 datatypes + 39 keywords) holds signatures only:
kind, name, a neutral summary ("RAPID function returning num"), the call shape, the
parameters with types and optional / switch markers, and a function's return type - no
description or example. It is generated offline by `parse-rapid-manual.mjs` (structure
only, from the syntax blocks of ABB manual `3HAC050917-001 Rev F`) and reduced by
`strip-language-data.mjs`. Run without arguments, the strip script reads the unreduced
file from git (commit `0c4e49d`, the last change to it before the reduction; nothing of
it is kept in the tree), parses every syntax block again for parameters the stored lists
missed, and writes the shipped file exactly; run on the shipped file it changes
nothing. `loadDb()` + the
`RapidEntry` interface are **copy-pasted into three providers**, each parsing the
JSON separately.

---

## 5. Control / data flow traces

### 5.1 Connect (`abbRobot.connectRobot`, `connectOnce` in `extension.ts`, flow in `portRecovery.ts`)
Resolve id (arg or `activeId`; none → `addRobot` wizard) → `onceAtATime`: one Connect per
robot; a second one returns at once → `planConnect` (probes and a scan of this PC without
credentials): `keep` when the robot is connected to its saved address with its saved login;
`saved` for a saved port that answers, a robot on another machine, or one saved without a
port; when the saved port on
this PC answers nothing, scan this PC and ask in a modal before a controller of its protocol
on another port is taken as the robot (`chosen`, probed again after the answer), else `stop`
with a message naming the address (nothing sent) → every plan but `keep` gives the robot a
fresh manager (no system id read, so the client never logs in to other controllers to look
for one) → `connectWithRetries`: up to 20 attempts, retrying **only** on `503`/busy with a
3 s sleep, and on this PC probing the address again before each retry →
`settleConnect`: a session on this PC on another port than asked for is disconnected
(`elsewhere`); a system id other than the one recorded for the robot disconnects and asks
(`different`); a chosen port that connected (or a port the client found on another machine's
host) is saved; a chosen port that did not connect is put back in memory, unless the port
changed outside this window meanwhile. The system read is recorded in global state
(`abbRobot.lastSeenControllers`); when it was not read yet, `onRobotChanged` checks it once it
is. On failure: "Show Logs" / "Edit Robot…". The Reconnect button of a lost connection runs
this command for that robot.

### 5.2 Push a RAPID file (`abbRobot.pushCurrentFile`, `extension.ts:1568-1603`)
Arg `Uri` from explorer, or the active editor (save dirty doc first) → only `.mod/.sys/
.prg` → strip any legacy `.controller`/`.from-controller` basename suffix (**module names
can't contain dots - the controller 400s**, L1630-1633) → `active.loadProgram(...)` which
(in the client) stops RAPID, unloads the same-named module, uploads to `$HOME`, and
`loadModule(replace=true)`.

### 5.3 Live inlay hint (`RapidInlayHintsProvider`)
A `setInterval` fires `onDidChangeInlayHints` every 1.5 s while connected (L44-49). VS
Code re-requests hints → provider re-indexes the doc, filters index symbols to `var/pers/
const` in the visible range, and reads each value **sequentially** via
`multi.active.getRapidVariable(task, containerModule, symbol)` (L78-95) with a TTL cache
(1.5 s success / 6 s failure). This is the headline "RAPID Live" feature.

### 5.4 Error → recovery dialog (`showError`)
Every shown error is traced with `opmode/ctrlstate/execstate` context plus the controller
code and the refusal's `kind`/`grantor`. An error the client explains (`RwsError.refusal`)
is shown with the client's own message: the sentence (what is missing, who can supply it)
followed by the controller detail. `showError(label, e, entry)` takes the robot entry the
handler resolved before sending (`activeEntry(multi)`), so the message reads that robot's
state and every button acts on that robot, whichever one is active when the dialog is
answered. The buttons come from `refusalButtons` in `src/refusalUi.ts`, never from a regex
on the message: **Request Remote Control** only for `rmmp-required` on RobotWare 6/7
(waits for the operator via `requestRmmp`, cancellable), **Show Holder** for
`held-by-other` on mastership (RobotWare 6/7, the mastership status) or on write access
(RobotWare 8, `getWriteAccessStatus`, the station's name only). A safety state (the
RobotWare 8 guard stop that waits for the Reset at the FlexPendant), a missing grant,
Remote Access off or a wrong mode get the sentence alone. An unexplained
`MASTERSHIP_REQUIRED` on RobotWare 6/7 keeps **Show Holder** and **Release this tool's
control of <robot>** (`releaseMastershipAll`, this session's own locks only). The
remaining patterns in `friendlyErrorMessage` are hints for errors that are not refusals
(a busy controller, a missing program pointer, a missing path); the 403 and 400 guesses
from the robot's state are gone.

Before a write, `confirm(entry, { label, tier, sideEffects })` (`src/confirm.ts`) names
the robot as `name (host:port)` plus the name it reports when that differs. Tier
`motion` (Start RAPID, Run routine, Motors On, a UI instruction answer, the first jog on
a connection) asks the user to type the robot's name, every time; `disruptive` (the
operation mode lock and unlock, a CFG file load, restart, restore, clearing event logs,
deleting a file) is one "Continue on <name>" button behind the list of side effects;
`change` (a signal write or toggle, the CFG instance written on Ctrl+S) is one "Write to
<name>" acknowledgement. A cancelled confirmation sends nothing; nothing skips one.

`setPPToRoutine`, `unloadModule` and `loadProgram` are refused by the client while the
program runs; `withStopOffer` asks the user, and only on a yes repeats the call with
`stopIfRunning: true`.

---

## 6. Conventions & invariants

- **No polling in the extension.** The client polls; the extension refreshes on
  `multi.onDidChange` (one subscriber fanning to 9 providers + status bar + context key,
  `extension.ts:501-549`). Manual `refresh*` commands are escape hatches.
- **All method calls go through `multi.active`, never `multi`** - see the seam in §1.
- **Command-argument polymorphism.** Nearly every context-menu command accepts a string,
  a `TreeItem` with `.id/.label`, or a `{node}`/`{entry}` wrapper, because VS Code passes
  different shapes for inline buttons vs item-clicks vs the palette (`extractRobotId`
  L340, `extractTaskName` L2627, signal unwrap L2343/2372). Getting this wrong produces
  `…/signals///undefined/set-value` (live-confirmed, L2369-2371).
- **Controller source becomes a real file.** Opening a module writes a real file to the
  workspace root or `~/.abb-rws-extension/scratch/` (not an untitled doc) so Push/Diff/
  language features work; the read-only `abb-controller:` scheme is reserved for diff
  targets (`ControllerSourceProvider.ts:10-21`).
- **`contextValue` flows through `CompositeTreeProvider` unchanged** - menu contributions
  target the composite view id but match on the child's `contextValue`
  (`CompositeTreeProvider.ts:17-20`, `CHANGELOG.md:63-65`).
- **RAPID everything is case-insensitive** (DB keyed lowercase, index lookups
  `.toLowerCase()`, grammar `(?i)`), matching RAPID semantics.
- **Errors render inline, not as notifications** in the tree providers (Cfg truncates to
  80 chars, FileExplorer shows "Failed to load", Watch stores per-entry errors).
- **VC-only operations are labeled** in command titles ("Switch Operation Mode (VC
  only)…", "Show / Control Virtual Time (VC only)").

---

## 7. Gotchas & hard-won knowledge

- **The multi-as-any seam** (`extension.ts:371-372`): 7 providers get an untyped `multi`.
  Safe for the 5 that only read `manager.state` (MultiRobotManager proxies state), but
  `FileExplorerProvider` calls `listDirectory` directly on it - the exact class of bug
  `ModulesTreeProvider.ts:107-111` documents. It works today only because
  `MultiRobotManager` happens to expose `listDirectory` (`MultiRobotManager.ts:71-75`).
- **Two-main `-519` collision**: two loaded modules each defining `PROC main()` puts the
  controller in a "semantic error" state that rejects **all** Set-PP calls.
  `tryResolveMainCollision` (`extension.ts:2655`) detects this and offers to unload one;
  `TabbedProgramWebviewProvider` shows a proactive warning banner (L1032-1049). Controller
  codes handled in `friendlyErrorMessage`: `-1073442809`, `icode:-519`, `org_code:-519`,
  `-4501`/`0xc004841d`. `isSemanticError` (`src/refusalUi.ts`) goes by the controller's
  code (`-1073442802`) when the error carries one, and by the text only when it does not;
  a load that ends in a semantic error keeps the client's report of what it did
  (`semanticErrorText`).
- **`setOpMode` timeout means the FlexPendant popup is pending, not failure**
  (`extension.ts:1112-1117`). Going to AUTO waits for a confirmation at the FlexPendant;
  RAPID Live does not send it (README, What RAPID Live does not do); on RobotWare 6/7 it
  may need RMMP, on RobotWare 8 control-station write access (Remote Access at the
  FlexPendant).
- **RAPID tasks are CFG, not runtime**: `createRapidTask` writes `SYS/CAB_TASKS` and needs
  a controller restart before the task appears (`extension.ts:2063-2077`).
- **Dynamically loaded modules don't enter the runtime symbol table** until a `.pgf` build
  or restart on RW6.16 (`test-rws1-writes.mjs:323-327`); `org_code 3500` = "Routine main
  not found" when no program is built.
- **`writeSignal` needs RMMP=modify even in AUTO** on the VC (403 "Rejected" otherwise) -
  documented identically in both write-test scripts (`test-rws1-writes.mjs:453`,
  `test-rws2-writes.mjs:553`).
- **Signature-help highlights the wrong parameter** - *resolved in 0.10.0*: parameters
  are stored in call order.
- **Manual-parse noise leaks into hover/completion** - *resolved*: page footers were
  filtered in 0.10.0, and since 1.3.0 no `syntax` field is shipped at all.
- **Watch list is `globalState`, not workspace state** despite the comment
  (`VariableWatchProvider.ts:19` vs `:52`) - watches are global across workspaces.
- **The `npm run watch` script is a no-op** - `build.js` ignores `--watch` (there is no
  esbuild `context()`/`watch()` call). Rebuilds go through the F5 `preLaunchTask`.
- **No type checking in the build** - esbuild doesn't typecheck and nothing runs `tsc`, so
  type errors ship silently (`build.js`, `tsconfig.json` has no `noEmit`).

---

## 8. Build, test, release

```bash
npm run build     # node build.js - esbuild bundles src/extension.ts + inlined
                  #   abb-rws-client → dist/extension.js (CJS, external:['vscode'],
                  #   minify:false, sourcemap). ~552 KB.
npm run watch     # BROKEN - one-shot build, does not watch
npm run package   # npx vsce package → .vsix
# F5 in VS Code   # Extension Development Host (preLaunchTask 'npm: build')
```

`npm run typecheck` runs `tsc` over `src/` and `test/`; `npm test` bundles `test/*.test.ts`
with esbuild into `out/test/` and runs them with Node's built-in test runner (modules without
a `vscode` import only). There is no lint script. Beyond that, verification is the root-level
live-test scripts run manually against the two VCs:

| Script | Target | Port | What |
|---|---|---|---|
| `test-everything.mjs` | RWS 2.0 | `127.0.0.1:5466` (hard) | ~80 read endpoints, XHTML parse asserts |
| `test-commands.mjs` | RWS 2.0 | `:5466` (hard) | mimics each command's data flow |
| `test-coverage.mjs` | either | auto-discover | reachability sweep by status code |
| `test-rws1-full.mjs` | RWS 1.0 | auto (wide scan) | read sweep via `RwsClient` |
| `test-rws1-writes.mjs` | RWS 1.0 | auto | write verification, state-restoring |
| `test-rws2-writes.mjs` | RWS 2.0 | auto | write verification, `edit`/`motion` mastership |
| `scripts/probe-module-save.mjs`, `scripts/probe-speedratio.mjs` | RWS 2.0 | port scan / `RWS2_URL` | one-off checks of module save and speed ratio |

Both write scripts use `samples/TestExtension.mod`.

---

## 9. Discrepancies (manifest vs code vs docs vs changelog)

| # | Discrepancy | Evidence |
|---|---|---|
| 1 | **`ModulesTreeProvider` is dead code** - constructed and refreshed but registered in no view (the Program panel is now `TabbedProgramWebviewProvider`) | `extension.ts:376, 505` vs `:385-431` |
| 2 | **Dependency version skew**: manifest pins `abb-rws-client-0.5.0.tgz`, `node_modules` has 0.7.1, source is 0.7.2, and `docs/RWS_COVERAGE.md`/`RWS1_PARITY_PLAN.md` attribute the shipped parity to 0.6.0 | `package.json:1164` vs installed vs `docs/*` |
| 3 | `abbRobot.resetRapid` and `abbRobot.ppToMain` are two commands with identical title "PP to Main" and icon | `package.json:243-253` |
| 4 | Category `Debuggers` declared but no debugger contribution exists (DebugAdapter is future work). Fixed in 1.4.1: the category is gone | `package.json:38-42`, `docs/RWS_COVERAGE.md:236` |
| 5 | Walkthrough "watch" step completes on `abbRobot.addWatch` but instructs the user to use `abbRobot.addSelectionToWatch` | `package.json:859-864` |
| 6 | README comparison table claims "IK + FK ✓" unqualified, but IK always fails on VCs and FK's param format is listed as a blocker | `README.md:54`, `docs/RWS_COVERAGE.md:92` |
| 7 | `setActiveTool`/`setActiveWobj` hardcode mechunit `ROB_1`, while `showMechunitDetails` correctly uses `state.mechunits[0] ?? 'ROB_1'` | `extension.ts:1773,1781,990` |
| 8 | `editCfgInstance` has no write-back - opens editable JSON but never writes edits to the controller | `extension.ts:1800-1806` |
| 9 | `createRapidTask` doc lists `Main` as a required CFG attr but the `createCfgInstance` call omits it | `extension.ts:2066-2073` vs `2128-2134` |
| 10 | Two parallel snippet systems (`snippets/rapid.json` 20 entries vs the `SNIPPETS` map in `RapidCompletionProvider`) with drifted bodies (zone `z10` vs `fine`, etc.); two `SNIPPETS` keys (`ifelse`, `forstep`) are dead | `snippets/rapid.json`, `RapidCompletionProvider.ts:52-114` |
| 11 | `RapidHoverProvider` doc says the DB has 666 entries; actual is 705 (comment predates keyword additions) | `RapidHoverProvider.ts:12-13` |
| 12 | TextMate grammar accepts `TASK PERS` but `RapidLanguageIndex` only accepts `LOCAL` - `TASK`-scoped decls highlight but are invisible to outline/definition/references/inlay-hints | `rapid.tmLanguage.json:64-76` vs `RapidLanguageIndex.ts:132-134` |
| 13 | Walkthrough media (`connect.md`, `open.md`, `watch.md`) still describe the pre-0.9.2 11-panel layout | `media/walkthrough/*.md` |
| 14 | Module-name detection is implemented three ways with different scopes (hover: whole doc; codelens: first 30 lines; index: line-by-line) | `RapidHoverProvider.ts:94`, `RapidCodeLensProvider.ts:89`, `RapidLanguageIndex.ts:165` |
| 15 | **`abbRobot.refreshInterval` is dead config** - declared (default 1000 ms, min 200) but read nowhere in `src/` (grep: only the declaration) and never passed to the client; polling cadence is hardcoded in the client's `RobotManager` (1 s / 5 s) | `package.json:133` |
| 16 | `abbRobot.robots` settings schema omits `port`/`useHttps`, but the add-robot wizard and the VC port-recovery path persist both into that setting | `package.json:81-115` vs `extension.ts:85-93,653-660` |

---

## 10. Open questions

1. Does opening a `.mod` file alone activate the extension (needed for language features),
   given `activationEvents: []` and no `onLanguage:rapid`? (`package.json:43`)
2. Is the installed `node_modules/abb-rws-client` actually 0.7.1 while the manifest pins
   0.5.0 - i.e. was a newer tgz installed without renaming? (confirmed installed = 0.7.1;
   whether the shipped `.vsix` bundles that or 0.5.0 depends on which was present at
   `npm install` time)
3. Was `abb-rws-client` ever published to the npm registry (README shows `npm i`)? The
   extension consumes a local tarball.
4. Which FK action string is real - `CalcPoseFromJoints` (`RWS1_PARITY_PLAN.md`) or
   `CalcRobTFromJoints` (`RWS_COVERAGE.md`)? **(inferred: `CalcRobTFromJoints` per
   `RwsClient2.ts:1020`, but the RWS 1.0 side uses `CalcRobTFromJoints` too per
   `RWS1Adapter.ts` - the plan doc's name is stale)**
5. Is shipping `docs/RWS_COVERAGE.md` inside the `.vsix` intentional?
