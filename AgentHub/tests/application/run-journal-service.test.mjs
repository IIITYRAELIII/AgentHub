import assert from "node:assert/strict";
import test from "node:test";

import { RunJournalService } from "../../src/application/run-journal-service.mjs";
import { legacyTaskRunKeys, taskRunKey } from "../../src/domain/task-runs.mjs";

function fixture({ statImpl = async () => ({}), releaseWorkflowEnabled = true } = {}) {
  const calls = [];
  const workspaceCatalogStore = {
    releaseWorkflowEnabledForThread: () => releaseWorkflowEnabled,
    recordReleaseChange: (value) => {
      calls.push(["release", value]);
      return { id: "legacy-change", ...value };
    },
  };
  const releaseChangeSetService = {
    observeTurn: (value) => { calls.push(["changeset", value]); return value; },
  };
  const usageStore = {
    recordAutomaticAndProject: async (value) => { calls.push(["automatic", value]); return value; },
    recordAndProject: async (value) => { calls.push(["explicit", value]); return value; },
    mergeTurnTexts: async (value) => calls.push(["merge", value]),
    project: async (...args) => calls.push(["project", ...args]),
    retireLegacyStorage: async (value) => { calls.push(["retire", value]); return { removed: ["old"] }; },
  };
  const service = new RunJournalService({
    usageStore,
    workspaceCatalogStore,
    releaseChangeSetService,
    findProject: (root) => root === "C:/workspace" ? { path: root } : null,
    defaultProjectRoot: "C:/workspace",
    projectionProjectRoots: ["C:/workspace"],
    legacyLedgerFile: "legacy-ledger.json",
    legacyWorkLogFile: "WORK_LOG.md",
    messageLimit: 2,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    statImpl,
    logger: { log: (...args) => calls.push(["log", ...args]), error: (...args) => calls.push(["error", ...args]) },
  });
  return { service, calls };
}

test("RunJournalService owns bounded last-message state by task identity", () => {
  const { service } = fixture();
  const task = (threadId) => ({ provider: "codex", projectRoot: "C:/workspace", threadId });
  service.rememberLastMessage(task("one"), "First");
  service.rememberLastMessage({ ...task("one"), turnId: "turn-2" }, "Updated");
  service.rememberLastMessage(task("two"), "Second");
  service.rememberLastMessage(task("three"), "Third");
  assert.equal(service.lastMessage(task("one")), "");
  assert.equal(service.lastMessage(task("two")), "Second");
  assert.equal(service.lastMessageRecord(task("three")).updatedAt, "2026-08-04T12:00:00.000Z");
  assert.equal(service.lastMessageRecord(task("three")).threadId, "three");
  assert.equal(service.lastMessageRecord(task("three")).provider, "codex");
  assert.equal(service.lastMessageSnapshot().length, 2);
});

test("RunJournalService preserves authoritative answer time during repeated observation", () => {
  const { service } = fixture();
  const task = { provider: "codex", projectRoot: "C:/workspace", threadId: "thread", turnId: "turn-1" };
  service.rememberLastMessage(task, "Answer", { updatedAt: "2026-08-04T03:52:00.000Z" });

  service.rememberLastMessage(task, "Answer");
  assert.equal(service.lastMessageRecord(task).updatedAt, "2026-08-04T03:52:00.000Z");

  service.rememberLastMessage(task, "Answer", { updatedAt: "2026-08-04T01:53:46.371Z" });
  assert.equal(service.lastMessageRecord(task).updatedAt, "2026-08-04T01:53:46.371Z");

  service.rememberLastMessage({ ...task, turnId: "older-turn" }, "Old answer", {
    updatedAt: "2026-08-04T01:00:00.000Z",
  });
  assert.equal(service.lastMessageRecord(task).text, "Answer");
});

