# Running RAPID Live next to ABB's RAPID & Ecosystem Tools

Measured 2026-10-10 on Windows 11 with VS Code 1.140.0, RAPID Live 1.3.0
(`merajsafari.abb-rws`, built from this repository; 1.3.0 was prepared but not
published, and its changes ship in 1.4.0) and ABB Robotics - RAPID &
Ecosystem Tools 0.1.0 (`abb-robotics-ecosystem.abb-robotics`, from the marketplace).

## How it was measured

Both extensions were installed into an empty VS Code (fresh `--user-data-dir` and
`--extensions-dir`, nothing else installed), once with ABB's installed first and once
with RAPID Live installed first. A small probe extension, run through
`--extensionTestsPath`, opened a folder holding `main.mod`, `user.sys`, `prog.prg` and a
`messy.mod` with lower-case keywords, and for each file read the document's language id,
the TextMate scopes (`_workbench.captureSyntaxTokens`), the formatter's edits, hovers,
completions, document symbols, definitions and semantic tokens through VS Code's
`vscode.execute*` commands, then the registered command ids and each extension's
activation state. The extension host and window logs were searched for warnings.

## What we measured

| Question | Result (same in both install orders) |
|---|---|
| Language of `.mod`, `.sys`, `.prg` | `rapid` for all three. Both extensions contribute the same language id `rapid`; VS Code merges them. ABB adds `.modx`/`.sysx` and a `MODULE` first-line match, RAPID Live adds `.prg`. |
| Which TextMate grammar colours the file | RAPID Live's. Both register the scope `source.rapid`; the tokens carry RAPID Live's names (comments are `comment.line.exclamation.rapid`, ABB's grammar would give `comment.line.bang.rapid`). No log line reports the clash. |
| Semantic highlighting | ABB turns it on for `[rapid]` (`configurationDefaults`) and provides tokens only for I/O signal names it finds in an `EIO.cfg`; none in these files, so the colours were RAPID Live's grammar alone. |
| Formatter | Only ABB contributes one (Format Document / Format Selection). On `messy.mod` it returned 5 edits (`module` to `MODULE`, `var` to `VAR`, `proc` to `PROC`, …). RAPID Live has no formatter, so ABB's runs by default with no setting. |
| Our commands | All present: 138 `abbRobot.*` commands registered (112 of them contributed in `package.json`), next to ABB's 4 `abb-robotics.*` commands. |
| Activation | Both activate on `onLanguage:rapid` when the first RAPID file opens; both active. |
| Hover on `MoveL` | Two hover sections, one from each extension. |
| Completion | Both lists merged: 1,521 items, 614 of them a label the other extension also offers. |
| Outline (document symbols) | The module and its routines listed twice, once per extension. |
| Go to Definition on a variable | 3 locations offered (both extensions answer). |
| Conflict warnings | None in the extension host or window logs about grammars or languages. The warnings seen were ABB's own (its format settings are window-scoped but read per file). |

## Not measured

- The Extensions view and Developer: Show Running Extensions were not looked at on
  screen; activation was read through the API and the extension host log.
- Which extension's language configuration (brackets, indentation rules, word pattern)
  applies; both set `!` as the line comment.
- ABB's injected grammars (EGM, SoftMove, ArcWare, Force Control, Paint) on top of
  RAPID Live's `source.rapid`.
- macOS and Linux, other VS Code versions, and VS Code profiles (the CLI's `--profile`
  needs a profile created in the UI first).

## Settings

Nothing is required: files open as `rapid`, the grammar and the formatter each come from
one extension. Optional:

```jsonc
{
  // Name ABB's formatter explicitly (it is already the sole formatter).
  "[rapid]": { "editor.defaultFormatter": "abb-robotics-ecosystem.abb-robotics" },
  // ABB without RAPID Live does not open .prg files as RAPID.
  "files.associations": { "*.prg": "rapid" }
}
```

Neither extension has a setting to switch off its hover, completion or outline, so the
duplicated entries above stay while both are installed.
