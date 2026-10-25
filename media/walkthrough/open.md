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
- **Hover signatures** for built-in RAPID instructions and functions - call
  shape, parameter types, optional and switch arguments, return type
- **Live variable hover** - hover any variable name to see its current
  controller value
- **Inlay hints** - faded gray live values next to every `VAR` / `PERS` / `CONST`
- **Program-pointer arrow** in the gutter at the line currently executing
- **Go to Definition** - Ctrl+click a routine name to jump to its declaration
