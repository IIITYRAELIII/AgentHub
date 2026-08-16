import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerLifecycle } from "../../../src/providers/codex/codex-app-server-lifecycle.mjs";

function fixture() {
  const events = [];
  const lifecycle = new CodexAppServerLifecycle({
    resolveExecutable: async () => "codex",
    unavailableMcpOverrides: async () => ({ disabled: [], args: [] }),
    executableArgs: [],
    projectRoot: () => process.cwd(),
    stopProcessTree: async () => {},
    onMessage: () => {},
    rpcTimeoutMs: 1_000,
    isStopping: () => false,
    providerSelected: () => true,
    activeRuns: () => [],
    setStage: (...args) => events.push(["stage", ...args]),
    recoverRuns: async () => events.push(["recover"]),
    startTyping: () => events.push(["typing"]),
    attachSelectedThread: async () => events.push(["attach"]),
    scheduleRetry: (...args) => events.push(["retry", ...args]),
    logger: { log: (...args) => events.push(["log", ...args]), error: (...args) => events.push(["error", ...args]) },
  });
  const lifecycleTransport = lifecycle.transport;
  lifecycle.transport = {
    running: true,
    pid: 17,
    generation: 1,
    initialize: async (params) => {
      events.push(["initialize", params]);
      return { newlyInitialized: true };
    },
    notify: (...args) => events.push(["notify", ...args]),
    start: async () => events.push(["start"]),
    stop: async () => events.push(["stop"]),
    request: async (...args) => {
      events.push(["request", ...args]);
      return {};
    },
    readThread: (...args) => events.push(["read", ...args]),
    invalidateThreadRead: (...args) => events.push(["invalidate", ...args]),
    respond: (...args) => events.push(["respond", ...args]),
  };
  return {
    lifecycle,
    events,
    timeout: (event) => lifecycleTransport.onTimeout(event),
    exit: (event) => lifecycleTransport.onExit(event),
  };
}

test("Codex App Server lifecycle initializes the transport and selected thread", async () => {
  const { lifecycle, events } = fixture();
  await lifecycle.initialize();
  assert.equal(lifecycle.running, true);
  assert.equal(lifecycle.pid, 17);
  assert.deepEqual(events.map(([name]) => name), ["initialize", "notify", "attach"]);
});

test("Codex App Server lifecycle owns crash recovery", async () => {
  const { lifecycle, events } = fixture();
  await lifecycle.restartAfterCrash();
  assert.deepEqual(events.map(([name]) => name), ["start", "initialize", "notify", "attach", "recover"]);
});

test("Codex App Server lifecycle keeps a healthy server after one background read timeout", async () => {
  const { events, timeout } = fixture();
  await timeout({ method: "thread/read", timeoutMs: 1_000, generation: 1 });

  assert.deepEqual(events.map(([name]) => name), ["error", "request", "log"]);
  assert.deepEqual(events[1], ["request", "thread/list", { limit: 1 }, {
    timeoutMs: 1_000,
    priority: "interactive",
  }]);
  assert.equal(events.some(([name]) => name === "stop"), false);
});

test("Codex App Server lifecycle restarts only after its follow-up health check times out", async () => {
  const { lifecycle, events, timeout } = fixture();
  lifecycle.transport.request = async (...args) => {
    events.push(["request", ...args]);
    await timeout({ method: "thread/list", timeoutMs: 1_000, generation: 1 });
    throw new Error("health check timed out");
  };

  await timeout({ method: "thread/turns/list", timeoutMs: 1_000, generation: 1 });

  assert.deepEqual(events.map(([name]) => name), ["error", "request", "error", "stop"]);
});

test("Codex App Server lifecycle ignores a timeout before the request reaches transport", async () => {
  const { events, timeout } = fixture();
  await timeout({
    method: "thread/list",
    timeoutMs: 1_000,
    generation: 1,
    error: { deliveryOutcome: "not-sent" },
  });

  assert.deepEqual(events, []);
});

test("Codex App Server lifecycle still restarts after a transport crash", async () => {
  const { events, exit } = fixture();
  await exit({ detail: "code=1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.map(([name]) => name), [
    "error", "start", "initialize", "notify", "attach", "recover",
  ]);
});
