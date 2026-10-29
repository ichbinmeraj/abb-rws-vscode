# Changelog

## Unreleased

## 1.4.1 - 2026-10-30 - Every task command goes to the task you meant

### Fixed

- **Multi-task systems (MultiMove).** Push Current File to Controller, Load
  Program from File, Diff Current File with Controller, Call Service Routine,
  Show Program Pointer, Pull All Modules, Validate RAPID Value and Add
  Selection to Variable Watch used the first active task, whatever task the
  module belonged to, so a module of T_ROB2 could go to T_ROB1 with no
  warning. They now take their task by one rule: the task the file was pulled
  from, else the one task that has the module loaded, else the one active
  task. Otherwise RAPID Live asks which task, in a list that names the robot,
  and a dismissed list sends nothing. A file pulled from a task the connected
  robot does not have always asks. Set PP to Routine, Unload Module, Open
  Loaded Module Source, View Module Text, Download Module to File, and Set PP
  and Run this routine from the editor follow the same rule where they took
  the first task that listed the module. No command uses T_ROB1 as a default
  any more. The Task box of Read Variable, Write Variable, Symbol Properties
  and Search Symbols is filled in only when one task is active.
- **The program pointer after Push and Load.** Push Current File and Load
  Program from File moved the program pointer to main for the whole
  execution whenever the file had `PROC main`, which on a multi-task system is
  every task it runs. They now leave it where it is. For a file with
  `PROC main` their message offers **PP to Main…**, which asks first and names
  the tasks it moves. Set PP and Run this routine from the editor load with
  the pointer untouched and then set it in their own task, as before.
- Hover live values, inlay hints and the program pointer marker read the
  file's own task. Where the rule cannot settle one they show nothing, not
  another task's value. The Live Cell view lists every active task.

### Changed

- Pull All Modules, Open Loaded Module Source, View Module Text, Download
  Module to File and a successful Push or Load record the task and a hash of
  the text for each file path. The folder layout is the same.
- The messages of Push, Load, Pull All, Set PP, Unload, Show Program Pointer
  and the watch name the robot and the task. The confirmation of Edit
  Watched Value names the task.
- Listing: the Debuggers category is gone (RAPID Live has no debugger), and
  so is the step debugging line under Coming soon. README: the comparison
  table against ABB's extension 0.1.0 is replaced by prose about ABB 0.3.0
  (checked 2026-10-28), the Git workflow box by two sentences, and the PC
  SDK sentence is corrected. New: a No telemetry line, and a Before you
  connect to a real cell section in place of Safety notes, whose link opened
  ABB's IRC5 troubleshooting manual. The trademark lines name ABB Asea Brown
  Boveri Ltd and any later owner of these products.
- Running next to ABB's RAPID & Ecosystem Tools, measured again with ABB 0.3.0
  (README and docs/coexistence.md): everything measured with 0.1.0 holds. New
  in 0.3.0, ABB's fixed colours apply to flow keywords, strings and numbers in
  RAPID files when both are installed. Also measured next to ABB RAPID Pack
  2.0.0, whose defaults turn format on save on for RAPID files. Push Current
  File saves an edited file before it sends it.

Checked on RW 8.2.1 virtual controllers. With one task, a new module was
pushed and then pushed again with a change, each read back with the module
text. The rule took T_ROB1 with no pick, and no PP to Main went out. With two
tasks (T_ROB1 and a second normal task, with the Multitasking option), Load
Program from File asked which task, Pull All Modules recorded the second task,
and Push and Diff went back to it with no pick. Every file was read back, and
T_ROB1's program pointer stayed on its routine through each of these. A module
of the same name in both tasks made the rule ask, offering the two. PP to Main,
as its own ask, moved both tasks to main. Not checked on a controller: the
pointer move of Call Service Routine in a second task, which the client holds
back on RobotWare 8 in Auto, and an IRC5 MultiMove system.

## 1.4.0 - 2026-10-25 - Add Robot through findControllers, motion control on RobotWare 8, abb-rws-client 1.5.1

1.3.0 was prepared but not published; its changes ship in this release,
under "Prepared as 1.3.0 (not published)" below, so this section lists
everything since 1.2.0. Entries that compare with 1.3.0 compare with that
prepared version. abb-rws-client 1.4.0 (which 1.3.0 bundled) and 1.5.0 were
not published either; their changes ship in abb-rws-client 1.5.1, which
this release bundles.

### Added

- **Allow Motion Control (RobotWare 8)** and **Withdraw Motion Control
  (RobotWare 8)**. On RobotWare 8 the controller refuses a RAPID start and a
  jog until motion control is allowed from the station; ABB treats allowing
  it as the station's confirmation that an emergency stop and a normal stop
  are available. Allow shows the client's text (both stops within your
  reach, for every robot and axis the controller moves, and what a normal
  stop is), then RAPID Live's lines (Stop RAPID is a program stop; neither
  RAPID Live nor VS Code gives an emergency stop or a normal stop; when it
  ends; in a remote window, that the stops must be within reach where you
  are), then the button "Both stops are within my reach", and then asks you
  to type the robot's name. It acts on the active robot only, sends nothing
  on RobotWare 6 or 7, and is neither offered nor sent for a robot whose
  settings carry a fixed `controlStation` (its confirmations and errors
  name the FlexPendant instead). The client withdraws it as the first
  request of a disconnect (Disconnect, Remove Robot, and closing the window,
  which now disconnects every robot at once) and after a re-issued
  controller session; if a withdrawal does not go through, whether the
  controller still counts it is not known. Withdraw sends at once, with no
  dialog, like Stop. Ran on an RW 8.2.1 virtual controller: a refused Run
  Routine's Allow Motion Control…, Cancel, Escape and a wrong name sent
  nothing; Allow Motion Control first… with the right name, then the routine
  ran; Stop; Withdraw; the disconnect's withdrawal went out first. There the
  allowance belongs to the control station, and a process that ends without
  the withdrawal leaves it standing for that station for more than 7
  minutes; unless a robot's settings name a `controlStation`, RAPID Live
  registers under an id made for its connection, so no other window or tool
  takes it over; with a fixed `controlStation` the vendored client withdraws
  such a leftover at its first registration (no notice: RAPID Live did not
  allow it), and the robot reads not allowed.
- **The status bar and the Robots view show it**: "Motion allowed since
  HH:MM", or "Motion control: not known" when the controller did not answer
  after RAPID Live allowed it. Clicking the status bar item withdraws it;
  with several robots allowed it counts them and asks which robot. The
  robot's row in the Robots view offers Withdraw Motion Control, and the
  command palette's Withdraw acts on the one robot that has it, or asks.
  Notices say when the client withdrew it, and warn when a withdrawal did
  not go through, also when the client disconnected on its own after failed
  polls (then with no buttons). Disconnect says "Disconnected." whenever no
  such notice did.
