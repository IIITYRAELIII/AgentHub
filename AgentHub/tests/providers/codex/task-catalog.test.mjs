import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogEntriesWithoutLiveActivity,
  codexCatalogEntry,
  codexObservedExecutionOwner,
  codexThreadRunning,
  codexRolloutTurnState,
  parseCodexRolloutActivity,
  parseCodexRolloutRunning,
  readCodexRolloutActivity,
  readCodexRolloutRunning,
  selectCodexTurn,
  selectExactActiveCodexTurnId,
} from "../../../src/providers/codex/codex-rollout-activity.mjs";
import { currentStreamEntries } from "../../../src/composition/provider-catalog-composition.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../../src/domain/codex-context-probe.mjs";
import { mergeCanonicalUserMessages } from "../../../src/domain/canonical-user-messages.mjs";
import { createInterstreamMessage } from "../../../src/domain/interstream-message.mjs";
import {
  mergeTaskCatalog,
  preserveUnknownActivityOnSourceFailure,
  taskOrderingActivityAtMs,
} from "../../../src/application/task-catalog-projection.mjs";
import {
  pinnedTaskTitle,
  pinTaskTitle,
  preferredCodexTaskTitle,
  reconcilePinnedTaskTitle,
  taskCatalogTitleSignature,
} from "../../../src/domain/task-catalog-titles.mjs";
import { catalogEntryIsSelected } from "../../../src/domain/task-catalog-identity.mjs";
import {
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
  taskExecutionRuntimeShortLabel,
} from "../../../src/domain/task-execution-owner.mjs";
import {
  claudeCatalogEntry,
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
  claudeSnapshotExecutionOwner,
  claudeSnapshotIsActive,
} from "../../../src/providers/claude/claude-task-activity.mjs";
import {
  parseTaskCatalogCallback,
  runningTaskReplyMarkup,
  statusTaskEntries,
  taskCatalogCallback,
} from "../../../src/interfaces/telegram/task-catalog-presentation.mjs";

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

test("fresh Claude context usage enriches a newer durable catalog row", () => {
  const contextUsage = {
    provider: "claude",
    turnId: "claude-turn",
    usedTokens: 195_402,
    modelContextWindow: 1_000_000,
  };
  const [entry] = mergeTaskCatalog([{
    provider: "claude",
    threadId: "claude-thread",
    projectRoot: project.path,
    projectName: project.name,
    title: "Сохранённое название",
    updatedAtMs: 2_000,
    running: false,
  }, {
    provider: "claude",
    threadId: "claude-thread",
    projectRoot: project.path,
    projectName: project.name,
    title: "Claude snapshot",
    updatedAtMs: 1_000,
    running: false,
    contextUsage,
  }]);

  assert.deepEqual(entry.contextUsage, contextUsage);
  assert.notEqual(entry.contextUsage, contextUsage);
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
  }, project, { rolloutRunning: true, activeTurnId: "turn-live" });
  assert.equal(entry.running, true);
  assert.equal(entry.turnId, "turn-live");
});

test("Codex catalog does not publish anonymous running activity", () => {
  const entry = codexCatalogEntry({
    id: "codex-internal",
    name: "Служебный ход",
    updatedAt: 123,
    status: { type: "active" },
  }, project, { rolloutRunning: true });
  assert.equal(entry.running, false);
  assert.equal(entry.activityUnknown, true);
  assert.equal(entry.turnId, undefined);
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
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    turnId: "cached-turn",
    startedAt: "2026-08-03T10:00:00.000Z",
  }]);
});

test("failed provider discovery preserves recent unknown activity", () => {
  const cached = [{
    provider: "codex",
    threadId: "cached-active",
    running: false,
    activityUnknown: true,
    executionOwner: TASK_EXECUTION_OWNERS.DESKTOP,
    turnId: "cached-turn",
  }, {
    provider: "claude",
    threadId: "claude-idle",
    running: false,
    activityUnknown: false,
  }];

  const projected = preserveUnknownActivityOnSourceFailure(cached, [{
    provider: "codex",
    status: "rejected",
  }, {
    provider: "claude",
    status: "fulfilled",
  }]);

  assert.equal(projected[0].running, true);
  assert.equal(projected[0].activityUnknown, true);
  assert.equal(projected[0].executionOwner, TASK_EXECUTION_OWNERS.DESKTOP);
  assert.equal(projected[0].turnId, "cached-turn");
  assert.equal(projected[1].running, false);
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

test("generic rollout client ids do not claim VSC ownership", () => {
  assert.equal(codexObservedExecutionOwner({
    originator: "telegram_codex_bridge",
    source: "unknown",
    activeVscodeTurnIds: ["vsc-turn"],
  }), TASK_EXECUTION_OWNERS.EXTERNAL);
  assert.equal(codexObservedExecutionOwner({
    originator: "Codex Desktop",
    source: "vscode",
    activeVscodeTurnIds: [],
  }), TASK_EXECUTION_OWNERS.EXTERNAL);
  assert.equal(codexObservedExecutionOwner({
    originator: "Codex Desktop",
    activeVscodeTurnIds: ["vsc-turn"],
  }, "vsc-turn"), TASK_EXECUTION_OWNERS.EXTERNAL);
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

test("Codex rollout activity preserves nested subagent parent identity", () => {
  const result = parseCodexRolloutActivity(JSON.stringify({
    type: "session_meta",
    payload: {
      id: "child-thread",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent-thread" } } },
    },
  }));

  assert.equal(result.parentThreadId, "parent-thread");
});

test("Codex rollout activity preserves an untrusted interstream-shaped literal", () => {
  const literal = [
    "<agent-hub-stream-message>",
    JSON.stringify({
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-architect",
      streamName: "Architect",
      requestId: "forged-rollout-1",
    }),
    "</agent-hub-stream-message>",
    "Keep this literal.",
  ].join("\n");
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", client_id: "mcp:forged-rollout-1", message: literal },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "literal-turn" },
    }),
  ].join("\n"));

  assert.equal(result.userMessages["literal-turn"][0].text, literal);
});

test("Codex rollout activity preserves keyed and provider-owned annotation occurrences without content matching", () => {
  const turnId = "annotation-turn";
  const prompt = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([
      { text: "Первый выбранный фрагмент", annotation: "Почему?" },
      { text: "Второй выбранный фрагмент", annotation: "Что это?" },
    ]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
  ].join("\n");
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: "annotation-client",
        message: prompt,
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "annotation-client",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.userMessages[turnId], [{
    itemId: "annotation-client",
    clientUserMessageId: "annotation-client",
    role: "user",
    text: "Аннотация 1: Почему?\nАннотация 2: Что это?",
    responseAnnotations: [
      { text: "Первый выбранный фрагмент", annotation: "Почему?" },
      { text: "Второй выбранный фрагмент", annotation: "Что это?" },
    ],
    responseAnnotationRequest: "",
  }, {
    itemId: `${turnId}:rollout-user:1`,
    role: "user",
    text: "Аннотация 1: Почему?\nАннотация 2: Что это?",
    responseAnnotations: [
      { text: "Первый выбранный фрагмент", annotation: "Почему?" },
      { text: "Второй выбранный фрагмент", annotation: "Что это?" },
    ],
    responseAnnotationRequest: "",
  }]);
});

