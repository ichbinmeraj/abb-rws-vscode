# RAPID Live — extension test plan

Walk through these scenarios end-to-end to verify every extension feature
against a real controller (or the OmniCore VC).

---

## Setup (do once)

1. **Open the extension** (Extension Development Host with the dev build, or
   install from the marketplace).
2. **Add and connect** to the OmniCore VC (port 5466 today, or whatever
   RobotStudio assigned). Wide scan should find it automatically.
3. **Upload the test modules** (Files panel → upload, OR Modules panel → load):
   - `samples/TestExtension.mod` — non-motion, safe to run anywhere
   - `samples/TestMotion.mod` — motion, only run after motors-on setup

---

## Scenario 1 — Status panel (real-time monitoring)

**What it tests**: WebSocket subscriptions / polling fallback, all status fields.

1. Open Status panel — verify these rows show real values:
   - Host: `IRB1200_5_90` (the system name, not the IP)
   - RobotWare: `7.21.0` something
   - Controller: `Motors OFF` (or whatever real state)
   - Operation Mode: `MANR` / `AUTO` etc.
   - Speed Ratio: `100%` (clickable to change)
   - RAPID: `Stopped` / `Running`

2. From RobotStudio FlexPendant, change motors-on/off — Status panel should
   update **<500 ms on RWS 1.0** (instant via WebSocket) or **~1 s on RWS 2.0
   VC** (polling fallback — VC limitation).

3. Click `System Info…` row — opens a doc with license, products, energy stats.

**Pass criteria**: ✅ all rows populate and update live.

---

## Scenario 2 — RAPID variable read/write

**What it tests**: `getRapidVariable`, `setRapidVariable`, symbol search.

1. Run `TestExtension/main` (PP-to-Routine → main → Start) once. This sets
   `counter = 1` and `lastTestResult = "main() ran at ..."`.

2. From the extension: `Ctrl+Shift+P` → **ABB Robot: Read RAPID Variable**
   - Task: `T_ROB1`
   - Module: `TestExtension`
   - Symbol: `counter`
   - Should show `counter = 1`

3. **Write a value back**: `ABB Robot: Write RAPID Variable`
   - Same task/module
   - Symbol: `counter`
   - Value: `42`
   - Read it again — should show `42`.

4. **Try a typed variable**:
   - Read `pi` — should show `3.14159265`
   - Read `bigNumber` (dnum) — should show `9007199254740992`
   - Read `isReady` (bool) — should show `TRUE`
   - Read `greeting` (string) — should show `"Hello from RAPID Live"`
   - Read `pHome` (robtarget) — should show the full robtarget literal

5. **Persistent across power cycles**: Write `persistentCounter = 100`, then
   stop and restart RAPID. Value should still be `100`.

6. **Symbol search**: `ABB Robot: Search Symbols` — task `T_ROB1`, type
   "All". Should return all variables, procedures, etc. defined in
   `TestExtension`.

**Pass criteria**: ✅ all reads/writes work, search returns the full list.

---

## Scenario 3 — RAPID execution control

**What it tests**: `startRapid`, `stopRapid`, `resetRapid`, `setExecutionCycle`.

1. Run `TestExtension/testCounterLoop` — the loop runs for ~10 seconds,
   incrementing `counter` 100 times.

2. While it's running:
   - Status panel shows RAPID: `Running` (with green icon)
   - Read `counter` — value increases each time you read

3. Click **Stop RAPID** in the toolbar — execution stops mid-loop.

4. **Set Execution Cycle**: change to "Once" then "Forever". Run again — for
   "Once" mode, the loop stops on its own; for "Forever", it restarts from
   `main` after exiting.

5. **PP to Main**: refresh the program pointer to `main()`.

**Pass criteria**: ✅ Start/Stop/PP-to-Main all work, cycle changes persist.

---

## Scenario 4 — Inverse Kinematics

**What it tests**: `calcJointsFromCartesian` adapter implementation.

