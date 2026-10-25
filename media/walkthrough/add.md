# Add a Robot

The **Robots** panel lives in the ABB activity bar (left side, robot icon).

```
┌─ Robots ────────────────────┐
│  + Add Robot…               │
└─────────────────────────────┘
```

The wizard reads this PC's listening ports and lists the RobotStudio virtual
controllers it finds, whatever random port they got. It also probes
`192.168.125.1` when your PC is cabled to a controller's service port, lists
controllers that announce themselves over mDNS, and probes the addresses you
saved with **Add address / range…**.

For a real controller on another network, use **Enter address manually…** or
**Add address / range…**, then enter credentials. A range is scanned only when
you pick it, and the wizard asks first every time: on a company network IT can
see the connection attempts.

To forget a saved address or range, click the trash button next to it in the
list, or use **Manage saved addresses and ranges…** to remove several or all.
To remove a robot, click the trash icon on its row in the **Robots** panel.

> For a virtual controller on this PC the wizard fills in `Admin` (RWS 2.0)
> or `Default User` (RWS 1.0) with the password `robotics`. For a controller
> on another machine, enter a user that exists on it. If your controller
> refuses, check the FlexPendant: ABB menu → Control Panel → User
> Authorization.
