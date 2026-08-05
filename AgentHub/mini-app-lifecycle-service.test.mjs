import assert from "node:assert/strict";
import test from "node:test";
import { MiniAppLifecycleService } from "./src/interfaces/web/mini-app-lifecycle-service.mjs";

function fixture({ gateway = false, worker = false, tunnel = false } = {}) {
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
    telegram: async (method, body) => events.push(`${method}:${body.chat_id ?? "default"}`),
    menuButtonRequests: ({ chatIds }) => [...chatIds].map((chatId) => ({ chat_id: chatId })),
    loadGatewaySettings: async () => ({ enabled: gateway, publicUrl: "https://gateway.example/" }),
    DirectGatewayControllerClass: Controller,
    MiniAppPublisherClass: Publisher,
    QuickTunnelControllerClass: QuickTunnel,
    controlHandler: async () => {},
    controlReconciler: async () => {},
    forgetControl: async () => {},
    logger: { log() {}, warn() {} },
  });
  return { service, events };
}

test("Mini App lifecycle starts the local surface without optional transports", async () => {
  const { service, events } = fixture();
  assert.deepEqual(await service.start(), { url: "http://127.0.0.1:1/" });
  assert.deepEqual(events, ["local:start"]);
});

test("Mini App lifecycle owns gateway, worker and tunnel transports", async () => {
  const { service, events } = fixture({ gateway: true, worker: true, tunnel: true });
  assert.deepEqual(await service.start(), {
    url: "http://127.0.0.1:1/",
    publicUrl: "https://public.example/",
  });
  assert.equal(events.filter((event) => event.startsWith("setChatMenuButton")).length, 3);
  assert.ok(events.includes("publisher:start"));
  assert.ok(events.includes("public:start"));
  await service.closePublisher();
  await service.closeDirectGateway();
  await service.closeQuickTunnel();
  await service.closePublicServer();
  await service.closeLocalServer();
  assert.equal(events.filter((event) => event.endsWith(":close")).length, 5);
});
