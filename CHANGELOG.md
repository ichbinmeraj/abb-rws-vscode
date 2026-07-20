# Changelog

## 1.0.0 - 2026-07-11 - Network discovery, secure credentials, simulation panel

The first stable release. Everything below is live-verified against both
controller generations (IRC5 RW6.16 + OmniCore RW7.21).

### Added

- **Automatic controller discovery.** The add-robot flow now finds controllers
  on your network over mDNS/Bonjour - pick one from the list instead of typing
  a host and port. New command **ABB Robot: Discover Controllers (mDNS)**.
  This finds RobotStudio's randomly-assigned virtual-controller ports for you.
- **Passwords moved to secure storage.** Controller passwords now live in VS
  Code's `SecretStorage` instead of plaintext in settings (which Settings Sync
  copied to the cloud). Existing passwords are migrated automatically on first
  launch and removed from the settings file.
- **Simulation panel** (virtual controllers) - six commands to drive the safety
  chain and reposition the simulated robot from VS Code: **Simulate E-Stop**,
  **Reset Simulated E-Stop**, **Simulate General Stop Toggle**, **Simulate Auto
  Stop Toggle**, **Simulate Enable Switch**, and **Teleport Robot to Joints…**
  (pre-filled with the robot's current pose).

### Internal

- Bundles `abb-rws-client` 1.0.0 (`vendor/abb-rws-client-1.0.0.tgz`) - adds
  HAL-JSON parsing for RWS 2.0, mDNS discovery, and the simulation-panel API.

## 0.10.0 - 2026-07-09 - Real real-time on OmniCore, module source everywhere, CFG editing that saves

### Fixed

- **Live updates on OmniCore controllers are now actually live.** The bundled
  client sent the RWS 1.0 WebSocket subprotocol to RWS 2.0 controllers, which
  reject it - so every OmniCore connection has silently been on 1-second
  polling since real-time shipped. With the corrected `rws_subscription`
  handshake (client 0.8.0), state changes arrive as push events; dropped
  sockets auto-reconnect, and if the stream is ever lost for good the
  extension falls back to fast polling instead of going quiet.
- **Opening module source works for every loaded module**
  ([#3](https://github.com/ichbinmeraj/abb-rws-vscode/issues/3)) - modules
  loaded from `.pgf`, RobotStudio, or the FlexPendant (no file in `HOME`) are
  now recovered through a save → read → delete round-trip on the controller's
  TEMP volume, on both IRC5 and OmniCore.
- **Edit CFG Instance now writes back.** Saving the scratch `.cfg.jsonc`
  document sends the edited attributes to the controller - to the robot the
  instance was opened from, even if you switch the active robot before
  saving. (The underlying CFG write endpoints were broken in the client on
  both protocols and had never worked; fixed in client 0.8.0.)
- **Create RAPID Task sent attribute names that don't exist** in the live
  `SYS/CAB_TASKS` schema (`Task`, `Trust Level`, `Motion Task`); it now uses
  the schema-verified names and value forms on both controller generations.
- **Tool/WObj activation no longer assumes `ROB_1`** - the connected robot's
  actual mechanical unit is used.
- **`abbRobot.refreshInterval` now does something.** The setting existed but
  was never read; it now controls the client's polling cadence (min 200 ms),
  and changing it prompts for a window reload.
- **RAPID signature help highlights the right parameter.** The language
  database stored parameters optionals-first (and dropped most optional
  arguments entirely); it is regenerated in call order with 21-parameter
  instructions like `SearchL` fully recovered, and manual page footers
  (copyright lines, page numbers) no longer leak into hover/completion text.
- **`TASK PERS` declarations** are now indexed - outline, go-to-definition,
  references, and inlay hints see task-persistent variables.
- **Variable watches are per-workspace** (with a one-time migration from the
  old global list) - different projects watching different cells no longer
  share one list.
- The `abbRobot.robots` settings schema now documents the `port` and
  `useHttps` fields the extension itself persists.

### Added

- **`abbRobot.strictTls`** (default off) - verify controller TLS certificates
  for plants that installed proper certs; off by default because controllers
  ship self-signed.
- **CI workflow** (build + typecheck) and `SECURITY.md`.

### Internal

- Bundles `abb-rws-client` 0.8.0 (`vendor/abb-rws-client-0.8.0.tgz`).

## 0.9.3 - 2026-07-03 - Real-hardware TLS fix + reproducible builds

### Fixed

- **Connecting to real OmniCore controllers from VS Code failed with
  `self signed certificate`** ([#2](https://github.com/ichbinmeraj/abb-rws-vscode/issues/2)).
  VS Code's extension host replaces custom HTTP agents for non-localhost targets,
  which silently dropped the client's agent-level TLS bypass - so the self-signed
  certificate every ABB controller ships was rejected. RobotStudio VCs on
  `127.0.0.1` were never affected (the extension host doesn't intercept localhost),
  which is why this only surfaced on real hardware. The bundled `abb-rws-client`
  0.7.3 now sets the TLS option per-request on every HTTPS path (requests,
  subscription POST, port probing, protocol detection).
- `npm run watch` now actually watches (esbuild context).

### Internal

- The `abb-rws-client` dependency is now a tarball tracked inside this repo
  (`vendor/abb-rws-client-0.7.3.tgz`) - the extension builds from a clean clone.
- `vscode:prepublish` runs build + typecheck, so a type-broken build can't be
  packaged.
- Internal docs, sourcemaps, and the vendor tarball are excluded from the `.vsix`.

## 0.9.2 - 2026-05-07 - Sidebar consolidation (11 → 5 panels) + tabbed webviews

A holistic redesign of the activity-bar layout. Eleven separate tree views
were too many to scan; many were redundant after the Live Cell webview
landed. This release groups them into five purpose-driven panels:
**Robots**, **Live Cell**, **Program** (tabbed webview), **Controller Data**
(composite tree), **Diagnostics** (composite tree).

### Program panel - tabbed webview with module → routine expand

The Program panel is now a custom webview with two real tabs at the top:

- **Modules** - status banner (motors / op-mode / running indicator), action
  buttons (Motors On/Off, Load, Start, Stop, PP-to-Main), and a list of
  loaded modules. Click the ▸ twisty (or the module name) to expand and
  see its routines (PROCs/FUNCs/TRAPs) underneath. Routines are fetched
  lazily on first expand and cached. Each PROC has inline ▶ Run + Set PP
  buttons; FUNCs and TRAPs have Set PP only.
- **Watch** - list of pinned RAPID variables with live values. Hover any
  row → Edit / Remove buttons. Empty state has a prominent "+ Add Variable"
  button.

### New - Create RAPID Task command

`ABB Robot: Create New RAPID Task…` - wizard that adds a new instance to
SYS/CAB_TASKS via CFG (task name, type NORMAL/STATIC/SEMISTATIC, trust
level, entry routine, motion-task flag). After write, prompts for the
mandatory controller restart that loads the new task.

Tab counts (e.g. "Modules 2", "Watch 5") in the tab buttons reflect the
current contents at a glance. CSS uses VS Code theme variables - adapts to
light, dark, and high-contrast themes automatically. CSP-restricted, all
inline. Action wiring goes through `vscode.commands.executeCommand`, so
every action available in the previous tree view (and via the command
palette) works the same here.

### New layout

| Before (11 panels) | After (5 panels) |
|---|---|
| Robots | **Robots** |
| Live Cell | **Live Cell** *(webview)* |
| Controller Status, Modules, RAPID, Variables (Watch) | **Program** - Modules & Tasks + Watched Variables |
| Controller Files, I/O Signals, Configuration (CFG) | **Controller Data** - Files + I/O + CFG |
| Event Log, Motion, (Status), (RAPID) | **Diagnostics** - Recent Events + Status & System Info + Motion + RAPID extras |

Each merged panel uses collapsible `── Section ──` headers. Default-expanded
sections are the high-frequency ones (Modules, Watch, Files, I/O, Recent
Events); rare-use sections (CFG, Motion details, Status info, RAPID extras)
default to collapsed but are one click away.

### Internal

- New `src/CompositeTreeProvider.ts` (~110 lines) wraps existing
  `TreeDataProvider`s without modification. Each underlying provider's
  `refresh()` continues to work; the composite subscribes to each child's
  `onDidChangeTreeData` and re-fires its own.
- `package.json` views block reduced from 11 entries to 5; `viewsWelcome`
  updated to point at new view IDs; menu `view/title` `when` clauses
  updated.
- All right-click context menus on tree items continue to work - they
  match on `viewItem == programModule` etc., and TreeItem `contextValue`
  flows up through the composite unchanged.
- Bundle size: 549 KB → 552 KB (~3 KB for the wrapper + section metadata).

## 0.9.1 - 2026-05-07 - UI modernization pass

Polish-focused release. No new commands or protocol features - everything that
went into 0.9.0 stays. This release makes the extension feel modern and
discoverable on first install.

### New

- **Live Cell webview** - a compact dashboard view at the top of the ABB
  activity bar showing motors / op-mode / exec state / joints / TCP / active
  task / RobotWare version in a single styled card. Updates live as the robot
  state changes. CSS adapts to light, dark, and high-contrast themes.
- **Welcome views** for empty states - Robots panel, Live Cell, Modules, and
  Variables (Watch) now show contextual call-to-action buttons when empty
  ("+ Add Robot", "Auto-detect VC", "Connect", "Add Variable", etc.) instead
  of silent emptiness.
- **First-run walkthrough** - accessible from `Help → Welcome` with five
  steps: Add a robot → Connect → Open a module → Edit and push back → Watch
  live values. Each step auto-completes when the corresponding command runs.
- **Three-item status bar** - connection pill (host name + state color),
  op-mode pill (lock for AUTO, unlock for MAN*), exec-state pill (RUNNING /
  STOPPED with color). Each clickable to its primary action. Disconnected
  shows a single "ABB" pill linking to Add Robot.

### Changed - UI polish

- **Colored state icons** across all tree providers using VS Code's
  `charts.*` and `errorForeground` theme tokens (auto-adapt across themes):
  - **Status panel**: motors green/orange/red, op-mode blue/orange, RAPID
    green-running/gray-stopped, low speed (< 30%) orange, collision detection
    green when OK, red when triggered.
  - **Modules panel**: motion task blue, running task green-play, inactive
    task gray, ProgMod blue, SysMod gray, collision-warning red, PP-here
    routine blue (debug-stackframe icon), local declaration gray.
  - **Event log**: error icons red, warnings orange, info blue.

### Internal

- Bumped version 0.9.0 → 0.9.1.
- New file `src/LiveCellWebviewProvider.ts` (~280 lines, all CSS/JS inline,
  CSP-restricted, no external resources).
- New folder `media/walkthrough/` with markdown step descriptions.
- `package.json` adds `viewsWelcome`, `walkthroughs`, and the new
  `abbRobot.liveCell` view registration.
- Bundle size: 543 KB → 549 KB (minor).

## 0.9.0 - 2026-05-07 - Real RAPID language server + git-style workflow

This release is the "actually a RAPID IDE" milestone. Everything in 0.8 was the
controller-side bridge. 0.9 makes the editor feel native: language server,
push/pull/diff workflow, and a live editor that tracks the running program.

### New - RAPID Language Server (workspace-wide)

- **Go to Definition** - Ctrl+click a routine / variable / trap → jumps to its `PROC` / `VAR` / `TRAP` declaration anywhere in the workspace.
- **Find All References** - Shift+F12 lists every call/usage site across all `.mod`/`.sys`/`.prg` files.
- **Document Outline + Breadcrumbs** - VS Code's outline panel shows module → routines → declarations; breadcrumbs at the top of the editor; `Ctrl+Shift+O` (Go to Symbol in File).
- **Workspace symbol index** - parses every RAPID file on activation, refreshes on save, debounced re-index on edits. Backs all three providers above.

### New - Live editor experience

- **Inlay hints** - faded gray text shows the live controller value next to every `VAR` / `PERS` / `CONST` declaration (` → 12`, ` → [[100,0,520],…]`). Updates every 1.5 s while connected. Tooltip shows full value.
- **Program-pointer gutter arrow** - green ▶ in the gutter at whichever line the running RAPID program is currently executing, with a subtle line highlight (same style VS Code uses for paused-debugger frames). Live, updates as PP moves.
- **Live variable hover** - hovering an identifier in code that's not a built-in instruction shows its current controller value in the hover popup. Cached briefly so hovering doesn't hammer the controller.

### New - Git-style RAPID workflow

- **Pull All Modules from Controller** - bulk-download every program module into your workspace folder (or a chosen folder). Progress, per-file failure tracking, "Open Folder" follow-up.
- **Push Current File to Controller** - load the active `.mod`/`.sys`/`.prg` into the running task. Available via Command Palette, editor right-click, editor title-bar, and explorer right-click on `.mod` files.
- **Diff with Controller** - open VS Code's native diff editor between your local file and the live controller version. Uses a custom `abb-controller:` URI scheme so the controller view is read-only and can't accidentally be re-diffed.
- **Open in Editor** buttons on every Modules-tree row and File-Explorer file - pull the live source straight into an editor tab. Smart collision handling: if the local file already exists, prompts "Open Local / Overwrite with Controller Version / Cancel" instead of silent rename.

### New - Variables (Watch) panel

- Pin RAPID variables / persistents / constants - values poll every 1 s while connected.
- Right-click any identifier in a `.mod` file → "Add Selection to Variable Watch".
- Edit values via right-click → write through controller.
- Watches persist across VS Code sessions (workspace-global state).

### New - Tasks panel + multi-task support

- Modules tree now shows **Tasks** with per-task module trees (T_ROB1, T_BCKGRND, etc.).
- Each task: motion / normal / static type, exec state, active flag, expand to see its modules.
- Right-click → Activate / Deactivate. Plus "Activate / Deactivate All RAPID Tasks" commands.

### New - Coverage of the rest of `IRWSAdapter`

We rounded out the lib's public surface. New commands wired in the extension:

- **RMMP**: Request Remote Control / Show Remote-Control Status.
- **Operation mode**: Switch Operation Mode (VC only) - auto-routes AUTO ↔ MANF through MANR (the controller rejects direct AUTO ↔ MANF). Now reachable by clicking the Operation Mode row in the Status panel.
- **Backup / Restore**: Create Backup (with progress polling), Restore Backup (with confirm).
- **Service routine call**: invoke any PROC by name remotely.
- **Forward kinematics**: Calculate Forward Kinematics (joints → cartesian).
- **Tool / Wobj activation**: Set Active Tool, Set Active Work Object.
- **CFG write**: Edit / Create / Remove CFG Instance, Load .cfg File, Save Domain to .cfg. Each wraps with `edit` mastership.
- **DIPC**: List / Create / Remove Queue, Send / Read Message.
- **File volumes**: List, Compress.
- **Validation**: Validate RAPID Value (pre-flight before write).
- **Module info**: Open Loaded Module Source, Open Controller File.

### Fixed

- **Auth fallback** - `createClient` now tries the configured user first; if 401, transparently falls back to `Default User` so the same code works on both IRC5 (where `Admin` may not exist) and OmniCore (where it does).
- **`setSpeedRatio` wire format** - RWS 2.0 OmniCore expects `?action=setspeedratio` query path with body `speed-ratio=N` (not `speedratio=N`). Live-verified. Wraps with `edit` mastership internally.
- **`setOperationMode` direction handling** - going to AUTO from MANR/MANF now auto-acquires `edit` mastership; AUTO ↔ MANF transit through MANR; same-mode picks short-circuit; guardstop pre-flight.
- **MANF wire format** - RWS 2.0 wants `manf`, not `manfs` (RWS 1.0). Probe-verified.
- **Mastership-error dialog** now offers three actions: Request Remote Control, Show Holder, Force-Release. Distinguishes RMMP missing from mastership held by another client.
- **Modules tree** showed routines from the wrong cache when a tree provider was constructed with `multi as any` instead of `RobotManager`. Fixed: providers now resolve `multi.active` per call.
- **Push / Diff with `Untitled-N` docs** - "Open in Editor" now writes a real file (workspace root or `~/.abb-rws-extension/scratch/`) so the doc keeps its `.mod` extension and downstream commands just work.
- **Push / Diff with `.controller.mod` files** - defensive `.controller` suffix stripping in three places so even legacy files don't 400 on the controller.
- **Default user changed to `Admin`** for full UAS grants on OmniCore (with auto-fallback to `Default User` on 401 for IRC5).

### Documentation

- README rewritten around the RAPID Live language server + the `abb-rws-client` npm package as the foundation other tools can build on. Removed pendant-clone framing.
- Honest "What's NOT in 0.9 (and won't be)" section listing safety-by-design walls (popup bypass, UAS grant write, FlexPendant key switch override, jog from AUTO).
- 30+ new protocol-quirk findings logged in memory for future maintenance.

## 0.8.0 - RAPID Live release

The extension now identifies as **RAPID Live**. Same package id (`merajsafari.abb-rws`),
new positioning: the only extension that connects VS Code to a live ABB controller.

### New
- **RAPID language support** - syntax highlighting, 18 snippets, language config (auto-close brackets, `!` line comments, indent rules) for `.mod`, `.sys`, `.prg` files.
- **Auto port discovery** for RobotStudio virtual controllers - detects controllers even on the random ports RobotStudio assigns each session, then persists the new port.
- **Wide-range TCP scan fallback** (1024-30000) for localhost when standard ports are empty.
- **Inverse Kinematics command** (`abbRobot.calcIK`) and Motion-panel button.
- **Jog UI** in the Motion panel - Joint and Cartesian modes, configurable increment/speed, ±/Stop buttons (subject to ABB safety constraints - see README).
- **RMMP (Remote Mastership Privilege)** auto-request - new Phase 2 finding; tells the user when FlexPendant approval is required.
- **Diagnostic Output channel** ("ABB Robot") with timestamped lifecycle events.
- **Visible error notifications** for connect/poll failures, with "Show Logs" / "Reconnect" / "Edit Robot" follow-ups.
- **WebSocket subscriptions** for instant state-change updates on RWS 1.0; transparent polling fallback on RWS 2.0 VC.
- **`abb-rws-client` session cookie reuse** in RWS 2.0 - fixes the "Too many sessions" lockout on repeated polling.
- **Concurrent-connect dedup** + polling generation gating - clicking Connect rapidly no longer spawns parallel sessions.

### Fixed
- TreeItem-vs-string argument mismatch on Robots panel inline buttons (Connect/Disconnect/Remove now actually work).
- Status panel "Host" row was inconsistent across RWS versions (now uses RAPID system name on both).
- `systemInfo`/`identity` would stay null forever if the first poll failed; now retries every poll until populated.
- RWS 2.0 POST/PUT/DELETE without a body returned HTTP 406 (now sends the required `Content-Type` header).
- Polling silently disconnected on a single transient failure; now tolerates 3 consecutive failures and surfaces a notification.
- Rapid Connect-button clicking caused session leaks; idempotent when already connected.

## 0.7.0 - Adapter pattern + multi-robot
- **RWS 1.0 + 2.0 adapter abstraction** - single interface, two implementations.
- **Multi-robot management** - Robots panel, switch active robot.
- **Auto-detection** - probes 80/443/28447/9403 with `WWW-Authenticate` to identify protocol + auth type.
- **Custom XHTML parser** for RWS 2.0 (which is XML-only - JSON returns 406).
- **Mastership domain rename** for RWS 2.0 (`rapid`/`cfg` → `edit`).
- **Same-host disambiguation** - session cookies keyed by `host:port`.
