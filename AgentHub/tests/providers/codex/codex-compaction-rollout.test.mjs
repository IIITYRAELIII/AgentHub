import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CodexCompactionBoundaryError,
  codexCompactionEstimateFromJsonl,
  codexTurnIdleFromJsonl,
  readCodexTurnIdle,
  codexTurnItemsAfterCompactionFromJsonl,
  readCodexTurnItemsAfterCompaction,
  latestCodexCompactionItemFromJsonl,
  readLatestCodexCompactionItem,
} from "../../../src/providers/codex/codex-compaction-rollout.mjs";

test("native compaction estimate is bound to one current turn and its boundary", () => {
  const start = (turn_id, timestamp) => line({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id } });
  const compacted = (timestamp) => line({ timestamp, type: "compacted", payload: {} });
  const usage = (total_tokens, fields = {}, timestamp = "2026-10-01T12:33:53.207Z") => line({ timestamp, type: "event_msg", payload: { type: "token_count", info: {
    model_context_window: 258400,
    last_token_usage: { total_tokens, input_tokens: 0, cached_input_tokens: 0,
      output_tokens: 0, reasoning_output_tokens: 0, ...fields },
  } } });
  const text = [start("foreign", "2026-10-01T12:00:00Z"), compacted("2026-10-01T12:00:01Z"), usage(99999),
    start("current", "2026-10-01T12:30:37Z"), usage(219317, { input_tokens: 219169 }),
    compacted("2026-10-01T12:33:53Z"), usage(73312), usage(80000),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "current" } }),
    start("later", "2026-10-01T12:37:39Z"), usage(97288),
  ].join("\n");
  assert.deepEqual(codexCompactionEstimateFromJsonl(text, {
    turnId: "current", notBefore: "2026-10-01T12:30:37Z",
  }), { usedTokens: 73312, modelContextWindow: 258400 });
  assert.equal(codexCompactionEstimateFromJsonl(text, { turnId: "absent" }), null);
  assert.equal(codexCompactionEstimateFromJsonl(text, {
    turnId: "current", notBefore: "2026-10-01T12:34:00Z",
  }), null);
  assert.equal(codexCompactionEstimateFromJsonl(`${text}\n${start("current", "2026-10-01T12:38:00Z")}\n${compacted("2026-10-01T12:38:01Z")}`, {
    turnId: "current", notBefore: "2026-10-01T12:30:37Z",
  }), null);
  const boundary = [start("current", "2026-10-01T12:30:37Z"), compacted("2026-10-01T12:33:53.160Z")];
  assert.equal(codexCompactionEstimateFromJsonl([...boundary, usage(73312, {}, "2026-10-01T12:33:53.150Z")].join("\n"), {
    turnId: "current", notBefore: "2026-10-01T12:30:37Z",
  }), null);
  assert.equal(codexCompactionEstimateFromJsonl([...boundary, usage(73312, {}, "")].join("\n"), {
    turnId: "current", notBefore: "2026-10-01T12:30:37Z",
  }), null);
  assert.deepEqual(codexCompactionEstimateFromJsonl([...boundary, usage(73312, {}, "2026-10-01T12:33:53.207Z")].join("\n"), {
    turnId: "current", notBefore: "2026-10-01T12:30:37Z",
  }), { usedTokens: 73312, modelContextWindow: 258400 });
});

test("bounded native terminal evidence rejects missing and later active turns", async () => {
  const start = (turn_id) => line({ type: "event_msg", payload: { type: "task_started", turn_id } });
  const finish = (turn_id) => line({ type: "event_msg", payload: { type: "task_complete", turn_id } });
  const completed = [start("target"), finish("target")].join("\n");
  assert.equal(codexTurnIdleFromJsonl(completed, "target"), true);
  assert.equal(codexTurnIdleFromJsonl([completed, start("later")].join("\n"), "target"), false);
  assert.equal(codexTurnIdleFromJsonl(finish("target"), "target"), false);
  assert.equal(codexTurnIdleFromJsonl([start("foreign"), finish("foreign")].join("\n"), "target"), false);
  const calls = [];
  assert.equal(await readCodexTurnIdle("rollout.jsonl", "target", {
    maxBytes: 1234,
    readTail: async (...args) => { calls.push(args); return completed; },
  }), true);
  assert.deepEqual(calls, [["rollout.jsonl", { maxBytes: 1234 }]]);
});

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
    readTail: async () => `${text}\n`,
    statImpl: async () => ({ size: Buffer.byteLength(`${text}\n`) }),
  }), expected);
});

