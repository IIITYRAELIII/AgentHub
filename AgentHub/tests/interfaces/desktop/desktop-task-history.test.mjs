import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDesktopTaskHistoryFactory,
  mergeCachedTaskHistory,
  mergeDurableTaskHistory,
} from "../../../src/interfaces/desktop/desktop-task-history.mjs";
import {
  mergeActiveTaskHistory,
  mergeCompletedTaskHistory,
} from "../../../src/application/task-history.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../../src/domain/codex-context-probe.mjs";
import {
  createInterstreamMessage,
  interstreamAuditContentHash,
} from "../../../src/domain/interstream-message.mjs";
import { LocalTaskSyncStore } from "../../../src/infrastructure/persistence/task-sync-store.mjs";
import { TaskViewController } from "../../../src/interfaces/telegram/task-view-controller.mjs";

const ANNOTATION_SOURCE = {
  version: 1,
  provider: "codex",
  threadId: "thread-source",
  turnId: "turn-source",
  itemId: "item-source",
  role: "agent",
  messageKey: "provider\u001fcodex\u001fthread-source\u001fturn-source\u001fitem-source\u001fagent",
  surfaceKind: "message-body",
  surfaceIndex: 0,
  start: 0,
  end: 6,
  contentHash: `sha256:${"a".repeat(64)}`,
  surfaceHash: `sha256:${"b".repeat(64)}`,
  selectionHash: `sha256:${"c".repeat(64)}`,
};

function fixture(overrides = {}) {
  const calls = {
    binding: null,
    merged: null,
    fit: null,
    attachments: [],
    refreshes: 0,
  };
  const entries = [{
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    title: "Задача",
  }];
  const sourceHistory = Array.from({ length: 4 }, (_, index) => ({
    id: `turn-${index + 1}`,
    prompt: `Вопрос ${index + 1}`,
    answer: `Ответ ${index + 1}`,
    status: index === 3 ? "running" : "completed",
    active: index === 3,
    completed: index < 3,
    startedAt: `2026-07-30T10:0${index}:00.000Z`,
    completedAt: `2026-07-30T10:0${index}:30.000Z`,
    activities: Array.from({ length: 105 }, (__, activity) => activity),
    messages: [
      {
        itemId: `user-${index + 1}`,
        clientUserMessageId: `client-${index + 1}`,
        role: "user",
        text: `Сообщение ${index + 1}`,
      },
      {
        itemId: `agent-${index + 1}`,
        role: "agent",
        phase: "final",
        text: `Ответ агента ${index + 1}`,
      },
      { role: "tool", text: "Скрыто" },
    ],
  }));
  const state = {
    activeProvider: "codex",
    threadId: "thread-1",
    chatId: 42,
    entries,
    history: sourceHistory,
    run: {
      id: "run-1",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-live",
      promptPreview: "Текущий вопрос",
      responseText: "Текущий ответ",
      clientUserMessageId: "client-live",
      userMessages: [
        { role: "user", clientUserMessageId: "client-live", text: "Текущий вопрос" },
        { role: "user", clientUserMessageId: "client-steer", text: "Уточнение" },
      ],
      responseItemId: "response-live",
      activities: [{ type: "reasoning" }],
      activityGroups: [{ id: "commentary-1", reasoning: "Проверяю.", activities: [{ type: "reasoning" }] }],
      startedAt: "2026-07-30T11:00:00.000Z",
      messageAttachments: [{ id: "live.png", name: "live.png", type: "image/png" }],
    },
    catalogRefresh: null,
    ...overrides,
  };
  if (!state.refresh) {
    state.refresh = async () => ({ history: structuredClone(state.history) });
  }
  const desktopTaskHistory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: {
      entries: () => state.entries,
      refresh: async () => state.catalogRefresh ? state.catalogRefresh() : state.entries,
    },
    historyReader: {
      read: async (binding, options = {}) => {
        calls.binding = binding;
        const history = structuredClone(state.history);
        return {
          history: state.honorHistoryReadLimit && Number(options.limit) > 0
            ? history.slice(-Number(options.limit))
            : history,
        };
      },
      refresh: async (binding) => {
        calls.refreshes += 1;
        return state.refresh(binding);
      },
    },
    runs: {
      forTask: () => state.run,
    },
    latestMessage: overrides.latestMessage ?? (() => null),
    historyMerger: {
      mergeActive: (history, active) => {
        calls.merged = active;
        history.push({ id: active.turnId, ...active });
      },
      mergeCompleted: mergeCompletedTaskHistory,
    },
    receipts: overrides.receipts ?? {
      forMessage: (message) => ({
        ...message,
        createdAt: "2026-07-30T09:59:00.000Z",
        result: {
          attachments: [{ id: `${message.clientUserMessageId}.png`, type: "image/png" }],
        },
      }),
      forTurn: () => null,
    },
    interstreamOriginForClientMessage: overrides.interstreamOriginForClientMessage ?? (() => null),
    responseBudget: {
      fit: (payload, options) => {
        calls.fit = options;
        return payload;
      },
    },
    attachmentImporter: async (sources) => {
      calls.attachments.push(sources);
      return sources.map((item) => ({
        id: item.value.split("/").at(-1),
        type: "image/png",
      }));
    },
  });
  return { desktopTaskHistory, state, calls };
}

test("durable history merges equivalent synthetic final-answer copies", () => {
  const history = mergeDurableTaskHistory([{
    id: "turn-1",
    messages: [{
      itemId: "turn-1:rollout-agent:final",
      role: "agent",
      text: "Готово",
    }],
  }], [{
    id: "turn-1",
    messages: [
      { itemId: "turn-1:agent:live", role: "agent", text: "Готово" },
      { itemId: "turn-1:agent:final", role: "agent", text: "Готово" },
    ],
  }]);

  assert.equal(history[0].messages.length, 1);
  assert.equal(history[0].messages[0].text, "Готово");
});

test("durable terminal final adopts exact provider citation references without a duplicate", () => {
  const turnId = "turn-citation-final";
  const [turn] = mergeDurableTaskHistory([{
    id: turnId,
    messages: [{
      itemId: "provider-final-item",
      role: "agent",
      phase: "final",
      text: "Цитата 1\nГотово",
      responseAnnotationReferences: [{ index: 1 }],
    }],
  }], [{
    id: turnId,
    messages: [{
      itemId: `${turnId}:rollout-agent:final`,
      role: "agent",
      text: "Цитата 1\nГотово",
    }],
  }]);

  assert.equal(turn.messages.length, 1);
  assert.equal(turn.messages[0].itemId, `${turnId}:rollout-agent:final`);
  assert.deepEqual(turn.messages[0].responseAnnotationReferences, [{ index: 1 }]);
});

test("durable terminal final never adopts citation references across an unsafe identity", () => {
  const turnId = "turn-citation-final";
  const cases = [{
    name: "wrong canonical target",
    canonicalItemId: `other-${turnId}:rollout-agent:final`,
    hydratedMessages: [{
      itemId: "provider-final-item",
      role: "agent",
      phase: "final",
      responseAnnotationReferences: [{ index: 1 }],
    }],
  }, {
    name: "non-final provider item",
    canonicalItemId: `${turnId}:rollout-agent:final`,
    hydratedMessages: [{
      itemId: "provider-commentary-item",
      role: "agent",
      phase: "commentary",
      responseAnnotationReferences: [{ index: 1 }],
    }],
  }, {
    name: "ambiguous provider final items",
    canonicalItemId: `${turnId}:rollout-agent:final`,
    hydratedMessages: [{
      itemId: "provider-final-one",
      role: "agent",
      phase: "final",
      responseAnnotationReferences: [{ index: 1 }],
    }, {
      itemId: "provider-final-two",
      role: "agent",
      phase: "final",
      responseAnnotationReferences: [{ index: 2 }],
    }],
  }];
  for (const { name, canonicalItemId, hydratedMessages } of cases) {
    const [turn] = mergeDurableTaskHistory([{
      id: turnId,
      messages: hydratedMessages,
    }], [{
      id: turnId,
      messages: [{
        itemId: canonicalItemId,
        role: "agent",
        text: "Готово",
      }],
    }]);

    const canonical = turn.messages.find((message) => (
      message.itemId === canonicalItemId
    ));
    assert.deepEqual(canonical?.responseAnnotationReferences ?? [], [], name);
    assert.equal(turn.messages.length, hydratedMessages.length + 1, name);
  }
});

test("sparse durable history does not erase an already known interstream author", () => {
  const history = mergeDurableTaskHistory([{
    id: "turn-1",
    messages: [{
      itemId: "turn-1:user",
      role: "user",
      text: "Проверь",
      author: "Agent HUB - Architect (Codex)",
    }],
  }], [{
    id: "turn-1",
    messages: [{ itemId: "turn-1:user", role: "user", text: "Проверь" }],
  }]);

  assert.equal(history[0].messages.some((message) => (
    message.author === "Agent HUB - Architect (Codex)"
  )), true);
});

test("durable history preserves an unproven interstream provider root occurrence", () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    model: "gpt-5.6-sol",
    requestId: "release-continuation-1",
  };
  const input = createInterstreamMessage({ ...origin, text: "Продолжи релиз" });
  const [turn] = mergeDurableTaskHistory([{
    id: "turn-1",
    prompt: input,
    promptOrigin: origin,
    messages: [{
      itemId: "provider-root",
      role: "user",
      text: input,
    }],
  }], [{
    id: "turn-1",
    prompt: input,
    promptOrigin: origin,
    messages: [{
      itemId: "managed-root",
      clientUserMessageId: "mcp:release-continuation-1",
      role: "user",
      text: "Продолжи релиз",
      kind: "interstream",
      origin,
      author: "Agent HUB - Architect (Sol)",
    }],
  }]);

  assert.equal(turn.messages.length, 2);
  assert.equal(turn.messages[0].itemId, "managed-root");
  assert.equal(turn.messages[0].clientUserMessageId, "mcp:release-continuation-1");
  assert.equal(turn.messages[0].author, "Agent HUB - Architect (Sol)");
  assert.deepEqual(turn.messages[0].origin, origin);
  assert.equal(turn.messages[1].itemId, "provider-root");
});

