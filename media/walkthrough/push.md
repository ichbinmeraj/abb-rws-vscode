# Edit and Push Back

After you make changes, right-click in the editor → **Push Current File
to Controller**. Or use the editor title-bar cloud-upload icon.

```
   1│ MODULE MotionTest
   2│   PROC main()
   3│     MoveJ pHome, v500, fine, tool0;
   4│     ! ↑ change v500 → v1000
                   ^^^^^
            edit, save (Ctrl+S),
            then right-click → Push
```

The controller picks up the change immediately. If a routine was running,
the next iteration uses the new code.

**Diff before pushing:** right-click → **Diff with Controller** opens
VS Code's native diff editor between your local file and what's currently
loaded on the controller. Useful when collaborating with a teammate who
may have edited the controller directly.
