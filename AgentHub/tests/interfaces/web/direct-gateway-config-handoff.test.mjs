import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DirectGatewayController, directGatewayCaddyfile } from "../../../src/interfaces/web/direct-gateway.mjs";
import { handoffDirectGateway } from "../../../src/infrastructure/process/direct-gateway-handoff.mjs";

test("old-owner barrier preserves configuration and retries one controller handoff", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-controller-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { domain: "files.example.test", localUrl: "http://127.0.0.1:8787", publicUrl: "https://files.example.test",
    executable: path.join(root, "caddy.exe"), workingDirectory: root };
  const file = path.join(root, "Caddyfile"), desired = directGatewayCaddyfile(settings), old = desired.replace("?Referrer-Policy", "Referrer-Policy");
  await writeFile(file, old);
  let active = true, launches = 0, handoffs = 0, callback;
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter(); child.exitCode = null; child.stderr = new EventEmitter(); child.stdout = new EventEmitter();
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); };
  const controller = new DirectGatewayController(settings, { probeImpl: async () => true, startupGraceMs: 1,
    handoffImpl: async (_settings, { existingConfig }) => { handoffs++; assert.equal(existingConfig, old);
      if (active) throw new Error("Previous gateway owner is still active"); return { pid: 123, stopped: true }; },
    spawnImpl: () => { launches++; return child; },
    scheduleHealthCheckImpl: fn => { callback = fn; return { unref() {} }; }, cancelHealthCheckImpl() {},
    logger: { log() {}, warn() {}, error() {} } });
  t.after(() => controller.close());
  await assert.rejects(controller.start(), /owner is still active/u);
  assert.equal(launches, 0); assert.equal(await readFile(file, "utf8"), old);
  active = false; await callback();
  assert.equal(handoffs, 2); assert.equal(launches, 1); assert.equal(await readFile(file, "utf8"), desired);
  await controller.start(); assert.equal(launches, 1);
});

const caddy = process.env.AGENT_HUB_CADDY_TEST_EXECUTABLE;
test("close during gateway observation drains startup without handoff or launch", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-close-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let entered, release;
  const observing = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let effects = 0;
  const controller = new DirectGatewayController({ domain: "files.example.test", publicUrl: "https://files.example.test",
    localUrl: "http://127.0.0.1:8787", executable: path.join(root, "caddy.exe"), workingDirectory: root }, {
    probeImpl: async () => { entered(); await held; return true; },
    handoffImpl: async () => { effects++; throw new Error("unexpected handoff"); },
    spawnImpl: () => { effects++; throw new Error("unexpected launch"); },
  });
  const startup = controller.start(); await observing;
  let closed = false; const closing = controller.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await startup; await closing; assert.equal(effects, 0);
});

test("real Caddy orphan handoff preserves upstream privacy and refuses a live parent", {
  skip: process.platform !== "win32" || !caddy,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway real handoff-"));
  const executable = path.join(root, "caddy.exe"), configFile = path.join(root, "Caddyfile");
  await copyFile(caddy, executable);
  const upstream = createServer((req, res) => { if (req.url.startsWith("/transfer")) res.setHeader("Referrer-Policy", "no-referrer"); res.end("synthetic"); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const settings = { domain: `http://127.0.0.1:${port}`, publicUrl: `http://127.0.0.1:${port}`,
    localUrl: `http://127.0.0.1:${upstream.address().port}`, executable, workingDirectory: root };
  const desired = directGatewayCaddyfile(settings), old = desired.replace("?Referrer-Policy", "Referrer-Policy");
  await writeFile(configFile, old);
  const parentFile = path.join(root, "parent.cjs");
  await writeFile(parentFile, `const {spawn}=require('node:child_process');const c=spawn(process.argv[2],['run','--config',process.argv[3],'--adapter','caddyfile'],{detached:true,windowsHide:true,stdio:'ignore'});c.once('spawn',()=>{console.log(c.pid);c.unref();});`);
  const execute = promisify(execFile);
  const parent = await execute(process.execPath, [parentFile, executable, configFile], { windowsHide: true, timeout: 10_000 });
  assert.ok(Number(parent.stdout.trim()) > 0);
  const base = settings.publicUrl;
  const response = async target => {
    const deadline = Date.now() + 5000;
    for (;;) { try { return await fetch(base + target); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 30)); } }
  };
  let controller, owned;
  t.after(async () => {
    if (owned) await controller.close();
    else await handoffDirectGateway(settings, { configFile, existingConfig: await readFile(configFile, "utf8") }).catch(() => {});
    await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  assert.equal((await response("/transfer/")).headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  let launches = 0;
  controller = new DirectGatewayController(settings, { probeImpl: async () => {
    try { return (await fetch(base + "/health")).headers.get("via")?.includes("Caddy") === true; } catch { return false; }
  }, spawnImpl: (...args) => { launches++; return spawn(...args); }, startupGraceMs: 500, logger: { log() {}, warn() {}, error() {} } });
  await controller.start(); owned = true;
  assert.equal(launches, 1);
  assert.equal((await response("/transfer/")).headers.get("referrer-policy"), "no-referrer");
  assert.equal((await response("/ordinary")).headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  const foreign = settings.executable.replace("caddy.exe", "other.exe");
  await assert.rejects(handoffDirectGateway({ ...settings, executable: foreign }, { configFile, existingConfig: desired }));
  // This Caddy is our current child: the default native handoff must refuse it,
  // leaving the listener and effective policy intact.
  await assert.rejects(handoffDirectGateway(settings, { configFile, existingConfig: desired }), /owner is still active/u);
  assert.equal((await response("/transfer/")).headers.get("referrer-policy"), "no-referrer");
});
