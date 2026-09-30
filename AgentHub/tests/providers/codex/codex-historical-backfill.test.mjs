import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanCodexHistoricalRolloutInWorker, scanCodexLiveRolloutInWorker } from "../../../src/providers/codex/codex-historical-backfill.mjs";
import { scanCodexHistoricalRollout } from "../../../src/providers/codex/codex-turn-usage.mjs";

test("historical rollout worker scans one file and returns its native terminal turns", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-history-worker-"));
  const transcriptPath = path.join(directory, "rollout.jsonl");
  const rolloutId = "019f1ec7-8de7-7aa3-92b6-045036561c8e";
  const turnId = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
  const lines = [
    { type: "session_meta", payload: { id: rolloutId, cwd: "D:/work" } },
    { timestamp: "2026-08-03T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-08-03T10:00:01.000Z", type: "response_item", payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Готово" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
    { timestamp: "2026-08-03T10:00:02.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  try {
    const result = await scanCodexHistoricalRolloutInWorker({ path: transcriptPath, id: rolloutId });
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].turnId, turnId);
    assert.equal(result.turns[0].terminal, true);
    assert.equal(result.turns[0].finalAnswer, "Готово");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical rollout worker excludes a manual compaction pseudo-turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-history-compact-"));
  const transcriptPath = path.join(directory, "rollout.jsonl");
  const rolloutId = "019f1ec7-8de7-7aa3-92b6-045036561c8e";
  const turnId = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
  const lines = [
    { type: "session_meta", payload: { id: rolloutId, cwd: "D:/work" } },
    { timestamp: "2026-08-03T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-08-03T10:00:01.000Z", type: "compacted", payload: {
      replacement_history: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Старый ответ" }],
        internal_chat_message_metadata_passthrough: { turn_id: "old-turn" },
      }],
    } },
  ];
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  try {
    const result = await scanCodexHistoricalRolloutInWorker({ path: transcriptPath, id: rolloutId });
    assert.deepEqual(result.turns, []);
    const live = await scanCodexLiveRolloutInWorker(transcriptPath, { maxBytes: 64 * 1024 });
    assert.deepEqual(live, await scanCodexHistoricalRollout(transcriptPath));
    assert.equal(live.turns.length, 1);
    assert.equal(live.turns[0].compactionOnly, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical worker retains only measured service operations with native identities", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-service-usage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout.jsonl");
  const threadId = "019f1ec7-8de7-7aa3-92b6-045036561c8e";
  const compactId = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
  const probeId = "019f1ec9-8de7-7aa3-92b6-045036561c8e";
  const usage = (turnId, count) => ({ type: "token_usage_record", payload: { turn_id: turnId,
    turn_token_usage: { input_tokens: count, cached_input_tokens: 0, output_tokens: 0,
      reasoning_output_tokens: 0, total_tokens: count } } });
  const rows = [
    { type: "session_meta", payload: { id: threadId, cwd: directory } },
    { type: "event_msg", payload: { type: "task_started", turn_id: compactId } },
    { type: "event_msg", payload: { type: "thread_settings_applied",
      thread_settings: { model: "gpt-6-astra" } } },
    { type: "compacted", payload: {} }, usage(compactId, 400),
    { type: "event_msg", payload: { type: "task_complete", turn_id: compactId } },
    { type: "event_msg", payload: { type: "task_started", turn_id: probeId } },
    { type: "response_item", payload: { type: "message", role: "user", client_id: "agent-hub-context-probe:de823030-9f98-40e6-9d93-066062d977c6",
      content: [{ type: "input_text", text: "probe" }],
      internal_chat_message_metadata_passthrough: { turn_id: probeId } } },
    { type: "turn_context", payload: { turn_id: probeId, model: "gpt-5.6-sol" } },
    usage(probeId, 300),
    { type: "event_msg", payload: { type: "task_complete", turn_id: probeId } },
  ];
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const first = await scanCodexHistoricalRolloutInWorker({ id: threadId, path: file });
  const second = await scanCodexHistoricalRolloutInWorker({ id: threadId, path: file });
  assert.deepEqual(second.turns, first.turns);
  assert.deepEqual(first.turns.map((turn) => [turn.turnId, turn.serviceUsageKind,
    turn.usage.inputTokens]), [[compactId, "context-compaction", 400],
    [probeId, "context-probe", 300]]);
});

