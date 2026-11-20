import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, snapshot, applyFixtureSnapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

const origin = { workspaceId: "workspace-1", workspaceName: "Agent HUB", streamId: "stream-s3",
  streamName: "S3", provider: "codex", model: "GPT-6 Astra", sourceThreadId: "thread-s3", requestId: "source-request" };
const entry = overrides => ({ provider: "codex", threadId: "thread-a", streamId: "stream-a",
  clientUserMessageId: "mcp:source-request", clientProjectionIntent: "conversation",
  createdAt: "2026-09-11T10:00:00.000Z", text: "Synthetic source summary", author: "S3 · Astra", origin, ...overrides });
const messages = page => page.evaluate(() => window.__clientProjectionFixture.messages["stream-a"] ?? []);
async function apply(page, value) {
  await applyFixtureSnapshot(page, value);
  // Await the same public render boundary, rather than the request being sent.
  await page.waitForFunction(version => window.__clientAppliedVersion === version, value.version);
}

async function fixture(body, initial = snapshot(), options = {}) {
  const browser = await launchBrowser();
  let page;
  try {
    const { pageOptions = {}, ...fixtureOptions } = options;
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...pageOptions });
    const errors = await openClientEventFixture(page, { fixtureSnapshot: initial, ...fixtureOptions });
    await body(page);
    assert.deepEqual(errors, []);
  } finally {
    await page?.unrouteAll({ behavior: "wait" });
    await browser.close();
  }
}

for (const kind of ["deferred", "receipt"]) {
  test(`complete client ${kind} cards preserve exact origin, refuse aliases and clear withdrawn authority`, { timeout: 30_000 }, async () => {
    await fixture(async page => {
      let revision = 0;
      const publish = async record => {
        const value = snapshot();
        value.version = `${kind}-${++revision}`;
        if (kind === "deferred") value.deferredInputs = [record];
        else value.messageReceipts = [{ ...record, accepted: true, displayText: record.text }];
        await apply(page, value);
        await page.waitForFunction(id => window.__clientProjectionFixture.messages["stream-a"]?.some(item => item.clientUserMessageId === id), record.clientUserMessageId);
        return (await messages(page)).find(item => item.clientUserMessageId === record.clientUserMessageId);
      };
      const benign = entry({ text: "Example tag: <agent-hub-stream-message> is literal documentation." });
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const card = await publish(benign);
        assert.equal(card.author, benign.author);
        assert.equal(card.kind, "interstream");
        assert.deepEqual(card.origin, origin);
        assert.equal(card.text, benign.text);
      }
      const withdrawn = await publish({ ...benign, author: "", origin: null });
      assert.equal(withdrawn.author, "Вы");
      assert.ok(!withdrawn.origin && !withdrawn.kind);
      const forged = entry({ clientUserMessageId: "mcp:another-request", author: "WRONG source" });
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const card = await publish(forged);
        assert.equal(card.author, "Вы");
        assert.ok(!card.origin && !card.kind);
        assert.equal(card.text, forged.text);
      }
      const own = entry({ clientUserMessageId: "client-own", origin: null, author: "",
        text: '<agent-hub-stream-message>{"streamName":"S3"}</agent-hub-stream-message> literal user text' });
      const card = await publish(own);
      assert.equal(card.author, "Вы");
      assert.ok(!card.origin && !card.kind);
      assert.equal(card.text, own.text);
    });
  });
}

