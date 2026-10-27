import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DirectGatewayController } from "../../../src/interfaces/web/direct-gateway.mjs";
import { MiniAppLifecycleService } from "../../../src/interfaces/web/mini-app-lifecycle-service.mjs";

function fixture({ gateway = false, worker = false, tunnel = false, sharedBot = false } = {}) {
  const events = [];
  class Controller {
    constructor(options, diagnostics = {}) { this.options = options; this.diagnostics = diagnostics; }
    async start() { events.push("controller:start"); return "https://public.example/"; }
    async close() { events.push("controller:close"); }
  }
  class Publisher extends Controller {
    async start() { events.push("publisher:start"); await this.options.onPublished("https://worker.example/"); }
  }
  class QuickTunnel extends Controller {
    async start() {
      events.push("controller:start");
      await this.options.onUrl("https://public.example/");
      return "https://public.example/";
    }
  }
  const localServer = {
    async start() { events.push("local:start"); return { url: "http://127.0.0.1:1/" }; },
    async close() { events.push("local:close"); },
  };
  const publicServer = {
    async start() { events.push("public:start"); return { url: "http://127.0.0.1:2/" }; },
    async close() { events.push("public:close"); },
  };
  const trustedDeviceStore = {
    async use(store) {
      assert.equal(typeof store.resolveSession, "function");
      events.push("registry:worker");
      return { migrated: 2 };
    },
  };
  const service = new MiniAppLifecycleService({
    config: {
      dataDir: "data",
      allowedUserIds: new Set([42]),
      components: { miniApp: true },
      miniApp: {
        worker: { enabled: worker, menuText: "Hub" },
        quickTunnel: { enabled: tunnel, menuText: "Hub", publicPort: 2 },
      },
    },
    localServer,
    publicServer,
    runtimeCommandRoot: "runtime",
    journalDatabaseFile: "journal.sqlite",
    telegram: async (method, body) => events.push(
      `${method}:${body.chat_id ?? "default"}:${body.url ?? ""}`,
    ),
    menuButtonRequests: ({ chatIds, url }) => [...chatIds].map((chatId) => ({ chat_id: chatId, url })),
    loadGatewaySettings: async () => ({ enabled: gateway, publicUrl: "https://gateway.example/" }),
    DirectGatewayControllerClass: Controller,
    MiniAppPublisherClass: Publisher,
    QuickTunnelControllerClass: QuickTunnel,
    controlHandler: async () => {},
    controlReconciler: async () => {},
    forgetControl: async () => {},
    trustedDeviceStore,
    sharedDashboardBotClient: sharedBot ? {
      async start() { events.push("shared-bot:start"); },
      async close() { events.push("shared-bot:close"); },
    } : null,
    logger: { log() {}, warn() {} },
  });
  return { service, events };
}

test("Mini App lifecycle starts the local surface without optional transports", async () => {
  const { service, events } = fixture();
  assert.deepEqual(await service.start(), { url: "http://127.0.0.1:1/" });
  assert.deepEqual(events, ["local:start"]);
});

test("gateway diagnostics use the existing trace port without a second runtime owner", async () => {
  const { service } = fixture({ gateway: true }), spans = [];
  service.recordCommandTrace = span => spans.push(span);
  await service.start();
  service.directGateway.diagnostics.recordCommandTrace({ commandId: "synthetic-upload", outcome: "failed" });
  assert.deepEqual(spans, [{ commandId: "synthetic-upload", outcome: "failed" }]);
  await service.closeDirectGateway();
});

test("Mini App lifecycle exposes the local startup screen before the shared bot", async () => {
  const { service, events } = fixture({ sharedBot: true });
  assert.deepEqual(await service.start(), { url: "http://127.0.0.1:1/" });
  assert.deepEqual(events, ["local:start", "shared-bot:start"]);
});

test("shared Dashboard bot starts without the Web App and closes independently", async () => {
  const { service, events } = fixture({ sharedBot: true });
  service.localServer = null;
  assert.equal(await service.start(), null);
  assert.deepEqual(events, ["shared-bot:start"]);
  await service.closeSharedDashboardBot();
  assert.deepEqual(events, ["shared-bot:start", "shared-bot:close"]);
});

