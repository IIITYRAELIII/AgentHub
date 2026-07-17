import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogEntryIsSelected,
  claudeCatalogEntry,
  codexCatalogEntry,
  codexThreadRunning,
  mergeTaskCatalog,
  parseTaskCatalogCallback,
  parseCodexRolloutActivity,
  parseCodexRolloutRunning,
  readCodexRolloutRunning,
  runningTaskReplyMarkup,
  selectCodexTurn,
  taskCatalogCallback,
} from "./task-catalog.mjs";

const project = { name: "Основной", path: "C:\\Projects\\Main" };

test("codexCatalogEntry preserves persistent task metadata and active status", () => {
  assert.deepEqual(codexCatalogEntry({
    id: "codex-1",
    name: "  Первая\n задача ",
    updatedAt: 123,
    status: { type: "active", activeFlags: [] },
  }, project), {
    provider: "codex",
    threadId: "codex-1",
    projectRoot: project.path,
    projectName: project.name,
    title: "Первая задача",
    updatedAtMs: 123000,
    running: true,
  });
});

test("parseCodexRolloutRunning follows the latest turn lifecycle marker", () => {
  const line = (type) => JSON.stringify({ type: "event_msg", payload: { type } });
  assert.equal(parseCodexRolloutRunning([
    line("task_started"),
    line("task_complete"),
    line("task_started"),
  ].join("\n")), true);
  assert.equal(parseCodexRolloutRunning([
    line("task_started"),
    line("turn_aborted"),
  ].join("\n")), false);
});

test("Codex rollout activity keeps another concurrent turn active after one is aborted", () => {
  const line = (type, turnId) => JSON.stringify({
    type: "event_msg",
    payload: { type, turn_id: turnId },
  });
  const text = [
    line("task_started", "original"),
    line("task_started", "parallel"),
    line("turn_aborted", "parallel"),
  ].join("\n");
  assert.deepEqual(parseCodexRolloutActivity(text), {
    running: true,
    activeTurnIds: ["original"],
  });
  assert.equal(parseCodexRolloutRunning(`${text}\n${line("task_complete", "original")}`), false);
});

test("Codex rollout activity ignores stale unmatched starts but keeps a fresh live turn", () => {
  const line = (value) => JSON.stringify(value);
  const nowMs = Date.parse("2026-07-17T19:30:00Z");
  const text = [
    line({
      timestamp: "2026-07-17T18:00:00Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "stale" },
    }),
    line({
      timestamp: "2026-07-17T19:29:00Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "live" },
    }),
    line({
      timestamp: "2026-07-17T19:29:30Z",
      type: "response_item",
      payload: {
        type: "message",
        internal_chat_message_metadata_passthrough: { turn_id: "live" },
      },
    }),
  ].join("\n");
  assert.deepEqual(parseCodexRolloutActivity(text, {
    nowMs,
    freshnessMs: 10 * 60 * 1000,
  }), {
    running: true,
    activeTurnIds: ["live"],
  });
});

test("stale rollout markers do not make an idle Codex thread active", () => {
  const turns = [
    { id: "stale", status: "completed" },
    { id: "latest", status: "completed" },
  ];
  const thread = { status: { type: "idle" }, turns };
  assert.equal(codexThreadRunning(thread), false);
  assert.equal(selectCodexTurn(turns, {
    rolloutActiveTurnIds: ["stale"],
  }).id, "latest");
});

test("Codex turn selection prefers a genuinely in-progress turn", () => {
  const turns = [
    { id: "stale", status: "completed" },
    { id: "running", status: "inProgress" },
  ];
  assert.equal(codexThreadRunning({ status: { type: "idle" }, turns }), true);
  assert.equal(selectCodexTurn(turns, {
    requestedTurnId: "stale",
    rolloutActiveTurnIds: ["stale", "running"],
  }).id, "running");
});

test("readCodexRolloutRunning reads a fresh local rollout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-codex-rollout-"));
  const rollout = path.join(root, "rollout.jsonl");
  await writeFile(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
  ].join("\n"), "utf8");

  assert.equal(await readCodexRolloutRunning(rollout), true);
});

test("claudeCatalogEntry treats only a fresh incomplete transcript as running", () => {
  const now = 2_000_000;
  const fresh = claudeCatalogEntry({
    sessionId: "claude-1",
    title: "Вторая задача",
    modifiedAtMs: now - 60_000,
    active: true,
  }, project, now);
  const stale = claudeCatalogEntry({
    sessionId: "claude-2",
    modifiedAtMs: now - 31 * 60_000,
    active: true,
  }, project, now);
  assert.equal(fresh.running, true);
  assert.equal(stale.running, false);
});

test("mergeTaskCatalog adds bot runs and promotes them to the top", () => {
  const entries = [{
    provider: "codex",
    threadId: "codex-1",
    projectRoot: project.path,
    projectName: project.name,
    title: "Старая",
    updatedAtMs: 1,
    running: false,
  }];
  const merged = mergeTaskCatalog(entries, [{
    id: "run-1",
    provider: "codex",
    threadId: "codex-1",
    projectRoot: project.path,
    taskTitle: "Старая",
  }, {
    id: "run-2",
    provider: "claude",
    threadId: "claude-1",
    projectRoot: project.path,
    projectName: project.name,
    taskTitle: "Новая",
  }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.every((entry) => entry.running), true);
});

test("task catalog callbacks identify provider and task", () => {
  const entry = { provider: "claude", threadId: "a2ea7518-5826-4480-aaff-bb80915953d8" };
  const callback = taskCatalogCallback(entry);
  assert.equal(callback, "task:l:a2ea7518-5826-4480-aaff-bb80915953d8");
  assert.deepEqual(parseTaskCatalogCallback(callback), {
    provider: "claude",
    threadId: entry.threadId,
  });
  assert.equal(parseTaskCatalogCallback("task:x:nope"), null);
});

test("runningTaskReplyMarkup creates switch buttons only for active tasks", () => {
  const markup = runningTaskReplyMarkup([{
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Тестирование обмена документами",
    running: true,
  }, {
    provider: "claude",
    threadId: "a2ea7518-5826-4480-aaff-bb80915953d8",
    projectName: "Utilities",
    title: "Завершённая",
    running: false,
  }], {
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    projectRoot: "C:\\Projects\\Main",
  });
  assert.deepEqual(markup, {
    inline_keyboard: [[{
      text: "✅ ТЕКУЩАЯ · Codex · VSC_Tyrael · Тестирование обмена документами",
      callback_data: "task:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    }]],
  });
});

test("catalogEntryIsSelected compares provider, task, and normalized project path", () => {
  assert.equal(catalogEntryIsSelected({
    provider: "codex",
    threadId: "one",
    projectRoot: "C:\\Projects\\Main",
  }, {
    provider: "codex",
    threadId: "one",
    projectRoot: "c:\\projects\\main",
  }), process.platform === "win32");
});
