import assert from "node:assert/strict";
import test from "node:test";
import { recycleCodexCompactionTransport } from "../../../src/providers/codex/codex-compaction-transport.mjs";

test("manual compaction recycle stops, sanitizes and restores the App Server", async () => {
  const calls = [];
  const result = await recycleCodexCompactionTransport({
    stop: async () => calls.push("stop"),
    sanitize: async () => {
      calls.push("sanitize");
      return { applied: true };
    },
    start: async () => calls.push("start"),
    initialize: async () => calls.push("initialize"),
  });

  assert.deepEqual(calls, ["stop", "sanitize", "start", "initialize"]);
  assert.deepEqual(result, { result: { applied: true }, error: null });
});

test("manual compaction recycle restores the App Server after sanitation failure", async () => {
  const calls = [];
  const failure = new Error("sanitize failed");
  const result = await recycleCodexCompactionTransport({
    stop: async () => calls.push("stop"),
    sanitize: async () => {
      calls.push("sanitize");
      throw failure;
    },
    start: async () => calls.push("start"),
    initialize: async () => calls.push("initialize"),
  });

  assert.deepEqual(calls, ["stop", "sanitize", "start", "initialize"]);
  assert.equal(result.error, failure);
});
