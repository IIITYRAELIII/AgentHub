import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexAppServerTransport } from "../../../src/providers/codex/codex-app-server-transport.mjs";

function fakeChild({ pid = 321 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

async function startedTransport(overrides = {}) {
  const child = overrides.child ?? fakeChild();
  const messages = [];
  const exits = [];
  const transport = new CodexAppServerTransport({
    spawnProcess: async (args) => {
      assert.deepEqual(args, ["app-server", "--stdio"]);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    stopProcessTree: async () => true,
    onMessage: (message) => messages.push(message),
    onExit: (event) => exits.push(event),
    onStderr: () => {},
    ...overrides,
  });
  await transport.start();
  return { child, exits, messages, transport };
}

function nextWrittenJson(stream) {
  return new Promise((resolve) => {
    stream.once("data", (chunk) => resolve(JSON.parse(String(chunk).trim())));
  });
}

test("CodexAppServerTransport routes RPC responses and notifications", async () => {
  const { child, messages, transport } = await startedTransport();
  const written = nextWrittenJson(child.stdin);
  const response = transport.request("thread/list", { limit: 1 });
  const request = await written;
  assert.equal(request.method, "thread/list");
  assert.deepEqual(request.params, { limit: 1 });

  child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [1] } })}\n`);
  assert.deepEqual(await response, { data: [1] });

  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { turnId: "t1" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ method: "turn/started", params: { turnId: "t1" } }]);
});

test("CodexAppServerTransport confirms an elicitation response was flushed", async () => {
  const { child, transport } = await startedTransport();
  const written = nextWrittenJson(child.stdin);
  const flushed = transport.respond(41, { action: "accept" });
  assert.deepEqual(await written, { id: 41, result: { action: "accept" } });
  await flushed;
});

test("CodexAppServerTransport rejects an elicitation response bound to an old generation", async () => {
  const firstChild = fakeChild({ pid: 321 });
  const replacementChild = fakeChild({ pid: 654 });
  const children = [firstChild, replacementChild];
  const replacementWrites = [];
  replacementChild.stdin.on("data", (chunk) => replacementWrites.push(String(chunk)));
  const transport = new CodexAppServerTransport({
    spawnProcess: async () => children.shift(),
    onStderr: () => {},
  });
  await transport.start();
  const firstGeneration = transport.generation;
  firstChild.emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  await transport.start();

  await assert.rejects(
    transport.respond(41, { action: "accept" }, { expectedGeneration: firstGeneration }),
    (error) => {
      assert.equal(error.code, "CODEX_APP_SERVER_GENERATION_CHANGED");
      assert.equal(error.deliveryOutcome, "not-sent");
      return true;
    },
  );
  assert.equal(transport.generation, firstGeneration + 1);
  assert.deepEqual(replacementWrites, []);
});

test("CodexAppServerTransport coalesces live answer deltas before dispatch", async () => {
  const { child, messages } = await startedTransport();
  const lines = Array.from({ length: 600 }, (_, index) => JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      delta: `${String(index + 1).padStart(4, "0")}\n`,
    },
  }));

  child.stdout.write(`${lines.join("\n")}\n`);
  assert.equal(messages.length, 0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].params.delta.split("\n").filter(Boolean).length, 600);
  assert.ok(messages[0].params.delta.startsWith("0001\n"));
  assert.ok(messages[0].params.delta.endsWith("0600\n"));
});

test("CodexAppServerTransport initializes each live process once", async () => {
  const { child, transport } = await startedTransport();
  const written = nextWrittenJson(child.stdin);
  const first = transport.initialize({ clientInfo: { name: "hub" } });
  const concurrent = transport.initialize({ clientInfo: { name: "hub" } });
  const request = await written;
  assert.equal(request.method, "initialize");
  assert.deepEqual(request.params, { clientInfo: { name: "hub" } });

  child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "test" } })}\n`);
  assert.deepEqual(await first, {
    result: { userAgent: "test" },
    newlyInitialized: true,
  });
  assert.deepEqual(await concurrent, {
    result: { userAgent: "test" },
    newlyInitialized: false,
  });
  assert.deepEqual(await transport.initialize({ clientInfo: { name: "hub" } }), {
    result: { userAgent: "test" },
    newlyInitialized: false,
  });
});

