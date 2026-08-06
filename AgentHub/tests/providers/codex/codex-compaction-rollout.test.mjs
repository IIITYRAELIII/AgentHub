import assert from "node:assert/strict";
import test from "node:test";

import {
  latestCodexCompactionItemFromJsonl,
  readLatestCodexCompactionItem,
} from "../../../src/providers/codex/codex-compaction-rollout.mjs";

function line(value) {
  return JSON.stringify(value);
}

test("latest compaction reader returns only a compaction after the requested start", () => {
  const oldItem = { type: "compaction", encrypted_content: "old" };
  const currentItem = { type: "compaction", encrypted_content: "current" };
  const text = [
    line({
      timestamp: "2026-08-06T20:00:00.000Z",
      type: "compacted",
      payload: { replacement_history: [oldItem] },
    }),
    line({ timestamp: "2026-08-06T20:59:59.000Z", type: "event_msg", payload: {} }),
    line({
      timestamp: "2026-08-06T21:00:01.000Z",
      type: "compacted",
      payload: { replacement_history: [{ type: "message" }, currentItem] },
    }),
  ].join("\n");

  assert.deepEqual(latestCodexCompactionItemFromJsonl(text, {
    notBefore: "2026-08-06T21:00:00.000Z",
  }), currentItem);
});

test("rollout compaction reader uses the bounded tail", async () => {
  const expected = { type: "compaction", encrypted_content: "opaque" };
  const calls = [];
  const result = await readLatestCodexCompactionItem("rollout.jsonl", {
    maxBytes: 1234,
    readTail: async (...args) => {
      calls.push(args);
      return line({
        timestamp: "2026-08-06T21:00:01.000Z",
        type: "compacted",
        payload: { replacement_history: [expected] },
      });
    },
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(calls, [["rollout.jsonl", { maxBytes: 1234 }]]);
});
