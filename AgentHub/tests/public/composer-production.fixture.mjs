import { readFile } from "node:fs/promises";
import { after } from "node:test";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const WEB_APP_ROOT = process.env.AGENT_HUB_TEST_WEB_APP_ROOT
  ? pathToFileURL(`${process.env.AGENT_HUB_TEST_WEB_APP_ROOT.replace(/[\\/]+$/u, "")}/`)
  : new URL("../../assets/web-app/", import.meta.url);
const composerDraftSource = await readFile(
  new URL("messages/composer-draft-reconciliation.js", WEB_APP_ROOT),
  "utf8",
);
const composerDraftContext = vm.createContext({ window: {}, atob, btoa, TextEncoder });
vm.runInContext(composerDraftSource, composerDraftContext);
const ComposerDraftFixture = composerDraftContext.window.AgentHubComposerDraftReconciliation;
const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

function task(streamId) {
  const suffix = streamId.at(-1);
  return {
    streamId,
    streamName: `Stream ${suffix.toUpperCase()}`,
    streamDisplayName: `Stream ${suffix.toUpperCase()}`,
    streamOrdinal: suffix === "a" ? 1 : 2,
    provider: "codex",
    threadId: `thread-${suffix}`,
    threadPosition: 1,
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    title: `Thread ${suffix.toUpperCase()}`,
    displayTitle: `Thread ${suffix.toUpperCase()}`,
    projectName: "Utilities",
    running: false,
    unread: false,
    selected: suffix === "a",
    lastAnswerAt: "2026-09-04T08:00:00.000Z",
  };
}

function snapshot(receipts = []) {
  return {
    version: `fixture-${receipts.length}`,
    tasks: [task("stream-a"), { ...task("stream-b"), selected: false }],
    workspaces: [{
      id: "workspace-1",
      name: "Workspace",
      kind: "project",
      streams: [
        { id: "stream-a", name: "Stream A", displayName: "Stream A", ordinal: 1, threads: [{ id: "thread-a" }] },
        { id: "stream-b", name: "Stream B", displayName: "Stream B", ordinal: 2, threads: [{ id: "thread-b" }] },
      ],
    }],
    boardTasks: [],
    messageReceipts: receipts,
    deferredInputs: [],
    pendingApprovals: [],
    archivedWorkspaces: [],
    boardLayout: { columnOrder: [] },
    selected: {
      streamId: "stream-a",
      provider: "codex",
      threadId: "thread-a",
      model: "gpt-test",
      reasoning: "medium",
      mode: "default",
    },
    settings: {
      provider: "codex",
      model: "gpt-test",
      reasoning: "medium",
      mode: "default",
      approvalMode: "auto",
      models: [],
      modelOptionsByProvider: { codex: [] },
      reasoningOptions: [],
      reasoningOptionsByProvider: { codex: [] },
      modeOptions: [],
      projects: [],
    },
    server: { process: { instanceId: "fixture-process", releaseId: "fixture-release" } },
  };
}

function persistedRecovery({
  taskId = "stream-a",
  requestId = "persisted-request",
  text = "persisted recovery",
  attachments = [],
  taskReferences = [],
  annotations = [],
  fingerprint = null,
} = {}) {
  return {
    taskId,
    text,
    attachments,
    taskReferences,
    annotations,
    recoveryRequestId: requestId,
    recoveryFingerprint: fingerprint ?? ComposerDraftFixture.recoveryFingerprint({
      taskId,
      text,
      attachments,
      taskReferences,
      annotations,
    }),
    recoveryEpoch: 0,
  };
}

// One process per shared fixture module (all consumers with test isolation off).
// Each lease owns separate BrowserContexts; closing a lease never affects peers.
let sharedBrowserPromise = null;

