import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { launchBrowser, openFixture, submit, bridgeCalls, snapshot } from "./composer-production.fixture.mjs";
import { clientPerformanceTraceSpans } from "../../src/application/client-performance-trace.mjs";

const source = await readFile(new URL("../../assets/web-app/command-trace.js", import.meta.url), "utf8");

function fixture() {
  let clock = 10;
  let sequence = 0;
  const frames = [];
  const timers = [];
  const listeners = new Map();
  const window = {
    performance: { now: () => clock }, crypto: { randomUUID: () => `trace-${++sequence}` },
    document: { hidden: false, documentElement: { dataset: { view: "chat" } },
      addEventListener: (name, callback) => listeners.set(name, callback) },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    requestAnimationFrame: (fn) => frames.push(fn), queueMicrotask, addEventListener() {},
  };
  vm.runInNewContext(source, { window, Date });
  return { trace: window.AgentHubCommandTrace, advance: (ms) => { clock += ms; }, frames, timers,
    hide: () => { window.document.hidden = true; listeners.get("visibilitychange")?.(); } };
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
  assert.equal(batches[0].events.find((event) => event.outcome === "succeeded").monotonicDurationMs, 37);
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
  const terminalEvents = events.filter((event) => event.outcome !== "started");
  assert.equal(terminalEvents[0].monotonicDurationMs, 51);
  assert.equal(terminalEvents[1].outcome, "failed");
  assert.equal(terminalEvents[2].commandId, "original-command");
  assert.equal(terminalEvents[2].stage, "client-ack");
  assert.equal(terminalEvents[2].timing.clientAckMonotonicMs, 61);
  assert.doesNotMatch(JSON.stringify(events), /private|secret/u);
});

test("stalled client operations report started before completion and retain exact paired identity", async () => {
  const { trace, advance } = fixture();
  const events = [];
  trace.bindReporter(async (batch) => events.push(...batch.events));
  let release;
  const pending = trace.measure("ui-control", "snapshot", () => new Promise((resolve) => { release = resolve; }), "command-stalled");
  await trace.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "started");
  assert.equal(trace.currentId(), "");
  advance(700);
  release({ secret: "private response" });
  assert.equal((await pending).secret, "private response");
  await trace.flush();
  assert.equal(events[1].monotonicDurationMs, 700);
  assert.equal(events[1].outcome, "succeeded");
  assert.equal(events[0].metadata.operationSpanId, events[1].metadata.operationSpanId);
  const converted = clientPerformanceTraceSpans({ events });
  assert.equal(converted[0].metadata.operationSpanId, converted[1].metadata.operationSpanId);
  assert.doesNotMatch(JSON.stringify(converted), /private response/u);
});

test("HTTP outcomes and cancellation describe observation without changing response or rejection", async () => {
  const { trace } = fixture();
  const events = [];
  trace.bindReporter(async (batch) => events.push(...batch.events));
  for (const status of [200, 304, 404, 503]) {
    const response = { status, body: "private response" };
    assert.equal(await trace.http("http-journal", async () => response, `http-${status}`), response);
  }
  const abort = Object.assign(new Error("private abort message"), { name: "AbortError" });
  await assert.rejects(trace.http("http-attachment", async () => { throw abort; }), (error) => error === abort);
  const timeout = Object.assign(new Error("private timeout"), { name: "TimeoutError" });
  assert.throws(() => trace.measure("ui-control", "snapshot", () => { throw timeout; }), (error) => error === timeout);
  await trace.flush();
  const terminal = events.filter((event) => event.outcome !== "started");
  assert.deepEqual(terminal.map((event) => event.outcome), ["succeeded", "succeeded", "failed", "failed", "cancelled", "failed"]);
  assert.deepEqual(terminal.slice(0, 4).map((event) => event.metadata.statusCode), [200, 304, 404, 503]);
  assert.equal(terminal[4].metadata.failureKind, "aborted");
  assert.equal(terminal[5].metadata.failureKind, "timeout");
  assert.equal(clientPerformanceTraceSpans({ events }).length, events.length);
  assert.doesNotMatch(JSON.stringify(events), /private/u);
});