test("CodexAppServerTransport allows initialization after a replacement process starts", async () => {
  const firstChild = fakeChild({ pid: 321 });
  const replacementChild = fakeChild({ pid: 654 });
  const children = [firstChild, replacementChild];
  const transport = new CodexAppServerTransport({
    spawnProcess: async () => children.shift(),
    onStderr: () => {},
  });
  await transport.start();
  let written = nextWrittenJson(firstChild.stdin);
  const first = transport.initialize();
  let request = await written;
  firstChild.stdout.write(`${JSON.stringify({ id: request.id, result: { process: 1 } })}\n`);
  assert.equal((await first).newlyInitialized, true);

  firstChild.emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.running, false);

  await transport.start();
  written = nextWrittenJson(replacementChild.stdin);
  const replacement = transport.initialize();
  request = await written;
  replacementChild.stdout.write(`${JSON.stringify({ id: request.id, result: { process: 2 } })}\n`);
  assert.deepEqual(await replacement, {
    result: { process: 2 },
    newlyInitialized: true,
  });
});

test("CodexAppServerTransport preserves structured RPC errors", async () => {
  const { child, transport } = await startedTransport();
  const written = nextWrittenJson(child.stdin);
  const response = transport.request("turn/steer", {});
  const request = await written;
  child.stdout.write(`${JSON.stringify({
    id: request.id,
    error: {
      code: -32602,
      message: "active turn not steerable",
      data: { kind: "activeTurnNotSteerable" },
    },
  })}\n`);
  await assert.rejects(response, (error) => {
    assert.equal(error.code, -32602);
    assert.deepEqual(error.data, { kind: "activeTurnNotSteerable" });
    assert.equal(error.rpcError.message, "active turn not steerable");
    return true;
  });
});

test("CodexAppServerTransport times out requests and rejects them on exit", async () => {
  const timeouts = [];
  const { child, exits, transport } = await startedTransport({
    rpcTimeoutMs: 10,
    onTimeout: (event) => timeouts.push(event),
  });
  await assert.rejects(transport.request("slow"), (error) => {
    assert.match(error.message, /timed out after 10 ms/u);
    assert.equal(error.deliveryOutcome, "unknown");
    assert.equal(error.uncertain, true);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].method, "slow");
  assert.equal(timeouts[0].timeoutMs, 10);
  assert.equal(timeouts[0].generation, transport.generation);

  const pending = transport.request("pending", {}, { timeoutMs: 5_000 });
  child.emit("exit", 7, null);
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /stopped \(code=7, signal=null\)/u);
    assert.equal(error.deliveryOutcome, "unknown");
    assert.equal(error.uncertain, true);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.running, false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 7);
});

test("CodexAppServerTransport deduplicates only in-flight thread reads", async () => {
  const { child, transport } = await startedTransport({ threadReadCacheMs: 10_000 });
  const firstWrite = nextWrittenJson(child.stdin);
  const first = transport.readThread("thread-1", { includeTurns: false });
  const duplicate = transport.readThread("thread-1", { includeTurns: false });
  const request = await firstWrite;
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-1" } } })}\n`);
  assert.deepEqual(await first, { thread: { id: "thread-1" } });
  assert.deepEqual(await duplicate, { thread: { id: "thread-1" } });

  const secondWrite = nextWrittenJson(child.stdin);
  const refreshed = transport.readThread("thread-1", { includeTurns: false });
  const secondRequest = await secondWrite;
  assert.notEqual(secondRequest.id, request.id);
  child.stdout.write(`${JSON.stringify({ id: secondRequest.id, result: { thread: { id: "thread-1", fresh: true } } })}\n`);
  assert.equal((await refreshed).thread.fresh, true);
  assert.equal(transport.diagnostics().inFlightThreadReads, 0);
  assert.equal("retainedThreadReadValues" in transport.diagnostics(), false);
});

