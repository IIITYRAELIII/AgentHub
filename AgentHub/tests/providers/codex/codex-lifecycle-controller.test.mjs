import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexLifecycleController } from "../../../src/providers/codex/codex-lifecycle-controller.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../../src/domain/codex-context-probe.mjs";
import { TASK_EXECUTION_OWNERS } from "../../../src/domain/task-execution-owner.mjs";

async function fixture({
  delivered = false,
  completion = { id: "completion" },
  run = null,
  taskGitDiff = async () => "",
  changedFilesForRun = (value) => value?.changedFiles ?? [],
  resolveTerminalAttachments = async () => [],
} = {}) {
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
    taskGitDiff,
    changedFilesForRun,
    turnEndNotifications: {
      hasDelivered: () => delivered,
      recordCompletion: (value) => {
        recorded.push(value);
        return completion;
      },
    },
    resolveTerminalAttachments,
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

test("Codex lifecycle commits generated images when no managed run owns the terminal", async () => {
  const calls = [];
  const responseAttachments = [
    { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
  ];
  const f = await fixture({
    resolveTerminalAttachments: async (run, turnId) => {
      calls.push({ run, turnId });
      return responseAttachments;
    },
  });
  await f.controller.handle(request("turn-start", f.projectRoot, {
    prompt: "Generate an image",
    startedAt: "2026-09-01T10:00:00.000Z",
  }));
  await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: "Done",
  }));

  assert.deepEqual(calls, [{
    run: {
      threadId: "thread-1",
      startedAt: "2026-09-01T10:00:00.000Z",
    },
    turnId: "turn-1",
  }]);
  assert.deepEqual(f.recorded[0].responseAttachments, responseAttachments);
});

test("Codex lifecycle leaves every managed run terminal to the finalizer", async () => {
  for (const status of ["running", "finishing", "completed"]) {
    let resolverCalls = 0;
    const f = await fixture({
      run: { status },
      resolveTerminalAttachments: async () => {
        resolverCalls += 1;
        return [];
      },
    });
    await f.controller.handle(request("turn-complete", f.projectRoot, {
      status: "completed",
      finalAnswer: "Done",
    }));

    assert.equal(resolverCalls, 0, status);
    assert.deepEqual(f.recorded[0].responseAttachments, [], status);
    assert.deepEqual(f.deliveredCompletions, [], status);
  }
});

test("Codex lifecycle preserves Hub terminal ownership after the managed run leaves the index", async () => {
  let resolverCalls = 0;
  const f = await fixture({
    run: null,
    resolveTerminalAttachments: async () => {
      resolverCalls += 1;
      return [];
    },
  });
  await f.controller.handle(request("turn-start", f.projectRoot, {
    prompt: "Generate an image",
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
  }));
  await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: "Done",
  }));

  assert.equal(resolverCalls, 0);
  assert.deepEqual(f.recorded[0].responseAttachments, []);
  assert.deepEqual(f.deliveredCompletions, []);
});

test("Codex lifecycle prefers turn-attributed files over shared-tree baseline changes", async () => {
  const f = await fixture({
    run: { gitBaseline: { roots: [] } },
    taskGitDiff: async () => "diff",
    changedFilesForRun: (value) => value?.gitBaseline
      ? ["themes/foreign.css"]
      : value?.changedFiles ?? [],
  });
  await f.controller.handle(request("turn-start", f.projectRoot, { prompt: "Do work" }));
  await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: "Готово",
    changedFiles: ["src/owned.mjs"],
  }));

  assert.deepEqual(f.recorded[0].changedFiles, ["src/owned.mjs"]);
});

test("Codex lifecycle does not attribute baseline-only files to a turn", async () => {
  const f = await fixture({
    run: { gitBaseline: { roots: [] } },
    taskGitDiff: async () => "diff",
    changedFilesForRun: () => ["themes/foreign.css"],
  });
  await f.controller.handle(request("turn-start", f.projectRoot, { prompt: "Do work" }));
  await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: "Готово",
    changedFiles: [],
  }));

  assert.deepEqual(f.recorded[0].changedFiles, []);
});

test("Codex lifecycle duplicate completion updates journal without redelivery", async () => {
  const f = await fixture({ delivered: true, completion: null });
  const result = await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: "Already delivered",
    startedAt: "2026-08-04T10:08:00.000Z",
  }));

  assert.equal(result, "Turn was already delivered.");
  assert.equal(f.projected.length, 1);
  assert.equal(f.remembered.length, 1);
  assert.equal(f.remembered[0][0].startedAt, "2026-08-04T10:08:00.000Z");
  assert.equal(f.deliveredCompletions.length, 0);
  assert.equal(f.lastSeenTaskTurnIds.size, 1);
});

test("Codex lifecycle ignores an internal context probe completion", async () => {
  const f = await fixture();
  await f.controller.handle(request("turn-start", f.projectRoot, {
    prompt: CODEX_CONTEXT_PROBE_PROMPT,
  }));

  const result = await f.controller.handle(request("turn-complete", f.projectRoot, {
    status: "completed",
    finalAnswer: CODEX_CONTEXT_PROBE_RESPONSE,
  }));

  assert.equal(result, "Ignored internal Codex context probe turn-1.");
  assert.equal(f.codexTurnStarts.size, 0);
  assert.equal(f.recorded.length, 0);
  assert.equal(f.projected.length, 0);
  assert.equal(f.remembered.length, 0);
  assert.equal(f.deliveredCompletions.length, 0);
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