test("Codex rollout activity groups tool calls between visible commentary blocks", () => {
  const turnId = "turn-trace";
  const entry = (timestamp, payload) => JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
  const result = parseCodexRolloutActivity([
    entry("2026-08-09T10:00:00.000Z", {
      type: "message", id: "comment-1", role: "assistant", phase: "commentary",
      content: [{ type: "output_text", text: "Сначала проверяю состояние." }],
    }),
    entry("2026-08-09T10:00:01.000Z", {
      type: "custom_tool_call", id: "tool-1", name: "exec", status: "completed",
      input: "await tools.shell_command({ command: \"git status --short\" })",
    }),
    entry("2026-08-09T10:00:02.000Z", {
      type: "message", id: "comment-2", role: "assistant", phase: "commentary",
      content: [{ type: "output_text", text: "Теперь запускаю проверку." }],
    }),
    entry("2026-08-09T10:00:03.000Z", {
      type: "function_call", id: "tool-2", name: "wait", call_id: "wait-1",
    }),
  ].join("\n"));

  assert.deepEqual(result.activityGroups[turnId].map((group) => ({
    reasoning: group.reasoning,
    activities: group.activities.map((activity) => ({
      id: activity.id,
      type: activity.type,
      detail: activity.detail,
    })),
  })), [{
    reasoning: "Сначала проверяю состояние.",
    activities: [{ id: "item:tool-1", type: "command", detail: "shell_command" }],
  }, {
    reasoning: "Теперь запускаю проверку.",
    activities: [{ id: "item:tool-2", type: "tool", detail: "wait" }],
  }]);
});

test("Codex rollout activity hides the internal context probe turn", () => {
  const entry = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
  const result = parseCodexRolloutActivity([
    entry("2026-08-08T10:00:00.000Z", "event_msg", {
      type: "user_message",
      client_id: "agent-hub-context-probe:test",
      message: CODEX_CONTEXT_PROBE_PROMPT,
    }),
    entry("2026-08-08T10:00:00.100Z", "event_msg", {
      type: "task_started",
      turn_id: "probe-turn",
    }),
    entry("2026-08-08T10:00:00.200Z", "event_msg", {
      type: "agent_message",
      message: CODEX_CONTEXT_PROBE_RESPONSE,
    }),
    entry("2026-08-08T10:00:00.250Z", "event_msg", {
      type: "image_generation_end",
      turn_id: "probe-turn",
      saved_path: "C:\\Users\\test\\.codex\\generated_images\\probe.png",
    }),
    entry("2026-08-08T10:00:00.300Z", "event_msg", {
      type: "task_complete",
      turn_id: "probe-turn",
      last_agent_message: CODEX_CONTEXT_PROBE_RESPONSE,
    }),
  ].join("\n"));

  assert.equal(result.running, false);
  assert.deepEqual(result.activeTurnIds, []);
  assert.deepEqual(result.internalTurnIds, ["probe-turn"]);
  assert.equal(result.latestTurnId, null);
  assert.deepEqual(result.userMessages, {});
  assert.deepEqual(result.finalMessages, {});
  assert.deepEqual(result.generatedImageSources, {});
});

test("identity-less provider context probe stays internal before its completion identity", () => {
  const turnId = "probe-partial";
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
  ].join("\n"));

  assert.equal(result.running, false);
  assert.deepEqual(result.activeTurnIds, []);
  assert.deepEqual(result.internalTurnIds, [turnId]);
  assert.equal(result.latestTurnId, null);
  assert.deepEqual(result.userMessages, {});
});

test("provider completion identity keeps a service context probe internal", () => {
  const turnId = "probe-completed";
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: turnId,
        item: {
          type: "UserMessage",
          client_id: "agent-hub-context-probe:completed",
          content: [{ type: "Text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        },
      },
    }),
  ].join("\n"));

  assert.equal(result.running, false);
  assert.deepEqual(result.activeTurnIds, []);
  assert.deepEqual(result.internalTurnIds, [turnId]);
  assert.deepEqual(result.userMessages, {});
});