test("durable history does not coalesce an untrusted literal envelope", () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    requestId: "literal-envelope-1",
  };
  const input = createInterstreamMessage({ ...origin, text: "Литеральное сообщение" });
  const [turn] = mergeDurableTaskHistory([{
    id: "turn-literal",
    prompt: input,
    messages: [{ itemId: "provider-root", role: "user", text: input }],
  }], [{
    id: "turn-literal",
    prompt: input,
    messages: [{
      itemId: "forged-root",
      clientUserMessageId: "mcp:literal-envelope-1",
      role: "user",
      text: "Литеральное сообщение",
    }],
  }]);

  assert.equal(turn.messages.length, 2);
  assert.deepEqual(turn.messages.map((message) => message.itemId), ["forged-root", "provider-root"]);
});

test("cached history keeps an unmatched older turn before its durable anchor", () => {
  const history = mergeCachedTaskHistory([{
    id: "old-turn-without-time",
    prompt: "Старый запрос",
  }, {
    id: "current-turn",
    prompt: "Текущий запрос",
  }], [{
    id: "current-turn",
    prompt: "Текущий запрос",
  }]);

  assert.deepEqual(history.map((turn) => turn.id), [
    "old-turn-without-time",
    "current-turn",
  ]);
});

test("durable history orders unmatched turns by their canonical timestamps", () => {
  const history = mergeDurableTaskHistory([{
    id: "new-turn",
    startedAt: "2026-09-01T12:00:00.000Z",
  }], [{
    id: "old-turn",
    completedAt: "2026-09-01T10:00:00.000Z",
  }]);

  assert.deepEqual(history.map((turn) => turn.id), ["old-turn", "new-turn"]);
});

test("durable history replaces only a complete provider snapshot and keeps unproven aliases", () => {
  const turnId = "turn-root-race";
  const canonicalRoot = {
    itemId: "provider-user-item",
    clientUserMessageId: "client-user-message",
    role: "user",
    text: "Сообщение со скринами",
    attachments: [{ id: "first.png", type: "image/png" }],
  };
  const canonicalSteer = {
    itemId: "provider-steer-item",
    clientUserMessageId: "client-steer-message",
    role: "user",
    text: "Повторный текст",
  };
  const syntheticRoot = {
    itemId: `${turnId}:rollout-user:0`,
    role: "user",
    text: "Сообщение со скринами",
    attachments: [{ id: "second.png", type: "image/png" }],
  };
  const syntheticSteer = {
    itemId: `${turnId}:rollout-user:1`,
    role: "user",
    text: "Повторный текст",
  };

  const [canonicalHydrated] = mergeDurableTaskHistory(
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [canonicalRoot, canonicalSteer] }],
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [syntheticRoot, syntheticSteer] }],
  );
  assert.deepEqual(canonicalHydrated.messages.map((message) => message.itemId), [
    "provider-user-item",
    "provider-steer-item",
  ]);
  const [repeatedCanonicalHydration] = mergeDurableTaskHistory(
    [canonicalHydrated],
    [canonicalHydrated],
  );
  assert.deepEqual(repeatedCanonicalHydration.messages, canonicalHydrated.messages);

  const [unkeyedHydrated] = mergeDurableTaskHistory(
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [syntheticRoot, syntheticSteer] }],
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [canonicalRoot, canonicalSteer] }],
  );
  assert.deepEqual(unkeyedHydrated.messages.map((message) => message.itemId), [
    "provider-user-item",
    "provider-steer-item",
    `${turnId}:rollout-user:0`,
    `${turnId}:rollout-user:1`,
  ]);
});

test("durable history preserves a sparse canonical steer without ordinal migration", () => {
  const turnId = "turn-sparse-steer";
  const syntheticRoot = {
    itemId: `${turnId}:rollout-user:0`,
    role: "user",
    text: "11 сек..",
  };
  const syntheticSteer = {
    itemId: `${turnId}:rollout-user:1`,
    role: "user",
    text: "11 сек..",
    attachments: [{ id: "legacy.png", type: "image/png" }],
  };
  const canonicalSteer = {
    itemId: "canonical-steer",
    clientUserMessageId: "b74897d2-0ba2-48e8-a378-cde19f96dbb2",
    role: "user",
    text: "11 сек..",
    attachmentSources: [{ type: "path", value: "C:/AgentHub/attachments/canonical.png" }],
  };

  const [canonicalHydrated] = mergeDurableTaskHistory(
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [syntheticRoot, canonicalSteer] }],
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [syntheticRoot, syntheticSteer] }],
  );
  assert.deepEqual(canonicalHydrated.messages.map((message) => message.itemId), [
    `${turnId}:rollout-user:0`,
    "canonical-steer",
  ]);
  const [unkeyedHydrated] = mergeDurableTaskHistory(
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [syntheticRoot, syntheticSteer] }],
    [{ id: turnId, userMessageSnapshotAuthority: "complete", messages: [syntheticRoot, canonicalSteer] }],
  );
  assert.deepEqual(unkeyedHydrated.messages.map((message) => message.itemId), [
    "canonical-steer",
    `${turnId}:rollout-user:0`,
    `${turnId}:rollout-user:1`,
  ]);
  assert.equal(unkeyedHydrated.messages[0].clientUserMessageId, "b74897d2-0ba2-48e8-a378-cde19f96dbb2");
});

test("durable history preserves a real steer beside the root message", () => {
  const turnId = "turn-with-steer";
  const [turn] = mergeDurableTaskHistory([{
    id: turnId,
    messages: [{
      itemId: `${turnId}:rollout-user:0`,
      role: "user",
      text: "Корневой запрос",
    }],
  }], [{
    id: turnId,
    messages: [{
      itemId: "root-client",
      clientUserMessageId: "root-client",
      turnUserSlot: "root",
      role: "user",
      text: "Корневой запрос",
    }, {
      itemId: "steer-client",
      clientUserMessageId: "steer-client",
      turnUserSlot: "steer",
      role: "user",
      text: "Корневой запрос",
    }],
  }]);

  assert.deepEqual(turn.messages.map((message) => message.itemId), [
    "root-client",
    "steer-client",
    `${turnId}:rollout-user:0`,
  ]);
});

test("complete provider hydration replaces an unowned stale message without itemId enrichment", () => {
  const history = mergeDurableTaskHistory([{
    id: "turn-new",
    userMessageSnapshotAuthority: "complete",
    startedAt: "2026-08-09T20:02:33.000Z",
    completedAt: "2026-08-09T20:03:14.000Z",
    messages: [{
      itemId: "client-new",
      role: "user",
      text: "Новый запрос",
      time: "2026-08-09T20:02:33.000Z",
    }],
  }], [{
    id: "turn-new",
    userMessageSnapshotAuthority: "complete",
    startedAt: "2026-08-09T19:29:18.000Z",
    completedAt: "2026-08-09T20:03:14.000Z",
    messages: [{
      itemId: "client-new",
      role: "user",
      text: "Новый запрос",
      time: "2026-08-09T19:29:18.000Z",
      attachments: [{ id: "screen.png", type: "image/png" }],
    }],
  }]);

  assert.equal(history[0].startedAt, "2026-08-09T20:02:33.000Z");
  assert.equal(history[0].messages[0].time, "2026-08-09T20:02:33.000Z");
  assert.equal(history[0].messages[0].attachments, undefined);
});

test("desktop history replays source-owned incremental occurrences exactly once", () => {
  const first = {
    role: "user",
    text: "Одинаковый текст",
    sourceOccurrenceId: `codex-rollout:${"5".repeat(64)}`,
  };
  const appended = {
    ...first,
    sourceOccurrenceId: `codex-rollout:${"6".repeat(64)}`,
  };
  let history = [];
  const hydrate = (messages) => {
    history = mergeDurableTaskHistory([{
      id: "turn-incremental-replay",
      userMessageSnapshotAuthority: "incremental",
      messages,
    }], history);
  };

  hydrate([first]);
  hydrate([first]);
  hydrate([first]);
  assert.equal(history[0].messages.filter((message) => message.role === "user").length, 1);
  hydrate([first, appended]);
  hydrate([first, appended]);
  assert.deepEqual(
    history[0].messages.filter((message) => message.role === "user")
      .map((message) => message.sourceOccurrenceId),
    [first.sourceOccurrenceId, appended.sourceOccurrenceId],
  );
});

test("desktop history replaces an enriched App Server source occurrence", () => {
  const sourceOccurrenceId = `codex-app-server:${"b".repeat(64)}`;
  const initial = {
    role: "user",
    text: "Provider projection",
    sourceOccurrenceId,
  };
  const enriched = {
    role: "user",
    text: "Accepted projection",
    sourceOccurrenceId,
    clientUserMessageId: "desktop-accepted",
    origin: { streamId: "desktop-owner" },
  };
  let history = mergeDurableTaskHistory([{
    id: "desktop-enrichment-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: [initial],
  }], []);
  history = mergeDurableTaskHistory([{
    id: "desktop-enrichment-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: [enriched],
  }], history);
  history = mergeDurableTaskHistory([{
    id: "desktop-enrichment-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: [initial],
  }], history);

  const users = history[0].messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].clientUserMessageId, "desktop-accepted");
  assert.deepEqual(users[0].origin, { streamId: "desktop-owner" });
});

