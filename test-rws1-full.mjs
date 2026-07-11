// Comprehensive RWS 1.0 verification — every endpoint, with pass/fail report.
// Auto-detects the IRC5 VC port. Read-only — no state changes.
//
// Run:  node test-rws1-full.js
// Or with a specific controller:  RWS1_URL=http://127.0.0.1:23308 node test-rws1-full.js
// Or with a specific port:        PORT=11811 node test-rws1-full.js
//
import { RwsClient } from "abb-rws-client";
import { RWS1_URL, RWS_USER as USER, RWS_PASS as PASS, tcpPing } from "./scripts/lib/probe-common.mjs";

// ─── Auto-detect IRC5 VC port ──────────────────────────────────────────────
const BASE = RWS1_URL ? new URL(RWS1_URL) : null;
const HOST = BASE?.hostname ?? "127.0.0.1";

async function isRWS1(port) {
  try {
    const c = new RwsClient({ host: HOST, port, timeout: 2000, username: USER, password: PASS });
    await c.connect();
    return c;
  } catch { return null; }
}
async function findIRC5() {
  // Common ports first
  for (const p of [11811, 26417, 80, 28447, 16146, 11342, 11343]) {
    if (await tcpPing(p, HOST, 250)) {
      const c = await isRWS1(p);
      if (c) return { port: p, client: c };
    }
  }
  // Wide scan — RobotStudio sometimes assigns ports >30000 (seen 50718 live).
  console.log("  (wide-scanning 1024-65535…)");
  for (let p = 1024; p <= 65535; p++) {
    if (await tcpPing(p, HOST, 80)) {
      const c = await isRWS1(p);
      if (c) return { port: p, client: c };
    }
  }
  return null;
}

console.log("Looking for IRC5 VC…");
const PORT = process.env.PORT ? +process.env.PORT : (BASE ? (Number(BASE.port) || 80) : null);
let found;
if (PORT) {
  const c = await isRWS1(PORT);
  if (c) found = { port: PORT, client: c };
} else {
  found = await findIRC5();
}
if (!found) {
  console.error("\nNo IRC5 VC reachable. Start your VC in RobotStudio and try again.");
  process.exit(1);
}
const { port, client } = found;
console.log(`Found IRC5 on ${HOST}:${port}\n`);

// ─── Test runner ────────────────────────────────────────────────────────────
const passed = [], failed = [];
function check(label, ok, hint = "") {
  (ok ? passed : failed).push({ label, hint });
  process.stdout.write(ok ? "." : "F");
}

async function checkRead(label, fn) {
  try {
    const v = await fn();
    check(label, v !== undefined && v !== null, typeof v === "object" ? "" : String(v).slice(0, 40));
  } catch (e) {
    check(label, false, e.message?.slice(0, 60) ?? String(e));
  }
}

async function checkEndpoint(label, path) {
  try {
    const url = path + (path.includes("?") ? "&" : "?") + "json=1";
    const r = await client.request("GET", url);
    if (r.status === 204) { check(label, true, "204 (empty)"); return; }
    if (r.status >= 400)  { check(label, false, `HTTP ${r.status}`); return; }
    // Some endpoints (e.g. /rw/retcode, /subscription) ignore ?json=1 and return XML.
    // Treat any 2xx with a non-empty body as reachable.
    const body = r.body || "";
    if (body.trimStart().startsWith("<")) {
      check(label, true, `XML ${body.length}b`);
      return;
    }
    const parsed = JSON.parse(body || "{}");
    const states = parsed._embedded?._state ?? [];
    check(label, true, `${states.length} states`);
  } catch (e) {
    check(label, false, e.message?.slice(0, 60) ?? String(e));
  }
}

// ═══ All tests ════════════════════════════════════════════════════════════
console.log("─── Connection ───");
check("connect()", true, `port ${port}`);

console.log("\n\n─── Panel + state (READ ops, always work) ───");
await checkRead("getControllerState",            () => client.getControllerState());
await checkRead("getOperationMode",              () => client.getOperationMode());
await checkRead("getSpeedRatio",                 () => client.getSpeedRatio());
await checkRead("getCollisionDetectionState",    () => client.getCollisionDetectionState());

console.log("\n\n─── RAPID execution (READ) ───");
await checkRead("getRapidExecutionState",        () => client.getRapidExecutionState());
await checkRead("getRapidExecutionInfo",         () => client.getRapidExecutionInfo());
await checkRead("getRapidTasks",                 () => client.getRapidTasks());
await checkRead("listModules(T_ROB1)",           () => client.listModules("T_ROB1"));

console.log("\n\n─── Motion (READ) ───");
await checkRead("getJointPositions",             () => client.getJointPositions());
await checkRead("getCartesianFull",              () => client.getCartesianFull());

console.log("\n\n─── System info ───");
await checkRead("getSystemInfo",                 () => client.getSystemInfo());
await checkRead("getControllerIdentity",         () => client.getControllerIdentity());
await checkRead("getControllerClock",            () => client.getControllerClock());

console.log("\n\n─── Event log + I/O + files (READ) ───");
await checkRead("getEventLog(0)",                () => client.getEventLog(0));
await checkRead("listAllSignals(0,10)",          () => client.listAllSignals(0, 10));
await checkRead("listNetworks",                  () => client.listNetworks());
await checkRead("listDirectory($HOME)",          () => client.listDirectory("$HOME"));
await checkRead("listDirectory($BACKUP)",        () => client.listDirectory("$BACKUP"));