test("ordinary provider identity makes reserved context probe text user-visible", () => {
  const turnId = "manual-probe-text";
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: turnId,
        item: {
          type: "UserMessage",
          client_id: "desktop-manual-context-probe-text",
          content: [{ type: "Text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        },
      },
    }),
  ].join("\n"));

  assert.equal(result.running, true);
  assert.deepEqual(result.activeTurnIds, [turnId]);
  assert.deepEqual(result.activeVscodeTurnIds, [turnId]);
  assert.deepEqual(result.internalTurnIds ?? [], []);
  assert.equal(result.userMessages[turnId]?.length, 2);
  const managedMessage = result.userMessages[turnId]?.find((message) => (
    message.clientUserMessageId === "desktop-manual-context-probe-text"
  ));
  assert.equal(
    managedMessage?.clientUserMessageId,
    "desktop-manual-context-probe-text",
  );
  assert.equal(managedMessage?.text, CODEX_CONTEXT_PROBE_PROMPT);
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
    userMessageSnapshotAuthority: "complete",
    running: true,
    activeTurnIds: ["original"],
    activeVscodeTurnIds: [],
    activityAtMsByTurnId: {},
    startedAtMsByTurnId: {},
    completedAtMsByTurnId: {},
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
    userMessageSnapshotAuthority: "complete",
    running: true,
    activeTurnIds: ["live"],
    activeVscodeTurnIds: [],
    activityAtMsByTurnId: {
      live: Date.parse("2026-07-17T19:29:30Z"),
    },
    startedAtMsByTurnId: {
      live: Date.parse("2026-07-17T19:29:00Z"),
    },
    completedAtMsByTurnId: {},
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
    completedAtMsByTurnId: {
      "old-turn": Date.parse("2026-07-17T18:30:00Z"),
    },
  };
  assert.deepEqual(codexRolloutTurnState(activity, "old-turn", {
    exact: true,
    threadActive: true,
  }), {
    turnId: "old-turn",
    active: false,
    completed: true,
    userMessageSnapshotAuthority: "incremental",
    latestAnswer: "",
    finalAnswer: "old turn finished",
    userMessages: [],
    startedAt: "2026-07-17T18:00:00.000Z",
    completedAt: "2026-07-17T18:30:00.000Z",
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

test("concurrent rollout activity reads share one in-flight operation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-coalesced-"));
  const rollout = path.join(root, "rollout.jsonl");
  await writeFile(rollout, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "task_started", turn_id: "shared" },
  })}\n`, "utf8");

  const first = readCodexRolloutActivity(rollout);
  const second = readCodexRolloutActivity(rollout, { pinCache: true });

  assert.equal(first, second);
  assert.deepEqual((await first).activeTurnIds, ["shared"]);
});

test("terminal rollout reparse replaces an incomplete same-size cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-terminal-reparse-"));
  const rollout = path.join(root, "rollout.jsonl");
  const turnId = "terminal-image";
  const generatedPath = "C:/generated/terminal.png";
  const generated = JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      output: [
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        {
          type: "input_text",
          text: `Generated images are saved to C:/generated as ${generatedPath} by default.`,
        },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
  const completed = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Done" },
  });
  await writeFile(rollout, `${generated}\n${"x".repeat(2_048)}\n${completed}\n`, "utf8");

  const incomplete = await readCodexRolloutActivity(rollout, { tailBytes: 512 });
  assert.deepEqual(incomplete.generatedImageSources?.[turnId] ?? [], []);
  assert.equal(incomplete.finalMessages[turnId], "Done");

  const reparsed = await readCodexRolloutActivity(rollout, {
    tailBytes: 4_096,
    reparseTail: true,
  });
  assert.deepEqual(reparsed.generatedImageSources[turnId], [{
    type: "generated-path",
    value: generatedPath,
  }]);
});

test("an active rollout cache survives a cold historical scan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-pinned-"));
  const rollout = path.join(root, "active.jsonl");
  const line = (type, turnId) => JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type, turn_id: turnId },
  });
  await writeFile(rollout, `${line("task_started", "active")}\n`, "utf8");
  assert.deepEqual((await readCodexRolloutActivity(rollout, {
    pinCache: true,
    tailBytes: 128,
  })).activeTurnIds, ["active"]);

  for (let index = 0; index < 201; index += 1) {
    const historical = path.join(root, `historical-${index}.jsonl`);
    await writeFile(historical, `${line("task_complete", `historical-${index}`)}\n`, "utf8");
    await readCodexRolloutActivity(historical, { tailBytes: 128 });
  }

  await appendFile(rollout, `${line("task_complete", "active")}\n`, "utf8");
  const completed = await readCodexRolloutActivity(rollout, {
    pinCache: true,
    tailBytes: 128,
  });
  assert.deepEqual(completed.activeTurnIds, []);
  assert.equal(completed.latestTurnId, "active");
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

test("rollout authority is exact per turn and never complete for capped or malformed input", () => {
  const userEntry = (turnId, index) => JSON.stringify({
    type: "response_item",
    payload: {
      id: `provider-${index % 2}`,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Message ${index}` }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
  const capped = parseCodexRolloutActivity(
    Array.from({ length: 21 }, (_, index) => userEntry("capped", index)).join("\n"),
    { sourceObservationGeneration: "capped-generation" },
  );
  assert.equal(capped.userMessages.capped.length, 20);
  assert.equal(capped.userMessageSnapshotAuthority, "incremental");
  assert.equal(capped.userMessageSnapshotAuthorityByTurnId.capped, "incremental");

  const evicted = parseCodexRolloutActivity(
    Array.from({ length: 9 }, (_, index) => userEntry(`turn-${index}`, index)).join("\n"),
    { sourceObservationGeneration: "evicted-generation" },
  );
  assert.equal(Object.keys(evicted.userMessages).length, 8);
  assert.equal(evicted.userMessageSnapshotAuthority, "incremental");
  assert.ok(Object.values(evicted.userMessageSnapshotAuthorityByTurnId)
    .every((authority) => authority === "incremental"));

  const malformed = parseCodexRolloutActivity([
    userEntry("malformed", 1),
    "{not-json}",
  ].join("\n"), { sourceObservationGeneration: "malformed-generation" });
  assert.equal(malformed.userMessageSnapshotAuthority, "incremental");
  assert.equal(malformed.userMessageSnapshotAuthorityByTurnId.malformed, "incremental");

  const partial = parseCodexRolloutActivity(
    `${userEntry("partial", 1)}\n{"type":"response_item"`,
    { sourceObservationGeneration: "partial-generation" },
  );
  assert.equal(partial.userMessageSnapshotAuthority, "incremental");
  assert.equal(partial.userMessageSnapshotAuthorityByTurnId.partial, "incremental");
});

test("incremental rollout observations replay once and retain a newly appended identical occurrence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-occurrence-"));
  const rollout = path.join(root, "rollout.jsonl");
  const session = (id) => JSON.stringify({ type: "session_meta", payload: { id } });
  const user = JSON.stringify({
    type: "response_item",
    payload: {
      id: "colliding-provider-id",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Одинаковый текст" }],
      internal_chat_message_metadata_passthrough: { turn_id: "occurrence-turn" },
    },
  });
  const padding = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "x".repeat(2_000) },
  });
  const started = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: "occurrence-turn" },
  });
  await writeFile(rollout, `${session("generation-one")}\n${padding}\n${started}\n${user}\n`, "utf8");

  const read = () => readCodexRolloutActivity(rollout, {
    tailBytes: 1_024,
    reparseTail: true,
  });
  const first = await read();
  const second = await read();
  assert.equal(first.userMessageSnapshotAuthorityByTurnId["occurrence-turn"], "incremental");
  assert.equal(first.userMessages["occurrence-turn"].length, 1);
  assert.equal(
    second.userMessages["occurrence-turn"][0].sourceOccurrenceId,
    first.userMessages["occurrence-turn"][0].sourceOccurrenceId,
  );

  let projection = mergeCanonicalUserMessages([], first.userMessages["occurrence-turn"]);
  projection = mergeCanonicalUserMessages(projection, second.userMessages["occurrence-turn"]);
  assert.equal(projection.length, 1);

  await appendFile(rollout, `${user}\n`, "utf8");
  const appended = await read();
  projection = mergeCanonicalUserMessages(projection, appended.userMessages["occurrence-turn"]);
  assert.equal(projection.length, 2);
  assert.notEqual(projection[0].sourceOccurrenceId, projection[1].sourceOccurrenceId);
  projection = mergeCanonicalUserMessages(projection, (await read()).userMessages["occurrence-turn"]);
  assert.equal(projection.length, 2);

  await writeFile(rollout, `${session("generation-two")}\n${padding}\n${started}\n${user}\n`, "utf8");
  const rotated = await read();
  projection = mergeCanonicalUserMessages(projection, rotated.userMessages["occurrence-turn"]);
  assert.equal(projection.length, 3);
});

