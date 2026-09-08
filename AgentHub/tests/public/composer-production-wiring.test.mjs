import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
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

async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

async function openFixture(page, {
  persistedDrafts = null,
  fixtureSnapshot = snapshot(),
  expectedTaskId = "stream-a",
  recoveryAuthorityAvailable = true,
  holdRecoveryAuthority = false,
} = {}) {
  const diagnostics = [];
  page.on("pageerror", (error) => diagnostics.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(message.text());
  });
  await page.addInitScript(({
    initialSnapshot, initialDrafts, authorityAvailable, holdAuthority,
  }) => {
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
    window.__toastHistory = [];
    new MutationObserver(() => {
      const message = String(document.querySelector("[data-toast]")?.textContent ?? "").trim();
      if (message && window.__toastHistory.at(-1) !== message) window.__toastHistory.push(message);
    }).observe(document, { childList: true, characterData: true, subtree: true });
    if (initialDrafts) localStorage.setItem(
      "agent-hub:composer-drafts:v1:vscode",
      JSON.stringify(initialDrafts),
    );
    const read = (key, fallback) => {
      try { return JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback)); } catch { return fallback; }
    };
    const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    window.__agentHubFixture = {
      snapshot: read("fixture:snapshot", initialSnapshot),
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
      ready: () => false,
      available: async () => false,
      warmup() {},
    };
    window.__agentHubVscode = {
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
            || (String(message.params.threadId ?? "").endsWith("-b") ? "stream-b" : "stream-a");
          const history = {
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
  }, {
    initialSnapshot: fixtureSnapshot,
    initialDrafts: persistedDrafts,
    authorityAvailable: recoveryAuthorityAvailable,
    holdAuthority: holdRecoveryAuthority,
  });
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") {
      await route.abort();
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
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
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
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
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
      throw new Error(`production fixture did not start: ${diagnostics.join(" | ")} | log=${log}`);
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
  if (attachment) await page.locator("[data-file-input]").setInputFiles(attachment);
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

test("production startup restores recovery before applying accepted snapshot evidence", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const requestId = "startup-accepted-recovery";
  const acceptedSnapshot = snapshot([{
    provider: "codex",
    threadId: "thread-a",
    clientUserMessageId: requestId,
    accepted: true,
    deferred: true,
    conflictKind: "message-intake",
    clientProjectionIntent: "queue",
  }]);
  try {
    const diagnostics = await openFixture(page, {
      persistedDrafts: [persistedRecovery({
        requestId,
        text: "stale accepted payload",
      })],
      fixtureSnapshot: acceptedSnapshot,
      expectedTaskId: "",
      holdRecoveryAuthority: true,
    });
    await page.waitForFunction(() => typeof window.__releaseComposerRecoveryAuthority === "function");
    assert.equal((await bridgeCalls(page, "snapshot")).length, 0);

    await page.evaluate(() => window.__releaseComposerRecoveryAuthority());
    await page.waitForFunction(() => (
      window.AgentHub?.composerRecoveryDiagnostics?.().restored === true
      && document.querySelector("[data-stream-task-id='stream-a']")
    ));
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
    const persistedAfterAcceptance = await page.evaluate(() => (
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode")
    ));
    assert.equal(persistedAfterAcceptance, null);

    await page.locator("[data-composer-input]").fill("new input after startup reconciliation");
    await refreshWithReceipt(page, acceptedSnapshot.messageReceipts[0]);
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value
        === "new input after startup reconciliation"
    ));
    assert.deepEqual(diagnostics, []);
  } finally {
    await browser.close();
  }
});

test("production index/app/hub-client preserves exact mixed-attachment retry across reload", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openFixture(page);
    await submit(page, {
      text: "Сохрани exact retry",
      attachment: { name: "screen.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) },
    });
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "Сохрани exact retry"
      && document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1
    ));
    const firstSend = (await bridgeCalls(page, "send-message")).at(-1);
    const firstUpload = (await bridgeCalls(page, "upload-attachment")).at(-1);
    assert.ok(firstSend?.params?.clientUserMessageId);
    assert.equal(firstUpload.params.dataUrl, "data:image/png;base64,AQID");
    const persisted = await page.evaluate(() => JSON.parse(
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]",
    ));
    assert.equal(persisted[0].recoveryRequestId, firstSend.params.clientUserMessageId);
    assert.equal(persisted[0].attachments[0].dataUrl, "data:image/png;base64,AQID");
    assert.equal(JSON.stringify(persisted).includes("fixture-upload"), false);

    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "Сохрани exact retry"
      && document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1
    ));
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const sends = await bridgeCalls(page, "send-message");
    const uploads = await bridgeCalls(page, "upload-attachment");
    assert.equal(sends[1].params.clientUserMessageId, sends[0].params.clientUserMessageId);
    assert.equal(uploads.length, 2);
    assert.notEqual(sends[1].params.attachments[0], sends[0].params.attachments[0]);
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally {
    await browser.close();
  }
});

test("production reload invalidates retry identity after a real user edit", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "Сохрани ID до edit" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Сохрани ID до edit");
    const firstRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Сохрани ID до edit");
    await page.locator("[data-composer-input]").fill("временная правка");
    await page.locator("[data-composer-input]").fill("Сохрани ID до edit");
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const secondRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    assert.notEqual(secondRequestId, firstRequestId);
  } finally {
    await browser.close();
  }
});

