# RWS 1.0 Full Parity Plan — `abb-rws-client@0.6.0`

**Goal**: bring `RWS1Adapter` to the same ~115-method surface as `RWS2Adapter` so
the extension behaves identically on IRC5 / RobotWare 6 and OmniCore / RobotWare 7.

**Source of truth**: ABB RWS 1.0 Application Manual **3HAC050973-001 Rev M**
(`D:\ABBRWS\RWS_API_Full_Reference.md`).

---

## Architecture decision

Instead of adding 100+ individual methods to `abb-rws-client`, we add **one new
public method** that exposes the underlying HTTP session:

```typescript
client.request(method, path, body?, contentType?): Promise<{status, body}>
```

Then `RWS1Adapter` implements each new method as ~10 lines: call `request()`,
parse the JSON `_embedded._state` envelope, return typed result.

**Why this approach:**
1. Keeps `abb-rws-client` focused on the well-known core surface (~45 high-level
   methods that handle all the digest/cookie/queue complexity).
2. Lets us add controller-side endpoints rapidly without bloating the library.
3. Mirrors how the RWS 2.0 adapter already works (raw `req()` + custom parsing).
4. Easier to iterate — bug fixes don't require repackaging the npm tgz.

---

## Coverage matrix — all 120+ endpoints

### Stage 1 — System detail (5 methods)

| Method | Endpoint | Source |
|---|---|---|
| `getRobotType` | `GET /rw/system/robottype?json=1` | Doc 6.8 |
| `getLicenseInfo` | `GET /rw/system/licenses?json=1` | Doc 6.8 |
| `listProducts` | `GET /rw/system/products?json=1` | Doc 6.8 |
| `getEnergyStats` | `GET /rw/system/energy?json=1` | Doc 6.8 |
| `listSystemOptions` | `GET /rw/system/options?json=1` | Doc 6.8 |

### Stage 2 — Return codes & devices (3)

| Method | Endpoint |
|---|---|
| `getReturnCode(code)` | `GET /rw/retcode?code={N}&json=1` |
| `listAllReturnCodes` | `GET /rw/retcode?json=1` |
| `listDevices` | `GET /rw/devices?json=1` |

### Stage 3 — RAPID detail (10)

| Method | Endpoint |
|---|---|
| `listAliasIO` | `GET /rw/rapid/aliasio?json=1` |
| `getTaskSelection` | `GET /rw/rapid/taskselection?json=1` |
| `setTaskSelection(tasks)` | `POST /rw/rapid/taskselection?json=1` |
| `getProgramPointer(task)` | `GET /rw/rapid/tasks/{task}/pcp?json=1` |
| `getMotionPointer(task)` | `GET /rw/rapid/tasks/{task}/motion?json=1` |
| `getServiceRoutine(task)` | `GET /rw/rapid/tasks/{task}/serviceroutine?json=1` |
| `saveModule(task, name, path)` | `POST /rw/rapid/tasks/{task}?action=savemod&json=1` |
| `listModuleRoutines(task, module)` | `GET /rw/rapid/modules/{task}/{module}/routines?json=1` |
| `startProductionMode` | `POST /rw/rapid/execution?action=start-prod&json=1` |
| `holdToRun(task, action)` | `POST /rw/rapid/tasks/{task}?action=holdtorun&json=1` |

### Stage 4 — RAPID breakpoints (4)

| Method | Endpoint |
|---|---|
| `listBreakpoints(task)` | `GET /rw/rapid/tasks/{task}/breakpoints?json=1` |
| `setBreakpoint(task, module, row, col?)` | `POST .../breakpoints?action=set&json=1` |
| `removeBreakpoint(task, module, row, col?)` | `DELETE .../breakpoints/{id}?json=1` |
| `clearBreakpoints(task)` | `POST .../breakpoints?action=clear&json=1` |

### Stage 5 — Motion detail (12)

