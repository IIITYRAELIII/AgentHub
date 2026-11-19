import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, snapshot, applyFixtureSnapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

test("complete WebView client schedules long operation budgets and the ordinary read budget", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = await openClientEventFixture(page);
    await page.evaluate(() => {
      let lastDelay;
      const timer = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => { lastDelay = delay; return timer(callback, delay, ...args); };
      window.__controlBudgets = [];
      const bridge = window.__fixtureBridge;
      const post = bridge.postMessage.bind(bridge);
      bridge.postMessage = message => {
        if (message.type === "agenthub:control") window.__controlBudgets.push({ action: message.action, delay: lastDelay });
        return post(message);
      };
      window.__dispatchClientFixture("bug-report:submit", { text: "Synthetic report", attachments: [], reportId: "fixture-report" });
      window.__dispatchClientFixture("model-catalog:refresh");
      window.__dispatchClientFixture("connection:retry");
    });
    await page.waitForFunction(() => ["submit-bug-report", "refresh-model-catalog", "snapshot"].every(action => window.__controlBudgets.some(value => value.action === action)));
    const budgets = await page.evaluate(() => Object.fromEntries(window.__controlBudgets.filter(value =>
      ["submit-bug-report", "refresh-model-catalog", "snapshot"].includes(value.action)).map(value => [value.action, value.delay])));
    assert.deepEqual(budgets, { "submit-bug-report": 180_000, "refresh-model-catalog": 180_000, snapshot: 45_000 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("complete client keeps idle and occupied polling cadence through public refresh events", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = await openClientEventFixture(page);
    await page.evaluate(() => {
      const timer = window.setTimeout.bind(window);
      window.__scheduledPolls = [];
      window.setTimeout = (callback, delay, ...args) => {
        window.__scheduledPolls.push(delay);
        return timer(callback, delay, ...args);
      };
    });
    for (const [state, delay] of [[{}, 5000], [{ running: true }, 1200], [{ activityUnknown: true }, 1200],
      [{ context: { compacting: true } }, 1200], [{ maintenance: {} }, 1200]]) {
      const value = snapshot();
      value.version = `poll-${JSON.stringify(state)}`;
      Object.assign(value.tasks[0], state);
      await applyFixtureSnapshot(page, value);
      await page.evaluate(() => { window.__scheduledPolls.length = 0; window.__dispatchClientFixture("connection:retry"); });
      await page.waitForFunction(expected => window.__scheduledPolls.includes(expected), delay);
      assert.ok((await page.evaluate(() => window.__scheduledPolls)).includes(delay));
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("rendered active duration begins at provider acceptance and advances without a new snapshot", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const value = snapshot();
    const startedAt = new Date(Date.now() - 180_000).toISOString();
    const acceptedAt = new Date(Date.now() - 61_000).toISOString();
    value.tasks[0] = { ...value.tasks[0], running: true, run: { id: "timed-run", turnId: "timed-turn",
      operationKind: "user-turn", projectionState: "active", startedAt, stage: "Working",
      providerStart: { state: "queued", turnId: "timed-turn" } } };
    const errors = await openClientEventFixture(page, { fixtureSnapshot: value });
    assert.equal(await page.locator("[data-task-started-at]").count(), 0, "queued provider launch has no active duration");
    const active = structuredClone(value);
    active.version = "provider-accepted-duration";
    active.tasks[0].run.providerStart = { state: "observed", turnId: "timed-turn", acceptedAt };
    await applyFixtureSnapshot(page, active);
    await page.waitForFunction(time => [...document.querySelectorAll("[data-task-started-at]")].some(node => node.dataset.taskStartedAt === time), acceptedAt);
    const timer = page.locator(".task-time[data-task-started-at]").first();
    const before = await timer.textContent();
    await page.waitForFunction(text => document.querySelector(".task-time[data-task-started-at]")?.textContent !== text, before, { timeout: 3000 });
    const completed = structuredClone(active);
    completed.version = "completed-duration";
    completed.tasks[0].running = false;
    completed.tasks[0].run.projectionState = "completed";
    await applyFixtureSnapshot(page, completed);
    await page.waitForFunction(() => document.querySelectorAll("[data-task-started-at]").length === 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("rename uses the emitted target rather than the selected chat and preserves Workspace ownership", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  let page;
  try {
    page = await browser.newPage();
    const value = snapshot();
    delete value.tasks[1].workspaceId;
    const errors = await openClientEventFixture(page, { fixtureSnapshot: value });
    await page.evaluate(async () => {
      window.__renames = [];
      const post = window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
      window.__fixtureBridge.postMessage = message => {
        if (["rename-workspace", "rename-task"].includes(message.action)) {
          window.__renames.push({ action: message.action, params: message.params });
          return window.postMessage({ type: "agenthub:control-result", id: message.id, ok: false, error: "Synthetic rename refusal" }, "*");
        }
        return post(message);
      };
      await window.__dispatchClientFixture("task:rename", { id: "stream-b", title: "Target Thread title" });
    });
    await page.waitForFunction(() => window.__renames.length === 1);
    let call = (await page.evaluate(() => window.__renames))[0];
    assert.equal(call.action, "rename-task");
    assert.equal(call.params.streamId, "stream-b");
    assert.equal(call.params.threadId, "thread-b");
    assert.equal(call.params.title, "Target Thread title");
    await page.evaluate(() => window.__dispatchClientFixture("task:rename", { id: "stream-a", title: "Workspace title" }));
    await page.waitForFunction(() => window.__renames.length === 2);
    call = (await page.evaluate(() => window.__renames))[1];
    assert.equal(call.action, "rename-workspace");
    assert.equal(call.params.workspaceId, "workspace-1");
    assert.equal(call.params.name, "Workspace title");
    assert.deepEqual(errors, []);
  } finally { await page?.unrouteAll({ behavior: "wait" }); await browser.close(); }
});

test("complete Web client reloads its document after the published runtime identity changes", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  let page;
  try {
    page = await browser.newPage();
    const errors = await openClientEventFixture(page, { surface: "web" });
    const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() });
    await page.evaluate(() => {
      const value = structuredClone(window.__agentHubFixture.snapshot);
      value.version = "new-published-runtime";
      value.server.process = { instanceId: "new-instance", releaseId: "new-release" };
      window.__agentHubFixture.snapshot = value;
      localStorage.setItem("fixture:snapshot", JSON.stringify(value));
      window.__dispatchClientFixture("connection:retry");
    });
    await navigation;
    await page.waitForFunction(() => window.__agentHubFixture?.snapshot?.server?.process?.releaseId === "new-release" && window.AgentHub);
    assert.equal(page.url(), "http://agent-hub.test/");
    assert.deepEqual(errors, []);
  } finally {
    await page?.unrouteAll({ behavior: "wait" });
    await browser.close();
  }
});

test("a newly created Workspace selects its exact chat and route from the creation result", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  let page;
  try {
    page = await browser.newPage();
    const errors = await openClientEventFixture(page);
    await page.evaluate(async () => {
      const post = window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
      window.__fixtureBridge.postMessage = message => {
        if (message.action !== "new-task") return post(message);
        window.__newTaskParams = message.params;
        const value = structuredClone(window.__agentHubFixture.snapshot);
        value.version = "created-workspace";
        value.tasks.forEach(task => { task.selected = false; });
        value.tasks.push({ ...value.tasks[0], provider: "claude", threadId: "created-thread", streamId: "created-stream",
          workspaceId: "created-workspace", workspaceName: "New Workspace", streamName: "Created Stream", streamDisplayName: "Created Stream", selected: true });
        value.workspaces.push({ id: "created-workspace", name: "New Workspace", streams: [
          { id: "created-stream", name: "Created Stream", displayName: "Created Stream", ordinal: 1, threads: [{ id: "created-thread" }] }] });
        value.selected = { provider: "claude", threadId: "created-thread", streamId: "created-stream" };
        window.__agentHubFixture.snapshot = value;
        return window.postMessage({ type: "agenthub:control-result", id: message.id, ok: true, result: value }, "*");
      };
      await window.__dispatchClientFixture("task:new", { title: "New Workspace", provider: "claude" });
    });
    await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "created-stream");
    assert.equal((await page.evaluate(() => window.__newTaskParams)).workspaceName, "New Workspace");
    assert.equal((await page.evaluate(() => window.__newTaskParams)).provider, "claude");
    assert.equal(new URL(page.url()).hash, "#/chat/stream/created-stream");
    assert.equal(await page.locator("[data-composer-input]").isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await page?.unrouteAll({ behavior: "wait" }); await browser.close(); }
});
