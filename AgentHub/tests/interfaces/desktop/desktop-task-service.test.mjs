import assert from "node:assert/strict";
import test from "node:test";

import { DesktopTaskService } from "../../../src/interfaces/desktop/desktop-task-service.mjs";

function fixture() {
  const entry = {
    streamId: "stream-1",
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "codex",
    projectRoot: "C:\\repo",
    threadId: "thread-1",
    title: "Task",
  };
  const calls = [];
  const service = new DesktopTaskService({
    catalog: () => [entry],
    refreshCatalog: async () => [entry],
    activateBinding: async (binding) => {
      calls.push(["activate", binding]);
      return { changed: true };
    },
    markRead: (...args) => calls.push(["read", ...args]),
    snapshot: async (...args) => {
      calls.push(["snapshot", ...args]);
      return { selected: true };
    },
    taskHistory: async (params) => {
      calls.push(["history", params]);
      return { params };
    },
    dispatchCommand: async (...args) => {
      calls.push(["dispatch", ...args]);
      return { selected: true };
    },
    commandTaskTarget: (params) => ({ ...params }),
    readTurn: async () => ({
      taskThreadId: "thread-1",
      projectRoot: "C:\\repo",
      body: "answer",
      title: "Turn",
    }),
    searchMessage: ({ itemId }) => itemId === "assistant-middle" ? {
      provider: "codex",
      threadId: "thread-1",
      turnThreadId: "thread-1",
      turnId: "turn-1",
      itemId,
      role: "assistant",
      text: "intermediate answer",
      occurredAt: "2026-08-10T08:00:00.000Z",
      attachmentNames: [],
    } : null,
    threadsForStream: () => [{ provider: "codex", threadId: "thread-1" }],
    currentThread: () => ({ provider: "codex", threadId: "thread-1" }),
    samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
    chatId: () => 101,
  });
  return { service, calls };
}

test("Desktop task service resolves streamId before provider references", async () => {
  const { service } = fixture();
  const target = await service.resolveTarget(
    { streamId: "stream-1" },
    { source: "vscode-extension" },
  );
  assert.equal(target.threadId, "thread-1");
  assert.equal(target.streamId, "stream-1");
  assert.equal(target.chatId, 101);
  assert.equal(target.telegramDeliveryRequested, false);
  assert.equal(target.clientSource, "vscode-extension");
  assert.equal(target.taskTitle, "Agent HUB - Themes");
});

test("Desktop task service retargets a stale Stream reference to its current Thread", async () => {
  const { service } = fixture();
  const entries = [{
    streamId: "stream-1",
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "claude",
    projectRoot: "C:\\repo",
    threadId: "thread-alpha",
    title: "Alpha",
  }, {
    streamId: "stream-1",
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "claude",
    projectRoot: "C:\\repo",
    threadId: "thread-beta",
    title: "Beta",
  }];
  service.catalog = () => entries;
  service.refreshCatalog = async () => entries;
  service.currentThread = () => ({ provider: "claude", threadId: "thread-beta" });

  const target = await service.resolveTarget({
    streamId: "stream-1",
    provider: "claude",
    threadId: "thread-alpha",
  });

  assert.equal(target.threadId, "thread-beta");
});

test("Desktop task service waits for the rotated Thread to enter the catalog", async () => {
  const { service } = fixture();
  const current = {
    streamId: "stream-1",
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "codex",
    projectRoot: "C:\\repo",
    threadId: "thread-new",
    title: "Task",
  };
  service.currentThread = () => ({ provider: "codex", threadId: "thread-new" });
  service.refreshCatalog = async () => [current];

  const target = await service.resolveTarget({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-old",
  });

  assert.equal(target.threadId, "thread-new");
});

test("Desktop task service refuses to send into a detached historical Thread", async () => {
  const { service } = fixture();
  service.threadsForStream = () => [{
    provider: "codex",
    threadId: "thread-1",
    detachedAtMs: 1_787_256_000_000,
  }];

  await assert.rejects(
    service.resolveTarget({ streamId: "stream-1" }),
    /исторический Thread.*создай новый Thread/iu,
  );
});

test("Desktop task selection activates and marks one exact task", async () => {
  const { service, calls } = fixture();
  const params = {
    provider: "codex",
    threadId: "thread-1",
    compactSnapshot: true,
    maxResponseBytes: 850_000,
  };
  const context = { source: "telegram-mini-app" };
  const result = await service.select(params, context);
  assert.equal(result.selectionChanged, true);
  assert.equal(calls[0][0], "activate");
  assert.equal(calls[0][1].taskTitle, "Agent HUB - Themes");
  assert.equal(calls[1][0], "read");
  assert.deepEqual(calls[2], ["snapshot", params, context]);
});