test("production wiring keeps attachment-only recovery and Task-scoped late evidence", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, {
      attachment: { name: "only.png", mimeType: "image/png", buffer: Buffer.from([4, 5, 6]) },
    });
    await page.waitForFunction(() => document.querySelectorAll(
      "[data-attachments] [data-attachment-index]",
    ).length === 1);
    const attachmentRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelectorAll(
      "[data-attachments] [data-attachment-index]",
    ).length === 1);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");

    await page.evaluate(() => {
      localStorage.removeItem("agent-hub:composer-drafts:v1:vscode");
      localStorage.setItem("fixture:bridge-log", "[]");
    });
    await page.reload({ waitUntil: "load" });
    await submit(page, { text: "одинаково" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "одинаково");
    const firstRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await setSelectedTask(page, "stream-b");
    await submit(page, { text: "одинаково" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "одинаково");
    const secondRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    assert.notEqual(firstRequestId, secondRequestId);

    await page.evaluate(({ receipt, nextSnapshot }) => {
      const fixture = window.__agentHubFixture;
      fixture.snapshot = { ...nextSnapshot, messageReceipts: [receipt], version: "fixture-late" };
      localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
      document.querySelector("[data-provider-connection-retry]")?.click();
    }, {
      receipt: {
        provider: "codex", threadId: "thread-a", streamId: "stream-a",
        clientUserMessageId: firstRequestId, accepted: true,
        conflictKind: "message-intake", clientProjectionIntent: "conversation",
      },
      nextSnapshot: snapshot(),
    });
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "snapshot").length >= 2;
    });
    await setSelectedTask(page, "stream-b");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "одинаково");
    await setSelectedTask(page, "stream-a");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.ok(attachmentRequestId);
  } finally {
    await browser.close();
  }
});

test("production Task-reference add and remove invalidate old recovery before late acceptance", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const addPage = await browser.newPage();
    await openFixture(addPage);
    await submit(addPage, { text: "reference add survives" });
    await addPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "reference add survives");
    const addRequestId = (await bridgeCalls(addPage, "send-message")).at(-1).params.clientUserMessageId;
    await attachTaskReference(addPage);
    await lateAcceptedReceipt(addPage, addRequestId);
    assert.equal(await addPage.locator("[data-composer-input]").inputValue(), "reference add survives");
    assert.equal(await addPage.locator("[data-attachments] .attachment-task-reference").count(), 1);
    await addPage.close();

    const removePage = await browser.newPage();
    await openFixture(removePage);
    await removePage.locator("[data-composer-input]").fill("reference remove survives");
    await attachTaskReference(removePage, { taskId: "board-task-2", taskNumber: "HUB-REMOVE" });
    await removePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await removePage.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "reference remove survives"
      && document.querySelectorAll("[data-task-reference-index]").length === 1
    ));
    const removeRequestId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.locator("[data-task-reference-index]").click();
    await lateAcceptedReceipt(removePage, removeRequestId);
    assert.equal(await removePage.locator("[data-composer-input]").inputValue(), "reference remove survives");
    assert.equal(await removePage.locator("[data-attachments] .attachment-task-reference").count(), 0);
    await removePage.close();
  } finally {
    await browser.close();
  }
});

test("production attachment add and remove invalidate old recovery before late acceptance", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const addPage = await browser.newPage();
    await openFixture(addPage);
    await submit(addPage, { text: "attachment add survives" });
    await addPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "attachment add survives");
    const addRequestId = (await bridgeCalls(addPage, "send-message")).at(-1).params.clientUserMessageId;
    await addPage.evaluate(() => {
      const readAsDataUrl = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function holdFileRead(file) {
        window.__heldFileRead = { reader: this, file };
      };
      window.__releaseFileRead = () => {
        const held = window.__heldFileRead;
        FileReader.prototype.readAsDataURL = readAsDataUrl;
        readAsDataUrl.call(held.reader, held.file);
      };
    });
    await addPage.locator("[data-file-input]").setInputFiles({
      name: "new.png", mimeType: "image/png", buffer: Buffer.from([11, 12, 13]),
    });
    await addPage.waitForFunction(() => Boolean(window.__heldFileRead));
    await setSelectedTask(addPage, "stream-b");
    await lateAcceptedReceipt(addPage, addRequestId);
    await setSelectedTask(addPage, "stream-b");
    await addPage.evaluate(() => window.__releaseFileRead());
    await addPage.waitForTimeout(50);
    assert.equal(await addPage.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await addPage.locator("[data-attachment-index]").count(), 0);
    await setSelectedTask(addPage, "stream-a");
    await addPage.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    assert.equal(await addPage.locator("[data-composer-input]").inputValue(), "attachment add survives");
    assert.equal(await addPage.locator("[data-attachment-index]").count(), 1);
    await addPage.close();

    const removePage = await browser.newPage();
    await openFixture(removePage);
    await submit(removePage, {
      text: "attachment remove survives",
      attachment: { name: "old.png", mimeType: "image/png", buffer: Buffer.from([21, 22, 23]) },
    });
    await removePage.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "attachment remove survives"
      && document.querySelectorAll("[data-attachment-index]").length === 1
    ));
    const removeRequestId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.locator("[data-attachment-index]").click();
    await lateAcceptedReceipt(removePage, removeRequestId);
    assert.equal(await removePage.locator("[data-composer-input]").inputValue(), "attachment remove survives");
    assert.equal(await removePage.locator("[data-attachment-index]").count(), 0);
    await removePage.close();
  } finally {
    await browser.close();
  }
});

