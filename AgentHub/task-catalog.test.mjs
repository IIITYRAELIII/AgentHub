import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogEntryIsSelected,
  catalogEntriesWithoutLiveActivity,
  claudeCatalogEntry,
  claudeSnapshotActivityAtMs,
  claudeSnapshotExecutionOwner,
  claudeSnapshotActivityState,
  claudeSnapshotIsActive,
  codexCatalogEntry,
  codexObservedExecutionOwner,
  codexThreadRunning,
  mergeTaskCatalog,
  pinnedTaskTitle,
  pinTaskTitle,
  preferredCodexTaskTitle,
  reconcilePinnedTaskTitle,
  codexRolloutTurnState,
  parseTaskCatalogCallback,
  parseCodexRolloutActivity,
  parseCodexRolloutRunning,
  readCodexRolloutActivity,
  readCodexRolloutRunning,
  runningTaskReplyMarkup,
  selectCodexTurn,
  selectExactActiveCodexTurnId,
  statusTaskEntries,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
  taskExecutionRuntimeShortLabel,
  taskOrderingActivityAtMs,
  taskCatalogTitleSignature,
  taskCatalogCallback,
} from "./task-catalog.mjs";

const project = { name: "Основной", path: "C:\\Projects\\Main" };

test("mergeTaskCatalog ignores terminal runs when calculating activity", () => {
  const [entry] = mergeTaskCatalog([{
    provider: "codex",
    threadId: "thread-completed",
    projectRoot: project.path,
    projectName: project.name,
    title: "Завершённая задача",
    updatedAtMs: 1,
    running: false,
  }], [{
    provider: "codex",
    threadId: "thread-completed",
    projectRoot: project.path,
    status: "completed",
    taskTitle: "Завершённая задача",
  }]);

  assert.equal(entry.running, false);
});

test("fresh provider activity overrides a newer stale durable catalog row", () => {
  const [entry] = mergeTaskCatalog([{
    provider: "codex",
    threadId: "thread-stale-running",
    projectRoot: project.path,
    projectName: project.name,
    title: "Сохранённое название",
    updatedAtMs: 2_000,
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
    turnId: "stale-turn",
    startedAt: "2026-08-03T10:00:00.000Z",
    lastActivityAtMs: 2_000,
  }, {
    provider: "codex",
    threadId: "thread-stale-running",
    projectRoot: project.path,
    projectName: project.name,
    title: "Старое имя из провайдера",
    updatedAtMs: 1_000,
    running: false,
    executionOwner: null,
    lastActivityAtMs: 1_500,
  }]);

  assert.equal(entry.title, "Сохранённое название");
  assert.equal(entry.running, false);
  assert.equal(entry.executionOwner, null);
  assert.equal(entry.turnId, null);
  assert.equal(entry.startedAt, null);
  assert.equal(entry.lastActivityAtMs, 1_500);
});

test("an authoritative provider title overrides a newer durable read-model title", () => {
  const [entry] = mergeTaskCatalog([{
    provider: "codex",
    threadId: "thread-renamed",
    projectRoot: project.path,
    projectName: project.name,
    title: "Старое название",
    updatedAtMs: 2_000,
    running: false,
  }, {
    provider: "codex",
    threadId: "thread-renamed",
    projectRoot: project.path,
    projectName: project.name,
    title: "Новое название",
    titleAuthoritative: true,
    updatedAtMs: 1_000,
    running: false,
  }]);

  assert.equal(entry.title, "Новое название");
  assert.equal(Object.hasOwn(entry, "titleAuthoritative"), false);
  assert.equal(entry.updatedAtMs, 2_000);
});

test("pinned task titles are stable per provider and thread", () => {
  const titles = {};
  assert.equal(pinTaskTitle(titles, "codex", "thread-a", "  FB   Фаровон обмен1  "), "FB Фаровон обмен1");
  assert.equal(pinTaskTitle(titles, "codex", "thread-b", "Правки ТГ Бота"), "Правки ТГ Бота");
  assert.equal(pinnedTaskTitle(titles, "codex", "thread-a"), "FB Фаровон обмен1");
  assert.equal(pinnedTaskTitle(titles, "codex", "thread-b"), "Правки ТГ Бота");
  assert.equal(pinnedTaskTitle(titles, "claude", "thread-a"), "");
});

