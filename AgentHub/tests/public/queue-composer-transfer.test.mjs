import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit", name: "Orbit", color: "#080b11", aliases: [], assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

async function transferOwner() {
  const source = await readFile(new URL("queue-composer-transfer.js", WEB_APP_ROOT), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubQueueComposerTransfer;
}

async function returnProtocol() {
  const source = await readFile(new URL("queue-composer-return.js", WEB_APP_ROOT), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubQueueComposerReturn;
}

test("shipped queue composer owner is CAS-safe and never overwrites a nonempty composer", async () => {
  const owner = await transferOwner();
  let current = { text: "", attachments: [], taskReferences: [], annotations: [] };
  let revision = 0;
  const notices = [];
  const transfer = owner.create({
    read: () => current,
    write: (_taskId, value) => { current = structuredClone(value); revision += 1; },
    revision: () => revision,
    notify: (message) => notices.push(message),
  });

  const guard = transfer.begin("task-1");
  revision += 1;
  current = { ...current, text: "новый ввод" };
  assert.equal(transfer.apply(guard, { text: "queued" }, { id: "q-1", token: "t-1" }), null);
  assert.equal(current.text, "новый ввод");

  assert.equal(transfer.begin("task-1"), null);
  assert.match(notices.at(-1), /очисти основной композер/iu);

  current = { text: "", attachments: [], taskReferences: [], annotations: [] };
  revision += 1;
  const nextGuard = transfer.begin("task-1");
  const applied = transfer.apply(nextGuard, {
    text: "queued",
    attachments: [{ name: "one.png", dataUrl: "data:image/png;base64,AA==" }],
    taskReferences: [{ taskId: "board-1", intent: "start" }],
    annotations: [{ quote: "цитата", annotation: "ответ" }],
    messageOrigin: { kind: "interstream", streamId: "source" },
  }, { id: "q-1", token: "t-1" });
  assert.equal(current.text, "queued");
  assert.equal(current.composerTransfer.token, "t-1");
  assert.equal(transfer.rollback(applied), true);
  assert.equal(current.text, "");

  const appliedAgain = transfer.apply(transfer.begin("task-1"), { text: "queued" }, { id: "q-1", token: "t-1" });
  current.text = "user edit";
  revision += 1;
  assert.equal(transfer.rollback(appliedAgain), false);
  assert.equal(current.text, "user edit");
});

test("shipped return protocol coalesces repeats and reconciles a lost commit response", async () => {
  const protocol = await returnProtocol();
  let prepareCount = 0;
  let commitCount = 0;
  let applyCount = 0;
  let releasePrepare;
  const gate = new Promise((resolve) => { releasePrepare = resolve; });
  const transfer = protocol.create({
    prepare: async () => {
      prepareCount += 1;
      await gate;
      return {
        token: "transfer-1", binding: { streamId: "task-1" },
        draft: { text: "queued", attachments: [{ id: "file-1" }] },
      };
    },
    commit: async () => { commitCount += 1; throw new Error("response lost"); },
    release: async () => assert.fail("committed item must not be released"),
    readSnapshot: async () => ({ deferredInputs: [] }),
    itemPresent: (snapshot, id) => snapshot.deferredInputs.some((item) => item.id === id),
    bindingTaskId: (binding) => binding.streamId,
    materializeAttachment: async () => ({ name: "one.png", dataUrl: "data:image/png;base64,AA==" }),
    applyDraft: () => { applyCount += 1; return { applied: true }; },
    rollbackDraft: () => assert.fail("lost response with absent item is committed"),
    applySnapshot: () => {},
    notify: () => {},
  });
  const request = { id: "queued-1", taskId: "task-1", guard: {} };
  const first = transfer.run(request);
  const repeat = transfer.run(request);
  assert.equal(first, repeat);
  releasePrepare();
  const [left, right] = await Promise.all([first, repeat]);
  assert.equal(left.reconciled, true);
  assert.equal(right.reconciled, true);
  assert.equal(prepareCount, 1);
  assert.equal(commitCount, 1);
  assert.equal(applyCount, 1);
});

test("shipped return protocol rolls back only when authoritative queue removal failed", async () => {
  const protocol = await returnProtocol();
  const events = [];
  const transfer = protocol.create({
    prepare: async () => ({
      token: "transfer-1", binding: { streamId: "task-1" }, draft: { text: "queued" },
    }),
    commit: async () => { throw new Error("disk full"); },
    release: async () => { events.push("release"); },
    readSnapshot: async () => ({ deferredInputs: [{ id: "queued-1" }] }),
    itemPresent: (snapshot, id) => snapshot.deferredInputs.some((item) => item.id === id),
    bindingTaskId: (binding) => binding.streamId,
    materializeAttachment: async (value) => value,
    applyDraft: () => ({ applied: true }),
    rollbackDraft: () => { events.push("rollback"); return true; },
    applySnapshot: () => { events.push("snapshot"); },
    notify: () => {},
  });

  await assert.rejects(transfer.run({ id: "queued-1", taskId: "task-1", guard: {} }), /disk full/u);
  assert.deepEqual(events, ["rollback", "release", "snapshot"]);
});

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function openProductionUi(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (url.pathname === "/work-log.css") {
      return route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    try {
      return route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
}

test("production app returns the exact queued draft to the main composer and exposes reorder buttons", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await openProductionUi(page);
    await page.evaluate(() => {
      const task = {
        id: "task-1", provider: "codex", threadId: "thread-1", streamId: "stream-1",
        workspaceId: "workspace-1", workspaceName: "Agent HUB", streamName: "Hotfixer",
        title: "Hotfixer", agentLabel: "Codex", selected: true,
      };
      window.__queueIntents = [];
      document.addEventListener("agenthub:intent", (event) => {
        if (["queue:edit", "queue:move"].includes(event.detail?.type)) {
          window.__queueIntents.push(event.detail);
        }
      });
      window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB" }]);
      window.AgentHub.setTasks([task]);
      window.AgentHub.setQueue("task-1", [{
        id: "queued-1", state: "queued", text: "Первое", queueOrder: 0,
      }, {
        id: "queued-2", state: "paused", text: "Второе", queueOrder: 1,
      }]);
      window.AgentHub.showSelectedTask();
    });

    const first = page.locator("[data-queue-id='queued-1']");
    const second = page.locator("[data-queue-id='queued-2']");
    assert.equal(await first.locator("[data-direction='up']").isDisabled(), true);
    assert.equal(await first.locator("[data-direction='down']").isDisabled(), false);
    assert.equal(await second.locator("[data-direction='up']").isDisabled(), false);
    assert.equal(await second.locator("[data-direction='down']").isDisabled(), true);
    await second.locator("[data-direction='up']").click();
    assert.deepEqual(await page.evaluate(() => {
      const intent = window.__queueIntents.at(-1);
      return { type: intent.type, id: intent.id, direction: intent.direction };
    }), { type: "queue:move", id: "queued-2", direction: "up" });

    await first.locator("[data-action='queue-edit']").click();
    const applied = await page.evaluate(() => {
      const intent = window.__queueIntents.find((entry) => entry.type === "queue:edit");
      window.__editIntent = intent;
      return Boolean(window.AgentHub.applyQueueComposerTransfer(intent.guard, {
        text: "Исходный текст",
        attachments: [{ name: "screen.png", type: "image/png", size: 1, dataUrl: "data:image/png;base64,AA==" }],
        taskReferences: [{ taskId: "board-1", taskNumber: "HUB-1", title: "Task", workflowStatus: "testing", intent: "start" }],
        annotations: [{ quote: "Цитата", annotation: "Комментарий" }],
        messageOrigin: { kind: "interstream", workspaceId: "w", workspaceName: "W", streamId: "s", streamName: "S" },
      }, { id: "queued-1", token: "transfer-1" }));
    });
    assert.equal(applied, true);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Исходный текст");
    assert.equal(await page.locator("[data-attachment-index]").count(), 1);
    assert.equal(await page.locator("[data-task-reference-index]").count(), 1);
    assert.equal(await page.locator("[data-annotation-index]").count(), 1);

    const before = await page.evaluate(() => window.__queueIntents.length);
    await second.locator("[data-action='queue-edit']").click();
    assert.equal(await page.evaluate(() => window.__queueIntents.length), before);
    assert.match(await page.locator("[data-toast]").textContent(), /очисти основной композер/iu);
  } finally {
    await browser.close();
  }
});
