# Connect to Your Robot

Right-click the robot in the **Robots** panel → **Connect**. Or use the
inline plug icon when hovering the row.

```
┌─ Robots ────────────────────┐
│  ● MyVC                     │  ← green dot = connected
│  ◌ ProductionRobot          │  ← gray = disconnected
└─────────────────────────────┘
```

Once connected:

- Status bar (bottom) shows three pills: **host · op-mode · exec state**
- **Live Cell** panel populates with joints, TCP, mode, exec
- All other panels (Modules, RAPID, Motion, etc.) come alive

If the connection fails, click "Show Logs" on the error notification - the
extension logs every HTTP request to a session file under
`~/.abb-rws-extension/logs/`.