test("live worker preserves the complete scanner result and exact usage across two bounded chunks", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-live-worker-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "rollout.jsonl");
  const rolloutId = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
  const turnId = "019f1ec7-8de7-7aa3-92b6-045036561c8e";
  const encode = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const usageRecord = (input, output) => ({ type: "token_usage_record", payload: {
    turn_id: turnId,
    turn_token_usage: { input_tokens: input, cached_input_tokens: 80, output_tokens: output, reasoning_output_tokens: 3, total_tokens: input + output },
  } });
  const prefix = encode([
    { type: "session_meta", payload: { id: rolloutId, cwd: directory } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: { turn_id: turnId, model: "gpt-6-astra" } },
    usageRecord(100, 10),
  ]);
  const maxBytes = 64 * 1024;
  const filler = { type: "padding", payload: "" };
  filler.payload = "x".repeat(maxBytes - Buffer.byteLength(prefix) - Buffer.byteLength(encode([filler])));
  const firstChunk = prefix + encode([filler]);
  assert.equal(Buffer.byteLength(firstChunk), maxBytes);
  const suffix = encode([
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 } } } },
    usageRecord(150, 20),
    { type: "event_msg", payload: { type: "image_generation_end", turn_id: turnId, call_id: "image-call", status: "completed", saved_path: path.join(directory, "generated.png") } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ]);
  await writeFile(transcriptPath, firstChunk + suffix, "utf8");
  const first = await scanCodexLiveRolloutInWorker(transcriptPath, { maxBytes });
  assert.deepEqual(first, await scanCodexHistoricalRollout(transcriptPath, { maxBytes }));
  assert.equal(first.nextOffset, maxBytes);
  assert.equal(first.turns[0].terminal, false);
  assert.equal(first.turns[0].usage.totalTokens, 110);
  assert.equal(first.resumeState.turns[0].exactUsageReported, true);
  const resumeState = JSON.parse(JSON.stringify(first.resumeState));
  const options = { startOffset: first.nextOffset, maxBytes, resumeState };
  const second = await scanCodexLiveRolloutInWorker(transcriptPath, options);
  assert.deepEqual(second, await scanCodexHistoricalRollout(transcriptPath, options));
  assert.equal(second.nextOffset, Buffer.byteLength(firstChunk + suffix));
  assert.equal(second.session.threadId, rolloutId);
  assert.equal(second.turns[0].turnId, turnId);
  assert.equal(second.turns[0].model, "gpt-6-astra");
  assert.equal(second.turns[0].terminal, true);
  assert.equal(second.turns[0].started, true);
  assert.deepEqual(second.turns[0].usage, { inputTokens: 150, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 3, totalTokens: 170 });
  assert.deepEqual(second.resumeState.turns, []);
  assert.deepEqual(second.attachmentCandidates, [{ turnId, generatedImageSources: [{ type: "generated-path", value: path.join(directory, "generated.png") }] }]);
});

test("live worker rejects exit without a result including exit code zero", async () => {
  for (const code of [0, 1]) {
    class ExitingWorker extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit("exit", code));
      }
    }
    await assert.rejects(scanCodexLiveRolloutInWorker("rollout.jsonl", { maxBytes: 1024, WorkerImpl: ExitingWorker }), {
      message: `Live rollout worker exited with code ${code} without a scan result`,
    });
    if (code === 0) assert.deepEqual(await scanCodexHistoricalRolloutInWorker({ path: "rollout.jsonl" }, { WorkerImpl: ExitingWorker }), { turns: [] });
  }
});

test("live worker rejects incomplete successful messages and preserves worker failures", async () => {
  for (const message of [{ ok: true }, { ok: true, result: { turns: [], nextOffset: 1024 } }, { ok: false, error: "scan failed" }]) {
    class MessagingWorker extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => { this.emit("message", message); this.emit("exit", 0); });
      }
    }
    await assert.rejects(scanCodexLiveRolloutInWorker("rollout.jsonl", { maxBytes: 1024, WorkerImpl: MessagingWorker }), /invalid scan result|scan failed/);
  }
});

test("live worker requires bounded bytes and a valid checkpoint before spawning", () => {
  class UnexpectedWorker {
    constructor() { assert.fail("must validate before spawning"); }
  }
  for (const maxBytes of [undefined, 0, -1, Infinity, NaN, 1.5]) {
    assert.throws(() => scanCodexLiveRolloutInWorker("rollout.jsonl", { maxBytes, WorkerImpl: UnexpectedWorker }), /maxBytes/);
  }
  for (const startOffset of [-1, Infinity, 1.5]) {
    assert.throws(() => scanCodexLiveRolloutInWorker("rollout.jsonl", { startOffset, maxBytes: 1024, WorkerImpl: UnexpectedWorker }), /startOffset/);
  }
});
