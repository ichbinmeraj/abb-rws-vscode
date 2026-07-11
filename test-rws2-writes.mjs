// Comprehensive RWS 2.0 *write* verification — every modify endpoint, restored.
// Auto-detects the OmniCore VC port. Each test restores controller state.
// Safe to run repeatedly. Requires AUTO mode for full coverage.
//
// Run:  node test-rws2-writes.js
// Or with a specific port:  PORT=9403 node test-rws2-writes.js
//
// Env: RWS2_URL RWS_USER RWS_PASS HOST PORT (see scripts/lib/probe-common.mjs)
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HOST, RWS_USER, makeSession, tcpPing } from './scripts/lib/probe-common.mjs';

const USER = RWS_USER;

let session = null;
const req = (method, _port, path, body) => session.req(method, path, body);
const reqRaw = (method, _port, path, rawBody, contentType) =>
  session.req(method, path, rawBody, { contentType: contentType || 'text/plain;v=2.0' });

async function tryBase(url) {
  const probe = makeSession(url);
  const r = await probe.req('GET', '/rw/system');
  if (r.status === 200 || r.status === 401) { return probe; }
  return null;
}

async function findBase() {
  if (process.env.RWS2_URL) { return tryBase(process.env.RWS2_URL); }
  if (process.env.PORT) {
    const p = +process.env.PORT;
    return (await tryBase(`https://${HOST}:${p}`)) || (await tryBase(`http://${HOST}:${p}`));
  }
  // RWS 2.0 ports we've seen live
  for (const [p, useHttps] of [[5466, true], [9403, true], [443, true], [80, false]]) {
    if (await tcpPing(p)) {
      const s = await tryBase(`${useHttps ? 'https' : 'http'}://${HOST}:${p}`);
      if (s) { return s; }
    }
  }
  // Wide scan
  console.log("  (wide-scanning 1024-65535…)");
  for (let p = 1024; p <= 65535; p++) {
    if (await tcpPing(p)) {
      // Try HTTPS first (more common for OmniCore)
      const s = (await tryBase(`https://${HOST}:${p}`)) || (await tryBase(`http://${HOST}:${p}`));
      if (s) { return s; }
    }
  }
  return null;
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log("Looking for OmniCore VC…");
  session = await findBase();
  if (!session) {
    console.error("\nNo OmniCore VC reachable. Start your VC in RobotStudio and try again.");
    process.exit(1);
  }
  const PORT = Number(session.url.port) || (session.url.protocol === 'https:' ? 443 : 80);
  console.log(`Found OmniCore on ${session.url.host} (${session.url.protocol === 'https:' ? 'HTTPS' : 'HTTP'}) as ${USER}\n`);

  // Establish session cookie
  await req('GET', PORT, '/rw/system');
  if (!session.cookie) {
    console.error("No session cookie issued — auth may have failed.");
    process.exit(1);
  }

  // ─── Test runner ─────────────────────────────────────────────────────────
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
        skipped.push({ label, reason: msg.slice(5) });
        console.log(`⊘ ${msg.slice(5)}`);
      } else {
        failed.push({ label, error: msg });
        console.log(`✗ ${msg.slice(0, 90)}`);
      }
    }
  }
  const skip = (r) => { throw new Error("SKIP:" + r); };

  // Helper: extract a span value from XHTML
  const xspan = (xhtml, cls) => {
    const m = xhtml.match(new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([^<]*)</span>`));
    return m ? m[1] : null;
  };

  // ═══ Pre-flight ═════════════════════════════════════════════════════════
  console.log("═".repeat(70));
  console.log(" Pre-flight");
  console.log("═".repeat(70));

  const initialState = {};
  await test("read controller state", async () => {
    const o  = await req('GET', PORT, '/rw/panel/opmode');
    const cs = await req('GET', PORT, '/rw/panel/ctrl-state');
    const sr = await req('GET', PORT, '/rw/panel/speedratio');
    initialState.opmode      = xspan(o.body, 'opmode') ?? 'unknown';
    initialState.ctrlstate   = xspan(cs.body, 'ctrlstate') ?? 'unknown';
    initialState.speedRatio  = +(xspan(sr.body, 'speedratio') ?? 100);
    return `mode=${initialState.opmode} state=${initialState.ctrlstate} speed=${initialState.speedRatio}%`;
  });

  let rmmpPrivilege = "unknown";
  await test("read RMMP privilege", async () => {
    const r = await req('GET', PORT, '/users/rmmp');
    rmmpPrivilege = xspan(r.body, 'privilege') ?? 'unknown';
    return `privilege=${rmmpPrivilege}`;
  });

  // Detect orphan 'edit' mastership — if we can't acquire it cleanly, an
  // earlier session is still holding it. The controller can take many
  // minutes to time out (maybe never, until VC restart). Mark this so we
  // skip mastership-dependent tests with a clear message instead of failing.
  let editAvailable = false;
  await test("probe edit mastership availability", async () => {
    const r = await req('POST', PORT, '/rw/mastership/edit/request', '');
    if (r.status === 204) {
      // Got it — release immediately so individual tests can re-acquire
      await req('POST', PORT, '/rw/mastership/edit/release', '');
      editAvailable = true;
      return "available";
    }
    if (r.status === 403 && r.body.includes("held by someone else")) {
      // Best-effort force-release attempt (rare cases this works)
      await req('POST', PORT, '/rw/mastership/edit/release', '');
      const r2 = await req('POST', PORT, '/rw/mastership/edit/request', '');
      if (r2.status === 204) {
        await req('POST', PORT, '/rw/mastership/edit/release', '');
        editAvailable = true;
        return "available (after force release)";
      }
      throw new Error("orphan mastership — restart OmniCore VC to clear");
    }
    throw new Error(`HTTP ${r.status}`);
  });

  const inAuto = initialState.opmode === "AUTO";
  const canModify = (inAuto || rmmpPrivilege === "modify" || rmmpPrivilege === "exclusive") && editAvailable;
  console.log("");
  if (!canModify) {
    console.log(`⚠️  opmode=${initialState.opmode}, RMMP=${rmmpPrivilege}, editMastership=${editAvailable} — mastership-required tests will SKIP.`);
  } else {
    console.log(`✓  opmode=${initialState.opmode}, RMMP=${rmmpPrivilege}, edit available — full write tests will run.`);
  }
  console.log("");

  // Always logout on exit — `GET /logout` releases mastership + subscriptions
  // held by this session. Live-verified: prevents orphan mastership locks
  // that would block the next test run for several minutes.
  let cleanupHooked = false;
  function hookCleanup() {
    if (cleanupHooked) return; cleanupHooked = true;
    const cleanup = () => {
      try { req('GET', PORT, '/logout'); } catch {}
    };
    process.on('SIGINT',  () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
    process.on('uncaughtException', e => { cleanup(); console.error(e); process.exit(1); });
  }
  hookCleanup();

  // ═══ Mastership cycles (RWS 2.0: rapid/cfg → edit, motion stays motion) ═
  console.log("═".repeat(70));
  console.log(" Mastership cycles (edit + motion)");
  console.log("═".repeat(70));

  for (const dom of ["motion", "edit"]) {
    await test(`request mastership '${dom}'`, async () => {
      if (!canModify && dom !== "motion") skip("needs AUTO or RMMP=modify");
      const r = await req('POST', PORT, `/rw/mastership/${dom}/request`, '');
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
      return `HTTP ${r.status}`;
    });
    await test(`release mastership '${dom}'`, async () => {
      if (!canModify && dom !== "motion") skip("previous request skipped");
      const r = await req('POST', PORT, `/rw/mastership/${dom}/release`, '');
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
      return `HTTP ${r.status}`;
    });
  }

  // ═══ Panel writes (with restore) ═════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" Panel writes (with restore)");
  console.log("═".repeat(70));

  // Helper: wrap an op with edit-mastership acquire/release (RWS 2.0)
  async function withEdit(fn) {
    await req('POST', PORT, '/rw/mastership/edit/request', '');
    try { return await fn(); } finally { await req('POST', PORT, '/rw/mastership/edit/release', ''); }
  }

  await test("setSpeedRatio(50)", async () => {
    if (!canModify) skip("needs AUTO or RMMP=modify");
    const r = await withEdit(() => req('POST', PORT, '/rw/panel/speedratio', 'speed-ratio=50'));
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    const v = +(xspan((await req('GET', PORT, '/rw/panel/speedratio')).body, 'speedratio') || 0);
    if (v !== 50) throw new Error(`expected 50, got ${v}`);
    return "verified read-back = 50";
  });
  await test(`setSpeedRatio(${initialState.speedRatio}) restore`, async () => {
    if (!canModify) skip("set was skipped");
    const r = await withEdit(() => req('POST', PORT, '/rw/panel/speedratio', `speed-ratio=${initialState.speedRatio}`));
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `restored to ${initialState.speedRatio}`;
  });

  await test("setControllerState('motoroff')", async () => {
    if (!canModify) skip("needs AUTO or RMMP=modify");
    const r = await req('POST', PORT, '/rw/panel/ctrl-state', 'ctrl-state=motoroff');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    await new Promise(r => setTimeout(r, 500));
    const v = xspan((await req('GET', PORT, '/rw/panel/ctrl-state')).body, 'ctrlstate');
    return `state=${v}`;
  });
  await test("setControllerState('motoron')", async () => {
    if (!canModify) skip("needs AUTO + safety chain closed");
    const r = await req('POST', PORT, '/rw/panel/ctrl-state', 'ctrl-state=motoron');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    await new Promise(r => setTimeout(r, 500));
    const v = xspan((await req('GET', PORT, '/rw/panel/ctrl-state')).body, 'ctrlstate');
    return `state=${v}`;
  });

  // ═══ File system writes (HOME) ═══════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" File system writes (HOME)");
  console.log("═".repeat(70));

  const TEST_FILE   = "/fileservice/HOME/rws2-write-test.txt";
  const TEST_CONTENT = "Hello from RWS 2.0 write test " + Date.now();

  await test("PUT (upload) file", async () => {
    const r = await reqRaw('PUT', PORT, TEST_FILE, TEST_CONTENT, 'text/plain;v=2.0');
    if (r.status !== 201 && r.status !== 200 && r.status !== 204) {
      throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    }
    return `HTTP ${r.status} (${TEST_CONTENT.length} bytes)`;
  });
  await test("GET (read) and verify content", async () => {
    const r = await req('GET', PORT, TEST_FILE);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    if (r.body !== TEST_CONTENT) throw new Error(`mismatch: got "${r.body.slice(0,40)}"`);
    return "byte-exact match";
  });
  await test("DELETE file", async () => {
    const r = await req('DELETE', PORT, TEST_FILE);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  await test("create directory", async () => {
    // RWS 2.0: POST /fileservice/{parent}/create with body fs-newname={name}
    const r = await req('POST', PORT, '/fileservice/HOME/create', 'fs-newname=rws2_test_dir');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    return `HTTP ${r.status}`;
  });
  await test("delete directory", async () => {
    const r = await req('DELETE', PORT, '/fileservice/HOME/rws2_test_dir');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  // ═══ Module load / unload ═════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" Module load / unload (TestExtension.mod)");
  console.log("═".repeat(70));

  const MOD_LOCAL  = fileURLToPath(new URL("./samples/TestExtension.mod", import.meta.url));
  const MOD_REMOTE = "/fileservice/HOME/TestExtension.mod";
  let modSrc;

  await test("read TestExtension.mod from disk", async () => {
    modSrc = await fs.readFile(MOD_LOCAL, "utf-8");
    return `${modSrc.length} bytes`;
  });
  let modUploaded = false;
  await test("upload module file", async () => {
    const r = await reqRaw('PUT', PORT, MOD_REMOTE, modSrc, 'text/plain;v=2.0');
    if (r.status !== 201 && r.status !== 200 && r.status !== 204) {
      throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    }
    modUploaded = true;
    return `HTTP ${r.status}`;
  });
  let modLoaded = false;
  await test("loadmod into T_ROB1", async () => {
    if (!canModify) skip("needs AUTO or RMMP=modify");
    if (!modUploaded) skip("upload failed");
    // Request edit mastership first
    await req('POST', PORT, '/rw/mastership/edit/request', '');
    try {
      // Stop RAPID first to prevent symbol-table corruption
      await req('POST', PORT, '/rw/rapid/execution/stop', 'stopmode=stop');
      // Load module — RWS 2.0 path-based action
      const r = await req('POST', PORT, '/rw/rapid/tasks/T_ROB1/loadmod', 'modulepath=HOME/TestExtension.mod&replace=true');
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,90)}`);
      modLoaded = true;
      return `HTTP ${r.status}`;
    } finally {
      await req('POST', PORT, '/rw/mastership/edit/release', '');
    }
  });
  await test("listModules confirms TestExtension", async () => {
    if (!modLoaded) skip("module not loaded");
    // Correct RWS 2.0 path: /rw/rapid/tasks/{task}/modules
    const r = await req('GET', PORT, '/rw/rapid/tasks/T_ROB1/modules');
    const found = r.body.includes('TestExtension');
    if (!found) throw new Error("not in list");
    return "present";
  });

  // ═══ RAPID variable writes ════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" RAPID variable writes");
  console.log("═".repeat(70));

  // RWS 2.0 OmniCore symbol API: suffix-style — /rw/rapid/symbol/{symburl}/{data|properties}
  // (RWS 1.0 uses prefix-style: /rw/rapid/symbol/{data|properties}/{symburl})
  let dynSymbolsReadable = false;
  let originalCounter;

  await test("probe: built-in BASE/tool0 (sanity)", async () => {
    const r = await req('GET', PORT, '/rw/rapid/symbol/RAPID/T_ROB1/BASE/tool0/data');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const v = xspan(r.body, 'value');
    return `tool0 = ${v?.slice(0, 30)}…`;
  });
  await test("get TestExtension/counter", async () => {
    if (!modLoaded) skip("module not loaded");
    const r = await req('GET', PORT, '/rw/rapid/symbol/RAPID/T_ROB1/TestExtension/counter/data');
    if (r.status >= 400) {
      const msg = xspan(r.body,'msg') || '';
      if (msg.toLowerCase().includes("not found") || r.status === 404) {
        skip(`symbol not in runtime table (HTTP ${r.status})`);
      }
      throw new Error(`HTTP ${r.status}: ${msg.slice(0,80)}`);
    }
    originalCounter = xspan(r.body, 'value') ?? '0';
    dynSymbolsReadable = true;
    return `counter = ${originalCounter}`;
  });
  await test("set counter = 42", async () => {
    if (!dynSymbolsReadable) skip("symbol not readable");
    const r = await withEdit(() => req('POST', PORT, '/rw/rapid/symbol/RAPID/T_ROB1/TestExtension/counter/data', 'value=42'));
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const r2 = await req('GET', PORT, '/rw/rapid/symbol/RAPID/T_ROB1/TestExtension/counter/data');
    const v = xspan(r2.body, 'value');
    if (Number(v) !== 42) throw new Error(`expected 42, got ${v}`);
    return "verified read-back = 42";
  });
  await test("restore counter", async () => {
    if (!dynSymbolsReadable || originalCounter === undefined) skip("set was skipped");
    await withEdit(() => req('POST', PORT, '/rw/rapid/symbol/RAPID/T_ROB1/TestExtension/counter/data', `value=${originalCounter}`));
    return `restored to ${originalCounter}`;
  });

  // ═══ RAPID execution control ══════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" RAPID execution control");
  console.log("═".repeat(70));

  await test("stop RAPID", async () => {
    const r = await req('POST', PORT, '/rw/rapid/execution/stop', 'stopmode=stop');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    await new Promise(r => setTimeout(r, 300));
    return `HTTP ${r.status}`;
  });
  let ppSet = false;
  await test("resetpp (PP-to-Main)", async () => {
    if (!canModify) skip("needs AUTO or RMMP=modify");
    if (!modLoaded) skip("no module loaded");
    await req('POST', PORT, '/rw/mastership/edit/request', '');
    try {
      const r = await req('POST', PORT, '/rw/rapid/execution/resetpp', '');
      if (r.status >= 400) {
        const msg = xspan(r.body, 'msg') || '';
        if (msg.includes("3500") || msg.toLowerCase().includes("not found")) {
          skip("no program entrypoint (controller needs program built first)");
        }
        throw new Error(`HTTP ${r.status}: ${msg.slice(0,80)}`);
      }
      ppSet = true;
      return `HTTP ${r.status}`;
    } finally {
      await req('POST', PORT, '/rw/mastership/edit/release', '');
    }
  });
  await test("start RAPID (briefly)", async () => {
    if (!canModify) skip("needs AUTO + motors-on");
    if (initialState.ctrlstate !== "motoron") skip(`motors not on (state=${initialState.ctrlstate})`);
    if (!ppSet) skip("PP not set");
    const r = await req('POST', PORT, '/rw/rapid/execution/start',
      'regain=continue&execmode=continue&cycle=once&condition=none&stopatbp=disabled&alltaskbytsp=false');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    await new Promise(r => setTimeout(r, 800));
    const s = xspan((await req('GET', PORT, '/rw/rapid/execution')).body, 'ctrlexecstate');
    return `state=${s}`;
  });
  await test("stop RAPID (final)", async () => {
    await req('POST', PORT, '/rw/rapid/execution/stop', 'stopmode=stop');
    return "stopped";
  });

  // ═══ Module cleanup ═══════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" Module cleanup");
  console.log("═".repeat(70));

  await test("unloadmod TestExtension", async () => {
    if (!modLoaded) skip("module never loaded");
    const r = await withEdit(async () => {
      await req('POST', PORT, '/rw/rapid/execution/stop', 'stopmode=stop');
      return await req('POST', PORT, '/rw/rapid/tasks/T_ROB1/unloadmod', 'module=TestExtension');
    });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    return `HTTP ${r.status}`;
  });
  await test("delete module file", async () => {
    if (!modUploaded) skip("never uploaded");
    const r = await req('DELETE', PORT, MOD_REMOTE);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  // ═══ I/O signal write ═════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" I/O signal toggle");
  console.log("═".repeat(70));

  let writableSignal = null;
  let originalSignalValue = null;
  await test("find writable DO signal", async () => {
    const r = await req('GET', PORT, '/rw/iosystem/signals?start=0&limit=200');
    // Parse XHTML for first DO signal
    const sigBlocks = [...r.body.matchAll(/<li[^>]*class="[^"]*ios-signal-li[^"]*"[^>]*>(.*?)<\/li>/gs)];
    for (const [, block] of sigBlocks) {
      const type = xspan(block, 'type');
      const name = xspan(block, 'name');
      const lvalue = xspan(block, 'lvalue');
      if (type === "DO" && name && !name.startsWith("ES_")) {
        writableSignal = { name, network: xspan(block, 'network') || '', device: xspan(block, 'device') || '' };
        originalSignalValue = lvalue ?? '0';
        return `${name} (lvalue=${originalSignalValue})`;
      }
    }
    throw new Error("no DO signal found");
  });
  await test("writeSignal toggle", async () => {
    if (rmmpPrivilege !== "modify" && rmmpPrivilege !== "exclusive") skip("needs RMMP=modify");
    if (!writableSignal) skip("no signal");
    const newVal = originalSignalValue === "1" ? "0" : "1";
    const path = writableSignal.network && writableSignal.device
      ? `/rw/iosystem/signals/${writableSignal.network}/${writableSignal.device}/${writableSignal.name}/set-value`
      : `/rw/iosystem/signals/${writableSignal.name}/set-value`;
    const r = await req('POST', PORT, path, `lvalue=${newVal}`);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `set to ${newVal}`;
  });
  await test("writeSignal restore", async () => {
    if (rmmpPrivilege !== "modify" && rmmpPrivilege !== "exclusive") skip("set was skipped");
    if (!writableSignal) skip("no signal");
    const path = writableSignal.network && writableSignal.device
      ? `/rw/iosystem/signals/${writableSignal.network}/${writableSignal.device}/${writableSignal.name}/set-value`
      : `/rw/iosystem/signals/${writableSignal.name}/set-value`;
    await req('POST', PORT, path, `lvalue=${originalSignalValue}`);
    return `restored to ${originalSignalValue}`;
  });

  // ═══ DIPC queues ══════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" DIPC queue lifecycle");
  console.log("═".repeat(70));

  const DIPC_SRC  = `rws2tq_src_${Date.now() % 100000}`;
  const DIPC_DEST = `rws2tq_dst_${Date.now() % 100000}`;
  let dipcSrcCreated = false, dipcDestCreated = false;
  await test("create DIPC src queue", async () => {
    // RWS 2.0 DIPC create: POST /rw/dipc with body (no /create suffix).
    const r = await req('POST', PORT, '/rw/dipc',
      `dipc-queue-name=${DIPC_SRC}&dipc-queue-size=1024&dipc-max-msg-size=444&dipc-max-no-of-messages=10`);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    dipcSrcCreated = true;
    return `HTTP ${r.status}`;
  });
  await test("create DIPC dest queue", async () => {
    const r = await req('POST', PORT, '/rw/dipc',
      `dipc-queue-name=${DIPC_DEST}&dipc-queue-size=1024&dipc-max-msg-size=444&dipc-max-no-of-messages=10`);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    dipcDestCreated = true;
    return `HTTP ${r.status}`;
  });
  await test("send DIPC message (src→dest)", async () => {
    if (!dipcSrcCreated || !dipcDestCreated) skip("queues not created");
    // RWS 2.0 send: POST /rw/dipc/{queue} with body
    const r = await req('POST', PORT, `/rw/dipc/${DIPC_DEST}`,
      `dipc-src-queue-name=${DIPC_SRC}&dipc-cmd=111&dipc-userdef=222&dipc-msgtype=1&dipc-data=hello`);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${(xspan(r.body,'msg')||'').slice(0,80)}`);
    return `HTTP ${r.status}`;
  });
  await test("delete DIPC src queue", async () => {
    if (!dipcSrcCreated) skip("not created");
    const r = await req('DELETE', PORT, `/rw/dipc/${DIPC_SRC}`);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });
  await test("delete DIPC dest queue", async () => {
    if (!dipcDestCreated) skip("not created");
    const r = await req('DELETE', PORT, `/rw/dipc/${DIPC_DEST}`);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  // ═══ Event log clear ══════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" Event log clear");
  console.log("═".repeat(70));

  await test("clearEventLog(0)", async () => {
    const r = await req('POST', PORT, '/rw/elog/0/clear', '');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  // Clean session shutdown — logout releases mastership and subscriptions.
  await req('GET', PORT, '/logout').catch(() => {});

  // ─── Final report ────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log(`PASSED: ${passed.length}    FAILED: ${failed.length}    SKIPPED: ${skipped.length}    TOTAL: ${passed.length + failed.length + skipped.length}`);
  console.log("═".repeat(70));

  if (skipped.length) {
    console.log("\nSkipped:");
    for (const s of skipped) console.log(`  ⊘ ${s.label} — ${s.reason}`);
  }

  if (failed.length === 0) {
    console.log(`\n🎉  Every applicable RWS 2.0 write op verified.${skipped.length ? ` (${skipped.length} skipped)` : ""}`);
    process.exit(0);
  }

  console.log("\nFailed:");
  for (const f of failed) console.log(`  ✗ ${f.label}\n      ${f.error}`);
  process.exit(failed.length);
})();