- **On RobotWare 8 the start, run and jog confirmations say whether motion
  control is allowed, and offer Allow Motion Control first…** where it is
  not known to be, and say what that button does. That runs Allow; then the
  same confirmation shows again and still asks for the typed name. After
  any Allow the controller may have taken, also one it did not answer, the
  next jog asks for its confirmation again.
- **A start or a jog refused because motion control is not allowed offers
  Allow Motion Control…** for the robot that refused. Nothing is retried:
  run the command again. A jog refused this way asks for its confirmation
  again on the next jog.

### Changed

- **Vendors abb-rws-client 1.5.1.** What changes for RAPID Live: a load that fails after the
  controller loaded the module under a name of its own (`<NAME>#2`) names
  the module by that name; an unload refused with its reason in the event
  log (403, -1073414145) shows the newest event-log message, which may be
  about something else, and the name to unload by; on RobotWare 8, when a
  virtual controller leaves the speed ratio out of the live updates, the
  client asks once more and otherwise polls everything at the full rate;
  on RobotWare 6, Export Event Log writes the whole domain, newest first, up
  to 20 pages of 50 messages (about 1000), where it wrote the newest 50
  only, with one request per page. The event-log page walk read a 6.16.03
  virtual controller's whole domain (312 messages, seven pages), and the
  speed ratio's second request ran on an 8.2.1 virtual controller
  (2026-10-22: the controller left the speed ratio out every time the
  client first asked for it and took it each time the client asked once
  more); the module name, the unload message and the full-rate polling
  have not run against a controller yet. Known limits say so. On RobotWare
  6 the I/O view lists every signal, where it listed the first 100: the
  client follows each page's next link, so each read of the signal table
  sends one request per 100 signals. That walk has not run against a
  controller (a 6.16.03 virtual controller has 62 signals, one page). When a
  controller leaves the event log out of the live updates while answering
  that it took them (a RobotWare 6.16.03 virtual controller did for a whole
  run, 2026-10-22), Recent Events is read on the slow poll, about once every
  five refresh intervals (5 s at the default `abbRobot.refreshInterval` of
  1000 ms), where it was read only by the occasional whole read, about once
  every 2.5 minutes at that default, or by Refresh Event Log; when it leaves
  out the RAPID execution state, the client polls at the full rate. RAPID
  Live does not show the client's reason for either; the polled event log
  has not run against a controller yet. The client also reads a program's
  build errors as XHTML on RobotWare 7 and 8, sends
  mastership of every domain as each domain's resource, and explains a
  registration without a locale and a second RobotWare 6 subscription
  socket; RAPID Live calls none of these.
  On RobotWare 7 and 8 the credentials go out only until the controller issues
  a session cookie, and after it answers 401 to that cookie (a session that
  idled out or a restarted controller) the client logs in once with a short
  request of its own and sends the refused request again with the new
  cookie, so a request the controller holds open never holds a stop or a
  poll behind it; with `abbRobot.strictTls` on, Add Robot's scan
  checks a controller's certificate against the same authorities as the
  connection (Node's own and the operating system's store), so a certificate
  a company CA signed is no longer listed as not trusted. RAPID Live has not
  run either against a controller yet.
  With `abbRobot.strictTls` off (the default), the log says once per
  controller and port that its certificate is not checked, with how to make
  the controller's certificate or its CA trusted (`NODE_EXTRA_CA_CERTS`, or
  this PC's certificate store on Node 22.15 and later; the client cannot pin
  one certificate per controller); not for a virtual controller on this PC's
  loopback. The line names the client's own option, and RAPID Live adds the
  setting to turn on: `abbRobot.strictTls`, then a window reload.
  The I/O view's values come from the signal table, which the client now
  reads at connect and then about once a minute (a failed read again after
  5 s, 10 s, 20 s, 40 s, then each minute), not every fifth poll, so a value
  there can be a minute old; Refresh I/O Signals reads it at once. A Refresh
  I/O Signals that overlaps the client's own read keeps the newer table and
  does not bring the next read forward, and a clock set back does not hold
  the next read off.
  Load .cfg File explains a file whose version header is malformed
  (-1073437686, which the 6.16.03, 7.21.4 and 8.2.1 virtual controllers
  answered to a file with no header) and shows the next step, to check the
  file's first line, where it showed the controller's message alone.
- **Load .cfg File shows the client's explanation of a refused load.** The
  vendored client explains "Name already exists in database" (-1073437689)
  and "Cfg file contains errors" (-1073437688) as a refusal of the file on
  every generation, so the error shows the client's sentence and the
  controller's answer, then the client's next step: load a file that holds
  only instances the controller does not have yet, or remove the existing
  instance first; for a file with errors, check the file first. RAPID Live's
  own sentence for the two codes (1.3.0, below) is kept as a fallback, only
  for an error that carries one of them without the client's explanation
  (for another operation than the load, about the instance or the data, not
  a file); the bundled client explains both, so with it the fallback does
  not show. Seen refused with "add" in AUTO on 6.16.03, 7.21.4 and 8.2.1
  virtual controllers (2026-10-12); the client's sentence has not been shown
  from a controller yet.
- **The error buttons follow the client's next step for each refusal**
  (`refusal.remedy`). A button only for a step RAPID Live takes after you
  confirm: Allow Motion Control… (RobotWare 8) and Request Remote Control
  (RobotWare 6 and 7, at the level the client names for the refused
  operation). A step that only a person at the FlexPendant, the holder, an
  administrator or the integrator can take is explained in the message and
  never offered as a button. RAPID Live no longer keeps its own rule for the
  RMMP level. Request Remote Control is now also offered where RobotWare 7
  refused a pointer move to a routine in manual mode (at the exec level).
- **The next step after a start or jog refused for motion control** names
  Allow Motion Control, or the FlexPendant (the FlexPendant only for a robot
  with a fixed `controlStation`); it no longer says that RAPID Live cannot
  make the declaration.
- **After the operator denied an RMMP request**, the warning adds the
  client's next step: speak to the operator first. Nothing asks again on its
  own.
- **Show Holder names the FlexPendant the same way on every generation.**
  RobotWare 7 names a FlexPendant hold of mastership as a local holder with
  the application `TPU`, and RobotWare 8 names it as the control station
  `FlexPendant`; Show Holder now says `held-by=the FlexPendant` (RobotWare 7)
  and "held by the FlexPendant" (RobotWare 8) for these two. Any other holder
  is named as the controller gives it, a remote holder with application `TPU`
  and a station named `TPU` too (neither has been seen). A RobotWare 6
  pendant holder has not been checked: Show Holder shows what the controller
  reports there.