| Method | Endpoint |
|---|---|
| `listMechunits` | `GET /rw/motionsystem/mechunits?json=1` |
| `getMechunitInfo(unit)` | `GET /rw/motionsystem/mechunits/{u}?json=1` |
| `getMechunitBaseFrame(unit)` | `GET /rw/motionsystem/mechunits/{u}/baseframe?json=1` |
| `setMechunitBaseFrame(unit, frame)` | `POST .../baseframe?action=set&json=1` |
| `getMechunitAxes(unit)` | `GET .../axes?json=1` |
| `getMechunitCalibInfo(unit)` | `GET .../calib?json=1` |
| `getMotionErrorState` | `GET /rw/motionsystem/errorstate?json=1` |
| `getMotionSupervision` | `GET /rw/motionsystem/motionsupervision?json=1` |
| `setMotionSupervision(level)` | `POST .../motionsupervision?action=set&json=1` |
| `getPathSupervision` | `GET /rw/motionsystem/pathsupervision?json=1` |
| `getNonMotionExecution` | `GET /rw/motionsystem/nonmotionexecution?json=1` |
| `setNonMotionExecution(on)` | `POST .../nonmotionexecution?action=set&json=1` |
| `calcCartesianFromJoints` (FK) | `POST .../mechunits/{u}?action=CalcPoseFromJoints&json=1` |

### Stage 6 — CFG database (9 — the big one)

| Method | Endpoint |
|---|---|
| `listCfgDomains` | `GET /rw/cfg?json=1` → 6 domains |
| `listCfgTypes(domain)` | `GET /rw/cfg/{domain}?json=1` (paginated) |
| `listCfgInstances(domain, type)` | `GET /rw/cfg/{domain}/{type}/instances?json=1` |
| `getCfgInstance(domain, type, instance)` | `GET /rw/cfg/{domain}/{type}/{instance}?json=1` |
| `setCfgInstance(...)` | `POST .../{instance}?action=set&json=1` |
| `createCfgInstance(...)` | `POST /rw/cfg/{domain}/{type}/instances?action=create&json=1` |
| `removeCfgInstance(...)` | `DELETE /rw/cfg/{domain}/{type}/{instance}?json=1` |
| `loadCfgFile(filepath, action)` | `POST /rw/cfg?action=load&json=1` |
| `validateCfgFile(filepath)` | `POST /rw/cfg?action=validate&json=1` |

### Stage 7 — Backup / Restore / Compress / Diagnostics (10)

| Method | Endpoint |
|---|---|
| `listBackups` | `GET /fileservice/$BACKUP?json=1` |
| `createBackup(name)` | `POST /ctrl/backup?action=backup&json=1` (returns 202 + /progress URL) |
| `restoreBackup(name)` | `POST /ctrl/backup?action=restore&json=1` (returns 202) |
| `getBackupStatus` | `GET /ctrl/backup?json=1` |
| `compressFile(src, dst)` | `POST /ctrl/compress?action=compress&json=1` |
| `decompressFile(src, dst)` | `POST /ctrl/compress?action=decompress&json=1` |
| `saveDiagnostics(path)` | `POST /ctrl/diagnostics?action=save&json=1` (202) |
| `listProgress` | `GET /progress?json=1` |
| `getProgress(id)` | `GET /progress/{id}?json=1` |

### Stage 8 — DIPC (6)

| Method | Endpoint |
|---|---|
| `listDipcQueues` | `GET /rw/dipc?json=1` |
| `createDipcQueue(name, opts)` | `POST /rw/dipc?action=create&json=1` |
| `getDipcQueue(name)` | `GET /rw/dipc/{queue}?json=1` |
| `sendDipcMessage(queue, payload, type)` | `POST /rw/dipc/{queue}?action=send&json=1` |
| `readDipcMessage(queue)` | `GET /rw/dipc/{queue}?action=read&json=1` |
| `removeDipcQueue(name)` | `DELETE /rw/dipc/{queue}?json=1` |

### Stage 9 — Safety controller (5)