test("desktop task history resolves selection and merges the active run", async () => {
  const { desktopTaskHistory, calls } = fixture();
  const result = await desktopTaskHistory({ limit: 2 });

  assert.deepEqual(calls.binding, {
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    taskTitle: "Agent HUB - Themes",
    chatId: 42,
  });
  assert.deepEqual(calls.merged, {
    active: true,
    provider: "codex",
    turnId: "turn-live",
    prompt: "Текущий вопрос",
    answer: "Текущий ответ",
    clientUserMessageId: "client-live",
    userMessages: [
      { role: "user", clientUserMessageId: "client-live", text: "Текущий вопрос" },
      { role: "user", clientUserMessageId: "client-steer", text: "Уточнение" },
    ],
    responseItemId: "response-live",
    activities: [{ type: "reasoning" }],
    activityGroups: [{ id: "commentary-1", reasoning: "Проверяю.", activities: [{ type: "reasoning" }] }],
    startedAt: "2026-07-30T11:00:00.000Z",
    attachments: [{ id: "live.png", name: "live.png", type: "image/png" }],
  });
  assert.equal(result.total, 5);
  assert.equal(result.messageTotal, 8);
  assert.equal(result.title, "Agent HUB - Themes");
  assert.equal(result.start, 3);
  assert.equal(result.end, 5);
  assert.equal(result.nextBefore, 3);
  assert.deepEqual(result.items.map((item) => item.id), ["turn-4", "turn-live"]);
  assert.equal(result.items[0].messages[0].time, "2026-07-30T09:59:00.000Z");
  assert.equal(result.items[0].messages[0].submittedAt, "2026-07-30T09:59:00.000Z");
  assert.equal(result.items[0].messages[0].startedAt, "2026-07-30T10:03:00.000Z");
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "client-4.png",
    type: "image/png",
  }]);
  assert.deepEqual(calls.fit, { maxBytes: 3_500_000 });
  assert.match(result.version, /^[A-Za-z0-9_-]{22}$/u);
});

test("durable probe repair supersedes a warm ordinary cache and accepts late user identity", async () => {
  const turn = { id: "probe-repair", prompt: CODEX_CONTEXT_PROBE_PROMPT, answer: "Ход завершён.", completed: true, contextProbe: false, messages: [] };
  const { desktopTaskHistory, state } = fixture({ run: null, history: [turn] });
  const initial = await desktopTaskHistory({ includeActive: false, limit: 10 });
  assert.deepEqual(initial.items.map((item) => item.id), [turn.id]);
  await new Promise((resolve) => setImmediate(resolve));
  state.history = [{ ...turn, operationKind: "probe", contextProbe: true }];
  const repaired = await desktopTaskHistory({ includeActive: false, limit: 10 });
  assert.deepEqual(repaired.items, []);
  state.history = [{ ...turn, operationKind: "user-turn", clientUserMessageId: "ordinary-command" }];
  const ordinary = await desktopTaskHistory({ includeActive: false, limit: 10 });
  assert.deepEqual(ordinary.items.map((item) => item.id), [turn.id]);
});

test("desktop task history removes an already persisted context probe turn", async () => {
  const { desktopTaskHistory } = fixture({
    run: null,
    history: [{
      id: "real-turn",
      prompt: "Рабочий запрос",
      answer: "Рабочий ответ",
      completed: true,
      messages: [],
    }, {
      id: "probe-turn",
      prompt: CODEX_CONTEXT_PROBE_PROMPT,
      answer: "Рабочий ответ",
      completed: true,
      clientUserMessageId: "agent-hub-context-probe:persisted",
      messages: [{
        itemId: "probe-user",
        role: "user",
        clientUserMessageId: "agent-hub-context-probe:persisted",
        text: CODEX_CONTEXT_PROBE_PROMPT,
      }, {
        itemId: "probe-answer",
        role: "agent",
        text: CODEX_CONTEXT_PROBE_RESPONSE,
      }],
    }],
  });

  const result = await desktopTaskHistory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items.map((item) => item.id), ["real-turn"]);
});

test("desktop task history hides the reserved probe text without metadata", async () => {
  const { desktopTaskHistory } = fixture({
    run: null,
    history: [{
      id: "user-turn",
      prompt: CODEX_CONTEXT_PROBE_PROMPT,
      answer: CODEX_CONTEXT_PROBE_RESPONSE,
      completed: true,
      messages: [{
        itemId: "user-message",
        role: "user",
        text: CODEX_CONTEXT_PROBE_PROMPT,
      }, {
        itemId: "user-answer",
        role: "agent",
        text: CODEX_CONTEXT_PROBE_RESPONSE,
      }],
    }],
  });

  const result = await desktopTaskHistory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items, []);
});

for (const topLevelIdentity of [true, false]) {
  test(`desktop task history keeps reserved probe text with user identity (top-level: ${topLevelIdentity})`, async () => {
    const { desktopTaskHistory } = fixture({
      run: null,
      history: [{
        id: "manual-probe-text",
        prompt: CODEX_CONTEXT_PROBE_PROMPT,
        answer: CODEX_CONTEXT_PROBE_RESPONSE,
        completed: true,
        ...(topLevelIdentity ? { clientUserMessageId: "client-manual-probe" } : {}),
        messages: [{
          itemId: "manual-user",
          role: "user",
          clientUserMessageId: "client-manual-probe",
          text: CODEX_CONTEXT_PROBE_PROMPT,
        }, {
          itemId: "manual-answer",
          role: "agent",
          text: CODEX_CONTEXT_PROBE_RESPONSE,
        }],
      }],
    });

    const result = await desktopTaskHistory({ includeActive: false, limit: 10 });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].prompt, CODEX_CONTEXT_PROBE_PROMPT);
    assert.equal(result.items[0].answer, CODEX_CONTEXT_PROBE_RESPONSE);
  });
}

test("desktop task history restores a reserved final from explicit journal identity before hydration", async () => {
  const blockedRefresh = new Promise(() => {});
  const { desktopTaskHistory } = fixture({
    run: null,
    history: [],
    refresh: async () => blockedRefresh,
    latestMessage: () => ({
      provider: "codex",
      threadId: "thread-1",
      turnId: "payload-only-user-turn",
      operationKind: "user-turn",
      contextProbe: false,
      clientUserMessageId: "client-manual-probe",
      text: CODEX_CONTEXT_PROBE_RESPONSE,
      updatedAt: "2026-09-01T16:00:00.000Z",
      terminalRevision: 1,
    }),
  });

  const result = await Promise.race([
    desktopTaskHistory({ includeActive: false, limit: 10 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("journal overlay awaited provider hydration")), 100)),
  ]);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "payload-only-user-turn");
  assert.equal(result.items[0].answer, CODEX_CONTEXT_PROBE_RESPONSE);
  assert.equal(result.items[0].messages.at(-1).text, CODEX_CONTEXT_PROBE_RESPONSE);
  assert.equal(result.items[0].terminalRevision, 1);
});

test("desktop task history hides an identity-less reserved final from the journal overlay", async () => {
  const { desktopTaskHistory } = fixture({
    run: null,
    history: [],
    latestMessage: () => ({
      provider: "codex",
      threadId: "thread-1",
      turnId: "legacy-synthetic-probe",
      text: CODEX_CONTEXT_PROBE_RESPONSE,
      updatedAt: "2026-09-01T16:00:00.000Z",
    }),
  });

  const result = await desktopTaskHistory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items, []);
});

test("desktop task history preserves the author of an interstream message", async () => {
  const { desktopTaskHistory, state } = fixture();
  state.history[3].messages[0].author = "Agent HUB · Themes (Codex)";

  const result = await desktopTaskHistory({ provider: "codex", threadId: "thread-1" });

  const turn = result.items.find((item) => item.id === "turn-4");
  assert.equal(turn.messages[0].author, "Agent HUB · Themes (Codex)");
});

test("desktop task history uses durable origin before cleaning interstream message text", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
  };
  const input = createInterstreamMessage({ ...origin, text: "Проверь доставку." });
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history = [{
    id: "legacy-interstream",
    prompt: input,
    promptOrigin: origin,
    answer: "Готово",
    completed: true,
    messages: [
      { itemId: "legacy-user", role: "user", origin, text: input },
      { itemId: "legacy-agent", role: "agent", text: "Готово" },
    ],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(result.items[0].prompt, "Проверь доставку.");
  assert.equal(result.items[0].promptAuthor, "Agent HUB - Architect (Codex)");
  assert.equal(result.items[0].messages[0].text, "Проверь доставку.");
  assert.equal(result.items[0].messages[0].author, "Agent HUB - Architect (Codex)");
});

test("desktop task history attributes a prompt-only interstream turn", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "claude",
  };
  const input = createInterstreamMessage({ ...origin, text: "Проверь тему." });
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history = [{
    id: "prompt-only-interstream",
    prompt: input,
    promptOrigin: origin,
    answer: "Готово",
    completed: true,
    messages: [],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(result.items[0].prompt, "Проверь тему.");
  assert.equal(result.items[0].promptAuthor, "Agent HUB - Themes (Claude)");
});

