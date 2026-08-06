import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanCodexHistoricalRolloutInWorker } from "../../../src/providers/codex/codex-historical-backfill.mjs";

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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
