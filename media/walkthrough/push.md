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

Push unloads the module on the controller and loads your file in its place.
If RAPID is running, the controller may refuse; the extension then asks
whether to stop the program first (**Stop Program and Continue**). When the
file declares `PROC main()`, the program pointer is set to main.

**Diff before pushing:** right-click → **Diff with Controller** opens
VS Code's native diff editor between your local file and what's currently
loaded on the controller. Useful when collaborating with a teammate who
may have edited the controller directly.
