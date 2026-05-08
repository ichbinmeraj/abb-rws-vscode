# RAPID Live — ABB Robotics for VS Code

> The first VS Code extension that connects directly to a live ABB controller.

**Live-tested on RobotWare 7.21 (OmniCore) and RobotWare 6.16 (IRC5).**
Works against real hardware and RobotStudio virtual controllers, with both
**RWS 1.0** (HTTP Digest, IRC5) and **RWS 2.0** (HTTPS Basic + XHTML, OmniCore)
auto-detected from the controller's auth challenge.

<!-- Screenshots coming in 0.9.3 -->

---

## What it does

- **RAPID language server** — hover docs from the official 705-entry reference manual, autocomplete, signature help, snippets, CodeLens above every `PROC` / `FUNC` / `TRAP`, Go-to-Definition, Find References, document outline, inlay hints showing live values.
- **Push / Pull / Diff** — `.mod` file workflow that fits in any git repo. Pull all controller modules into your workspace; edit; push back. Diff your local file against what's currently loaded.
- **Live Cell dashboard** — joints, TCP, op-mode, exec state, speed at a glance.
- **Tasks panel** — every RAPID task with its modules and routines. One-click run, set PP, unload. Create new tasks (writes `SYS/CAB_TASKS` in CFG).
- **Variables Watch** — pin variables, see live values poll every 1 s.
- **Multi-robot** — one window, many controllers, switch active in a click.
- Plus: file system browser, I/O signal control, event log with details, CFG read+write, backup / restore, service-routine call, IK + FK, and ~90 commands covering the full RWS surface.

---

## Quick start

1. Install from the marketplace.
2. Click the **RAPID Live** icon in the activity bar → **+ Add Robot**.
3. The wizard auto-scans `127.0.0.1` and `192.168.125.1`. RobotStudio VCs use random ports — those are detected automatically.
4. Default credentials: `Admin` / `robotics` (recommended; works on most controllers). Falls back to `Default User` automatically on IRC5 if `Admin` doesn't exist.
5. Right-click your robot → **Connect**.

That's it — the panels populate in under 2 seconds.

---

## How it differs from other ABB extensions

The other ABB extensions on the marketplace are static editor enhancements — syntax highlighting, snippets, language servers. None of them connect to a controller.

| Feature | RAPID Live | Other ABB extensions |
|---|:---:|:---:|
| Syntax highlighting + snippets | ✓ | ✓ |
| Hover docs from the official manual | **✓** | partial |
| **Live controller connection** | **✓** | ✗ |
| **Live variable values inline** | **✓** | ✗ |
| **Push / Pull / Diff** workflow | **✓** | ✗ |
| Multi-robot management | **✓** | ✗ |
| Real-time WebSocket subscriptions | **✓** | ✗ |
| Module load/unload + routine drill-down | **✓** | ✗ |
| File system + I/O + CFG access | **✓** | ✗ |
| Event log with severity + details | **✓** | ✗ |
| Inverse + forward kinematics | **✓** | ✗ |
| Cross-platform (macOS / Linux) | **✓** | most no |
| Built on a published TS RWS client | **✓** | n/a |

We don't compete with RobotStudio's 3D simulation or cell design — that's a different category. We do the **dev loop**: connect, monitor, edit, deploy, repeat.

---

## Live editing in the editor itself

Open any `.mod` / `.sys` / `.prg` file while connected and the editor lights up:

- **Faded gray live values** next to every `VAR` / `PERS` / `CONST` declaration, polled every 1.5 s.
- **Green ▶ in the gutter** at the line where the controller's program pointer is currently executing.
- **CodeLens** above every routine: `▶ Run this routine` and `▶ Set PP here`.
- **Hover any identifier** → reference-manual docs (705 entries) for built-ins, live controller value for user variables.
- **Ctrl+click a routine name** → jump to its declaration anywhere in your workspace.

---

## Git workflow for RAPID

The point of RAPID Live: edit at your desk, version-control in git, deploy to the robot. None of that flow exists in RobotStudio.

```
┌─ Pull All Modules from Controller ─┐         ┌─ Push Current File ─┐
│                                     │         │                     │
│   Workspace folder ←  controller   │  edit   │  workspace ── push ──→ controller
│   (now in git)                     │ ────────│                       │
└─────────────────────────────────────┘         └─────────────────────┘
```

- **Pull All Modules** — bulk download every loaded program module into your workspace as `.mod` files.
- **Push Current File** — load the active `.mod` into the running task. Right-click in the editor, the title bar, or the file explorer.
- **Diff with Controller** — VS Code's native diff editor between your local file and what's currently loaded. Read-only on the controller side, no risk of clobbering.

---

## Built on the open-source `abb-rws-client` package

The protocol layer is published separately as **[`abb-rws-client`](https://www.npmjs.com/package/abb-rws-client)** — the only TypeScript client for ABB Robot Web Services that supports both protocol versions (RWS 1.0 + 2.0).

Building robot tooling outside this extension — a CLI, a web HMI, a ROS bridge, an MES connector? Skip the protocol-quirk research:

```bash
npm i abb-rws-client
```

```ts
import { createClient } from 'abb-rws-client';

// Auto-detects RWS 1.0 (IRC5) vs 2.0 (OmniCore) from the auth challenge
const client = await createClient({ host: '192.168.125.1' });
console.log(await client.getControllerState(), await client.getOperationMode());
```

The package ships with the full `RobotManager` lifecycle, `MultiRobotManager` orchestration, WebSocket subscriptions with polling fallback, `IRWSAdapter` typed interface, and ~30 documented protocol quirks the ABB developer center doesn't cover.

---

## What you can't do (and why)

ABB designed certain things to be impossible from a remote interface. We probed all of these against live virtual controllers; they're protocol-level walls, not extension limitations:

- **Bypass the FlexPendant op-mode-change confirmation popup** — safety-by-design.
- **Bypass the RMMP grant prompt** — safety-by-design.
- **Modify UAS user grants from RWS** — `/users/grant-status` is read-only; UAS configuration is FlexPendant-only.
- **Override the FlexPendant key switch on real hardware** — physical safety interlock.
- **Jog from AUTO mode** — forbidden by ISO 10218.

Coming in 0.10+:

- Step debugging UI (Step Into / Over / Out + breakpoint sync).
- WebSocket-based real-time state on RWS 2.0 (currently 1 s polling).
- Hot-edit / ModPos in a running program.

---

## Pair with the official ABB extension

ABB's own [RAPID & Ecosystem Tools](https://marketplace.visualstudio.com/items?itemName=abb-robotics-ecosystem.abb-robotics) provides additional language-level features. Both extensions co-exist cleanly — install both for the best experience.

---

## Cross-platform

Built on Node.js APIs only. Tested on Windows; the same code runs on macOS and Linux. RobotStudio is Windows-only, but real ABB hardware (and OmniCore Docker VCs) work fine from any platform.

---

## Safety notes

This extension can change controller state — turn motors on, start RAPID, write I/O signals. Read the [ABB safety documentation](https://search.abb.com/library/Download.aspx?DocumentID=3HAC020738-001&LanguageCode=en) for your robot before using these features outside a sandbox.

---

## Contributing & feedback

- Issues / PRs: <https://github.com/ichbinmeraj/abb-rws-vscode>
- Release history: [CHANGELOG.md](./CHANGELOG.md)

## License

MIT — Meraj Safari, 2026
