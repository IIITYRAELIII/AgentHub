"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");

const { AgentHubBridge, webviewHttpMessages } = require("./agent-hub-bridge.js");

function day(date, turnId) {
  return "<details data-work-log-day-section>"
    + `<summary data-work-log-day><strong>${date}</strong></summary>`
    + `<div data-work-log-turn-entry data-work-log-turn-id="${turnId}">`
    + "<details data-work-log-turn-details>"
    + `<summary>Ход ${turnId}</summary>`
    + `<div data-work-log-turn-expanded>Ответ ${turnId}</div>`
    + "</details></div></details>";
}

function memoryJournal({ html = "", days = {}, turns = {}, version = "sqlite-v1" } = {}) {
  return {
    metadata: async () => ({
      updatedAt: "2026-07-30T02:55:14.512Z",
      version,
      revision: 1,
    }),
    payload: async () => ({
      html,
      updatedAt: "2026-07-30T02:55:14.512Z",
      version,
      revision: 1,
    }),
    fragment: async (kind, key) => (kind === "day" ? days : turns)[key] ?? null,
    subscribe(listener) {
      listener({ type: "revision", revision: 1, initial: true });
      return () => {};
    },
    close() {},
  };
}

test("VS Code bridge serves the same lazy journal contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-bridge-"));
  let bridge;
  try {
    const olderDay = day("01.07.2026", "turn-6");
    bridge = new AgentHubBridge({
      journalDatabase: memoryJournal({
        html: [
          day("06.07.2026", "turn-1"),
          day("05.07.2026", "turn-2"),
          day("04.07.2026", "turn-3"),
          day("03.07.2026", "turn-4"),
          day("02.07.2026", "turn-5"),
          '<details data-work-log-day-section data-lazy-day="01.07.2026"></details>',
        ].join("\n"),
        days: { "01.07.2026": olderDay },
      }),
      moduleRoot: path.resolve(__dirname, ".."),
      runtimeRoot: root,
    });
    const initial = await bridge.http({ path: "/api/journal" });
    assert.equal(initial.status, 200);
    const payload = JSON.parse(initial.body);
    assert.match(payload.html, /Ответ turn-1/u);
    assert.doesNotMatch(payload.html, /Ответ turn-6/u);

    const older = await bridge.http({
      path: `/api/journal/day?date=01.07.2026&version=${encodeURIComponent(payload.version)}`,
    });
    assert.equal(older.status, 200);
    assert.match(JSON.parse(older.body).html, /Ход turn-6/u);
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge returns metadata ETag without loading the journal payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-journal-etag-"));
  let payloadCalls = 0;
  const bridge = new AgentHubBridge({
    journalDatabase: {
      metadata: async () => ({ version: "sqlite-v-fast", revision: 7, updatedAt: "now" }),
      payload: async () => {
        payloadCalls += 1;
        throw new Error("payload must remain lazy");
      },
      subscribe: () => () => {},
      close() {},
    },
    moduleRoot: path.resolve(__dirname, ".."),
    runtimeRoot: root,
  });
  bridge.control = async () => ({ configured: false });
  try {
    const response = await bridge.http({
      path: "/api/journal",
      headers: { "if-none-match": '"sqlite-v-fast"' },
    });
    assert.equal(response.status, 304);
    assert.equal(payloadCalls, 0);
  } finally {
    bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge exposes account panel HTML and stored usage sync status when control is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-journal-sync-status-"));
  let bridge;
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "usage-sync-remote.json"), JSON.stringify({
      serverUrl: "https://sync.example.test/agenthub",
      deviceId: "device-vscode",
      enrolledAt: "2026-08-20T13:45:00.000Z",
      lastPullAt: "2026-08-20T13:46:00.000Z",
      lastResult: { added: 2, updated: 1, projected: true, after: 3 },
    }), "utf8");
    await writeFile(path.join(root, "data", "usage-sync-identity.json"), JSON.stringify({
      deviceId: "device-vscode",
      label: "SidorukSV",
      labelConfirmedAt: "2026-08-20T13:44:00.000Z",
    }), "utf8");
    bridge = new AgentHubBridge({
      journalDatabase: memoryJournal({
        html: [
          '<section data-work-log-account-panel>',
          '<span data-work-log-account-panel-caption>Расход по аккаунтам</span>',
          "</section>",
          day("06.07.2026", "turn-1"),
        ].join("\n"),
      }),
      moduleRoot: path.resolve(__dirname, ".."),
      runtimeRoot: root,
    });
    bridge.control = async () => { throw new Error("desktop control unavailable"); };

    const response = await bridge.http({ path: "/api/journal" });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.match(payload.html, /data-work-log-account-panel/u);
    assert.equal(payload.usageSync.configured, true);
    assert.equal(payload.usageSync.deviceId, "device-vscode");
    assert.equal(payload.usageSync.deviceLabel, "SidorukSV");
    assert.equal(payload.usageSync.lastResult.added, 2);
    assert.match(response.headers.ETag, /2026-08-20T13:46:00\.000Z/u);
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge exposes usage sync without the local Web App", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-sync-ipc-"));
  let bridge;
  try {
    const actions = [];
    const status = {
      configured: false,
      serverUrl: "https://sync.example.test",
      deviceId: "device-1",
      deviceLabel: "SidorukSV",
      deviceLabelPromptRequired: false,
    };
    bridge = new AgentHubBridge({
      journalDatabase: memoryJournal({ html: day("06.07.2026", "turn-1") }),
      moduleRoot: path.resolve(__dirname, ".."),
      runtimeRoot: root,
    });
    bridge.control = async (action, params = {}) => {
      actions.push({ action, params });
      if (action === "usage-sync-status") return status;
      return { ok: true, result: { accepted: true, action }, usageSync: status };
    };

    const journal = await bridge.http({ path: "/api/journal" });
    const journalSync = JSON.parse(journal.body).usageSync;
    assert.equal(journalSync.configured, status.configured);
    assert.equal(journalSync.serverUrl, status.serverUrl);
    assert.equal(journalSync.deviceId, status.deviceId);
    assert.equal(journalSync.deviceLabel, status.deviceLabel);
    assert.equal(journalSync.deviceLabelPromptRequired, status.deviceLabelPromptRequired);

    const sync = await bridge.http({
      method: "POST",
      path: "/api/journal/usage-sync/device-label",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ deviceLabel: "Tyrael" }),
    });
    assert.equal(sync.status, 200);
    assert.deepEqual(JSON.parse(sync.body).usageSync, status);
    assert.deepEqual(actions.map(({ action }) => action), [
      "usage-sync-status",
      "usage-sync-device-label",
    ]);
    assert.equal(actions[1].params.deviceLabel, "Tyrael");
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge revalidates journal metadata against the current desktop usage sync status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-sync-etag-"));
  const database = memoryJournal({ html: day("06.07.2026", "turn-1") });
  const readPayload = database.payload;
  let payloadCalls = 0;
  database.payload = async () => {
    payloadCalls += 1;
    return readPayload();
  };
  const bridge = new AgentHubBridge({
    journalDatabase: database,
    moduleRoot: path.resolve(__dirname, ".."),
    runtimeRoot: root,
  });
  const status = { configured: false, deviceLabel: "Desktop", deviceLabelPromptRequired: true };
  bridge.control = async (action) => {
    assert.equal(action, "usage-sync-status");
    return { ...status };
  };
  try {
    const initial = await bridge.http({ path: "/api/journal" });
    assert.equal(initial.status, 200);
    assert.equal(payloadCalls, 1);
    bridge.journalCache = null;
    const unchanged = await bridge.http({
      path: "/api/journal",
      headers: { "if-none-match": initial.headers.ETag },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(payloadCalls, 1);
    status.deviceLabel = "Laptop";
    const changed = await bridge.http({
      path: "/api/journal",
      headers: { "if-none-match": initial.headers.ETag },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.ETag, initial.headers.ETag);
    assert.equal(JSON.parse(changed.body).usageSync.deviceLabel, "Laptop");
    assert.equal(payloadCalls, 2);
  } finally {
    bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge closes its SQLite reader after each journal request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-ephemeral-journal-"));
  const marker = path.join(root, "closed.txt");
  let bridge;
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "journal-database.mjs"), [
      'import { appendFileSync } from "node:fs";',
      "export class JournalDatabase {",
      "  async payload() { return { html: '', updatedAt: '', version: 'v1', revision: 1 }; }",
      `  close() { appendFileSync(${JSON.stringify(marker)}, 'closed\\n', 'utf8'); }`,
      "}",
    ].join("\n"), "utf8");
    bridge = new AgentHubBridge({ moduleRoot: root, runtimeRoot: root });

    await bridge.journal();

    assert.equal(await readFile(marker, "utf8"), "closed\n");
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge stages pasted images in the allowed runtime directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-image-"));
  const previousRoot = process.env.AGENT_HUB_RUNTIME_ROOT;
  try {
    process.env.AGENT_HUB_RUNTIME_ROOT = root;
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
    });
    const body = Buffer.from("test-image");
    const target = await bridge.control("upload-attachment", {
      type: "image/png",
      dataUrl: `data:image/png;base64,${body.toString("base64")}`,
    });
    assert.equal(path.dirname(target), path.join(root, "attachments"));
    assert.deepEqual(await readFile(target), body);
    assert.equal(await bridge.attachmentPath(path.basename(target)), target);
    await assert.rejects(bridge.attachmentPath("../outside.png"), /идентификатор/u);
  } finally {
    if (previousRoot == null) delete process.env.AGENT_HUB_RUNTIME_ROOT;
    else process.env.AGENT_HUB_RUNTIME_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("installed VS Code bridge resolves backend modules from the active runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-runtime-"));
  try {
    const release = "test-release";
    const releaseRoot = path.join(root, "releases", release);
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: release }), "utf8");
    await writeFile(path.join(releaseRoot, "desktop-control.mjs"), [
      "export async function callDesktopControl(action, params, options) {",
      "  return { action, params, options, installedLayout: true };",
      "}",
    ].join("\n"), "utf8");
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
    });
    assert.deepEqual(await bridge.control("snapshot", { sample: 1 }), {
      action: "snapshot",
      params: { sample: 1 },
      options: { runtimeRoot: root, timeoutMs: 10_000 },
      installedLayout: true,
    });
    assert.deepEqual(await bridge.control("submit-bug-report", { text: "bug" }), {
      action: "submit-bug-report",
      params: { text: "bug" },
      options: { runtimeRoot: root, timeoutMs: 180_000 },
      installedLayout: true,
    });
    assert.deepEqual(await bridge.control("rotate-stream", { streamId: "stream-1" }), {
      action: "rotate-stream",
      params: { streamId: "stream-1" },
      options: { runtimeRoot: root, timeoutMs: 180_000 },
      installedLayout: true,
    });
    assert.deepEqual(await bridge.control("browse-directory", { initialPath: "D:\\repo" }), {
      action: "browse-directory",
      params: { initialPath: "D:\\repo" },
      options: { runtimeRoot: root, timeoutMs: 180_000 },
      installedLayout: true,
    });
    assert.deepEqual(await bridge.control("usage-sync"), {
      action: "usage-sync",
      params: {},
      options: { runtimeRoot: root, timeoutMs: 180_000 },
      installedLayout: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code message fallback uses local HTTP with the exact client message id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-message-http-"));
  const calls = [];
  let bridge;
  try {
    await mkdir(path.join(root, "src", "interfaces", "web"), { recursive: true });
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      miniApp: { host: "127.0.0.1", port: 8787 },
    }), "utf8");
    await writeFile(path.join(root, "local-web.secret"), "secret\n", "utf8");
    await writeFile(path.join(root, "src", "interfaces", "web", "local-webview-session.mjs"), [
      "export function createLocalWebviewSession() {",
      "  return { token: 'session-token', expiresAt: Date.now() + 60_000 };",
      "}",
    ].join("\n"), "utf8");
    bridge = new AgentHubBridge({
      moduleRoot: root,
      runtimeRoot: root,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/api/control/ack")) {
          return new Response(JSON.stringify({ ok: true, retired: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          receiptId: body.commandId,
          result: { accepted: true, clientUserMessageId: body.commandId },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await bridge.control("send-message", {
      clientUserMessageId: "client-message-1",
      text: "hello",
    }, { commandId: "client-message-1" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(result, {
      accepted: true,
      clientUserMessageId: "client-message-1",
    });
    assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
      "/api/control", "/api/control/ack",
    ]);
    assert.equal(JSON.parse(calls[0].options.body).commandId, "client-message-1");
    assert.equal(JSON.parse(calls[1].options.body).commandId, "client-message-1");
    assert.equal(calls[0].options.headers.Authorization, "webview session-token");
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code message uses desktop control when the local Web App is disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-message-desktop-"));
  let bridge;
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      components: { miniApp: false, androidApp: false },
      miniApp: { host: "127.0.0.1", port: 8787 },
    }), "utf8");
    bridge = new AgentHubBridge({
      moduleRoot: root,
      runtimeRoot: root,
      fetchImpl: async () => assert.fail("disabled Web App must not receive a message"),
    });
    const calls = [];
    bridge.desktopControl = async (action, params, options) => {
      calls.push({ action, params, options });
      return { accepted: true, clientUserMessageId: options.commandId };
    };

    const result = await bridge.control("send-message", {
      clientUserMessageId: "client-message-core-1",
      text: "hello from core",
    }, { commandId: "client-message-core-1" });

    assert.deepEqual(result, {
      accepted: true,
      clientUserMessageId: "client-message-core-1",
    });
    assert.deepEqual(calls, [{
      action: "send-message",
      params: {
        clientUserMessageId: "client-message-core-1",
        text: "hello from core",
      },
      options: { commandId: "client-message-core-1" },
    }]);
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed VS Code bridge resolves the journal from the decomposed runtime layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-journal-runtime-"));
  let bridge;
  try {
    const release = "decomposed-release";
    const releaseRoot = path.join(root, "releases", release);
    const persistenceRoot = path.join(releaseRoot, "src", "infrastructure", "persistence");
    await mkdir(persistenceRoot, { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: release }), "utf8");
    await writeFile(path.join(persistenceRoot, "journal-database.mjs"), [
      "export class JournalDatabase {",
      "  constructor(file) { this.file = file; this.layout = 'decomposed'; }",
      "  close() {}",
      "}",
    ].join("\n"), "utf8");
    bridge = new AgentHubBridge({ runtimeRoot: root });
    const journal = await bridge.journalStore();
    assert.equal(journal.layout, "decomposed");
    assert.equal(journal.file, path.join(root, "data", "journal.sqlite"));
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge proxies usage sync POST requests with a local webview session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-sync-post-"));
  const calls = [];
  let bridge;
  try {
    await mkdir(path.join(root, "src", "interfaces", "web"), { recursive: true });
    await writeFile(path.join(root, "config.json"), JSON.stringify({ miniApp: { host: "127.0.0.1", port: 8787 } }), "utf8");
    await writeFile(path.join(root, "local-web.secret"), "secret", "utf8");
    await writeFile(path.join(root, "src", "interfaces", "web", "local-webview-session.mjs"), [
      "export function createLocalWebviewSession() {",
      "  return { token: 'session-token', expiresAt: Date.now() + 60000 };",
      "}",
    ].join("\n"), "utf8");
    bridge = new AgentHubBridge({
      moduleRoot: root,
      runtimeRoot: root,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          status: 200,
          ok: true,
          headers: new Map([["content-type", "application/json; charset=utf-8"]]),
          text: async () => `${JSON.stringify({ ok: true })}\n`,
        };
      },
    });

    const cases = [
      {
        path: "/api/journal/usage-sync/enroll",
        body: { serverUrl: "https://sync.example.test", code: "code-1" },
      },
      {
        path: "/api/journal/usage-sync/invite",
        body: {},
      },
      {
        path: "/api/journal/usage-sync/device-label",
        body: { deviceLabel: "SidorukSV" },
      },
    ];
    for (const entry of cases) {
      const result = await bridge.http({
        method: "POST",
        path: entry.path,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(entry.body),
      });
      assert.equal(result.status, 200);
    }

    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), cases.map((entry) => entry.path));
    for (const call of calls) {
      assert.equal(call.url, `http://127.0.0.1:8787${new URL(call.url).pathname}`);
      assert.equal(call.options.method, "POST");
      assert.equal(call.options.headers.get("Authorization"), "webview session-token");
    }
    assert.equal(JSON.parse(calls[0].options.body).code, "code-1");
    assert.equal(JSON.parse(calls[2].options.body).deviceLabel, "SidorukSV");
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge handles usage sync POST through desktop control without local web secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-sync-desktop-"));
  let bridge;
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ miniApp: { host: "127.0.0.1", port: 8787 } }), "utf8");
    await writeFile(path.join(root, "desktop-control.mjs"), [
      "export async function callDesktopControl(action, params) {",
      "  return { ok: true, result: { action, params }, usageSync: { configured: true } };",
      "}",
    ].join("\n"), "utf8");
    bridge = new AgentHubBridge({
      moduleRoot: root,
      runtimeRoot: root,
      fetchImpl: async () => {
        throw new Error("local web proxy must not be used");
      },
    });

    const result = await bridge.http({
      method: "POST",
      path: "/api/journal/usage-sync/device-label",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ deviceLabel: "Andrey" }),
    });

    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.action, "usage-sync-device-label");
    assert.deepEqual(payload.result.params, { deviceLabel: "Andrey" });
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge keeps desktop IPC isolated to its runtime profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-profile-ipc-"));
  const productionRoot = path.join(root, "production");
  const contourRoot = path.join(root, "test-contour");
  const moduleRoot = path.resolve(__dirname, "..");
  const previousRuntimeRoot = process.env.AGENT_HUB_RUNTIME_ROOT;
  const { DesktopControlServer } = await import(pathToFileURL(path.join(moduleRoot, "desktop-control.mjs")).href);
  const productionServer = new DesktopControlServer({
    runtimeRoot: productionRoot,
    protectSecret: async () => {},
    handler: async ({ action }) => ({ action, profile: "production" }),
  });
  const contourServer = new DesktopControlServer({
    runtimeRoot: contourRoot,
    protectSecret: async () => {},
    handler: async ({ action }) => ({ action, profile: "test-contour" }),
  });
  try {
    process.env.AGENT_HUB_RUNTIME_ROOT = productionRoot;
    await productionServer.start();
    await contourServer.start();
    const production = new AgentHubBridge({ moduleRoot });
    const contour = new AgentHubBridge({ moduleRoot, runtimeRoot: contourRoot });

    assert.deepEqual(await production.control("runtime-health"), {
      action: "runtime-health",
      profile: "production",
    });
    assert.deepEqual(await contour.control("runtime-health"), {
      action: "runtime-health",
      profile: "test-contour",
    });
    assert.deepEqual(await contour.http({ method: "GET", path: "/api/attachment-upload" }), {
      action: "attachment-upload",
      profile: "test-contour",
    });
  } finally {
    if (previousRuntimeRoot == null) delete process.env.AGENT_HUB_RUNTIME_ROOT;
    else process.env.AGENT_HUB_RUNTIME_ROOT = previousRuntimeRoot;
    await Promise.all([productionServer.close(), contourServer.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge does not retry failed usage sync through a second desktop alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-sync-no-duplicate-fallback-"));
  let bridge;
  let controlCalls = 0;
  try {
    await mkdir(path.join(root, "src", "interfaces", "web"), { recursive: true });
    await writeFile(path.join(root, "config.json"), JSON.stringify({ miniApp: { host: "127.0.0.1", port: 8787 } }), "utf8");
    await writeFile(path.join(root, "local-web.secret"), "secret", "utf8");
    await writeFile(path.join(root, "src", "interfaces", "web", "local-webview-session.mjs"), [
      "export function createLocalWebviewSession() {",
      "  return { token: 'session-token', expiresAt: Date.now() + 60000 };",
      "}",
    ].join("\n"), "utf8");
    bridge = new AgentHubBridge({
      moduleRoot: root,
      runtimeRoot: root,
      fetchImpl: async () => {
        throw new Error("local web unavailable");
      },
    });
    bridge.control = async () => {
      controlCalls += 1;
      throw new Error("Неизвестная desktop-команда");
    };

    const result = await bridge.http({
      method: "POST",
      path: "/api/journal/usage-sync",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{}",
    });

    assert.equal(result.status, 503);
    assert.match(JSON.parse(result.body).error, /local web unavailable/u);
    assert.equal(controlCalls, 1);
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed VS Code bridge follows the next runtime release without Reload Window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-runtime-switch-"));
  async function writeRelease(name) {
    const releaseRoot = path.join(root, "releases", name);
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(path.join(releaseRoot, "desktop-control.mjs"), [
      "export async function callDesktopControl(action) {",
      `  return { action, release: ${JSON.stringify(name)} };`,
      "}",
    ].join("\n"), "utf8");
    return releaseRoot;
  }
  try {
    const firstRoot = await writeRelease("first");
    const secondRoot = await writeRelease("second");
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "first" }), "utf8");
    const bridge = new AgentHubBridge({ runtimeRoot: root });
    assert.equal(await bridge.runtimeReleaseRoot(), firstRoot);
    assert.deepEqual(await bridge.control("snapshot"), { action: "snapshot", release: "first" });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "second" }), "utf8");
    assert.equal(await bridge.runtimeReleaseRoot(), secondRoot);
    assert.deepEqual(await bridge.control("snapshot"), { action: "snapshot", release: "second" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed VS Code bridge keeps the UI on the running release until cutover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-runtime-cutover-"));
  try {
    for (const release of ["running", "published"]) {
      await mkdir(path.join(root, "releases", release), { recursive: true });
    }
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "published" }), "utf8");
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: 123,
      instanceToken: "running-owner",
      releaseId: "running",
      ready: true,
    }), "utf8");
    let owner = "running-owner";
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
      processIsAlive: () => true,
      instanceOwner: async () => owner,
    });
    assert.equal(await bridge.runtimeReleaseRoot(), path.join(root, "releases", "running"));
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: 456,
      instanceToken: "published-owner",
      releaseId: "published",
      ready: true,
    }), "utf8");
    owner = "published-owner";
    assert.equal(await bridge.runtimeReleaseRoot(), path.join(root, "releases", "published"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed VS Code bridge ignores a reused PID without the canonical instance owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-runtime-reused-pid-"));
  try {
    for (const release of ["stale", "current"]) {
      await mkdir(path.join(root, "releases", release), { recursive: true });
    }
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "current" }), "utf8");
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: 5050,
      instanceToken: "stale-owner",
      releaseId: "stale",
      ready: true,
    }), "utf8");
    await writeFile(path.join(root, "AgentHub.RuntimeHost.exe"), "runtime-host", "utf8");
    const starts = [];
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
      platform: "win32",
      processIsAlive: () => true,
      instanceOwner: async () => "different-owner",
      startRuntimeHost: async (runtimeRoot) => starts.push(runtimeRoot),
    });

    assert.equal(await bridge.runtimeReleaseRoot(), path.join(root, "releases", "current"));
    assert.equal(await bridge.ensureRuntimeStarted(), true);
    assert.deepEqual(starts, [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed VS Code bridge preserves a live old runtime until its token reader is available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-runtime-legacy-reader-"));
  try {
    for (const release of ["running", "current"]) {
      await mkdir(path.join(root, "releases", release), { recursive: true });
    }
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "current" }), "utf8");
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: 6060,
      instanceToken: "legacy-reader-owner",
      releaseId: "running",
    }), "utf8");
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
      processIsAlive: () => true,
      instanceOwner: async () => undefined,
    });

    assert.equal(await bridge.runtimeReleaseRoot(), path.join(root, "releases", "running"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge observes an atomic active-runtime replacement", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-runtime-watch-")));
  const bridge = new AgentHubBridge({ runtimeRoot: root });
  let notifications = 0;
  try {
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "first" }), "utf8");
    const unsubscribe = bridge.subscribeRuntime(() => { notifications += 1; }, { pollMs: 50 });
    await writeFile(path.join(root, "current.next.json"), JSON.stringify({ current: "second" }), "utf8");
    await rename(path.join(root, "current.next.json"), path.join(root, "current.json"));
    for (let attempt = 0; attempt < 20 && notifications === 0; attempt += 1) await delay(10);
    unsubscribe();
    assert.ok(notifications > 0);
  } finally {
    bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge answers the rate-limit summary without the journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-limits-"));
  let bridge;
  try {
    const limitsHtml = [
      '<div data-work-log-rate-limits data-sampled-at="2026-07-30T02:55:14.512Z">'
        + "<span data-rate-limit-caption>Лимиты</span>"
        + "<span data-rate-limit><span data-rate-limit-name>CODEX</span>"
        + "<span data-rate-limit-value>75.0%</span></span></div>",
      day("06.07.2026", "turn-1"),
    ].join("\n");
    bridge = new AgentHubBridge({
      journalDatabase: memoryJournal({ html: limitsHtml }),
      moduleRoot: path.resolve(__dirname, ".."),
      runtimeRoot: root,
    });
    const response = await bridge.http({ path: "/api/rate-limits" });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.match(payload.html, /CODEX/u);
    assert.equal(payload.sampledAt, "2026-07-30T02:55:14.512Z");
    // шапке отдаётся только сводка, дни в ответ не попадают
    assert.doesNotMatch(payload.html, /data-work-log-day-section/u);
  } finally {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge reads runtime health over desktop control without the Web App", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-health-"));
  try {
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
      journalDatabase: {
        payload: async () => assert.fail("health must not read the journal"),
      },
    });
    bridge.control = async (action) => {
      assert.equal(action, "runtime-health");
      return {
        ready: false,
        startup: { operations: [{ id: "web", state: "running" }] },
      };
    };
    const response = await bridge.http({ path: "/health" });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).startup.operations[0].state, "running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge starts Runtime Host and retries health after an autostart race", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-autostart-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({ pid: 4040 }), "utf8");
    await writeFile(path.join(root, "AgentHub.RuntimeHost.exe"), "runtime-host", "utf8");
    const starts = [];
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
      platform: "win32",
      processIsAlive: () => false,
      startRuntimeHost: async (runtimeRoot) => starts.push(runtimeRoot),
      waitImpl: async () => {},
    });
    let attempts = 0;
    bridge.desktopControl = async (action) => {
      assert.equal(action, "runtime-health");
      attempts += 1;
      if (attempts === 1) throw new Error("control pipe is unavailable");
      return { ready: true };
    };

    assert.deepEqual(await bridge.control("runtime-health"), { ready: true });
    assert.deepEqual(starts, [root]);
    assert.equal(attempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge does not relaunch a live Runtime Host on startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-live-runtime-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "release-live" }), "utf8");
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: 5050,
      instanceToken: "live-owner",
      releaseId: "release-live",
    }), "utf8");
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
      platform: "win32",
      processIsAlive: (pid) => pid === 5050,
      instanceOwner: async () => "live-owner",
      startRuntimeHost: async () => assert.fail("live runtime must not be relaunched"),
    });

    assert.equal(await bridge.ensureRuntimeStarted(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge issues a short-lived direct WebView session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-session-"));
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      miniApp: { enabled: true, host: "127.0.0.1", port: 9876 },
    }), "utf8");
    const secret = "w".repeat(43);
    await writeFile(path.join(root, "local-web.secret"), secret, "utf8");
    const bridge = new AgentHubBridge({
      moduleRoot: path.resolve(__dirname, ".."),
      runtimeRoot: root,
    });
    const session = await bridge.webviewSession();
    const { validLocalWebviewSession } = await import(
      "../src/interfaces/web/local-webview-session.mjs"
    );
    assert.equal(session.baseUrl, "http://127.0.0.1:9876");
    assert.notEqual(session.token, secret);
    assert.equal(validLocalWebviewSession(session.token, secret), true);
    assert.ok(session.expiresAt > Date.now());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge does not advertise direct WebView HTTP when its component is disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-disabled-web-"));
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      components: { miniApp: false, androidApp: false },
      miniApp: { host: "127.0.0.1", port: 8787 },
    }), "utf8");
    await writeFile(path.join(root, "local-web.secret"), "w".repeat(43), "utf8");
    const bridge = new AgentHubBridge({
      moduleRoot: path.resolve(__dirname, ".."),
      runtimeRoot: root,
    });

    await assert.rejects(bridge.webviewSession(), /Web App Agent Hub отключён/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge chunks a large journal response for webview IPC", () => {
  const body = JSON.stringify({ html: "Ж".repeat(1_500_000) });
  const messages = webviewHttpMessages("request-1", {
    status: 200,
    headers: { ETag: '"large"' },
    body,
  });
  assert.equal(messages[0].type, "agenthub:http-start");
  assert.equal(messages.at(-1).type, "agenthub:http-result");
  assert.equal(messages.at(-1).chunked, true);
  assert.ok(messages.length > 3);
  const chunks = messages.filter((message) => message.type === "agenthub:http-chunk");
  assert.equal(chunks.length, messages[0].chunkCount);
  assert.equal(chunks.map((message) => message.body).join(""), body);
  assert.ok(chunks.every((message) => message.body.length <= 192 * 1024));
});
