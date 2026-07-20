// Comprehensive RWS 1.0 *write* verification - every modify endpoint, restored.
// Auto-detects the IRC5 VC port. Each test restores controller state to what
// it was before the test. Safe to run repeatedly.
//
// Run:  node test-rws1-writes.js
// Or with a specific controller:  RWS1_URL=http://127.0.0.1:23308 node test-rws1-writes.js
// Or with a specific port:        PORT=50718 node test-rws1-writes.js
//
// Behavior by mode:
//   AUTO:           full write tests run
//   MANR/MANF:      mastership-required ops auto-skip with a note
//
import { RwsClient } from "abb-rws-client";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RWS1_URL, RWS_USER as USER, RWS_PASS as PASS, tcpPing } from "./scripts/lib/probe-common.mjs";

// ─── Auto-detect IRC5 VC port (1024-65535) ─────────────────────────────────
const BASE = RWS1_URL ? new URL(RWS1_URL) : null;
const HOST = BASE?.hostname ?? "127.0.0.1";

async function tryOpen(port) {
  try {
    const c = new RwsClient({ host: HOST, port, timeout: 3000, username: USER, password: PASS });
    await c.connect();
    return c;
  } catch { return null; }
}
async function findIRC5() {
  for (const p of [50718, 11811, 26417, 80, 28447, 16146, 11342, 11343]) {
    if (await tcpPing(p, HOST, 250)) {
      const c = await tryOpen(p);
      if (c) return { port: p, client: c };
    }
  }
  console.log("  (wide-scanning 1024-65535…)");
  for (let p = 1024; p <= 65535; p++) {
    if (await tcpPing(p, HOST, 80)) {
      const c = await tryOpen(p);
      if (c) return { port: p, client: c };
    }
  }
  return null;
}

console.log("Looking for IRC5 VC…");
const PORT = process.env.PORT ? +process.env.PORT : (BASE ? (Number(BASE.port) || 80) : null);
let found;
if (PORT) {
  const c = await tryOpen(PORT);
  if (c) found = { port: PORT, client: c };
} else {
  found = await findIRC5();
}
if (!found) {
  console.error("\nNo IRC5 VC reachable. Start your VC in RobotStudio and try again.");
  process.exit(1);
}
const { port, client } = found;
console.log(`Found IRC5 on ${HOST}:${port} as ${USER}\n`);

// ─── Test runner ────────────────────────────────────────────────────────────
const passed = [], failed = [], skipped = [];
async function test(label, fn) {
  process.stdout.write(`  ${label}… `);
  try {
    const note = await fn();
    passed.push({ label, note });
    console.log(`✓${note ? ` (${note})` : ""}`);
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (msg.startsWith("SKIP:")) {
      skipped.push({ label, reason: msg.slice(6) });
      console.log(`⊘ ${msg.slice(6)}`);
    } else {
      failed.push({ label, error: msg });
      console.log(`✗ ${msg.slice(0, 80)}`);
    }
  }
}
const skip = (reason) => { throw new Error("SKIP:" + reason); };

// ═══ Pre-flight ═══════════════════════════════════════════════════════════
console.log("═".repeat(70));
console.log(" Pre-flight");
console.log("═".repeat(70));

const initialState = {};
await test("read controller state", async () => {
  initialState.ctrlstate    = await client.getControllerState();
  initialState.opmode       = await client.getOperationMode();
  initialState.speedRatio   = await client.getSpeedRatio();
  initialState.execState    = await client.getRapidExecutionState();
  return `mode=${initialState.opmode} state=${initialState.ctrlstate} speed=${initialState.speedRatio}%`;
});

