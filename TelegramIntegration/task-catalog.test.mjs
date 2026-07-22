import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogEntryIsSelected,
  claudeCatalogEntry,
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
  claudeSnapshotIsActive,
  codexCatalogEntry,
  codexObservedExecutionOwner,
  codexThreadRunning,
  mergeTaskCatalog,
  pinnedTaskTitle,
  pinTaskTitle,
  parseTaskCatalogCallback,
  parseCodexRolloutActivity,
  parseCodexRolloutRunning,
  readCodexRolloutActivity,
  readCodexRolloutRunning,
  runningTaskReplyMarkup,
  selectCodexTurn,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
  taskExecutionRuntimeShortLabel,
  taskCatalogCallback,
} from "./task-catalog.mjs";

const project = { name: "Основной", path: "C:\\Projects\\Main" };

test("pinned task titles are stable per provider and thread", () => {
  const titles = {};
  assert.equal(pinTaskTitle(titles, "codex", "thread-a", "  FB   Фаровон обмен1  "), "FB Фаровон обмен1");
  assert.equal(pinTaskTitle(titles, "codex", "thread-b", "Правки ТГ Бота"), "Правки ТГ Бота");
  assert.equal(pinnedTaskTitle(titles, "codex", "thread-a"), "FB Фаровон обмен1");
  assert.equal(pinnedTaskTitle(titles, "codex", "thread-b"), "Правки ТГ Бота");
  assert.equal(pinnedTaskTitle(titles, "claude", "thread-a"), "");
});

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
    executionOwner: null,
    lastActivityAtMs: null,
  });
});

test("Codex runtime labels distinguish supported app servers", () => {
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.VSCODE), "VSCode App Server");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.TELEGRAM), "Integration App Server");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.DESKTOP), "Codex Desktop App");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.CLI), "Codex CLI");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.EXTERNAL), "External Codex");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.VSCODE), "VSC");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.TELEGRAM), "INT");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.DESKTOP), "APP");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.CLI), "CLI");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.EXTERNAL), "EXT");
});

test("observed ownership follows the active turn instead of historical session metadata", () => {
  assert.equal(codexObservedExecutionOwner({
    originator: "telegram_codex_bridge",
    source: "unknown",
    activeVscodeTurnIds: ["vsc-turn"],
  }), TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(codexObservedExecutionOwner({
    originator: "Codex Desktop",
    source: "vscode",
    activeVscodeTurnIds: [],
  }), TASK_EXECUTION_OWNERS.EXTERNAL);
  assert.equal(codexObservedExecutionOwner({
    originator: "Codex Desktop",
    activeVscodeTurnIds: ["vsc-turn"],
  }, "vsc-turn"), TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(codexObservedExecutionOwner({
    originator: "Codex Desktop",
    activeVscodeTurnIds: ["vsc-turn"],
  }, "other-turn"), TASK_EXECUTION_OWNERS.EXTERNAL);
});

test("Codex rollout activity identifies the current VSC turn by client id", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "session_meta",
      payload: { originator: "codex_vscode", source: "vscode" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "one" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", client_id: "vscode-client", message: "Продолжай" },
    }),
  ].join("\n"));
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.reasoningEffort, "medium");
  assert.deepEqual(result.activeTurnIds, ["one"]);
  assert.deepEqual(result.activeVscodeTurnIds, ["one"]);
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
    activeVscodeTurnIds: [],
    activityAtMsByTurnId: {},
    model: null,
    reasoningEffort: null,
    latestTurnId: "parallel",
    latestMessages: {},
    finalMessages: {},
    unscopedLatestMessage: null,
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
    activeVscodeTurnIds: [],
    activityAtMsByTurnId: {
      live: Date.parse("2026-07-17T19:29:30Z"),
    },
    model: null,
    reasoningEffort: null,
    latestTurnId: "live",
    latestMessages: {},
    finalMessages: {},
    unscopedLatestMessage: null,
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

test("rollout activity makes an externally running Codex thread active", () => {
  assert.equal(codexThreadRunning(
    { status: { type: "idle" }, turns: [{ id: "external", status: "completed" }] },
    { rolloutRunning: true },
  ), true);
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

test("a bot-managed Codex run stays attached to its own parallel turn", () => {
  const turns = [
    { id: "managed", status: "completed" },
    { id: "external", status: "inProgress" },
  ];
  assert.equal(selectCodexTurn(turns, {
    requestedTurnId: "managed",
    rolloutActiveTurnIds: ["external"],
    strictRequested: true,
  }).id, "managed");
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

test("readCodexRolloutActivity follows append-only lifecycle updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-codex-rollout-append-"));
  const rollout = path.join(root, "rollout.jsonl");
  const line = (type, turnId) => JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type, turn_id: turnId },
  });
  await writeFile(rollout, `${line("task_started", "first")}\n`, "utf8");
  assert.deepEqual(
    (await readCodexRolloutActivity(rollout)).activeTurnIds,
    ["first"],
  );
  await appendFile(
    rollout,
    `${line("task_started", "second")}\n${line("task_complete", "first")}\n`,
    "utf8",
  );
  assert.deepEqual(
    (await readCodexRolloutActivity(rollout)).activeTurnIds,
    ["second"],
  );
});