1. `Ctrl+Shift+P` → **ABB Robot: Calculate Inverse Kinematics**
2. Press Enter through all 7 prompts (X/Y/Z/Q1-Q4 are pre-filled with the
   robot's *current* TCP position).
3. **On real hardware**: result shows J1–J6 in degrees.
4. **On the OmniCore VC**: error notification "Position outside of reach"
   (`SYS_CTRL_E_POSE_OUTSIDE_REACH`) — this is expected because virtual
   controllers don't have the licensed kinematic-solver module.

**Pass criteria**: ✅ command runs without crashing; on real hardware
returns a sensible J1–J6.

---

## Scenario 5 — I/O signals (live updates)

**What it tests**: `listAllSignals`, `writeSignal`, `readSignal`,
real-time signal subscriptions (if enabled).

1. Open the I/O panel — should list all signals on `IntegratedIONetwork`
   (default IRB 1200 has ~80 signals: IIO_di1-N, IIO_do1-N, IIO_gi*, etc.).
2. Click the pencil icon next to `IIO_do1` → choose `1` → value flips to 1.
3. Run `TestExtension/testSignals` — watches outputs DO1, DO2, DO3 pulse
   in sequence over ~7 seconds. The I/O panel should reflect each pulse.

**Pass criteria**: ✅ signals list, write works, live updates visible.

---

## Scenario 6 — Active UI Instruction

**What it tests**: `getActiveUiInstruction`, `setUiInstructionParam`.

1. Run `TestExtension/testTPReadNum`. The robot is now waiting for input.
2. `Ctrl+Shift+P` → **ABB Robot: Get Active UI Instruction**.
3. Should show: `Instruction: TPReadNum, Stack: ..., Message: "Enter any number:"`.
4. Click **Respond…** → Parameter `Result` → Value `42` → Send.
5. RAPID continues; check `counter` is now `42`.

**Pass criteria**: ✅ UI instruction detected, response delivered to RAPID.

---

## Scenario 7 — Event Log

**What it tests**: `getEventLog`, expandable details, `lang=en` enrichment.

1. Run `TestExtension/testError` — deliberately divides by zero.
2. Open Event Log panel — newest entry should be **41131 — Division by zero**
   (or similar code).
3. Click the entry to expand — should show:
   - Description
   - Causes
   - Consequences
   - Actions

**Pass criteria**: ✅ event appears, all 4 detail rows populated.

---

## Scenario 8 — Modules / Files

**What it tests**: `listModules`, `loadModule`, `unloadModule`,
`listDirectory`, `readFile`, `uploadFile`, `deleteFile`.

1. Modules panel — should list all loaded modules including `TestExtension`.
2. Right-click `TestExtension` → Download Module → save the `.mod` file
   locally → open in VS Code (gets RAPID syntax highlighting + snippets).
3. Files panel — browse `$HOME` and any of the other 7 volumes (BACKUP,
   DATA, ADDINDATA, PRODUCTS, RAMDISK, TEMP).
4. Upload a small file → verify it appears in the listing → delete it.

**Pass criteria**: ✅ all CRUD operations on files and modules.

---

## Scenario 9 — Configuration database (CFG) — the unique feature

**What it tests**: 4-level CFG tree (`listCfgDomains`, `listCfgTypes`
paginated, `listCfgInstances`, `getCfgInstance`).

1. Open **Configuration (CFG)** panel.
2. Expand each domain — verify counts:
   - EIO: 24 types
   - MMC: 53 types
   - **MOC: 163 types** (paginated across 3 controller pages)
   - PROC: 0 types (empty by design)
   - SIO: 10 types
   - SYS: 28 types
3. Drill **MOC → ROBOT → ROB_1** — JSON document opens with **88 attributes**
   including `name`, `use_robot_type` = `ROB1_1200_0.9_5_TypeB`, all the
   joint references, calibration source, etc.
4. Drill **EIO → EIO_SIGNAL** — should list **80 signals** (paginated).
5. Drill **MOC → ARM** — should list 6 arms (rob1_1 .. rob1_6).

**Pass criteria**: ✅ all 6 domains expand, MOC pagination shows >100 types,
instance JSON loads with full attributes.

---

## Scenario 10 — Motion (real movement only — needs FlexPendant setup)

**What it tests**: live joint/cartesian streaming, motion pointer updates.

**Prerequisites**: FlexPendant in MANR with deadman held, motors on.

1. Load `TestMotion.mod` into the controller.
2. PP-to-Routine `goHome` → Start. Robot moves to `jHome`.
3. Watch the Motion panel — joint angles update in real time.
4. PP-to-Routine `main` → Start. Robot cycles through 3 points twice.
5. Watch the **TCP Position** rows update.
6. `Ctrl+Shift+P` → **ABB Robot: Show Program Pointer + Motion Pointer**
   while running — PP and MP should differ (MP is ahead of PP).

**Pass criteria**: ✅ motion executes, panel updates live.

---

## Scenario 11 — Mechunit details

**What it tests**: `getMechunitInfo`, `getMechunitBaseFrame`, `getMechunitAxes`.

1. Motion panel → click **Mechunit Details** (under Frames & Tools).
2. Should open a markdown doc with:
   - Type: TCPRobot
   - Mode: Activated
   - Status: Synchronized
   - Base frame: x=0, y=0, z=0, q=[1,0,0,0]
   - 6 axes detail rows

**Pass criteria**: ✅ doc opens with all sections populated.

---

## Scenario 12 — Tool / WObj / Payload

**What it tests**: `getActiveTool`, `getActiveWobj`, `getActivePayload`.

1. Motion panel → click **Active Tool / WObj / Payload**.
2. Notification shows: tool0, wobj0, load0 (defaults).
3. After loading `TestExtension.mod` (which declares `tGripper` / `wTable`),
   activate them via RAPID `Hand SetTool` / `SetWobj` (not via extension yet)
   and re-run — should reflect the change.

**Pass criteria**: ✅ shows the currently-active values.

---

## Scenario 13 — Virtual Time (VC only)

**What it tests**: `getVirtualTime`, `setVirtualTimeRunning`, `setVirtualTimeScale`.

1. `Ctrl+Shift+P` → **ABB Robot: Show / Control Virtual Time**.
2. Notification shows current vt (microseconds since boot).
3. Click **Set scale 10x** — VC simulation now runs 10× real-time.
4. Click again to **Pause/Resume**.
5. Click **Set scale 1x** to go back to real-time.

**Pass criteria**: ✅ scale changes persist.

---

## Scenario 14 — Multi-robot

**What it tests**: switching between connected controllers.

1. Add a second robot (the IRC5 VC if running).
2. Click between the two in the Robots panel.
3. All other panels (Status, Motion, RAPID, etc.) should reflect the
   active robot's state.

**Pass criteria**: ✅ active highlight moves, panels reflect each robot's data.

---

## Scenario 15 — RAPID syntax + snippets

**What it tests**: TextMate grammar, language config, snippets file.

1. Open the downloaded `TestExtension.mod` in a VS Code editor tab.
2. Verify keyword highlighting:
   - `MODULE`, `PROC`, `FUNC`, `ENDMODULE` — control-flow color
   - `num`, `dnum`, `bool`, `string`, `robtarget` — type color
   - `MoveJ`, `MoveL`, `SetDO`, `WaitTime`, `TPWrite` — function color
   - `TRUE`, `FALSE`, `tool0`, `wobj0`, `v100`, `z10`, `fine` — constant color
   - `!` line comments — comment color
3. Type a snippet: `proc<Tab>` should expand to a `PROC … ENDPROC`
   skeleton. Try also: `module`, `if`, `while`, `for`, `movej`, `robtarget`.

**Pass criteria**: ✅ all syntax categories colored correctly, snippets expand.

---

## Quick-fire verification (10-minute smoke test)

If you only have 10 minutes, run these in order:

1. Connect ✓
2. Status panel populates ✓
3. Read `counter` from `TestExtension` ✓
4. Browse CFG → MOC → ROBOT → ROB_1 → JSON opens ✓
5. Trigger `testError` → event appears in Event Log ✓
6. Toggle a DO signal in I/O panel ✓
7. Open `TestExtension.mod` from samples → see syntax colors ✓

If all 7 work, the extension is healthy.

---

## What's NOT in this test plan

- **Jog motion** — ABB safety design blocks it from RWS by default. See
  `docs/RWS_COVERAGE.md` for details.
- **Mode switch AUTO ↔ MAN** — requires FlexPendant confirmation.
- **Backup creation** — write op, leaves artifacts; test only when needed.

---

## When something breaks

1. Check the **ABB Robot output channel** (`View → Output → ABB Robot`).
   Every connect / poll / disconnect is logged with timestamp + reason.
2. Run `node test-everything.js` from the project root — verifies all 63
   live data paths against the connected controller.
3. Compare the failing endpoint against `docs/RWS_COVERAGE.md` — known
   blockers and their reasons are documented there.