test("desktop task history trusts durable interstream origin after the envelope is removed", async () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "gpt-5.6-terra",
    sourceThreadId: "thread-themes",
    requestId: "request-1",
  };
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history = [{
    id: "durable-interstream",
    prompt: "Проверь тему.",
    promptAuthor: "Вы",
    promptOrigin: origin,
    answer: "Готово",
    completed: true,
    messages: [{
      itemId: "durable-user",
      role: "user",
      kind: "interstream",
      origin,
      author: "Вы",
      text: "Проверь тему.",
    }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(result.items[0].promptAuthor, "Agent HUB - Themes (Terra)");
  assert.deepEqual(result.items[0].promptOrigin, origin);
  assert.equal(result.items[0].messages[0].author, "Agent HUB - Themes (Terra)");
  assert.deepEqual(result.items[0].messages[0].origin, origin);
});

test("desktop task history recovers a legacy task assignment from exact MCP audit identity", async () => {
  const envelopeOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Original Workspace",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    model: "gpt-5.6-sol",
    sourceThreadId: "thread-architect",
    requestId: "legacy-assignment-1",
  };
  const auditOrigin = {
    ...envelopeOrigin,
    workspaceName: "Renamed Workspace",
    streamName: "S4",
  };
  delete auditOrigin.model;
  const resolved = [];
  const input = createInterstreamMessage({ ...envelopeOrigin, text: "Начни работу над Task" });
  const audit = {
    ...auditOrigin,
    toolName: "hub_task_start",
    argumentsHash: "a".repeat(64),
    contentHash: interstreamAuditContentHash(input),
  };
  const { desktopTaskHistory, state } = fixture({
    run: null,
    interstreamOriginForClientMessage: (clientUserMessageId) => {
      resolved.push(clientUserMessageId);
      return clientUserMessageId === "mcp:legacy-assignment-1" ? audit : null;
    },
  });
  state.history = [{
    id: "legacy-assignment",
    prompt: input,
    answer: "Принято",
    completed: true,
    messages: [{
      itemId: "legacy-provider-root",
      role: "user",
      text: input,
    }, {
      itemId: "legacy-managed-root",
      clientUserMessageId: "mcp:legacy-assignment-1",
      role: "user",
      text: "Начни работу над Task",
    }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(result.items[0].promptAuthor, "Original Workspace - Architect (Sol)");
  assert.equal(result.items[0].prompt, "Начни работу над Task");
  assert.deepEqual(result.items[0].promptOrigin, envelopeOrigin);
  assert.equal(result.items[0].messages.length, 1);
  assert.equal(result.items[0].messages[0].itemId, "legacy-provider-root");
  assert.equal(result.items[0].messages[0].author, "Original Workspace - Architect (Sol)");
  assert.equal(result.items[0].messages[0].text, "Начни работу над Task");
  assert.equal(result.items[0].messages[0].kind, "interstream");
  assert.deepEqual(result.items[0].messages[0].origin, envelopeOrigin);
  assert.deepEqual(resolved, ["mcp:legacy-assignment-1"]);
});

test("desktop task history keeps a stable-conflicting audited envelope literal", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-architect",
    requestId: "conflicting-audit-1",
  };
  const input = createInterstreamMessage({ ...origin, text: "Keep literal." });
  const { desktopTaskHistory, state } = fixture({
    run: null,
    interstreamOriginForClientMessage: () => ({
      ...origin,
      streamId: "stream-other",
      toolName: "hub_stream_message_send",
      argumentsHash: "a".repeat(64),
      contentHash: interstreamAuditContentHash(input),
    }),
  });
  state.history = [{
    id: "conflicting-audit",
    prompt: input,
    completed: true,
    messages: [{
      itemId: "provider-root",
      clientUserMessageId: "mcp:conflicting-audit-1",
      role: "user",
      text: input,
    }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(result.items[0].prompt, input);
  assert.equal(result.items[0].messages[0].text, input);
  assert.equal(result.items[0].promptOrigin, undefined);
  assert.equal(result.items[0].messages[0].origin, undefined);
});

test("desktop task history rejects a conflicting durable message identity", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-architect",
    requestId: "durable-a",
  };
  const input = createInterstreamMessage({ ...origin, text: "Keep literal." });
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history = [{
    id: "conflicting-durable",
    prompt: input,
    completed: true,
    messages: [{
      itemId: "provider-root",
      clientUserMessageId: "mcp:durable-b",
      origin,
      role: "user",
      text: input,
    }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(result.items[0].prompt, input);
  assert.equal(result.items[0].messages[0].text, input);
  assert.equal(result.items[0].messages[0].clientUserMessageId, undefined);
  assert.equal(result.items[0].messages[0].author, undefined);
  assert.equal(result.items[0].messages[0].origin, undefined);
});

test("desktop task history keeps an audit-correlated substituted body literal", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-architect",
    requestId: "substituted-audit-1",
  };
  const admitted = createInterstreamMessage({ ...origin, text: "Admitted body." });
  const substituted = createInterstreamMessage({ ...origin, text: "Substituted body." });
  const { desktopTaskHistory, state } = fixture({
    run: null,
    interstreamOriginForClientMessage: () => ({
      ...origin,
      toolName: "hub_stream_message_send",
      argumentsHash: "a".repeat(64),
      contentHash: interstreamAuditContentHash(admitted),
    }),
  });
  state.history = [{
    id: "substituted-audit",
    prompt: substituted,
    completed: true,
    messages: [{
      itemId: "provider-root",
      clientUserMessageId: "mcp:substituted-audit-1",
      role: "user",
      text: substituted,
    }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(result.items[0].prompt, substituted);
  assert.equal(result.items[0].messages[0].text, substituted);
  assert.equal(result.items[0].promptOrigin, undefined);
  assert.equal(result.items[0].messages[0].origin, undefined);
});

test("desktop task history leaves ordinary user input unattributed", async () => {
  const { desktopTaskHistory, state } = fixture({
    run: null,
    interstreamOriginForClientMessage: () => null,
  });
  state.history = [{
    id: "ordinary-user",
    prompt: "Обычный вопрос",
    answer: "Ответ",
    completed: true,
    messages: [{
      itemId: "ordinary-user-message",
      clientUserMessageId: "user-message-1",
      role: "user",
      text: "Обычный вопрос",
    }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal("promptAuthor" in result.items[0], false);
  assert.equal("author" in result.items[0].messages[0], false);
  assert.equal("kind" in result.items[0].messages[0], false);
  assert.equal("origin" in result.items[0].messages[0], false);
});

test("desktop task history does not reactivate a completed registry run", async () => {
  const { desktopTaskHistory, state } = fixture();
  state.run.status = "completed";
  state.run.promptPreview = "Устаревший активный запрос";
  state.run.responseText = "Устаревший промежуточный ответ";
  state.history[3].active = false;
  state.history[3].completed = true;
  state.history[3].status = "completed";
  state.history[3].answer = "Сохранённый финальный ответ";
  state.history[3].messages[1].text = "Сохранённый финальный ответ";

  const result = await desktopTaskHistory({ provider: "codex", threadId: "thread-1" });

  const turn = result.items.find((item) => item.id === "turn-4");
  assert.equal(turn.active, false);
  assert.equal(turn.answer, "Сохранённый финальный ответ");
  assert.equal(turn.messages.at(-1).text, "Сохранённый финальный ответ");
});

test("desktop task history hides an empty maintenance completion after restart", async () => {
  const { state } = fixture({ run: null });
  state.history = [{
    id: "real-turn",
    prompt: "Рабочий запрос",
    answer: "Рабочий ответ",
    completed: true,
    messages: [],
  }, {
    id: "empty-maintenance-turn",
    prompt: "",
    answer: "Ход завершён без текстового ответа.",
    completed: true,
    messages: [{ role: "agent", text: "Ход завершён без текстового ответа." }],
  }];
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: { entries: () => state.entries },
    historyReader: { read: async () => ({ history: structuredClone(state.history) }) },
    runs: { forTask: () => null },
    latestMessage: () => ({
      turnId: "empty-maintenance-turn",
      text: "Ход завершён без текстового ответа.",
      updatedAt: "2026-08-08T19:28:32.000Z",
    }),
    historyMerger: {
      mergeActive() {},
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items.map((item) => item.id), ["real-turn"]);
});

test("desktop task history hides a stale auto-compaction transfer after rotation", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history = [{
    id: "real-turn",
    prompt: "Рабочий запрос",
    answer: "Финальный ответ",
    completed: true,
    messages: [],
  }, {
    id: "auto-compact-0",
    prompt: "Сообщение с вложением",
    answer: "Полный цикл commentary предыдущего хода",
    completed: false,
    messages: [{ role: "agent", text: "Полный цикл commentary предыдущего хода" }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items.map((item) => item.id), ["real-turn"]);
});

test("desktop task history combines provider Threads in global chronological order", async () => {
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => "codex",
      threadId: () => "thread-2",
      chatId: () => 42,
    },
    catalog: {
      entries: () => [{
        streamId: "stream-1",
        provider: "codex",
        projectRoot: "D:/work",
        threadId: "thread-2",
        title: "Workspace",
      }],
      threadsForStream: () => [
        { provider: "codex", threadId: "thread-1", projectRoot: "D:/work" },
        { provider: "codex", threadId: "thread-2", projectRoot: "D:/work" },
      ],
    },
    historyReader: {
      read: async ({ threadId }) => ({
        history: [{
          id: `turn-${threadId}`,
          prompt: threadId,
          answer: `answer-${threadId}`,
          startedAt: threadId === "thread-1"
            ? "2026-08-15T01:10:00.000Z"
            : "2026-08-15T01:00:00.000Z",
        }],
      }),
    },
    runs: {
      forTask: () => ({
        provider: "codex",
        threadId: "thread-1",
        turnId: "stale-live-turn",
        responseText: "Старый live-ответ",
      }),
    },
    latestMessage: () => ({
      provider: "codex",
      threadId: "thread-1",
      turnId: "stale-final-turn",
      text: "Старый финальный ответ",
      updatedAt: "2026-07-30T09:00:00.000Z",
    }),
    historyMerger: {
      mergeActive: (history) => history.push({ id: "unexpected-live" }),
      mergeCompleted: (history) => history.push({ id: "unexpected-final" }),
    },
    responseBudget: { fit: (payload) => payload },
  });
  const result = await factory({ streamId: "stream-1", provider: "codex", threadId: "thread-2" });
  assert.equal(result.streamId, "stream-1");
  assert.deepEqual(result.items.map((item) => item.id), ["turn-thread-2", "turn-thread-1"]);
});

test("desktop Stream history uses the SQLite page without reading every Thread", async () => {
  const reads = [];
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => "claude",
      threadId: () => "thread-current",
      chatId: () => 42,
    },
    catalog: {
      entries: () => [{
        streamId: "stream-1",
        provider: "claude",
        projectRoot: "D:/work",
        threadId: "thread-current",
        title: "Workspace",
      }],
      threadsForStream: () => [
        { provider: "codex", threadId: "thread-old", projectRoot: "D:/work" },
        { provider: "claude", threadId: "thread-current", projectRoot: "D:/work" },
      ],
    },
    historyReader: {
      read: async (binding) => {
        reads.push(binding.threadId);
        throw new Error("full Thread history must not be read");
      },
      readPage: async (bindings, options) => {
        assert.deepEqual(bindings.map(({ provider, threadId }) => ({ provider, threadId })), [
          { provider: "codex", threadId: "thread-old" },
          { provider: "claude", threadId: "thread-current" },
        ]);
        assert.equal(options.limit, 2);
        return {
          total: 597,
          messageTotal: 1_429,
          start: 595,
          end: 597,
          items: [{
            provider: "codex",
            threadId: "thread-old",
            turn: {
              id: "turn-old",
              prompt: "Старый вопрос",
              answer: "Старый ответ",
              completed: true,
              startedAt: "2026-08-28T10:00:00.000Z",
              messages: [],
            },
          }, {
            provider: "claude",
            threadId: "thread-current",
            turn: {
              id: "turn-current",
              prompt: "Текущий вопрос",
              answer: "Текущий ответ",
              completed: true,
              startedAt: "2026-08-28T11:00:00.000Z",
              messages: [],
            },
          }],
        };
      },
    },
    runs: { forTask: () => null },
    latestMessage: () => null,
    historyMerger: { mergeActive() {}, mergeCompleted() {} },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({
    streamId: "stream-1",
    provider: "claude",
    threadId: "thread-current",
    limit: 2,
  });

  assert.deepEqual(reads, []);
  assert.equal(result.total, 597);
  assert.equal(result.messageTotal, 1_429);
  assert.equal(result.start, 595);
  assert.equal(result.end, 597);
  assert.deepEqual(result.items.map(({ id, provider, threadId }) => ({ id, provider, threadId })), [
    { id: "turn-old", provider: "codex", threadId: "thread-old" },
    { id: "turn-current", provider: "claude", threadId: "thread-current" },
  ]);
});

test("desktop Stream history refreshes only its current Thread and exposes a failed refresh", async () => {
  const refreshes = [];
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => "codex",
      threadId: () => "thread-current",
      chatId: () => 42,
    },
    catalog: {
      entries: () => [{
        streamId: "stream-1",
        provider: "codex",
        projectRoot: "D:/work",
        threadId: "thread-current",
        title: "Workspace",
      }],
      threadsForStream: () => [
        { provider: "codex", threadId: "thread-old", projectRoot: "D:/work" },
        { provider: "codex", threadId: "thread-current", projectRoot: "D:/work" },
      ],
    },
    historyReader: {
      read: async ({ threadId }) => ({
        history: [{
          id: `turn-${threadId}`,
          prompt: `prompt-${threadId}`,
          answer: `answer-${threadId}`,
          completed: true,
        }],
      }),
      refresh: async ({ threadId }) => {
        refreshes.push(threadId);
        throw new Error("provider is starting");
      },
    },
    runs: { forTask: () => null },
    historyMerger: {
      mergeActive: () => {},
      mergeCompleted: () => {},
    },
    latestMessage: () => null,
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-current",
    refreshSource: true,
  });

  assert.deepEqual(refreshes, ["thread-current"]);
  assert.equal(result.sourceFresh, false);
  assert.deepEqual(result.items.map((item) => item.id), ["turn-thread-old", "turn-thread-current"]);
});

test("desktop Stream history resolves a stale request and preserves mixed-provider turn provenance", async () => {
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => "claude",
      threadId: () => "thread-new",
      chatId: () => 42,
    },
    catalog: {
      entries: () => [{
        streamId: "stream-1",
        provider: "claude",
        projectRoot: "D:/work",
        threadId: "thread-new",
        title: "Workspace",
      }],
      threadsForStream: () => [
        { provider: "codex", threadId: "thread-old", projectRoot: "D:/work" },
        { provider: "claude", threadId: "thread-new", projectRoot: "D:/work" },
      ],
    },
    historyReader: {
      read: async ({ provider, threadId }) => ({
        history: [{
          id: `turn-${threadId}`,
          prompt: `prompt-${provider}`,
          answer: `answer-${provider}`,
          completed: true,
          startedAt: provider === "codex"
            ? "2026-08-15T01:00:00.000Z"
            : "2026-08-15T02:00:00.000Z",
        }],
      }),
    },
    runs: { forTask: () => null },
    historyMerger: {
      mergeActive: () => {},
      mergeCompleted: () => {},
    },
    receipts: {
      forMessage: () => null,
      forTurn: () => null,
    },
    latestMessage: () => null,
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-old",
  });

  assert.equal(result.streamId, "stream-1");
  assert.equal(result.provider, "claude");
  assert.equal(result.threadId, "thread-new");
  assert.deepEqual(result.items.map(({ id, provider, threadId }) => ({ id, provider, threadId })), [
    { id: "turn-thread-old", provider: "codex", threadId: "thread-old" },
    { id: "turn-thread-new", provider: "claude", threadId: "thread-new" },
  ]);
});

