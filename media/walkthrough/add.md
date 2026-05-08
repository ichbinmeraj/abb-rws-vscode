# Add a Robot

The **Robots** panel lives in the ABB activity bar (left side, robot icon).

```
┌─ Robots ────────────────────┐
│  [+ Add Robot]              │
│  [Auto-detect VC]           │
└─────────────────────────────┘
```

The wizard scans `127.0.0.1` and `192.168.125.1` automatically and lists any
controllers it finds. RobotStudio virtual controllers use random ports; the
extension wide-scans for them.

For a real controller, enter the IP and credentials manually.

> The default `Admin` / `robotics` works on most OmniCore controllers and on
> IRC5 with default UAS configuration. If your controller refuses, check
> the FlexPendant: ABB menu → Control Panel → User Authorization.
