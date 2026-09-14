import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CodexCompactionBoundaryError,
  codexTurnItemsAfterCompactionFromJsonl,
  readCodexTurnItemsAfterCompaction,
  latestCodexCompactionItemFromJsonl,
  readLatestCodexCompactionItem,
} from "../../../src/providers/codex/codex-compaction-rollout.mjs";

function line(value) {
  return JSON.stringify(value);
}

function responseItem(turnId, type, fields = {}) {
  return line({
    type: "response_item",
    payload: {
      type,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
      ...fields,
    },
  });
}

function compactedRecord(...replacement) {
  return line({ type: "compacted", payload: { replacement_history: replacement } });
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

// Всё, что ход сделал до свёртки, уже представлено её результатом. В новый
// Thread уходит только упорядоченный хвост того же хода после этой свёртки.
test("turn transfer keeps only the ordered suffix after the exact compaction boundary", async () => {
  const boundary = { type: "compaction", encrypted_content: "current-summary" };
  const text = [
    responseItem("turn-other", "message", { role: "user", content: [] }),
    responseItem("turn-1", "message", {
      role: "user",
      content: [{ type: "input_text", text: "Сделай" }],
    }),
    responseItem("turn-1", "function_call", { name: "shell", call_id: "call-1" }),
    responseItem("turn-1", "function_call_output", { call_id: "call-1", output: "до свёртки" }),
    compactedRecord({ type: "message", role: "user", content: [] }, boundary),
    responseItem("turn-1", "compaction", { encrypted_content: "current-summary" }),
    responseItem("turn-1", "function_call", { name: "shell", call_id: "call-2" }),
    responseItem("turn-other", "message", { role: "assistant", content: [] }),
    responseItem("turn-1", "function_call_output", { call_id: "call-2", output: "после свёртки" }),
    responseItem("turn-1", "message", {
      role: "assistant",
      content: [{ type: "output_text", text: "Готово" }],
    }),
  ].join("\n");

  const expected = [
    { type: "function_call", name: "shell", call_id: "call-2" },
    { type: "function_call_output", call_id: "call-2", output: "после свёртки" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Готово" }],
    },
  ];
  assert.deepEqual(codexTurnItemsAfterCompactionFromJsonl(text, "turn-1", boundary), expected);
  assert.deepEqual(await readCodexTurnItemsAfterCompaction("rollout.jsonl", "turn-1", boundary, {
    createReadStreamImpl: () => Readable.from(text.split("\n").map((value) => `${value}\n`)),
  }), expected);
});

test("a large turn transfers only its post-boundary suffix, once and in order", () => {
  // Пропорции хода S2: 4 904 элемента до свёртки и 69 после неё.
  const boundary = { type: "compaction", encrypted_content: "large-turn-summary" };
  const lines = [];
  for (let index = 0; index < 4_904; index += 1) {
    lines.push(responseItem("turn-big", "function_call_output", { call_id: `before-${index}`, output: "x" }));
  }
  lines.push(compactedRecord(boundary));
  for (let index = 0; index < 69; index += 1) {
    lines.push(responseItem("turn-big", "function_call_output", { call_id: `after-${index}`, output: "y" }));
  }

  const suffix = codexTurnItemsAfterCompactionFromJsonl(lines.join("\n"), "turn-big", boundary);

  assert.equal(suffix.length, 69);
  assert.deepEqual(
    suffix.map((item) => item.call_id),
    Array.from({ length: 69 }, (_, index) => `after-${index}`),
  );
});

test("a compaction at the very end of a turn transfers an empty suffix", () => {
  const boundary = { type: "compaction", encrypted_content: "final" };
  const text = [
    responseItem("turn-1", "message", { role: "user", content: [] }),
    compactedRecord(boundary),
  ].join("\n");

  assert.deepEqual(codexTurnItemsAfterCompactionFromJsonl(text, "turn-1", boundary), []);
});

test("an earlier compaction of the same turn is not mistaken for the transferred boundary", () => {
  const earlier = { type: "compaction", encrypted_content: "earlier" };
  const current = { type: "compaction", encrypted_content: "current" };
  const text = [
    responseItem("turn-1", "message", { role: "user", content: [] }),
    compactedRecord(earlier),
    responseItem("turn-1", "function_call", { call_id: "between" }),
    compactedRecord(current),
    responseItem("turn-1", "function_call", { call_id: "after" }),
  ].join("\n");

  assert.deepEqual(codexTurnItemsAfterCompactionFromJsonl(text, "turn-1", current), [
    { type: "function_call", call_id: "after" },
  ]);
});

test("a missing or ambiguous compaction boundary refuses the transfer", () => {
  const boundary = { type: "compaction", encrypted_content: "summary" };
  const item = responseItem("turn-1", "message", { role: "user", content: [] });
  for (const [text, reason] of [
    [item, "boundary-not-found"],
    [[compactedRecord(boundary), item, compactedRecord(boundary), item].join("\n"), "boundary-ambiguous"],
  ]) {
    assert.throws(
      () => codexTurnItemsAfterCompactionFromJsonl(text, "turn-1", boundary),
      (error) => error instanceof CodexCompactionBoundaryError && error.reason === reason,
    );
  }
  assert.throws(
    () => codexTurnItemsAfterCompactionFromJsonl(item, "turn-1", { type: "message" }),
    (error) => error instanceof CodexCompactionBoundaryError && error.reason === "missing-compaction",
  );
});
