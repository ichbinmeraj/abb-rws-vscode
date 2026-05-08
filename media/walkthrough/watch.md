# Watch Live Variables

Hover any RAPID variable while connected to see its current value:

```
   3│ VAR num counter := 0;          → 47
            ↑
   hover → current value from controller
```

Faded gray inlay hints appear automatically next to every `VAR` / `PERS` /
`CONST` declaration.

To **pin** a variable so it's always visible:

- Right-click the identifier → **Add Selection to Variable Watch**
- Or open the **Variables (Watch)** panel → click `+`

```
── Variables (Watch) ──────────
  MotionTest.counter      → 47
  MotionTest.cycleCount   → 12
  user.persistentRuns     → 5
  BASE.tool0              → [TRUE,…]
```

Values poll every 1 second. Right-click any watched value → **Edit** to
write a new value through the controller.
