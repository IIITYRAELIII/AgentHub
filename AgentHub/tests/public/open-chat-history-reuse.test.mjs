import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";
import { TaskReadStateStore, taskHasUnreadAnswer } from "../../src/infrastructure/persistence/task-read-state-store.mjs";
import { DesktopReadModelService } from "../../src/interfaces/desktop/desktop-read-model-service.mjs";

const assetOverrides = process.env.AGENT_HUB_TEST_OVERRIDE_WEB_APP_ROOT
  ? Object.fromEntries(await Promise.all(["app.js", "hub-client.js"].map(async name => [name,
    await readFile(path.join(process.env.AGENT_HUB_TEST_OVERRIDE_WEB_APP_ROOT, name)),
  ]))) : {};

const history = (suffix, revision = 1) => ({
  streamId: `stream-${suffix}`, provider: "codex", threadId: `thread-${suffix}`,
  start: 0, end: 12, total: 12, messageTotal: 24, nextBefore: null,
  version: `history-${suffix}-${revision}`,
  items: Array.from({ length: 12 }, (_, index) => ({
    id: `turn-${suffix}-${index}`, completed: true, terminalRevision: revision,
    messages: [{ role: "user", itemId: `user-${suffix}-${index}`, text: `Question ${suffix}/${index}` },
      { role: "agent", itemId: `final-${suffix}-${index}`, phase: "final",
        text: `Loaded answer ${suffix}/${index}${revision > 1 ? ` revision ${revision}` : ""}\n\n${"Retained complete text. ".repeat(30)}` }],
  })),
});