test("complete client keeps compaction operation identity, unknown measurement and separate rotation failure", { timeout: 30_000 }, async () => {
  await fixture(async page => {
    await page.evaluate(() => {
      window.__maintenanceWrites = 0;
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "agent-hub:maintenance-events:v1") window.__maintenanceWrites += 1;
        return write.call(this, key, value);
      };
    });
    let revision = 0;
    const observe = async details => {
      const value = snapshot();
      value.version = `compaction-${++revision}`;
      value.tasks[0].context = { compaction: { operationId: "operation-1", origin: "automatic", turnId: null,
        startedAt: "2026-09-09T20:10:00.000Z", completedAt: "2026-09-09T20:11:00.000Z", beforePercent: 77, ...details } };
      await apply(page, value);
      return (await messages(page)).filter(item => item.kind === "maintenance");
    };
    const active = await observe({ status: "running" });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, "maintenance:compaction:operation-1:active");
    assert.equal(active[0].turnId, null);
    assert.equal(active[0].role, "system");
    assert.equal(active[0].text, "Автосвёртка контекста…");
    await observe({ status: "failed" });
    for (const status of ["unknown", "timeout"]) {
      const records = await observe({ status });
      assert.equal(records.length, 1);
      assert.equal(records[0].id, "maintenance:compaction:operation-1");
      assert.equal(records[0].maintenanceStatus, "unknown");
      assert.equal(records[0].text, "Статус свёртки неизвестен");
    }
    const complete = { status: "completed", measurementStatus: "completed", afterPercent: 14 };
    let records = await observe(complete);
    assert.equal(records[0].maintenanceStatus, "completed");
    assert.equal(records[0].afterPercent, 14);
    await observe({ status: "failed" });
    records = await observe(complete);
    assert.equal(records.length, 1);
    assert.equal(records[0].maintenanceStatus, "completed");
    records = await observe({ ...complete, measurementKind: "estimated" });
    const compaction = records.find(item => item.maintenanceType === "compaction");
    assert.match(compaction.text, /77% → ≈14%/u);
    assert.match(compaction.maintenanceDetail, /Предварительная оценка провайдера/u);
    assert.match(await page.locator('.msg-maintenance').getAttribute('title'), /≈14%.*Предварительная оценка провайдера/u);
    for (const details of [{ measurementStatus: "completed", afterPercent: null }, { measurementStatus: "failed", afterPercent: 14 }, { afterPercent: 14 }]) {
      records = await observe({ status: "completed", ...details });
      const missing = records.find(item => item.maintenanceType === "compaction");
      assert.equal(missing.afterPercent, null);
      assert.doesNotMatch(missing.text, /(?:≈14%|успешно)/u);
      assert.ok(missing.maintenanceDetail);
    }
    // The real owner retains only the latest maintenance event, whereas the
    // retired fragment harness replaced that owner with an identity function.
    records = await observe({ ...complete, measurementKind: "estimated", rotationStatus: "failed", rotationMessage: "Целевой Thread недоступен" });
    const rotation = records.find(item => item.maintenanceType === "rotation");
    assert.ok(rotation, "the later failed rotation remains visible instead of being replaced by its successful compaction");
    assert.equal(rotation.maintenanceStatus, "failed");
    assert.match(rotation.text, /Исходный Thread сохранён/u);
    assert.match(rotation.maintenanceDetail, /Целевой Thread недоступен/u);
    const writes = await page.evaluate(() => window.__maintenanceWrites);
    const unchanged = await observe({ ...complete, measurementKind: "estimated", rotationStatus: "failed", rotationMessage: "Целевой Thread недоступен" });
    assert.deepEqual(unchanged, records);
    assert.equal(await page.evaluate(() => window.__maintenanceWrites), writes, "unchanged polling does not alternate two persisted projections");
  });
});

