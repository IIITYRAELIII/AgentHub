import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexAppServerTransport } from "./src/providers/codex/codex-app-server-transport.mjs";

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
  await assert.rejects(transport.request("slow"), /timed out after 10 ms/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].method, "slow");
  assert.equal(timeouts[0].timeoutMs, 10);

  const pending = transport.request("pending", {}, { timeoutMs: 5_000 });
  child.emit("exit", 7, null);
  await assert.rejects(pending, /stopped \(code=7, signal=null\)/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.running, false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 7);
});

test("CodexAppServerTransport deduplicates, caches and invalidates thread reads", async () => {
  const { child, transport } = await startedTransport({ threadReadCacheMs: 10_000 });
  const firstWrite = nextWrittenJson(child.stdin);
  const first = transport.readThread("thread-1");
  const duplicate = transport.readThread("thread-1");
  const request = await firstWrite;
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-1" } } })}\n`);
  assert.deepEqual(await first, { thread: { id: "thread-1" } });
  assert.deepEqual(await duplicate, { thread: { id: "thread-1" } });

  assert.deepEqual(await transport.readThread("thread-1"), { thread: { id: "thread-1" } });
  transport.invalidateThreadRead("thread-1");
  const secondWrite = nextWrittenJson(child.stdin);
  const refreshed = transport.readThread("thread-1");
  const secondRequest = await secondWrite;
  assert.notEqual(secondRequest.id, request.id);
  child.stdout.write(`${JSON.stringify({ id: secondRequest.id, result: { thread: { id: "thread-1", fresh: true } } })}\n`);
  assert.equal((await refreshed).thread.fresh, true);
});

test("CodexAppServerTransport keeps lightweight metadata separate from full history", async () => {
  const { child, transport } = await startedTransport({ threadReadCacheMs: 10_000 });
  const metadataWrite = nextWrittenJson(child.stdin);
  const metadata = transport.readThread("thread-1", { includeTurns: false });
  const metadataRequest = await metadataWrite;
  assert.equal(metadataRequest.params.includeTurns, false);
  child.stdout.write(`${JSON.stringify({ id: metadataRequest.id, result: { thread: { id: "thread-1" } } })}\n`);
  await metadata;

  const fullWrite = nextWrittenJson(child.stdin);
  const full = transport.readThread("thread-1");
  const fullRequest = await fullWrite;
  assert.equal(fullRequest.params.includeTurns, true);
  child.stdout.write(`${JSON.stringify({ id: fullRequest.id, result: { thread: { id: "thread-1", turns: [] } } })}\n`);
  await full;
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