test("CodexAppServerTransport builds bounded full history from cursor pages", async () => {
  const { child, transport } = await startedTransport({ threadReadCacheMs: 10_000 });
  const metadataWrite = nextWrittenJson(child.stdin);
  const metadata = transport.readThread("thread-1", { includeTurns: false });
  const metadataRequest = await metadataWrite;
  assert.equal(metadataRequest.params.includeTurns, false);
  child.stdout.write(`${JSON.stringify({ id: metadataRequest.id, result: { thread: { id: "thread-1" } } })}\n`);
  await metadata;

  const fullWrite = nextWrittenJson(child.stdin);
  const full = transport.readThread("thread-1", { turnLimit: 2, turnPageSize: 1 });
  const fullRequest = await fullWrite;
  assert.deepEqual(fullRequest.params, { threadId: "thread-1", includeTurns: false });
  let turnsWrite = nextWrittenJson(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: fullRequest.id, result: { thread: { id: "thread-1" } } })}\n`);
  let turnsRequest = await turnsWrite;
  assert.equal(turnsRequest.method, "thread/turns/list");
  assert.equal(turnsRequest.params.itemsView, "full");
  child.stdout.write(`${JSON.stringify({
    id: turnsRequest.id,
    result: { data: [{ id: "turn-2" }], nextCursor: "older", backwardsCursor: "newer" },
  })}\n`);
  turnsWrite = nextWrittenJson(child.stdin);
  turnsRequest = await turnsWrite;
  assert.equal(turnsRequest.params.cursor, "older");
  child.stdout.write(`${JSON.stringify({
    id: turnsRequest.id,
    result: { data: [{ id: "turn-1" }], nextCursor: null, backwardsCursor: "turn-2" },
  })}\n`);
  assert.deepEqual((await full).thread.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
});

test("CodexAppServerTransport dispatches critical RPC before queued background work", async () => {
  const { child, transport } = await startedTransport({
    maxConcurrentRequests: 1,
    maxBackgroundRequests: 1,
  });
  let written = nextWrittenJson(child.stdin);
  const first = transport.request("thread/list", { limit: 1 });
  const firstRequest = await written;
  const second = transport.request("thread/read", { threadId: "thread-1", includeTurns: false });
  written = nextWrittenJson(child.stdin);
  const critical = transport.request("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" });
  const criticalRequest = await written;
  assert.equal(criticalRequest.method, "turn/interrupt");
  child.stdout.write(`${JSON.stringify({ id: criticalRequest.id, result: {} })}\n`);
  written = nextWrittenJson(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: firstRequest.id, result: {} })}\n`);
  const secondRequest = await written;
  assert.equal(secondRequest.method, "thread/read");
  child.stdout.write(`${JSON.stringify({ id: secondRequest.id, result: {} })}\n`);
  await Promise.all([first, second, critical]);
});

test("CodexAppServerTransport includes queue wait in the RPC timeout", async () => {
  const timeouts = [];
  const { child, transport } = await startedTransport({
    maxConcurrentRequests: 1,
    maxBackgroundRequests: 1,
    onTimeout: (event) => timeouts.push(event),
  });
  const first = transport.request("thread/list", { limit: 1 }, { timeoutMs: 5_000 });
  await assert.rejects(
    transport.request("thread/read", { threadId: "thread-1" }, { timeoutMs: 10 }),
    (error) => {
      assert.match(error.message, /timed out after 10 ms/u);
      assert.equal(error.deliveryOutcome, "not-sent");
      assert.equal(error.uncertain, false);
      return true;
    },
  );
  assert.equal(timeouts.at(-1)?.method, "thread/read");
  child.emit("exit", 1, null);
  await assert.rejects(first, /stopped/u);
});

