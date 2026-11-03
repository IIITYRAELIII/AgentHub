import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { chromium } from "playwright";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { SharedSqliteRecoveryCoordinator } from "../../src/infrastructure/persistence/shared-sqlite-recovery.mjs";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";
import { createLocalWebviewSession } from "../../src/interfaces/web/local-webview-session.mjs";
import { importCompositionWithPorts } from "../helpers/composition-ports.fixture.mjs";
import * as startupTrace from "../../src/composition/command-trace-composition.mjs";

test("actual infrastructure serves the existing web shell while its database copy is held", async (t) => {
  const oldRelease = process.env.AGENT_HUB_RELEASE_ID;
  process.env.AGENT_HUB_RELEASE_ID = "isolated-hub297-startup-web";
  t.after(() => {
    if (oldRelease === undefined) delete process.env.AGENT_HUB_RELEASE_ID;
    else process.env.AGENT_HUB_RELEASE_ID = oldRelease;
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-startup-web-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const databaseFile = path.join(root, "journal.sqlite");
  const sourceRoot = new URL("../../", import.meta.url);
  const releaseRoot = path.join(root, "releases", "fixture");
  await fs.mkdir(path.join(releaseRoot, "assets"), { recursive: true });
  await fs.cp(new URL("assets/web-app/", sourceRoot), path.join(releaseRoot, "assets", "web-app"), { recursive: true });
  await fs.copyFile(new URL("work-log.css", sourceRoot), path.join(releaseRoot, "work-log.css"));
  await fs.writeFile(path.join(root, "current.json"), JSON.stringify({ current: "fixture" }));
  const db = new DatabaseSync(databaseFile);
  db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY); INSERT INTO sample VALUES(1)");
  db.close();
  const original = await fs.readFile(databaseFile);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const copyStarted = new Promise(resolve => { entered = resolve; });
  const sentinel = new Error("owned post-inspection boundary");
  let listener, address;
  let boundAtMs;
  let browser;
  const logs = [];
  class ObservedServer extends MiniAppServer {
    async start() {
      const result = await super.start();
      listener = this; address = result;
      boundAtMs = performance.now();
      return result;
    }
  }
  class HeldInspection extends SharedSqliteRecoveryCoordinator {
    constructor(options) {
      super({ ...options, fileSystem: { ...fs, copyFile: async (source, destination) => {
        if (source === databaseFile) { entered(); await gate; }
        return fs.copyFile(source, destination);
      } } });
    }
  }
  const { createHubInfrastructure } = await importCompositionWithPorts(
    new URL("../../src/composition/infrastructure-composition.mjs", import.meta.url), {
      "../infrastructure/persistence/rotating-log.mjs": { installRotatingConsole() {} },
      "./command-trace-composition.mjs": { ...startupTrace,
        measureStartupBeforeTrace: (stage, operation, options) => startupTrace.measureStartupBeforeTrace(
          stage, operation, { ...options, logger: { info: (_prefix, body) => logs.push(JSON.parse(body)) } }),
      },
      "../infrastructure/diagnostics/sentry-diagnostics.mjs": { sentryDiagnostics: {
        configure() {}, captureException() {},
      } },
      "../infrastructure/persistence/shared-sqlite-recovery.mjs": { SharedSqliteRecoveryCoordinator: HeldInspection },
      "../interfaces/web/mini-app-server.mjs": { MiniAppServer: ObservedServer },
      "../infrastructure/persistence/trusted-device-store.mjs": { TrustedDeviceStore: class {
        async load() { throw sentinel; }
      } },
    });
  const initializationStarted = performance.now();
  const initialization = createHubInfrastructure({
    config: { dataDir: root, projectRoot: root, diagnostics: { sentry: {} },
      components: {}, miniApp: { enabled: true, host: "127.0.0.1", port: 0,
        quickTunnel: { enabled: false } }, projects: [] },
    agentHubRoot: path.join(root, "source"), runtimeCommandRoot: root,
    journalDatabaseFile: databaseFile, instanceLockFile: path.join(root, "instance.lock"),
    localWebSecret: "s".repeat(43),
  });
  // Join any eventual failure immediately, including a causal parent negative.
  const settled = initialization.then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([copyStarted, settled.then(result => { throw result.error ?? new Error("copy never entered"); })]);
    assert.ok(address?.url, "the startup web listener must already be bound before SQLite inspection");
    const first = address.url;
    const healthStarted = performance.now();
    const health = await (await fetch(first + "health")).json();
    const healthResponseMs = performance.now() - healthStarted;
    assert.equal(health.ready, false);
    assert.equal(health.startup.operations.find(x => x.id === "database").state, "running");
    assert.equal((await fetch(first)).status, 200);
    assert.equal((await fetch(first + "app.js")).status, 200);
    assert.equal((await fetch(first + "api/snapshot")).status, 503);
    assert.equal((await fetch(first + "api/control", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "{}" })).status, 503);
    assert.equal((await fetch(first + "events")).status, 503);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue() : route.abort());
    const navigationStarted = performance.now();
    await page.goto(first, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const screen = document.querySelector(".hub-startup-screen");
      return screen && getComputedStyle(screen).display !== "none"
        && screen.textContent.includes("Проверка базы данных");
    });
    const startupScreenMs = performance.now() - navigationStarted;
    assert.equal((await (await fetch(first + "health")).json()).ready, false);
    await browser.close(); browser = null;
    release();
    assert.equal((await settled).error, sentinel);
    t.diagnostic(JSON.stringify({
      operationSpanId: logs.find(x => x.stage === "sqlite-recovery").operationSpanId,
      listenerFromInitializationMs: boundAtMs - initializationStarted,
      healthResponseMs, startupScreenFromNavigationMs: startupScreenMs,
      readyWhileCopyHeld: false,
      query: logs.find(x => x.phase === "inspection-query" && x.outcome === "succeeded"),
      qualification: "isolated actual composition; copy deliberately held; not production timing",
    }));
    assert.equal(listener.address(), null, "failed startup joins its listener before releasing the instance");
    await assert.rejects(fetch(first + "health"));
    assert.deepEqual(await fs.readFile(databaseFile), original);
  } finally {
    await browser?.close();
    release();
    await settled;
    await listener?.close();
  }
});