test("production annotation edit and remove invalidate old recovery before late acceptance", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const editPage = await browser.newPage();
    await openFixture(editPage, {
      persistedDrafts: [{
        taskId: "stream-a",
        text: "annotation edit survives",
        taskReferences: [],
        annotations: [{ quote: "Alpha", annotation: "old comment" }],
      }],
    });
    await editPage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    await editPage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await editPage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    const editRequestId = (await bridgeCalls(editPage, "send-message")).at(-1).params.clientUserMessageId;
    await editPage.locator("[data-annotation-comment-index='0']").fill("new comment");
    await lateAcceptedReceipt(editPage, editRequestId);
    assert.equal(await editPage.locator("[data-composer-input]").inputValue(), "annotation edit survives");
    assert.equal(await editPage.locator("[data-annotation-comment-index='0']").inputValue(), "new comment");
    await editPage.close();

    const removePage = await browser.newPage();
    await openFixture(removePage, {
      persistedDrafts: [{
        taskId: "stream-a",
        text: "annotation remove survives",
        taskReferences: [],
        annotations: [{ quote: "Bravo", annotation: "remove me" }],
      }],
    });
    await removePage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    await removePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await removePage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    const removeRequestId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.locator("[data-annotation-index='0']").click();
    await lateAcceptedReceipt(removePage, removeRequestId);
    assert.equal(await removePage.locator("[data-composer-input]").inputValue(), "annotation remove survives");
    assert.equal(await removePage.locator("[data-annotations] .annotation").count(), 0);
    await removePage.close();
  } finally {
    await browser.close();
  }
});

test("production edit revisions fence a late rejected send and programmatic composer edits", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const rejectPage = await browser.newPage();
    await openFixture(rejectPage);
    await rejectPage.evaluate(() => localStorage.setItem("fixture:send-mode", "hold-reject"));
    await submit(rejectPage, { text: "old held payload" });
    await rejectPage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "send-message");
    });
    const oldRequestId = (await bridgeCalls(rejectPage, "send-message")).at(-1).params.clientUserMessageId;
    await rejectPage.locator("[data-composer-input]").fill("new user composition");
    await rejectPage.evaluate(() => window.__rejectHeldSend());
    await rejectPage.waitForFunction(() => !document.querySelector("[data-composer-send]")?.disabled);
    assert.equal(await rejectPage.locator("[data-composer-input]").inputValue(), "new user composition");
    await rejectPage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await rejectPage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await rejectPage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const newRequestId = (await bridgeCalls(rejectPage, "send-message")).at(-1).params.clientUserMessageId;
    assert.notEqual(newRequestId, oldRequestId);
    await rejectPage.close();

    const editPage = await browser.newPage();
    await openFixture(editPage);
    await submit(editPage, { text: "recovered before edit button" });
    await editPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "recovered before edit button");
    const acceptedRequestId = (await bridgeCalls(editPage, "send-message")).at(-1).params.clientUserMessageId;
    await editPage.evaluate(() => window.AgentHub.setMessages("stream-a", [{
      id: "user-edit-source", itemId: "user-edit-source", role: "user",
      text: "programmatic replacement", time: "2026-09-04T08:00:02.000Z",
    }]));
    await editPage.locator("[data-message-edit]").evaluate((button) => button.click());
    await lateAcceptedReceipt(editPage, acceptedRequestId);
    assert.equal(await editPage.locator("[data-composer-input]").inputValue(), "programmatic replacement");
    await editPage.close();

    const slashPage = await browser.newPage();
    await openFixture(slashPage);
    await submit(slashPage, {
      attachment: { name: "slash.png", mimeType: "image/png", buffer: Buffer.from([31, 32, 33]) },
    });
    await slashPage.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    const slashRequestId = (await bridgeCalls(slashPage, "send-message")).at(-1).params.clientUserMessageId;
    await slashPage.locator("[data-action='slash-menu']").click();
    await lateAcceptedReceipt(slashPage, slashRequestId);
    assert.equal(await slashPage.locator("[data-composer-input]").inputValue(), "/");
    assert.equal(await slashPage.locator("[data-attachment-index]").count(), 1);
    await slashPage.close();
  } finally {
    await browser.close();
  }
});

test("production over-limit recovery stays exact in memory and blocks managed reload", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    const text = "x".repeat(100_001);
    await submit(page, { text });
    await page.waitForFunction((length) => (
      document.querySelector("[data-composer-input]")?.value.length === length
    ), text.length);
    assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    ))), true);
    const firstRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    const persisted = await page.evaluate(() => JSON.parse(
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]",
    ));
    assert.equal(persisted[0].text.length, 100_000);
    assert.equal("recoveryRequestId" in persisted[0], false);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal((await page.locator("[data-composer-input]").inputValue()).length, 100_001);

    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const secondRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    assert.equal(secondRequestId, firstRequestId);
  } finally {
    await browser.close();
  }
});

