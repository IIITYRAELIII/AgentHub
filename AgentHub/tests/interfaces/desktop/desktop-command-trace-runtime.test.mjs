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