test("desktop task history returns a compact marker for an unchanged completed page", async () => {
  const { desktopTaskHistory, calls } = fixture();
  const first = await desktopTaskHistory({ limit: 2, includeActive: false });
  const unchanged = await desktopTaskHistory({
    limit: 2,
    includeActive: false,
    knownVersion: first.version,
  });

  assert.equal(calls.merged, null);
  assert.deepEqual(unchanged, {
    provider: "codex",
    threadId: "thread-1",
    notModified: true,
    version: first.version,
  });
});

test("desktop task history overlays a saved final before provider hydration catches up", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history[3].activityGroups = [{
    id: "group-1",
    reasoning: "Проверяю.",
    activities: [{ id: "tool-1", type: "command" }],
  }];
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: { entries: () => state.entries },
    historyReader: {
      read: async () => ({ history: structuredClone(state.history) }),
    },
    runs: { forTask: () => null },
    latestMessage: () => ({
      turnId: "turn-4",
      text: "Сохранённый финальный ответ",
      updatedAt: "2026-07-30T10:04:45.000Z",
    }),
    historyMerger: {
      mergeActive() {},
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({ limit: 1, includeActive: false });

  assert.equal(result.items[0].answer, "Сохранённый финальный ответ");
  assert.equal(result.items[0].messages.at(-1).text, "Сохранённый финальный ответ");
  assert.equal(result.items[0].activities.length, 105);
  assert.deepEqual(result.items[0].activityGroups, state.history[3].activityGroups);
  assert.equal(result.items[0].completed, true);
  assert.equal(typeof desktopTaskHistory, "function");
});

test("desktop task history never assigns an old final to an unrelated active turn", async () => {
  const state = fixture({ run: null }).state;
  state.history = [{
    id: "maintenance-turn",
    prompt: "",
    answer: "",
    status: "inProgress",
    active: true,
    completed: false,
    startedAt: "2026-08-08T17:09:19.000Z",
    messages: [],
  }];
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: { entries: () => state.entries },
    historyReader: { read: async () => ({ history: structuredClone(state.history) }) },
    runs: { forTask: () => null },
    latestMessage: () => ({
      turnId: "previous-user-turn",
      text: "Релиз завершён",
      updatedAt: "2026-08-08T14:21:46.000Z",
    }),
    historyMerger: {
      mergeActive() {},
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({ limit: 10, includeActive: false });

  assert.equal(result.items[0].id, "maintenance-turn");
  assert.equal(result.items[0].answer, "");
  assert.deepEqual(result.items[0].messages, []);
});

test("desktop task history keeps a saved final beside a later active user turn", async () => {
  const state = fixture({ run: null }).state;
  state.history = [{
    id: "previous-user-turn",
    prompt: "Закрепи Fake",
    answer: "Релиз",
    status: "completed",
    active: false,
    completed: true,
    startedAt: "2026-08-08T14:00:00.000Z",
    completedAt: "2026-08-08T14:21:46.000Z",
    messages: [
      { role: "user", text: "Закрепи Fake" },
      { role: "agent", phase: "final", text: "Релиз" },
    ],
  }];
  state.run = {
    provider: "codex",
    threadId: state.threadId,
    turnId: "current-user-turn",
    promptPreview: "Почему пропал предыдущий ответ?",
    responseText: "",
    clientUserMessageId: "current-client",
    userMessages: [{
      role: "user",
      clientUserMessageId: "current-client",
      text: "Почему пропал предыдущий ответ?",
      time: "2026-08-08T01:01:00.000Z",
    }],
    startedAt: "2026-08-08T17:09:19.000Z",
    messageAttachments: [],
  };
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: { entries: () => state.entries },
    historyReader: { read: async () => ({ history: structuredClone(state.history) }) },
    runs: { forTask: () => state.run },
    latestMessage: () => ({
      turnId: "previous-user-turn",
      text: "Релиз завершён",
      updatedAt: "2026-08-08T14:21:46.000Z",
      terminalRevision: 2,
    }),
    historyMerger: {
      mergeActive: mergeActiveTaskHistory,
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({ limit: 10 });

  assert.deepEqual(result.items.map((item) => item.id), ["previous-user-turn", "current-user-turn"]);
  const previous = result.items.find((item) => item.id === "previous-user-turn");
  const current = result.items.find((item) => item.id === "current-user-turn");
  assert.equal(previous.answer, "Релиз завершён");
  assert.equal(previous.completed, true);
  assert.equal(previous.terminalRevision, 2);
  assert.equal(current.answer, "");
  assert.equal(current.active, true);
  assert.equal(current.messages[0].time, "2026-08-08T01:01:00.000Z");
  assert.equal(current.messages[0].submittedAt, "2026-08-08T01:01:00.000Z");
  assert.equal(current.messages[0].startedAt, "2026-08-08T17:09:19.000Z");
});

test("desktop task history returns durable history while provider hydration is still blocked", async () => {
  let releaseRefresh;
  const blockedRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const { desktopTaskHistory, calls } = fixture({
    run: null,
    refresh: async () => blockedRefresh,
    catalogRefresh: async () => new Promise(() => {}),
  });

  const result = await Promise.race([
    desktopTaskHistory({ limit: 1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("durable history did not return promptly")), 100)),
  ]);
  assert.equal(result.total, 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.refreshes, 1);
  releaseRefresh({ history: [] });
});

test("desktop task history exposes a new durable completion before hydration refresh", async () => {
  const blockedRefresh = new Promise(() => {});
  const { desktopTaskHistory, state } = fixture({
    run: null,
    refresh: async () => blockedRefresh,
  });
  await desktopTaskHistory({ limit: 1, includeActive: false });
  state.history.push({
    id: "turn-new",
    prompt: "Новый вопрос",
    answer: "Новый финальный ответ",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      { itemId: "turn-new:user", role: "user", text: "Новый вопрос" },
      { itemId: "turn-new:agent", role: "agent", phase: "final", text: "Новый финальный ответ" },
    ],
  });

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });

  assert.equal(result.items[0].id, "turn-new");
  assert.equal(result.items[0].messages[0].text, "Новый вопрос");
  assert.equal(result.items[0].messages[1].text, "Новый финальный ответ");
});