test("production attachment recovery beyond durable byte quota blocks managed reload", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, {
      text: "large attachment",
      attachment: {
        name: "large.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(3_000_100, 65),
      },
    });
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "large attachment"
      && document.querySelectorAll("[data-attachment-index]").length === 1
    ));
    assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    ))), true);
    const persisted = await page.evaluate(() => JSON.parse(
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]",
    ));
    assert.equal("recoveryRequestId" in persisted[0], false);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal(await page.locator("[data-attachment-index]").count(), 1);
  } finally {
    await browser.close();
  }
});

test("production quota failure is explicit and leaves no partial reload identity", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      const originalRemove = Storage.prototype.removeItem;
      window.__restoreDraftStorage = () => {
        Storage.prototype.setItem = original;
        Storage.prototype.removeItem = originalRemove;
      };
      Storage.prototype.setItem = function setItem(key, value) {
        if (String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
      Storage.prototype.removeItem = function removeItem(key) {
        if (String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("privacy", "SecurityError");
        }
        return originalRemove.call(this, key);
      };
    });
    await submit(page, {
      attachment: { name: "quota.png", mimeType: "image/png", buffer: Buffer.from([7, 8, 9]) },
    });
    await page.waitForFunction(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    )));
    const persisted = await page.evaluate(() => {
      window.__restoreDraftStorage();
      return localStorage.getItem("agent-hub:composer-drafts:v1:vscode");
    });
    assert.equal(persisted, null);
    assert.equal(await page.locator("[data-attachments] [data-attachment-index]").count(), 1);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
  } finally {
    await browser.close();
  }
});

test("production receipt without streamId completes only one exact provider Thread Task", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "receipt-owned-by-a" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "receipt-owned-by-a");
    const requestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    const base = {
      clientUserMessageId: requestId,
      accepted: true,
      conflictKind: "message-intake",
      clientProjectionIntent: "conversation",
    };
    for (const identity of [
      { provider: "codex", threadId: "thread-b" },
      { provider: "claude", threadId: "thread-a" },
    ]) {
      await refreshWithReceipt(page, { ...base, ...identity });
      await setSelectedTask(page, "stream-a");
      assert.equal(await page.locator("[data-composer-input]").inputValue(), "receipt-owned-by-a");
    }

    const ambiguous = snapshot();
    ambiguous.version = "fixture-receipt-ambiguous-provider-thread";
    ambiguous.tasks[1] = { ...ambiguous.tasks[1], provider: "codex", threadId: "thread-a" };
    ambiguous.messageReceipts = [{ ...base, provider: "codex", threadId: "thread-a" }];
    await applyFixtureSnapshot(page, ambiguous);
    await setSelectedTask(page, "stream-a");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "receipt-owned-by-a");

    await refreshWithReceipt(page, {
      ...base,
      provider: "codex",
      threadId: "thread-a",
    });
    await setSelectedTask(page, "stream-a");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
  } finally {
    await browser.close();
  }
});

test("production accepted send invalidates a held FileReader draft operation", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function hold(file) {
        window.__heldSendRead = { reader: this, file };
      };
      window.__releaseSendRead = () => {
        const held = window.__heldSendRead;
        FileReader.prototype.readAsDataURL = original;
        original.call(held.reader, held.file);
      };
      localStorage.setItem("fixture:send-mode", "accept");
    });
    await page.locator("[data-composer-input]").fill("accepted while file read is pending");
    await page.locator("[data-file-input]").setInputFiles({
      name: "late.png", mimeType: "image/png", buffer: Buffer.from([31, 32, 33]),
    });
    await page.waitForFunction(() => Boolean(window.__heldSendRead));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "send-message")
        && document.querySelector("[data-composer-input]")?.value === "";
    });
    await page.evaluate(() => window.__releaseSendRead());
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await page.locator("[data-attachment-index]").count(), 0);
    assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.text, "accepted while file read is pending");
  } finally {
    await browser.close();
  }
});

test("production attachment reads are Task-scoped, generation-fenced and latest-operation wins", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const overlap = await browser.newPage();
    await openFixture(overlap);
    await overlap.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      window.__heldReads = [];
      FileReader.prototype.readAsDataURL = function hold(file) {
        window.__heldReads.push({ reader: this, file });
      };
      window.__releaseRead = (index) => {
        const held = window.__heldReads[index];
        original.call(held.reader, held.file);
      };
    });
    await overlap.locator("[data-file-input]").setInputFiles({
      name: "first.png", mimeType: "image/png", buffer: Buffer.from([1]),
    });
    await overlap.locator("[data-file-input]").setInputFiles({
      name: "second.png", mimeType: "image/png", buffer: Buffer.from([2]),
    });
    await overlap.waitForFunction(() => window.__heldReads?.length === 2);
    await overlap.evaluate(() => window.__releaseRead(1));
    await overlap.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    await overlap.evaluate(() => window.__releaseRead(0));
    await overlap.waitForTimeout(50);
    assert.equal(await overlap.locator("[data-attachment-index]").count(), 1);
    assert.equal(await overlap.locator("[data-attachments] img[alt='second.png']").count(), 1);
    await overlap.close();

    const removed = await browser.newPage();
    await openFixture(removed);
    await removed.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function hold(file) {
        window.__removedTaskRead = { reader: this, file };
      };
      window.__releaseRemovedTaskRead = () => original.call(
        window.__removedTaskRead.reader,
        window.__removedTaskRead.file,
      );
    });
    await removed.locator("[data-file-input]").setInputFiles({
      name: "stale.png", mimeType: "image/png", buffer: Buffer.from([3]),
    });
    await removed.waitForFunction(() => Boolean(window.__removedTaskRead));
    const beforeRemoval = (await bridgeCalls(removed, "snapshot")).length;
    await removed.evaluate(() => {
      const fixture = window.__agentHubFixture;
      fixture.snapshot = {
        ...fixture.snapshot,
        tasks: fixture.snapshot.tasks
          .filter((candidate) => candidate.streamId !== "stream-a")
          .map((candidate) => ({ ...candidate, selected: true })),
        version: "fixture-a-removed",
      };
      localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
      document.querySelector("[data-provider-connection-retry]")?.click();
    });
    await removed.waitForFunction((minimum) => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "snapshot").length > minimum;
    }, beforeRemoval);
    await removed.evaluate(() => window.__releaseRemovedTaskRead());
    await removed.waitForTimeout(50);
    const beforeRestore = (await bridgeCalls(removed, "snapshot")).length;
    await removed.evaluate((nextSnapshot) => {
      window.__agentHubFixture.snapshot = nextSnapshot;
      localStorage.setItem("fixture:snapshot", JSON.stringify(nextSnapshot));
      document.querySelector("[data-provider-connection-retry]")?.click();
    }, snapshot());
    await removed.waitForFunction((minimum) => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "snapshot").length > minimum;
    }, beforeRestore);
    await setSelectedTask(removed, "stream-a");
    assert.equal(await removed.locator("[data-attachment-index]").count(), 0);
    await removed.close();
  } finally {
    await browser.close();
  }
});

