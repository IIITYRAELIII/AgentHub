import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { launchBrowser, openFixture, submit, bridgeCalls } from "./composer-production.fixture.mjs";
import { clientPerformanceTraceSpans } from "../../src/application/client-performance-trace.mjs";

const source = await readFile(new URL("../../assets/web-app/command-trace.js", import.meta.url), "utf8");

function fixture() {
  let clock = 10;
  let sequence = 0;
  const frames = [];
  const timers = [];
  const window = {
    performance: { now: () => clock }, crypto: { randomUUID: () => `trace-${++sequence}` },
    document: { hidden: false, documentElement: { dataset: { view: "chat" } }, addEventListener() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    requestAnimationFrame: (fn) => frames.push(fn), queueMicrotask, addEventListener() {},
  };
  vm.runInNewContext(source, { window, Date });
  return { trace: window.AgentHubCommandTrace, advance: (ms) => { clock += ms; }, frames, timers };
}

test("client trace batches are bounded and do not hold the measured result behind a stalled reporter", async () => {
  const { trace, advance } = fixture();
  let release;
  const batches = [];
  trace.bindReporter((batch) => {
    batches.push(batch);
    return new Promise((resolve) => { release = resolve; });
  });
  const result = trace.measure("ui-control", "snapshot", () => { advance(37); return 42; }, "command-1");
  assert.equal(result, 42);
  const flushing = trace.flush();
  for (let i = 0; i < 400; i += 1) trace.record("ui-render", "messages", i);
  assert.equal(trace.diagnostics().pending, 256);
  assert.equal(trace.diagnostics().droppedCount, 144);
  await trace.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].events[0].monotonicDurationMs, 37);
  release();
  await flushing;
  trace.bindReporter(async (batch) => { batches.push(batch); });
  await trace.flush();
  assert.equal(batches[1].events.length, 32);
});

test("one client trace owner retains command identity, ACK timings and errors without serializing results", async () => {
  const { trace, advance } = fixture();
  const batches = [];
  trace.bindReporter(async (batch) => { batches.push(batch); });
  const secretResult = { snapshot: {}, text: "private-user-text", token: "secret" };
  const result = await trace.measure("ui-control", "send-message", async () => {
    advance(51);
    return trace.associate(secretResult, "original-command");
  }, "original-command");
  assert.equal(result, secretResult);
  assert.equal(trace.objectId(result.snapshot), "original-command");
  const failure = new Error("private-error-content");
  await assert.rejects(trace.measure("ui-control", "snapshot", async () => { throw failure; }), (error) => error === failure);
  trace.ack("original-command", { submittedAtMs: Date.now(), submittedMonotonicMs: 10 }, "succeeded");
  await trace.flush();
  const events = batches.flatMap((batch) => batch.events);
  assert.equal(events[0].monotonicDurationMs, 51);
  assert.equal(events[1].outcome, "failed");
  assert.equal(events[2].commandId, "original-command");
  assert.equal(events[2].stage, "client-ack");
  assert.equal(events[2].timing.clientAckMonotonicMs, 61);
  assert.doesNotMatch(JSON.stringify(events), /private|secret/u);
});

test("shipped UI measures navigation, message ACK, rendering and long main-thread work through one batch endpoint", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const batches = [];
    const legacyAcks = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/command-trace/client-events")) batches.push(request.postDataJSON());
      if (request.url().endsWith("/api/command-trace/client-ack")) legacyAcks.push(request);
    });
    const diagnostics = await openFixture(page);
    assert.equal(page.url(), "http://agent-hub.test/");
    assert.match(await page.title(), /Agent Hub/u);
    await page.locator("[data-view-button='dashboard']").click();
    await page.waitForFunction(() => document.documentElement.dataset.view === "dashboard");
    await page.locator("[data-view-button='chat']").click();
    await page.waitForFunction(() => document.documentElement.dataset.view === "chat");
    await page.evaluate(() => { window.__agentHubFixture.mode = "accept"; });
    await submit(page, { text: "PRIVATE-TRACE-CONTENT-MUST-NOT-LEAK" });
    await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "send-message"));
    await page.evaluate(() => new Promise((resolve) => {
      const observer = new PerformanceObserver(() => { observer.disconnect(); resolve(); });
      observer.observe({ type: "longtask" });
      setTimeout(() => { const end = performance.now() + 90; while (performance.now() < end) {} }, 0);
    }));
    await page.waitForFunction(() => {
      const state = window.AgentHubCommandTrace.diagnostics();
      return state.pending === 0 && !state.flushing && state.reportedCount > 0;
    });
    const events = batches.flatMap((batch) => batch.events);
    const send = (await bridgeCalls(page, "send-message"))[0];
    const commandId = send.params.clientUserMessageId;
    assert.equal(send.params.clientTraceId, commandId);
    assert.ok(events.some((event) => event.stage === "ui-navigation"));
    assert.ok(events.some((event) => event.stage === "ui-snapshot"));
    assert.ok(events.some((event) => event.stage === "ui-render" && event.metadata.action === "messages"));
    assert.ok(events.some((event) => event.stage === "ui-control" && event.commandId === commandId));
    assert.equal(events.filter((event) => event.stage === "client-ack" && event.commandId === commandId).length, 1);
    assert.ok(events.some((event) => event.stage === "ui-render" && event.metadata.action === "message-ack-projection" && event.commandId === commandId));
    assert.ok(events.some((event) => event.stage === "ui-long-task" && event.monotonicDurationMs >= 50));
    assert.equal(legacyAcks.length, 0);
    assert.ok(batches.every((batch) => batch.events.length <= 32));
    assert.equal(batches.flatMap((batch) => clientPerformanceTraceSpans(batch)).length, events.length);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE-TRACE-CONTENT|fixture-upload|Thread A/u);
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});