test("Desktop task open shares one response budget between snapshot and history", async () => {
  const { service } = fixture();
  let historyParams;
  service.dispatchCommand = async () => ({ payload: "s".repeat(300_000) });
  service.taskHistory = async (params) => {
    historyParams = params;
    return { payload: "h".repeat(params.maxResponseBytes - 1_000) };
  };

  const result = await service.openTask({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    limit: 10,
    maxAnswerChars: 75_000,
    maxResponseBytes: 850_000,
    compactSnapshot: true,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 850_000);
  assert.equal(historyParams.refreshSource, true);
  assert.ok(historyParams.maxResponseBytes >= 64 * 1_024);
  assert.ok(historyParams.maxResponseBytes < 550_000);
});

test("Desktop task open marks an answer discovered by canonical history refresh as read", async () => {
  const { service, calls } = fixture();
  let latestTurnId = "turn-before-refresh";
  service.dispatchCommand = async () => {
    calls.push(["dispatch-read", latestTurnId]);
    return {
      version: "snapshot-before-refresh",
      selectionChanged: true,
      tasks: [{ threadId: "thread-1", unread: true }],
    };
  };
  service.taskHistory = async () => {
    calls.push(["history-refresh"]);
    latestTurnId = "turn-after-refresh";
    return { turns: [{ id: latestTurnId }] };
  };
  service.markRead = (entry, context) => {
    calls.push(["read-after-history", latestTurnId, entry.threadId, context]);
  };
  service.snapshot = async (params, context) => {
    calls.push(["snapshot-after-read", params, context]);
    return {
      version: "snapshot-after-refresh",
      tasks: [{ threadId: "thread-1", unread: false }],
    };
  };
  const context = { source: "trusted-device", userId: "42" };

  const result = await service.openTask({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    compactSnapshot: true,
  }, context);

  assert.deepEqual(calls.map(([name]) => name), [
    "dispatch-read",
    "history-refresh",
    "read-after-history",
    "snapshot-after-read",
  ]);
  assert.equal(calls[2][1], "turn-after-refresh");
  assert.equal(calls[3][1].knownVersion, "snapshot-before-refresh");
  assert.equal(result.snapshot.tasks[0].unread, false);
  assert.equal(result.snapshot.selectionChanged, true);
});

test("Desktop task open resolves a rotated Thread to the current Stream task", async () => {
  const { service, calls } = fixture();
  service.threadsForStream = () => [
    { provider: "codex", threadId: "thread-old" },
    { provider: "codex", threadId: "thread-1" },
  ];

  const result = await service.openTask({
    provider: "codex",
    threadId: "thread-old",
    limit: 20,
  });

  const dispatch = calls.find(([name]) => name === "dispatch");
  const history = calls.find(([name]) => name === "history");
  assert.equal(dispatch[2].streamId, "stream-1");
  assert.equal(dispatch[2].threadId, "thread-1");
  assert.equal(dispatch[4].target.streamId, "stream-1");
  assert.equal(dispatch[4].target.threadId, "thread-1");
  assert.equal(history[1].streamId, "stream-1");
  assert.equal(history[1].threadId, "thread-1");
  assert.equal(result.history.params.threadId, "thread-1");
});

test("Desktop task open resolves a stale cross-provider Stream request to its current binding", async () => {
  const { service, calls } = fixture();
  const current = {
    streamId: "stream-1",
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "claude",
    projectRoot: "C:\\repo",
    threadId: "thread-new",
    title: "Task",
  };
  service.catalog = () => [current];
  service.refreshCatalog = async () => [current];
  service.threadsForStream = () => [
    { provider: "codex", threadId: "thread-old" },
    { provider: "claude", threadId: "thread-new" },
  ];

  const result = await service.openTask({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-old",
    limit: 20,
  });

  const dispatch = calls.find(([name]) => name === "dispatch");
  const history = calls.find(([name]) => name === "history");
  assert.equal(dispatch[2].provider, "claude");
  assert.equal(dispatch[2].threadId, "thread-new");
  assert.equal(history[1].provider, "claude");
  assert.equal(history[1].threadId, "thread-new");
  assert.equal(result.history.params.provider, "claude");
  assert.equal(result.history.params.threadId, "thread-new");
});

test("Desktop turn open verifies task ownership before returning the body", async () => {
  const { service, calls } = fixture();
  const result = await service.openTurn({
    provider: "codex",
    taskThreadId: "thread-1",
    turnThreadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(result.focusedTurn.answer, "answer");
  assert.equal(calls.some(([name]) => name === "dispatch"), true);
});

test("Desktop turn deep link resolves a historical Thread after Stream rebirth", async () => {
  const { service, calls } = fixture();
  const current = {
    streamId: "stream-1",
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "claude",
    projectRoot: "C:\\repo-current",
    threadId: "thread-new",
    title: "Task",
  };
  service.catalog = () => [current];
  service.refreshCatalog = async () => [current];
  service.threadsForStream = () => [
    { provider: "codex", threadId: "thread-old", projectRoot: "C:\\repo-old" },
    { provider: "claude", threadId: "thread-new", projectRoot: "C:\\repo-current" },
  ];
  service.readTurn = async (params) => {
    calls.push(["turn", params]);
    return {
      taskThreadId: "thread-old",
      projectRoot: "C:\\repo-old",
      body: "historical answer",
      title: "Historical turn",
    };
  };

  const result = await service.openTurn({
    provider: "codex",
    taskThreadId: "thread-old",
    turnThreadId: "thread-old",
    turnId: "turn-old",
  });

  const dispatch = calls.find(([name]) => name === "dispatch");
  const history = calls.find(([name]) => name === "history");
  assert.equal(dispatch[2].streamId, "stream-1");
  assert.equal(dispatch[2].provider, "claude");
  assert.equal(dispatch[2].threadId, "thread-new");
  assert.deepEqual(calls.find(([name]) => name === "turn")[1], {
    provider: "codex",
    threadId: "thread-old",
    turnId: "turn-old",
  });
  assert.equal(history[1].streamId, "stream-1");
  assert.equal(history[1].provider, "codex");
  assert.equal(history[1].threadId, "thread-old");
  assert.equal(result.focusedTurn.answer, "historical answer");
});

test("Desktop turn open forwards compact limits and bounds its history", async () => {
  const { service, calls } = fixture();
  let historyParams;
  service.dispatchCommand = async (...args) => {
    calls.push(["dispatch", ...args]);
    return { payload: "s".repeat(300_000) };
  };
  service.readTurn = async () => ({
    taskThreadId: "thread-1",
    projectRoot: "C:\\repo",
    body: "a".repeat(120_000),
    title: "Turn",
  });
  service.taskHistory = async (params) => {
    historyParams = params;
    return { payload: "h".repeat(params.maxResponseBytes - 1_000) };
  };
  const params = {
    streamId: "stream-1",
    provider: "codex",
    taskThreadId: "thread-1",
    turnThreadId: "thread-1",
    turnId: "turn-1",
    compactSnapshot: true,
    maxAnswerChars: 120_000,
    maxResponseBytes: 850_000,
  };

  const result = await service.openTurn(params, { source: "telegram-mini-app" });

  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 850_000);
  assert.ok(historyParams.maxResponseBytes >= 64 * 1_024);
  assert.ok(historyParams.maxResponseBytes < 430_000);
  assert.equal(calls.at(-1)[0], "dispatch");
  assert.equal(calls.at(-1)[2].compactSnapshot, true);
});

test("Desktop turn open returns the exact indexed intermediate message", async () => {
  const { service } = fixture();
  const result = await service.openTurn({
    streamId: "stream-1",
    provider: "codex",
    taskThreadId: "thread-1",
    turnThreadId: "thread-1",
    turnId: "turn-1",
    itemId: "assistant-middle",
  });
  assert.equal(result.focusedMessage.itemId, "assistant-middle");
  assert.equal(result.focusedTurn.focusItemId, "assistant-middle");
  assert.equal(result.focusedTurn.messages[0].text, "intermediate answer");
});

test("Desktop message intake does not start catalog refresh for a cached task", async () => {
  const { service } = fixture();
  let refreshStarted = false;
  service.refreshCatalog = async () => {
    refreshStarted = true;
    return new Promise(() => {});
  };

  const target = await service.resolveTarget({ streamId: "stream-1" });

  assert.equal(target.threadId, "thread-1");
  assert.equal(refreshStarted, false);
});

test("Desktop turn open keeps an inter-Stream source agent on its fallback prompt", async () => {
  const { service } = fixture();
  service.readTurn = async () => ({
    taskThreadId: "thread-1",
    projectRoot: "C:\\repo",
    prompt: [
      "<agent-hub-stream-message>",
      JSON.stringify({
        workspaceId: "workspace-1",
        workspaceName: "Agent HUB",
        streamId: "stream-architect",
        streamName: "Architect",
        provider: "claude",
      }),
      "</agent-hub-stream-message>",
      "Review the release.",
    ].join("\n"),
    body: "Reviewed.",
    title: "Turn",
  });

  const result = await service.openTurn({
    streamId: "stream-1",
    provider: "codex",
    taskThreadId: "thread-1",
    turnThreadId: "thread-1",
    turnId: "turn-interstream",
  });

  assert.equal(result.focusedTurn.prompt, "Review the release.");
  assert.equal(result.focusedTurn.promptAuthor, "Agent HUB - Architect (Claude)");
});