test("small-source transfer refuses an unfinished JSONL record", async () => {
  const boundary = { type: "compaction", encrypted_content: "small-incomplete" };
  const text = compactedRecord(boundary);
  await assert.rejects(readCodexTurnItemsAfterCompaction("rollout.jsonl", "turn-1", boundary, {
    readTail: async () => text,
    statImpl: async () => ({ size: Buffer.byteLength(text) }),
    indexCache: new Map(),
  }), (error) => error.reason === "incomplete-jsonl");
});

test("transfer streams a source larger than the bounded tail to prove its exact boundary", async () => {
  const boundary = { type: "compaction", encrypted_content: "before-tail" };
  const full = [compactedRecord(boundary), responseItem("turn-1", "message", { role: "assistant", content: [] })].join("\n");
  const tail = responseItem("turn-1", "message", { role: "assistant", content: [] });
  const calls = [];
  assert.deepEqual(await readCodexTurnItemsAfterCompaction("rollout.jsonl", "turn-1", boundary, {
    maxBytes: 20,
    readTail: async (...args) => { calls.push(args); return tail; },
    statImpl: async () => ({ size: Buffer.byteLength(`${full}\n`) }),
    readAnchor: async () => ({ head: "h", suffix: "s", complete: true }),
    indexCache: new Map(),
    createReadStreamImpl: () => Readable.from([`${full}\n`]),
  }), [{ type: "message", role: "assistant", content: [] }]);
  assert.deepEqual(calls, [], "a partial tail cannot prove boundary uniqueness");
});

test("split-tail duplicate boundary is refused before transfer", async () => {
  const boundary = { type: "compaction", encrypted_content: "same-boundary" };
  const tail = [compactedRecord(boundary), responseItem("turn-1", "message", { role: "assistant", content: [] })].join("\n");
  const full = [compactedRecord(boundary), tail].join("\n");
  await assert.rejects(readCodexTurnItemsAfterCompaction("rollout.jsonl", "turn-1", boundary, {
    maxBytes: 20,
    readTail: async () => tail,
    statImpl: async () => ({ size: Buffer.byteLength(`${full}\n`) }),
    readAnchor: async () => ({ head: "h", suffix: "s", complete: true }),
    indexCache: new Map(),
    createReadStreamImpl: () => Readable.from([`${full}\n`]),
  }), (error) => error instanceof CodexCompactionBoundaryError
    && error.reason === "boundary-ambiguous" && error.matches === 2);
});

function virtualRollout(initial, { maxBytes = 400 } = {}) {
  let bytes = Buffer.from(initial);
  let revision = 1;
  let inode = 1;
  const metrics = { streamedBytes: 0, tailBytes: 0, streamStarts: [] };
  const indexCache = new Map();
  const options = {
    maxBytes, indexCache,
    statImpl: async () => ({ size: bytes.length, dev: 1, ino: inode,
      mtimeMs: revision, ctimeMs: revision }),
    readAnchor: async (_path, size) => {
      const prefix = bytes.subarray(0, size);
      return { head: prefix.subarray(0, 64).toString("hex"),
        suffix: prefix.subarray(Math.max(0, size - 64)).toString("hex"),
        complete: prefix.at(-1) === 0x0a };
    },
    readTail: async (_path, { maxBytes: cap }) => {
      const start = Math.max(0, bytes.length - cap);
      metrics.tailBytes += bytes.length - start;
      const text = bytes.subarray(start).toString("utf8");
      return start ? text.slice(text.indexOf("\n") + 1) : text;
    },
    createReadStreamImpl: (_path, { start = 0, end = bytes.length - 1 }) => {
      const slice = bytes.subarray(start, end + 1);
      metrics.streamedBytes += slice.length;
      metrics.streamStarts.push(start);
      return Readable.from(Array.from({ length: Math.ceil(slice.length / 7) }, (_, index) => (
        slice.subarray(index * 7, (index + 1) * 7)
      )));
    },
  };
  return {
    metrics, indexCache, options,
    append: (value) => { bytes = Buffer.concat([bytes, Buffer.from(value)]); revision += 1; },
    rewrite: (value, { replace = false } = {}) => {
      bytes = Buffer.from(value); revision += 1; if (replace) inode += 1;
    },
    size: () => bytes.length,
  };
}