test("a hidden surface cancels pending paint measurements and late frames cannot claim visibility", async () => {
  const { trace, frames, hide, advance } = fixture();
  const events = [];
  trace.bindReporter(async (batch) => events.push(...batch.events));
  trace.afterPaint("ui-render", "messages", 10, "paint-1");
  assert.equal(trace.diagnostics().paintPending, 1);
  advance(19);
  hide();
  for (const frame of frames) frame();
  await trace.flush();
  assert.equal(trace.diagnostics().paintPending, 0);
  assert.equal(events.length, 2);
  assert.equal(events[1].outcome, "cancelled");
  assert.equal(events[1].metadata.failureKind, "hidden");
  assert.equal(events[1].monotonicDurationMs, 19);
  assert.equal(events[0].metadata.operationSpanId, events[1].metadata.operationSpanId);
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

test("shipped queue cancellation and rejected message keep end-to-end handler evidence without payloads", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const batches = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/command-trace/client-events")) batches.push(request.postDataJSON());
    });
    const queued = snapshot();
    queued.deferredInputs = [{ id: "private-queue-id", provider: "codex", threadId: "thread-a",
      streamId: "stream-a", clientUserMessageId: "private-message-id", state: "queued",
      conflictKind: "task-running", clientProjectionIntent: "queue", text: "PRIVATE-QUEUED-TEXT",
      createdAt: "2026-09-10T00:00:00.000Z" }];
    const diagnostics = await openFixture(page, { fixtureSnapshot: queued });
    await page.evaluate(() => {
      const postMessage = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === "deferred-input" && message.params.action === "cancel") {
          window.__agentHubFixture.snapshot.deferredInputs = [];
          window.__agentHubFixture.snapshot.version = "fixture-cancelled";
        }
        postMessage(message);
      };
    });
    await page.locator("[data-action='queue-remove']").click();
    await page.waitForFunction(() => !document.querySelector(".queue-item"));
    const cancel = (await bridgeCalls(page, "deferred-input"))[0];
    assert.equal(cancel.params.action, "cancel");
    const cancelTraceId = cancel.params.clientTraceId;
    await page.evaluate(() => { window.__agentHubFixture.mode = "hold-reject"; });
    await submit(page, { text: "PRIVATE-REJECTED-MESSAGE" });
    await page.waitForFunction(() => window.__agentHubFixture.heldSend);
    const send = (await bridgeCalls(page, "send-message"))[0];
    const messageId = send.params.clientUserMessageId;
    const drain = () => page.evaluate(async () => {
      for (let count = 0; count < 16 && window.AgentHubCommandTrace.diagnostics().pending; count += 1) {
        await window.AgentHubCommandTrace.flush();
      }
    });
    await drain();
    let events = batches.flatMap((batch) => batch.events);
    assert.ok(events.some((event) => event.commandId === messageId
      && event.stage === "ui-control" && event.outcome === "started"));
    assert.equal(events.some((event) => event.commandId === messageId
      && event.stage === "ui-control" && event.outcome !== "started"), false);
    await page.evaluate(() => window.__rejectHeldSend());
    await page.waitForFunction(() => !window.__agentHubFixture.heldSend
      && document.querySelector("[data-composer-input]")?.value === "PRIVATE-REJECTED-MESSAGE");
    await drain();
    events = batches.flatMap((batch) => batch.events);
    const handler = events.filter((event) => event.commandId === cancelTraceId
      && event.metadata?.action === "intent-handler");
    assert.deepEqual(handler.map((event) => event.outcome), ["started", "succeeded"]);
    assert.equal(handler[0].metadata.operationSpanId, handler[1].metadata.operationSpanId);
    assert.equal(events.filter((event) => event.commandId === messageId
      && event.stage === "client-ack" && event.outcome === "failed").length, 1);
    assert.ok(events.some((event) => event.commandId === messageId
      && event.stage === "ui-control" && event.outcome === "failed"));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE-|private-queue-id|private-message-id/u);
    assert.deepEqual(diagnostics, []);
    if (process.env.AGENT_HUB_TRACE_QA_SCREENSHOT) await page.screenshot({
      path: process.env.AGENT_HUB_TRACE_QA_SCREENSHOT, fullPage: true,
    });
  } finally { await browser.close(); }
});