test("production refused attachment selections preserve the exact retry identity", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const scenarios = [
      async (page) => page.locator("[data-file-input]").setInputFiles({
        name: "too-large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
      }),
      async (page) => page.locator("[data-file-input]").setInputFiles({
        name: "empty.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(0),
      }),
    ];
    for (const refuse of scenarios) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await openFixture(page);
      await submit(page, { text: "retry-after-refusal" });
      await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "retry-after-refusal");
      const firstId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
      await refuse(page);
      await page.waitForTimeout(50);
      await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
      await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
      await page.waitForFunction(() => {
        const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
        return log.filter((entry) => entry.action === "send-message").length === 2;
      });
      assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, firstId);
      await context.close();
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    await openFixture(page);
    const eight = Array.from({ length: 8 }, (_, index) => ({
      name: `full-${index}.bin`, mimeType: "application/octet-stream", buffer: Buffer.from([index + 1]),
    }));
    await page.locator("[data-file-input]").setInputFiles(eight);
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 8);
    await page.locator("[data-composer-input]").fill("retry-at-zero-room");
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 8);
    const firstId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.locator("[data-file-input]").setInputFiles({
      name: "ninth.bin", mimeType: "application/octet-stream", buffer: Buffer.from([9]),
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, firstId);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("production persisted attachment recovery rejects non-canonical bytes and metadata", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const valid = { name: "safe.png", type: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" };
  const invalidAttachments = [
    { ...valid, dataUrl: "data:image/png;base64,AQ=I" },
    { ...valid, dataUrl: "data:image/png;base64,AQI" },
    { ...valid, size: 2 },
    { ...valid, type: "text/plain" },
    { ...valid, name: "../safe.png" },
  ];
  try {
    for (const [index, attachment] of invalidAttachments.entries()) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const requestId = `invalid-recovery-${index}`;
      await openFixture(page, {
        persistedDrafts: [persistedRecovery({
          requestId,
          text: `invalid ${index}`,
          attachments: [attachment],
          fingerprint: "legacy-invalid-fingerprint",
        })],
      });
      await page.waitForFunction((text) => document.querySelector("[data-composer-input]")?.value === text, `invalid ${index}`);
      assert.equal(await page.locator("[data-attachment-index]").count(), 0);
      assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
      assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
        message.includes("не может точно сохранить")
      ))), true);
      await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
      await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
      await page.waitForFunction(() => {
        const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
        return log.some((entry) => entry.action === "send-message");
      });
      assert.notEqual((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, requestId);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("production durable epoch rejects stale identity after localStorage set/remove failure", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const setContext = await browser.newContext();
    const setPage = await setContext.newPage();
    await openFixture(setPage);
    await submit(setPage, { text: "old durable text" });
    await setPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "old durable text");
    const oldSetId = (await bridgeCalls(setPage, "send-message")).at(-1).params.clientUserMessageId;
    await setPage.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function failDraftSet(key, value) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await setPage.locator("[data-composer-input]").fill("new unsaved text");
    await setPage.waitForFunction(() => window.__toastHistory.some((message) => message.includes("не может точно сохранить")));
    assert.equal(await setPage.evaluate(() => window.__toastHistory.filter((message) => (
      message.includes("не может точно сохранить")
    )).length), 1);
    assert.equal(await setPage.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    await setPage.waitForFunction(() => {
      const status = window.AgentHub.composerRecoveryDiagnostics();
      return status.pending === 0 && status.epoch > 0;
    });
    await setPage.reload({ waitUntil: "load" });
    await setPage.waitForFunction(() => window.AgentHub?.composerRecoveryDiagnostics?.().ready === true);
    assert.equal(await setPage.locator("[data-composer-input]").inputValue(), "");
    await setPage.locator("[data-composer-input]").fill("fresh after failed set");
    await setPage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await setPage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await setPage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.notEqual((await bridgeCalls(setPage, "send-message")).at(-1).params.clientUserMessageId, oldSetId);
    await setContext.close();

    const removeContext = await browser.newContext();
    const removePage = await removeContext.newPage();
    await openFixture(removePage);
    await submit(removePage, {
      attachment: { name: "remove.png", mimeType: "image/png", buffer: Buffer.from([7, 8, 9]) },
    });
    await removePage.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    const oldRemoveId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.evaluate(() => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function failDraftRemove(key) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("privacy", "SecurityError");
        }
        return original.call(this, key);
      };
    });
    await removePage.locator("[data-attachment-index]").click();
    await removePage.waitForFunction(() => window.__toastHistory.some((message) => message.includes("не может точно сохранить")));
    assert.equal(await removePage.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    await removePage.waitForFunction(() => {
      const status = window.AgentHub.composerRecoveryDiagnostics();
      return status.pending === 0 && status.epoch > 0;
    });
    await removePage.reload({ waitUntil: "load" });
    await removePage.waitForFunction(() => document.querySelector("[data-composer-input]"));
    assert.equal(await removePage.locator("[data-attachment-index]").count(), 0);
    assert.equal(await removePage.evaluate(() => window.AgentHub.prepareForRuntimeReload()), true);
    await removePage.locator("[data-composer-input]").fill("fresh after failed remove");
    await removePage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await removePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await removePage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.notEqual((await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId, oldRemoveId);
    await removeContext.close();
  } finally {
    await browser.close();
  }
});

