# ABB Robot (RWS) — VS Code Extension

Monitor and control ABB IRC5 robots directly from VS Code via the **Robot Web Services (RWS)** HTTP API.

---

## Features

- **Live controller status** — motor state, operation mode, RAPID execution state
- **Joint positions** — all 6 axes updated every second
- **TCP position** — Cartesian X/Y/Z and quaternion orientation
- **RAPID control** — Start, Stop, and PP to Main from the sidebar
- **Program management** — load `.mod` files from disk, download modules from the controller
- **Session persistence** — reconnects instantly by reusing the saved RWS session cookie

---

## Quick Start

1. Open the **ABB Robot** panel in the Activity Bar (robot arm icon)
2. Click the **gear icon** (Configure Connection) and enter your controller IP, username, and password
3. Click **Connect** — the status bar shows live motor and RAPID state

---

## Connection Settings

| Setting | Default | Description |
|---|---|---|
| `abbRobot.host` | `192.168.125.1` | Controller IP address or hostname |
| `abbRobot.username` | `Default User` | RWS username |
| `abbRobot.password` | `robotics` | RWS password |
| `abbRobot.refreshInterval` | `1000` | Polling interval in milliseconds |

---

## Loading a RAPID Program

1. Connect to the controller
2. In the **Program** panel, click the **upload icon** (Load Program from File…)
3. Select a `.mod` file — the extension unloads the current program, uploads, and sets PP to Main automatically

---

## Requirements

- ABB IRC5 controller with RWS 1.0 enabled
- Controller reachable over the network (Ethernet)
- RWS user with sufficient privileges (Default User works for most operations)

---

## Known Limitations

- PP to Main requires a `PROC main()` in the loaded module — otherwise a warning is shown but the load still succeeds
- Motor-on must be done from the FlexPendant; RWS does not support remote motor enable on IRC5
- Maximum 70 concurrent RWS sessions per controller — the extension reuses sessions to avoid exhausting this limit

---

## License

MIT © Meraj Safari