test("readCodexRolloutActivity preserves a JSONL line split across reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-codex-rollout-partial-"));
  const rollout = path.join(root, "rollout.jsonl");
  const line = (type) => JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type, turn_id: "split" },
  });
  const completed = line("task_complete");
  await writeFile(
    rollout,
    `${line("task_started")}\n${completed.slice(0, -4)}`,
    "utf8",
  );
  assert.deepEqual(
    (await readCodexRolloutActivity(rollout)).activeTurnIds,
    ["split"],
  );
  await appendFile(rollout, `${completed.slice(-4)}\n`, "utf8");
  assert.deepEqual(
    (await readCodexRolloutActivity(rollout)).activeTurnIds,
    [],
  );
});

test("rollout activity exposes current and final messages without thread/read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-codex-rollout-message-"));
  const rollout = path.join(root, "rollout.jsonl");
  const entry = (type, payload) => JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    payload,
  });
  await writeFile(rollout, [
    entry("event_msg", { type: "task_started", turn_id: "turn-1" }),
    entry("event_msg", { type: "agent_message", message: "Текущий этап" }),
  ].join("\n") + "\n", "utf8");
  let activity = await readCodexRolloutActivity(rollout);
  assert.equal(activity.latestTurnId, "turn-1");
  assert.equal(activity.latestMessages["turn-1"], "Текущий этап");
  await appendFile(rollout, `${entry("event_msg", {
    type: "task_complete",
    turn_id: "turn-1",
    last_agent_message: "Итог",
  })}\n`, "utf8");
  activity = await readCodexRolloutActivity(rollout);
  assert.equal(activity.running, false);
  assert.equal(activity.finalMessages["turn-1"], "Итог");
});

test("concurrent rollout messages stay attached to their response_item turn ids", () => {
  const entry = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
  const assistant = (turnId, text) => entry("2026-07-22T12:00:00.000Z", "response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const activity = parseCodexRolloutActivity([
    entry("2026-07-22T11:59:00.000Z", "event_msg", { type: "task_started", turn_id: "first" }),
    entry("2026-07-22T11:59:01.000Z", "event_msg", { type: "task_started", turn_id: "second" }),
    entry("2026-07-22T11:59:02.000Z", "event_msg", { type: "agent_message", message: "Текст второго" }),
    assistant("second", "Текст второго"),
    entry("2026-07-22T12:00:01.000Z", "event_msg", { type: "agent_message", message: "Текст первого" }),
    entry("2026-07-22T12:00:01.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Текст первого" }],
      internal_chat_message_metadata_passthrough: { turn_id: "first" },
    }),
  ].join("\n"));

  assert.deepEqual(activity.activeTurnIds, ["second", "first"]);
  assert.equal(activity.latestTurnId, "first");
  assert.equal(activity.latestMessages.first, "Текст первого");
  assert.equal(activity.latestMessages.second, "Текст второго");
  assert.equal(activity.latestMessages.first.includes("Текст второго"), false);
});

test("a bounded cold tail keeps an unscoped current message when task_started is older", () => {
  const activity = parseCodexRolloutActivity(JSON.stringify({
    timestamp: "2026-07-22T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "still working" },
  }));
  assert.equal(activity.unscopedLatestMessage, "still working");
  assert.equal(activity.latestTurnId, null);
});

test("cold rollout reads only a bounded tail and skips an oversized line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-codex-rollout-tail-"));
  const rollout = path.join(root, "rollout.jsonl");
  const line = (type, turnId, extra = {}) => JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type, turn_id: turnId, ...extra },
  });
  await writeFile(rollout, `${"x".repeat(32_000)}\n${line("task_started", "tail")}\n`, "utf8");
  const activity = await readCodexRolloutActivity(rollout, {
    tailBytes: 2_000,
    maximumLineBytes: 1_000,
  });
  assert.deepEqual(activity.activeTurnIds, ["tail"]);
});

test("rollout cache detects a truncated file that regrew before the next poll", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-codex-rollout-replaced-"));
  const rollout = path.join(root, "rollout.jsonl");
  const line = (type, turnId, extra = {}) => JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type, turn_id: turnId, ...extra },
  });
  await writeFile(rollout, `${line("task_started", "old")}\n`, "utf8");
  assert.deepEqual((await readCodexRolloutActivity(rollout)).activeTurnIds, ["old"]);
  await writeFile(rollout, [
    line("task_started", "new"),
    line("task_complete", "new", { last_agent_message: "Новый итог" }),
    JSON.stringify({ padding: "x".repeat(500) }),
  ].join("\n") + "\n", "utf8");
  const activity = await readCodexRolloutActivity(rollout);
  assert.deepEqual(activity.activeTurnIds, []);
  assert.equal(activity.latestTurnId, "new");
  assert.equal(activity.finalMessages.new, "Новый итог");
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