test("desktop task history imports private screenshot references for the visible page", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  state.history[3].messages[0].attachmentSources = [{
    type: "path",
    value: "C:/Temp/codex-clipboard-test.png",
  }];

  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(calls.attachments, [[{
    type: "path",
    value: "C:/Temp/codex-clipboard-test.png",
  }]]);
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "codex-clipboard-test.png",
    type: "image/png",
  }]);
});

test("desktop task history hides Codex image transport tags but keeps the attachment", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  const imageTag = [
    "Посмотри",
    '<image name="[Image #1]" path="C:\\Temp\\screen.png">',
    "</image>",
  ].join("\n");
  state.history[3].prompt = imageTag;
  state.history[3].messages[0].text = imageTag;
  state.history[3].messages[0].attachments = [{
    id: "screen.png",
    name: "screen.png",
    type: "image/png",
  }];
  state.history[3].messages[1].text = "Пример <image path=\"public.png\"></image>";

  const result = await desktopTaskHistory({ limit: 1 });

  assert.equal(result.items[0].prompt, "Посмотри");
  assert.equal(result.items[0].messages[0].text, "Посмотри");
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "screen.png",
    name: "screen.png",
    type: "image/png",
  }]);
  assert.equal(
    result.items[0].messages[1].text,
    'Пример <image path="public.png"></image>',
  );
});

test("image-only durable messages keep a visible attachment label", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history[3].messages[0].text = [
    '<image name="[Image #1]" path="C:\\Temp\\screen.png">',
    "</image>",
  ].join("\n");
  state.history[3].messages[0].attachments = [{ id: "screen.png", type: "image/png" }];

  const result = await desktopTaskHistory({ limit: 1 });

  assert.equal(result.items[0].messages[0].text, "Изображение");
  assert.equal(result.items[0].messages[0].attachments.length, 1);
});

test("desktop task history imports generated images attached to an assistant message", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  state.history[3].messages[1].attachmentSources = [{
    type: "generated-path",
    value: "C:/Users/test/.codex/generated_images/thread/call.png",
  }];

  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(calls.attachments, [[{
    type: "generated-path",
    value: "C:/Users/test/.codex/generated_images/thread/call.png",
  }]]);
  assert.deepEqual(result.items[0].messages[1].attachments, [{
    id: "call.png",
    type: "image/png",
  }]);
});

test("desktop task history hides cached Codex inspection images from assistant answers", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history[3].messages[1].attachments = Array.from(
    { length: 8 },
    (_, index) => ({ id: `codex-viewed-page-${index + 1}.png`, type: "image/png" }),
  );
  state.history[3].messages[1].attachmentSources = Array.from(
    { length: 8 },
    (_, index) => ({ type: "view-path", value: `C:/Temp/page-${index + 1}.png` }),
  );

  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(result.items[0].messages[1].attachments, []);
});

test("desktop task history restores screenshot sources lost from the durable cache", async () => {
  const { desktopTaskHistory, state, calls } = fixture({
    run: null,
    receipts: { forMessage: () => null, forTurn: () => null },
  });
  const providerHistory = structuredClone(state.history);
  providerHistory[3].messages[0].attachmentSources = [{
    type: "data",
    value: "data:image/png;base64,aGVsbG8=",
  }];
  state.history[3].messages[0].attachments = [];
  state.refresh = async () => ({ history: providerHistory });

  const initial = await desktopTaskHistory({ limit: 1 });
  assert.deepEqual(initial.items[0].messages[0].attachments, []);
  await new Promise((resolve) => setImmediate(resolve));
  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(calls.attachments, [[{
    type: "data",
    value: "data:image/png;base64,aGVsbG8=",
  }]]);
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "png;base64,aGVsbG8=",
    type: "image/png",
  }]);
});

test("desktop task history exposes structured response annotations", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history[3].promptAnnotations = [{
    text: "Цитата",
    annotation: "Комментарий",
    source: ANNOTATION_SOURCE,
  }];
  state.history[3].promptRequest = "Общий вопрос";
  state.history[3].messages[0].responseAnnotations = state.history[3].promptAnnotations;
  state.history[3].messages[0].responseAnnotationRequest = state.history[3].promptRequest;
  state.history[3].messages[1].responseAnnotationReferences = [{ index: 1 }];

  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(result.items[0].promptAnnotations, [{
    text: "Цитата",
    annotation: "Комментарий",
    source: ANNOTATION_SOURCE,
  }]);
  assert.equal(result.items[0].promptRequest, "Общий вопрос");
  assert.deepEqual(result.items[0].messages[0].responseAnnotations, [{
    text: "Цитата",
    annotation: "Комментарий",
    source: ANNOTATION_SOURCE,
  }]);
  assert.deepEqual(result.items[0].messages[1].responseAnnotationReferences, [{ index: 1 }]);
});

test("desktop task history preserves pagination, field limits and response budget", async () => {
  const longAnswer = "я".repeat(2_000);
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  state.history[1].answer = longAnswer;
  state.history[1].messages[1].text = longAnswer;

  const result = await desktopTaskHistory({
    provider: "codex",
    threadId: "thread-1",
    before: 3,
    limit: 2,
    maxAnswerChars: 1_000,
    maxResponseBytes: 1,
  });

  assert.equal(result.start, 1);
  assert.equal(result.end, 3);
  assert.equal(result.nextBefore, 1);
  assert.equal(result.items[0].answer.length, 1_000);
  assert.equal(result.items[0].messages[1].text.length, 1_000);
  assert.equal(result.items[0].activities.length, 105);
  assert.equal(result.items[0].messages.some((message) => message.role === "tool"), false);
  assert.deepEqual(calls.fit, { maxBytes: 64 * 1_024 });
});

test("desktop task history can await provider hydration for a completed image response", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  const providerHistory = structuredClone(state.history);
  providerHistory[3].active = false;
  providerHistory[3].completed = true;
  providerHistory[3].status = "completed";
  providerHistory[3].messages[1].attachmentSources = [{
    type: "generated-path",
    value: "C:/Users/test/.codex/generated_images/thread/generated.png",
  }];
  state.refresh = async () => ({ history: providerHistory });

  const result = await desktopTaskHistory({
    limit: 1,
    includeActive: false,
    refreshSource: true,
  });

  assert.equal(calls.refreshes, 1);
  assert.deepEqual(result.items[0].messages[1].attachments, [{
    id: "generated.png",
    type: "image/png",
  }]);
});