test("mobile maintenance preserves terminal revision across replay and reload and notifies actual starts once", { timeout: 45_000 }, async () => {
  await fixture(async page => {
    let revision = 0;
    const startedAt = new Date().toISOString();
    const observe = async compaction => {
      const value = snapshot();
      value.version = `maintenance-replay-${++revision}`;
      value.tasks[0].context = { compaction: { operationId: "operation-replay", origin: "automatic",
        dedicatedProviderTurn: true, startedAt, ...compaction } };
      value.deferredInputs = [{ id: "saved-input", clientUserMessageId: "preserved-original", provider: "codex",
        threadId: "thread-a", streamId: "stream-a", state: "paused", paused: true,
        conflictKind: "message-intake", waitReason: "provider-thread-active", text: "Продолжай",
        createdAt: startedAt }];
      await page.evaluate(value => {
        window.__agentHubFixture.snapshot = value;
        localStorage.setItem("fixture:snapshot", JSON.stringify(value));
        return window.__dispatchClientFixture("connection:retry");
      }, value);
      await page.waitForFunction(version => window.__clientAppliedVersion === version, value.version);
    };
    const toasts = () => page.evaluate(() => window.__clientProjectionFixture.toasts.filter(text => text.startsWith("Началась автосвёртка")));
    await observe({ revision: 1, status: "running", turnId: null });
    assert.equal((await toasts()).length, 0, "RPC preparation is not a confirmed provider start");
    await page.locator('.msg-maintenance').filter({ hasText: "Запуск обслуживания контекста…" }).waitFor({ state: "visible" });
    await observe({ revision: 2, status: "running", turnId: "maintenance-turn" });
    assert.equal((await toasts()).length, 1);
    const failed = { revision: 3, status: "failed", turnId: "maintenance-turn", completedAt: new Date().toISOString() };
    await observe(failed);
    for (const observation of [failed, { revision: 1, status: "running", turnId: null }, { revision: 2, status: "running", turnId: "maintenance-turn" }, failed]) {
      await observe(observation);
      const records = (await messages(page)).filter(item => item.kind === "maintenance");
      assert.equal(records.length, 1);
      assert.equal(records[0].maintenanceStatus, "failed");
      await page.locator('.msg-maintenance').filter({ hasText: "Автосвёртка контекста не завершилась" }).waitFor({ state: "visible" });
    }
    assert.equal((await toasts()).length, 1, "reordered observations do not restart an operation");
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__clientAppliedVersion));
    await observe({ revision: 2, status: "running", turnId: "maintenance-turn" });
    assert.equal((await messages(page)).filter(item => item.kind === "maintenance")[0].maintenanceStatus, "failed");
    assert.equal((await toasts()).length, 0, "reload does not announce an already observed operation");
    await page.getByText("Продолжай", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Сохранённый запрос", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Полный финальный ответ", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator('.msg').filter({ hasText: "Сохранённый запрос" }).count(), 1);
    assert.equal(await page.locator('.msg').filter({ hasText: "Полный финальный ответ" }).count(), 1);
    if (process.env.AGENT_HUB_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AGENT_HUB_TEST_SCREENSHOT });
    await observe({ operationId: "new-operation", revision: 1, status: "running", turnId: "new-maintenance-turn" });
    assert.equal((await toasts()).length, 1, "a different actual start remains visible");
  }, snapshot(), { surface: "web", followSelection: true,
    fixtureHistory: { provider: "codex", threadId: "thread-a", streamId: "stream-a",
      items: [{ id: "history-turn", completed: true, terminalRevision: 1, messages: [
        { role: "user", itemId: "user-item", clientUserMessageId: "history-user", text: "Сохранённый запрос" },
        { role: "agent", itemId: "final-item", phase: "final", text: "Полный финальный ответ" },
      ] }], start: 0, end: 1, total: 1, messageTotal: 2, nextBefore: null, version: "history-stable" },
    pageOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
});

test("failed pending intake exposes decisions only in the exact Stream despite a shared Thread", { timeout: 30_000 }, async () => {
  const value = snapshot();
  value.tasks[1].threadId = "thread-a";
  value.deferredInputs = [{ id: "failed-intake", clientUserMessageId: "failed-client", provider: "codex",
    threadId: "thread-a", streamId: "stream-b", state: "pending", attentionRequired: true,
    conflictKind: "message-intake", text: "Synthetic failed intake", lastError: "Provider start was not confirmed" }];
  await fixture(async page => {
    assert.equal(await page.locator(".queue-item[data-queue-id='failed-intake']").count(), 0);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    const row = page.locator(".queue-item[data-queue-id='failed-intake']");
    await row.waitFor({ state: "visible" });
    assert.match(await row.textContent(), /Provider start was not confirmed/u);
    assert.match(await page.locator(".queue-head").textContent(), /Требуют решения: 1/u);
    for (const action of ["queue-retry", "queue-remove"]) {
      assert.equal(await row.locator(`[data-action='${action}']`).isEnabled(), true);
    }
  }, value);
});