test("boundary index reuses a complete source and scans only appended records", async () => {
  const first = { type: "compaction", encrypted_content: "first" };
  const second = { type: "compaction", encrypted_content: "second" };
  const padding = `${line({ type: "event_msg", payload: { type: "noise", value: "x".repeat(600) } })}\n`;
  const source = virtualRollout(`${padding}${compactedRecord(first)}\n${responseItem("turn-1", "message", { role: "assistant", content: [] })}\n`);
  const read = (item, turnId = "turn-1") => readCodexTurnItemsAfterCompaction("virtual.jsonl", turnId, item, source.options);
  assert.equal((await read(first)).length, 1);
  assert.equal(source.metrics.streamedBytes, source.size(), "cold proof reads the source once");
  assert.equal((await read(first)).length, 1);
  assert.equal(source.metrics.streamedBytes, source.size(), "unchanged source uses the bounded tail");
  source.append(`${compactedRecord(second)}\n${responseItem("turn-2", "message", { role: "assistant", content: [] })}\n`);
  const beforeAppend = source.metrics.streamedBytes;
  assert.equal((await read(second, "turn-2")).length, 1);
  assert.equal(source.metrics.streamedBytes - beforeAppend, source.size() - beforeAppend,
    "append catch-up reads only bytes after the old cursor");
  const beforeDuplicate = source.metrics.streamedBytes;
  const added = `${compactedRecord(first)}\n`;
  source.append(added);
  await assert.rejects(read(first), (error) => error.reason === "boundary-ambiguous" && error.matches === 2);
  assert.equal(source.metrics.streamedBytes - beforeDuplicate, Buffer.byteLength(added));
});

test("boundary index handles split UTF-8, partial JSONL and a long post-boundary suffix", async () => {
  const item = { type: "compaction", encrypted_content: "long-suffix" };
  const padding = `${line({ type: "event_msg", payload: { value: `🙂${"x".repeat(600)}` } })}\n`;
  const source = virtualRollout(`${padding}${compactedRecord(item)}\n`, { maxBytes: 200 });
  const read = () => readCodexTurnItemsAfterCompaction("virtual-long.jsonl", "turn-1", item, source.options);
  assert.deepEqual(await read(), []);
  const suffix = Array.from({ length: 12 }, (_, index) => responseItem("turn-1", "message", {
    role: "assistant", content: [{ type: "output_text", text: `after-${index}` }],
  })).join("\n") + "\n";
  source.append(suffix);
  const previousStarts = source.metrics.streamStarts.length;
  assert.equal((await read()).length, 12);
  assert.ok(source.metrics.streamStarts.slice(previousStarts).every((offset) => offset > 0),
    "append catch-up and long-suffix transfer never rescan the older prefix");
  const partial = Buffer.from(line({ type: "compacted", payload: { marker: "🙂",
    replacement_history: [{ type: "compaction", encrypted_content: "later" }] } }));
  const split = partial.indexOf(Buffer.from("🙂")) + 2;
  source.append(partial.subarray(0, split));
  await assert.rejects(read(), (error) => error.reason === "incomplete-jsonl");
  source.append(Buffer.concat([partial.subarray(split), Buffer.from("\n")]));
  assert.equal((await read()).length, 12);
});

test("boundary index rejects stale proof after rewrite, replacement, truncation and restart", async () => {
  const item = { type: "compaction", encrypted_content: "stable" };
  const padding = `${line({ type: "event_msg", payload: { value: "x".repeat(600) } })}\n`;
  const record = `${compactedRecord(item)}\n`;
  const source = virtualRollout(`${padding}${record}`, { maxBytes: 200 });
  const read = (options = source.options) => readCodexTurnItemsAfterCompaction("virtual-rewrite.jsonl", "turn-1", item, options);
  await read();
  const first = source.metrics.streamedBytes;
  source.rewrite(`${padding.slice(0, 300)}yyy${padding.slice(303)}${record}`);
  await read();
  assert.equal(source.metrics.streamedBytes - first, source.size(), "same-size rewrite rebuilds proof");
  const second = source.metrics.streamedBytes;
  source.rewrite(`${padding}${record}`, { replace: true });
  await read();
  assert.equal(source.metrics.streamedBytes - second, source.size(), "new inode rebuilds proof");
  source.rewrite(padding);
  await assert.rejects(read(), (error) => error.reason === "boundary-not-found");
  source.rewrite(`${padding}${record}`);
  const beforeRestart = source.metrics.streamedBytes;
  await read({ ...source.options, indexCache: new Map() });
  assert.equal(source.metrics.streamedBytes - beforeRestart, source.size(),
    "restart without a trusted index performs one cold proof");
});

test("append during a bounded suffix read invalidates the transfer proof", async () => {
  const item = { type: "compaction", encrypted_content: "concurrent" };
  const padding = `${line({ type: "event_msg", payload: { value: "x".repeat(600) } })}\n`;
  const source = virtualRollout(`${padding}${compactedRecord(item)}\n`, { maxBytes: 200 });
  const read = () => readCodexTurnItemsAfterCompaction("virtual-race.jsonl", "turn-1", item, source.options);
  await read();
  const originalReadTail = source.options.readTail;
  source.options.readTail = async (...args) => {
    const result = await originalReadTail(...args);
    source.append(`${line({ type: "event_msg", payload: { type: "message" } })}\n`);
    return result;
  };
  await assert.rejects(read(), (error) => error.reason === "source-changed");
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