test("CodexAppServerTransport keeps one critical slot free from thread resume", async () => {
  const { child, transport } = await startedTransport({
    maxCriticalRequests: 2,
    maxThreadResumeRequests: 1,
  });
  let written = nextWrittenJson(child.stdin);
  const firstResume = transport.request("thread/resume", { threadId: "thread-1" });
  const firstRequest = await written;
  assert.equal(firstRequest.method, "thread/resume");

  const secondResume = transport.request("thread/resume", { threadId: "thread-2" });
  written = nextWrittenJson(child.stdin);
  const start = transport.request("turn/start", { threadId: "thread-3" });
  const startRequest = await written;
  assert.equal(startRequest.method, "turn/start");
  child.stdout.write(`${JSON.stringify({ id: startRequest.id, result: {} })}\n`);
  await start;

  written = nextWrittenJson(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: firstRequest.id, result: {} })}\n`);
  const secondRequest = await written;
  assert.equal(secondRequest.method, "thread/resume");
  child.stdout.write(`${JSON.stringify({ id: secondRequest.id, result: {} })}\n`);
  await Promise.all([firstResume, secondResume]);
});

test("CodexAppServerTransport bounds thread resume independently", async () => {
  const timeouts = [];
  const { transport } = await startedTransport({
    rpcTimeoutMs: 5_000,
    threadResumeTimeoutMs: 10,
    onTimeout: (event) => timeouts.push(event),
  });
  await assert.rejects(
    transport.request("thread/resume", { threadId: "occupied" }),
    /thread\/resume timed out after 10 ms/u,
  );
  assert.equal(timeouts.at(-1)?.method, "thread/resume");
});

test("CodexAppServerTransport applies a thread snapshot before buffered live events", async () => {
  const applied = [];
  const { child, transport } = await startedTransport({
    onMessage: (message) => applied.push(`event:${message.params.delta}`),
  });
  const written = nextWrittenJson(child.stdin);
  const hydrated = transport.readThread("thread-1", {
    fresh: true,
    includeTurns: false,
    applySnapshot: async () => applied.push("snapshot"),
  });
  const request = await written;
  child.stdout.write(`${JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "Гото" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "во" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-1" } } })}\n`);
  await hydrated;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(applied, ["snapshot", "event:Готово"]);
});

test("CodexAppServerTransport drops hydrated deltas superseded by item completion", async () => {
  const messages = [];
  const { child, transport } = await startedTransport({ onMessage: (message) => messages.push(message) });
  const written = nextWrittenJson(child.stdin);
  const hydrated = transport.readThread("thread-1", {
    fresh: true,
    includeTurns: false,
    applySnapshot: async () => {},
  });
  const request = await written;
  child.stdout.write(`${JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "Готово" },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-1", type: "agentMessage", text: "Готово" },
    },
  })}\n`);
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-1" } } })}\n`);
  await hydrated;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(messages.map((message) => message.method), ["item/completed"]);
});

test("CodexAppServerTransport owns notifications, responses and process-tree stop", async () => {
  const stopped = [];
  const { child, transport } = await startedTransport({
    stopProcessTree: async (pid) => {
      stopped.push(pid);
      return true;
    },
  });
  const notificationWrite = nextWrittenJson(child.stdin);
  transport.notify("initialized", { ready: true });
  assert.deepEqual(await notificationWrite, { method: "initialized", params: { ready: true } });

  const responseWrite = nextWrittenJson(child.stdin);
  transport.respond(91, { answer: true });
  assert.deepEqual(await responseWrite, { id: 91, result: { answer: true } });

  await transport.stop();
  assert.deepEqual(stopped, [321]);
  assert.equal(transport.running, false);
  assert.equal(transport.diagnostics().hubOwnedProcessTrees, undefined);
});

test("CodexAppServerTransport reports startup failures without becoming active", async () => {
  const transport = new CodexAppServerTransport({
    spawnProcess: async () => { throw new Error("spawn blocked"); },
  });
  await assert.rejects(transport.start(), /failed to start: spawn blocked/);
  assert.equal(transport.running, false);
});

test("CodexAppServerTransport coalesces concurrent starts", async () => {
  const child = fakeChild();
  let spawns = 0;
  const transport = new CodexAppServerTransport({
    spawnProcess: async () => {
      spawns += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return child;
    },
  });
  const [first, second] = await Promise.all([transport.start(), transport.start()]);
  assert.equal(first, child);
  assert.equal(second, child);
  assert.equal(spawns, 1);
});


function diagnosticWire(child, value) {
  const line = JSON.stringify(value);
  child.stdout.write(`${line}\n`);
  return Buffer.byteLength(line, "utf8");
}

