import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexRolloutTurnState, readCodexRolloutActivityOnCurrentThread } from "../../../src/providers/codex/codex-rollout-activity.mjs";

// A cold read of a rollout larger than the raw tail infers active turns,
// because the matching task_started can sit before the observation window.
// Codex still flushes item_completed records for tools that were running when
// the turn ended, so those trailing records must not resurrect the turn.
const ABORTED_TURN = "01a09073-42b9-7821-b76c-bf39740e3a21";
const COMPLETED_TURN = "01a0907b-4596-70e1-82c7-16b652329f69";

function stamp(offsetMs, nowMs) {
  return new Date(nowMs + offsetMs).toISOString();
}

async function writeRollout(file, nowMs) {
  const rows = [
    { timestamp: stamp(-900_000, nowMs), type: "session_meta", payload: { id: "01a08b07-5fde-7310-a226-614ae6f9ba36" } },
    // Pushes the observation window past the head so the cold read infers.
    { timestamp: stamp(-880_000, nowMs), type: "response_item", payload: { type: "tool_output", text: "x".repeat(50_000) } },
    { timestamp: stamp(-520_000, nowMs), type: "event_msg", payload: { type: "task_started", turn_id: ABORTED_TURN } },
    { timestamp: stamp(-519_000, nowMs), type: "event_msg", payload: { type: "user_message", turn_id: ABORTED_TURN, message: "проверь контур" } },
    { timestamp: stamp(-61_000, nowMs), type: "response_item", payload: { type: "message", role: "assistant", turn_id: ABORTED_TURN, content: [{ type: "output_text", text: "Промежуточный ответ." }] } },
    { timestamp: stamp(-60_000, nowMs), type: "event_msg", payload: { type: "turn_aborted", turn_id: ABORTED_TURN } },
    // Tool that was still running when the turn was aborted.
    { timestamp: stamp(-49_000, nowMs), type: "event_msg", payload: { type: "item_completed", turn_id: ABORTED_TURN, item: { type: "CommandExecution", id: "exec-1", status: "completed", exit_code: 0 } } },
    { timestamp: stamp(-40_000, nowMs), type: "event_msg", payload: { type: "task_started", turn_id: COMPLETED_TURN } },
    { timestamp: stamp(-39_000, nowMs), type: "event_msg", payload: { type: "user_message", turn_id: COMPLETED_TURN, message: "теперь собери отчёт" } },
    { timestamp: stamp(-31_000, nowMs), type: "response_item", payload: { type: "message", role: "assistant", turn_id: COMPLETED_TURN, content: [{ type: "output_text", text: "Отчёт готов." }] } },
    { timestamp: stamp(-30_000, nowMs), type: "event_msg", payload: { type: "task_complete", turn_id: COMPLETED_TURN, last_agent_message: "Отчёт готов." } },
  ];
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

test("a trailing record of an aborted turn does not revive it as a running turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-aborted-turn-"));
  const file = path.join(directory, "rollout.jsonl");
  const nowMs = Date.now();
  try {
    await writeRollout(file, nowMs);
    // tailBytes below the file size is what enables inference on a cold read.
    const activity = await readCodexRolloutActivityOnCurrentThread(file, {
      nowMs,
      tailBytes: 4096,
    });

    assert.deepEqual(activity.activeTurnIds, [],
      "прерванный ход снова показан выполняющимся");
    assert.equal(activity.running, false,
      "поток показан выполняющимся после прерванного хода");

    // The finished history of both turns stays readable.
    assert.equal(activity.latestMessages[ABORTED_TURN], "Промежуточный ответ.");
    assert.equal(activity.finalMessages[COMPLETED_TURN], "Отчёт готов.");
    assert.equal(activity.latestTurnId, COMPLETED_TURN);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inference still adopts a turn whose task_started is outside the observation window", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-inferred-turn-"));
  const file = path.join(directory, "rollout.jsonl");
  const nowMs = Date.now();
  try {
    const rows = [
      { timestamp: stamp(-900_000, nowMs), type: "session_meta", payload: { id: "01a08b07-5fde-7310-a226-614ae6f9ba36" } },
      { timestamp: stamp(-880_000, nowMs), type: "response_item", payload: { type: "tool_output", text: "x".repeat(50_000) } },
      { timestamp: stamp(-20_000, nowMs), type: "event_msg", payload: { type: "user_message", turn_id: ABORTED_TURN, message: "продолжай" } },
      { timestamp: stamp(-10_000, nowMs), type: "response_item", payload: { type: "message", role: "assistant", turn_id: ABORTED_TURN, content: [{ type: "output_text", text: "Работаю." }] } },
    ];
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const activity = await readCodexRolloutActivityOnCurrentThread(file, {
      nowMs,
      tailBytes: 4096,
    });
    assert.deepEqual(activity.activeTurnIds, [ABORTED_TURN],
      "выполняющийся ход без task_started в окне перестал определяться");
    assert.equal(activity.running, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("old promptless task_started stays unknown across cache/reopen until its exact terminal event", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-promptless-terminal-"));
  const file = path.join(directory, "rollout.jsonl");
  const turnId = "01a0ecfb-d1fa-7e20-a64e-02cf4902e19b";
  const nowMs = Date.parse("2026-09-29T11:46:00.000Z");
  const rows = [
    { timestamp: stamp(-60_000, nowMs), type: "session_meta", payload: { id: "01a07cd5-d039-7fd3-95c4-71f3672f8d52" } },
    { timestamp: stamp(-40_000, nowMs), type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
  ];
  const read = () => readCodexRolloutActivityOnCurrentThread(file, { nowMs, pinCache: true });
  try {
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    for (const activity of [await read(), await read()]) {
      assert.deepEqual(activity.activeTurnIds, []);
      assert.deepEqual(activity.internalTurnIds, [turnId]);
      const state = codexRolloutTurnState(activity, turnId, { exact: true });
      assert.equal(state.active, false);
      assert.equal(state.completed, false);
      assert.equal(state.terminalStatus, "");
    }
    await appendFile(file, `${JSON.stringify({ timestamp: stamp(1_000, nowMs), type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Готово" } })}\n`, "utf8");
    const terminal = codexRolloutTurnState(await read(), turnId, { exact: true });
    assert.equal(terminal.completed, true);
    assert.equal(terminal.terminalStatus, "completed");
    assert.equal(terminal.finalAnswer, "Готово");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