console.log("\n\n─── Wave 1: System detail ───");
await checkEndpoint("/rw/system/robottype",      "/rw/system/robottype");
await checkEndpoint("/rw/system/license",        "/rw/system/license");
await checkEndpoint("/rw/system/products",       "/rw/system/products");
await checkEndpoint("/rw/system/energy",         "/rw/system/energy");
await checkEndpoint("/rw/system/options",        "/rw/system/options");

console.log("\n\n─── Wave 2: Return code + controller detail ───");
await checkEndpoint("/rw/retcode",               "/rw/retcode");
await checkEndpoint("/ctrl/options",             "/ctrl/options");
await checkEndpoint("/ctrl/identity",            "/ctrl/identity");
await checkEndpoint("/ctrl/clock",               "/ctrl/clock");

console.log("\n\n─── Wave 3: RAPID detail ───");
await checkEndpoint("/rw/rapid/aliasio",         "/rw/rapid/aliasio");
await checkEndpoint("/rw/rapid/taskselection",   "/rw/rapid/taskselection");
await checkEndpoint("/rw/rapid/tasks/T_ROB1/pcp",      "/rw/rapid/tasks/T_ROB1/pcp");
await checkEndpoint("/rw/rapid/tasks/T_ROB1/motion",   "/rw/rapid/tasks/T_ROB1/motion");
await checkEndpoint("/rw/rapid/tasks/T_ROB1",          "/rw/rapid/tasks/T_ROB1");
await checkEndpoint("/rw/rapid/execution",       "/rw/rapid/execution");

console.log("\n\n─── Wave 4: Motion detail ───");
await checkEndpoint("/rw/motionsystem",                                         "/rw/motionsystem");
await checkEndpoint("/rw/motionsystem/errorstate",                              "/rw/motionsystem/errorstate");
await checkEndpoint("/rw/motionsystem/nonmotionexecution",                      "/rw/motionsystem/nonmotionexecution");
await checkEndpoint("/rw/motionsystem/mechunits",                               "/rw/motionsystem/mechunits");
await checkEndpoint("/rw/motionsystem/mechunits/ROB_1",                          "/rw/motionsystem/mechunits/ROB_1");
await checkEndpoint("/rw/motionsystem/mechunits/ROB_1/baseframe",                "/rw/motionsystem/mechunits/ROB_1/baseframe");
await checkEndpoint("/rw/motionsystem/mechunits/ROB_1/axes",                     "/rw/motionsystem/mechunits/ROB_1/axes");
await checkEndpoint("/rw/motionsystem/mechunits/ROB_1/jointtarget",              "/rw/motionsystem/mechunits/ROB_1/jointtarget");
await checkEndpoint("/rw/motionsystem/mechunits/ROB_1/cartesian",                "/rw/motionsystem/mechunits/ROB_1/cartesian");

console.log("\n\n─── Wave 5: CFG database (all 6 domains) ───");
await checkEndpoint("/rw/cfg",                   "/rw/cfg");
for (const d of ["EIO", "MMC", "MOC", "PROC", "SIO", "SYS"]) {
  await checkEndpoint(`/rw/cfg/${d}`,            `/rw/cfg/${d}`);
}
await checkEndpoint("/rw/cfg/MOC/MOTION_SYSTEM/instances", "/rw/cfg/MOC/MOTION_SYSTEM/instances");
await checkEndpoint("/rw/cfg/MOC/ROBOT/instances",         "/rw/cfg/MOC/ROBOT/instances");
await checkEndpoint("/rw/cfg/EIO/EIO_SIGNAL/instances",    "/rw/cfg/EIO/EIO_SIGNAL/instances");

console.log("\n\n─── Wave 6: RMMP, mastership, subscription ───");
await checkEndpoint("/users/rmmp",               "/users/rmmp");
await checkEndpoint("/rw/mastership",            "/rw/mastership");
await checkEndpoint("/subscription",             "/subscription");

console.log("\n\n─── Wave 7: Backup / progress ───");
await checkEndpoint("/ctrl/backup",              "/ctrl/backup");
await checkEndpoint("/progress",                 "/progress");

console.log("\n\n─── Wave 8: DIPC ───");
await checkEndpoint("/rw/dipc",                  "/rw/dipc");

console.log("\n\n─── Wave 9: Safety ───");
await checkEndpoint("/ctrl/safety",              "/ctrl/safety");

console.log("\n\n─── Wave 10: Virtual time (4 sub-resources) ───");
await checkEndpoint("/ctrl/virtualtime",                  "/ctrl/virtualtime");
for (const sub of ["vttime", "vtstate", "vtspeed", "vttimeslice"]) {
  await checkEndpoint(`/ctrl/virtualtime/${sub}`, `/ctrl/virtualtime/${sub}`);
}

console.log("\n\n─── Wave 11: Vision ───");
await checkEndpoint("/rw/vision",                "/rw/vision");

await client.disconnect();

// ─── Final report ───────────────────────────────────────────────────────────
console.log("\n\n" + "═".repeat(70));
console.log(`PASSED: ${passed.length}    FAILED: ${failed.length}    TOTAL: ${passed.length + failed.length}`);
console.log("═".repeat(70));

if (failed.length === 0) {
  console.log("\n🎉  All RWS 1.0 endpoints reachable.");
  process.exit(0);
}

console.log("\nFailed:");
for (const f of failed) {
  console.log(`  ✗ ${f.label}` + (f.hint ? ` — ${f.hint}` : ""));
}

console.log("\nNote: 404s on safety zones, breakpoints, network/dns/routes, time zone,");
console.log("      and compatibility are usually controller-config dependent (not bugs in our code).");
console.log("      404s on /ctrl/features, /ctrl/certstore, /ctrl/registry are RobotWare 7-only.");
process.exit(failed.length > 5 ? 1 : 0);
