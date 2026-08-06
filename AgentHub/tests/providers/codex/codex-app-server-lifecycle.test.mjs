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
  lifecycle.transport = {
    running: true,
    pid: 17,
    initialize: async (params) => {
      events.push(["initialize", params]);
      return { newlyInitialized: true };
    },
    notify: (...args) => events.push(["notify", ...args]),
    start: async () => events.push(["start"]),
    stop: async () => events.push(["stop"]),
    request: (...args) => events.push(["request", ...args]),
    readThread: (...args) => events.push(["read", ...args]),
    invalidateThreadRead: (...args) => events.push(["invalidate", ...args]),
    respond: (...args) => events.push(["respond", ...args]),
  };
  return { lifecycle, events };
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