test("production recovery fails closed when its independent durable authority is unavailable", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const staleRequestId = "stale-without-authority";
  try {
    await openFixture(page, {
      persistedDrafts: [persistedRecovery({
        requestId: staleRequestId,
        text: "visible but not trusted",
      })],
      recoveryAuthorityAvailable: false,
    });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "visible but not trusted");
    assert.deepEqual(await page.evaluate(() => window.AgentHub.composerRecoveryDiagnostics()), {
      epoch: 0,
      pending: 0,
      ready: true,
      restored: true,
      trusted: false,
    });
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    ))), true);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "send-message");
    });
    assert.notEqual((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, staleRequestId);
  } finally {
    await browser.close();
  }
});

test("production annotation hashing is Task-scoped and no-op failures preserve recovery", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const navigationContext = await browser.newContext();
    const navigation = await navigationContext.newPage();
    await openFixture(navigation);
    await navigation.locator("[data-composer-input]").fill("annotation belongs to A");
    await selectMessageText(navigation);
    await navigation.evaluate(() => {
      const subtle = crypto.subtle;
      const original = subtle.digest;
      window.__heldAnnotationHashes = [];
      subtle.digest = function hold(...args) {
        return new Promise((resolve, reject) => window.__heldAnnotationHashes.push({ self: this, args, resolve, reject }));
      };
      window.__releaseAnnotationHashes = async () => {
        const held = window.__heldAnnotationHashes.splice(0);
        subtle.digest = original;
        for (const entry of held) original.apply(entry.self, entry.args).then(entry.resolve, entry.reject);
      };
      window.__annotationPromise = window.AgentHub.addSelectedAnnotation();
    });
    await navigation.waitForFunction(() => window.__heldAnnotationHashes?.length === 3);
    await setSelectedTask(navigation, "stream-b");
    await navigation.evaluate(() => window.__releaseAnnotationHashes());
    await navigation.evaluate(() => window.__annotationPromise);
    assert.equal(await navigation.locator("[data-annotations] .annotation").count(), 0);
    await setSelectedTask(navigation, "stream-a");
    assert.equal(await navigation.locator("[data-annotations] .annotation").count(), 1);
    assert.equal(await navigation.locator("[data-composer-input]").inputValue(), "annotation belongs to A");
    await navigationContext.close();

    const failureContext = await browser.newContext();
    const failure = await failureContext.newPage();
    await openFixture(failure);
    await submit(failure, { text: "retry after hash failure" });
    await failure.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "retry after hash failure");
    const firstId = (await bridgeCalls(failure, "send-message")).at(-1).params.clientUserMessageId;
    await selectMessageText(failure);
    const added = await failure.evaluate(async () => {
      const subtle = crypto.subtle;
      const original = subtle.digest;
      subtle.digest = () => Promise.reject(new Error("hash failed"));
      try {
        return await window.AgentHub.addSelectedAnnotation();
      } finally {
        subtle.digest = original;
      }
    });
    assert.equal(added, false);
    await failure.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await failure.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await failure.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(failure, "send-message")).at(-1).params.clientUserMessageId, firstId);
    await failureContext.close();
  } finally {
    await browser.close();
  }
});