test("Codex memory diagnostics count exact UTF-8 wire bytes without retaining payload or method text", async (t) => {
  const invalid = [];
  const { child, transport } = await startedTransport({ onInvalidMessage: (error) => invalid.push(error) });
  t.after(() => transport.stop());
  const written = nextWrittenJson(child.stdin);
  const response = transport.request("private/path?token=SECRET", { token: "SECRET" });
  const request = await written;
  const result = { text: "Полный ответ 😀 SECRET", values: [1, 2] };
  const bytes = diagnosticWire(child, { id: request.id, result });
  assert.deepEqual(await response, result);
  const orphanBytes = diagnosticWire(child, { id: "private-secret-id", result: { text: "SECRET" } });
  child.stdout.write("invalid-json\n");
  const diagnostics = transport.diagnostics().memory;
  assert.equal(diagnostics.wireBytes, bytes + orphanBytes + Buffer.byteLength("invalid-json"));
  assert.equal(diagnostics.invalidWireBytes, Buffer.byteLength("invalid-json"));
  assert.equal(diagnostics.wireMessages, 3);
  assert.equal(invalid.length, 1);
  assert.equal(diagnostics.rpc.other.wireBytes, bytes);
  assert.deepEqual(diagnostics.rpc.other.last, {
    requestId: request.id, generation: 1, observedGeneration: 1, wireBytes: bytes, disposition: "succeeded",
  });
  assert.equal(diagnostics.unclassifiedResponses, 1);
  assert.equal(diagnostics.rpc.unknown.last.requestId, null);
  assert.equal(diagnostics.rpc.unknown.last.generation, null);
  assert.equal(JSON.stringify(diagnostics).includes("SECRET"), false);
  assert.equal(JSON.stringify(diagnostics).includes("private"), false);
  diagnostics.rpc.other.responses = 999;
  assert.equal(transport.diagnostics().memory.rpc.other.responses, 1);
});

test("Codex memory diagnostics measure active full-read page volume and release it after failure", async (t) => {
  const { child, transport } = await startedTransport();
  t.after(() => transport.stop());
  let written = nextWrittenJson(child.stdin);
  const full = transport.readThread("private-thread", { turnLimit: 3, turnPageSize: 1 });
  const metadata = await written;
  written = nextWrittenJson(child.stdin);
  diagnosticWire(child, { id: metadata.id, result: { thread: { id: "private-thread" } } });
  const first = await written;
  written = nextWrittenJson(child.stdin);
  const firstBytes = diagnosticWire(child, { id: first.id, result: {
    data: [{ id: "new", items: [{ text: "Whole 😀 answer" }] }], nextCursor: "private-cursor",
  } });
  const second = await written;
  let memory = transport.diagnostics().memory;
  assert.equal(memory.fullRead.active, 1);
  assert.equal(memory.fullRead.currentPageWireBytes, firstBytes);
  assert.equal(memory.fullRead.peakPageWireBytes, firstBytes);
  written = nextWrittenJson(child.stdin);
  const secondBytes = diagnosticWire(child, { id: second.id, result: {
    data: [{ id: "middle" }], nextCursor: "private-older",
  } });
  const third = await written;
  const rejected = assert.rejects(full, (error) => error.code === -42 && error.deliveryOutcome === "rejected");
  diagnosticWire(child, { id: third.id, error: { code: -42, message: "original failure" } });
  await rejected;
  memory = transport.diagnostics().memory;
  assert.equal(memory.fullRead.active, 0);
  assert.equal(memory.fullRead.currentPageWireBytes, 0);
  assert.equal(memory.fullRead.peakPageWireBytes, firstBytes + secondBytes);
  assert.equal(memory.fullRead.unknownPages, 0);
  assert.deepEqual(memory.fullRead.last, {
    generation: 1, firstRequestId: first.id, lastRequestId: second.id, lastRequestGeneration: 1,
    pageWireBytes: firstBytes + secondBytes, pages: 2, unknownPages: 0, outcome: "failed",
  });
  assert.equal(memory.rpc["thread/turns/list"].last.requestId, third.id);
  assert.equal(memory.rpc["thread/turns/list"].last.disposition, "rejected");
  assert.equal(JSON.stringify(memory).includes("private"), false);
});