test("cached navigation paints before selection; a new final clears only after exact painted SQLite read ACK", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-retained-read-"));
  const store = new TaskReadStateStore({ dataDir: directory });
  let revision = 1;
  let sequence = 0;
  let holdAck = false;
  let releaseAck;
  const ackGate = new Promise(resolve => { releaseAck = resolve; });
  const serverReads = [];
  const completedAt = "2026-11-05T00:00:00.000Z";
  const service = new DesktopReadModelService({
    resolveReadTask: ({ provider, threadId }) => snapshot().tasks.find(task => task.provider === provider && task.threadId === threadId),
    readStateStore: store, trustedDeviceUserId: () => "fixture-user", hasUnread: taskHasUnreadAnswer,
    lastTaskMessage: task => task.threadId === "thread-b" ? {
      provider: "codex", threadId: "thread-b", turnId: "turn-b-11", terminalRevision: revision, updatedAt: completedAt,
    } : null,
    snapshot: ({ projectTask = x => x } = {}) => {
      const value = snapshot();
      return { ...value, version: `retained-read-${++sequence}`, tasks: value.tasks.map(projectTask) };
    },
  });
  const browser = await launchBrowser();
  try {
    await store.initialize();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const traceBatches = [];
    await page.exposeFunction("__retainedReadAck", async params => {
      const row = { params, admittedAt: Date.now() }; serverReads.push(row);
      if (holdAck) await ackGate;
      row.result = await service.markTaskRead(params);
      row.completedAt = Date.now();
      return row.result;
    });
    await page.addInitScript(() => {
      let bridge;
      window.__critical = { reads: [], held: [], hold: false, acknowledgements: [] };
      Object.defineProperty(window, "__fixtureBridge", {
        configurable: true, get: () => bridge,
        set(value) {
          bridge = value;
          const original = value.postMessage.bind(value);
          const respond = (m, result) => window.dispatchEvent(new MessageEvent("message", {
            data: { type: "agenthub:control-result", id: m.id, ok: true, result },
          }));
          window.__critical.respond = respond;
          value.postMessage = message => {
            const p = window.__critical;
            if (message.action === "mark-task-read") {
              p.acknowledgements.push({ params: message.params, at: performance.now(),
                renderedRevision: [...document.querySelectorAll("[data-chat-log] [data-turn-id='turn-b-11']")]
                  .map(node => Number(node.dataset.terminalRevision)).filter(Boolean) });
              void window.__retainedReadAck(message.params).then(result => respond(message, result));
              return;
            }
            if (["open-task", "task-history", "select-task"].includes(message.action)) {
              p.reads.push({ action: message.action, params: message.params, at: performance.now() });
              if (p.hold && message.params.streamId === "stream-b") { p.held.push(message); return; }
              if (message.action === "select-task") { queueMicrotask(() => respond(message, window.__agentHubFixture.snapshot)); return; }
              window.__agentHubFixture.history = p.histories?.[message.params.streamId]
                ?? window.__agentHubFixture.history;
            }
            return original(message);
          };
        },
      });
    });
    const errors = await openFixture(page, { surface: "web", fixtureSnapshot: await service.snapshot(), fixtureHistory: history("a"), assetOverrides });
    await page.route("**/api/command-trace/client-events", async route => {
      traceBatches.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await page.evaluate(histories => { window.__critical.histories = histories; }, { "stream-a": history("a"), "stream-b": history("b") });
    const click = suffix => page.locator(`.stream-tabs-track [data-stream-tab-id="stream-${suffix}"]`).click();
    await click("b");
    await page.getByText("Loaded answer b/11", { exact: false }).first().waitFor();
    await page.waitForFunction(() => window.__critical.acknowledgements.length === 1);
    await page.waitForFunction(() => !document.querySelector(".stream-tabs-track [data-stream-task-id='stream-b']").hasAttribute("data-answer-ready"));
    await click("a");
    await page.getByText("Loaded answer a/11", { exact: false }).first().waitFor();
    revision = 2;
    holdAck = true;
    await page.evaluate(value => {
      window.__agentHubFixture.snapshot = value;
      document.querySelector("[data-provider-connection-retry]").click();
    }, await service.snapshot());
    await page.waitForFunction(() => document.querySelector(".stream-tabs-track [data-stream-task-id='stream-b']").hasAttribute("data-answer-ready"));
    await page.evaluate(() => { window.__critical.hold = true; });
    const started = await page.evaluate(() => performance.now());
    await click("b");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const cached = await page.evaluate(start => ({ elapsedMs: performance.now() - start,
      visible: document.querySelector("[data-chat-log]").textContent.includes("Loaded answer b/11"),
      acks: window.__critical.acknowledgements.length,
      badge: document.querySelector(".stream-tabs-track [data-stream-task-id='stream-b']").hasAttribute("data-answer-ready"),
      held: window.__critical.held.map(m => ({ action: m.action, knownVersion: m.params.knownVersion ?? null })),
    }), started);
    assert.equal(cached.visible, true, "old complete page paints while both selection and conditional refresh are held");
    assert.equal(cached.acks, 1, "cached revision1 is not display evidence for unseen revision2");
    assert.equal(cached.badge, true);
    await page.waitForFunction(() => window.__critical.held.some(m => m.action === "task-history"));
    await page.evaluate(body => {
      const p = window.__critical;
      p.respond(p.held.find(m => m.action === "task-history"), body);
    }, history("b", 2));
    await page.getByText("Loaded answer b/11 revision 2", { exact: false }).first().waitFor();
    await page.waitForFunction(() => window.__critical.acknowledgements.length === 2);
    const painted = await page.evaluate(start => ({ elapsedMs: performance.now() - start,
      badge: document.querySelector(".stream-tabs-track [data-stream-task-id='stream-b']").hasAttribute("data-answer-ready"),
      acknowledgement: window.__critical.acknowledgements[1],
    }), started);
    assert.equal(painted.badge, true, "a displayed final alone cannot clear before its durable exact receipt");
    assert.equal(serverReads[1].result, undefined);
    assert.equal(painted.acknowledgement.params.final.revision, 2);
    assert.ok(painted.acknowledgement.renderedRevision.includes(2));
    releaseAck();
    await page.waitForFunction(() => !document.querySelector(".stream-tabs-track [data-stream-task-id='stream-b']").hasAttribute("data-answer-ready"));
    const clearedAtMs = await page.evaluate(start => performance.now() - start, started);
    const durable = await service.snapshot();
    assert.equal(durable.tasks.find(task => task.threadId === "thread-b").unread, false);
    assert.equal(serverReads[1].result.marked, true);
    assert.notEqual(serverReads[0].params.clientTraceId, serverReads[1].params.clientTraceId);
    for (let batch = 0; batch < 16; batch += 1) {
      await page.waitForFunction(() => !window.AgentHubCommandTrace.diagnostics().flushing);
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
      if (await page.evaluate(() => window.AgentHubCommandTrace.diagnostics().pending === 0)) break;
    }
    const events = traceBatches.flatMap(batch => batch.events ?? []);
    const ackId = serverReads[1].params.clientTraceId;
    const ackEvents = events.filter(event => event.commandId === ackId);
    assert.ok(ackEvents.some(event => event.metadata?.action === "read-marker-view" && event.metadata?.render === "viewed"));
    assert.ok(ackEvents.some(event => event.metadata?.action === "read-marker-receipt" && event.metadata?.render === "confirmed"));
    assert.ok(ackEvents.some(event => event.metadata?.action === "read-marker-clear" && event.outcome === "succeeded"));
    assert.ok(events.some(event => event.metadata?.action === "history-page-paint"
      && event.metadata?.clientAssetRevision === "hub414.history.1" && event.outcome === "succeeded"));
    assert.doesNotMatch(JSON.stringify(events), /Loaded answer|Retained complete text|Question b/);
    t.diagnostic(JSON.stringify({ cached, painted, clearedAtMs, serverReads, errors }));
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await mkdir(process.env.AGENT_HUB_UI_EVIDENCE_DIR, { recursive: true });
      await writeFile(path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, "read-critical-path.json"),
        JSON.stringify({ cached, painted, clearedAtMs, serverReads, ackEvents, errors }, null, 2));
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, "exact-read-confirmed.png") });
    }
    assert.deepEqual(errors, []);
  } finally {
    releaseAck();
    await browser.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recent canonical windows stay bounded and explicit close fences its late read", { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    page.setDefaultTimeout(5000);
    const initial = snapshot();
    const prototype = initial.tasks[0];
    initial.tasks = Array.from({ length: 8 }, (_, index) => ({ ...prototype,
      streamId: `stream-${index}`, threadId: `thread-${index}`,
      streamName: `Chat ${index}`, streamDisplayName: `Chat ${index}`, streamOrdinal: index + 1,
      selected: index === 0,
    }));
    initial.workspaces[0].streams = initial.tasks.map(task => ({ id: task.streamId,
      name: task.streamName, ordinal: task.streamOrdinal, threads: [{ id: task.threadId }] }));
    initial.selected = { ...initial.selected, streamId: "stream-0", threadId: "thread-0" };
    const errors = await openFixture(page, { surface: "web", fixtureSnapshot: initial,
      fixtureHistory: history("0"), expectedTaskId: "stream-0", assetOverrides });
    await page.evaluate(histories => {
      const p = window.__bounds = { histories, held: [], hold: false, released: [], reads: [] };
      const release = window.AgentHub.releaseTaskHistory.bind(window.AgentHub);
      window.AgentHub.releaseTaskHistory = id => {
        const result = release(id);
        if (result) p.released.push(id);
        return result;
      };
      const original = window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
      const respond = (m, result) => window.dispatchEvent(new MessageEvent("message", {
        data: { type: "agenthub:control-result", id: m.id, ok: true, result },
      }));
      p.respond = respond;
      window.__fixtureBridge.postMessage = m => {
        if (["open-task", "task-history", "select-task"].includes(m.action)) {
          p.reads.push({ action: m.action, streamId: m.params.streamId });
          if (p.hold) { p.held.push(m); return; }
          if (m.action === "select-task") { queueMicrotask(() => respond(m, window.__agentHubFixture.snapshot)); return; }
          window.__agentHubFixture.history = p.histories[m.params.streamId];
        }
        return original(m);
      };
    }, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`stream-${i}`, history(String(i))])));
    const click = (id, options) => page.locator(`.stream-tabs-track [data-stream-tab-id="stream-${id}"]`).click(options);
    for (let i = 1; i < 8; i += 1) {
      await click(i);
      await page.getByText(`Loaded answer ${i}/11`, { exact: false }).first().waitFor();
    }
    assert.deepEqual(await page.evaluate(() => [...new Set(window.__bounds.released)].sort()),
      ["stream-0", "stream-1", "stream-2", "stream-3"], "only the existing four-page recent working set survives replacement");
    await page.evaluate(() => { window.__bounds.hold = true; });
    await click(4);
    await page.getByText("Loaded answer 4/11", { exact: false }).first().waitFor();
    assert.equal(await page.evaluate(() => window.__bounds.held.some(m => m.action === "open-task")), false);
    await click(7, { modifiers: ["Control"] });
    await click(4, { modifiers: ["Control"] });
    await page.waitForFunction(() => window.__bounds.released.includes("stream-4"));
    await page.evaluate(body => {
      const p = window.__bounds;
      for (const m of p.held.filter(m => m.action === "task-history" && m.params.streamId === "stream-4")) p.respond(m, body);
    }, { ...history("4", 2), items: [{ id: "late-turn", completed: true, terminalRevision: 2,
      messages: [{ role: "agent", itemId: "late-final", phase: "final", text: "Late closed answer" }] }] });
    await click(4);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText("Loaded answer 4/11", { exact: false }).count(), 0);
    assert.equal(await page.getByText("Late closed answer", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__bounds.held.some(m => m.params.streamId === "stream-4"
      && (m.action === "open-task" || (m.action === "task-history" && m.params.includeActive == null)))), true,
    "an explicitly closed page needs a fresh canonical read before it can reappear");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("A-B-A-B reuses loaded canonical history before an unavailable selection response", { timeout: 30000 }, async (t) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = await openFixture(page, { surface: "web", fixtureSnapshot: snapshot(), fixtureHistory: history("a"), assetOverrides });
    await page.getByText("Loaded answer a/11", { exact: false }).first().waitFor();
    await page.evaluate((histories) => {
      const bridge = window.__fixtureBridge;
      const original = bridge.postMessage.bind(bridge);
      window.__reuse = { histories, hold: false, held: [], reads: [], clicks: [] };
      bridge.postMessage = (message) => {
        const p = window.__reuse;
        if (["open-task", "task-history", "select-task"].includes(message.action)) {
          p.reads.push({ action: message.action, params: message.params, at: performance.now() });
          if (p.hold) { p.held.push(message); return; }
          if (message.action === "select-task") {
            queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", {
              data: { type: "agenthub:control-result", id: message.id, ok: true, result: window.__agentHubFixture.snapshot },
            })));
            return;
          }
          window.__agentHubFixture.history = p.histories[message.params.streamId];
        }
        return original(message);
      };
      window.__reuse.release = () => {
        for (const message of window.__reuse.held.splice(0)) {
          if (message.action === "select-task") {
            window.dispatchEvent(new MessageEvent("message", { data: {
              type: "agenthub:control-result", id: message.id, ok: true, result: window.__agentHubFixture.snapshot,
            } }));
            continue;
          }
          window.__agentHubFixture.history = window.__reuse.histories[message.params.streamId];
          original(message);
        }
      };
    }, { "stream-a": history("a"), "stream-b": history("b") });
    const click = (suffix) => page.locator(`.stream-tabs-track [data-stream-tab-id="stream-${suffix}"]`).click();
    await click("b");
    await page.getByText("Loaded answer b/11", { exact: false }).first().waitFor();
    const coldRequests = await page.evaluate(() => window.__reuse.reads.filter(row => row.params.streamId === "stream-b")
      .map(row => ({ action: row.action, knownVersion: row.params.knownVersion ?? "" })));
    t.diagnostic(JSON.stringify({ coldRequests }));
    assert.equal(coldRequests.filter(row => row.action === "open-task" || !row.knownVersion).length, 1,
      "the cold page has one full-read owner; later conditional freshness checks remain allowed");
    await page.locator("[data-chat-scroll]").evaluate(node => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      node.scrollTop = Math.floor(node.scrollHeight / 3);
    });
    const expectedScrollB = await page.locator("[data-chat-scroll]").evaluate(node => node.scrollTop);
    await page.evaluate(() => { window.__reuse.hold = true; });
    const evidence = [];
    for (const suffix of ["a", "b"]) {
      const start = await page.evaluate(() => performance.now());
      await click(suffix);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      evidence.push(await page.evaluate(({ suffix, start }) => ({
        suffix, elapsedMs: performance.now() - start,
        hasLoadedText: document.querySelector("[data-chat-log]").textContent.includes(`Loaded answer ${suffix}/11`),
        scrollTop: document.querySelector("[data-chat-scroll]").scrollTop,
        held: window.__reuse.held.map(m => ({ action: m.action, streamId: m.params.streamId })),
      }), { suffix, start }));
    }
    t.diagnostic(JSON.stringify({ coldRequests, evidence, expectedScrollB, errors }));
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await mkdir(process.env.AGENT_HUB_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, "retained-chat-switch.png") });
      await writeFile(path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, "retained-chat-switch.json"),
        JSON.stringify({ url: page.url(), title: await page.title(), viewport: page.viewportSize(), coldRequests, evidence, expectedScrollB, errors }, null, 2));
    }
    assert.deepEqual(evidence.map(row => row.hasLoadedText), [true, true], "both previously loaded chats must paint while selection/history I/O is held");
    assert.ok(Math.abs(evidence[1].scrollTop - expectedScrollB) <= 2, "returning to a loaded page preserves its scroll position");
    assert.equal(evidence[1].held.some(row => row.action === "open-task"), false, "cached repeats do not request another complete open-task page");
    await page.evaluate(() => window.__reuse.release());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok((await page.locator("[data-chat-log]").textContent()).includes("Loaded answer b/11"));
    assert.ok(Math.abs(await page.locator("[data-chat-scroll]").evaluate(node => node.scrollTop) - expectedScrollB) <= 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
