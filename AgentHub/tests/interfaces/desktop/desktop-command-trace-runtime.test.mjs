import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopControlRouter } from "../../../src/interfaces/desktop/desktop-control-router.mjs";

test("desktop command keeps its result while emitting receive and real receipt lock timing", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-command-trace-runtime-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const spans = [];
  const router = createDesktopControlRouter({
    handlers: { "send-message": async () => ({ accepted: true }) },
    mutationActions: ["send-message"],
    receiptActions: ["send-message"],
    receiptFile: path.join(directory, "receipts.json"),
    commandTrace: { recordBestEffort: (span) => { spans.push(span); return true; } },
  });

  const result = await router.handleDesktopControl({
    action: "send-message",
    params: { text: "hello" },
    context: { source: "desktop-control", commandId: "message:test:1" },
  });

  assert.deepEqual(result, { accepted: true });
  assert.ok(spans.some((span) => span.stage === "hub-receive" && span.commandId === "message:test:1"));
  assert.ok(spans.some((span) => (
    span.stage === "receipt-lock-wait"
      && span.commandId === "message:test:1"
      && Number.isFinite(span.lockWaitMs)
  )));
});


test("generic UI trace identity correlates handlers without changing durable retries", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-trace-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let effects = 0; const spans = [];
  const router = createDesktopControlRouter({
    handlers: { pin: async () => { effects += 1; return { ok: true }; } },
    mutationActions: ["pin"], receiptFile: path.join(directory, "receipts.json"),
    commandTrace: { recordBestEffort: (span) => spans.push(span) },
  });
  for (const clientTraceId of ["ui-1", "ui-2"]) await router.handleDesktopControl({
    action: "pin", params: { pinId: "pin-1", clientTraceId },
    context: { source: "desktop-control", commandId: "original-command" },
  });
  assert.equal(effects, 1);
  assert.ok(spans.some((span) => span.commandId === "ui-1" && span.stage === "hub-receive"));
  assert.ok(spans.some((span) => span.commandId === "ui-2" && span.stage === "hub-receive"));
});

test("snapshot run-source trace shares the original client request identity", async () => {
  const spans = [];
  const projection = {
    source: "none", gate: "inactive", provider: "codex", threadId: "thread-current",
    streamId: "stream-current", turnId: "turn-current", clientUserMessageId: "client-current",
    entryRunning: false, providerStartPresent: false,
  };
  const snapshot = {
    version: "snapshot-current", server: { process: { releaseId: "release-current" } },
    snapshotTiming: { selectedProjection: projection },
  };
  const router = createDesktopControlRouter({
    handlers: { snapshot: async () => snapshot },
    commandTrace: { recordBestEffort: (span) => { spans.push(span); return true; } },
  });
  assert.equal(await router.handleDesktopControl({ action: "snapshot",
    params: { clientTraceId: "request-original" }, context: { source: "desktop-control" } }), snapshot);
  const evidence = spans.find((span) => span.stage === "snapshot-selected-projection");
  assert.equal(evidence?.commandId, "request-original");
  assert.equal(evidence?.metadata.source, "none");
  assert.equal(evidence?.metadata.gate, "inactive");
  assert.equal(evidence?.metadata.turnId, "turn-current");
  assert.equal(evidence?.metadata.serverReleaseId, "release-current");
  assert.doesNotMatch(JSON.stringify(evidence), /Private|prompt|answer/u);
});
