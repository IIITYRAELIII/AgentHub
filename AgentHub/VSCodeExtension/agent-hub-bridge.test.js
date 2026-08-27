"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

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
      options: { timeoutMs: 10_000 },
      installedLayout: true,
    });
    assert.deepEqual(await bridge.control("send-message", {
      clientUserMessageId: "client-message-1",
      text: "hello",
    }), {
      action: "send-message",
      params: { clientUserMessageId: "client-message-1", text: "hello" },
      options: { timeoutMs: 10_000, commandId: "client-message-1" },
      installedLayout: true,
    });
    assert.deepEqual(await bridge.control("submit-bug-report", { text: "bug" }), {
      action: "submit-bug-report",
      params: { text: "bug" },
      options: { timeoutMs: 180_000 },
      installedLayout: true,
    });
    assert.deepEqual(await bridge.control("rotate-stream", { streamId: "stream-1" }), {
      action: "rotate-stream",
      params: { streamId: "stream-1" },
      options: { timeoutMs: 180_000 },
      installedLayout: true,
    });
  } finally {
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
      releaseId: "running",
      ready: true,
    }), "utf8");
    const bridge = new AgentHubBridge({ runtimeRoot: root, processIsAlive: () => true });
    assert.equal(await bridge.runtimeReleaseRoot(), path.join(root, "releases", "running"));
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: 456,
      releaseId: "published",
      ready: true,
    }), "utf8");
    assert.equal(await bridge.runtimeReleaseRoot(), path.join(root, "releases", "published"));
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

test("VS Code bridge proxies runtime health without reading the journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-health-"));
  let requestedUrl = "";
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      miniApp: { host: "127.0.0.1", port: 9876 },
    }), "utf8");
    const bridge = new AgentHubBridge({
      runtimeRoot: root,
      journalDatabase: {
        payload: async () => assert.fail("health must not read the journal"),
      },
      fetchImpl: async (url) => {
        requestedUrl = url;
        return new Response(JSON.stringify({
          ready: false,
          startup: { operations: [{ id: "web", state: "running" }] },
        }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
      },
    });
    const response = await bridge.http({ path: "/health" });
    assert.equal(requestedUrl, "http://127.0.0.1:9876/health");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).startup.operations[0].state, "running");
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