| Method | Endpoint |
|---|---|
| `getSafetyStatus` | `GET /ctrl/safety?json=1` |
| `getSafetyMode` | `GET /ctrl/safety?action=get-mode&json=1` |
| `runCyclicBrakeCheck` | `GET /ctrl/safety/cyclic-brake-check?json=1` |
| `getSafetyConfigStatus` | `GET /ctrl/safety/config-status?json=1` |
| `loadSafetyConfig(filepath)` | `POST /ctrl/safety?action=load&json=1` |

### Stage 10 — Virtual time (3, VC-only)

| Method | Endpoint |
|---|---|
| `getVirtualTime` | `GET /ctrl/virtualtime?json=1` |
| `setVirtualTimeRunning(bool)` | `POST /ctrl/virtualtime/vtrun?json=1` |
| `setVirtualTimeSpeed(scale)` | `POST /ctrl/virtualtime/vtspeed?action=set&json=1` |

### Stage 11 — Integrated Vision (5)

| Method | Endpoint |
|---|---|
| `listVisionSystems` | `GET /rw/vision?json=1` |
| `getVisionCameraInfo(camera)` | `GET /rw/vision/{camera}?json=1` |
| `triggerVisionJob(camera)` | `POST /rw/vision/{camera}?action=trigger&json=1` |
| `restartVisionCamera(camera)` | `POST /rw/vision/{camera}?action=restart&json=1` |
| `flashVisionLeds(camera)` | `POST /rw/vision/{camera}?action=flash&json=1` |

### Stage 12 — RMMP (3)

| Method | Endpoint |
|---|---|
| `getRmmpPrivilege` | `GET /users/rmmp?json=1` |
| `requestRmmp(level)` | `POST /users/rmmp?action=request&json=1` |
| `pollRmmpGrant` | `GET /users/rmmp/poll?json=1` |

### Stage 13 — Network / Time / Compatibility (8)

| Method | Endpoint |
|---|---|
| `getNetworkConfig` | `GET /ctrl/network?json=1` |
| `getDnsConfig` | `GET /ctrl/network/dns?json=1` |
| `setDnsConfig(servers)` | `PUT /ctrl/network/dns?json=1` |
| `getRoutingTable` | `GET /ctrl/network/routes?json=1` |
| `getTimezone` | `GET /ctrl/clock/timezone?json=1` |
| `setTimezone(tz)` | `POST /ctrl/clock/timezone?action=set&json=1` |
| `getTimeServer` | `GET /ctrl/clock/timeserver?json=1` |
| `getCompatibility` | `GET /ctrl/compatible?json=1` |

### Stage 14 — Set mechunit / robtarget for jogging (2)

| Method | Endpoint |
|---|---|
| `setMechunitForJogging(unit)` | `POST /rw/motionsystem?action=set-mechunit&json=1` |
| `setRobtargetForJogging(target)` | `POST /rw/motionsystem?action=set-target&json=1` |

### Stage 15 — High-priority subscriptions (architectural)

Convert per-signal and per-persvar subscriptions to use `priority=2` (high) so
they get sub-200ms updates. Currently we use `priority=1` (medium, ~200ms-1s).

---

## Implementation order — what we ship now vs later

**This session**: Add `request()` helper to `abb-rws-client@0.6.0`, then
implement Stages 1, 2, 3, 4, 5, 6 (44 methods) in `RWS1Adapter` — the highest
visible value. CFG editor + system detail + RAPID/motion detail.

**Follow-up session**: Stages 7-15 (~30 more methods).

After this session:
- `RWS1Adapter` will have **~90 methods** (was 45)
- Most of our extension's UI will work identically on RWS 1.0 and RWS 2.0
- Documented gap: only ~25 methods remaining (mostly admin/niche)

---

## Verification

For each stage, run a parallel of `test-everything.mjs` against the IRC5 VC.
At the end of this session: `test-rws1-everything.js` should report ≥ 90 / 90
on the live IRC5.