test("desktop task history returns the preceding page for a supplied cursor", async () => {
  const { desktopTaskHistory, state } = fixture({
    run: null,
    honorHistoryReadLimit: true,
  });
  state.history = Array.from({ length: 27 }, (_, index) => ({
    id: `turn-${index + 1}`,
    prompt: `Вопрос ${index + 1}`,
    answer: `Ответ ${index + 1}`,
    status: "completed",
    completed: true,
    startedAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00.000Z`,
    completedAt: `2026-07-30T10:${String(index).padStart(2, "0")}:30.000Z`,
    messages: [
      { itemId: `user-${index + 1}`, role: "user", text: `Сообщение ${index + 1}` },
      { itemId: `agent-${index + 1}`, role: "agent", phase: "final", text: `Ответ ${index + 1}` },
    ],
  }));

  const newest = await desktopTaskHistory({ limit: 10 });
  const older = await desktopTaskHistory({ before: newest.nextBefore, limit: 10 });

  assert.deepEqual(newest.items.map((item) => item.id), [
    "turn-18", "turn-19", "turn-20", "turn-21", "turn-22",
    "turn-23", "turn-24", "turn-25", "turn-26", "turn-27",
  ]);
  assert.equal(newest.nextBefore, 17);
  assert.deepEqual(older.items.map((item) => item.id), [
    "turn-8", "turn-9", "turn-10", "turn-11", "turn-12",
    "turn-13", "turn-14", "turn-15", "turn-16", "turn-17",
  ]);
  assert.equal(older.start, 7);
  assert.equal(older.end, 17);
  assert.equal(older.nextBefore, 7);
});

test("desktop task history never assigns turn receipts to unkeyed provider occurrences", async () => {
  const { desktopTaskHistory, state } = fixture({
    run: null,
    receipts: {
      forMessage: () => null,
      forTurn: () => [{
        clientUserMessageId: "root-receipt",
        result: {
          displayText: "Текст receipt не используется для identity",
          attachments: [{ id: "root.png", type: "image/png" }],
        },
      }, {
        clientUserMessageId: "steer-receipt",
        result: {
          displayText: "Другой текст receipt тоже не используется",
          attachments: [{ id: "steer.png", type: "image/png" }],
        },
      }],
    },
  });
  state.history = [{
    id: "turn-with-steer",
    prompt: "Корневой запрос",
    answer: "Ответ",
    completed: true,
    messages: [
      {
        itemId: "turn-with-steer:rollout-user:0",
        role: "user",
        text: "Корневой запрос",
      },
      {
        itemId: "turn-with-steer:rollout-user:1",
        role: "user",
        text: "Уточнение",
      },
      { itemId: "final", role: "agent", text: "Ответ" },
    ],
  }];

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });

  assert.equal(result.items[0].messages[0].clientUserMessageId, undefined);
  assert.deepEqual(result.items[0].messages[0].attachments, []);
  assert.equal(result.items[0].messages[1].clientUserMessageId, undefined);
  assert.deepEqual(result.items[0].messages[1].attachments, []);
});

test("desktop task history leaves an external occurrence unbound when one receipt remains", async () => {
  const receipts = [{
    clientUserMessageId: "root-receipt",
    result: { attachments: [] },
  }, {
    clientUserMessageId: "steer-receipt",
    result: {
      attachments: [{ id: "steer.png", type: "image/png" }],
      responseAnnotations: [{ text: "Ветка", annotation: "сделал?" }],
      responseAnnotationRequest: "Уточнение без service markup",
    },
  }];
  const { desktopTaskHistory, state } = fixture({
    run: null,
    receipts: {
      forMessage: ({ clientUserMessageId }) => (
        receipts.find((receipt) => receipt.clientUserMessageId === clientUserMessageId) ?? null
      ),
      forTurn: () => receipts,
    },
  });
  state.history = [{
    id: "turn-with-partial-identities",
    prompt: "Корневой запрос\n\nУточнение",
    completed: true,
    messages: [{
      itemId: "provider-root",
      clientUserMessageId: "root-receipt",
      role: "user",
      text: "Корневой запрос",
    }, {
      itemId: "turn-with-partial-identities:rollout-user:1",
      role: "user",
      text: "Уточнение",
      responseAnnotations: [{ text: "Ветка", annotation: "сделал?" }],
      responseAnnotationRequest: [
        "Уточнение без service markup",
        '<image name=[Image #1] path="C:/AgentHub/attachments/steer.png">',
        "</image>",
      ].join("\n"),
    }],
  }];

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });
  assert.equal(result.items[0].messages[1].clientUserMessageId, undefined);
  assert.equal(result.items[0].messages[1].responseAnnotationRequest, "Уточнение без service markup");
  assert.deepEqual(result.items[0].messages[1].attachments, []);
});

test("desktop task history keeps turn attachments on the root user only", async () => {
  const rootAttachment = { id: "screen.png", type: "image/png" };
  const { desktopTaskHistory, state } = fixture({
    run: null,
    receipts: {
      forMessage: () => null,
      forTurn: () => [{
        clientUserMessageId: "root-receipt",
        result: { attachments: [rootAttachment] },
      }],
    },
  });
  state.history = [{
    id: "turn-with-one-screen",
    prompt: "Проанализируй изображение",
    completed: true,
    attachments: [rootAttachment],
    messages: [{
      itemId: "turn-with-one-screen:rollout-user:0",
      role: "user",
      text: "Проанализируй изображение",
    }, {
      itemId: "turn-with-one-screen:rollout-user:1",
      role: "user",
      text: "Дубля уже нет",
    }],
  }];

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });

  assert.deepEqual(result.items[0].messages[0].attachments, [rootAttachment]);
  assert.deepEqual(result.items[0].messages[1].attachments, []);
});

test("rollout history preserves authors, trusted bodies and two images after a cold SQLite reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-history-projection-"));
  const filePath = path.join(directory, "tasks.json");
  const task = { provider: "codex", threadId: "thread-1", projectRoot: directory };
  let store = new LocalTaskSyncStore({ filePath });
  const images = ["first.png", "second.png"].map((id) => ({ id, name: "image.png", type: "image/png" }));
  const origin = {
    kind: "interstream", workspaceId: "hub", workspaceName: "Agent HUB",
    streamId: "themes", streamName: "Themes", provider: "codex", model: "gpt-5.6-terra",
    sourceThreadId: "themes-thread", requestId: "design-review",
  };
  const wrapped = createInterstreamMessage({ ...origin, text: "Проверь дизайн" });
  try {
    await store.load();
    const view = new TaskViewController({
      taskSyncStore: store,
      findCodexRolloutPath: async () => "rollout.jsonl",
      readCodexRolloutActivity: async () => ({
        userMessages: { "turn-projection": [
          { itemId: "image-user", clientUserMessageId: "image-client", role: "user", text: "Проверь скриншоты",
            attachmentSources: images.map((image) => ({ type: "path", value: image.id })) },
          { itemId: "msg-child", role: "agent", kind: "subagent", author: "Субагент (Terra)",
            agentThreadId: "child-thread", model: "gpt-5.6-terra", text: "Отчёт" },
          { itemId: "trusted-user", clientUserMessageId: "mcp:design-review", role: "user", origin, text: wrapped },
          { itemId: "literal-user", clientUserMessageId: "literal-client", role: "user", text: wrapped },
        ] },
        finalMessages: { "turn-projection": "Итог" },
      }),
      attachmentImporter: async (sources) => {
        assert.deepEqual(sources.map((source) => source.value), images.map((image) => image.id));
        return structuredClone(images);
      },
    });
    await view.readHistory(task, { completedOnly: true });
    store.close();
    store = new LocalTaskSyncStore({ filePath });
    await store.load();
    const { desktopTaskHistory } = fixture({
      history: store.history(task), run: null,
      receipts: { forMessage: () => null, forTurn: () => [] },
    });
    const result = await desktopTaskHistory({ limit: 1, includeActive: false });
    const messages = result.items[0].messages;
    assert.deepEqual(messages.find((message) => message.clientUserMessageId === "image-client").attachments, images);
    const subagent = messages.find((message) => message.itemId === "msg-child");
    assert.equal(subagent.role, "agent");
    assert.equal(subagent.kind, "subagent");
    assert.equal(subagent.author, "Субагент (Terra)");
    assert.equal(subagent.agentThreadId, "child-thread");
    const trusted = messages.find((message) => message.clientUserMessageId === "mcp:design-review");
    assert.equal(trusted.text, "Проверь дизайн");
    assert.deepEqual(trusted.origin, origin);
    const literal = messages.find((message) => message.clientUserMessageId === "literal-client");
    assert.equal(literal.role, "user");
    assert.equal(literal.text, wrapped);
    assert.equal(literal.author, undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh bounded history repairs only the exact preexisting misclassified subagent occurrence across SQLite reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-history-existing-subagent-"));
  const filePath = path.join(directory, "tasks.json");
  const task = { provider: "codex", threadId: "thread-1", projectRoot: directory };
  const turnId = "turn-existing-subagent";
  const sourceOccurrenceId = `codex-rollout:${"a".repeat(64)}`;
  const root = { itemId: "root", clientUserMessageId: "root-client", role: "user", text: "Проверь" };
  const genuineUser = { itemId: "literal", clientUserMessageId: "literal-client", role: "user", text: "Отчёт" };
  const ghost = { itemId: "msg-child", sourceOccurrenceId, role: "user", text: "Отчёт" };
  let store = new LocalTaskSyncStore({ filePath });
  let refreshCount = 0;
  try {
    await store.load();
    store.recordHistory(task, [{
      id: turnId, prompt: "Проверь", answer: "Итог", completed: true, status: "completed",
      userMessageSnapshotAuthority: "incremental", messages: [root, genuineUser, ghost],
    }]);
    await store.save();
    store.close();
    store = new LocalTaskSyncStore({ filePath });
    await store.load();
    assert.equal(store.history(task)[0].messages.find((message) => message.itemId === "msg-child").role, "user");
    const view = new TaskViewController({
      taskSyncStore: store,
      findCodexRolloutPath: async () => "rollout.jsonl",
      readCodexRolloutActivity: async (_path, options) => {
        refreshCount += 1;
        assert.equal(options.tailBytes, 16 * 1024 * 1024);
        return {
          userMessageSnapshotAuthorityByTurnId: { [turnId]: "incremental" },
          userMessages: { [turnId]: [root, genuineUser, {
            ...ghost, role: "agent", kind: "subagent", agentThreadId: "child-thread",
            author: "Субагент (Terra)", model: "gpt-5.6-terra",
          }] },
          finalMessages: { [turnId]: "Итог" },
        };
      },
    });
    const harness = fixture({
      history: store.history(task), run: null,
      receipts: { forMessage: () => null, forTurn: () => [] },
      refresh: async () => {
        const result = await view.readHistory(task, { completedOnly: true });
        harness.state.history = store.history(task);
        return result;
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await harness.desktopTaskHistory({
        provider: task.provider, threadId: task.threadId, limit: 1, includeActive: false, refreshSource: true,
      });
      const messages = result.items[0].messages;
      assert.deepEqual(messages.filter((message) => message.itemId === "msg-child").map((message) => message.role), ["agent"]);
      assert.equal(messages.find((message) => message.clientUserMessageId === "literal-client").text, "Отчёт");
      assert.equal(messages.find((message) => message.role === "agent" && message.kind === "subagent").author, "Субагент (Terra)");
    }
    assert.equal(refreshCount, 2);
    const staleHistory = [{
      id: turnId, prompt: "Проверь", answer: "Итог", completed: true, status: "completed",
      userMessageSnapshotAuthority: "incremental", messages: [root, genuineUser, ghost],
    }];
    const refreshedHistory = store.history(task);
    for (const [cached, durable] of [[staleHistory, refreshedHistory], [refreshedHistory, staleHistory]]) {
      const merged = mergeCachedTaskHistory(cached, durable);
      assert.deepEqual(merged[0].messages.filter((message) => message.itemId === "msg-child").map((message) => message.role), ["agent"]);
    }
    store.close();
    store = new LocalTaskSyncStore({ filePath });
    await store.load();
    assert.deepEqual(store.history(task)[0].messages.filter((message) => message.itemId === "msg-child").map((message) => message.role), ["agent"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop task history restores receipt attachments from an explicit empty message list", async () => {
  const { desktopTaskHistory } = fixture({
    history: [{
      id: "turn-attachments",
      completed: true,
      messages: [{
        itemId: "user-attachments",
        clientUserMessageId: "client-attachments",
        role: "user",
        text: "Проверь скриншот",
        attachments: [],
      }],
    }],
    receipts: {
      forMessage: () => ({
        clientUserMessageId: "client-attachments",
        result: { attachments: [{ id: "screen.png", type: "image/png" }] },
      }),
    },
  });

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });
  assert.equal(result.items[0].messages[0].attachments[0].id, "screen.png");
});

test("desktop task history renders a Task-only message without a service label", async () => {
  const taskPrompt = [
    "# Attached Agent Hub Tasks",
    "",
    "- [Dashboard Task: Проверка](agent-hub://task/board-1) · status: new · intent: context",
    "",
    "Открой актуальное содержимое Task командой MCP `hub_task_get` по `taskId` из ссылки.",
    "",
    "# My request",
    "",
    "Учти прикреплённые Dashboard Task как контекст; само прикрепление не является просьбой выполнять их.",
  ].join("\n");
  const reference = {
    kind: "task",
    taskId: "board-1",
    taskNumber: null,
    title: "Проверка",
    workflowStatus: "new",
    workspaceId: null,
    intent: "context",
  };
  const { desktopTaskHistory } = fixture({
    run: null,
    history: [{
      id: "turn-task",
      completed: true,
      messages: [{
        itemId: "user-task",
        clientUserMessageId: "client-task",
        role: "user",
        text: taskPrompt,
      }],
    }],
    receipts: {
      forMessage: () => ({ result: { attachments: [] } }),
      forTurn: () => null,
    },
  });

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });

  assert.equal(result.items[0].messages[0].text, "");
  assert.deepEqual(result.items[0].messages[0].attachments, [reference]);
});

test("desktop task history preserves subagent identity metadata", async () => {
  const { desktopTaskHistory } = fixture({
    history: [{
      id: "turn-subagent",
      completed: true,
      messages: [{
        itemId: "agent-child",
        role: "agent",
        text: "Проверено",
        kind: "subagent",
        agentThreadId: "child-thread",
        model: "gpt-5.6-terra",
      }],
    }],
  });

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });
  assert.deepEqual(result.items[0].messages[0], {
    itemId: "agent-child",
    role: "agent",
    text: "Проверено",
    kind: "subagent",
    agentThreadId: "child-thread",
    model: "gpt-5.6-terra",
    time: null,
    attachments: [],
    pinEligible: false,
    messageKey: "",
    sourceAlias: '["codex","thread-1","turn-subagent","agent-child","agent"]',
    semanticSlot: "",
  });
});

test("desktop task history hydrates only visible turns and evicts old hydrated turns", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  state.history = Array.from({ length: 42 }, (_, index) => ({
    id: `turn-${index + 1}`,
    userMessageSnapshotAuthority: "complete",
    prompt: `Вопрос ${index + 1}`,
    answer: `Ответ ${index + 1}`,
    status: "completed",
    completed: true,
    messages: [{
      itemId: `user-${index + 1}`,
      role: "user",
      text: `Сообщение ${index + 1}`,
      attachmentSources: [{ type: "data", value: `data:image/png;base64,turn-${index + 1}` }],
    }],
  }));

  const newest = await desktopTaskHistory({ includeActive: false, limit: 1 });
  assert.equal(newest.items[0].id, "turn-42");
  assert.equal(calls.attachments.length, 1);

  for (let before = 41; before >= 1; before -= 1) {
    await desktopTaskHistory({ includeActive: false, before, limit: 1 });
  }
  await desktopTaskHistory({ includeActive: false, limit: 1 });

  assert.equal(calls.attachments.length, 43);
});

test("legacy VSC chronology survives initial load hydration reconnect journal and reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-legacy-chronology-"));
  const filePath = path.join(directory, "task-sync.json");
  const databaseFile = path.join(directory, "journal.sqlite");
  const binding = {
    streamId: "stream-legacy",
    provider: "codex",
    threadId: "thread-vsc-codex",
    projectRoot: "D:/work",
    title: "Legacy VSC chronology",
  };
  const providerHistory = [{
    id: "legacy-vsc-1",
    prompt: "Старый VSC-запрос",
    answer: "Старый VSC-ответ",
    status: "completed",
    completed: true,
    messages: [
      { itemId: "legacy-vsc-user-1", role: "user", text: "Старый VSC-запрос" },
      { itemId: "legacy-vsc-agent-1", role: "agent", phase: "final", text: "Старый VSC-ответ" },
    ],
  }, {
    id: "legacy-vsc-2",
    prompt: "Ещё один старый VSC-запрос",
    answer: "Ещё один старый VSC-ответ",
    status: "completed",
    completed: true,
    messages: [
      { itemId: "legacy-vsc-user-2", role: "user", text: "Ещё один старый VSC-запрос" },
      { itemId: "legacy-vsc-agent-2", role: "agent", phase: "final", text: "Ещё один старый VSC-ответ" },
    ],
  }, {
    id: "modern-codex-1",
    prompt: "Современный запрос",
    answer: "Современный ответ",
    status: "completed",
    completed: true,
    startedAt: "2026-09-01T20:00:00.000Z",
    completedAt: "2026-09-01T20:01:00.000Z",
    messages: [
      {
        itemId: "modern-codex-user-1",
        role: "user",
        text: "Современный запрос",
        time: "2026-09-01T20:00:00.000Z",
      },
      {
        itemId: "modern-codex-agent-1",
        role: "agent",
        phase: "final",
        text: "Современный ответ",
        time: "2026-09-01T20:01:00.000Z",
      },
    ],
  }];
  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordHistory(binding, providerHistory);
  let savedCompletion = null;
  const createHistory = () => createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => binding.provider,
      threadId: () => binding.threadId,
      chatId: () => 42,
    },
    catalog: {
      entries: () => [binding],
      threadsForStream: () => [binding],
    },
    historyReader: {
      read: async () => ({ history: store.history(binding) }),
      readPage: async (references, options) => store.historyPage(references, options),
      refresh: async () => ({ history: structuredClone(providerHistory) }),
    },
    runs: { forTask: () => null },
    latestMessage: () => savedCompletion,
    historyMerger: {
      mergeActive: mergeActiveTaskHistory,
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });
  const expectedIds = ["legacy-vsc-1", "legacy-vsc-2", "modern-codex-1"];
  const assertChronology = (result) => {
    assert.deepEqual(result.items.map((item) => item.id), expectedIds);
    assert.equal(new Set(result.items.map((item) => item.id)).size, expectedIds.length);
    assert.equal(result.items[0].startedAt, null);
    assert.equal(result.items[0].completedAt, null);
    assert.equal(result.items[0].messages[0].time, null);
  };
  try {
    const initialHistory = createHistory();
    assertChronology(await initialHistory({ streamId: binding.streamId, limit: 10 }));
    assertChronology(await initialHistory({
      streamId: binding.streamId,
      limit: 10,
      refreshSource: true,
    }));

    savedCompletion = {
      provider: binding.provider,
      threadId: binding.threadId,
      turnId: "modern-codex-1",
      text: "Современный ответ из journal overlay",
      updatedAt: "2026-09-01T20:01:30.000Z",
      terminalRevision: 2,
    };
    const overlaid = await initialHistory({ streamId: binding.streamId, limit: 10 });
    assertChronology(overlaid);
    assert.equal(overlaid.items.at(-1).answer, "Современный ответ из journal overlay");

    const reconnectedHistory = createHistory();
    assertChronology(await reconnectedHistory({ streamId: binding.streamId, limit: 10 }));

    store.close();
    store = new LocalTaskSyncStore({ filePath, databaseFile });
    await store.load();
    savedCompletion = null;
    const reloadedHistory = createHistory();
    assertChronology(await reloadedHistory({ streamId: binding.streamId, limit: 10 }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop task history rejects invalid and missing tasks", async () => {
  const { desktopTaskHistory, state } = fixture();
  await assert.rejects(
    desktopTaskHistory({ provider: "other", threadId: "thread-1" }),
    /Укажите корректный поток/,
  );
  state.entries = [];
  await assert.rejects(
    desktopTaskHistory({ provider: "codex", threadId: "missing" }),
    /Поток не найден/,
  );
});