test("a title discovered from Codex replaces a stale pinned title", () => {
  const titles = {};
  pinTaskTitle(titles, "codex", "thread-a", "Agent Hub");

  assert.deepEqual(
    reconcilePinnedTaskTitle(titles, "codex", "thread-a", "Agent HUB"),
    { title: "Agent HUB", changed: true },
  );
  assert.equal(pinnedTaskTitle(titles, "codex", "thread-a"), "Agent HUB");
  assert.deepEqual(
    reconcilePinnedTaskTitle(titles, "codex", "thread-a", "Agent HUB"),
    { title: "Agent HUB", changed: false },
  );
});

test("the latest Codex index title wins over stale App Server metadata", () => {
  assert.equal(
    preferredCodexTaskTitle("Agent Hub", {
      currentTitle: "Agent HUB",
      recoverableTitle: "",
    }),
    "Agent HUB",
  );
  assert.equal(
    preferredCodexTaskTitle("Telegram · 27.07.2026, 12:00", {
      currentTitle: "Telegram · 27.07.2026, 12:00",
      recoverableTitle: "Agent HUB",
    }),
    "Agent HUB",
  );
});

test("a live App Server title confirmed by the Hub pin survives a stale index", () => {
  assert.equal(
    preferredCodexTaskTitle("Новое название", {
      currentTitle: "Старое название",
      recoverableTitle: "",
    }, "Новое название"),
    "Новое название",
  );
});

test("a successful Hub rename stays authoritative until the Codex index confirms it", () => {
  assert.equal(
    preferredCodexTaskTitle("Старое название", {
      currentTitle: "Старое название",
      recoverableTitle: "",
    }, "Новое название", "Новое название"),
    "Новое название",
  );
});

test("task title signature changes only with journal-relevant task identity or title", () => {
  const entries = [{
    provider: "codex",
    threadId: "thread-a",
    projectRoot: project.path,
    title: "Agent  Hub",
    running: false,
    updatedAtMs: 100,
  }];
  const signature = taskCatalogTitleSignature(entries);

  assert.equal(taskCatalogTitleSignature([{ ...entries[0], running: true, updatedAtMs: 200 }]), signature);
  assert.equal(taskCatalogTitleSignature([{ ...entries[0], title: "Agent Hub" }]), signature);
  assert.notEqual(taskCatalogTitleSignature([{ ...entries[0], title: "Agent HUB" }]), signature);
});

test("Codex thread status alone does not claim that a turn is running", () => {
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
    model: null,
    updatedAtMs: 123000,
    running: false,
    executionOwner: null,
    lastActivityAtMs: null,
    startedAt: null,
  });
});

test("rollout activity makes a Codex catalog entry running", () => {
  const entry = codexCatalogEntry({
    id: "codex-live",
    name: "Живая задача",
    updatedAt: 123,
    status: { type: "active" },
  }, project, { rolloutRunning: true });
  assert.equal(entry.running, true);
});

test("durable catalog activity is unknown until a live provider scan confirms it", () => {
  assert.deepEqual(catalogEntriesWithoutLiveActivity([{
    provider: "codex",
    threadId: "cached-active",
    projectRoot: project.path,
    title: "Кэшированная задача",
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    turnId: "cached-turn",
    startedAt: "2026-08-03T10:00:00.000Z",
  }]), [{
    provider: "codex",
    threadId: "cached-active",
    projectRoot: project.path,
    title: "Кэшированная задача",
    running: false,
    activityUnknown: true,
    executionOwner: null,
    turnId: null,
    startedAt: null,
  }]);
});

test("Codex runtime labels distinguish supported app servers", () => {
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.VSCODE), "VSCode App Server");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.HUB), "Agent Hub Server");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.DESKTOP), "Codex Desktop App");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.CLI), "Codex CLI");
  assert.equal(taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.EXTERNAL), "External Codex");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.VSCODE), "VSC");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.HUB), "HUB");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.DESKTOP), "APP");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.CLI), "CLI");
  assert.equal(taskExecutionRuntimeShortLabel(TASK_EXECUTION_OWNERS.EXTERNAL), "EXT");
});