test("production overlapping and duplicate annotation operations do not advance stale revisions", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const overlapContext = await browser.newContext();
    const overlap = await overlapContext.newPage();
    await openFixture(overlap);
    await selectMessageText(overlap);
    await overlap.evaluate(() => {
      const subtle = crypto.subtle;
      const original = subtle.digest;
      window.__heldAnnotationHashes = [];
      subtle.digest = function hold(...args) {
        return new Promise((resolve, reject) => window.__heldAnnotationHashes.push({ self: this, args, resolve, reject }));
      };
      window.__releaseAnnotationHashIndexes = (indexes) => {
        for (const index of indexes) {
          const entry = window.__heldAnnotationHashes[index];
          original.apply(entry.self, entry.args).then(entry.resolve, entry.reject);
        }
      };
      window.__restoreAnnotationDigest = () => { subtle.digest = original; };
      window.__annotationFirst = window.AgentHub.addSelectedAnnotation();
    });
    await overlap.waitForFunction(() => window.__heldAnnotationHashes?.length === 3);
    await selectMessageText(overlap);
    await overlap.evaluate(() => { window.__annotationSecond = window.AgentHub.addSelectedAnnotation(); });
    await overlap.waitForFunction(() => window.__heldAnnotationHashes?.length === 6);
    await overlap.evaluate(() => window.__releaseAnnotationHashIndexes([3, 4, 5]));
    assert.equal(await overlap.evaluate(() => window.__annotationSecond), true);
    await overlap.evaluate(() => window.__releaseAnnotationHashIndexes([0, 1, 2]));
    assert.equal(await overlap.evaluate(() => window.__annotationFirst), false);
    await overlap.evaluate(() => window.__restoreAnnotationDigest());
    assert.equal(await overlap.locator("[data-annotations] .annotation").count(), 1);
    await overlapContext.close();

    const duplicateContext = await browser.newContext();
    const duplicate = await duplicateContext.newPage();
    await openFixture(duplicate);
    await selectMessageText(duplicate);
    assert.equal(await duplicate.evaluate(() => window.AgentHub.addSelectedAnnotation()), true);
    await duplicate.locator("[data-composer-input]").fill("duplicate annotation retry");
    await duplicate.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await duplicate.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    const requestId = (await bridgeCalls(duplicate, "send-message")).at(-1).params.clientUserMessageId;
    await selectMessageText(duplicate);
    assert.equal(await duplicate.evaluate(() => window.AgentHub.addSelectedAnnotation()), false);
    await lateAcceptedReceipt(duplicate, requestId);
    assert.equal(await duplicate.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await duplicate.locator("[data-annotations] .annotation").count(), 0);
    await duplicateContext.close();
  } finally {
    await browser.close();
  }
});

test("production mixed FileReader failure preserves recovery revision and exact retry", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "reader failure retry" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "reader failure retry");
    const originalId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.evaluate(() => {
      const original = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function controlledRead(file) {
        if (file.name === "broken.png") {
          setTimeout(() => this.onerror?.(new ProgressEvent("error")), 0);
          return;
        }
        original.call(this, file);
      };
    });
    await page.locator("[data-file-input]").setInputFiles([
      { name: "good.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) },
      { name: "broken.png", mimeType: "image/png", buffer: Buffer.from([4, 5, 6]) },
    ]);
    await page.waitForFunction(() => window.__toastHistory.some((message) => message.includes("broken.png")));
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "reader failure retry");
    assert.equal(await page.locator("[data-attachment-index]").count(), 0);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, originalId);
  } finally {
    await browser.close();
  }
});

test("production snapshot evidence completes once and fails closed on ambiguity", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "aggregate evidence" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "aggregate evidence");
    const requestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    const requestOnly = await page.evaluate((id) => window.AgentHub.completeSend(id, { outcome: "accepted" }), requestId);
    assert.equal(requestOnly.cleared, false);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "aggregate evidence");
    await page.evaluate(() => {
      const complete = window.AgentHub.completeSend.bind(window.AgentHub);
      window.__completionCalls = [];
      window.AgentHub.completeSend = (...args) => {
        window.__completionCalls.push(structuredClone(args));
        return complete(...args);
      };
    });
    const accepted = snapshot([{
      provider: "codex", threadId: "thread-a", streamId: "stream-a",
      clientUserMessageId: requestId, accepted: true,
    }]);
    accepted.version = "aggregate-1";
    accepted.deferredInputs = [{
      id: "deferred-1", provider: "codex", threadId: "thread-a", streamId: "stream-a",
      clientUserMessageId: requestId, state: "queued", text: "aggregate evidence",
    }];
    accepted.tasks[0] = {
      ...accepted.tasks[0],
      running: true,
      run: {
        clientUserMessageId: requestId,
        turnId: "turn-aggregate",
        providerStart: { state: "observed", turnId: "turn-aggregate" },
      },
    };
    await applyFixtureSnapshot(page, accepted);
    await page.waitForFunction(() => window.__completionCalls.length === 1);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");

    await applyFixtureSnapshot(page, { ...structuredClone(accepted), version: "aggregate-2" });
    assert.equal(await page.evaluate(() => window.__completionCalls.length), 1);

    const ambiguous = structuredClone(accepted);
    ambiguous.version = "aggregate-ambiguous";
    ambiguous.deferredInputs.push({
      id: "deferred-2", provider: "codex", threadId: "thread-b", streamId: "stream-b",
      clientUserMessageId: requestId, state: "queued", text: "wrong owner",
    });
    await applyFixtureSnapshot(page, ambiguous);
    assert.equal(await page.evaluate(() => window.__completionCalls.length), 1);
  } finally {
    await browser.close();
  }
});