test("the same listener activates guarded runtime routes only at ordinary start", async (t) => {
  const health = createRuntimeHealth();
  health.begin({ operations: [{ id: "database", label: "Database" }] });
  health.startOperation("database");
  const secret = "x".repeat(43);
  let calls = 0, subscriptions = 0;
  const journal = { subscribe() { subscriptions += 1; return () => {}; } };
  const server = new MiniAppServer({ host: "127.0.0.1", port: 0, startupOnly: true,
    health, localAccessSecret: secret, telegramRuntime: false });
  t.after(() => server.close());
  const address = await server.start();
  const url = address.url + "api/control";
  const headers = { "Content-Type": "application/json",
    Authorization: `webview ${createLocalWebviewSession(secret).token}` };
  const command = { action: "fixture-command", params: {}, commandId: "one-original" };
  const send = () => fetch(url, { method: "POST", headers, body: JSON.stringify(command) });
  assert.equal((await send()).status, 503);
  assert.throws(() => server.configureRuntime({ host: "0.0.0.0", port: 0, journalDatabase: journal }),
    /listener identity changed/);
  server.configureRuntime({ host: "127.0.0.1", port: 0, health, journalDatabase: journal,
    localAccessSecret: secret, telegramRuntime: false,
    controlHandler: async () => { calls += 1; return { ok: true }; } });
  assert.equal((await send()).status, 503);
  assert.equal(calls, 0);
  assert.equal(subscriptions, 0);
  assert.deepEqual(await server.start(), address);
  assert.equal(subscriptions, 1);
  assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command) })).status, 401);
  assert.equal((await send()).status, 200);
  assert.equal(calls, 1);
  assert.equal((await (await fetch(address.url + "health")).json()).ready, false);
  assert.throws(() => server.configureRuntime({ journalDatabase: journal }), /already configured/);
});

test("a failed listener drain joins its sibling and cannot release the instance owner", async () => {
  const databaseFailure = Object.assign(new Error("inspection unavailable"), { code: "EIO" });
  const closeFailure = new Error("listener drain unknown");
  let released = false;
  const closed = [];
  const { createHubInfrastructure } = await importCompositionWithPorts(
    new URL("../../src/composition/infrastructure-composition.mjs", import.meta.url), {
      "node:fs/promises": { access: async () => {}, mkdir: async () => {}, readFile: fs.readFile },
      "../infrastructure/persistence/rotating-log.mjs": { installRotatingConsole() {} },
      "../infrastructure/diagnostics/sentry-diagnostics.mjs": { sentryDiagnostics: {
        configure() {}, captureException() {},
      } },
      "./command-trace-composition.mjs": { ...startupTrace,
        measureStartupBeforeTrace: (stage, operation, options) => startupTrace.measureStartupBeforeTrace(
          stage, operation, { ...options, logger: { info() {} } }),
      },
      "../infrastructure/process/instance-lock.mjs": { SingleInstanceGuard: class {
        instanceToken = "fixture";
        async acquire() {}
        async release() { released = true; }
      } },
      "../infrastructure/persistence/shared-sqlite-recovery.mjs": { SharedSqliteRecoveryCoordinator: class {
        async prepare() { throw databaseFailure; }
      } },
      "../interfaces/web/mini-app-server.mjs": { MiniAppServer: class {
        constructor(options) { this.public = options.requireTelegramAuth === true; }
        async start() {}
        async close() { closed.push(this.public); if (!this.public) throw closeFailure; }
      } },
    });
  await assert.rejects(createHubInfrastructure({
    config: { dataDir: "owned-fixture", projectRoot: "owned-fixture", diagnostics: { sentry: {} },
      components: {}, miniApp: { enabled: true, host: "127.0.0.1", port: 0,
        quickTunnel: { enabled: true, publicPort: 0 } }, projects: [] },
    agentHubRoot: "owned-fixture", runtimeCommandRoot: "owned-fixture",
    journalDatabaseFile: "owned-fixture/journal.sqlite", instanceLockFile: "owned-fixture/instance.lock",
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, databaseFailure);
    assert.deepEqual(error.errors, [databaseFailure, closeFailure]);
    return true;
  });
  assert.deepEqual(closed.sort(), [false, true]);
  assert.equal(released, false);
});
