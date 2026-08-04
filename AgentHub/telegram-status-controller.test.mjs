import assert from "node:assert/strict";
import test from "node:test";

import { TelegramStatusController } from "./telegram-status-controller.mjs";

function fixture({ catalogError = null, limitsError = null } = {}) {
  const catalog = [{
    provider: "codex",
    projectRoot: "C:\\repo",
    projectName: "Repo",
    threadId: "thread-1",
    title: "Current task",
    running: true,
  }];
  const sent = [];
  let limitsReads = 0;
  const controller = new TelegramStatusController({
    config: { showProjectButton: false },
    projects: [{ path: "C:\\repo", name: "Repo" }],
    findProject: () => ({ path: "C:\\repo", name: "Repo" }),
    refreshTaskCatalog: async () => {
      if (catalogError) throw catalogError;
      return catalog;
    },
    currentTaskCatalog: () => catalog,
    currentTaskRuns: () => [],
    readCodexRateLimits: async () => {
      limitsReads += 1;
      if (limitsError) throw limitsError;
      return {};
    },
    readClaudeRateLimits: async () => "",
    codexModelLabel: (value) => `Model ${value}`,
    claudeModelLabels: { opus: "Opus" },
    reasoningLabels: { high: "High" },
    collaborationModeLabels: { default: "Work" },
    sendStatusCard: async (...args) => sent.push(args),
    logger: { error() {} },
  });
  const snapshot = {
    chatId: 101,
    provider: "codex",
    projectRoot: "C:\\repo",
    threadId: "thread-1",
    taskTitle: "Fallback",
    codexModel: "sol",
    codexReasoningEffort: "high",
    codexCollaborationMode: "default",
  };
  return { controller, snapshot, sent, limitsReads: () => limitsReads };
}

test("Telegram status renders the selected live task and caches limits", async () => {
  const { controller, snapshot, sent, limitsReads } = fixture();
  await controller.send(snapshot);
  await controller.send(snapshot);

  assert.equal(limitsReads(), 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0][0], /Current task/);
  assert.equal(sent[0][2][0], "codex");
  assert.deepEqual(sent[0][3], { targetChatId: 101, provider: "codex" });
});

test("Telegram status degrades when catalog and limits are unavailable", async () => {
  const { controller, snapshot, sent } = fixture({
    catalogError: new Error("catalog offline"),
    limitsError: new Error("limits offline"),
  });
  await controller.send(snapshot);

  assert.equal(sent.length, 1);
  assert.match(sent[0][0], /Current task/);
  assert.match(sent[0][0], /limits offline/);
});