- **Remove Robot waits for the disconnect**, so on RobotWare 8 the withdrawal
  goes out first and its notice follows. **Closing the window disconnects
  every robot at once**, so each robot's withdrawal goes out before any slow
  step of another robot's disconnect.
- **Host harness, Start RAPID (step E1)**: after the wrong robot name, the
  name box is also answered with nothing typed (Enter on an empty box); the
  step passes when that is refused the same way and no start is sent. Not
  yet run against a controller.
- **Host harness, `RWS_TEST_HOST`**: takes the same two forms as the
  client's live suites, which read the same variable: an http(s) URL
  (`https://127.0.0.1:80`, its scheme, host and port) or a bare host
  (`127.0.0.1`), with `RWS_TEST_SCHEME` and `RWS_TEST_PORT` for a bare host
  (https and the scheme's own port by default). A host with a port and no
  scheme (`127.0.0.1:80`), which the harness used to read as https, is
  refused by both, with the forms to give instead.
- **CI starts a real VS Code.** The host job used to run only the plain
  host harness, which without a controller skips every step and passes. It
  now also packages the .vsix and runs host step U1 (language features on a
  small .mod, and every contributed command registered), which needs no
  controller, in the latest stable VS Code for Linux under xvfb, and says in
  the job summary what ran and what did not. The harness takes
  `VSCODE_CLI` and `RWS_TEST_VSCODE_ARGS`, and finds the CLI beside
  `VSCODE_EXE` in the Linux archive. U1 passed in a local run on VS Code
  1.142.0 for Windows; the CI job has not run yet.
- In this release RAPID Live does not withdraw motion control on a switch of
  the active robot, and the client does not withdraw it on a change of
  operating mode or when the FlexPendant takes write access. Both are built
  and held off until a run on a controller shows what a withdrawal does to a
  running program. Known limits say so.

### Fixed

- **The live updates come back after a slow connect or a lost stream.** When
  the controller did not answer the bundled client's subscription request in
  time at connect, or the live updates were lost later, RAPID Live polled the
  controller at the full rate (every `abbRobot.refreshInterval`, 1000 ms by
  default) for the rest of the connection, with no live updates. A RobotWare
  6.16.03 virtual controller connected together with two others did not
  answer that request within 5 s in three rounds out of three (2026-10-25).
  The client now asks again while connected without live updates, after 5,
  10, 20 and 40 s, then each minute, and 10 minutes apart after three
  requests in a row that got no answer in time; once one lands, it polls at
  the slow rate again. On RobotWare 6 the subscription request waits 10 s
  for its answer, where it waited 5 s, and when the controller closes the
  live-update connection the client reconnects it, where the updates stopped
  while the slow poll went on. The cost, on RobotWare 6: the client sends
  one request at a time, so a subscription request the controller never
  answers holds the next request, Stop RAPID among them, for up to 10 s, and
  the retries can do that again, at most three times in a row. On 2026-10-25
  the client ran this on RobotWare 6.16.03, 7.21.4 and 8.2.1 virtual
  controllers: with the 10 s wait the RobotWare 6 connect got its live
  updates in each of three rounds, and after a simulated loss each
  controller had them again within 8 s. RAPID Live has not run it against a
  controller yet.
- **RobotWare 6 controllers on ports that Node's `fetch` refuses can be
  reached.** The bundled client sent every RWS 1.0 request through Node's
  global `fetch`, which refuses the Fetch standard's "bad ports" (7, 21, 22,
  6000, 6665-6669 and 10080 among them) before sending anything, so Connect
  failed with "fetch failed" for a controller on such a port. A RobotWare
  6.16.03 virtual controller came back on port 7 after a restart
  (2026-10-22); a real IRC5 behind port forwarding can sit on any port. The
  client now picks the transport once per connection, from the robot's port
  (80, or 443 for https, when the address names none): on a port `fetch`
  refuses, RWS 1.0 requests go through `node:http` / `node:https`, as its
  RWS 2.0 requests already went; on every other port they go through
  `fetch`, as before. Only for a controller on such a port, inside VS Code
  with its proxy support on (`http.proxySupport` not `off`, the default),
  each RWS 1.0 request goes on a connection of its own, as RWS 2.0 requests
  already did; on every other port RobotWare 6 keeps one connection, as
  before. RAPID Live has not run this against a RobotWare 6 controller yet.
