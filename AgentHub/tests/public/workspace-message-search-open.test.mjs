import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { DesktopSystemService } from "../../src/interfaces/desktop/desktop-system-service.mjs";
import { DesktopTaskService } from "../../src/interfaces/desktop/desktop-task-service.mjs";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";

const workspaceId = "workspace-1";
const current = { provider: "codex", threadId: "thread-a", streamId: "stream-a", workspaceId };
const former = { ...current, threadId: "thread-old" };
const other = { ...current, threadId: "thread-b", streamId: "stream-b" };
const turn = (suffix, day, text = "workspace needle") => ({
  id: "turn-" + suffix,
  status: "completed",
  completed: true,
  startedAt: `2026-09-${day}T01:00:00Z`,
  completedAt: `2026-09-${day}T01:01:00Z`,
  messages: [{ role: "user", itemId: `user-${suffix}`, text: "Question " + suffix },
    { role: "agent", itemId: `hit-${suffix}`, phase: "commentary", text: text + " " + suffix },
    { role: "agent", itemId: `final-${suffix}`, phase: "final_answer", text: "Answer " + suffix }],
});

async function fixture(t, surface, { preload = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "hub556-search-"));
  const store = new LocalTaskSyncStore({ filePath: path.join(dir, "sync.json"), databaseFile: path.join(dir, "journal.sqlite"), historyLimit: 20 });
  const browser = await launchBrowser();
  const indexing = Promise.withResolvers();
  const releaseIndex = indexing.resolve;
  const release = [];
  let search;
  t.after(async () => {
    releaseIndex();
    for (const open of release) open();
    try { await browser.close(); } finally {
      try { await search?.messageSearchIndexTail; } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
  await store.load();
  const historical = turn("historical", "01");
  const intermediate = turn("intermediate", "02");
  const currentTurns = Array.from({ length: 42 }, (_, i) => turn("recent-" + i, "03"));
  if (preload) {
    currentTurns[22].messages[0].text = "indexed user target";
    currentTurns[23].messages.unshift({ role: "user", itemId: "extra-user", text: "Another user item" });
  }
  const otherTurn = turn("other", "04");
  await store.recordHistory(former, [historical]);
  await store.recordHistory(current, [intermediate, ...currentTurns]);
  await store.recordHistory(other, [otherTurn]);
  store.markMessageSearchThread(former);
  store.markMessageSearchThread(current);
  assert.equal(store.history(current).some(item => item.id === intermediate.id), false);
  const model = snapshot();
  model.workspaces[0].streams[0].threads = [current, former];
  model.workspaces[0].streams[1].threads = [other];
  search = new DesktopSystemService({
    workspaceHierarchy: () => model.workspaces,
    searchMessages: args => store.searchMessages(args),
    messageSearchStatus: refs => store.messageSearchStatus(refs),
    markMessageSearchThread: (ref, status) => store.markMessageSearchThread(ref, status),
    refreshHistory: () => indexing.promise,
  });
  const calls = [];
  const responses = [];
  const held = new Map();
  let unavailableItem = null;
  const threadsForStream = id => id === current.streamId ? [former, current] : [other];
  const taskHistory = createDesktopTaskHistoryFactory({
    selection: { activeProvider: () => current.provider, threadId: () => current.threadId, chatId: () => null },
    catalog: { entries: () => [current, other], threadsForStream },
    historyReader: { readPage: (refs, params) => store.historyPage(refs, params) },
    runs: { forTask: () => null },
    responseBudget: { fit: payload => payload },
  });
  const desktop = new DesktopTaskService({
    catalog: () => [current, other],
    refreshCatalog: async () => [current, other],
    threadsForStream,
    currentThread: id => id === current.streamId ? current : other,
    samePath: (a, b) => a === b,
    searchMessage: params => params.itemId === unavailableItem ? null : store.searchMessage(params),
    readTurn: async () => null,
    taskHistory,
    commandTaskTarget: args => args,
    dispatchCommand: async (_command, args) => ({
      ...model, selected: { ...model.selected, ...args }, tasks: model.tasks.map(task => ({
        ...task, selected: task.streamId === args.streamId,
      })),
    }),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5_000);
  await page.exposeFunction("__hub556Control", async ({ action, params }) => {
    try {
      if (action === "workspace-message-search") return { ok: true, result: await search.workspaceMessageSearch(params) };
      calls.push(params);
      const result = await desktop.openTurn(params);
      if (held.has(params.itemId)) await held.get(params.itemId);
      assert.equal(result.history.streamId, params.streamId);
      assert.equal(result.history.threadId, params.streamId === current.streamId ? current.threadId : other.threadId);
      responses.push(result.focusedMessage.itemId);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  const fixtureHistory = preload ? await taskHistory({ ...current, limit: 20, refreshSource: false }) : null;
  const diagnostics = await openFixture(page, {
    fixtureSnapshot: model, fixtureHistory, surface, directTransport: surface === "web",
  });
  await page.evaluate(() => {
    const bridge = window.__fixtureBridge;
    const post = bridge.postMessage.bind(bridge);
    window.__hub556Sent = [];
    window.__hub556Delivered = [];
    bridge.postMessage = message => {
      if (!["workspace-message-search", "workspace-message-open"].includes(message.action)) return post(message);
      if (message.action === "workspace-message-open") window.__hub556Sent.push(message.params.itemId);
      void window.__hub556Control(message).then(outcome => {
        if (message.action === "workspace-message-open") {
          window.__hub556Delivered.push({ itemId: message.params.itemId, ok: outcome.ok });
        }
        window.dispatchEvent(new MessageEvent("message", {
          data: { ...outcome, id: message.id, type: "agenthub:control-result" },
        }));
      });
    };
  });
  const dialog = page.locator("[data-workspace-message-search]");
  const hit = suffix => dialog.getByRole("button").filter({ hasText: "workspace needle " + suffix });
  const target = suffix => page.locator(`[data-chat-log] [data-item-id="hit-${suffix}"]`);
  const find = async () => {
    await page.locator("[data-workspace-message-search-toggle]").click();
    await dialog.locator("[data-workspace-message-search-input]").fill("workspace needle");
    await dialog.locator("[data-workspace-message-search-result]").first().waitFor();
    assert.match(await dialog.locator("[data-workspace-message-search-status]").textContent(), /2.*3/);
  };
  return { page, dialog, hit, target, find, calls, responses, diagnostics,
    unavailable: itemId => { unavailableItem = itemId; },
    hold: itemId => {
      const gate = Promise.withResolvers();
      held.set(itemId, gate.promise);
      release.push(gate.resolve);
      return gate.resolve;
    },
  };
}

async function exactTarget(f, suffix, provider, threadId) {
  const item = f.target(suffix);
  await item.waitFor();
  assert.equal(await item.getAttribute("data-provider"), provider);
  assert.equal(await item.getAttribute("data-thread-id"), threadId);
  assert.equal(await item.evaluate((node) => {
    const chat = node.closest("[data-chat-scroll]").getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return document.activeElement === node && box.top < chat.bottom && box.bottom > chat.top;
  }), true, "the exact item owns focus and intersects the chat viewport");
  assert.equal(await f.dialog.isVisible(), false);
  assert.deepEqual(f.diagnostics, []);
}

for (const surface of ["web", "vscode"]) {
  test(`workspace search opens a former Thread from page two while indexing in ${surface}`, { timeout: 40_000 }, async t => {
    const f = await fixture(t, surface);
    await f.find();
    await f.dialog.locator("[data-workspace-message-search-more]").click();
    await f.hit("historical").click();
    await exactTarget(f, "historical", former.provider, former.threadId);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].itemId, "hit-historical");
    assert.equal(f.calls[0].taskThreadId, former.threadId);
    assert.deepEqual(f.responses, ["hit-historical"]);
  });
}

test("workspace search coalesces a double click and renders an old indexed item beyond the chat tail", { timeout: 40_000 }, async t => {
  const f = await fixture(t, "web");
  await f.find();
  await f.dialog.locator("[data-workspace-message-search-more]").click();
  const release = f.hold("hit-intermediate");
  await f.hit("intermediate").dblclick();
  await f.page.waitForFunction(() => window.__hub556Sent.length > 0);
  assert.deepEqual(await f.page.evaluate(() => window.__hub556Sent), ["hit-intermediate"],
    "a double click starts one pending transition");
  release();
  await exactTarget(f, "intermediate", current.provider, current.threadId);
});

test("workspace search preserves results on an unavailable hit and commits only the newest click", { timeout: 40_000 }, async t => {
  const f = await fixture(t, "vscode");
  await f.find();
  const oldHit = f.hit("recent-41");
  f.unavailable("hit-other");
  await f.hit("other").click();
  await f.page.locator("[data-toast]").filter({ hasText: /не найдено в индексе/u }).waitFor();
  assert.equal(await f.dialog.isVisible(), true);
  const release = f.hold("hit-recent-41");
  await oldHit.click();
  await f.page.waitForFunction(() => window.__hub556Sent.includes("hit-recent-41"));
  f.unavailable(null);
  await f.hit("other").press("Enter");
  await exactTarget(f, "other", other.provider, other.threadId);
  release();
  await f.page.waitForFunction(() => window.__hub556Delivered.some(value => value.itemId === "hit-recent-41" && value.ok));
  assert.ok((await f.page.evaluate(() => location.hash)).includes("thread-b"));
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.target("recent-41").count(), 0);
  assert.deepEqual(f.responses, ["hit-other", "hit-recent-41"]);
});

test("workspace search retains the indexed item beside another agent message in the same turn", { timeout: 40_000 }, async t => {
  const f = await fixture(t, "web");
  await f.find();
  await f.hit("other").click();
  await f.page.waitForFunction(() => window.__hub556Delivered.some(value => value.itemId === "hit-other" && value.ok));
  assert.deepEqual(f.responses, ["hit-other"]);
  await exactTarget(f, "other", other.provider, other.threadId);
  assert.equal(await f.page.locator("[data-chat-log] [data-item-id=final-other]").count(), 1);
});

test("workspace search renders a user hit from an unchanged cached page beyond the DOM tail", { timeout: 40_000 }, async t => {
  const f = await fixture(t, "web", { preload: true });
  await f.page.locator("[data-chat-log] [data-item-id=final-recent-22]").waitFor();
  const target = f.page.locator("[data-chat-log] [data-item-id=user-recent-22]");
  assert.equal(await target.count(), 0);
  await f.page.locator("[data-workspace-message-search-toggle]").click();
  await f.dialog.locator("[data-workspace-message-search-input]").fill("indexed user target");
  await f.dialog.getByRole("button").filter({ hasText: "indexed user target" }).click();
  await target.waitFor();
  assert.equal(await target.getAttribute("data-role"), "user");
  assert.equal(await target.evaluate(node => document.activeElement === node), true);
  assert.deepEqual(f.responses, ["user-recent-22"]);
  assert.deepEqual(f.diagnostics, []);
});