function sharedBrowser() {
  if (!sharedBrowserPromise) {
    const pending = (async () => {
      const { chromium } = await import(process.env.AGENT_HUB_TEST_PLAYWRIGHT_MODULE
        ? pathToFileURL(process.env.AGENT_HUB_TEST_PLAYWRIGHT_MODULE).href : "playwright-core");
      return process.platform === "win32"
        ? chromium.launch({ channel: "msedge", headless: true })
        : chromium.launch({ headless: true });
    })();
    sharedBrowserPromise = pending;
    void pending.catch(() => {
      if (sharedBrowserPromise === pending) sharedBrowserPromise = null;
    });
  }
  return sharedBrowserPromise;
}

after(async () => {
  const pending = sharedBrowserPromise;
  sharedBrowserPromise = null;
  if (pending) await (await pending).close();
});

async function launchBrowser() {
  const browser = await sharedBrowser();
  const contexts = new Set();
  const creating = new Set();
  let closed = false;
  let closing = null;
  const newContext = async (options) => {
    if (closed) throw new Error("Composer browser handle is closed");
    const pending = browser.newContext(options);
    creating.add(pending);
    try {
      const context = await pending;
      contexts.add(context);
      context.once("close", () => contexts.delete(context));
      if (closed) throw new Error("Composer browser handle is closed");
      return context;
    } finally {
      creating.delete(pending);
    }
  };
  return {
    newContext,
    async newPage(options) {
      // Match browser.newPage(): context options and a fresh context per page.
      return (await newContext(options)).newPage();
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          await Promise.allSettled([...creating]);
          const results = await Promise.allSettled([...contexts].map(async (context) => {
            for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" });
            await context.close();
          }));
          const failure = results.find((result) => result.status === "rejected");
          if (failure) throw failure.reason;
        })();
      }
      return closing;
    },
  };
}