test("RunJournalService rejects an older turn that finishes projection after a newer turn", () => {
  const { service } = fixture();
  const task = { provider: "codex", projectRoot: "C:/workspace", threadId: "thread" };

  service.rememberLastMessage({
    ...task,
    turnId: "turn-2",
    startedAt: "2026-08-04T12:00:02.000Z",
  }, "New answer");
  service.rememberLastMessage({
    ...task,
    turnId: "turn-1",
    startedAt: "2026-08-04T12:00:01.000Z",
  }, "Old answer", { updatedAt: "2026-08-04T12:00:04.000Z" });

  assert.equal(service.lastMessageRecord(task).text, "New answer");
  assert.equal(service.lastMessageRecord(task).turnId, "turn-2");
  assert.equal(service.lastMessageRecord(task).startedAt, "2026-08-04T12:00:02.000Z");
});

test("RunJournalService revision changes only when the last-message projection changes", () => {
  const { service } = fixture();
  const task = { provider: "codex", projectRoot: "C:/workspace", threadId: "thread", turnId: "turn-1" };

  assert.equal(service.revision, 0);
  assert.equal(service.rememberLastMessage(task, "Answer", { updatedAt: "2026-08-04T03:52:00.000Z" }), true);
  assert.equal(service.revision, 1);
  assert.equal(service.rememberLastMessage(task, "Answer"), false);
  assert.equal(service.revision, 1);
  assert.equal(service.rememberLastMessage(task, "Updated"), true);
  assert.equal(service.revision, 2);
});

test("RunJournalService rejects live and restored context probe answers", () => {
  const { service } = fixture();
  const task = { provider: "codex", projectRoot: "C:/workspace", threadId: "thread", turnId: "probe" };

  assert.equal(service.rememberLastMessage(task, "AGENT_HUB_CONTEXT_PROBE"), false);
  assert.equal(service.lastMessage(task), "");
  assert.equal(service.restoreLastMessages([
    ["probe", { provider: "codex", text: "AGENT_HUB_CONTEXT_PROBE_OK_V1" }],
    ["answer", { provider: "codex", text: "Рабочий ответ" }],
  ]), 1);
  assert.deepEqual(service.lastMessageSnapshot().map(([key]) => key), ["answer"]);
});

test("RunJournalService restores only valid bounded message records", () => {
  const { service } = fixture();
  const restored = service.restoreLastMessages([
    ["old", { text: "Old" }],
    ["bad", {}],
    ["new-1", { text: "One" }],
    ["new-2", { text: "Two" }],
  ]);
  assert.equal(restored, 2);
  assert.deepEqual(service.lastMessageSnapshot().map(([key]) => key), ["new-1", "new-2"]);
});

test("RunJournalService lazily migrates legacy last-message task keys", () => {
  const { service } = fixture();
  const task = {
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-2",
  };
  const [streamKey, providerThreadKey] = legacyTaskRunKeys(task);
  service.restoreLastMessages([
    [providerThreadKey, {
      provider: "codex",
      threadId: "thread-2",
      text: "Older answer",
      updatedAt: "2026-08-20T22:50:23.628Z",
    }],
    [streamKey, {
      provider: "codex",
      threadId: "thread-2",
      text: "Latest answer",
      updatedAt: "2026-08-20T22:50:40.466Z",
    }],
  ]);

  assert.equal(service.lastMessageRecord(task).text, "Latest answer");
  assert.deepEqual(service.lastMessageSnapshot().map(([key]) => key), [taskRunKey(task)]);
});

test("RunJournalService does not migrate a previous Thread message into a reborn Thread", () => {
  const { service } = fixture();
  const task = {
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-2",
  };
  const [streamKey] = legacyTaskRunKeys(task);
  service.restoreLastMessages([[streamKey, {
    provider: "codex",
    threadId: "thread-1",
    text: "Previous Thread answer",
    updatedAt: "2026-08-20T22:40:00.000Z",
  }]]);

  assert.equal(service.lastMessageRecord(task), null);
  assert.deepEqual(service.lastMessageSnapshot().map(([key]) => key), [streamKey]);
});

