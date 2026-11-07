import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

const { loadThemeRegistry, renderThemeHtml } = createRequire(import.meta.url)("../../theme-registry.cjs");

test("replacing a single chat releases closed history and reopening reloads its canonical page", async (t) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await page.addInitScript(() => {
      // This scenario exercises a manual Pulsar selection after the one-time migration.
      localStorage.setItem("agent-hub:theme-migration:nexus", "done");
      localStorage.setItem("agent-hub-theme", "pulsar");
    });
    const initial = snapshot();
    const prototype = initial.tasks[0];
    initial.tasks = Array.from({ length: 8 }, (_, index) => ({ ...prototype,
      streamId: `retention-${index}`, threadId: `retention-thread-${index}`,
      streamName: `Chat ${index}`, streamDisplayName: `Chat ${index}`, streamOrdinal: index + 1,
      selected: index === 0,
    }));
    initial.workspaces[0].streams = initial.tasks.map((entry) => ({
      id: entry.streamId, name: entry.streamName, ordinal: entry.streamOrdinal,
      threads: [{ id: entry.threadId }],
    }));
    initial.selected = { ...initial.selected, streamId: initial.tasks[0].streamId,
      threadId: initial.tasks[0].threadId };
    const webRoot = process.env.AGENT_HUB_TEST_WEB_APP_ROOT
      ? pathToFileURL(`${process.env.AGENT_HUB_TEST_WEB_APP_ROOT}/`)
      : new URL("../../assets/web-app/", import.meta.url);
    const html = renderThemeHtml(await readFile(new URL("index.html", webRoot), "utf8"),
      loadThemeRegistry(fileURLToPath(webRoot)));
    const errors = await openFixture(page, { fixtureSnapshot: initial, expectedTaskId: "retention-0",
      assetOverrides: { "index.html": html } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const before = (await cdp.send("Performance.getMetrics")).metrics;
    for (let index = 0; index < 8; index += 1) {
      await page.evaluate((i) => {
        window.__agentHubFixture.history = { provider: "codex", streamId: `retention-${i}`,
          threadId: `retention-thread-${i}`, start: 0, end: 20, total: 20, messageTotal: 40,
          nextBefore: null, version: `history-${i}`,
          items: Array.from({ length: 20 }, (_, turn) => ({ id: `turn-${i}-${turn}`, completed: true, terminalRevision: 1,
            activities: turn === 19 ? [{ type: "command", label: "Completed action",
              detail: (`Private closed command output ${i}. `).repeat(12000) }] : [],
            messages: [{ role: "user", itemId: `user-${i}-${turn}`, text: `Question ${i}/${turn}` },
              { role: "agent", itemId: `final-${i}-${turn}`, phase: "final", text: `Answer ${i}` }] })),
        };
        window.AgentHub.openStream("workspace-1", `retention-${i}`);
      }, index);
      await page.waitForFunction((i) => document.querySelector("[data-chat-log]")?.textContent.includes(`Answer ${i}`), index);
    }
    await page.evaluate(() => { window.__agentHubFixture.history = null; });
    await cdp.send("HeapProfiler.collectGarbage");
    const metrics = (await cdp.send("Performance.getMetrics")).metrics;
    const prototypeHandle = await cdp.send("Runtime.evaluate", { expression: "Object.prototype" });
    const objects = await cdp.send("Runtime.queryObjects", { prototypeObjectId: prototypeHandle.result.objectId });
    let alive;
    try {
      const result = await cdp.send("Runtime.callFunctionOn", { objectId: objects.objects.objectId,
        functionDeclaration: `function () { return [...new Set(this.filter(value =>
          value?.provider === 'codex' && /^retention-thread-[0-7]$/.test(value?.threadId)
          && /^Answer [0-7]$/.test(value?.text)).map(value => value.threadId))].sort(); }`,
        returnByValue: true });
      alive = result.result.value;
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: objects.objects.objectId });
      await cdp.send("Runtime.releaseObject", { objectId: prototypeHandle.result.objectId });
    }
    const metric = (values, name) => values.find((entry) => entry.name === name)?.value ?? 0;
    t.diagnostic(JSON.stringify({ retainedThreads: alive, heapBytes: metric(metrics, "JSHeapUsedSize"),
      taskSeconds: metric(metrics, "TaskDuration") - metric(before, "TaskDuration"),
      scriptSeconds: metric(metrics, "ScriptDuration") - metric(before, "ScriptDuration"),
      nodes: (await cdp.send("Memory.getDOMCounters")).nodes }));
    assert.deepEqual(alive, ["retention-thread-7"], "closed canonical messages must become collectible; the open chat stays owned");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "pulsar");
    assert.equal(await page.locator("[data-chat-log] details[open]").count(), 0);
    await page.evaluate(() => {
      window.__agentHubFixture.history = { provider: "codex", streamId: "retention-0",
        threadId: "retention-thread-0", start: 0, end: 1, total: 1, messageTotal: 2,
        nextBefore: null, version: "reopened-current",
        items: [{ id: "turn-0", completed: true, terminalRevision: 2,
          messages: [{ role: "user", itemId: "user-0", text: "Question 0" },
            { role: "agent", itemId: "final-0", phase: "final", text: "Current reopened answer" }] }],
      };
      window.AgentHub.openStream("workspace-1", "retention-0");
    });
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Current reopened answer"));
    assert.equal(await page.locator("[data-chat-log] [data-message-id]").count(), 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("another Workspace's still-open chat retains its older loaded page", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    const initial = snapshot();
    initial.tasks[1].workspaceId = "workspace-2";
    initial.tasks[1].workspaceName = "Other Workspace";
    initial.workspaces[0].streams = initial.workspaces[0].streams.slice(0, 1);
    initial.workspaces.push({ id: "workspace-2", name: "Other Workspace", kind: "project",
      streams: [{ id: "stream-b", name: "Stream B", ordinal: 1, threads: [{ id: "thread-b" }] }] });
    const turn = (id, answer) => ({ id, completed: true, terminalRevision: 1,
      messages: [{ role: "user", itemId: `${id}-user`, text: `Question ${id}` },
        { role: "agent", itemId: `${id}-final`, phase: "final", text: answer }] });
    const histories = {
      "stream-a": { provider: "codex", streamId: "stream-a", threadId: "thread-a",
        start: 0, end: 2, total: 2, messageTotal: 4, nextBefore: null, version: "older-loaded",
        items: [turn("older-a", "Older retained answer A"), turn("newer-a", "Newest answer A")] },
      "stream-b": { provider: "codex", streamId: "stream-b", threadId: "thread-b",
        start: 0, end: 1, total: 1, messageTotal: 2, nextBefore: null, version: "other-workspace",
        items: [turn("turn-b", "Other Workspace answer")] },
    };
    const errors = await openFixture(page, { fixtureSnapshot: initial, fixtureHistory: histories["stream-a"] });
    await page.evaluate((values) => {
      window.__workspaceHistories = values;
      const original = window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
      window.__fixtureBridge.postMessage = (message) => {
        if (["open-task", "task-history"].includes(message.action)) {
          window.__agentHubFixture.history = window.__workspaceHistories[message.params.streamId];
        }
        return original(message);
      };
      window.AgentHub.openStream("workspace-1", "stream-a");
    }, histories);
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Older retained answer A"));
    await page.evaluate(() => window.AgentHub.openStream("workspace-2", "stream-b"));
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Other Workspace answer"));
    await page.evaluate(() => {
      const newest = window.__workspaceHistories["stream-a"];
      newest.start = 1;
      newest.items = newest.items.slice(1);
      newest.version = "newest-only";
      window.AgentHub.openStream("workspace-1", "stream-a");
    });
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Newest answer A"));
    assert.ok((await page.locator("[data-chat-log]").textContent()).includes("Older retained answer A"),
      "switching Workspace does not close that Workspace's open column or discard its older page");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("open parallel history survives while a late closed-page response cannot refill its cache", { timeout: 30_000 }, async (t) => {
  const browser = await launchBrowser();
  let release;
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    page.setDefaultTimeout(5000);
    const initial = snapshot();
    const history = (suffix, answer) => ({ provider: "codex", streamId: `stream-${suffix}`,
      threadId: `thread-${suffix}`, start: 0, end: 1, total: 1, messageTotal: 2,
      nextBefore: null, version: `history-${answer}`,
      items: [{ id: `turn-${suffix}`, completed: true, terminalRevision: 1,
        messages: [{ role: "user", itemId: `user-${suffix}`, text: `Question ${suffix}` },
          { role: "agent", itemId: `final-${suffix}`, phase: "final", text: answer }] }],
    });
    await openFixture(page, { surface: "web", fixtureSnapshot: initial, fixtureHistory: history("a", "Parallel answer A") });
    t.diagnostic("parallel fixture opened");
    await page.evaluate((histories) => {
      const original = window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
      window.__fixtureBridge.postMessage = (message) => {
        if (["open-task", "task-history"].includes(message.action)) {
          window.__agentHubFixture.history = histories[message.params.streamId];
        }
        return original(message);
      };
    }, { "stream-a": history("a", "Parallel answer A"), "stream-b": history("b", "Parallel answer B") });
    await page.locator("[data-stream-task-id='stream-a']:visible").first().click();
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Parallel answer A"));
    t.diagnostic("first canonical history rendered");
    await page.evaluate((value) => { window.__agentHubFixture.history = value; }, history("b", "Parallel answer B"));
    await page.locator("[data-stream-task-id='stream-b']:visible").first().click({ modifiers: ["Control"] });
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Parallel answer B"));
    t.diagnostic("second canonical history rendered");
    t.diagnostic(await page.locator(".stream-chat-preview").textContent());
    await page.waitForFunction(() => document.querySelector(".stream-chat-preview")?.textContent.includes("Parallel answer A"));
    t.diagnostic("retained parallel history rendered");
    let started;
    const held = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/control", async (route) => {
      const request = route.request().postDataJSON();
      if (request.action !== "task-history" || request.params.streamId !== "stream-a") return route.fallback();
      started();
      await gate;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true,
        result: history("a", "Late closed answer A") }) });
    });
    const next = structuredClone(initial);
    next.version = "parallel-final-refresh";
    next.selected = { ...next.selected, streamId: "stream-b", threadId: "thread-b" };
    next.tasks[0].latestFinal = { provider: "codex", threadId: "thread-a", turnId: "turn-a", revision: 1 };
    next.tasks[0].lastAnswerTurnId = "turn-a";
    next.tasks[0].unread = true;
    await page.evaluate((value) => {
      window.__agentHubFixture.snapshot = value;
      document.querySelector("[data-provider-connection-retry]").click();
    }, next);
    await held;
    t.diagnostic("new final snapshot dispatched the held history read");
    await page.locator("[data-stream-task-id='stream-a']:visible").first().click({ modifiers: ["Control"] });
    await page.waitForFunction(() => document.querySelectorAll(".stream-chat-preview").length === 0);
    release();
    await page.waitForFunction(() => !document.querySelector("[data-history-loading]"));
    assert.ok((await page.locator("[data-chat-log]").textContent()).includes("Parallel answer B"));
    assert.equal(await page.getByText("Late closed answer A", { exact: true }).count(), 0);
    assert.equal((await page.evaluate(() => window.__agentHubFixture.log))
      .filter((entry) => entry.action === "mark-task-read" && entry.params.final?.threadId === "thread-a").length, 0,
    "an offscreen late final is not read evidence");
  } finally { release?.(); await browser.close(); }
});
