# Sample RAPID modules

These are ready-to-upload .mod files for testing the extension's "Upload Module" + RAPID-execution flows. They're the minimum-viable demos for verifying that round-trip works:

| File | Purpose | Robot motion? |
|---|---|---|
| `TestExtension.mod` | Variables (VAR / PERS / CONST), TP messages, error handling, basic flow control. No motion. Smallest module - good first test. | No |
| `MotionTest.mod` | MoveJ + MoveL through a square, zig-zag wave, pick-and-place, joint-axis sweep. **You'll see the robot move in RobotStudio's 3D view.** | **Yes** |
| `IOTest.mod` | Pulses digital outputs in patterns (single pulse + chase). The I/O panel updates live as signals toggle. | No |

## Recommended test sequence

1. **Connect** to a VC (OmniCore preferred - it has `Module1` removable; IRC5 too)
2. **Upload Module** → `MotionTest.mod` (replaces same-named module if it exists)
3. **Status panel → Motors On** (motors must be running for motion)
4. **PP to Main** → sets program pointer to `main` of the loaded module
5. **Start RAPID** → robot moves through the square, zig-zag, etc.
6. **Watch the Motion panel** - joint values + cartesian update live (~1s)
7. **Watch the 3D view in RobotStudio** - robot follows the trajectory

## "Set PP to routine" - running specific procs

You can also run individual procedures (not just `main`):

- Right-click a module in the Modules panel → **Set PP to Routine** → pick `testWave`, `testPickPlace`, `testJoints`, `runChase`, etc.
- Then **Start RAPID** runs that procedure once.

## Adjusting for your robot

`MotionTest.mod`'s targets are tuned for **IRB120 / IRB1200** (small reach, ~580mm). If your robot is different:

- Open `MotionTest.mod` in any editor
- Adjust the `CONST robtarget` values near the top
- Re-upload via the extension

All modules use **`tool0` + `wobj0`** (default tool, default work object). No tooling configuration needed.

## Coexistence with default modules

OmniCore VCs ship with `Module1` (which has its own `PROC main()`). Loading any of these test modules **replaces or coexists** depending on the name:

- `MotionTest`, `IOTest`, `TestExtension` are different names → coexist with Module1
- BUT all three define their own `PROC main()`, which conflicts with Module1's `main` → semantic error on PP-to-Main

**Solution:** in the Modules panel, right-click `Module1` → **Unload Module** before running these tests (or they become standalone programs).

The extension's `Upload Module` flow uses `replace=true`, so re-uploading the same file replaces the previous version cleanly.
