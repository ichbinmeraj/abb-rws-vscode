# Screenshots needed before publish

The marketplace README references three images. Capture them, save with these
exact filenames, then re-package the .vsix.

## 1. `hero.png`  —  Overview / hero shot

**Recommended: 1280 × 800 px** (marketplace clamps wider images).

The "showcase" image at the top of the listing. Should communicate at a
glance: VS Code window, ABB activity bar visible, a `.mod` file open in the
editor, the side panel showing live cell state.

**Setup**:
1. Connect to your VC (OmniCore preferred — looks more modern).
2. Open `samples/MotionTest.mod` in the editor.
3. Have the **Live Cell** panel expanded showing joints + TCP + state.
4. Have the **Program** panel showing modules with one expanded to its routines.
5. Window size: ~1280 × 800.

**Tools**:
- Windows: `Win + Shift + S` → save selection as PNG.
- Or use Snipping Tool / ShareX.

---

## 2. `program-panel.png`  —  Program panel close-up

**Recommended: 600 × 700 px** (sidebar shape).

Just the Program panel — Modules tab active, status banner visible, tasks &
modules list with one task expanded showing modules, one module expanded
showing routines, the **+ New Task** button visible.

**Setup**:
1. Connect.
2. Open Program panel → Modules tab.
3. Expand T_ROB1 → MotionTest → so you see PROC main, testWave, etc.
4. Crop tightly to the panel.

---

## 3. `editor-live.png`  —  Editor with live features

**Recommended: 1280 × 600 px**.

A `.mod` file open with multiple live features visible:
- **Inlay hints** (faded gray `→ value` next to VAR / PERS / CONST declarations)
- **CodeLens** (`▶ Run this routine` above a PROC)
- **Program-pointer arrow** in the gutter at a line (best if running a program briefly so PP is visible)

**Setup**:
1. Connect.
2. Open `samples/MotionTest.mod`.
3. Make sure controller is connected (so inlay hints + CodeLens render).
4. Optional: start the program briefly to capture the PP gutter arrow on a line.
5. Crop to show the editor + line numbers + a few VAR declarations with their
   inline values.

---

## After capturing all three

1. Save as `hero.png`, `program-panel.png`, `editor-live.png` in this folder.
2. Verify with: `ls D:/abb-rws-vscode/media/screenshots/` — you should see 3 PNGs + this README.
3. Re-package: `cd D:/abb-rws-vscode && rm -f abb-rws-0.9.2.vsix && npx vsce package --no-dependencies`
4. Smoke-test: `code --install-extension D:/abb-rws-vscode/abb-rws-0.9.2.vsix --force` then check Extensions → @installed → "RAPID Live" → click it to see the README rendered with images.

---

## Optional but high-impact: a demo GIF

A short loop (5-10 seconds) of the **Push file → see it run on the robot**
flow boosts marketplace conversion significantly. Tools:
- Windows: ShareX → Screen Recording → animated GIF, or ScreenToGif.
- Save as `demo.gif` here and add `![](media/screenshots/demo.gif)` near the top of the README.

If you decide to include a GIF, target < 5 MB for fast load.
