import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_HUB_VERSION } from "../../../src/infrastructure/filesystem/agent-hub-package.mjs";
import { CodexAppServerLifecycle } from "../../../src/providers/codex/codex-app-server-lifecycle.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
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
    onStartupSuccess: overrides.onStartupSuccess,
    onStartupFailure: overrides.onStartupFailure,
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
  assert.equal(events[0][1].clientInfo.version, AGENT_HUB_VERSION);
});

test("Codex App Server lifecycle owns crash recovery", async () => {
  const { lifecycle, events } = fixture();
  await lifecycle.restartAfterCrash();
  assert.deepEqual(events.map(([name]) => name), ["start", "initialize", "notify", "attach", "recover"]);
});

test("Codex App Server lifecycle retries once with last-known-good after candidate startup failure", async () => {
  const failures = [];
  let initializeCount = 0;
  const { lifecycle, events } = fixture({
    onStartupFailure: async (error) => {
      failures.push(error.message);
      return true;
    },
    onStartupSuccess: async () => events.push(["startup-success"]),
  });
  lifecycle.transport.initialize = async () => {
    initializeCount += 1;
    events.push(["initialize", initializeCount]);
    if (initializeCount === 1) throw new Error("candidate protocol rejected");
    return { newlyInitialized: true };
  };

  const initialized = await lifecycle.initialize();

  assert.equal(initialized.rolledBack, true);
  assert.deepEqual(failures, ["candidate protocol rejected"]);
  assert.deepEqual(events.map(([name]) => name), [
    "initialize", "error", "stop", "start", "initialize", "notify", "attach", "startup-success",
  ]);
});

test("Codex App Server lifecycle rolls back when candidate process cannot start", async () => {
  const failures = [];
  let starts = 0;
  const { lifecycle, events } = fixture({
    onStartupFailure: async (error) => {
      failures.push(error.message);
      return true;
    },
    onStartupSuccess: async () => events.push(["startup-success"]),
  });
  lifecycle.transport.start = async () => {
    starts += 1;
    events.push(["start", starts]);
    if (starts === 1) throw new Error("candidate executable would not start");
  };

  await lifecycle.start();
  const initialized = await lifecycle.initialize();

  assert.equal(initialized.rolledBack, true);
  assert.deepEqual(failures, ["candidate executable would not start"]);
  assert.deepEqual(events.map(([name]) => name), [
    "start", "error", "stop", "start", "initialize", "notify", "attach", "startup-success",
  ]);
});

test("Codex App Server lifecycle bounds candidate and rollback process start failures", async () => {
  const failures = [];
  const { lifecycle } = fixture({
    onStartupFailure: async (error) => {
      failures.push(error.message);
      return failures.length === 1;
    },
  });
  lifecycle.transport.start = async () => {
    throw new Error(failures.length === 0 ? "candidate spawn failed" : "rollback spawn failed");
  };

  await assert.rejects(lifecycle.start(), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.message, /rollback spawn failed/u);
    return true;
  });
  assert.deepEqual(failures, ["candidate spawn failed", "rollback spawn failed"]);
});

test("Codex App Server lifecycle reports aggregate failure when candidate and rollback both fail", async () => {
  const failures = [];
  const { lifecycle } = fixture({
    onStartupFailure: async (error) => {
      failures.push(error.message);
      return failures.length === 1;
    },
  });
  lifecycle.transport.initialize = async () => {
    throw new Error(failures.length === 0 ? "candidate failed" : "rollback failed");
  };

  await assert.rejects(lifecycle.initialize(), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.message, /rollback failed/u);
    return true;
  });
  assert.deepEqual(failures, ["candidate failed", "rollback failed"]);
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

test("Codex App Server lifecycle ignores unrelated timeouts while its health check is pending", async () => {
  const { lifecycle, events, timeout } = fixture();
  const healthCheck = deferred();
  lifecycle.transport.request = (...args) => {
    events.push(["request", ...args]);
    return healthCheck.promise;
  };

  const checking = timeout({ id: 41, method: "thread/read", timeoutMs: 1_000, generation: 1 });
  await timeout({ id: 42, method: "thread/turns/list", timeoutMs: 1_000, generation: 1 });

  assert.equal(events.some(([name]) => name === "stop"), false);
  healthCheck.resolve({});
  await checking;

  assert.deepEqual(events.map(([name]) => name), ["error", "request", "log"]);
});

test("Codex App Server lifecycle restarts only after its follow-up health check times out", async () => {
  const { lifecycle, events, timeout } = fixture();
  lifecycle.transport.request = async (...args) => {
    events.push(["request", ...args]);
    await timeout({ id: 52, method: "thread/list", timeoutMs: 1_000, generation: 1 });
    throw new Error("health check timed out");
  };

  await timeout({ id: 51, method: "thread/turns/list", timeoutMs: 1_000, generation: 1 });

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
