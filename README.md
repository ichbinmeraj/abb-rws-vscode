# RAPID Live for ABB Robots

> A VS Code extension that connects directly to a live ABB controller.

**Tested on RobotStudio virtual controllers: RobotWare 8.2.1, 7.21.4 (OmniCore) and 6.16.03 (IRC5); not yet run against a real controller.**
It speaks both
**RWS 1.0** (HTTP Digest, IRC5) and **RWS 2.0** (HTTPS Basic + XHTML, OmniCore)
auto-detected from the controller's auth challenge.

---

## What it does

- **RAPID language server** - hover with the signature and parameter types of built-in instructions and functions (705 RAPID names), autocomplete, signature help, snippets, CodeLens above every `PROC` / `FUNC` / `TRAP`, Go-to-Definition, Find References, document outline, inlay hints showing live values.
- **Push / Pull / Diff** - `.mod` file workflow that fits in any git repo. Pull all controller modules into your workspace; edit; push back. Diff your local file against what's currently loaded.
- **Live Cell dashboard** - joints, TCP, op-mode, exec state, speed at a glance.
- **Tasks panel** - every RAPID task with its modules and routines. One-click run, set PP, unload. Create new tasks (writes `SYS/CAB_TASKS` in CFG).
- **Variables Watch** - pin variables, see live values poll every 1 s.
- **Multi-robot** - one window, many controllers, switch active in a click.
- Plus: file system browser, I/O signal control, event log with details, CFG read+write, backup / restore, Call Service Routine (sets the program pointer to a listed service routine and leaves the start to you; the controller decides the operating mode, and the client holds back RobotWare 8 in Auto), Allow / Withdraw Motion Control (RobotWare 8; see [Starting RAPID on RobotWare 8](#starting-rapid-on-robotware-8)), IK + FK, and 100+ commands in all. [Known limits](#known-limits) lists what is not offered.

---

## Quick start

1. Install from the marketplace.
2. Click the **RAPID Live** icon in the activity bar → **+ Add Robot**.
3. The wizard finds controllers that answer on the hosts and ports you allow: RobotStudio VCs on this PC whatever random port they landed on, a real robot on the service port address when your PC is cabled to it, anything announcing over mDNS/Bonjour, and the addresses you saved (see [Finding controllers](#finding-controllers)).
4. Credentials: for a VC on this PC the wizard fills in the factory user with password `robotics`: `Admin` when the controller answers as RWS 2.0 (OmniCore), `Default User` when it answers as RWS 1.0 (IRC5). For a controller on another machine, enter a user that exists on it. The login is tried once with the user you give; if it is refused, enter another user.
5. Right-click your robot → **Connect**.

That's it - the panels populate in under 2 seconds.

RobotStudio gives a VC a new port when it restarts. When a saved robot on this PC answers nothing on its saved port, Connect looks on this PC's other ports (probes without credentials) and asks before it connects: the dialog names the robot and each controller of its protocol it found (the address Connect will use, and the name and RobotWare version where this PC can read them), and the controller the robot last connected to when this PC has a record of it. RAPID Live cannot tell two controllers apart without logging in, so it asks every time the port moved. The robot's user and password go to its saved address, or to the controller you choose, and the new port is saved once it connects. Cancel sends nothing. When no other controller answers, Connect stops and says which address answers nothing.

VCs that restart together can swap ports. When the saved address answers as another system than the one the robot last connected to, Connect disconnects, saves nothing, and asks before it keeps that controller as the robot. If a controller stops answering during the connect itself and another one on this PC answers instead, RAPID Live disconnects from it at once and saves nothing. The Reconnect button after a lost connection runs Connect, with the same questions.

To remove a robot, use the trash icon on its row, right-click → **Remove Robot…**, or **ABB Robot: Remove Robot…** in the Command Palette, which asks which one. Its saved password is deleted with it.

---

## Finding controllers

**+ Add Robot** scans, then lists what answered:

| Source | When | What it sends |
|---|---|---|
| This PC | always | nothing leaves the PC: the listening ports are read from the OS and probed on 127.0.0.1 |
| Service port address `192.168.125.1` | when this PC has an address in 192.168.125.0/24, or when ticked in **Scan again with options…** | up to 3 connections (443, 80 over TLS, 80 over HTTP) |
| mDNS | on in the wizard; off in **Scan again with options…** if you untick it | one multicast query on each IPv4 network interface, VPN adapters included, repeated twice in the first second |
| Saved addresses | every scan | up to 3 connections per address (plus 2 per extra port), or the saved port only; plus one DNS lookup per host name, to the configured DNS server |
| Saved ranges | only when you pick one, after a confirmation | the same per address, at most 10 new connections per second |

Every probe is one `GET /rw/system` without credentials; discovery never logs in.

- **Add address / range…** saves an address (`10.0.5.20`, `robot1.example.com:443`) or a range (`10.0.5.0/24`, `10.0.5.20-10.0.5.60`; private addresses, at most 256 per scan) for later scans.
- **Enter address manually…** probes one address now without saving it.
- **Remove** a saved address or range with the trash button next to it in the list. **Manage saved addresses and ranges…** (also **ABB Robot: Manage Saved Addresses and Ranges…** in the Command Palette and the Robots view's **…** menu) removes several at once, or all of them after a confirmation. Saved robots and their passwords are not affected.
- Settings (user settings only; a workspace cannot set them): `abbRobot.discoveryManual`, `abbRobot.discoveryRanges`, `abbRobot.discoveryPorts` (extra ports for addresses without one).

Scanning a range opens TCP connections to every address in it. On a company network IT can see these attempts, and intrusion detection may flag them. The extension asks before every range scan.

In a Remote - WSL, SSH or Dev Containers window the scan runs on the remote side and cannot see VCs on your PC; use a local window or enter the address.

---

## Other VS Code extensions for ABB robots

ABB's own RAPID & Ecosystem Tools (0.3.0, checked 2026-10-28) is an editor extension. It has a RAPID grammar, hover, completion, go to definition, an outline and a formatter. It also covers CFG and install.cmd files. It does not connect to a controller. The two run side by side. We last tested them together on 2026-10-29 with ABB 0.3.0 (see [Use it with ABB's extension](#use-it-with-abbs-extension)).

Some community extensions also connect to a controller over Robot Web Services, to IRC5 and to OmniCore. Some of them offer controller breakpoints in the debugger, a guarded module deploy or a live watch list.

What RAPID Live brings: several controllers in one window, backup and restore, the configuration database, IK and FK, and a Motion Control switch on RobotWare 8 that you turn on and off yourself. It is built on abb-rws-client, a published RWS client you can use in your own code.

We don't compete with RobotStudio's 3D simulation or cell design. That is a different category. We do the dev loop: connect, monitor, edit, deploy, repeat.

---

## Live editing in the editor itself

Open any `.mod` / `.sys` / `.prg` file while connected and the editor lights up:

- **Faded gray live values** next to every `VAR` / `PERS` / `CONST` declaration, polled every 1.5 s.
- **Green ▶ in the gutter** at the line where the controller's program pointer is currently executing.
- **CodeLens** above every routine: `▶ Run this routine` and `▶ Set PP here`.
- **Hover any identifier** → signature and parameter types for built-ins (705 entries), live controller value for user variables.
- **Ctrl+click a routine name** → jump to its declaration anywhere in your workspace.

---

## Git workflow for RAPID

The point of RAPID Live: edit at your desk, keep the code in git, deploy to the robot. The modules are plain files in your VS Code workspace, so git and the VS Code diff work on them like on any other code.

- **Pull All Modules** - download every loaded program module of one task into your workspace as `.mod` files. On a system with more than one active task it asks which task. It remembers the task each file came from.
- **Push Current File** - load the active `.mod` into its task: the task the file was pulled from, else the one task that has the module loaded, else the task you pick from a list that names the robot. Right-click in the editor, the title bar, or the file explorer. Push leaves the program pointer where it is. For a file with `PROC main`, its message offers **PP to Main…**, which asks first and names the tasks it moves.
- **Diff with Controller** - VS Code's diff editor between your local file and the module as loaded in the same task. Read-only on the controller side.

---

## Built on the open-source `abb-rws-client` package

The protocol layer is published separately as **[`abb-rws-client`](https://www.npmjs.com/package/abb-rws-client)** - a TypeScript client for ABB Robot Web Services that supports both protocol versions (RWS 1.0 + 2.0).

Building robot tooling outside this extension - a CLI, a web HMI, a ROS bridge, an MES connector? Skip the protocol-quirk research:

```bash
npm i abb-rws-client
```

```ts
import { createClient } from 'abb-rws-client';

// Auto-detects RWS 1.0 (IRC5) vs 2.0 (OmniCore) from the auth challenge
const client = await createClient({ host: '192.168.125.1' });
console.log(await client.getControllerState(), await client.getOperationMode());
```

The package ships with the full `RobotManager` lifecycle, `MultiRobotManager` orchestration, WebSocket subscriptions with polling fallback, `IRWSAdapter` typed interface, and the protocol quirks the ABB developer center doesn't cover.

---

## What RAPID Live does not do

- It does not send the operating-mode confirmation; that is the person's at the FlexPendant.
- It does not answer the RMMP prompt; the pendant does.
- It does not change UAS user grants; UAS configuration is done at the FlexPendant.
- It does not use the key switch of a real controller.
- It allows RobotWare 8 motion control only when you run Allow Motion Control (RobotWare 8), or choose Allow Motion Control first… in a start or jog confirmation, and confirm by typing the robot's name that an emergency stop and a normal stop are within your reach. It withdraws it when you disconnect or choose Withdraw Motion Control, and tries to when you close the window. ABB's PC SDK has an automatic setting for this, and ABB allows it on virtual controllers and not on real ones. On a real controller the tool has to turn it on itself, and ABB asks it to confirm both stops first. RAPID Live asks you every time, on a virtual controller and on a real one.
- It gives no emergency stop and no normal stop. Stop RAPID is a program stop sent over the network; the stops are at the FlexPendant.
- It sends no write to a robot in Watch only, and requests no mastership, write access or RMMP for one. See [Watch only and Program and operate](#watch-only-and-program-and-operate).
- It does not send a module file with non-ASCII characters to a controller: the controller reads the file as single-byte text and would store a UTF-8 character wrong. The message names the line, the column and the byte. A file with a control character, such as a UTF-16 file saved without a byte order mark, is refused the same way.
- A jog in AUTO is sent like any other and the controller decides; its answer is shown.
- A jog goes to the mechanical unit the confirmation names. When the controller has another unit selected for jogging, the client selects that one first, and the selection stays on the FlexPendant. The controller jogs the unit in the jog mode set for it there. The Joint or Cartesian setting of the Motion view only chooses the axis labels.
- It has no jog stop button: one click is one jog step, so no jog is left running. Stop robot motion at the FlexPendant or with the emergency stop.
- It collects no telemetry. It sends nothing about you or your use to anyone. It talks to the controllers you connect to and, when you scan, to the addresses listed under [Finding controllers](#finding-controllers).

Coming soon:

- **Robot panel** - a dedicated interactive panel view for the whole cell: jog, I/O at a glance, signal search, production monitoring. In active development.
- Hot-edit / ModPos in a running program.

---

## Known limits

Some commands rest on a client operation that has never answered with success on a
controller of that generation: no probe log or functional-test trace holds the request
with a 2xx answer. The request is built from the controller's own form or ABB's manual,
and `abb-rws-client` marks it `@experimental` (see its Known limits). Try these on a
virtual controller first.

### Open at this release

- Every success the client has logged comes from RobotStudio virtual controllers; a real controller may refuse what a virtual one accepted (the operating-mode switch, for one), so try a command on a virtual controller first and take the controller's refusal as final.
- RobotWare 6: `abb-rws-client` has no RWS 1.0 form for Modify Position yet, although ABB documents one; modify positions at the FlexPendant. Its RWS 1.0 forms for signal simulation, unblocking signals and enabling or disabling an I/O device are built from ABB's RWS 1.0 pages and not yet run. Its RWS 1.0 forms for setting a base frame, the keyless motors-on and reading the task selection ran on a 6.16.03 virtual controller. ABB's RWS 1.0 has no breakpoint removal, and neither generation has a write for the whole task selection: Activate Task and Deactivate Task, offered on both, change one task at a time.
- RAPID Live has no command for Modify Position, removing a breakpoint, setting a base frame, signal simulation, unblocking signals, enabling or disabling an I/O device, or the keyless motors-on, on any generation.
- RobotWare 6: RAPID Live does not set virtual time in this release, although ABB's RWS 1.0 documents the speed write. Show / Control Virtual Time shows the time, speed and state there; change the simulation speed in RobotStudio.
- RobotWare 6 and 7: a remote jog was refused in the modes tried and has not been seen to succeed there; jog from the FlexPendant.
- RobotWare 8: the controller refuses the jog (Jog Robot and the Motion view), Start RAPID and Run Routine until motion control is allowed from this station. An 8.2.1 virtual controller answered 403 (-1073435864), even for a program that moves nothing. Allow Motion Control (RobotWare 8) allows it after you confirm both stops are within your reach (the client's `setAllowMotionControl`). The client withdraws it as the first request of a disconnect; if that withdrawal does not go through, whether the controller still counts it is not known. Stop RAPID is a program stop; RAPID Live gives no emergency stop or normal stop. The error of a start or a jog refused this way shows the client's reason and offers **Allow Motion Control…**; nothing is retried, so run the command again after allowing it. Allow (from a refused Run Routine's button, from the palette, and from Run Routine's Allow Motion Control first…), Run Routine after it, Withdraw and the withdrawal at disconnect ran on an 8.2.1 virtual controller; Start RAPID's and the jog's confirmations have not run against a controller. On that controller the allowance belongs to the control station, and when RAPID Live ends without the withdrawal (a crash), the controller keeps it for that station for more than 7 minutes; unless the robot's settings name a `controlStation`, RAPID Live registers under an id made for its connection, so no other window or tool takes it over. With a fixed `controlStation`, the client withdraws such a leftover at its first registration, and the robot reads not allowed.
- RobotWare 8: in this release RAPID Live does not withdraw motion control when you switch the active robot, and the client does not withdraw it when the operating mode changes or the FlexPendant takes write access. Both are built and held off until a run on a controller shows what a withdrawal does to a running program. Until then the allowance stays while the robot is connected: the status bar shows it for every robot that has one (several are counted, and a click asks which robot to withdraw it on), the robot's row in the Robots view says so and offers Withdraw Motion Control, and Withdraw Motion Control in the command palette acts on the one robot that has one, or asks which when there are several.
- RobotWare 8: Start RAPID warns when the controller enforces the heartbeat, because ABB documents no RWS way to send it; the start still goes out, and RAPID may stop after the timeout.
- Restore Backup keeps the backup: on both generations the client sends ABB's `delete-dir` as false, where the controller's default deletes the backup it restored. The restore has run on RobotWare 6. It has not been sent on RobotWare 7 or 8, so on RobotWare 8 the write access it needs is unrecorded; the client holds write access around it, as ABB's RobotWare 8 page asks, and the controller decides.
- Show Program Pointer + Motion Pointer: the client reads the motion pointer from the `motionpointer` entry of the task's program pointer resource, on both generations, so the MP line fills where the controller reports a position. On RobotWare 6.16.03 and 7.21.4 virtual controllers the client read a filled motion pointer (row 9, column 16) while a MoveAbsJ ran. On RobotWare 8 no program ran for it: the start was refused without the motion-control declaration. The read stays in both lists below. It sends the same request as the program pointer read, whose answer carries that entry with no position when no program has started. The client's logs keep no answer body, so a logged 2xx answer does not show that a position was read. While the controller reports none (no program started), the MP line shows dashes.
- A few built-in instructions and functions (BitSet, Abs, StrMatch and others) show only their kind in the hover, with no call shape, and some call shapes leave out arguments (TriggIO, TriggL, TriggJ, MoveJ, TriggEquip and others), where the source syntax was incomplete; ABB's RAPID reference manual has the full form.
- RobotWare 7: Request Remote Control at the `exec` level was refused by a 7.21.4 virtual controller in manual reduced speed (403, -1073445800), with the virtual controller's enable switch on and with Enable held at the virtual FlexPendant. A granted `modify` was still held after 3 minutes, until it was cancelled; ABB states no lifetime, and longer was not measured. Asking for `exec` while this session holds `modify` sends nothing and says so. Use `modify`, or do the step at the FlexPendant.
- RobotWare 7 and 8: a switch to Auto waits (`AUTO_CH`) until it is confirmed at the FlexPendant; RAPID Live does not send that confirmation, by design. A RobotWare 8.2.1 virtual controller also took Switch Operation Mode in a guard stop, in both directions. RWS 1.0 (RobotWare 6) has no operating-mode change.
- RobotWare 7, seen once on 7.21.4: a module named like one of its own global symbols, ignoring case, breaks ABB's rule that names are unique. The controller loads it with errors under a new name (`<NAME>#2`). The error of Load Program from File or Push Current File to Controller then names the module by that name. Unload Module by the original name is refused (403, -1073414145: the reason is written in the event log); the error then shows the newest event-log message, which may be about something else. Unload the module by the listed name. Neither error has been shown from a controller yet. Not tried on RobotWare 6 or 8. Name modules so they do not clash.
- RobotWare 8: an 8.2.1 virtual controller sometimes left the speed ratio out of the client's live updates while answering that it took them, so a speed ratio changed elsewhere showed only at the next slow poll; the cause is not known. The client now asks once more, with the resource in its other spelling, and if it is still left out polls everything at the full rate. In a test run on 2026-10-22 that virtual controller left the speed ratio out of all 24 subscription requests that named `/rw/panel/speedratio;speedratio`, and took it in each one that named `/rw/panel/speedratio`; the full-rate polling, for a speed ratio left out in both spellings, has not run against a controller.
- Module files with non-ASCII text: a controller reads a module file as single-byte text. On 6.16.03, 7.21.4 and 8.2.1 virtual controllers (2026-10-30) a UTF-8 file with an a-umlaut loaded with no error, the program text held mojibake, and RobotWare 7 and 8 saved it back double-encoded, so a push followed by a pull would corrupt the character and each further round trip would encode it once more. A windows-1252 file was read correctly on all three, and text written through RWS was stored correctly. A UTF-8 byte order mark loaded with a syntax-error event, and on RobotWare 7 and 8 the module came up named after the mark's first byte. RAPID Live therefore refuses any byte above 0x7F before sending, a byte order mark included. A later release may convert text to the controller's encoding and read it back by generation.
- RobotWare 6: Export Event Log writes the whole domain, newest first, up to 20 pages of 50 messages (about 1000), where earlier releases wrote the newest 50 only. The client follows the listing's next link page by page, so one export sends one request per page, and a later page that fails ends the export with the messages read so far. On a 6.16.03 virtual controller the client's page walk read the whole domain, 312 messages over seven pages.

### RWS 1.0 (IRC5, RobotWare 6)

- Jog Robot (`jog`)
- Request Remote Control (RMMP) at the `exec` level: not yet sent on RobotWare 6. `modify` was granted at the FlexPendant on a 6.16.03 virtual controller in manual reduced speed.
- Lock Operation Mode, Unlock Operation Mode (`lockOperationMode`, `unlockOperationMode`)
- Set Controller Clock (`setControllerClock`)
- Show Program Pointer + Motion Pointer: the motion pointer (`getMotionPointer`), listed although its request answers; see Open at this release
- Switch Operation Mode (VC only) is not one of these: RWS 1.0 has no operating-mode change, so the client refuses it before sending anything.

### RWS 2.0 (OmniCore, RobotWare 7 and 8)

- Get & Respond to UI Instruction: the answer (`setUiInstructionParam`)
- Set Controller Clock (`setControllerClock`)
- Restore Backup (`restoreBackup`)
- Show Program Pointer + Motion Pointer: the motion pointer (`getMotionPointer`), listed although its request answers; see Open at this release

### Dialogs

- **Allow Motion Control…** on a start or a jog refused because motion control is not allowed (RobotWare 8, RWS 2.0): not yet run from this button. It opens Allow Motion Control (RobotWare 8) for the robot that refused (`setAllowMotionControl`).
- **Request Remote Control** on an error that needs RMMP (RobotWare 6 and 7; RobotWare 8 has no RMMP): not yet run from this button on RWS 1.0, where it asks for `modify` (`requestRmmp`). The client's `modify` request was granted at the FlexPendant on a 6.16.03 virtual controller in manual reduced speed.

### Load .cfg File

Loading a configuration file with the action "add" was refused on the 6.16.03, 7.21.4 and 8.2.1 virtual controllers
(in AUTO, 2026-10-12) for a file the same controller had just saved: the controller answers "Name already exists in
database" (`SYS_CTRL_E_CFG_NAME_EXIST`, -1073437689), because the file holds instances that already exist. The error
shows the client's explanation, then its next step. On 6.16.03 the saved EIO domain was answered "Cfg file contains errors" (`SYS_CTRL_E_CFG_DATA_INCORRECT`, -1073437688) instead. "replace" and "add-with-reset" were not tried, and neither was manual mode.

### Virtual Time

- **Show / Control Virtual Time (VC only)** shows the time, speed and state and sets the speed (1x, 10x); pause and resume are not offered; RobotStudio's Simulation tab controls the virtual clock. RAPID Live does not set virtual time on RobotWare 6 in this release; there the command shows the time, speed and state, and the simulation speed is changed in RobotStudio.

Requests corrected in client 1.5.1 against the controller's form and ABB's manual: the
RWS 1.0 jog target (action `positiontarget`, 17 fields), Unlock Operation Mode (sends
the PIN), RWS 2.0 Activate/Deactivate Task (per-task resource, no body), Restore Backup
(keeps the backup directory, on both generations), the motion pointer (the
`motionpointer` entry of the program pointer resource, on both generations), and
virtual-time speed (the write on RWS 2.0, the read on both generations).

---

## Use it with ABB's extension

ABB's own [RAPID & Ecosystem Tools](https://marketplace.visualstudio.com/items?itemName=abb-robotics-ecosystem.abb-robotics) provides additional language-level features, including a formatter. Measured together on 2026-10-29 with VS Code 1.143.1, ABB 0.3.0 and RAPID Live 1.4.0, in both install orders: `.mod`, `.sys` and `.prg` open as `rapid`, RAPID Live's grammar colours them, ABB's formatter is the sole formatter and runs by default, and all RAPID Live commands are present. Hover, completion and the outline show entries from both. No setting is needed.

Since 0.3.0, ABB's extension also sets fixed colours for some RAPID tokens. Three of them are tokens RAPID Live's grammar gives too: flow keywords such as `IF` and `ENDIF`, strings and numbers. With both installed those show in ABB's colours in every theme, while `PROC`, `MODULE`, comments and instructions keep the theme's colours. Neither extension has a setting for it.

ABB RAPID Pack, a community extension, turns format on save on for RAPID files when it is installed. Push Current File saves an edited file before it sends it, so with more than one RAPID extension installed, check what a save does to your file. Details: [docs/coexistence.md](docs/coexistence.md).

---

## Cross-platform

Built on Node.js APIs only. Tested on Windows against RobotStudio virtual controllers; macOS, Linux and real controllers have not been tried.

---

## Before the robot moves

Every command that writes to a controller asks before it sends. The dialog names the robot
as `name (host:port)`, plus the name the controller reports for itself when that differs,
and the task when the write goes to one: the title reads `Push Current File in T_ROB2 on
Cell1 (192.168.125.1:443)`. A write that acts on the whole execution, such as Start RAPID
or PP to Main, lists every task it runs. For a connected robot the address is the one its
session is on, even when its saved address changed since (in another window, say). What it
asks depends on what the write does:

- **A command that can move the robot** - Start RAPID, Run Routine from the editor, Motors
  On, answering a UI instruction, the first jog on a connection (and the next one after the
  jog increment is raised above the confirmed value, the unit changes or the axis labels
  change) - shows what it does and then asks you
  to **type the robot's name** in a box, exactly as it is saved in the Robots view (spaces
  around it are ignored). A name that does not match sends nothing and says so. Apart from
  the jog this is asked every time, and there is no setting that turns it off.
- **A command that is hard to undo, or one only a virtual controller takes** - Load Program
  from File, Push Current File, Unload Module, Reset RAPID, PP to Main, Set PP from the
  editor when the file must be loaded first, Restore Module from Restore Point, Activate /
  Deactivate Task (one or all), Create CFG Instance, Lock / Unlock Operation Mode, Switch
  Operation Mode, Load .cfg File, Remove CFG Instance, Create New RAPID Task, Restart
  Controller, Restore Backup, Clear Event Log and Clear ALL Event Log Domains, Delete file or
  folder, Remove DIPC Queue and Set Controller Clock, the simulation commands (Simulate E-Stop,
  Reset Simulated E-Stop, Simulate General Stop, Simulate Auto Stop, Simulate Enable Switch,
  Teleport Robot to Joints), the speed actions of Show / Control Virtual Time, and Set Speed
  Ratio when it raises the ratio while RAPID runs, or when the current ratio is not read yet
  while RAPID runs - lists what it does behind one button,
  **Continue on <name>**.
- **A value write** - Write Signal, Toggle Signal (also the one-click toggle in the I/O
  panel), saving a CFG instance with Ctrl+S, Edit Watched Value, Write RAPID Variable, Set
  Execution Cycle, Set Speed Ratio in every other case, Set PP to Routine, the pointer move
  of Call Service Routine, Set PP from the editor when the module is loaded, Create Backup,
  Create Directory, Rename, Compress, Save Domain to .cfg, Create DIPC Queue, Send DIPC
  Message, Read DIPC Message (it takes the message off the queue), Set Active Tool / Work
  Object and Request Remote Control - is one button, **Write to <name>**.

- **Allow Motion Control (RobotWare 8)** - shows ABB's condition (an emergency stop and a
  normal stop within your reach), then **Both stops are within my reach**, then asks you to
  **type the robot's name**. Withdraw Motion Control never asks: it only removes the permission and is not a stop.

A cancelled dialog sends nothing. Stop RAPID and Motors Off never ask: they send at once and
show their result, as do Withdraw Motion Control and the release of this tool's own locks.
Open Loaded Module Source, Pull All Modules and Diff Current File with Controller write the
module to a temporary file on the controller and delete it afterwards, without asking about
that file. Pull All Modules does ask first, in a modal, before it overwrites local files of
the same name in the destination folder (**Pull**). When the controller refuses a load, an
unload or a pointer move because the program runs, the extension asks whether to stop it
first (**Stop Program and Continue**).

Every command that acts on one RAPID task takes the same task. That is the task the file
was pulled from, else the one task that has the module loaded, else the one active task.
When none of these settles it, as on a MultiMove system with a new module, the extension
asks which task in a list that names the robot, and a dismissed list sends nothing. Load
Program from File and Push Current File leave the program pointer where it is. For a file
with `PROC main` their message offers **PP to Main…**, which lists the tasks it moves behind
one button, **Continue on <name>**. On a multi-task system that is every task the
execution runs, the other tasks as well as the one the file went to.

### Watch only and Program and operate

RAPID Live treats each robot in one of two ways. In **Program and operate** every write is
sent after the dialog above. In **Watch only** RAPID Live reads from the controller and sends
no writes: a command that would write stops with a message that names the robot, and no
mastership, write access or RMMP is requested. The mode comes from what the controller
reports itself as. A virtual controller starts in Program and operate. A real controller, or
one that does not say what it is, starts in Watch only. A robot saved before 1.5.0 that
answers as a real controller is asked once, when it connects, with no answer preselected.
Closing that question leaves it in Watch only.

**Set Robot Mode** switches one robot, from the command palette, the robot's row in the
Robots view, the status bar item that shows the mode, or the button on a refusal. Switching
to Watch only withdraws the RobotWare 8 motion control and releases the locks RAPID Live
holds on that robot, and says so. The choice is kept per robot on this PC, bound to the
controller's kind and address, so a robot entry pointed at another controller asks again.
Stop RAPID and Motors Off are refused in Watch only too, so a click on the status bar cannot
stop a cell you chose to watch. Pull All Modules, Diff Current File with Controller and Open
Loaded Module Source still save a temporary copy to the controller's TEMP volume and delete
it. They change no program, configuration or state.

### Before a module is replaced

Push Current File and Load Program from File, and the loads of Set PP and Run this routine
from the editor, protect the controller's copy:

- An editor with unsaved changes to the file is saved first, so the file loaded is the one
  you see. A save that does not go through stops the command.
- The file is read as bytes. An empty file, and a file with a byte order mark or any
  non-ASCII character, is refused before anything is sent. The message names the line, the
  column and the byte, with a **Go to line** button. A controller reads a module file as
  single-byte text, so a UTF-8 character is stored wrong, RobotWare 7 and 8 save it back
  double-encoded, and a byte order mark becomes part of the module name there (checked on
  6.16.03, 7.21.4 and 8.2.1 virtual controllers on 2026-10-30, see Known limits). Replace the
  character and push again.
- The file name must be the declared module name, exactly: `Main_T2.mod` declares
  `MODULE Main_T2`. The controller loads a file under its file name and unloads a loaded
  module of that name first, so a file named for another module is refused, and the message
  says which name to change.
- RAPID Live reads the module from the task itself, not from its last poll. When it is there,
  the controller's copy is compared with the base recorded when you pulled the file (line
  endings aside). If the copy changed on the controller, nothing is sent and a message says
  so, with **Show diff** and **Push anyway…**. When RAPID Live has no record of pulling that
  file, it stops the same way once. After a push or a pull the controller's copy is recorded
  as the base. A controller copy equal to your file is nothing to push. Once you confirm, the
  copy is read once more: a change made while the dialog was open stops the push. The base
  and the check are both the program text as the controller holds it, with each PERS at its
  declared value, so a PERS that changes while the program runs does not count as a change.
  The file you pull carries the current values, as a module save does.
- Once you confirm, and before the load is sent, the controller's copy is saved as a restore
  point under the extension's global storage folder, outside your workspace (a cancelled or
  refused push leaves none):
  `restore-points/<robot>/<task>/<time>/<Module>.mod` next to a `restore.json`. The
  newest 20 per module are kept, and at most 100 MB in all.
- A load the controller takes without loading the module named counts as failed too, and so
  does one that lists it under a numbered name beside a module that stayed. A RobotWare 6.16
  controller loaded a file with no MODULE line under another name, and RobotWare 7 lists a
  name clash as the name with #2. After a restore the module is read back the same way.
- A .prg file is refused: it is a program, not a module. Load a program from RobotStudio or
  the FlexPendant.
- If the load fails, RAPID Live reads the module again and tells the cases apart. Still
  there as it was: nothing was lost. Gone: it offers **Reload the saved copy…** as a
  separate confirmed write. There but changed: the offer says the reload replaces what is
  loaded now, and saves that copy first. Not readable: the saved copy is named and nothing is
  offered. One message reports both steps. **Restore Module from Restore Point…** lists the
  saved copies of the active robot and runs the same confirmed write. The module loaded under
  that name at the time is saved as a restore point of its own first. A saved copy with
  non-ASCII characters is kept but not offered back.

The confirmation is the extension's, in front of the controller's own checks: the
controller still decides every write (mastership or write access, the operating mode, the
safety state), and a refusal is shown with the client's sentence saying what is missing
and who can supply it, with the buttons acting on the robot that refused.

## Starting RAPID on RobotWare 8

On RobotWare 8 a remote station must allow motion control before it can start RAPID or jog. ABB
treats allowing it as the station's confirmation that an emergency stop and a normal stop are
available at that station (RWS 2.0 Control Station Service, Allow Motion Control).
A normal stop is the FlexPendant's Stop button held for more than 1 second, or a safe input set
up for it. RAPID Live gives neither stop.

1. At the FlexPendant: Auto mode, Remote Access on (hold the Message button for more than 1
   second), the motors on, and no other station holding write access.
2. In RAPID Live, Start RAPID or **▶ Run this routine**. On RobotWare 8 the confirmation says
   whether motion control is allowed from this station and, when it is not known to be,
   offers **Allow Motion Control first…**.
3. **Allow Motion Control first…** shows what you confirm: both stops within your reach, for
   every robot and axis the controller moves, and what a normal stop is. On a virtual
   controller, RobotStudio's virtual FlexPendant stands in for the FlexPendant. Choose **Both
   stops are within my reach**, then type the robot's name. Cancel, or a name that does not
   match, sends nothing.
4. The start confirmation shows again; type the name again, and the start goes out. Two
   typed names, every time motion control is allowed.

The same dialog is **ABB Robot: Allow Motion Control (RobotWare 8)…** in the command palette,
and **Allow Motion Control…** on the error of a start or a jog the controller refused for it.
After it, run the refused command again: nothing is retried on its own. Allow acts on the
active robot only.

While it is allowed, the status bar shows **Motion allowed since HH:MM** and the robot's row in
the Robots view says **motion allowed**; click the status bar item, or choose **Withdraw Motion
Control** on the robot's row, to withdraw it. With several robots allowed, the status bar counts
them and its click asks which robot to withdraw it on.
**ABB Robot: Withdraw Motion Control (RobotWare 8)** withdraws it at once, with no dialog.
Withdrawing is not a stop. When you disconnect or remove the robot, the withdrawal is the
first request of the disconnect; when you close the window, RAPID Live tries to send it. It
never allows it again on its own after a reconnect.

A robot entry with a `controlStation` field in its settings registers as a fixed control
station, which other windows or computers with the same setting share; RAPID Live does not
allow motion control for it. Its start and jog confirmations and its errors name the
FlexPendant instead of offering Allow Motion Control, and the command refuses it. RAPID Live's handling of a fixed station is built and tested
offline and has not run against a controller; Allow Motion Control, Run Routine after it, Withdraw and the disconnect's withdrawal ran on an
8.2.1 virtual controller (see [Known limits](#known-limits)).

## Before you connect to a real cell

RAPID Live has been tested on RobotStudio virtual controllers and has not yet run against a real controller. Its confirmations are there so that a click goes to the robot you meant. They are not safety functions. They do not replace the controller's own checks, the FlexPendant, or the stops and safeguards of your cell. ABB's safety manual for your robot and controller applies to everything you do with it, and so do your site's rules.

By default RAPID Live does not check the controller's TLS certificate, because OmniCore controllers ship with a self-signed one. To check it, install a certificate on the controller that your PC trusts, turn on the `abbRobot.strictTls` setting, then reload the window. RobotWare 6 (IRC5) has no TLS: RWS 1.0 is plain HTTP with Digest authentication.

---

## Development

The extension bundles the client from a tarball that is not tracked in git:
`package.json` pins `file:vendor/abb-rws-client-1.5.3.tgz`, and `package-lock.json`
holds that tarball's sha512. Build it from the client at the matching tag:

1. Clone the client beside this repo, at the tag matching the pin (the tag exists
   once that client version is published; before that, check out the client branch
   that carries that version):

   ```
   git clone --branch v1.5.3 https://github.com/ichbinmeraj/abb-rws-client.git ../abb-rws-client
   ```

2. `npm run vendor`: makes `vendor/`, installs the client's dependencies if it has
   none, and packs it into `vendor/abb-rws-client-1.5.3.tgz` (the client's own build
   and tests run first, a minute or two). It refuses a client whose version the pin
   does not name.
3. `npm ci`

Then:

```
npm run typecheck
npm run build
npm test
npm run package
```

The client checks its text files out with LF on every platform, so the same tag packs
to the same bytes everywhere and `npm ci` accepts it. `npm test` fails when the
tarball, the lock and `node_modules` disagree.

## Contributing & feedback

- Issues / PRs: <https://github.com/ichbinmeraj/abb-rws-vscode>
- Release history: [CHANGELOG.md](./CHANGELOG.md)

## Licence

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). If you redistribute
this work, keep the NOTICE file.

Releases up to and including 1.2.0 were published under the MIT License and
remain available under those terms.

Contributions are accepted under the DCO - see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Disclaimer

Independent open-source project by [Meraj Safari](https://github.com/ichbinmeraj).
ABB is a trademark of ABB Asea Brown Boveri Ltd. IRC5, OmniCore, RobotWare, RobotStudio,
RAPID and FlexPendant are trademarks of their respective owners. **This project is not
affiliated with, endorsed by, sponsored by or supported by ABB, ABB Robotics or any later
owner of these products.** Project names and trademark position: see
[TRADEMARKS.md](./TRADEMARKS.md).