test("task ordering changes only on a user turn start or a final answer", () => {
  const entry = {
    updatedAtMs: 9_000,
    lastActivityAtMs: 10_000,
  };
  const run = {
    startedAt: "1970-01-01T00:00:02.000Z",
    lastMeaningfulProgressAt: "1970-01-01T00:00:08.000Z",
    progressHeartbeatAt: "1970-01-01T00:00:09.000Z",
  };

  assert.equal(taskOrderingActivityAtMs(entry, { run }), 2_000);
  assert.equal(taskOrderingActivityAtMs(entry, {
    run,
    lastMessage: { updatedAt: "1970-01-01T00:00:07.000Z" },
  }), 7_000);
  assert.equal(taskOrderingActivityAtMs(entry, {
    run,
    userMessageAtMs: 11_000,
  }), 11_000);
  assert.equal(taskOrderingActivityAtMs(entry), 0);
});

test("parallel active tasks keep their rows while progress timestamps change", () => {
  const first = {
    title: "Первая",
    running: true,
    updatedAtMs: 20_000,
    lastActivityAtMs: 20_000,
    orderingActivityAtMs: 2_000,
  };
  const second = {
    title: "Вторая",
    running: true,
    updatedAtMs: 30_000,
    lastActivityAtMs: 30_000,
    orderingActivityAtMs: 1_000,
  };

  assert.deepEqual(statusTaskEntries([second, first], 2), [first, second]);
  second.updatedAtMs = 40_000;
  second.lastActivityAtMs = 40_000;
  assert.deepEqual(statusTaskEntries([second, first], 2), [first, second]);

  second.orderingActivityAtMs = 50_000;
  assert.deepEqual(statusTaskEntries([first, second], 2), [second, first]);
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
      payload: { type: "user_message", client_id: "vscode-client", message: "Продолжай" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "one" },
    }),
  ].join("\n"));
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.reasoningEffort, "medium");
  assert.deepEqual(result.activeTurnIds, ["one"]);
  assert.deepEqual(result.activeVscodeTurnIds, ["one"]);
  assert.deepEqual(result.userMessages.one, [{
    itemId: "vscode-client",
    clientUserMessageId: "vscode-client",
    role: "user",
    text: "Продолжай",
  }]);
});

test("an unscoped user message is assigned to a new concurrent VSC turn", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "old" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", client_id: "new-client", message: "Новый ход" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "new" },
    }),
  ].join("\n"));
  assert.deepEqual(result.activeTurnIds, ["old", "new"]);
  assert.equal(result.userMessages.old, undefined);
  assert.deepEqual(result.userMessages.new?.map((message) => message.text), ["Новый ход"]);
  assert.deepEqual(result.activeVscodeTurnIds, ["new"]);
});

test("a previous steer is not moved into a later concurrent VSC turn", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "old" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", client_id: "steer", message: "Уточнение старого" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", client_id: "new", message: "Новый ход" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "new" },
    }),
  ].join("\n"));
  assert.deepEqual(result.userMessages.old?.map((message) => message.text), ["Уточнение старого"]);
  assert.deepEqual(result.userMessages.new?.map((message) => message.text), ["Новый ход"]);
  assert.deepEqual(result.activeVscodeTurnIds, ["old", "new"]);
});

test("a trailing VSC user message is exposed before another rollout event arrives", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "one" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", client_id: "client-one", message: "Вопрос" },
    }),
  ].join("\n"));
  assert.deepEqual(result.userMessages.one?.map((message) => message.text), ["Вопрос"]);
  assert.deepEqual(result.activeVscodeTurnIds, ["one"]);
});

test("an unscoped steering message stays with the sole active VSC turn", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "one" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", client_id: "steer-client", message: "Уточнение" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Принято" },
    }),
  ].join("\n"));
  assert.deepEqual(result.userMessages.one?.map((message) => message.text), ["Уточнение"]);
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
    startedAtMsByTurnId: {},
    model: null,
    reasoningEffort: null,
    latestTurnId: "parallel",
    latestMessages: {},
    finalMessages: {},
    userMessages: {},
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
    startedAtMsByTurnId: {
      live: Date.parse("2026-07-17T19:29:00Z"),
    },
    model: null,
    reasoningEffort: null,
    latestTurnId: "live",
    latestMessages: {},
    finalMessages: {},
    userMessages: {},
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