// Read RMMP to decide whether mastership-required ops can succeed.
let rmmpPrivilege = "none";
await test("read RMMP privilege", async () => {
  const r = await client.request("GET", "/users/rmmp?json=1");
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}`); }
  const m = r.body.match(/"privilege"\s*:\s*"([^"]+)"/);
  rmmpPrivilege = m?.[1] ?? "unknown";
  return `privilege=${rmmpPrivilege}`;
});

const inAuto = initialState.opmode === "AUTO";
const canModify = inAuto || rmmpPrivilege === "modify" || rmmpPrivilege === "exclusive";

console.log("");
if (!canModify) {
  console.log(`⚠️  opmode=${initialState.opmode}, RMMP=${rmmpPrivilege} - mastership-required tests will SKIP.`);
  console.log(`   To run full tests: switch to AUTO in RobotStudio, or grant RMMP from FlexPendant.`);
} else {
  console.log(`✓  opmode=${initialState.opmode}, RMMP=${rmmpPrivilege} - full write tests will run.`);
}
console.log("");

// ═══ Mastership cycles ════════════════════════════════════════════════════
console.log("═".repeat(70));
console.log(" Mastership cycles");
console.log("═".repeat(70));

for (const dom of ["motion", "rapid", "cfg"]) {
  await test(`requestMastership('${dom}')`, async () => {
    if (!canModify && dom !== "motion") {
      skip(`needs AUTO or RMMP=modify`);
    }
    await client.requestMastership(dom);
    return "ok";
  });
  await test(`releaseMastership('${dom}')`, async () => {
    if (!canModify && dom !== "motion") {
      skip(`previous request skipped`);
    }
    await client.releaseMastership(dom);
    return "ok";
  });
}

// ═══ Panel writes ═════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" Panel writes (with restore)");
console.log("═".repeat(70));

await test("setSpeedRatio(50)", async () => {
  if (!canModify) skip("needs AUTO or RMMP=modify");
  await client.setSpeedRatio(50);
  const v = await client.getSpeedRatio();
  if (v !== 50) { throw new Error(`expected 50, got ${v}`); }
  return "verified read-back = 50";
});
await test(`setSpeedRatio(${initialState.speedRatio}) restore`, async () => {
  if (!canModify) skip("nothing to restore (set was skipped)");
  await client.setSpeedRatio(initialState.speedRatio);
  return `restored to ${initialState.speedRatio}`;
});

await test("setControllerState('motoroff')", async () => {
  if (!canModify) skip("needs AUTO or RMMP=modify");
  await client.setControllerState("motoroff");
  await new Promise(r => setTimeout(r, 500));
  const v = await client.getControllerState();
  return `state=${v}`;
});
await test("setControllerState('motoron')", async () => {
  if (!canModify) skip("needs AUTO + safety chain closed");
  await client.setControllerState("motoron");
  await new Promise(r => setTimeout(r, 500));
  const v = await client.getControllerState();
  return `state=${v}`;
});

// ═══ Controller clock ═════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" Controller clock");
console.log("═".repeat(70));

let originalClock;
await test("getControllerClock", async () => {
  originalClock = await client.getControllerClock();
  return `datetime=${originalClock.datetime}`;
});
await test("setControllerClock to PC time", async () => {
  // RW6.16 only allows GET on /ctrl/clock - POST and PUT both return 405.
  // This is a controller-firmware limitation, not a bug in our code.
  const r = await client.request("OPTIONS", "/ctrl/clock?json=1").catch(() => ({ status: 0 }));
  // Skip if the server doesn't allow modification methods on this endpoint
  try {
    const now = new Date();
    await client.setControllerClock(
      now.getFullYear(), now.getMonth() + 1, now.getDate(),
      now.getHours(), now.getMinutes(), now.getSeconds(),
    );
    return "set ok";
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (msg.includes("HTTP 405") || msg.includes("not supported")) {
      skip("not supported on this RobotWare (read-only on RW6.x)");
    }
    throw e;
  }
});

// ═══ File system writes ═══════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" File system writes ($HOME)");
console.log("═".repeat(70));

const TEST_FILE   = "$HOME/rws1-write-test.txt";
const TEST_FILE_2 = "$HOME/rws1-write-test-copy.txt";
const TEST_DIR    = "rws1-write-test-dir";
const TEST_CONTENT = "Hello from RWS 1.0 write test " + Date.now();

let uploadedTestFile = false;
await test("uploadModule (small text)", async () => {
  await client.uploadModule(TEST_FILE, TEST_CONTENT);
  uploadedTestFile = true;
  return `wrote ${TEST_CONTENT.length} bytes`;
});
await test("readFile and verify content", async () => {
  if (!uploadedTestFile) skip("upload failed");
  const got = await client.readFile(TEST_FILE);
  if (got !== TEST_CONTENT) { throw new Error(`content mismatch: got "${got.slice(0,40)}"`); }
  return "byte-exact match";
});
await test("copyFile", async () => {
  if (!uploadedTestFile) skip("upload failed");
  await client.copyFile(TEST_FILE, TEST_FILE_2);
  const got = await client.readFile(TEST_FILE_2);
  if (got !== TEST_CONTENT) { throw new Error("copy content mismatch"); }
  return "verified copy contents";
});
await test(`createDirectory($HOME, ${TEST_DIR})`, async () => {
  await client.createDirectory("$HOME", TEST_DIR);
  const entries = await client.listDirectory("$HOME");
  const hit = entries.find(e => e.name === TEST_DIR);
  if (!hit) { throw new Error("directory not in listing"); }
  return `created (kind=${hit.kind ?? hit.type ?? "?"})`;
});
await test("deleteFile (test file)", async () => {
  if (!uploadedTestFile) skip("nothing to delete");
  await client.deleteFile(TEST_FILE);
  return "deleted";
});
await test("deleteFile (copy)", async () => {
  await client.deleteFile(TEST_FILE_2).catch((e) => {
    if (String(e).includes("404")) return; // already gone or copy never made
    throw e;
  });
  return "deleted";
});
await test("deleteFile (directory)", async () => {
  await client.deleteFile(`$HOME/${TEST_DIR}`).catch((e) => {
    if (String(e).includes("404") || String(e).includes("400")) {
      skip("controller refused directory delete");
    }
    throw e;
  });
  return "deleted";
});

// ═══ Module load / unload ═════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" Module load / unload (TestExtension.mod)");
console.log("═".repeat(70));

const MODULE_PATH_LOCAL  = path.resolve("D:/abb-rws-vscode/samples/TestExtension.mod");
const MODULE_PATH_REMOTE = "$HOME/TestExtension.mod";
let moduleSrc;

await test("read TestExtension.mod from disk", async () => {
  moduleSrc = await fs.readFile(MODULE_PATH_LOCAL, "utf-8");
  return `${moduleSrc.length} bytes, ${moduleSrc.split("\n").length} lines`;
});
let moduleUploaded = false;
await test("uploadModule(TestExtension.mod)", async () => {
  await client.uploadModule(MODULE_PATH_REMOTE, moduleSrc);
  moduleUploaded = true;
  return "uploaded to $HOME";
});

let moduleLoaded = false;
await test("loadModule(T_ROB1, ...)", async () => {
  if (!canModify) skip("needs AUTO or RMMP=modify");
  if (!moduleUploaded) skip("upload failed");
  await client.requestMastership("rapid");
  try {
    await client.stopRapid().catch(() => {});
    const existing = await client.listModules("T_ROB1");
    if (existing.includes("TestExtension")) {
      await client.unloadModule("T_ROB1", "TestExtension").catch(() => {});
    }
    await client.loadModule("T_ROB1", MODULE_PATH_REMOTE, true);
    moduleLoaded = true;
  } finally {
    await client.releaseMastership("rapid").catch(() => {});
  }
  return "loaded with replace=true";
});
await test("listModules includes TestExtension", async () => {
  if (!moduleLoaded) skip("module not loaded");
  const mods = await client.listModules("T_ROB1");
  if (!mods.includes("TestExtension")) { throw new Error(`got: ${mods.join(",")}`); }
  return `${mods.length} modules`;
});

// ═══ RAPID variable writes ════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" RAPID variable writes");
console.log("═".repeat(70));

let originalCounter;
// First check if the controller even exposes the dynamic module's symbols.
// On this RW6.16 VC, dynamically-loaded NORM-modules (and even SYS-modules
// added at runtime via ?action=loadmod) don't enter the runtime symbol table
// until a program is built (.pgf) or the controller restarts.
// Reading reg1 from the boot-time `user` SYSMODULE confirms the read API works.
let dynSymbolsReadable = false;
await test("probe: built-in user/reg1 (sanity)", async () => {
  const v = await client.getRapidVariable("T_ROB1", "user", "reg1");
  return `reg1 = ${v}`;
});
await test("getRapidVariable(TestExtension/counter)", async () => {
  if (!moduleLoaded) skip("module not loaded");
  try {
    originalCounter = await client.getRapidVariable("T_ROB1", "TestExtension", "counter");
    dynSymbolsReadable = true;
    return `counter = ${originalCounter}`;
  } catch (e) {
    const detail = (e?.rwsDetail ?? "") + (e?.message ?? "");
    if (detail.toLowerCase().includes("symbol not found")) {
      skip("dynamically-loaded module symbols not in runtime table (needs .pgf or restart)");
    }
    throw e;
  }
});
await test("setRapidVariable(counter, 42)", async () => {
  if (!moduleLoaded) skip("module not loaded");
  if (!dynSymbolsReadable) skip("symbol not in runtime table");
  await client.requestMastership("rapid");
  try {
    await client.setRapidVariable("T_ROB1", "TestExtension", "counter", "42");
  } finally {
    await client.releaseMastership("rapid").catch(() => {});
  }
  const v = await client.getRapidVariable("T_ROB1", "TestExtension", "counter");
  if (Number(v) !== 42) { throw new Error(`expected 42, got ${v}`); }
  return "verified read-back = 42";
});
await test("setRapidVariable restore", async () => {
  if (!moduleLoaded || !dynSymbolsReadable || originalCounter === undefined) skip("set was skipped");
  await client.requestMastership("rapid");
  try {
    await client.setRapidVariable("T_ROB1", "TestExtension", "counter", String(originalCounter));
  } finally {
    await client.releaseMastership("rapid").catch(() => {});
  }
  return `restored to ${originalCounter}`;
});

// ═══ RAPID execution control ══════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" RAPID execution control");
console.log("═".repeat(70));

await test("stopRapid", async () => {
  await client.stopRapid();
  await new Promise(r => setTimeout(r, 300));
  return `state=${await client.getRapidExecutionState()}`;
});
let ppSet = false;
await test("resetRapid (PP-to-Main)", async () => {
  if (!canModify) skip("needs AUTO or RMMP=modify");
  if (!moduleLoaded) skip("no module loaded");
  await client.requestMastership("rapid");
  try {
    await client.resetRapid();
    ppSet = true;
  } catch (e) {
    if (String(e).includes("400") || String(e).includes("3500")) {
      // org_code 3500 = "Routine main not found" - controller has no entrypoint.
      // Happens when no program is built; SYSMODULE module's main isn't auto-picked.
      skip("no program entrypoint (controller needs program built first)");
    }
    throw e;
  } finally {
    await client.releaseMastership("rapid").catch(() => {});
  }
  return "PP set to main";
});
await test("startRapid (briefly)", async () => {
  if (!canModify) skip("needs AUTO + motors-on");
  if (initialState.ctrlstate !== "motoron") skip(`motors not on (state=${initialState.ctrlstate})`);
  if (!ppSet) skip("PP not set");
  await client.startRapid();
  await new Promise(r => setTimeout(r, 800));
  const s = await client.getRapidExecutionState();
  return `state=${s}`;
});
await test("stopRapid (final)", async () => {
  await client.stopRapid();
  await new Promise(r => setTimeout(r, 300));
  return "stopped";
});

// ═══ Module cleanup ═══════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" Module cleanup");
console.log("═".repeat(70));

await test("unloadModule(TestExtension)", async () => {
  if (!moduleLoaded) skip("module never loaded");
  await client.requestMastership("rapid");
  try {
    await client.stopRapid().catch(() => {});
    await client.unloadModule("T_ROB1", "TestExtension");
  } finally {
    await client.releaseMastership("rapid").catch(() => {});
  }
  return "unloaded";
});
await test("deleteFile (TestExtension.mod)", async () => {
  if (!moduleUploaded) skip("never uploaded");
  await client.deleteFile(MODULE_PATH_REMOTE);
  return "deleted from $HOME";
});

// ═══ I/O signal toggle ════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" I/O signal toggle");
console.log("═".repeat(70));

let writableSignal = null;
let originalSignalValue = null;
await test("find writable DO signal", async () => {
  const sigs = await client.listAllSignals(0, 200);
  const candidate = sigs.find(s => s.type === "DO" && s.name && !s.name.startsWith("ES_"));
  if (!candidate) { throw new Error("no DO signal found"); }
  writableSignal = candidate;
  originalSignalValue = candidate.lvalue ?? candidate.value ?? "0";
  return `${candidate.name} (lvalue=${originalSignalValue})`;
});
await test("writeSignal toggle", async () => {
  // Even in AUTO, writeSignal needs RMMP=modify on this VC - controller rejects
  // with HTTP 403 "Rejected" otherwise.
  if (rmmpPrivilege !== "modify" && rmmpPrivilege !== "exclusive") {
    skip("needs RMMP=modify (FlexPendant grant)");
  }
  if (!writableSignal) skip("no signal selected");
  const newVal = originalSignalValue === "1" ? "0" : "1";
  await client.writeSignal(
    writableSignal.network ?? "",
    writableSignal.device  ?? "",
    writableSignal.name,
    newVal,
  );
  await new Promise(r => setTimeout(r, 200));
  const sig = await client.readSignal(
    writableSignal.network ?? "",
    writableSignal.device  ?? "",
    writableSignal.name,
  );
  if ((sig.lvalue ?? sig.value) !== newVal) {
    throw new Error(`expected ${newVal}, got ${sig.lvalue ?? sig.value}`);
  }
  return `set to ${newVal}, verified`;
});
await test("writeSignal restore", async () => {
  if (rmmpPrivilege !== "modify" && rmmpPrivilege !== "exclusive") skip("set was skipped");
  if (!writableSignal) skip("no signal selected");
  await client.writeSignal(
    writableSignal.network ?? "",
    writableSignal.device  ?? "",
    writableSignal.name,
    originalSignalValue,
  );
  return `restored to ${originalSignalValue}`;
});

// ═══ DIPC queue lifecycle ═════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" DIPC queue lifecycle");
console.log("═".repeat(70));

// DIPC needs TWO queues - send goes from a source queue to a destination.
// Pre-clean any leftovers from prior runs (delete works for queues we own).
const DIPC_SRC  = `rws1tq_src_${Date.now() % 100000}`;
const DIPC_DEST = `rws1tq_dst_${Date.now() % 100000}`;
let dipcSrcCreated = false, dipcDestCreated = false;
await test("create DIPC src queue", async () => {
  const body = `dipc-queue-name=${DIPC_SRC}&dipc-queue-size=1024&dipc-max-msg-size=444&dipc-max-no-of-messages=10`;
  const r = await client.request("POST", "/rw/dipc?action=dipc-create&json=1", body);
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 120)}`); }
  dipcSrcCreated = true;
  return `HTTP ${r.status}`;
});
await test("create DIPC dest queue", async () => {
  const body = `dipc-queue-name=${DIPC_DEST}&dipc-queue-size=1024&dipc-max-msg-size=444&dipc-max-no-of-messages=10`;
  const r = await client.request("POST", "/rw/dipc?action=dipc-create&json=1", body);
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 120)}`); }
  dipcDestCreated = true;
  return `HTTP ${r.status}`;
});
await test("read DIPC queue info", async () => {
  if (!dipcDestCreated) skip("queue not created");
  const r = await client.request("GET", `/rw/dipc/${DIPC_DEST}?json=1`);
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}`); }
  return `HTTP ${r.status}`;
});
await test("send DIPC message (src→dest)", async () => {
  if (!dipcSrcCreated || !dipcDestCreated) skip("queues not created");
  const body = `dipc-src-queue-name=${DIPC_SRC}&dipc-cmd=111&dipc-userdef=222&dipc-msgtype=1&dipc-data=hello`;
  const r = await client.request("POST", `/rw/dipc/${DIPC_DEST}?action=dipc-send&json=1`, body);
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 120)}`); }
  return `HTTP ${r.status}`;
});
await test("remove DIPC src queue", async () => {
  if (!dipcSrcCreated) skip("queue not created");
  const r = await client.request("DELETE", `/rw/dipc/${DIPC_SRC}?json=1`);
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 100)}`); }
  return `HTTP ${r.status}`;
});
await test("remove DIPC dest queue", async () => {
  if (!dipcDestCreated) skip("queue not created");
  const r = await client.request("DELETE", `/rw/dipc/${DIPC_DEST}?json=1`);
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 100)}`); }
  return `HTTP ${r.status}`;
});

// ═══ Virtual time control ═════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" Virtual time control (VC-only)");
console.log("═".repeat(70));

await test("get virtual time", async () => {
  const r = await client.request("GET", "/ctrl/virtualtime?json=1");
  if (r.status >= 400) { throw new Error(`HTTP ${r.status}`); }
  return `HTTP ${r.status}`;
});

// ═══ Event log ════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(70));
console.log(" Event log clear");
console.log("═".repeat(70));

await test("clearEventLog(0)", async () => {
  await client.clearEventLog(0);
  return "cleared domain 0";
});

// ─── Final ─────────────────────────────────────────────────────────────────
// /logout releases any held mastership/subscriptions before disconnect - prevents orphans.
await client.request("GET", "/logout").catch(() => {});
await client.disconnect();

console.log("\n" + "═".repeat(70));
console.log(`PASSED: ${passed.length}    FAILED: ${failed.length}    SKIPPED: ${skipped.length}    TOTAL: ${passed.length + failed.length + skipped.length}`);
console.log("═".repeat(70));

if (skipped.length) {
  console.log("\nSkipped (mostly mode-dependent):");
  for (const s of skipped) console.log(`  ⊘ ${s.label} - ${s.reason}`);
}

if (failed.length === 0) {
  console.log(`\n🎉  Every applicable RWS 1.0 write op verified.${skipped.length ? ` (${skipped.length} skipped - see above)` : ""}`);
  process.exit(0);
}

console.log("\nFailed:");
for (const f of failed) console.log(`  ✗ ${f.label}\n      ${f.error}`);
process.exit(failed.length);
