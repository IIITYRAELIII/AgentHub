import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CommandTraceService } from "../../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { createDesktopControlRouter } from "../../../src/interfaces/desktop/desktop-control-router.mjs";

test("slow trace writes stay off the ACK path and overflow drops spans, not commands", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-slow-command-trace-"));
  const store = new CommandTraceWorkerStore({
    databaseFile: path.join(directory, "ignored.sqlite"),
    workerUrl: new URL("../../fixtures/command-trace-slow-worker.mjs", import.meta.url),
    workerData: { delayMs: 10_000 },
    maxPendingWrites: 3,
    closeTimeoutMs: 100,
    logger: { warn: () => {} },
  });
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.initialize();
  const service = new CommandTraceService({ store });
  const router = createDesktopControlRouter({
    handlers: { "send-message": async () => ({ accepted: true }) },
    mutationActions: ["send-message"],
    commandTrace: service,
  });

  const result = await router.handleDesktopControl({
    action: "send-message",
    params: { text: "ACK must not await trace" },
    context: { source: "desktop-control", commandId: "slow-trace-command" },
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(store.stats().queuedWrites, 2, "ACK returned while both boundary spans were still pending");
  assert.equal(service.recordBestEffort({
    commandId: "slow-trace-command",
    stage: "client-ack",
    outcome: "succeeded",
    transport: "desktop-control",
  }), true);
  assert.equal(service.recordBestEffort({
    commandId: "slow-trace-command",
    stage: "response-send",
    outcome: "succeeded",
    transport: "desktop-control",
  }), false);
  assert.deepEqual(store.stats(), {
    queuedWrites: 3,
    droppedSpans: 1,
    pendingRequests: 0,
    workerRestarts: 0,
    workerRunning: true,
  });
});

test("trace worker crash drops only telemetry and restarts independently", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-crashed-command-trace-"));
  const store = new CommandTraceWorkerStore({
    databaseFile: path.join(directory, "ignored.sqlite"),
    workerUrl: new URL("../../fixtures/command-trace-slow-worker.mjs", import.meta.url),
    workerData: { crashOnAppend: true },
    restartDelayMs: 10,
    logger: { warn: () => {} },
  });
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.initialize();
  const service = new CommandTraceService({ store });
  assert.equal(service.recordBestEffort({
    commandId: "crashed-trace-command",
    stage: "hub-receive",
    outcome: "succeeded",
    transport: "desktop-control",
  }), true);
  const deadline = Date.now() + 2_000;
  while (store.stats().workerRestarts < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.stats().workerRestarts, 1);
  assert.equal(store.stats().droppedSpans, 1);

  const router = createDesktopControlRouter({
    handlers: { "send-message": async () => ({ accepted: true }) },
    mutationActions: ["send-message"],
    commandTrace: service,
  });
  assert.deepEqual(await router.handleDesktopControl({
    action: "send-message",
    params: { text: "runtime survives trace worker crash" },
    context: { source: "desktop-control", commandId: "after-trace-crash" },
  }), { accepted: true });
});
