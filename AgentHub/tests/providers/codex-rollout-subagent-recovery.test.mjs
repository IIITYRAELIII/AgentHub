import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexRolloutActivityOnCurrentThread } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { recoverCodexRolloutSubagents } from "../../src/providers/codex/codex-rollout-activity-worker-client.mjs";

test("archive recovery uses byte occurrence evidence beyond the live tail and protects client identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-subagent-recovery-"));
  const file = path.join(directory, "rollout.jsonl");
  const notification = `<subagent_notification>${JSON.stringify({ agent_path: "child", status: { completed: "Отчёт" } })}</subagent_notification>`;
  const rows = [
    { type: "session_meta", payload: { id: "thread" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", id: "report", content: [{ type: "input_text", text: notification }] } },
    { type: "response_item", payload: { type: "message", role: "user", id: "literal", client_id: "real-client", content: [{ type: "input_text", text: notification.replace('"child"', '"other-child"') }] } },
  ];
  for (const row of rows.filter((entry) => entry.type === "response_item")) {
    row.payload.internal_chat_message_metadata_passthrough = { turn_id: "old-turn" };
  }
  try {
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n", "utf8");
    const original = await readCodexRolloutActivityOnCurrentThread(file);
    const occurrence = original.userMessages["old-turn"][0].sourceOccurrenceId;
    await appendFile(file, JSON.stringify({ type: "response_item", payload: { type: "tool_output", text: "x".repeat(17 * 1024 * 1024) } }) + "\n");
    await appendFile(file, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } }) + "\n");
    const candidates = [{ turnId: "old-turn", sourceOccurrenceId: occurrence }];
    const recovered = await recoverCodexRolloutSubagents(file, candidates);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].role, "agent");
    assert.equal(recovered[0].agentThreadId, "child");
    assert.equal(recovered[0].text, "Отчёт");
    assert.equal(recovered[0].sourceOccurrenceId, occurrence);
    const boundOccurrence = original.userMessages["old-turn"].find((message) => message.itemId === "literal").sourceOccurrenceId;
    assert.deepEqual(await recoverCodexRolloutSubagents(file, [{ turnId: "old-turn", sourceOccurrenceId: boundOccurrence }]), []);
    assert.deepEqual(await recoverCodexRolloutSubagents(file, [{ ...candidates[0], turnId: "new-turn" }]), []);
    assert.deepEqual(await recoverCodexRolloutSubagents(file, [{ ...candidates[0], sourceOccurrenceId: `codex-rollout:${"f".repeat(64)}` }]), []);
    rows[0].payload.id = "other-generation";
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n", "utf8");
    assert.deepEqual(await recoverCodexRolloutSubagents(file, candidates), []);
    await assert.rejects(recoverCodexRolloutSubagents(file, Array(1001).fill(candidates[0])), /Invalid recovery candidates/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