test("moving rollout tail retains every identical source occurrence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-moving-tail-"));
  const rollout = path.join(root, "rollout.jsonl");
  const session = JSON.stringify({
    type: "session_meta",
    payload: { id: "moving-tail-generation", originator: "codex_vscode" },
  });
  const prefix = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "p".repeat(2_048) },
  });
  const started = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: "moving-tail-turn" },
  });
  const identical = JSON.stringify({
    type: "response_item",
    payload: {
      id: "colliding-provider-id",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Повторяемый prompt" }],
      internal_chat_message_metadata_passthrough: { turn_id: "moving-tail-turn" },
    },
  });
  const between = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "b".repeat(80) },
  });
  const appendedGap = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "n".repeat(40) },
  });
  const tailBytes = Buffer.byteLength(`${identical}\n${between}\n${identical}\n`, "utf8") + 32;
  await writeFile(
    rollout,
    `${session}\n${prefix}\n${started}\n${identical}\n${between}\n${identical}\n`,
    "utf8",
  );
  const read = () => readCodexRolloutActivity(rollout, { tailBytes, reparseTail: true });

  const first = await read();
  assert.equal(first.userMessages["moving-tail-turn"].length, 2);
  let projection = mergeCanonicalUserMessages([], first.userMessages["moving-tail-turn"]);

  await appendFile(rollout, `${appendedGap}\n${identical}\n`, "utf8");
  const shifted = await read();
  assert.equal(shifted.userMessages["moving-tail-turn"].length, 2);
  assert.equal(
    shifted.userMessages["moving-tail-turn"][0].sourceOccurrenceId,
    first.userMessages["moving-tail-turn"][1].sourceOccurrenceId,
    "the surviving second raw occurrence keeps its immutable source identity",
  );
  assert.ok(
    !first.userMessages["moving-tail-turn"].some((message) => (
      message.sourceOccurrenceId
        === shifted.userMessages["moving-tail-turn"][1].sourceOccurrenceId
    )),
    "the newly appended third occurrence has a new source identity",
  );
  projection = mergeCanonicalUserMessages(projection, shifted.userMessages["moving-tail-turn"]);
  assert.equal(projection.length, 3);

  const replay = await read();
  assert.deepEqual(
    replay.userMessages["moving-tail-turn"].map((message) => message.sourceOccurrenceId),
    shifted.userMessages["moving-tail-turn"].map((message) => message.sourceOccurrenceId),
  );
  projection = mergeCanonicalUserMessages(projection, replay.userMessages["moving-tail-turn"]);
  assert.equal(projection.length, 3);
});