test("Codex memory diagnostics preserve full pages and hydration replay while measuring suppression", async (t) => {
  let releaseSnapshot;
  const snapshotWait = new Promise((resolve) => { releaseSnapshot = resolve; });
  let snapshotEntered;
  const entered = new Promise((resolve) => { snapshotEntered = resolve; });
  const delivered = [];
  const { child, transport } = await startedTransport({ onMessage: (value) => delivered.push(value) });
  t.after(() => transport.stop());
  let written = nextWrittenJson(child.stdin);
  let completeSnapshot;
  const hydrated = transport.readThread("private-thread", {
    turnLimit: 1,
    applySnapshot: async (value) => { completeSnapshot = value; snapshotEntered(); await snapshotWait; },
  });
  const metadata = await written;
  const delta = (text) => ({ method: "item/agentMessage/delta", params: {
    threadId: "private-thread", turnId: "turn", itemId: "answer", delta: text,
  } });
  const firstBytes = diagnosticWire(child, delta("Гото"));
  written = nextWrittenJson(child.stdin);
  diagnosticWire(child, { id: metadata.id, result: { thread: { id: "private-thread" } } });
  const pageRequest = await written;
  const page = { data: [{ id: "turn", items: [{ text: "Whole answer 😀" }] }], nextCursor: null };
  const pageBytes = diagnosticWire(child, { id: pageRequest.id, result: page });
  await entered;
  const secondBytes = diagnosticWire(child, delta("во"));
  const during = transport.diagnostics().memory;
  assert.equal(during.hydration.currentMessages, 2);
  assert.equal(during.hydration.currentWireBytes, firstBytes + secondBytes);
  assert.equal(during.fullRead.currentPageWireBytes, 0);
  assert.equal(during.fullRead.last.pageWireBytes, pageBytes);
  assert.equal(during.fullRead.last.outcome, "succeeded");
  assert.deepEqual(completeSnapshot.thread.turns, page.data);
  releaseSnapshot();
  assert.equal(await hydrated, completeSnapshot);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].params.delta, "Готово");
  const after = transport.diagnostics().memory.hydration;
  assert.equal(after.currentWireBytes, 0);
  assert.equal(after.currentMessages, 0);
  assert.equal(after.peakWireBytes, firstBytes + secondBytes);
  assert.equal(after.peakMessages, 2);
  assert.equal(after.receivedMessages, 2);
  assert.equal(after.replayedMessages, 1);
  assert.equal(after.coalescedMessages, 1);
});

test("Codex memory diagnostics bound timeout attribution and leave evicted replies unknown", async (t) => {
  const { child, transport } = await startedTransport({ maxConcurrentRequests: 70, rpcTimeoutMs: 10 });
  t.after(() => transport.stop());
  const requests = [];
  child.stdin.on("data", (chunk) => requests.push(JSON.parse(String(chunk))));
  const replies = await Promise.allSettled(Array.from({ length: 65 }, () => transport.request("private-method")));
  assert.equal(requests.length, 65);
  assert.ok(replies.every((reply) => reply.status === "rejected" && reply.reason.deliveryOutcome === "unknown"));
  const firstBytes = diagnosticWire(child, { id: requests[0].id, result: { private: "SECRET" } });
  const lastBytes = diagnosticWire(child, { id: requests.at(-1).id, result: { private: "SECRET" } });
  const memory = transport.diagnostics().memory;
  assert.equal(memory.timeoutIdentityEvictions, 1);
  assert.equal(memory.lateResponses, 1);
  assert.equal(memory.unclassifiedResponses, 1);
  assert.equal(memory.ignoredResponses, 2);
  assert.equal(memory.rpc.other.timeouts, 65);
  assert.equal(memory.rpc.other.wireBytes, lastBytes);
  assert.equal(memory.rpc.unknown.wireBytes, firstBytes);
  assert.equal(memory.rpc.other.last.requestId, requests.at(-1).id);
  assert.equal(memory.rpc.other.last.disposition, "late");
  assert.equal(JSON.stringify(memory).includes("SECRET"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(memory)) < 4096);
});

