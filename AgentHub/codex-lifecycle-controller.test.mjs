import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexLifecycleController } from "./codex-lifecycle-controller.mjs";
import { TASK_EXECUTION_OWNERS } from "./task-catalog.mjs";

async function fixture({ delivered = false, completion = { id: "completion" }, run = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-lifecycle-controller-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const codexTurnStarts = new Map();
  const hookReceipts = {};
  const lastSeenTaskTurnIds = new Map();
  const saved = [];
  const deliveredCompletions = [];
  const projected = [];
  const remembered = [];
  const recorded = [];
  const taskRuns = {
    forEvent: () => run,
    reindex() {},
  };
  const controller = new CodexLifecycleController({
    config: {
      projects: [{ path: projectRoot }],
      dataDir: path.join(root, "data"),
    },
    ensureCodexTransport: async () => {},
    readCodexThread: async () => ({ thread: { path: "rollout", cwd: projectRoot } }),
    readCodexRolloutActivity: async () => ({ activeTurnIds: ["turn-1"] }),
    readCodexTurnUsage: async () => ({ terminal: true }),
    findProject: (value) => path.resolve(value) === path.resolve(projectRoot)
      ? { path: projectRoot }
      : null,
    codexTurnStarts,
    setBoundedMapValue: (map, key, value) => map.set(key, value),
    setHookReceipt: (kind, receipt) => { hookReceipts[kind] = receipt; },
    taskRuns,
    saveState: async () => { saved.push(true); },
    taskTitle: async () => "Lifecycle task",
    taskGitDiff: async () => "",
    changedFilesForRun: (value) => value?.changedFiles ?? [],
    turnEndNotifications: {
      hasDelivered: () => delivered,
      recordCompletion: (value) => {
        recorded.push(value);
        return completion;
      },
    },
    defaultNotificationChatId: () => 101,
    projectTurnUsageToWorkLog: async (...args) => { projected.push(args); },
    rememberLastTaskMessage: (...args) => { remembered.push(args); },
    lastSeenTaskTurnIds,
    deliverTurnEndNotification: async (value) => { deliveredCompletions.push(value); },
  });
  return {
    controller,
    projectRoot,
    codexTurnStarts,
    hookReceipts,
    saved,
    deliveredCompletions,
    projected,
    remembered,
    recorded,
    lastSeenTaskTurnIds,
  };
}

function request(command, projectRoot, payload) {
  return {
    command,
    args: [JSON.stringify({
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      projectRoot,
      ...payload,
    })],
    cwd: projectRoot,
    environment: { CODEX_THREAD_ID: "thread-1" },
  };
}

test("Codex lifecycle start records the verified turn and hook receipt", async () => {
  const f = await fixture();
  const result = await f.controller.handle(request("turn-start", f.projectRoot, {
    prompt: "Do work",
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    gitBaseline: { roots: [] },
  }));

  assert.equal(result, "Recorded Codex turn start turn-1.");
  assert.equal(f.codexTurnStarts.size, 1);
  assert.equal([...f.codexTurnStarts.values()][0].prompt, "Do work");
  assert.equal([...f.codexTurnStarts.values()][0].executionOwner, TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(f.hookReceipts.start.turnId, "turn-1");
  assert.equal(f.saved.length, 1);
});

test("Codex lifecycle completion records and delivers one terminal result", async () => {
  const f = await fixture();
  await f.controller.handle(request("turn-start", f.projectRoot, { prompt: "Do work" }));
  const result = await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: "Готово",
    changedFiles: ["one.mjs"],
    usage: { inputTokens: 10, outputTokens: 2 },
    usageReported: true,
  }));

  assert.equal(result, "Recorded Codex turn completion turn-1.");
  assert.equal(f.recorded.length, 1);
  assert.equal(f.recorded[0].taskTitle, "Lifecycle task");
  assert.deepEqual(f.recorded[0].changedFiles, ["one.mjs"]);
  assert.deepEqual(f.deliveredCompletions, [{ id: "completion" }]);
  assert.equal(f.codexTurnStarts.size, 0);
  assert.equal(f.hookReceipts.stop.status, "completed");
});

test("Codex lifecycle duplicate completion updates journal without redelivery", async () => {
  const f = await fixture({ delivered: true, completion: null });
  const result = await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: "Already delivered",
  }));

  assert.equal(result, "Turn was already delivered.");
  assert.equal(f.projected.length, 1);
  assert.equal(f.remembered.length, 1);
  assert.equal(f.deliveredCompletions.length, 0);
  assert.equal(f.lastSeenTaskTurnIds.size, 1);
});

test("Codex lifecycle rejects mixed caller identities", async () => {
  const f = await fixture();
  assert.throws(
    () => f.controller.identify({
      CODEX_THREAD_ID: "codex",
      CLAUDE_CODE_SESSION_ID: "claude",
    }),
    /both Codex and Claude IDs/,
  );
  assert.deepEqual(await f.controller.reconcile({ command: "turn-start" }), {
    resolved: true,
    result: "Codex turn-start will be recovered from its rollout.",
  });
});