test("an exact Codex observer completes its requested turn instead of following a newer turn", () => {
  const activity = {
    activeTurnIds: ["new-turn"],
    latestTurnId: "new-turn",
    latestMessages: {
      "new-turn": "still working",
    },
    finalMessages: {
      "old-turn": "old turn finished",
    },
    startedAtMsByTurnId: {
      "old-turn": Date.parse("2026-07-17T18:00:00Z"),
      "new-turn": Date.parse("2026-07-17T19:00:00Z"),
    },
  };
  assert.deepEqual(codexRolloutTurnState(activity, "old-turn", {
    exact: true,
    threadActive: true,
  }), {
    turnId: "old-turn",
    active: false,
    completed: true,
    latestAnswer: "",
    finalAnswer: "old turn finished",
    userMessages: [],
    startedAt: "2026-07-17T18:00:00.000Z",
  });
  assert.equal(codexRolloutTurnState(activity, "old-turn", {
    threadActive: true,
  }).turnId, "new-turn");
});

test("deferred notifications select one exact active VS Code turn", () => {
  assert.equal(selectExactActiveCodexTurnId({
    activeTurnIds: ["integration", "vscode"],
    activeVscodeTurnIds: ["vscode"],
  }), "vscode");
  assert.equal(selectExactActiveCodexTurnId({
    activeTurnIds: ["only"],
    activeVscodeTurnIds: [],
  }), "only");
  assert.equal(selectExactActiveCodexTurnId({
    activeTurnIds: [],
    activeVscodeTurnIds: [],
  }), null);
  assert.throws(() => selectExactActiveCodexTurnId({
    activeTurnIds: ["first", "second"],
    activeVscodeTurnIds: [],
  }), /several Codex turns/);
  assert.throws(() => selectExactActiveCodexTurnId({
    activeTurnIds: ["first", "second"],
    activeVscodeTurnIds: ["first", "second"],
  }), /several VS Code turns/);
});

test("readCodexRolloutRunning reads a fresh local rollout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-"));
  const rollout = path.join(root, "rollout.jsonl");
  await writeFile(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
  ].join("\n"), "utf8");

  assert.equal(await readCodexRolloutRunning(rollout), true);
});

test("readCodexRolloutActivity follows append-only lifecycle updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-append-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-partial-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-message-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-tail-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-replaced-"));
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
    cwd: "C:\\Projects\\Main\\Utilities\\AgentHub",
    modifiedAtMs: now - 60_000,
    startedAt: new Date(now - 120_000).toISOString(),
    active: true,
  }, project, now);
  const stale = claudeCatalogEntry({
    sessionId: "claude-2",
    modifiedAtMs: now - 31 * 60_000,
    active: true,
  }, project, now);
  assert.equal(fresh.running, true);
  assert.equal(fresh.orderingActivityAtMs, now - 60_000);
  assert.equal(taskOrderingActivityAtMs(fresh), 0);
  assert.equal(fresh.startedAt, new Date(now - 120_000).toISOString());
  assert.equal(fresh.sessionCwd, path.resolve("C:\\Projects\\Main\\Utilities\\AgentHub"));
  assert.equal(stale.running, false);
});

test("Claude VS Code activity keeps its source and transcript message ordering", () => {
  const updatedAt = "2026-08-03T18:04:52.321Z";
  const entry = claudeCatalogEntry({
    sessionId: "claude-vscode-session",
    modifiedAtMs: Date.parse(updatedAt) + 1_000,
    updatedAt,
    active: true,
    entrypoint: "claude-vscode",
  }, project, Date.parse(updatedAt) + 2_000);
  assert.equal(entry.executionOwner, TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(claudeSnapshotExecutionOwner({ entrypoint: "claude-vscode" }), "vscode");
  assert.equal(entry.messageActivityAtMs, Date.parse(updatedAt));
  assert.equal(taskOrderingActivityAtMs(entry), Date.parse(updatedAt));
});

test("Codex rollout activity retains imagegen output paths for the exact turn", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: [{
          type: "input_text",
          text: "Generated images are saved to C:\\Users\\test\\.codex\\generated_images\\thread as C:\\Users\\test\\.codex\\generated_images\\thread\\call-image.png by default.",
        }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-image" },
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.generatedImageSources, {
    "turn-image": [{
      type: "generated-path",
      value: "C:\\Users\\test\\.codex\\generated_images\\thread\\call-image.png",
    }],
  });
});