test("Codex memory diagnostics retain generation and drain hydration on exit without settling UNKNOWN", async (t) => {
  const children = [fakeChild({ pid: 111 }), fakeChild({ pid: 222 })];
  const { child, transport } = await startedTransport({
    child: children[0], spawnProcess: async () => children.shift(),
  });
  t.after(() => transport.stop());
  const written = nextWrittenJson(child.stdin);
  const hydration = transport.readThread("private-thread", { includeTurns: false, applySnapshot: async () => {} });
  const request = await written;
  const bytes = diagnosticWire(child, { method: "item/agentMessage/delta", params: {
    threadId: "private-thread", turnId: "turn", itemId: "answer", delta: "kept",
  } });
  const rejected = assert.rejects(hydration, (error) => error.deliveryOutcome === "unknown");
  child.emit("exit", 1, null);
  await rejected;
  assert.equal(transport.diagnostics().memory.hydration.currentWireBytes, 0);
  assert.equal(transport.diagnostics().memory.hydration.peakWireBytes, bytes);
  await transport.start();
  assert.equal(transport.diagnostics().generation, 2);
  const replacement = children.length ? children[0] : transport.child;
  diagnosticWire(replacement, { id: request.id, result: { thread: {} } });
  assert.equal(transport.diagnostics().memory.rpc.unknown.last.generation, null);
  assert.equal(transport.diagnostics().memory.rpc.unknown.last.observedGeneration, 2);
  assert.equal(transport.diagnostics().memory.lateResponses, 0);
  assert.equal(transport.diagnostics().memory.unclassifiedResponses, 1);
});


test("Codex memory diagnostics separate concurrent page occupancy and queued timeout identities", async (t) => {
  const { child, transport } = await startedTransport({ maxConcurrentRequests: 2, maxBackgroundRequests: 2 });
  t.after(() => transport.stop());
  let written = nextWrittenJson(child.stdin);
  const left = transport.readRecentThreadTurns("left-private", { limit: 2, pageSize: 1 });
  const leftFirst = await written;
  written = nextWrittenJson(child.stdin);
  const right = transport.readRecentThreadTurns("right-private", { limit: 2, pageSize: 1 });
  const rightFirst = await written;
  written = nextWrittenJson(child.stdin);
  const leftBytes = diagnosticWire(child, { id: leftFirst.id, result: { data: [{ id: "L1" }], nextCursor: "L" } });
  const leftSecond = await written;
  written = nextWrittenJson(child.stdin);
  const rightBytes = diagnosticWire(child, { id: rightFirst.id, result: { data: [{ id: "R1" }], nextCursor: "R" } });
  const rightSecond = await written;
  assert.equal(transport.diagnostics().memory.fullRead.currentPageWireBytes, leftBytes + rightBytes);
  const queued = assert.rejects(transport.request("thread/read", {}, { timeoutMs: 10 }),
    (error) => error.deliveryOutcome === "not-sent");
  await queued;
  const lastTimeout = transport.diagnostics().memory.rpc["thread/read"].lastTimeout;
  assert.equal(lastTimeout.dispatched, false);
  assert.equal(lastTimeout.generation, 1);
  assert.equal(transport.diagnostics().memory.rpc["thread/read"].queuedTimeouts, 1);
  const leftRejected = assert.rejects(left, (error) => error.message === "same error" && error.deliveryOutcome === "rejected");
  diagnosticWire(child, { id: leftSecond.id, error: { message: "same error" } });
  await leftRejected;
  assert.equal(transport.diagnostics().memory.fullRead.currentPageWireBytes, rightBytes);
  const rightLastBytes = diagnosticWire(child, { id: rightSecond.id, result: { data: [{ id: "R0" }], nextCursor: null } });
  assert.deepEqual((await right).turns.map((turn) => turn.id), ["R0", "R1"]);
  const memory = transport.diagnostics().memory;
  assert.equal(memory.fullRead.currentPageWireBytes, 0);
  assert.equal(memory.fullRead.peakPageWireBytes, Math.max(leftBytes + rightBytes, rightBytes + rightLastBytes));
  assert.equal(memory.fullRead.active, 0);
  assert.equal(memory.fullRead.completed, 1);
  assert.equal(memory.fullRead.failed, 1);
  assert.equal(memory.fullRead.currentUnknownPages, 0);
  assert.equal(memory.rpc["thread/read"].timeouts, 0);
});