test("Mini App lifecycle owns gateway, worker and tunnel transports", async () => {
  const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
  assert.deepEqual(await service.start(), {
    url: "http://127.0.0.1:1/",
    publicUrl: "https://public.example/",
  });
  assert.deepEqual(events.filter((event) => event.startsWith("setChatMenuButton")), [
    "setChatMenuButton:42:https://public.example/",
  ]);
  assert.ok(events.includes("publisher:start"));
  assert.ok(events.includes("registry:worker"));
  assert.ok(events.includes("public:start"));
  await service.closePublisher();
  await service.closeDirectGateway();
  await service.closeQuickTunnel();
  await service.closePublicServer();
  await service.closeLocalServer();
  assert.equal(events.filter((event) => event.endsWith(":close")).length, 5);
});

test("Mini App lifecycle publishes the Worker menu without a direct gateway", async () => {
  const { service, events } = fixture({ worker: true });
  await service.start();
  assert.deepEqual(events.filter((event) => event.startsWith("setChatMenuButton")), [
    "setChatMenuButton:42:https://worker.example/",
  ]);
});

test("Mini App lifecycle exposes local UI before optional transports finish", async () => {
  const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
  assert.deepEqual(await service.start({ waitForTransports: false }), {
    url: "http://127.0.0.1:1/",
  });
  assert.equal(events[0], "local:start");
  assert.deepEqual(await service.waitForTransports(), {
    url: "http://127.0.0.1:1/",
    publicUrl: "https://public.example/",
  });
  assert.ok(events.includes("publisher:start"));
  assert.ok(events.includes("public:start"));
});

test("closing local UI prevents later optional transport stages", async () => {
  let releaseGateway;
  const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
  service.DirectGatewayControllerClass = class {
    async start() {
      events.push("gateway:waiting");
      return new Promise((resolve) => { releaseGateway = resolve; });
    }
    async close() { events.push("gateway:close"); }
  };
  await service.start({ waitForTransports: false });
  await new Promise((resolve) => setImmediate(resolve));
  await service.closeLocalServer();
  releaseGateway("https://gateway.example/");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("publisher:start"), false);
  assert.equal(events.includes("public:start"), false);
});

const pendingGatewayError = () => Object.assign(new Error("Synthetic gateway handoff pending"), {
  code: "DIRECT_GATEWAY_CONFIG_HANDOFF_REQUIRED",
});

test("pending gateway starts the configured Worker and fallback menu without completing transport startup", async t => {
  const area = await mkdtemp(path.join(os.tmpdir(), "hub-gateway-startup-"));
  const configFile = path.join(area, "Caddyfile"), preserved = "preserved old gateway config\n";
  await writeFile(configFile, preserved);
  const { service, events } = fixture({ gateway: true, worker: true, sharedBot: true });
  let spawned = 0, scheduled = 0;
  service.loadGatewaySettings = async () => ({ enabled: true, domain: "gateway.example", publicUrl: "https://gateway.example/",
    localUrl: "http://127.0.0.1:1", executable: path.join(area, "caddy.exe"), workingDirectory: area });
  service.DirectGatewayControllerClass = class extends DirectGatewayController {
    constructor(settings, diagnostics) {
      super(settings, { ...diagnostics, logger: { warn() {}, error() {}, log() {} },
        probeImpl: async () => true, handoffImpl: async () => { throw pendingGatewayError(); },
        spawnImpl: () => { spawned += 1; assert.fail("Pending gateway cannot launch another listener"); },
        scheduleHealthCheckImpl: () => { scheduled += 1; return { unref() {} }; }, cancelHealthCheckImpl() {} });
    }
  };
  t.after(async () => { await service.closeDirectGateway(); await service.closePublisher(); await rm(area, { recursive: true }); });
  assert.deepEqual(await service.start({ waitForTransports: false }), { url: "http://127.0.0.1:1/" });
  let original;
  await assert.rejects(service.waitForTransports(), error => {
    original = error; return error.code === "DIRECT_GATEWAY_CONFIG_HANDOFF_REQUIRED";
  });
  assert.equal(events.filter(event => event === "shared-bot:start").length, 1);
  assert.equal(events.filter(event => event === "publisher:start").length, 1);
  assert.equal(events.filter(event => event === "registry:worker").length, 1);
  assert.deepEqual(events.filter(event => event.startsWith("setChatMenuButton")), ["setChatMenuButton:42:https://worker.example/"]);
  assert.equal(spawned, 0);
  assert.equal(scheduled, 1);
  assert.equal(await readFile(configFile, "utf8"), preserved);
  await service.start({ waitForTransports: false });
  await assert.rejects(service.waitForTransports(), error => error === original);
  assert.equal(events.filter(event => event === "publisher:start").length, 1);
});