test("RunJournalService selects automatic and explicit journal projection paths", async () => {
  const { service, calls } = fixture();
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "turn",
    taskTitle: "Task",
    status: "completed",
  };
  await service.projectTurn(completion, { body: "Useful final answer" });
  await service.projectTurn({ ...completion, message: { workLogId: "row-1" } }, { title: "Title" });
  assert.equal(calls[0][0], "automatic");
  assert.equal(calls[0][1].title, "Useful final answer");
  assert.equal(calls[1][0], "explicit");
  assert.equal(calls[1][1].workLogId, "row-1");
});

test("RunJournalService projects the initial and every steered message", async () => {
  const { service, calls } = fixture();
  await service.projectTurn({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "turn",
    prompts: ["Изначальный запрос", "Первое уточнение", "Второе уточнение"],
    status: "completed",
  }, { body: "Готово" });

  assert.equal(
    calls[0][1].prompt,
    "Изначальный запрос\n\nПервое уточнение\n\nВторое уточнение",
  );
});

test("RunJournalService registers changed files in the Workspace release registry", async () => {
  const { service, calls } = fixture();
  await service.projectTurn({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "turn",
    changedFiles: ["AgentHub/app.js"],
    diff: "diff --git a/AgentHub/app.js b/AgentHub/app.js",
    status: "completed",
  }, { title: "Implemented release registry" });
  const release = calls.find(([name]) => name === "release")?.[1];
  assert.equal(release.summary, "Implemented release registry");
  assert.deepEqual(release.changedFiles, ["AgentHub/app.js"]);
  assert.equal(release.status, "draft");
  assert.match(release.diffHash, /^[a-f0-9]{64}$/u);
  const observation = calls.find(([name]) => name === "changeset")?.[1];
  assert.equal(observation.status, "completed");
  assert.deepEqual(observation.changedFiles, ["AgentHub/app.js"]);
  assert.equal(observation.legacyChangeId, "legacy-change");
  assert.equal("manifestHash" in observation, false);

  await service.projectTurn({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "failed-turn",
    changedFiles: ["AgentHub/failure.js"],
    status: "failed",
  }, { title: "Failed change" });
  const failedRelease = calls.filter(([name]) => name === "release").at(-1)[1];
  assert.equal(failedRelease.status, "blocked");
  const failedObservation = calls.filter(([name]) => name === "changeset").at(-1)[1];
  assert.equal(failedObservation.status, "failed");
});

test("RunJournalService does not register changed files for a regular Workspace", async () => {
  const { service, calls } = fixture({ releaseWorkflowEnabled: false });
  await service.projectTurn({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "turn",
    changedFiles: ["AgentHub/app.js"],
    status: "completed",
  }, { title: "Regular work" });

  assert.equal(calls.some(([name]) => name === "release"), false);
  assert.equal(calls.some(([name]) => name === "changeset"), false);
  assert.equal(calls.some(([name]) => name === "automatic"), true);
});

test("RunJournalService forwards deferred projection for historical accounting", async () => {
  const { service, calls } = fixture();
  await service.projectTurn({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "historical-turn",
    status: "completed",
  }, { deferProjection: true });

  assert.equal(calls[0][0], "automatic");
  assert.equal(calls[0][1].deferProjection, true);
});

test("RunJournalService initializes projection before retiring verified legacy storage", async () => {
  const { service, calls } = fixture();
  const retirement = await service.initialize({
    pending: [{ workLogId: "pending" }],
    completions: [{ message: { workLogId: "completed" } }],
  });
  assert.deepEqual(calls.slice(0, 3).map(([name]) => name), ["merge", "project", "retire"]);
  assert.deepEqual(retirement.removed, ["old"]);
});

test("RunJournalService keeps legacy files when no ledger exists", async () => {
  const missing = new Error("missing");
  missing.code = "ENOENT";
  const { service, calls } = fixture({ statImpl: async () => { throw missing; } });
  assert.equal(await service.initialize(), null);
  assert.equal(calls.some(([name]) => name === "retire"), false);
});
