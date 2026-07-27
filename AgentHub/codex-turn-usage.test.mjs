import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  codexRecentTerminalTurnsFromJsonl,
  codexTurnUsageFromJsonl,
  readCodexRolloutTail,
  readCodexTurnUsage,
  scanCodexTerminalEventsFromOffset,
  scanCodexTurnJsonl,
  scanCodexTurnJsonlIncrementally,
} from "./codex-turn-usage.mjs";

function line(value) {
  return JSON.stringify(value);
}

function response(turnId, type = "reasoning", extra = {}) {
  return {
    type: "response_item",
    payload: {
      type,
      ...extra,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

function token(input, cache, output, reasoning) {
  return {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cache,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: input + output,
        },
      },
    },
  };
}

test("Codex rollout usage sums every model response and sees the final token event", () => {
  const startedAt = "2026-07-26T19:03:03.527Z";
  const completedAt = "2026-07-26T19:09:33.227Z";
  const text = [
    line({ timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line(response("turn-1", "message", { role: "assistant", phase: "final_answer" })),
    line(token(50, 40, 5, 1)),
    line({ timestamp: completedAt, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-1");
  assert.equal(result.reported, true);
  assert.equal(result.finalAnswerSeen, true);
  assert.equal(result.finalTokenSeen, true);
  assert.equal(result.terminal, true);
  assert.equal(result.status, "completed");
  assert.equal(result.startedAt, startedAt);
  assert.equal(result.completedAt, completedAt);
  assert.deepEqual(result.usage, {
    inputTokens: 150,
    cachedInputTokens: 120,
    outputTokens: 15,
    reasoningOutputTokens: 5,
    totalTokens: 165,
  });
});

test("streaming rollout scan extracts the exact prompt, terminal status and changed files", async () => {
  const startedAt = "2026-07-26T19:03:03.527Z";
  const completedAt = "2026-07-26T19:04:03.527Z";
  const text = [
    line({ timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-other", "message", {
      role: "user",
      content: [{ type: "input_text", text: "Чужой запрос" }],
    })),
    line(response("turn-1", "message", {
      role: "user",
      content: [{
        type: "input_text",
        text: "Служебное начало\n<environment_context>скрыть</environment_context>\nТочный запрос",
      }],
    })),
    line({
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        turn_id: "turn-1",
        changes: {
          "D:\\repo\\first.mjs": { type: "update" },
          "D:\\repo\\second.mjs": { type: "add" },
        },
      },
    }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line({ timestamp: completedAt, type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1" } }),
  ].join("\n");

  const result = await scanCodexTurnJsonl("large-rollout.jsonl", "turn-1", {
    createReadStreamImpl: () => Readable.from(text.split("\n").map((value) => `${value}\n`)),
  });

  assert.equal(result.prompt, "Служебное начало\n\nТочный запрос");
  assert.equal(result.status, "aborted");
  assert.equal(result.terminal, true);
  assert.equal(result.startedAt, startedAt);
  assert.equal(result.completedAt, completedAt);
  assert.deepEqual(result.changedFiles, [
    "D:\\repo\\first.mjs",
    "D:\\repo\\second.mjs",
  ]);
  assert.equal(result.usage.inputTokens, 100);
});

test("streaming rollout scan extracts files from the apply_patch tool call", async () => {
  const text = [
    line({ type: "session_meta", payload: { cwd: "D:\\repo" } }),
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "custom_tool_call", {
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: src/one.mjs\n@@\n-old\n+new\n*** Add File: D:\\repo\\src\\two.mjs\n+two\n*** End Patch",
    })),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");
  const result = await scanCodexTurnJsonl("rollout.jsonl", "turn-1", {
    createReadStreamImpl: () => Readable.from(text.split("\n").map((value) => `${value}\n`)),
  });
  assert.deepEqual(result.changedFiles, [
    "D:\\repo\\src\\one.mjs",
    "D:\\repo\\src\\two.mjs",
  ]);
});

test("recent terminal scan distinguishes completed and aborted turns", () => {
  const values = codexRecentTerminalTurnsFromJsonl([
    line({ timestamp: "2026-07-26T19:04:03.527Z", type: "event_msg", payload: {
      type: "turn_aborted",
      turn_id: "turn-aborted",
    } }),
    line({ timestamp: "2026-07-26T19:05:03.527Z", type: "event_msg", payload: {
      type: "task_complete",
      turn_id: "turn-completed",
    } }),
  ].join("\n"));
  assert.deepEqual(values, [
    {
      turnId: "turn-aborted",
      status: "aborted",
      completedAt: "2026-07-26T19:04:03.527Z",
    },
    {
      turnId: "turn-completed",
      status: "completed",
      completedAt: "2026-07-26T19:05:03.527Z",
    },
  ]);
});

test("terminal event scanner resumes from the last complete JSONL byte", async () => {
  const first = `${line({
    timestamp: "2026-07-27T03:00:00.000Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1" },
  })}\n`;
  const incomplete = line({
    timestamp: "2026-07-27T03:01:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-2" },
  });
  const partialLength = Math.floor(Buffer.byteLength(incomplete) / 2);
  const starts = [];
  let source = `${first}${Buffer.from(incomplete).subarray(0, partialLength).toString("utf8")}`;
  const createReadStreamImpl = (_path, { start }) => {
    starts.push(start);
    return Readable.from([Buffer.from(source).subarray(start)]);
  };

  const firstResult = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    createReadStreamImpl,
  });
  assert.deepEqual(firstResult.terminals.map((value) => value.turnId), ["turn-1"]);
  assert.equal(firstResult.nextOffset, Buffer.byteLength(first));

  source = `${first}${incomplete}\n`;
  const secondResult = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    startOffset: firstResult.nextOffset,
    createReadStreamImpl,
  });
  assert.deepEqual(secondResult.terminals.map((value) => value.turnId), ["turn-2"]);
  assert.equal(secondResult.nextOffset, Buffer.byteLength(source));
  assert.deepEqual(starts, [0, Buffer.byteLength(first)]);
});