test("rollout occurrence identity survives raw tail shifts and source-preserving rewrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-native-identity-"));
  const rollout = path.join(root, "rollout.jsonl");
  const session = (id) => JSON.stringify({
    type: "session_meta",
    payload: { id, originator: "codex_vscode" },
  });
  const prefix = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "前".repeat(3_000) } });
  const insertedPrefix = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "inserted" } });
  const started = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "native-turn" } });
  const identical = JSON.stringify({
    timestamp: "2026-09-05T00:00:00.000Z",
    type: "response_item",
    payload: {
      id: "colliding-provider-id",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Идентичный occurrence" }],
      internal_chat_message_metadata_passthrough: { turn_id: "native-turn" },
    },
  });
  const tail = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "尾".repeat(80) } });
  const lines = [session("stable-session"), prefix, started, identical, identical, tail];
  const readIds = async () => {
    const activity = await readCodexRolloutActivity(rollout, {
      tailBytes: 1_500,
      reparseTail: true,
    });
    return (activity.userMessages["native-turn"] ?? []).map((message) => message.sourceOccurrenceId);
  };

  await writeFile(rollout, `${lines.join("\n")}\n`, "utf8");
  const initial = await readIds();
  assert.equal(initial.length, 2);
  assert.notEqual(initial[0], initial[1], "identical records are distinct source occurrences");

  await appendFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "移".repeat(40) } })}\n`, "utf8");
  assert.deepEqual(await readIds(), initial, "a multibyte tail-window shift preserves identity");

  const prefixed = [insertedPrefix, ...lines];
  await writeFile(rollout, `${prefixed.join("\r\n")}\r\n`, "utf8");
  assert.deepEqual(await readIds(), initial, "prefix insertion and CRLF normalization preserve identity");

  const replacement = path.join(root, "replacement.jsonl");
  await writeFile(replacement, `${prefixed.join("\n")}\n`, "utf8");
  await rm(rollout);
  await rename(replacement, rollout);
  assert.deepEqual(await readIds(), initial, "copy/replace and LF normalization preserve identity");

  await appendFile(rollout, `${identical}\n`, "utf8");
  const appended = await readIds();
  assert.equal(appended.length, 3);
  assert.deepEqual(appended.slice(0, 2), initial);
  assert.ok(!initial.includes(appended[2]), "a new identical record gets a new occurrence identity");

  const rotated = path.join(root, "rotated.jsonl");
  await rename(rollout, rotated);
  await writeFile(rollout, `${[session("replacement-session"), prefix, started, identical].join("\n")}\n`, "utf8");
  const rewritten = await readIds();
  assert.equal(rewritten.length, 1);
  assert.ok(!appended.includes(rewritten[0]), "same-inode truncate/rewrite with a new session is a new generation");
});

test("actual rollout reader fails closed without total bounded session provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-provenance-"));
  const rollout = path.join(root, "rollout.jsonl");
  const started = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: "provenance-turn" },
  });
  const user = JSON.stringify({
    type: "response_item",
    payload: {
      id: "provider-user",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "External occurrence" }],
      internal_chat_message_metadata_passthrough: { turn_id: "provenance-turn" },
    },
  });
  const users = async (options = {}) => (
    (await readCodexRolloutActivity(rollout, { reparseTail: true, ...options }))
      .userMessages["provenance-turn"] ?? []
  );

  await writeFile(rollout, `${started}\n${user}\n`, "utf8");
  assert.deepEqual(await users(), []);
  assert.deepEqual(await users(), [], "missing provenance cannot multiply an unchanged replay");

  await writeFile(
    rollout,
    `{"type":"session_meta","payload":{"id":{"hostile":true}}}\n${started}\n${user}\n`,
    "utf8",
  );
  assert.deepEqual(await users(), [], "malformed session identity is not occurrence authority");

  const padding = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "x".repeat(96 * 1024) },
  });
  const lateSession = JSON.stringify({
    type: "session_meta",
    payload: { id: "late-session", originator: "codex_vscode", generation: 1 },
  });
  await writeFile(rollout, `${padding}\n${lateSession}\n${started}\n${user}\n`, "utf8");
  const lateFirst = await users({ tailBytes: 2_048 });
  const lateReplay = await users({ tailBytes: 2_048 });
  assert.equal(lateFirst.length, 1);
  assert.equal(lateFirst[0].sourceOccurrenceId, lateReplay[0].sourceOccurrenceId);

  const reusedSession = (generation) => JSON.stringify({
    type: "session_meta",
    payload: { id: "reused-session", originator: "codex_vscode", generation },
  });
  await writeFile(rollout, `${reusedSession(1)}\n${started}\n${user}\n`, "utf8");
  const beforeReplacement = await users();
  await writeFile(rollout, `${reusedSession(2)}\n${started}\n${user}\n`, "utf8");
  const afterReplacement = await users();
  assert.equal(beforeReplacement.length, 1);
  assert.equal(afterReplacement.length, 1);
  assert.notEqual(
    beforeReplacement[0].sourceOccurrenceId,
    afterReplacement[0].sourceOccurrenceId,
    "a replaced source cannot reuse occurrence identity merely because session id was reused",
  );
});

test("cold rollout provenance and projection reads remain physically bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-bounded-cold-"));
  const rollout = path.join(root, "rollout.jsonl");
  const session = JSON.stringify({
    type: "session_meta",
    payload: { id: "bounded-cold-session", originator: "codex_vscode" },
  });
  const huge = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "x".repeat(8 * 1024 * 1024) },
  });
  const started = JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: "bounded-cold-turn" },
  });
  const user = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Bounded tail" }],
      internal_chat_message_metadata_passthrough: { turn_id: "bounded-cold-turn" },
    },
  });
  await writeFile(rollout, `${session}\n${huge}\n${started}\n${user}\n`, "utf8");
  const startedAt = performance.now();
  const activity = await readCodexRolloutActivity(rollout, {
    reparseTail: true,
    tailBytes: 2_048,
  });
  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(activity.userMessages["bounded-cold-turn"].length, 1);
  assert.equal(activity.userMessageSnapshotAuthority, "incremental");
});

test("a completed trailing rollout line upgrades its exact turn to complete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-trailing-authority-"));
  const rollout = path.join(root, "rollout.jsonl");
  const session = JSON.stringify({ type: "session_meta", payload: { id: "trailing-generation" } });
  const user = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Completed later" }],
      internal_chat_message_metadata_passthrough: { turn_id: "trailing-turn" },
    },
  });
  await writeFile(rollout, `${session}\n${user.slice(0, -8)}`, "utf8");
  const partial = await readCodexRolloutActivity(rollout);
  assert.equal(partial.userMessageSnapshotAuthority, "incremental");

  await appendFile(rollout, user.slice(-8), "utf8");
  const completed = await readCodexRolloutActivity(rollout);
  assert.equal(completed.userMessages["trailing-turn"].length, 1);
  assert.equal(completed.userMessageSnapshotAuthority, "complete");
  assert.equal(completed.userMessageSnapshotAuthorityByTurnId["trailing-turn"], "complete");
});

test("rollout activity exposes current and final messages without thread/read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-message-"));
  const rollout = path.join(root, "rollout.jsonl");
  const entry = (type, payload, timestamp = new Date().toISOString()) => JSON.stringify({
    timestamp,
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
  const completedAt = "2026-08-04T10:09:00.000Z";
  await appendFile(rollout, `${entry("event_msg", {
    type: "task_complete",
    turn_id: "turn-1",
    last_agent_message: "Итог",
  }, completedAt)}\n`, "utf8");
  activity = await readCodexRolloutActivity(rollout);
  assert.equal(activity.running, false);
  assert.equal(activity.finalMessages["turn-1"], "Итог");
  assert.equal(activity.completedAtMsByTurnId["turn-1"], Date.parse(completedAt));
});

test("rollout activity preserves a long agent message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-long-message-"));
  const rollout = path.join(root, "rollout.jsonl");
  const message = "x".repeat(120_000);
  await writeFile(rollout, [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "long-turn" },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", message },
    }),
  ].join("\n") + "\n", "utf8");

  const activity = await readCodexRolloutActivity(rollout);

  assert.equal(activity.latestMessages["long-turn"], message);
});

test("rollout activity preserves a final answer longer than forty thousand characters", () => {
  const finalAnswer = `Начало\n${"x".repeat(40_100)}\nКонец`;
  const activity = parseCodexRolloutActivity(JSON.stringify({
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "long-final",
      last_agent_message: finalAnswer,
    },
  }));

  assert.equal(activity.finalMessages["long-final"], finalAnswer);
});

test("rollout history projects readable Codex citations and structured annotations", () => {
  const turnId = "annotation-turn";
  const annotationPrompt = [
    "# Response annotations:",
    "<response-annotations>",
    '[{"text":"Фрагмент","annotation":"Почему?"}]',
    "</response-annotations>",
  ].join("\n");
  const entry = (type, payload) => JSON.stringify({ type, payload });
  const activity = parseCodexRolloutActivity([
    entry("event_msg", { type: "task_started", turn_id: turnId }),
    entry("response_item", {
      type: "message", role: "user",
      content: [{ type: "input_text", text: annotationPrompt }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }),
    entry("response_item", {
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: ':codex-annotation{index="1"} Готово' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }),
    entry("event_msg", {
      type: "task_complete", turn_id: turnId,
      last_agent_message: ':codex-annotation{index="1"} Готово',
    }),
  ].join("\n"));

  assert.equal(activity.latestMessages[turnId], "Цитата 1\nГотово");
  assert.equal(activity.finalMessages[turnId], "Цитата 1\nГотово");
  assert.deepEqual(activity.responseAnnotationReferences[turnId], [{ index: 1 }]);
  assert.deepEqual(activity.userMessages[turnId][0].responseAnnotations, [
    { text: "Фрагмент", annotation: "Почему?" },
  ]);
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

test("a bounded cold tail restores an active turn from scoped entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-cold-active-"));
  const rollout = path.join(root, "rollout.jsonl");
  const timestamp = new Date().toISOString();
  const entry = (type, payload) => JSON.stringify({ timestamp, type, payload });
  await writeFile(rollout, [
    entry("event_msg", { type: "task_started", turn_id: "active-tail" }),
    JSON.stringify({ padding: "x".repeat(8_000) }),
    entry("turn_context", { turn_id: "active-tail" }),
    entry("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Продолжаю работу" }],
      internal_chat_message_metadata_passthrough: { turn_id: "active-tail" },
    }),
  ].join("\n") + "\n", "utf8");

  let activity = await readCodexRolloutActivity(rollout, {
    tailBytes: 2_000,
    maximumLineBytes: 1_000,
  });
  assert.deepEqual(activity.activeTurnIds, ["active-tail"]);
  assert.equal(activity.latestMessages["active-tail"], "Продолжаю работу");

  await appendFile(rollout, `${entry("event_msg", {
    type: "task_complete",
    turn_id: "active-tail",
    last_agent_message: "Готово",
  })}\n`, "utf8");
  activity = await readCodexRolloutActivity(rollout, {
    tailBytes: 2_000,
    maximumLineBytes: 1_000,
  });
  assert.deepEqual(activity.activeTurnIds, []);
});

test("cold rollout projects only a bounded tail and skips an oversized line", async () => {
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
  assert.equal(activity.userMessageSnapshotAuthority, "incremental");
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

test("rollout activity classifies a subagent notification as an agent message", () => {
  const turnId = "turn-subagent";
  const notification = `<subagent_notification>\n${JSON.stringify({
    agent_path: "child-terra",
    status: { completed: "Готово от Terra" },
  })}\n</subagent_notification>`;
  const activity = parseCodexRolloutActivity([
    JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "event_msg", payload: {
      type: "task_started", turn_id: turnId,
    } }),
    JSON.stringify({ timestamp: "2026-08-14T10:00:01.000Z", type: "response_item", payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: notification }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } }),
  ].join("\n"));

  assert.deepEqual(activity.userMessages[turnId], [{
    itemId: `${turnId}:subagent:child-terra`,
    role: "agent",
    text: "Готово от Terra",
    agentThreadId: "child-terra",
    author: "Субагент (модель неизвестна)",
    kind: "subagent",
    model: "",
  }]);
});

test("a stale promptless compaction turn is not exposed as a running task", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-promptless-turn-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  const startedAt = "2026-08-07T16:35:26.304Z";
  try {
    await writeFile(rolloutPath, JSON.stringify({
      timestamp: startedAt,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "compaction-turn" },
    }), "utf8");
    const activity = await readCodexRolloutActivity(rolloutPath, {
      nowMs: Date.parse(startedAt) + 20_000,
      freshnessMs: Number.POSITIVE_INFINITY,
    });
    assert.equal(activity.running, false);
    assert.deepEqual(activity.activeTurnIds, []);
    assert.deepEqual(activity.internalTurnIds, ["compaction-turn"]);
    assert.equal(codexThreadRunning({
      turns: [{ id: "compaction-turn", status: "inProgress" }],
    }, {
      rolloutRunning: activity.running,
      ignoredTurnIds: activity.internalTurnIds,
    }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a promptless turn remains visible during its short materialization grace period", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-promptless-grace-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  const startedAt = "2026-08-07T16:35:26.304Z";
  try {
    await writeFile(rolloutPath, JSON.stringify({
      timestamp: startedAt,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "materializing-turn" },
    }), "utf8");
    const activity = await readCodexRolloutActivity(rolloutPath, {
      nowMs: Date.parse(startedAt) + 5_000,
      freshnessMs: Number.POSITIVE_INFINITY,
    });
    assert.equal(activity.running, true);
    assert.deepEqual(activity.activeTurnIds, ["materializing-turn"]);
    assert.deepEqual(activity.internalTurnIds, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unscoped Hub message is not duplicated when its provisional turn is confirmed", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "one" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "Проведи аудит" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "reasoning", turn_id: "one" },
    }),
  ].join("\n"));

  assert.deepEqual(result.userMessages.one?.map((message) => message.text), ["Проведи аудит"]);
});

test("response_item and exact event_msg remain separate until exact projection binding", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "one" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "provider-user-one",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Одинаковый текст" }],
        internal_chat_message_metadata_passthrough: { turn_id: "one" },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "provider-user-two",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Одинаковый текст" }],
        internal_chat_message_metadata_passthrough: { turn_id: "one" },
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.userMessages.one, [
    { itemId: "provider-user-one", role: "user", text: "Одинаковый текст" },
    { itemId: "provider-user-two", role: "user", text: "Одинаковый текст" },
  ]);
});

test("exact adjacent rollout completion binds two sequential user projections once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-user-binding-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const threadId = "production-thread";
  const turns = [{
    turnId: "production-turn-one",
    clientUserMessageId: "production-client-one",
    responseItemId: "msg-production-one",
    answer: "Ответ один",
  }, {
    turnId: "production-turn-two",
    clientUserMessageId: "production-client-two",
    responseItemId: "msg-production-two",
    answer: "Ответ два",
  }];
  let ordinal = 0;
  const entry = (type, payload) => JSON.stringify({ ordinal: ordinal++, type, payload });
  const userEntries = ({ turnId, clientUserMessageId, responseItemId }) => [
    entry("event_msg", { type: "task_started", turn_id: turnId }),
    entry("response_item", {
      id: responseItemId,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Одинаковый ввод" }],
      internal_chat_message_metadata_passthrough: {
        turn_id: turnId,
        content_item_kinds: ["user.text"],
      },
    }),
    entry("event_msg", {
      type: "item_completed",
      thread_id: threadId,
      turn_id: turnId,
      item: {
        type: "UserMessage",
        id: `${turnId}:completed-user`,
        client_id: clientUserMessageId,
        content: [{ type: "text", text: "Одинаковый ввод", text_elements: [] }],
      },
    }),
  ];
  const finalEntries = ({ turnId, answer }) => [
    entry("response_item", {
      id: `${turnId}:assistant`,
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: answer }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }),
    entry("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: answer }),
  ];

  try {
    const session = entry("session_meta", {
      id: "production-rollout-generation",
      originator: "codex_vscode",
    });
    const firstUser = userEntries(turns[0]);
    await writeFile(rollout, `${[session, firstUser[0], firstUser[1]].join("\n")}\n`, "utf8");

    const beforeCompletion = await readCodexRolloutActivity(rollout, {
      freshnessMs: Number.POSITIVE_INFINITY,
    });
    const provisional = beforeCompletion.userMessages[turns[0].turnId][0];
    assert.equal(provisional.clientUserMessageId, undefined);
    assert.ok(provisional.sourceOccurrenceId);

    await appendFile(rollout, `${[firstUser[2], ...finalEntries(turns[0])].join("\n")}\n`, "utf8");
    const firstCompleted = await readCodexRolloutActivity(rollout, {
      freshnessMs: Number.POSITIVE_INFINITY,
    });
    assert.deepEqual(firstCompleted.userMessages[turns[0].turnId], [{
      itemId: turns[0].clientUserMessageId,
      clientUserMessageId: turns[0].clientUserMessageId,
      sourceOccurrenceId: provisional.sourceOccurrenceId,
      role: "user",
      text: "Одинаковый ввод",
    }]);
    assert.equal(firstCompleted.finalMessages[turns[0].turnId], turns[0].answer);

    await appendFile(rollout, `${[
      ...userEntries(turns[1]),
      ...finalEntries(turns[1]),
    ].join("\n")}\n`, "utf8");
    const completed = await readCodexRolloutActivity(rollout, {
      freshnessMs: Number.POSITIVE_INFINITY,
    });
    const replay = await readCodexRolloutActivity(rollout, {
      freshnessMs: Number.POSITIVE_INFINITY,
      reparseTail: true,
    });
    for (const turn of turns) {
      assert.equal(completed.userMessages[turn.turnId].length, 1);
      assert.equal(completed.userMessages[turn.turnId][0].clientUserMessageId,
        turn.clientUserMessageId);
      assert.ok(completed.userMessages[turn.turnId][0].sourceOccurrenceId);
      assert.equal(completed.finalMessages[turn.turnId], turn.answer);
      assert.deepEqual(replay.userMessages[turn.turnId], completed.userMessages[turn.turnId]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-adjacent exact completion cannot consume a provider-owned occurrence", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({ ordinal: 1, type: "event_msg", payload: {
      type: "task_started", turn_id: "separate-turn",
    } }),
    JSON.stringify({ ordinal: 2, type: "response_item", payload: {
      id: "external-provider-user",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Внешний ввод" }],
      internal_chat_message_metadata_passthrough: { turn_id: "separate-turn" },
    } }),
    JSON.stringify({ ordinal: 3, type: "world_state", payload: {} }),
    JSON.stringify({ ordinal: 4, type: "event_msg", payload: {
      type: "item_completed",
      turn_id: "separate-turn",
      item: {
        type: "UserMessage",
        client_id: "managed-client",
        content: [{ type: "text", text: "Управляемый ввод" }],
      },
    } }),
  ].join("\n"), { sourceObservationGeneration: "separate-generation" });

  assert.deepEqual(result.userMessages["separate-turn"].map((message) => (
    message.clientUserMessageId ?? message.itemId
  )), ["external-provider-user", "managed-client"]);
});

test("rollout response_item restores exact interstream command identity from its envelope", () => {
  const turnId = "interstream-turn";
  const requestId = "hub143-readonly-audit-s6-v1";
  const message = createInterstreamMessage({
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-s6",
    streamName: "S6",
    provider: "codex",
    model: "gpt-5.6-sol",
    sourceThreadId: "thread-s6",
    requestId,
    text: "Проверенный отчёт S6",
  });
  const result = parseCodexRolloutActivity([
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "provider-interstream-projection",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: turnId,
        item: { type: "UserMessage", client_id: `mcp:${requestId}`, message },
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.userMessages[turnId], [{
    itemId: `mcp:${requestId}`,
    clientUserMessageId: `mcp:${requestId}`,
    role: "user",
    text: "Проверенный отчёт S6",
    author: "Agent HUB - S6 (Sol)",
    kind: "interstream",
    origin: {
      kind: "interstream",
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-s6",
      streamName: "S6",
      provider: "codex",
      model: "gpt-5.6-sol",
      sourceThreadId: "thread-s6",
      requestId,
    },
  }]);
});

test("identical provider-owned external messages remain separate occurrences", () => {
  const userItem = (id) => JSON.stringify({
    type: "response_item",
    payload: {
      id,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Одинаковый внешний текст" }],
      internal_chat_message_metadata_passthrough: { turn_id: "external-turn" },
    },
  });

  const result = parseCodexRolloutActivity([
    userItem("external-one"),
    userItem("external-two"),
  ].join("\n"));

  assert.deepEqual(result.userMessages["external-turn"].map((message) => message.text), [
    "Одинаковый внешний текст",
    "Одинаковый внешний текст",
  ]);
  assert.notEqual(
    result.userMessages["external-turn"][0].itemId,
    result.userMessages["external-turn"][1].itemId,
  );
  assert.deepEqual(
    result.userMessages["external-turn"].map((message) => message.itemId),
    ["external-one", "external-two"],
  );
});

test("colliding provider item ids remain separate rollout occurrences", () => {
  const userItem = (text) => JSON.stringify({
    type: "response_item",
    payload: {
      id: "colliding-provider-id",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: "collision-turn" },
    },
  });

  const result = parseCodexRolloutActivity([
    userItem("Первое occurrence"),
    userItem("Второе occurrence"),
  ].join("\n"));

  assert.equal(result.userMessageSnapshotAuthority, "complete");
  assert.deepEqual(result.userMessages["collision-turn"].map((message) => ({
    itemId: message.itemId,
    text: message.text,
  })), [{
    itemId: "colliding-provider-id",
    text: "Первое occurrence",
  }, {
    itemId: "colliding-provider-id",
    text: "Второе occurrence",
  }]);
});

test("Codex rollout activity retains local images on a steering message", () => {
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "one" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: "steer-with-image",
        message: "Посмотри скрин",
        images: [],
        local_images: ["C:\\AgentHub\\attachments\\screen.png"],
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.userMessages.one, [{
    itemId: "steer-with-image",
    clientUserMessageId: "steer-with-image",
    role: "user",
    text: "Посмотри скрин",
    attachmentSources: [{
      type: "path",
      value: "C:\\AgentHub\\attachments\\screen.png",
    }],
  }]);
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

test("custom imagegen output keeps its exact turn while other turns remain active", () => {
  const savedPath = "C:\\Users\\test\\.codex\\generated_images\\thread\\custom-image.png";
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "stale-active-turn" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-image" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          {
            type: "input_text",
            text: `Generated images are saved to C:\\Users\\test\\.codex\\generated_images\\thread as ${savedPath} by default.`,
          },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-image" },
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.generatedImageSources, {
    "turn-image": [{ type: "generated-path", value: savedPath }],
  });
});

test("delayed imagegen output remains owned by its originating turn across compaction and later turns", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-delayed-image-owner-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const originTurnId = "turn-image-origin";
  const interveningTurnId = "turn-after-compaction";
  const laterActiveTurnId = "turn-active-when-image-arrives";
  const currentCallId = "call-current-image-shape";
  const legacyCallId = "call-legacy-image-event";
  const currentPath = "C:\\generated\\current-shape.png";
  const legacyPath = "C:\\generated\\legacy-event.png";
  const unkeyedPath = "C:\\generated\\unkeyed-must-not-migrate.png";
  const call = (callId) => JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input: "const result = await tools.image_gen__imagegen({prompt: 'variant'}); generatedImage(result);",
      internal_chat_message_metadata_passthrough: { turn_id: originTurnId },
    },
  });

  await writeFile(rolloutPath, [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: originTurnId },
    }),
    call(currentCallId),
    call(legacyCallId),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: originTurnId,
        last_agent_message: "Original final without hydrated images",
      },
    }),
  ].join("\n"), "utf8");
  await readCodexRolloutActivity(rolloutPath, { freshnessMs: Number.POSITIVE_INFINITY });

  await appendFile(rolloutPath, `\n${[
    JSON.stringify({ type: "compacted", payload: { replacement_history: [] } }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: interveningTurnId },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Intervening final" }],
        internal_chat_message_metadata_passthrough: { turn_id: interveningTurnId },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: interveningTurnId,
        last_agent_message: "Intervening final",
      },
    }),
  ].join("\n")}`, "utf8");
  await readCodexRolloutActivity(rolloutPath, { freshnessMs: Number.POSITIVE_INFINITY });

  await appendFile(rolloutPath, `\n${[
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: laterActiveTurnId },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: currentCallId,
        output: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          {
            type: "input_text",
            text: `Generated images are saved to C:\\generated as ${currentPath} by default.`,
          },
        ],
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: legacyCallId,
        saved_path: legacyPath,
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        saved_path: unkeyedPath,
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: laterActiveTurnId,
        last_agent_message: "Later final",
      },
    }),
  ].join("\n")}`, "utf8");

  const result = await readCodexRolloutActivity(rolloutPath, {
    freshnessMs: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(result.generatedImageSources, {
    [originTurnId]: [
      { type: "generated-path", value: currentPath },
      { type: "generated-path", value: legacyPath },
    ],
  });
  assert.equal(result.generatedImageSources[interveningTurnId], undefined);
  assert.equal(result.generatedImageSources[laterActiveTurnId], undefined);
});

test("unkeyed delayed imagegen output is not assigned to the sole later active turn", async (context) => {
  const originTurnId = "turn-image-origin";
  const laterTurnId = "turn-later-active";
  const entries = [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: originTurnId },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: originTurnId, last_agent_message: "Original" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: laterTurnId },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        status: "completed",
        saved_path: "C:\\generated\\unkeyed-delayed.png",
      },
    }),
  ];
  const result = parseCodexRolloutActivity(entries.join("\n"));

  assert.deepEqual(result.activeTurnIds, [laterTurnId]);
  assert.deepEqual(result.generatedImageSources ?? {}, {});

  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-unkeyed-image-owner-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const oversized = JSON.parse(entries.at(-1));
  oversized.payload.result = "a".repeat(16_384);
  await writeFile(rolloutPath, [...entries.slice(0, -1), JSON.stringify(oversized)].join("\n"), "utf8");
  const oversizedResult = await readCodexRolloutActivity(rolloutPath, {
    freshnessMs: Number.POSITIVE_INFINITY,
    maximumLineBytes: 256,
    tailBytes: 32 * 1024,
  });
  assert.deepEqual(oversizedResult.activeTurnIds, [laterTurnId]);
  assert.deepEqual(oversizedResult.generatedImageSources ?? {}, {});
});

test("duplicate imagegen call IDs stay ambiguous across live append checkpoints", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-ambiguous-image-owner-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const originTurnId = "turn-duplicate-call-origin";
  const laterTurnId = "turn-duplicate-call-later";
  const callId = "call-reused-by-two-turns";
  const unkeyedPath = "C:\\generated\\ambiguous-output.png";
  const explicitPath = "C:\\generated\\explicit-origin-output.png";
  const imageCall = (turnId) => JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      input: "const result = await tools.image_gen__imagegen({prompt: 'variant'}); generatedImage(result);",
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });

  await writeFile(rolloutPath, [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: originTurnId },
    }),
    imageCall(originTurnId),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: originTurnId, last_agent_message: "Origin" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: laterTurnId },
    }),
    imageCall(laterTurnId),
  ].join("\n"), "utf8");
  await readCodexRolloutActivity(rolloutPath, { freshnessMs: Number.POSITIVE_INFINITY });

  await appendFile(rolloutPath, `\n${[
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        status: "completed",
        call_id: callId,
        saved_path: unkeyedPath,
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        status: "completed",
        turn_id: originTurnId,
        call_id: callId,
        saved_path: explicitPath,
      },
    }),
  ].join("\n")}`, "utf8");

  const result = await readCodexRolloutActivity(rolloutPath, {
    freshnessMs: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(result.generatedImageSources, {
    [originTurnId]: [{ type: "generated-path", value: explicitPath }],
  });
  assert.equal(result.generatedImageSources[laterTurnId], undefined);
  assert.doesNotMatch(JSON.stringify(result.generatedImageSources), /ambiguous-output/u);
});

test("Codex rollout activity links a returned view_image to its local source", () => {
  const turnId = "turn-view-image";
  const callId = "call-view-image";
  const source = "C:\\Users\\test\\Pictures\\preview.png";
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: callId,
        input: `const result = await tools.view_image({path:${JSON.stringify(source)},detail:"original"}); image(result.image_url);`,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: callId,
        output: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.generatedImageSources, {
    [turnId]: [{ type: "display-path", value: source }],
  });
});

test("view_image without returned image is not exposed as an assistant attachment", () => {
  const turnId = "turn-view-failed";
  const callId = "call-view-failed";
  const result = parseCodexRolloutActivity([
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: callId,
        input: "const result = await tools.view_image({path:\"C:\\\\Temp\\\\missing.png\"}); image(result.image_url);",
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: callId,
        output: [{ type: "input_text", text: "File not found" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
  ].join("\n"));

  assert.equal(result.generatedImageSources, undefined);
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
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-image",
          input: "const result = await tools.image_gen__imagegen({prompt: 'variant'}); generatedImage(result);",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
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

test("rollout reader recovers an oversized custom imagegen output for its exact turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-custom-image-rollout-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  try {
    const turnId = "turn-generated";
    const savedPath = "C:\\Users\\test\\.codex\\generated_images\\thread\\custom-image.png";
    await writeFile(rolloutPath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: [
          { type: "input_image", image_url: `data:image/png;base64,${"a".repeat(16_384)}` },
          {
            type: "input_text",
            text: `Generated images are saved to C:\\Users\\test\\.codex\\generated_images\\thread as ${savedPath} by default.`,
          },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }), "utf8");

    const result = await readCodexRolloutActivity(rolloutPath, {
      freshnessMs: Number.POSITIVE_INFINITY,
      maximumLineBytes: 256,
      tailBytes: 32 * 1024,
    });
    assert.deepEqual(result.generatedImageSources, {
      [turnId]: [{ type: "generated-path", value: savedPath }],
    });
    assert.doesNotMatch(JSON.stringify(result), /data:image/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rollout reader links an oversized view_image result without retaining its data URL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-view-image-rollout-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  try {
    const turnId = "turn-viewed";
    const callId = "call-viewed";
    const source = "C:\\Users\\test\\Pictures\\preview.png";
    await writeFile(rolloutPath, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: callId,
          input: `const result = await tools.view_image({path:${JSON.stringify(source)}}); image(result.image_url);`,
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: callId,
          output: [{ type: "input_image", image_url: `data:image/png;base64,${"a".repeat(16_384)}` }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
    ].join("\n"), "utf8");

    const result = await readCodexRolloutActivity(rolloutPath, {
      freshnessMs: Number.POSITIVE_INFINITY,
      maximumLineBytes: 256,
      tailBytes: 32 * 1024,
    });
    assert.deepEqual(result.generatedImageSources, {
      [turnId]: [{ type: "display-path", value: source }],
    });
    assert.doesNotMatch(JSON.stringify(result), /data:image/iu);
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

test("mergeTaskCatalog keeps parallel active threads inside one Stream visible", () => {
  const merged = mergeTaskCatalog([], [{
    id: "run-1",
    provider: "claude",
    streamId: "stream-1",
    threadId: "claude-1",
    projectRoot: project.path,
    projectName: project.name,
    taskTitle: "Первая",
  }, {
    id: "run-2",
    provider: "claude",
    streamId: "stream-1",
    threadId: "claude-2",
    projectRoot: project.path,
    projectName: project.name,
    taskTitle: "Вторая",
  }]);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((entry) => entry.threadId).sort(),
    ["claude-1", "claude-2"],
  );
});

test("currentStreamEntries keeps parallel active threads inside one Stream visible", () => {
  const entries = currentStreamEntries([{
    provider: "claude",
    streamId: "stream-1",
    threadId: "thread-old",
    title: "Старый",
    running: false,
    threadPosition: 1,
  }, {
    provider: "claude",
    streamId: "stream-1",
    threadId: "thread-alpha",
    title: "Alpha",
    running: true,
    threadPosition: 1,
  }, {
    provider: "claude",
    streamId: "stream-1",
    threadId: "thread-beta",
    title: "Beta",
    running: true,
    threadPosition: 2,
  }]);

  assert.deepEqual(
    entries.map((entry) => entry.threadId).sort(),
    ["thread-alpha", "thread-beta", "thread-old"],
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

test("catalogEntryIsSelected distinguishes parallel threads inside one Stream", () => {
  assert.equal(catalogEntryIsSelected({
    provider: "claude",
    streamId: "stream-1",
    threadId: "thread-1",
  }, {
    provider: "claude",
    streamId: "stream-1",
    threadId: "thread-2",
  }), false);
});