async function openFixture(page, {
  persistedDrafts = null,
  fixtureSnapshot = snapshot(),
  fixtureHistory = null,
  expectedTaskId = "stream-a",
  recoveryAuthorityAvailable = true,
  holdRecoveryAuthority = false,
  chunkedUpload = false,
  attachmentStorageOpenFailure = false,
  surface = "vscode",
  directTransport = false,
  webAppRoot = WEB_APP_ROOT,
  assetOverrides = {},
} = {}) {
  const diagnostics = [];
  page.on("pageerror", (error) => diagnostics.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(message.text());
  });
  await page.addInitScript(({
    initialSnapshot, initialHistory, initialDrafts, authorityAvailable, holdAuthority, attachmentOpenFailure,
    transportSurface, direct,
  }) => {
    // Opening the attachment database fails. This covers only the open step:
    // the product treats that rejection as "not durable". The error code is set
    // to QuotaExceededError for readability and is not produced by a real quota;
    // a failure during put or transaction commit is a different path.
    if (attachmentOpenFailure) {
      const nativeOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
      globalThis.indexedDB.open = (name, ...rest) => {
        if (name !== "agent-hub-composer-files-v1") return nativeOpen(name, ...rest);
        const request = {
          result: null,
          error: new DOMException("attachment storage is full", "QuotaExceededError"),
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        queueMicrotask(() => request.onerror?.({ target: request }));
        return request;
      };
    }
    if (!authorityAvailable) {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: null });
    } else if (holdAuthority) {
      const nativeIndexedDB = globalThis.indexedDB;
      const heldSuccesses = [];
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: {
          open(...args) {
            const nativeRequest = nativeIndexedDB.open(...args);
            const request = {
              error: null,
              result: null,
              onblocked: null,
              onerror: null,
              onsuccess: null,
              onupgradeneeded: null,
            };
            nativeRequest.onupgradeneeded = (event) => {
              request.result = nativeRequest.result;
              request.onupgradeneeded?.(event);
            };
            nativeRequest.onblocked = (event) => {
              request.error = nativeRequest.error;
              request.onblocked?.(event);
            };
            nativeRequest.onerror = (event) => {
              request.error = nativeRequest.error;
              request.onerror?.(event);
            };
            nativeRequest.onsuccess = (event) => {
              request.result = nativeRequest.result;
              heldSuccesses.push(() => request.onsuccess?.(event));
            };
            return request;
          },
        },
      });
      window.__releaseComposerRecoveryAuthority = () => {
        for (const release of heldSuccesses.splice(0)) release();
      };
    }
    if (!crypto.subtle) {
      Object.defineProperty(crypto, "subtle", { value: {
        async digest(_algorithm, bytes) {
          const source = new Uint8Array(bytes);
          const digest = new Uint8Array(32);
          source.forEach((byte, index) => { digest[index % digest.length] ^= byte; });
          return digest.buffer;
        },
      } });
    }
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } });
    window.__toastHistory = [];
    new MutationObserver(() => {
      const message = String(document.querySelector("[data-toast]")?.textContent ?? "").trim();
      if (message && window.__toastHistory.at(-1) !== message) window.__toastHistory.push(message);
    }).observe(document, { childList: true, characterData: true, subtree: true });
    if (initialDrafts) localStorage.setItem(
      `agent-hub:composer-drafts:v1:${transportSurface === "vscode" ? "vscode" : "web"}`,
      JSON.stringify(initialDrafts),
    );
    const read = (key, fallback) => {
      try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)); } catch { return fallback; }
    };
    const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    window.__agentHubFixture = {
      snapshot: read("fixture:snapshot", initialSnapshot),
      history: initialHistory,
      mode: localStorage.getItem("fixture:send-mode") || "reject",
      log: read("fixture:bridge-log", []),
      uploadSequence: Number(localStorage.getItem("fixture:upload-sequence")) || 0,
    };
    const respond = ({ id, ok = true, result = {}, error = "" }) => setTimeout(() => (
      window.dispatchEvent(new MessageEvent("message", { data: {
        type: "agenthub:control-result", id, ok, result, error,
      } }))
    ), 0);
    window.__rejectHeldSend = () => {
      const held = window.__agentHubFixture.heldSend;
      if (!held) return false;
      window.__agentHubFixture.heldSend = null;
      respond({ id: held.id, ok: false, error: "Введите сообщение" });
      return true;
    };
    window.__releaseHeldUpload = () => {
      const held = window.__agentHubFixture.heldUpload;
      if (!held) return false;
      window.__agentHubFixture.heldUpload = null;
      respond({
        id: held.id,
        result: `C:\\fixture-upload\\${held.sequence}-${held.name}`,
      });
      return true;
    };
    window.__agentHubIpcRuntimeHealth = async () => ({ ok: true });
    window.__agentHubDirectTransport = {
      ready: () => direct,
      available: async () => true,
      warmup() {},
    };
    window.__fixtureBridge = {
      postMessage(message) {
        const fixture = window.__agentHubFixture;
        const recorded = structuredClone(message);
        const dataUrl = String(recorded?.params?.dataUrl ?? "");
        if (dataUrl.length > 1_000_000) {
          recorded.params.dataUrlLength = dataUrl.length;
          recorded.params.dataUrl = `[bounded-test-log:${dataUrl.length}]`;
        }
        fixture.log.push(recorded);
        write("fixture:bridge-log", fixture.log);
        let ok = true;
        let result = {};
        let error = "";
        if (message.action === "snapshot") result = fixture.snapshot;
        else if (message.action === "open-task" || message.action === "task-history") {
          const streamId = message.params.streamId
            || fixture.snapshot.tasks.find((entry) => entry.provider === message.params.provider
              && entry.threadId === message.params.threadId)?.streamId
            || null;
          const fixtureHistoryMatches = fixture.history?.provider === message.params.provider
            && fixture.history?.threadId === message.params.threadId
            && fixture.history?.streamId === streamId;
          const history = fixtureHistoryMatches ? fixture.history : {
            provider: message.params.provider,
            threadId: message.params.threadId,
            streamId,
            items: [], start: 0, end: 0, total: 0, messageTotal: 0,
            nextBefore: null, version: "empty",
          };
          result = message.action === "task-history"
            ? history
            : { history, snapshot: fixture.snapshot };
        } else if (message.action === "upload-attachment") {
          fixture.uploadSequence += 1;
          localStorage.setItem("fixture:upload-sequence", String(fixture.uploadSequence));
          if (localStorage.getItem("fixture:upload-mode") === "hold") {
            fixture.heldUpload = {
              id: message.id,
              name: message.params.name,
              sequence: fixture.uploadSequence,
            };
            return;
          }
          result = `C:\\fixture-upload\\${fixture.uploadSequence}-${message.params.name}`;
        } else if (message.action === "send-message") {
          fixture.mode = localStorage.getItem("fixture:send-mode") || fixture.mode;
          if (fixture.mode === "hold-reject") {
            fixture.heldSend = { id: message.id };
            return;
          } else if (fixture.mode === "reject") {
            ok = false;
            error = "Введите сообщение";
          } else if (fixture.mode === "disconnect") {
            ok = false;
            error = "Agent Hub в VS Code не ответил вовремя";
          } else {
            result = {
              accepted: true,
              provider: message.params.provider,
              threadId: message.params.threadId,
              streamId: message.params.streamId,
              clientUserMessageId: message.params.clientUserMessageId,
              itemId: `item-${message.params.clientUserMessageId}`,
              message: "Сообщение принято",
            };
          }
        }
        respond({ id: message.id, ok, result, error });
      },
    };
    if (transportSurface === "vscode") window.__agentHubVscode = window.__fixtureBridge;
  }, {
    initialSnapshot: fixtureSnapshot,
    initialHistory: fixtureHistory,
    initialDrafts: persistedDrafts,
    authorityAvailable: recoveryAuthorityAvailable,
    holdAuthority: holdRecoveryAuthority,
    attachmentOpenFailure: attachmentStorageOpenFailure,
    transportSurface: surface, direct: directTransport,
  });
  const uploads = new Map();
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/api/attachment-upload") {
      if (!chunkedUpload) { await route.fulfill({ status: 404, body: "{}" }); return; }
      const protocol = "agent-hub-attachment-upload-v1";
      const policy = { protocol, chunkBytes: 1024 * 1024, maxBytes: 128 * 1024 * 1024,
        maxTotalBytes: 256 * 1024 * 1024, expiresInMs: 30 * 60_000, supportsBeginRecovery: true };
      const method = route.request().method();
      const id = requestUrl.searchParams.get("id");
      let value = policy;
      let status = 200;
      if (method === "POST" && !id) {
        const mode = await page.evaluate(() => localStorage.getItem("fixture:upload-mode"));
        if (mode === "drop-begin-once") {
          await page.evaluate(() => localStorage.removeItem("fixture:upload-mode"));
          await route.abort("failed");
          return;
        }
        const metadata = route.request().postDataJSON();
        if (!uploads.has(metadata.uploadId)) uploads.set(metadata.uploadId, { ...metadata, protocol, status: "uploading", received: [] });
        value = uploads.get(metadata.uploadId);
      } else if (id) {
        value = uploads.get(id);
        if (!value) { status = 404; value = { error: "Upload missing", state: "absent" }; }
        else if (method === "PUT") {
          const mode = await page.evaluate(() => localStorage.getItem("fixture:upload-mode"));
          if (mode === "fail-once") {
            await page.evaluate(() => localStorage.removeItem("fixture:upload-mode"));
            await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Fixture disconnected"}' });
            return;
          }
          const index = Number(requestUrl.searchParams.get("index"));
          value.received = value.received.filter((part) => part.index !== index);
          value.received.push({ index, size: route.request().postDataBuffer().length,
            sha256: route.request().headers()["x-agent-hub-chunk-sha256"] });
        } else if (method === "POST") {
          value.status = "ready"; value.path = `C:\\fixture-upload\\${id}-${value.name}`; value.sha256 = "a".repeat(64);
        } else if (method === "DELETE") value.status = "cancelled";
      }
      await page.evaluate((entry) => {
        const log = JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]");
        log.push(entry); localStorage.setItem("fixture:upload-log", JSON.stringify(log));
      }, { method, id, index: requestUrl.searchParams.get("index"), value,
        size: method === "PUT" ? route.request().postDataBuffer().length : 0 });
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value),
        headers: { "Server-Timing": "auth;dur=2.5, body;dur=3.5, owner;dur=4.5" } });
      return;
    }
    if (requestUrl.pathname === "/api/attachment") {
      const name = decodeURIComponent(route.request().headers()["x-agent-hub-file-name"]);
      const size = route.request().postDataBuffer().length;
      const sequence = await page.evaluate(async ({ name, size }) => {
        const fixture = window.__agentHubFixture;
        fixture.uploadSequence += 1;
        fixture.log.push({ action: "upload-attachment", transport: "http", params: { name, size } });
        localStorage.setItem("fixture:bridge-log", JSON.stringify(fixture.log));
        localStorage.setItem("fixture:upload-sequence", String(fixture.uploadSequence));
        if (localStorage.getItem("fixture:upload-mode") === "hold") await new Promise((resolve) => {
          fixture.heldUpload = { name };
          window.__releaseHeldUpload = () => { fixture.heldUpload = null; resolve(); };
        });
        return fixture.uploadSequence;
      }, { name, size });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: `C:\\fixture-upload\\${sequence}-${name}` }) });
      return;
    }
    if (requestUrl.pathname === "/api/snapshot") {
      const value = await page.evaluate(() => window.__agentHubFixture.snapshot);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
      return;
    }
    if (requestUrl.pathname === "/api/control") {
      const message = route.request().postDataJSON();
      const outcome = await page.evaluate((request) => new Promise((resolve) => {
        const listener = (event) => {
          if (event.data?.type !== "agenthub:control-result" || event.data.id !== request.commandId) return;
          window.removeEventListener("message", listener); resolve(event.data);
        };
        window.addEventListener("message", listener);
        window.__fixtureBridge.postMessage({ ...request, id: request.commandId, transport: "http" });
      }), message);
      await route.fulfill({ status: outcome.ok === false ? 400 : 200, contentType: "application/json", body: JSON.stringify(outcome) });
      return;
    }
    if (requestUrl.pathname === "/events") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" });
      return;
    }
    if (requestUrl.pathname.startsWith("/api/")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (requestUrl.pathname === "/health") {
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = assetOverrides["index.html"] ?? await readFile(new URL("index.html", webAppRoot), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace("<!-- agent-hub-theme-catalog -->", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script>`);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      return;
    }
    if (requestUrl.pathname === "/work-log.css") {
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
      return;
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    try {
      await route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: assetOverrides[relative] ?? await readFile(new URL(relative, webAppRoot)),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  if (expectedTaskId) {
    try {
      await page.waitForFunction((taskId) => document.querySelector(`[data-stream-task-id='${taskId}']`), expectedTaskId, {
        timeout: 5_000,
      });
      await page.waitForFunction(() => (
        window.AgentHub?.composerRecoveryDiagnostics?.().restored === true
      ));
    } catch {
      const log = await page.evaluate(() => localStorage.getItem("fixture:bridge-log"));
      const taskIds = await page.locator("[data-stream-task-id]").evaluateAll((entries) => entries.map((entry) => entry.dataset.streamTaskId));
      throw new Error(`production fixture did not start: ${diagnostics.join(" | ")} | tasks=${JSON.stringify(taskIds)} | log=${log}`);
    }
  }
  return diagnostics;
}

async function bridgeCalls(page, action) {
  return page.evaluate((requestedAction) => {
    const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
    return log.filter((entry) => entry.action === requestedAction);
  }, action);
}

async function applyFixtureSnapshot(page, nextSnapshot) {
  const before = (await bridgeCalls(page, "snapshot")).length;
  await page.evaluate((value) => {
    window.__agentHubFixture.snapshot = value;
    localStorage.setItem("fixture:snapshot", JSON.stringify(value));
    document.querySelector("[data-provider-connection-retry]")?.click();
  }, nextSnapshot);
  await page.waitForFunction(({ expected, version }) => {
    const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
    return log.filter((entry) => entry.action === "snapshot").length > expected
      && window.__agentHubFixture.snapshot.version === version;
  }, { expected: before, version: nextSnapshot.version });
}

async function submit(page, { text = "", attachment = null } = {}) {
  if (text) await page.locator("[data-composer-input]").fill(text);
  if (attachment) {
    await page.locator("[data-file-input]").setInputFiles(attachment);
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length > 0);
  }
  await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
}

async function setSelectedTask(page, taskId) {
  await page.evaluate((id) => window.AgentHub.selectTask(id), taskId);
  await page.waitForFunction((id) => (
    document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === id
  ), taskId);
}

async function lateAcceptedReceipt(page, requestId, streamId = "stream-a") {
  const before = (await bridgeCalls(page, "snapshot")).length;
  await page.evaluate(({ receiptId, receiptStreamId, nextSnapshot }) => {
    const fixture = window.__agentHubFixture;
    const suffix = receiptStreamId.at(-1);
    fixture.snapshot = {
      ...nextSnapshot,
      messageReceipts: [{
        provider: "codex",
        threadId: `thread-${suffix}`,
        streamId: receiptStreamId,
        clientUserMessageId: receiptId,
        accepted: true,
        conflictKind: "message-intake",
        clientProjectionIntent: "conversation",
      }],
      version: `fixture-late-${receiptId}`,
    };
    localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
    document.querySelector("[data-provider-connection-retry]")?.click();
  }, { receiptId: requestId, receiptStreamId: streamId, nextSnapshot: snapshot() });
  await page.waitForFunction((minimum) => {
    const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
    return log.filter((entry) => entry.action === "snapshot").length > minimum;
  }, before);
}

async function refreshWithReceipt(page, receipt) {
  const before = (await bridgeCalls(page, "snapshot")).length;
  await page.evaluate(({ nextReceipt, nextSnapshot }) => {
    const fixture = window.__agentHubFixture;
    fixture.snapshot = {
      ...nextSnapshot,
      messageReceipts: [nextReceipt],
      version: `fixture-receipt-${(fixture.receiptSequence = (fixture.receiptSequence ?? 0) + 1)}`,
    };
    localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
    document.querySelector("[data-provider-connection-retry]")?.click();
  }, { nextReceipt: receipt, nextSnapshot: snapshot() });
  await page.waitForFunction((minimum) => {
    const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
    return log.filter((entry) => entry.action === "snapshot").length > minimum;
  }, before);
}

async function selectMessageText(page, text = "Alpha source text") {
  await page.evaluate((sourceText) => {
    window.AgentHub.setMessages("stream-a", [{
      id: "source-message",
      itemId: "source-item",
      turnId: "source-turn",
      role: "assistant",
      provider: "codex",
      threadId: "thread-a",
      text: sourceText,
      time: "2026-09-04T08:00:00.000Z",
    }]);
    const body = [...document.querySelectorAll(".msg-body")]
      .find((candidate) => candidate.textContent.includes(sourceText));
    const node = body?.firstChild;
    if (!body || !node) throw new Error("source message was not rendered");
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, text);
}

async function attachTaskReference(page, {
  taskId = "board-task-1",
  taskNumber = "HUB-TEST",
  title = "Referenced Task",
} = {}) {
  await page.locator("[data-chat-pane]").evaluate((target, reference) => {
    const transfer = new DataTransfer();
    transfer.setData(window.AgentHubTaskReferences.MIME, JSON.stringify({
      kind: "task",
      taskId: reference.taskId,
      taskNumber: reference.taskNumber,
      title: reference.title,
      workflowStatus: "in_progress",
      workspaceId: "workspace-1",
      intent: "context",
    }));
    target.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { taskId, taskNumber, title });
  await page.waitForFunction(() => (
    document.querySelectorAll("[data-attachments] .attachment-task-reference").length > 0
  ));
}

export {
  task,
  snapshot,
  persistedRecovery,
  launchBrowser,
  openFixture,
  bridgeCalls,
  applyFixtureSnapshot,
  submit,
  setSelectedTask,
  lateAcceptedReceipt,
  refreshWithReceipt,
  selectMessageText,
  attachTaskReference
};