test("claudeSnapshotIsActive ignores an abandoned incomplete transcript", () => {
  const now = 2_000_000;
  assert.equal(claudeSnapshotIsActive({ active: true, modifiedAtMs: now - 60_000 }, { nowMs: now }), true);
  assert.equal(claudeSnapshotIsActive({ active: true, modifiedAtMs: now - 31 * 60_000 }, { nowMs: now }), false);
  assert.equal(claudeSnapshotIsActive({ active: false, modifiedAtMs: now }, { nowMs: now }), false);
  assert.equal(claudeSnapshotIsActive(null, { nowMs: now }), false);
  assert.equal(claudeSnapshotIsActive({ active: true }, { nowMs: now }), false);
});

test("claudeSnapshotIsActive accepts a transcript timestamp without file mtime", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const snapshot = { active: true, updatedAt: "2026-07-21T11:55:00.000Z" };
  assert.equal(claudeSnapshotActivityAtMs(snapshot), Date.parse(snapshot.updatedAt));
  assert.equal(claudeSnapshotIsActive(snapshot, { nowMs: now }), true);
  assert.equal(
    claudeSnapshotIsActive({ active: true, updatedAt: "2026-07-21T10:00:00.000Z" }, { nowMs: now }),
    false,
  );
});

test("stale incomplete Claude transcript has unknown rather than inactive activity", () => {
  const now = 2_000_000;
  assert.equal(claudeSnapshotActivityState({
    active: true,
    modifiedAtMs: now - 31 * 60_000,
  }, { nowMs: now }), "unknown");
  assert.equal(claudeSnapshotActivityState({
    active: true,
    modifiedAtMs: now - 60_000,
  }, { nowMs: now }), "active");
  assert.equal(claudeSnapshotActivityState({ completed: true }, { nowMs: now }), "inactive");
  assert.equal(claudeCatalogEntry({
    sessionId: "claude-stale",
    active: true,
    modifiedAtMs: now - 31 * 60_000,
  }, project, now).activityUnknown, true);
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

test("observer ownership overrides historical catalog ownership", () => {
  const [entry] = mergeTaskCatalog([{
    provider: "codex",
    threadId: "codex-observed",
    projectRoot: project.path,
    projectName: project.name,
    title: "Наблюдаемая",
    updatedAtMs: 1,
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.TELEGRAM,
  }], [{
    id: "observer",
    provider: "codex",
    threadId: "codex-observed",
    projectRoot: project.path,
    observer: true,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
  }]);
  assert.equal(entry.executionOwner, TASK_EXECUTION_OWNERS.VSCODE);
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

test("runningTaskReplyMarkup shows active tasks first and fills four rows with recent tasks", () => {
  const markup = runningTaskReplyMarkup([{
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Тестирование обмена документами",
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    lastActivityAtMs: 300,
  }, {
    provider: "claude",
    threadId: "a2ea7518-5826-4480-aaff-bb80915953d8",
    projectRoot: "C:\\Projects\\Utilities",
    projectName: "Utilities",
    title: "Завершённая",
    running: false,
    updatedAtMs: 500,
  }, {
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf014",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Вторая активная",
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.TELEGRAM,
    lastActivityAtMs: 200,
  }, {
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf015",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Недавняя",
    running: false,
    lastActivityAtMs: 400,
  }, {
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf016",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Старая не помещается",
    running: false,
    updatedAtMs: 100,
  }], {
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    projectRoot: "C:\\Projects\\Main",
  });
  assert.deepEqual(markup, {
    inline_keyboard: [[{
      text: "✅ ТЕКУЩАЯ · VSC · Codex · Тестирование обмена документами",
      callback_data: "task:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    }], [{
      text: "🧵 · INT · Codex · Вторая активная",
      callback_data: "task:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf014",
    }], [{
      text: "🕘 · Claude · Завершённая",
      callback_data: "task:l:a2ea7518-5826-4480-aaff-bb80915953d8",
    }], [{
      text: "🕘 · Codex · Недавняя",
      callback_data: "task:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf015",
    }]],
  });
});

test("running task buttons include project only when requested", () => {
  const entries = [{
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Фаровон",
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.TELEGRAM,
  }];
  assert.equal(
    runningTaskReplyMarkup(entries, null).inline_keyboard[0][0].text,
      "🧵 · INT · Codex · Фаровон",
  );
  assert.equal(
    runningTaskReplyMarkup(entries, null, { showProject: true }).inline_keyboard[0][0].text,
      "🧵 · INT · Codex · VSC_Tyrael · Фаровон",
  );
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