test("pending gateway does not swallow other gateway failures", async () => {
  for (const failure of [new Error("Synthetic native failure"), Object.assign(new Error("Foreign refusal"), { code: "OTHER_GATEWAY_REFUSAL" })]) {
    const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
    service.DirectGatewayControllerClass = class { async start() { throw failure; } };
    await assert.rejects(service.start(), error => error === failure);
    assert.equal(events.includes("publisher:start"), false);
    assert.equal(events.includes("public:start"), false);
    assert.deepEqual(events.filter(event => event.startsWith("setChatMenuButton")), []);
  }
});

test("pending gateway keeps independent tunnel behavior but startup remains rejected", async () => {
  const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
  const failure = pendingGatewayError();
  service.DirectGatewayControllerClass = class { async start() { throw failure; } };
  await assert.rejects(service.start(), error => error === failure);
  assert.equal(events.includes("publisher:start"), true);
  assert.equal(events.includes("public:start"), true);
  assert.deepEqual(events.filter(event => event.startsWith("setChatMenuButton")), [
    "setChatMenuButton:42:https://worker.example/", "setChatMenuButton:42:https://public.example/",
  ]);
});

test("pending gateway cannot publish a late Worker menu or start a tunnel after close", async () => {
  const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
  let finishWorker;
  service.DirectGatewayControllerClass = class { async start() { throw pendingGatewayError(); } };
  service.MiniAppPublisherClass = class {
    constructor(options) { this.options = options; }
    async start() {
      events.push("publisher:waiting");
      await new Promise(resolve => { finishWorker = resolve; });
      await this.options.onPublished("https://worker.example/");
    }
    async close() { events.push("publisher:close"); }
  };
  await service.start({ waitForTransports: false });
  const startup = service.waitForTransports();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishWorker, "function");
  await service.closePublisher();
  finishWorker();
  await startup;
  assert.deepEqual(events.filter(event => event.startsWith("setChatMenuButton")), []);
  assert.equal(events.includes("public:start"), false);
});

test("pending gateway preserves fresh Worker publication after a full close and reopen", async () => {
  const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
  service.DirectGatewayControllerClass = class { async start() { throw pendingGatewayError(); } async close() {} };
  await assert.rejects(service.start(), { code: "DIRECT_GATEWAY_CONFIG_HANDOFF_REQUIRED" });
  const oldWorker = service.publisher;
  await service.closePublisher();
  await service.closeQuickTunnel();
  await service.closeDirectGateway();
  await service.closePublicServer();
  await service.closeLocalServer();
  await assert.rejects(service.start(), { code: "DIRECT_GATEWAY_CONFIG_HANDOFF_REQUIRED" });
  assert.notEqual(service.publisher, oldWorker);
  assert.deepEqual(events.filter(event => event.startsWith("setChatMenuButton")), [
    "setChatMenuButton:42:https://worker.example/", "setChatMenuButton:42:https://public.example/",
    "setChatMenuButton:42:https://worker.example/", "setChatMenuButton:42:https://public.example/",
  ]);
  const beforeLate = events.length;
  await oldWorker.options.onPublished("https://stale-worker.example/");
  assert.equal(events.length, beforeLate);
  await service.closePublisher();
  await service.closeQuickTunnel();
});