- **Connect asks before it takes a controller on another port.** When a
  saved robot on this PC answered nothing on its saved port, the bundled
  client looked on this PC's other ports and, when one controller of the
  robot's protocol answered, logged in to it with the robot's user and
  password and saved its port, without asking. A robot that had connected
  before in the same window logged in to each such controller to compare
  system ids. Connect now looks first (probes without credentials) and
  shows a modal that names the robot, its saved address and each
  controller found (the address Connect will use, and the name and
  RobotWare version where this PC can read them from the virtual
  controller's system folder), plus the controller the robot last
  connected to when this PC has a record of it. The chosen controller is
  probed again after the answer; the user and password go only to it, and
  its port is saved once it connects. Cancel sends nothing. When no other
  controller answers, or this PC cannot be searched, Connect stops, says
  which address answers nothing, and sends nothing. A port chosen this way
  that does not connect is not saved. Telling two controllers apart needs a
  login, so the dialog comes every time the port moved, also for the same
  controller.
- **Connect asks when the saved address answers as another controller.**
  Virtual controllers that restart together can swap ports. A robot that
  had connected before in the same window then logged in to each
  controller of its protocol on this PC to look for its own, and took the
  one that matched. Each Connect now starts the robot's session afresh, so
  the client has no system id to look for. When the saved address answers
  as another system than the one the robot last connected to, Connect
  disconnects, saves nothing, and asks before it keeps that controller as
  the robot.
- **If the controller stops answering during the connect itself** and
  another controller on this PC answers instead, RAPID Live disconnects
  from it at once, saves nothing, and says so. A busy controller is probed
  again before each retry; when it answers nothing any more, Connect stops.
- **One Connect per robot at a time.** A second Connect for a robot while
  one runs (a double click, Reconnect while the row's Connect runs) does
  nothing, so the question is not shown twice and a second answer cannot
  undo the first.
- **Connect on a connected robot whose saved address changed** (in Edit
  Robot, or outside this window) runs the checks above before it
  reconnects. Until then the robot stays connected where it is.
- **A port changed outside this window during a connect that fails is
  kept.** Only a port chosen in the question goes back to the saved one.
- **Reconnect after a lost connection goes through Connect.** The button of
  the "disconnected" error ran the client's own reconnect, which looked for a
  moved port without asking. It now runs Connect for that robot, with the
  questions above, and saves a chosen port as Connect does.
- **What each robot connected to is recorded on this PC** (system id, name,
  RobotWare version) in the extension's global state, not in the synced
  robot list, for the questions above. Remove Robot deletes the record.

- **Show Virtual Time says nothing about RobotWare 6 until it knows the
  generation.** While a robot's generation was not known yet, the notice
  showed the RobotWare 6 sentence whatever the robot. It now shows the
  reading alone, with no speed action, until the generation is known.
- **A load that ends in a semantic error keeps the client's report.** When
  the move of the program pointer to main after Load Program from File or
  Push Current File to Controller was refused for a semantic error, the
  error said the load was "blocked" and gave only the PROC main() hint,
  although the module had been uploaded and loaded. It now shows the
  client's report of what was done, with the hint after it.
- **A RAPID semantic error is told by the controller's code** when the error
  carries one. A client sentence that quotes an event-log message about a
  semantic error no longer turns another refusal into the PROC main() hint.
- **Compress says the job started.** The controller answers 202 and writes
  the archive after that; the message said "Compressed".

### Prepared as 1.3.0 (not published)

#### Added

- **The writes that move the robot or are hard to undo ask first, naming the
  robot.** Before one of the commands below changes a controller, a dialog names the robot as `name (host:port)`, plus the name
  the controller reports for itself when that differs, so two entries for
  one controller or two controllers with similar names are told apart.
  Three kinds: a command that can move the robot (Start RAPID, Run routine
  from the editor, Motors On, answering a UI instruction, the first jog on a
  connection and the next one after the jog increment is raised) shows what
  it does and then asks you to type the robot's name, exactly as saved
  (spaces around it are ignored); a command that changes the controller in a
  way that is hard to undo, or that only a virtual controller takes (Lock /
  Unlock Operation Mode, Switch Operation Mode, Load CFG File, Remove CFG
  Instance, Create RAPID Task, Restart, Restore Backup, Clear Event Log and
  Clear ALL Event Log Domains, Delete file or folder, the simulation
  commands and Teleport, the Virtual Time speed actions, and Set Speed Ratio
  when it raises the ratio while RAPID runs) lists what it does behind one
  "Continue on <name>" button; a value write (Write Signal, Toggle Signal,
  also the one-click toggle in the I/O panel, saving a CFG instance with
  Ctrl+S, Edit Watched Value, Set Speed Ratio in every other case, and, only
  while RAPID runs, Set PP to Routine, Unload Module and Call Service
  Routine's pointer move) is one "Write to <name>" acknowledgement. A
  cancelled dialog sends nothing. No setting turns a confirmation off. The
  other writes (PP to Main, Set PP from the editor, Set Execution Cycle,
  Load Program from File, Push, Write RAPID Variable, Set PP to Routine,
  Unload Module and Call Service Routine while RAPID is stopped, Create
  Backup, Create Directory, Rename, Compress, Create CFG Instance, Save
  Domain to .cfg, the DIPC commands, Activate / Deactivate Task, tool and
  work object, Set Controller Clock) send at once and show their result.
  Run routine asks once for everything the click does (load, program
  pointer, motors, start); the separate "turn motors on?" question is gone.
  The jog confirmation is kept per robot and per connection (it used to be
  one flag for the whole session). Stop RAPID and Motors Off never ask.
- **`npm run test:host`**: the host harness (`test/host/`) drives the
  installed .vsix in a real VS Code against one controller, with the dialogs
  answered by a script, and writes `test/host/last-run.md` with every request
  and every dialog text per step. Steps: Lock / Unlock Operation Mode,
  Virtual Time, Create Backup, Call Service Routine, Start RAPID with a wrong
  and (opt-in) the right robot name, a probe digital output toggled and put
  back, Load CFG File cancelled, and a CFG instance saved from one of two
  entries for the same controller. Without `RWS_TEST_HOST` it skips itself,
  so CI runs it on every push.

- **Add Robot: saved addresses and ranges.** "Add address / range…" in the
  Add Robot picker saves an address, `host:port`, or a private IPv4 range
  (`10.0.5.0/24`, `10.0.5.20-10.0.5.60`, at most 256 addresses per scan) in
  the new user settings `abbRobot.discoveryManual` and
  `abbRobot.discoveryRanges`; `abbRobot.discoveryPorts` adds extra ports.
  All three are machine-scoped, so a workspace's `.vscode/settings.json`
  cannot set them. Saved addresses are probed on every scan; a range only
  when you pick it, and every range scan asks first with a plain note that
  IT can see the connection attempts on a company network.
- **Add Robot: "Scan again with options…"** ticks the service port address
  `192.168.125.1`, mDNS, the saved addresses and saved ranges for one scan.
- **Remove saved addresses and ranges.** Every saved address and saved range
  in the Add Robot picker has a trash button ("Remove from saved"); the list
  updates in place. A saved address that answered is listed too, so each one
  can be removed. **ABB Robot: Manage Saved Addresses and Ranges…** (also in
  the picker and in the Robots view's "…" menu) removes several at once, or
  all of them after a confirmation; **ABB Robot: Remove All Saved Addresses
  and Ranges…** does the latter directly. Only the removed entries leave the
  settings; the other entries, the extra ports, saved robots and their
  passwords stay.
- **Right-click menu on a robot** in the Robots view: Connect or Disconnect,
  Set as Active Robot, and Remove Robot…. The quick start and the walkthrough
  already pointed at "right-click → Connect".
- **Unit tests** (`npm test`, Node's built-in runner) for the discovery
  flow's parsing, scan options, range confirmation, picker rows and the
  settings' scope, for removing saved entries, for the Robots view menus,
  and for the bundled client pin (the lock's integrity matches the vendored
  tarball).

#### Changed

- **The Marketplace display name is now "RAPID Live for ABB Robots".** The
  extension id (`merajsafari.abb-rws`), its settings and its commands are unchanged.
- **Hover, completion and signature help show signatures and parameters
  only, no reference-manual text.** For a built-in RAPID instruction,
  function or data type they show its kind, its call shape, its parameters
  with their types and optional / switch markers,
  and a function's return type; descriptions and examples are no longer
  shown. The hover points to ABB's RAPID reference manual for what an
  instruction does. All 705 names are still there; `GetSysData`,
  `RenameFile`, `PathRecStop`, `GetTaskName`, `IsPers`, `IsVar`, `Present`
  and `TextTabGet` now have signature help too. 105 call shapes gained
  arguments the old parameter lists missed, 52 of them a required one: for
  example `Interrupt` in `ITimer`, `TriggValue` and `Interrupt` in
  `ISignalDI`, `ModuleName` in `Save`, `ArrPar` in `Dim`, `ToPoint` in
  `TriggL`, `\SDelay` in `SetDO`, `\Z` and `\Inpos` in `MoveAbsJ`.
- **The error dialog is bound to the robot that refused, and names it.** Every
  command resolves its robot before it sends anything; the error it shows starts
  with that robot's name and address, reads
  that robot's state and acts on that robot, whichever one is active by the
  time you answer; the trace line for the error names the robot. The buttons
  follow the client's refusal only: **Request Remote Control** where RMMP is
  what is missing (manual mode, RobotWare 6 and 7); **Show Holder** where
  another client holds mastership (RobotWare 6/7) or write access
  (RobotWare 8, which reads the control-station status and shows the
  station's name, never an id). **Force-Release** is now **Release this
  tool's control of <robot>**, which is what it always did: it releases this
  session's own locks and nobody else's. The guesses from a 403 or 400 and
  the robot's mode ("in MANR the FlexPendant has priority", "may need the
  motors on") are gone, and so is Switch Operation Mode's own list of
  likely causes; the client's sentence says what is missing and who can
  supply it. The hints that are not refusals stay (a busy controller, a
  missing program pointer, a path that does not exist).
- **Start RAPID and Run routine warn about the RobotWare 8 heartbeat.** On
  RobotWare 8, when the controller's HeartBeat is enforced, the confirmation
  says that the station holding write access must send a periodic heartbeat
  while RAPID runs, that RobotWare 8 offers no RWS way to send it, and that
  RAPID may stop after the timeout. The start still goes out when you confirm.
- **Run routine lists everything the click can do**, including unloading a
  module that also declares `main` if the controller refuses the pointer
  move for that reason, and turning the motors on; nothing is asked again.
- **Restart says what each mode does** to programs and configuration.
- **A robot with no saved name cannot be confirmed**: the command says to
  give it a name and sends nothing.
- **Known limits follow the client's evidence.** The vendored client was
  packed from a later commit whose live runs moved Write Signal (RWS 1.0),
  Activate / Deactivate Task, the event-log clears, tool and work object,
  and the CFG writes (RWS 2.0) out of "never run"; the README lists follow.
- **Request Remote Control (RMMP) says what it is and what it covers.** RMMP is "Request Manual Mode Privileges" (it was called
  "Remote Mastership Privilege"). The command and the error dialog's button ask for the level that fits: `modify` for RAPID data
  writes and module loads, `exec` for moving the program pointer to a routine on RobotWare 7 (ABB: RMMP_Exe); the palette command
  asks which. After a grant the message says what the privilege covers instead of "Retry the operation": it does not cover Start,
  PP to Main or a pointer move under `modify`, which ABB gives to a remote client in Auto or to the FlexPendant, and the dialog
  for a refused Start or PP to Main has no Request button. RobotWare 7 takes the request in MANR only (MANF was listed as
  allowed).
- **Edit Watched Value writes to the robot the row's value came from.** The watch list is per workspace and is read from the active
  robot; the write used to go to whichever robot was active when the value was typed. The input box now names the robot, a "Write
  to <name>" confirmation follows, and the write and any error go to that robot. A robot that is no longer connected is said so and
  nothing is sent.
- **Remove CFG Instance names the robot** and uses the same one-button confirmation as the other disruptive commands.
- **DIPC: Create Queue says what is required.** ABB: the queue size (1 to 32767) is required; the message size (1 to 448) is optional
  on RobotWare 7 and 8 and required on RobotWare 6 (1 to 444); no defaults are documented. The two boxes were both marked
  "(optional)" and an empty queue size ended in the controller's 400. They now say what is required and refuse an empty or
  out-of-range value.
- **Load .cfg File says what the controller refused**: a file that holds an instance whose name already exists ("Name already exists
  in database", -1073437689; every file saved from the same controller does) and a file the controller finds errors in ("Cfg file
  contains errors", -1073437688, seen on RobotWare 6 for a saved EIO domain). The pick list no longer describes "add" as leaving
  existing instances unchanged. Seen refused in AUTO on 6.16.03, 7.21.4 and 8.2.1; manual mode, "replace" and "add-with-reset"
  not tried.
- **Set Controller Clock says so when the controller does not take a clock write**: a virtual controller answers 405.
- **DIPC: Read Message labels the controller's message kind**: a read returns the kind ("IPC_SEND"), not the data type the sender
  chose, which the controller does not return.
- **Create CFG Instance leaves out `rdonly` and `instanceid`**, the keys a read returns; a pasted copy of an instance sent them and
  RobotWare 6 answered 400. Create says which keys it left out; the Ctrl+S write-back uses the same filter.
- **Open Module Source** says on a refusal that opening a module writes the
  module to a file on the controller and deletes it afterwards, so it needs
  write access like any other write.
- **Show Remote-Control Status** shows a waiting request as "pending
  (modify)" or "pending (exec)" (it used to show "Unknown" for exec).
- **Vendors abb-rws-client 1.4.0 with the 2026-10-09 spec-check fixes.** The
  client was checked against ABB's RWS 2.0 OpenAPI files (Rev L) and the
  controller forms on RobotWare 7.21.4 and 8.2.1. What changes for RAPID
  Live: Virtual Time now reads a running VC as running (it used to read
  every VC as paused), "Set scale 1x / 10x" set real time and ten times
  real time (they used to set 1 % and 10 %), and the time shows in seconds
  (it is milliseconds on the wire); Create Backup polls the controller's
  backup state and reports a failed backup instead of "created" (it used to
  stop after the first poll); Activate / Deactivate Task post to the
  per-task resource ABB documents.
- **Unlock Operation Mode asks for the PIN** the lock was set with; the
  controller's unlock form requires it, and the client no longer posts an
  empty body.
- **Lock / Unlock Operation Mode leave the RWS 2.0 Known limits.** Both
  answered 204 on RobotWare 7.21.4, 8.1.1 and 8.2.1 virtual controllers
  (2026-10-10); the vendored client tags them live on RWS 2.0. They stay
  listed under RWS 1.0, where they have not run.
- **Call Service Routine sets the program pointer and leaves the start to
  you.** RWS 2.0 has no operation that calls a service routine (the resource
  is a GET listing; the client used to POST and get 405 while the command
  said "started"). The command lists the task's service routines and moves
  the pointer through the client's `setPPToServiceRoutine`, which sends
  nothing for a routine that is not listed; start RAPID yourself. The
  controller decides the mode: ABB documents a pointer move to a routine for
  a remote client in Auto on RobotWare 6 and 7 (in manual mode only with RMMP
  exec on RobotWare 7), and the refusal is shown with its sentence. One case
  is held back by the client: RobotWare 8 in Auto. The same path runs on RWS
  1.0 and RWS 2.0.
- **Vendors abb-rws-client 1.4.0**: manual-mode behaviour checked against ABB's documents, `requestRmmp` can ask for `exec`,
  the jog, a program-pointer move and a write while RAPID runs are sent and the controller decides, a refusal names ABB's
  local-client rule, the RMMP wait reads the privilege on every poll, Set Execution Cycle is read back into the state, and on
  RobotWare 8 Switch Operation Mode holds write access and allowing motion control registers the station first. Messages name
  the controller by its `/rw/system` name, not the PC name a virtual IRC5 reports.
- **Restore Backup keeps the backup.** The bundled client sends ABB's
  `delete-dir` as false on both generations; without it the controller
  deletes the backup it restored. The confirmation says that the backup stays
  on the controller. The restore has run on RobotWare 6; it has not been sent
  on RobotWare 7 or 8.
- **A RobotWare 8 start refused for the motion-control declaration is
  explained.** The controller's -1073435864 used to reach Start RAPID and Run
  Routine as a refusal the client gave no reason for. They now show the
  client's reason, that the declaration is missing, as the jog already did.
  For all three the error then adds RAPID Live's next step: RAPID Live does
  not make this declaration; start or jog from the FlexPendant. The dialog
  offers no button. The refusal was seen on an 8.2.1 virtual controller.
- **Show Program Pointer + Motion Pointer reads the motion pointer where ABB
  serves it.** The bundled client reads the `motionpointer` entry of the
  task's program pointer resource on both generations (it read resources that
  hold no position), so the MP line fills where the controller reports a
  position. RobotWare 6.16.03 and 7.21.4 virtual controllers send the start
  of that entry as `begposition`, which the client also reads; there it read
  row 9, column 16 while a MoveAbsJ ran. The client keeps the read in its
  never-run lists. It sends the same request as the program pointer read,
  whose answer carries this entry with no position when no program has
  started. The client's logs keep no answer body, so a logged 2xx answer does
  not show that a position was read. While the controller reports none (no
  program started), the MP line shows dashes.
- **Known limits updated**: the client ran Compress File / Directory and the UI instruction read and answer live on RobotWare 6, so they are no longer listed as never run on RWS 1.0.
- **The UI instruction answer is TPAnswer, then TPCompleted.** The prompt defaults to TPAnswer (a TPReadNum refuses Result) and the answer is followed by TPCompleted = TRUE; the confirmation says so.
- **The jog axis value is not degrees or millimetres.** ABB documents the six axis
  values of a jog without a unit; the sign is the direction and one click is one
  jog step (on RobotWare 8.2.1 a value of 1 with the smallest increment moved
  axis 5 about 0.01 degree). The setting, the commands, the Motion view and the
  first-jog confirmation no longer call it degrees or millimetres, and say that
  the jog speed and the jog mode are not sent (ABB's jog form has neither).
  "Set Jog Increment…" sets the axis value.
- **The Motion view offers the jog arrows in every mode and with the motors off.**
  The client sends a jog in any mode, including AUTO, and the controller decides;
  its own refusal is shown. The status line carries a hint (AUTO, motors off).
- **Request Manual Mode Privileges is sent in any mode.** The extension no
  longer stops a request in AUTO or, on RobotWare 7, outside MANR before
  sending. The controller answers (ABB: MANR only on RobotWare 7) and the
  refusal is shown.
- **No stop offer for other refusals.** The client explains a refusal as
  "program running" only for an execution-state refusal, or a 400/403 the
  controller leaves unexplained, of the step that changes the program. A
  mode refusal keeps its operating-mode explanation. A missing file or
  routine, a bad argument and a holder of
  access keep their own message and never raise "Stop the program first?".
- **The "stop the program first?" offer follows the controller's answer.** Load,
  unload and PP to routine are sent while RAPID runs; when the controller
  refuses, the offer appears with the controller's code and text, and it no
  longer says nothing was changed when a load had already unloaded the old
  module.
- **Virtual Time offers no pause or resume.** Show / Control Virtual Time
  still shows the time, speed and state and sets the speed (1x, 10x); the
  Pause/Resume button is gone. RobotStudio's Simulation tab controls the
  virtual clock.
- **Virtual Time on RobotWare 6 offers no speed actions.** RAPID Live does not
  set virtual time on RobotWare 6 in this release; change the simulation speed
  in RobotStudio. The state is shown with one line saying so, and a command
  invoked there sends nothing.
- **Request spacing is 100 ms** (was 55 ms): the vendored client keeps at
  least 100 ms between the starts of any two requests to a controller, on
  both generations. ABB's RWS introduction states 50 ms minimum per request
  (20 requests per second); 100 ms keeps twice that floor.
- **Remove Robot asks which robot** when it runs from the Command Palette
  or the Robots view's "…" menu; it used to take the active robot. The
  confirmation names the address and says that the saved password is
  deleted too.
- **A removed robot stays removed.** The legacy single-robot settings
  (`abbRobot.host`, `abbRobot.username`, `abbRobot.password`) are moved once
  into `abbRobot.robots`, with the password in VS Code secure storage, and
  then removed from the settings; Remove Robot removes them too. Before, an
  emptied robot list brought the legacy robot back on the next start, with
  its plaintext password still in the settings, and a fresh install listed a
  robot at the schema's default `192.168.125.1`. The robot list is saved to
  the settings it is read from, so removing a robot from a list set in the
  workspace settings takes effect.
- **Add Robot uses the client's `findControllers`.** One merged entry per
  controller (a VC found by the port scan and by mDNS appears once), with
  the system name and RobotWare version of local VCs where known. The scan
  is cancellable and shows progress; Cancel keeps what was found so far.
  The service port address is probed when this PC has an address in
  192.168.125.0/24 or when ticked (it used to be probed on every scan), and
  another machine gets ports 443 and 80 only (plus extra ports), HTTPS first
  and HTTP only where the port is open but not TLS.
- **mDNS picks are probed, never guessed.** A controller seen only through
  mDNS is probed when picked (also in "Discover Controllers (mDNS)"); if it
  does not answer, you choose the scheme. A controller whose login challenge
  is not ABB's is marked "Not confirmed as ABB" and needs a confirm.
- **Factory credentials are pre-filled only for a VC on this PC.** Add Robot
  and Configure Robot no longer fill in `Admin` / `robotics` for a
  controller on another machine.
- **`abbRobot.strictTls` applies to the Add Robot probes** as well as to
  connections.
- **Manual entry refuses IPv6** ("RobotWare does not support IPv6") and
  splits the port from the right. The connection guide lists the ports the
  scan really probes.
- **License: MIT to Apache-2.0.** The whole `abb-rws-*` family is now Apache-2.0,
  which adds an explicit patent grant (section 3) and a trademark clause - both
  of which matter for industrial adoption and for contributors. Releases up to
  and including 1.2.0 remain available under MIT; this and later releases are
  Apache-2.0. Added `NOTICE`, `CONTRIBUTING.md` (DCO sign-off) and
  `TRADEMARKS.md`. The `NOTICE` shipped in the .vsix also records the MIT
  license of `ws`, which esbuild compiles into `dist/extension.js`.
- **Search Signals prompt says what the controller does.** The name filter is
  a case-insensitive PREFIX match, not a substring match, on RW 6.16, 7.21 and
  8.1.1 (e.g. on RW 8.1.1 `IIO_do` finds `IIO_do8`, `do8` does not); the prompt
  and the `*` hint now say so. The empty-search warning no longer blames the
  controller: an empty signal search is accepted and returns every signal
  (RWS 2.0 pages it at 100; seen on RW 8.1.1, whose 141 signals took two
  pages), and the I/O tree is the place for the full list, so the command
  still asks for a name or a type. The device-search prompt drops its
  unverified "substring" claim and makes no claim about wildcards; that
  endpoint refuses an empty criteria set (400 on RW 6.16 and 7.21; the bundled
  client rejects it before sending, on every version), and its warning says so.
- **Bundled client: abb-rws-client 1.4.0.** Among its changes: writes take the
  mastership or RobotWare 8 write access ABB documents for them, one at a
  time per controller; stop and motors off are sent first and never wait
  for access; `startRapid` continues from the program pointer instead of
  moving it back to the last Set PP routine.
- **Error messages use the client's explanation.** A refused write now shows
  what is missing, who can supply it and the controller's answer, as the
  client explains it, instead of a guess from the HTTP status and the text.
  The buttons follow that explanation: "Request Remote Control" only when
  RMMP is what is missing (manual mode, RobotWare 6/7), "Show Holder" only
  when another client holds mastership on RobotWare 6/7.
- **Request Remote Control waits for the operator.** The command (and the
  button) now waits up to 30 s for the operator at the FlexPendant, says so
  while it waits, can be cancelled (which withdraws the request), and reports
  granted, denied or expired. On RobotWare 8, which has no RMMP, nothing is
  sent and the message points at Remote Access at the FlexPendant. The RMMP
  status reads ABB's `exec` privilege.
- **Set PP, Unload Module, Upload Module, Push and Run Routine ask before
  stopping a running program.** The client no longer stops the program on
  its own for these; when the program runs, the extension asks, and stops it
  only on "Stop Program and Continue".
- **Stop Jog is removed.** One click is one jog step, so no jog is left
  running for it to stop, and the zero jog it sent was an ordinary jog
  request, not a stop. Stop robot motion at the FlexPendant or with the
  emergency stop; the jog rows in the Motion view say so.
- **Switch Operation Mode is sent in a guard stop or an emergency stop.** The
  extension no longer refuses it before sending; the controller decides, and
  its refusal is shown with the client's sentence, on RobotWare 8 with where
  the Reset is. A RobotWare 8.2.1 virtual controller accepted the switch in a
  guard stop, in both directions (the switch to Auto then waited for the
  confirmation at the FlexPendant), so no refusal was seen there; an
  emergency stop was not tried.
- **Request Remote Control on RobotWare 6 says what is known about `exec`.**
  ABB's RWS 1.0 lists `exec` as a privilege level but does not say what it
  covers; the pick list and the grant message no longer say that ABB
  documents nothing for it, and the pick list says that `exec` has not been
  sent on RobotWare 6.
- **README.** Known limits: RAPID Live does not make RobotWare 8's
  motion-control declaration, so the controller refuses its jog, and also
  Start RAPID and Run Routine, even for a program that moves nothing (an 8.2.1
  virtual controller answered 403, -1073435864; the error says that the
  declaration is missing); jog and start RAPID from the FlexPendant. RobotWare
  7: Request Remote Control at the `exec` level was refused also with Enable
  held at the virtual FlexPendant, and a granted `modify` was still held after
  3 minutes. A switch to Auto waits for the confirmation at the FlexPendant on
  RobotWare 7 and 8. The renamed module was seen once, on 7.21.4. The MP line
  of Show Program Pointer + Motion Pointer is read from the `motionpointer`
  entry of the task's program pointer resource, on both generations; the
  client read a filled one on 6.16.03 and 7.21.4 virtual controllers and
  keeps it in its never-run lists: before a program starts, that resource
  carries the entry with no position, and the client's logs keep no answer
  body. The RobotWare 6 line names the RWS 1.0
  form the client lacks although ABB documents it (Modify Position), the RWS
  1.0 forms it has built but not run (signal simulation, unblocking signals,
  device state), the ones that ran on a 6.16.03 virtual controller (base
  frame, keyless motors-on, reading the task selection), and the commands
  RAPID Live does not offer. Restore Backup
  keeps the backup, on both generations, and has not been sent on RobotWare
  7 or 8. RAPID Live does not set virtual time on RobotWare 6 in this
  release. Request Remote Control on RobotWare 6 is listed for the `exec`
  level, not yet sent there; `modify` was granted at the FlexPendant on a
  6.16.03 virtual controller in manual reduced speed. A few
  built-in entries show only their kind, with no call shape, and some call
  shapes leave out arguments. The comparison names ABB's RAPID & Ecosystem
  Tools 0.1.0 and the date it was checked.

#### Fixed

- **Saved robots changed elsewhere are kept.** RAPID Live read
  `abbRobot.robots` once, at start, and each save (Add Robot, Configure
  Robot, Remove Robot, a port found again at connect) wrote back the whole
  list it held. A robot added or changed in another VS Code window, by hand
  in settings.json or through Settings Sync was lost at the next save. A
  save now reads the stored list again and changes only its own robot, in
  the settings the list is read from. A change of the setting is also
  applied while RAPID Live runs: a new robot is listed, a changed one takes
  the new values, and a robot removed elsewhere is disconnected and dropped.
  A connected robot whose saved address or user changed elsewhere stays on
  the controller it is connected to until it reconnects: a message says so
  and offers Reconnect, and the confirmations name the address the session
  is on. A save that VS Code refuses (settings.json with unsaved edits or an
  error) changes nothing in this window either: Add Robot takes the robot
  out again, Configure Robot keeps the old host, user and password, and
  Remove Robot keeps the robot and its saved password. A password saved in
  another window is used from the robot's next connect. A plaintext password
  found in the setting moves to VS Code secure storage, and only that field
  is removed from the list as it is then. Passwords stay in secure storage,
  never in the settings.
- **Commands act on the robot they name.** A failed connect's "Edit Robot…"
  edits that robot, a robot row connects with no active robot, and the
  Restart Now and clock Set… buttons keep the robot they were shown for.
- **More writes ask first, naming the robot**: speed ratio, operating mode,
  virtual time and simulation actions, teleport, Create RAPID Task, and a
  pointer move, service routine or unload while RAPID runs. The jog asks
  again when its axis value is raised. Nothing is blocked.
- **A signal search that returns after a robot switch** stays with the robot
  that ran it; Set PP from CodeLens uses the lens's own file; the stop offer
  names the robot; a duplicate saved robot name warns at save.
- **RWS 1.0 real-time updates.** On an IRC5 (RobotWare 6) every
  subscription failed inside the extension and the panels fell back to
  polling: the bundled client loaded its WebSocket library in a way that a
  bundled extension does not support. Client 1.4.0 loads it the way the
  RWS 2.0 side already did.
- **No trash button on the "Add Robot…" row.** The Robots view showed one
  there, and it offered to remove the active robot.
- **RobotWare 8 guard stop: no RMMP or grant advice.** A start or motors on
  refused because the controller waits for the Reset (`-1073445806`) offered
  the RMMP and mastership buttons and blamed missing grants. It now says that
  someone must press Reset at the FlexPendant (the thumb button in Auto) and
  offers no buttons. The guard-stop hints for the op-mode switch say the same
  on RobotWare 8 instead of pointing at the enabling device.
- **The RMMP and mastership dialog no longer opens for any 403 on a RAPID
  path.** It used to match the message text, so unrelated refusals (a
  safety state, a missing option, RobotWare 8 write access) offered RMMP.
- **Jog errors carry the controller context**, so a jog refused for missing
  RMMP offers "Request Remote Control".
- **Download Module to File saves the loaded module's text.** It used to
  read a file `$HOME/<module>.mod`, so a system module such as BASE answered
  404 and, on RobotWare 7 and 8, the message said to check the parent
  directory. It now reads the module the way View Module Text does and offers
  a picker of the loaded modules when none is given.
- **Controller clock labels.** Read Controller Clock no longer labels the value
  "(UTC)": ABB documents the value as UTC, but a virtual controller answers the
  PC's local time. The value is shown as the
  controller gave it, with that note. Set Controller Clock sends the typed
  values unchanged, prefilled with UTC, and its prompt and confirmation say so.
- **List File Volumes on RobotWare 6** shows the controller's volumes
  (`$HOME`, `$TEMP`, `$BACKUP`) where a virtual controller listed the PC's
  C: and D: drives.

## 1.2.0 - 2026-08-15 - The 1.3.0 surface, surfaced: search, rename, export

The "groundwork for upcoming extension features" from 1.1.0 becomes the
features. Ships the bundled client at 1.3.1 (RobotManager wrapper-surface
completion: RMMP poll/cancel, per-domain mastership with hold coordination,
RAPID debugger backbone, event-log domains, and more).

### Added

- **Server-side signal search in the I/O panel.** Search Signals asks the
  CONTROLLER (name filter + type filter), so it finds signals the polled
  snapshot doesn't carry, and pins the results as a group at the top of the
  I/O tree until you clear it (inline button on the group).
- **I/O device search.** Filter devices by name and logical state; picking a
  result chains straight into a signal search scoped to that device.
- **View Module Text with change count.** A sibling of Open Module Source that
  uses the module-text endpoint and shows the controller's change count in the
  status bar - the handle a later concurrent-edit-safe push will build on.
- **Rename files and folders on the controller** from the File Explorer
  context menu (same-directory rename, both generations).
- **Export Event Log** from the Diagnostics panel: any domain, JSON or CSV,
  straight to a local file.

### Changed

- Bundled `abb-rws-client` 1.3.1: RobotManager now wraps the full adapter
  surface (no more capability gaps behind casts), coordinates caller-held
  mastership with its self-managing writes and jog, and refuses to trigger a
  wrong vision job on RWS 1.0 instead of doing it silently.

### Fixed

- **MultiMove controllers: every task's modules are shown** (#4). The Program
  panel listed modules for a single task and painted that same list under
  every active task, so on MultiMove systems (virtual or real) one robot's
  modules were missing and the other's were duplicated. Each active task now
  gets its own module list, the module actions (Open, Text, Set PP, Unload)
  act on the task the row belongs to, the module quick-picks show the owning
  task when more than one has modules, and the `main`-collision warning only
  fires for two `main`s inside ONE task - every MultiMove motion task having
  its own `main` is normal.

## 1.1.0 - 2026-08-12 - Client 1.3.0: discovery that finds every controller, full RWS surface

No extension code changes - this release ships the substantially upgraded
`abb-rws-client` 1.3.0 underneath. Everything below is live-verified on
RobotStudio virtual controllers (RW 6.16, 7.21, 8.1.1).

### Changed

- **Controller discovery finds every local VC, fast.** Discovery now asks the
  OS which ports are actually listening and probes those, instead of guessing
  from a fixed port list with a capped blind scan. Concretely: a RobotStudio
  VC on a randomly-assigned high port (they drift on every restart - 40483 and
  62214 observed) is now found; previously a VC on a standard port would hide
  any second VC on a non-standard one. A full local discovery takes ~1.5 s and
  works on non-English Windows (the netstat parse no longer depends on the
  localized "LISTENING" word).
- **Complete RWS endpoint surface in the bundled client.** Signal search,
  I/O device search, module-text read, file rename, event-log export, RMMP
  poll/cancel and more now work on BOTH generations (many were RWS 2.0-only or
  missing) - groundwork for upcoming extension features. Client conformance:
  59 implemented / 0 unmapped / 0 orphan against live controllers.
- **Reliability hardening under the hood:** secret redaction in trace logs,
  `ws` CVE bump, typed errors on every search path, silent-socket RWS 2.0
  subscription liveness (no more 25 s self-disconnect loop).

### Coming next

- **Robot panel** - a dedicated interactive panel view (jog, I/O, signal search, production monitoring) is in active development.


## 1.0.0 - 2026-07-11 - Network discovery, secure credentials, simulation panel

The first stable release. Everything below was live-verified on RobotStudio
virtual controllers of both generations (IRC5 RW 6.16, OmniCore RW 7.21).

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
- README gained a section on what the extension does not do.

## 0.8.0 - RAPID Live release

The extension now identifies as **RAPID Live**. Same package id (`merajsafari.abb-rws`),
new positioning: a VS Code extension that connects to a live ABB controller.

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