test("rollout reader recovers an oversized image_generation_end without loading its base64", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-image-rollout-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  try {
    const turnId = "turn-generated";
    const savedPath = "C:\\Users\\test\\.codex\\generated_images\\thread\\call-image.png";
    await writeFile(rolloutPath, [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "image_generation_end",
          call_id: "call-image",
          saved_path: savedPath,
          result: "a".repeat(16_384),
        },
      }),
    ].join("\n"), "utf8");

    const result = await readCodexRolloutActivity(rolloutPath, {
      freshnessMs: Number.POSITIVE_INFINITY,
      maximumLineBytes: 256,
      tailBytes: 32 * 1024,
    });
    assert.deepEqual(result.generatedImageSources, {
      [turnId]: [{ type: "generated-path", value: savedPath }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mergeTaskCatalog preserves the latest known model for an inactive task", () => {
  const [entry] = mergeTaskCatalog([{
    provider: "codex",
    threadId: "codex-model",
    projectRoot: project.path,
    projectName: project.name,
    title: "Задача",
    model: "Sol",
    updatedAtMs: 1,
  }, {
    provider: "codex",
    threadId: "codex-model",
    projectRoot: project.path,
    projectName: project.name,
    title: "Задача",
    model: null,
    updatedAtMs: 2,
  }]);
  assert.equal(entry.model, "Sol");
});

test("an image-only response item remains a visible rollout user message", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "image-turn" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "\n" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "image-turn" },
      },
    }),
  ].join("\n"));
  assert.deepEqual(result.userMessages["image-turn"]?.map((message) => message.text), ["Изображение"]);
});

test("claudeCatalogEntry resumes from the original session root, not the latest nested cwd", () => {
  const entry = claudeCatalogEntry({
    sessionId: "claude-moved",
    title: "Переименованная задача",
    sessionRoot: "C:\\Projects\\Main",
    cwd: "C:\\Projects\\Main\\Utilities\\AgentHub",
    modifiedAtMs: 1,
    active: false,
  }, project, 2);

  assert.equal(entry.sessionCwd, path.resolve("C:\\Projects\\Main"));
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
    sessionCwd: "C:\\Projects\\Main\\Utilities\\AgentHub",
    taskTitle: "Новая",
  }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.every((entry) => entry.running), true);
  assert.equal(
    merged.find((entry) => entry.threadId === "claude-1").sessionCwd,
    path.resolve("C:\\Projects\\Main\\Utilities\\AgentHub"),
  );
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
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
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

test("run-only observer keeps its detected execution owner", () => {
  const [entry] = mergeTaskCatalog([], [{
    id: "observer-only",
    provider: "codex",
    threadId: "codex-observed-only",
    projectRoot: project.path,
    projectName: project.name,
    taskTitle: "Наблюдаемая без каталога",
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
    orderingActivityAtMs: 300,
  }, {
    provider: "claude",
    threadId: "a2ea7518-5826-4480-aaff-bb80915953d8",
    projectRoot: "C:\\Projects\\Utilities",
    projectName: "Utilities",
    title: "Завершённая",
    running: false,
    updatedAtMs: 500,
    orderingActivityAtMs: 500,
  }, {
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf014",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Вторая активная",
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
    lastActivityAtMs: 200,
    orderingActivityAtMs: 200,
  }, {
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf015",
    projectRoot: "C:\\Projects\\Main",
    projectName: "VSC_Tyrael",
    title: "Недавняя",
    running: false,
    lastActivityAtMs: 400,
    orderingActivityAtMs: 400,
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
      text: "⚡ · HUB · Codex · Вторая активная",
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
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
  }];
  assert.equal(
    runningTaskReplyMarkup(entries, null).inline_keyboard[0][0].text,
      "⚡ · HUB · Codex · Фаровон",
  );
  assert.equal(
    runningTaskReplyMarkup(entries, null, { showProject: true }).inline_keyboard[0][0].text,
      "⚡ · HUB · Codex · VSC_Tyrael · Фаровон",
  );
  assert.equal(
    runningTaskReplyMarkup(entries, entries[0]).inline_keyboard[0][0].text,
      "✅ ТЕКУЩАЯ · ⚡ HUB · Codex · Фаровон",
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
