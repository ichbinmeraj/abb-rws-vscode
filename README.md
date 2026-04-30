# ABB Robot (RWS) — VS Code Extension

Monitor and control ABB IRC5 robots directly from VS Code via the **Robot Web Services (RWS 1.0)** HTTP API — no FlexPendant required for most operations.

> **Compatibility:** ABB IRC5 controllers with RobotWare 6.x only.  
> Not compatible with OmniCore / RobotWare 7.x / RWS 2.0.

---

## Features

### Controller Status
- Live motor state, operation mode, RAPID execution state
- Speed ratio — click to change (AUTO mode only)
- Collision detection state (requires Collision Detection option)
- All RAPID tasks with active/stopped state
- RobotWare version and controller name
- Read controller clock (UTC)
- Restart controller — Restart / P-Start / I-Start / B-Start modes

### Motion
- Joint positions J1–J6 updated every second (degrees)
- TCP position — Cartesian X/Y/Z (mm) and quaternion orientation
- Robot configuration flags (shoulder / elbow / wrist)

### RAPID Control
- Start / Stop RAPID
- PP to Main (reset program pointer)
- Set execution cycle — Once / Forever / As Is
- Motors On / Off (requires AUTO mode)
- Set speed ratio 0–100%

### Program Management
- List loaded modules per task
- **Load program from file** — full sequence: unload old modules → upload `.mod` → load → PP to Main
- Download module from controller to disk

### RAPID Variables & Symbols
- Read any RAPID variable (task / module / symbol)
- Write any RAPID variable with RAPID-syntax values
- Read symbol properties — type, dimensions, storage class
- Search symbols — filter by type (var / per / con / fun / prc) — results open in editor
- Get active UI instruction (detect when RAPID is waiting for operator input)

### I/O Signals
- All signals loaded automatically on connect, refreshed every 5 seconds
- Grouped by type: Digital Inputs, Digital Outputs, Analog Inputs, Analog Outputs, Group Inputs, Group Outputs
- **Click any Digital Output** to toggle it (0 ↔ 1) instantly
- Inline write button on all output signals (DO / AO / GO)
- Manual refresh button

### Event Log
- Live event log from the controller (domain 0 — up to 1000 entries)
- Severity icons: info / warning / error
- Expandable entries with description, causes, consequences, and actions
- Clear event log (with confirmation)

### Controller File Browser
- Browse `$HOME` directory on the controller
- Download any file to disk
- Delete files (with confirmation)
- Create directories

---

## Quick Start

1. Open the **ABB Robot** panel in the Activity Bar (robot arm icon on the left)
2. Click the **gear icon** → Configure Connection → enter IP, username, password
3. Click **Connect**

The status bar at the bottom shows live motor state and RAPID execution state. All panels update automatically.

---

## Connection Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `abbRobot.host` | `192.168.125.1` | Controller IP address or hostname |
| `abbRobot.username` | `Default User` | RWS username |
| `abbRobot.password` | `robotics` | RWS password |
| `abbRobot.refreshInterval` | `1000` | Status polling interval (ms) |

---

## Commands

All commands are available via `Ctrl+Shift+P` → type **ABB Robot**:

| Command | Description |
|---------|-------------|
| ABB Robot: Connect | Connect to the configured controller |
| ABB Robot: Disconnect | Disconnect |
| ABB Robot: Configure Connection… | Set host, username, password |
| ABB Robot: Refresh | Force immediate status refresh |
| ABB Robot: Start RAPID | Start program execution |
| ABB Robot: Stop RAPID | Stop program execution |
| ABB Robot: PP to Main | Reset program pointer to main |
| ABB Robot: Set Execution Cycle… | Once / Forever / As Is |
| ABB Robot: Motors On | Enable motors (AUTO mode only) |
| ABB Robot: Motors Off | Disable motors |
| ABB Robot: Set Speed Ratio… | Set override speed 0–100% |
| ABB Robot: Load Program from File… | Upload and load a `.mod` file |
| ABB Robot: Download Module to File | Save a controller module to disk |
| ABB Robot: Read RAPID Variable… | Read any RAPID variable |
| ABB Robot: Write RAPID Variable… | Write any RAPID variable |
| ABB Robot: Read RAPID Symbol Properties… | Introspect a symbol |
| ABB Robot: Search RAPID Symbols… | Search by type in a task |
| ABB Robot: Get Active UI Instruction | Check if RAPID is waiting for input |
| ABB Robot: Refresh I/O Signals | Reload all signal values |
| ABB Robot: Write Signal Value… | Write a DO / AO / GO signal |
| ABB Robot: Refresh Event Log | Reload event log |
| ABB Robot: Clear Event Log | Clear all domain 0 messages |
| ABB Robot: Refresh File Browser | Reload $HOME directory |
| ABB Robot: Download File from Controller | Download a file to disk |
| ABB Robot: Delete File from Controller | Delete a file |
| ABB Robot: Create Directory on Controller | Create a new directory |
| ABB Robot: Read Controller Clock | Show current UTC time |
| ABB Robot: Restart Controller… | Restart with mode selection |

---

## Loading a RAPID Program

1. Connect to the controller (must be in AUTO mode, RAPID stopped)
2. In the **Program** panel → click the **upload icon** (Load Program from File…)
3. Select a `.mod` file
4. The extension automatically:
   - Unloads all non-system modules from the task
   - Uploads the file to `$HOME/` on the controller
   - Loads it into the first active task (T_ROB1)
   - Moves the program pointer to Main

> The module must have a `PROC main()` for PP to Main to succeed. If not, the module is still loaded and a warning is shown.

---

## I/O Signals Panel

The **I/O Signals** panel shows all configured signals grouped by type:

- **Digital Inputs (DI)** — read-only, shown with filled/empty circle icon
- **Digital Outputs (DO)** — click to toggle 0↔1, inline write button
- **Analog Inputs (AI)** — read-only, shows current value
- **Analog Outputs (AO)** — inline write button with numeric input
- **Group Inputs (GI)** — read-only
- **Group Outputs (GO)** — inline write button

Signals refresh automatically every 5 seconds. Use the **Refresh** button in the panel title bar for immediate update.

---

## Requirements

- ABB IRC5 controller with RobotWare 6.x
- RWS 1.0 enabled on the controller (PC Interface option)
- Network connectivity to the controller
- RWS user with appropriate privileges (Default User is sufficient for most operations)

---

## Session Management

The IRC5 controller allows a maximum of **70 concurrent RWS sessions**. The extension automatically persists the session cookie across reloads so it always reuses the same session slot — avoiding the 503 errors that occur when the limit is exhausted.

The session cookie is stored at `~/.abb-rws-session`.

---

## License

MIT © Meraj Safari