test("complete client projects generated attachments and clears a drained live run without reviving its prompt", { timeout: 30_000 }, async () => {
  const value = snapshot();
  const image = { id: "generated-one.png", type: "image/png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
  value.tasks[0] = { ...value.tasks[0], running: true, run: { turnId: "generated-turn", clientUserMessageId: "generated-client",
    operationKind: "user-turn", projectionState: "active", stage: "working", prompt: "Synthetic image request",
    responseAttachments: [image] } };
  await fixture(async page => {
    await page.waitForFunction(() => window.__clientProjectionFixture.live["stream-a"]?.attachments?.length === 1);
    const card = await page.evaluate(() => window.__clientProjectionFixture.live["stream-a"]);
    assert.equal(card.turnId, "generated-turn");
    assert.deepEqual(card.attachments, [image]);
    const idle = snapshot();
    idle.version = "generated-run-drained";
    await apply(page, idle);
    assert.equal(await page.evaluate(() => window.__clientProjectionFixture.live["stream-a"]), null);
    assert.equal((await messages(page)).some(item => item.clientUserMessageId === "generated-client"), false);
    assert.equal(await page.locator("[data-chat-live]").evaluate(node => node.hidden), true);
  }, value);
});

test("whole client restores one exact rotation notice after reload, between source and target turns", { timeout: 30_000 }, async () => {
  const value = snapshot();
  value.tasks[0] = { ...value.tasks[0], threadId: "thread-old", threadPosition: 37, selected: false,
    context: { compaction: { operationId: "rotation-source-operation", status: "completed", rotated: true,
      beforePercent: 78.408282, afterPercent: 25.770898, completedAt: "2026-09-10T20:53:46.990Z" } } };
  value.tasks.push({ ...snapshot().tasks[0], threadId: "thread-new", threadPosition: 38, context: { percent: 61 } });
  value.tasks.push({ ...value.tasks[0], threadId: "thread-older", threadPosition: 36,
    context: { compaction: { ...value.tasks[0].context.compaction, operationId: "earlier-rotation", completedAt: "2026-09-09T20:00:00.000Z" } } });
  value.selected.threadId = "thread-new";
  await fixture(async page => {
    let retained;
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      if (reload) await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
      await page.waitForFunction(() => window.__clientProjectionFixture.messages["stream-a"]?.some(item => item.maintenanceType === "rotation"));
      const records = (await messages(page)).filter(item => item.kind === "maintenance");
      assert.equal(records.length, 1);
      assert.equal(Object.hasOwn(records[0], "afterPercent"), false);
      if (retained) assert.deepEqual(records, retained);
      retained = records;
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => window.AgentHub.showSelectedTask());
        const marker = page.locator(".msg-maintenance");
        assert.equal(await marker.count(), 1);
        assert.match(await marker.textContent(), /Ротация завершена/u);
        await marker.waitFor({ state: "visible", timeout: 3000 }).catch(async error => {
          console.log("rotation-visibility", JSON.stringify(await marker.evaluate(node => {
            const result = [];
            for (; node; node = node.parentElement) result.push({ tag: node.tagName, cls: node.className,
              hidden: node.hidden, display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility,
              box: { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height } });
            return result;
          })));
          throw error;
        });
        const order = await page.evaluate(() => {
          const marker = document.querySelector(".msg-maintenance");
          const before = [...document.querySelectorAll(".msg-agent")].find(node => node.textContent.includes("Source answer"));
          const after = [...document.querySelectorAll(".msg-user")].find(node => node.textContent.includes("Target question"));
          return { afterSource: Boolean(before?.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING),
            beforeTarget: Boolean(marker.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) };
        });
        assert.deepEqual(order, { afterSource: true, beforeTarget: true });
        if (process.env.AGENT_HUB_UI_QA_DIR) await page.screenshot({ path: `${process.env.AGENT_HUB_UI_QA_DIR}/rotation-${width}-${reload ? 'reload' : 'initial'}.png` });
      }
    }
  }, value, { surface: "web", fixtureHistory: { provider: "codex", threadId: "thread-new", streamId: "stream-a", version: "rotated-history",
    start: 0, end: 2, total: 2, messageTotal: 2, items: [
      { id: "source-turn", provider: "codex", threadId: "thread-old", completed: true, messages: [
        { role: "agent", itemId: "source-final", phase: "final", text: "Source answer", time: "2026-09-10T20:53:50.000Z" }] },
      { id: "target-turn", provider: "codex", threadId: "thread-new", completed: true, messages: [
        { role: "user", itemId: "target-user", text: "Target question", time: "2026-09-10T20:56:00.000Z" }] },
    ] } });
});

test("durable final clears a pre-turn live card through its exact client identity", { timeout: 30_000 }, async () => {
  const value = snapshot();
  value.tasks[0] = { ...value.tasks[0], running: true, run: { id: "pre-turn-run", turnId: "", clientUserMessageId: "pre-turn-client",
    operationKind: "user-turn", projectionState: "active", stage: "preparing", prompt: "Pre-turn question" } };
  await fixture(async page => {
    await page.waitForFunction(() => window.__clientProjectionFixture.live["stream-a"] != null);
    await page.evaluate(() => {
      window.__agentHubFixture.history = { provider: "codex", threadId: "thread-a", streamId: "stream-a", version: "pre-turn-durable",
        start: 0, end: 1, total: 1, messageTotal: 2, items: [{ id: "accepted-turn", completed: true,
          messages: [{ role: "user", itemId: "accepted-user", clientUserMessageId: "pre-turn-client", text: "Pre-turn question" },
            { role: "agent", itemId: "accepted-final", phase: "final", text: "Pre-turn final" }] }] };
    });
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Pre-turn final"));
    assert.equal(await page.evaluate(() => window.__clientProjectionFixture.live["stream-a"]), null);
    assert.equal((await messages(page)).filter(item => item.clientUserMessageId === "pre-turn-client").length, 1);
    assert.equal(await page.locator("[data-chat-live]").evaluate(node => node.hidden), true);
  }, value);
});