test("production upload completion is fenced by Task generation and exact Thread identity", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      localStorage.setItem("fixture:upload-mode", "hold");
      localStorage.setItem("fixture:send-mode", "accept");
    });
    await page.locator("[data-composer-input]").fill("stale upload must abort");
    await page.locator("[data-file-input]").setInputFiles({
      name: "held.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]),
    });
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => Boolean(window.__agentHubFixture.heldUpload));
    const replaced = snapshot();
    replaced.version = "thread-replaced";
    replaced.tasks[0] = {
      ...replaced.tasks[0],
      provider: "claude",
      threadId: "thread-a-replaced",
      title: "Replaced Thread",
      displayTitle: "Replaced Thread",
    };
    replaced.workspaces[0].streams[0].threads = [{ id: "thread-a-replaced" }];
    replaced.selected.threadId = "thread-a-replaced";
    replaced.selected.provider = "claude";
    await applyFixtureSnapshot(page, replaced);
    await page.waitForFunction(() => document.querySelector("[data-stream-header-provider]")?.textContent === "Claude");
    await page.evaluate(() => window.__releaseHeldUpload());
    await page.waitForFunction(() => window.__toastHistory.some((message) => message.includes("Диалог изменился")));
    assert.equal((await bridgeCalls(page, "upload-attachment")).length, 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
  } finally {
    await browser.close();
  }
});

test("production Task deletion durably fences same-identity cold recreation", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openFixture(page);
    await submit(page, { text: "deleted recovery must stay deleted" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "deleted recovery must stay deleted");
    const oldId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.evaluate(() => {
      const originalSet = Storage.prototype.setItem;
      const originalRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function failDraftSet(key, value) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSet.call(this, key, value);
      };
      Storage.prototype.removeItem = function failDraftRemove(key) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("privacy", "SecurityError");
        }
        return originalRemove.call(this, key);
      };
    });
    const deleted = snapshot();
    deleted.version = "task-a-deleted";
    deleted.tasks = [{ ...task("stream-b"), selected: true }];
    deleted.workspaces[0].streams = [deleted.workspaces[0].streams[1]];
    deleted.selected = { ...deleted.selected, streamId: "stream-b", threadId: "thread-b" };
    await applyFixtureSnapshot(page, deleted);
    await page.waitForFunction(() => !document.querySelector("[data-stream-task-id='stream-a']"));
    await page.waitForFunction(() => {
      const status = window.AgentHub.composerRecoveryDiagnostics();
      return status.pending === 0 && status.epoch > 0;
    });
    await page.close();

    const cold = await context.newPage();
    await openFixture(cold, { expectedTaskId: "stream-b" });
    const recreated = snapshot();
    recreated.version = "task-a-recreated";
    await applyFixtureSnapshot(cold, recreated);
    await setSelectedTask(cold, "stream-a");
    assert.equal(await cold.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await cold.locator("[data-attachment-index]").count(), 0);
    await cold.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await cold.locator("[data-composer-input]").fill("deleted recovery must stay deleted");
    await cold.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await cold.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.notEqual((await bridgeCalls(cold, "send-message")).at(-1).params.clientUserMessageId, oldId);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("production attachment boundary rejects unsafe names and accepts exact 20 MiB without crash", {
  timeout: 180_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const unsafePage = await browser.newPage();
    await openFixture(unsafePage);
    await submit(unsafePage, { text: "unsafe names preserve retry" });
    await unsafePage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "unsafe names preserve retry");
    const originalId = (await bridgeCalls(unsafePage, "send-message")).at(-1).params.clientUserMessageId;
    const unsafeResults = await unsafePage.evaluate(async () => {
      const results = [];
      for (const name of [".", "..", "NUL.txt", "control\u0085.png", "trail. "]) {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([1])], name, { type: "image/png" }));
        const input = document.querySelector("[data-file-input]");
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push({ name, count: document.querySelectorAll("[data-attachment-index]").length });
      }
      return {
        results,
        loneSurrogateRejected: window.AgentHubComposerDraftReconciliation.safeAttachmentMetadata({
          name: "lone-\uD800.png", type: "image/png", size: 1,
        }) === null,
      };
    });
    assert.deepEqual(unsafeResults.results.map((entry) => entry.count), [0, 0, 0, 0, 0]);
    assert.equal(unsafeResults.loneSurrogateRejected, true);
    assert.equal(await unsafePage.locator("[data-attachment-index]").count(), 0);
    await unsafePage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await unsafePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await unsafePage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(unsafePage, "send-message")).at(-1).params.clientUserMessageId, originalId);
    await unsafePage.close();

    const maximum = await browser.newPage();
    const diagnostics = await openFixture(maximum);
    await maximum.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        [new Uint8Array(20 * 1024 * 1024)],
        "maximum.bin",
        { type: "application/octet-stream" },
      ));
      const input = document.querySelector("[data-file-input]");
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await maximum.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1, null, {
      timeout: 60_000,
    });
    await maximum.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([1])], "overflow.bin", { type: "application/octet-stream" }));
      const input = document.querySelector("[data-file-input]");
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      localStorage.setItem("fixture:send-mode", "accept");
    });
    await maximum.waitForTimeout(50);
    assert.equal(await maximum.locator("[data-attachment-index]").count(), 1);
    await maximum.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await maximum.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "send-message");
    }, null, { timeout: 60_000 });
    const upload = (await bridgeCalls(maximum, "upload-attachment")).at(-1);
    assert.ok(upload.params.dataUrlLength > 20 * 1024 * 1024);
    assert.equal(diagnostics.some((message) => /RangeError|Maximum call stack/iu.test(message)), false);
  } finally {
    await browser.close();
  }
});
