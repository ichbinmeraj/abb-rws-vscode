# Open a Loaded Module

In the **Modules** panel, every loaded program module shows an
**Open in Editor** icon on hover.

```
── Tasks ──
 T_ROB1     motion · running
   📄 MotionTest    [open] [pp] [unload]
   📄 user
```

Click the open icon → the live RAPID source streams in from the controller
into a new editor tab.

The editor gets:

- Syntax highlighting for `.mod` / `.sys` / `.prg` files
- **Hover docs** for every documented RAPID instruction (705 entries from
  the official ABB Technical Reference Manual)
- **Live variable hover** - hover any variable name to see its current
  controller value
- **Inlay hints** - faded gray live values next to every `VAR` / `PERS` / `CONST`
- **Program-pointer arrow** in the gutter at the line currently executing
- **Go to Definition** - Ctrl+click a routine name to jump to its declaration