test("task panel follows the effective local Stream instead of a stale server selection", { timeout: 30_000 }, async () => {
  const value = snapshot();
  value.tasks[1].workspaceId = "workspace-2";
  value.tasks[1].workspaceName = "Other Workspace";
  value.workspaces.push({ id: "workspace-2", name: "Other Workspace", streams: [] });
  await fixture(async page => {
    const stale = structuredClone(value);
    stale.version = "stale-server-selection";
    stale.tasks[0].selected = false;
    stale.tasks[1].selected = true;
    stale.selected = { provider: "codex", threadId: "thread-b", streamId: "stream-b", workspaceId: "workspace-2" };
    await apply(page, stale);
    assert.deepEqual(await page.evaluate(() => window.__clientProjectionFixture.boardSelection), { workspace: "workspace-1", stream: "stream-a" });
    await page.evaluate(() => window.__dispatchClientFixture("task:select", { id: "stream-b" }));
    await page.waitForFunction(() => window.__clientProjectionFixture.boardSelection?.stream === "stream-b");
    assert.deepEqual(await page.evaluate(() => window.__clientProjectionFixture.boardSelection), { workspace: "workspace-2", stream: "stream-b" });
  }, value);
});

test("automatic compaction feedback names the actual displayed Task and falls back to its Workspace and Stream", { timeout: 30_000 }, async () => {
  await fixture(async page => {
    for (const [index, names, expected] of [
      [1, { displayTitle: "Exact Task", title: "Historical Thread" }, "Exact Task"],
      [2, { displayTitle: "", title: "Historical Thread", workspaceName: "Workspace", streamName: "S2" }, "Workspace - S2"],
    ]) {
      const value = snapshot();
      value.version = `named-compaction-${index}`;
      Object.assign(value.tasks[0], names, { context: { compaction: { operationId: `named-operation-${index}`,
        status: "running", turnId: `named-provider-turn-${index}`, origin: "automatic", startedAt: new Date().toISOString() } } });
      await apply(page, value);
      await page.waitForFunction(name => window.__clientProjectionFixture.toasts.some(text => text.endsWith(`· ${name}`)), expected);
    }
  });
});

test("whole history projection retains attachment identity and time and the actual viewer opens its image", { timeout: 30_000 }, async () => {
  const image = { id: "history-image.png", name: "history-image.png", type: "image/png",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
  const submittedAt = "2026-09-11T10:00:00.000Z";
  await fixture(async page => {
    await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
    await page.waitForFunction(() => window.__clientProjectionFixture.messages["stream-a"]?.some(item => item.itemId === "image-user"));
    const user = (await messages(page)).find(item => item.itemId === "image-user");
    assert.equal(user.time, submittedAt);
    assert.deepEqual(user.attachments, [image, { id: "missing-file", name: "missing.txt", missing: true }]);
    const missing = page.locator('.msg-user .attachment-missing');
    assert.equal(await missing.isDisabled(), true);
    assert.match(await missing.textContent(), /Файл недоступен/u);
    await page.locator('.msg-user .attachment-image').click();
    await page.locator('[data-attachment-viewer]').waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[data-attachment-viewer-image]')?.naturalWidth > 0);
    assert.equal(await page.locator('[data-attachment-viewer-name]').textContent(), image.name);
    await page.locator('[data-attachment-viewer-close]').click();
    assert.equal(await page.locator('[data-attachment-viewer]').isVisible(), false);
  }, snapshot(), { fixtureHistory: { provider: "codex", threadId: "thread-a", streamId: "stream-a", version: "history-attachment",
    start: 0, end: 1, total: 1, messageTotal: 1, items: [{ id: "image-turn", completed: true,
      messages: [{ role: "user", itemId: "image-user", text: "Synthetic attached image", submittedAt,
        attachments: [image, { id: "missing-file", name: "missing.txt", missing: true }] }] }] } });
});
