import assert from "node:assert/strict";
import test from "node:test";
import { MiniAppLifecycleService } from "../../../src/interfaces/web/mini-app-lifecycle-service.mjs";

function fixture({ gateway = false, worker = false, tunnel = false, sharedBot = false } = {}) {
  const events = [];
  class Controller {
    constructor(options) { this.options = options; }
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