test("Codex usage reader uses the incremental streaming scanner by default", async () => {
  let scans = 0;
  const result = await readCodexTurnUsage("large-rollout.jsonl", "turn-1", {
    attempts: 1,
    scanIncrementalImpl: async () => {
      scans += 1;
      return {
        reported: true,
        finalTokenSeen: true,
        usage: { inputTokens: 10 },
      };
    },
  });
  assert.equal(scans, 1);
  assert.equal(result.usage.inputTokens, 10);
});

test("incremental retries scan only bytes appended after the first large pass", async () => {
  const base = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "message", { role: "assistant", phase: "final_answer" })),
  ].join("\n") + "\n";
  const complete = `${base}${line(token(50, 40, 5, 1))}\n${line({
    timestamp: "2026-07-27T01:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1" },
  })}\n`;
  const starts = [];
  let reads = 0;
  const result = await scanCodexTurnJsonlIncrementally("growing-rollout.jsonl", "turn-1", {
    attempts: 2,
    retryDelayMs: 0,
    createReadStreamImpl: (_file, options) => {
      starts.push(options.start);
      reads += 1;
      const current = reads === 1 ? base : complete;
      return Readable.from([Buffer.from(current).subarray(options.start)]);
    },
  });

  assert.deepEqual(starts, [0, Buffer.byteLength(base)]);
  assert.equal(result.finalTokenSeen, true);
  assert.equal(result.completedAt, "2026-07-27T01:00:00.000Z");
  assert.equal(result.usage.inputTokens, 50);
});

test("streaming scan finds an exact turn beyond the former 64 MiB tail boundary", async () => {
  const padding = `${line({
    type: "event_msg",
    payload: { type: "unrelated", padding: "x".repeat(64 * 1024) },
  })}\n`;
  const chunks = Array.from({ length: 1_040 }, () => padding);
  chunks.push(
    `${line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-large" } })}\n`,
    `${line(response("turn-large"))}\n`,
    `${line(token(321, 300, 21, 8))}\n`,
    `${line({
      timestamp: "2026-07-27T01:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-large" },
    })}\n`,
  );

  const result = await scanCodexTurnJsonl("huge-rollout.jsonl", "turn-large", {
    createReadStreamImpl: () => Readable.from(chunks),
  });

  assert.equal(Buffer.byteLength(padding) * 1_040 > 64 * 1024 * 1024, true);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.inputTokens, 321);
});

test("Codex rollout usage keeps interleaved turns separate", () => {
  const text = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line(response("turn-2")),
    line(token(200, 150, 20, 8)),
    line(response("turn-1", "message", { role: "assistant", phase: "final_answer" })),
    line(token(50, 40, 5, 1)),
  ].join("\n");

  assert.deepEqual(codexTurnUsageFromJsonl(text, "turn-1").usage, {
    inputTokens: 150,
    cachedInputTokens: 120,
    outputTokens: 15,
    reasoningOutputTokens: 5,
    totalTokens: 165,
  });
  assert.deepEqual(codexTurnUsageFromJsonl(text, "turn-2").usage, {
    inputTokens: 200,
    cachedInputTokens: 150,
    outputTokens: 20,
    reasoningOutputTokens: 8,
    totalTokens: 220,
  });
});

test("Codex rollout reader retries until the final token event is flushed", async () => {
  let reads = 0;
  const base = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "message", { role: "assistant", phase: "final_answer" })),
  ].join("\n");
  const result = await readCodexTurnUsage("rollout.jsonl", "turn-1", {
    attempts: 2,
    retryDelayMs: 0,
    readFileImpl: async () => {
      reads += 1;
      return reads === 1 ? base : `${base}\n${line(token(50, 40, 5, 1))}`;
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.finalTokenSeen, true);
});

test("Codex rollout tail reads only the bounded suffix and drops its partial first line", async () => {
  const source = Buffer.from(`ignored-prefix\n${line(response("turn-1"))}\n${line(token(50, 40, 5, 1))}`);
  let requested = null;
  let closed = false;
  const text = await readCodexRolloutTail("large-rollout.jsonl", {
    maxBytes: source.length - 5,
    openImpl: async () => ({
      stat: async () => ({ size: source.length }),
      read: async (buffer, offset, length, position) => {
        requested = { length, position };
        const chunk = source.subarray(position, position + length);
        chunk.copy(buffer, offset);
        return { bytesRead: chunk.length };
      },
      close: async () => {
        closed = true;
      },
    }),
  });

  assert.deepEqual(requested, { length: source.length - 5, position: 5 });
  assert.equal(text, `${line(response("turn-1"))}\n${line(token(50, 40, 5, 1))}`);
  assert.equal(closed, true);
});
