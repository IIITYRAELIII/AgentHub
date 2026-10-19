import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeCatalogProjectionService,
  CodexCatalogProjectionService,
} from "../../../src/providers/provider-catalog-services.mjs";

test("Codex local catalog projects titles without admitting optional pricing repair", async () => {
  const titleWrites = [];
  const catalogOptions = [];
  const service = new CodexCatalogProjectionService({
    backfillPricing: async () => { throw new Error('optional pricing backfill must remain owned by post-readiness startup'); },
    readTitleHistories: async () => new Map([["thread-1", {
      currentTitle: "Local title",
      recoverableTitle: "",
    }]]),
    findProject: () => ({ path: "D:/Work" }),
    rememberRolloutPath() {},
    readActivity: async () => ({
      running: false,
      activeTurnIds: [],
      internalTurnIds: [],
      startedAtMsByTurnId: {},
      lastActivityAtMs: 1,
      model: null,
    }),
    runForTask: () => null,
    selectActiveTurnId: () => null,
    capturedOwner: () => null,
    runtimeActive: async () => false,
    agentHubPid: () => 1,
    resolveOwner: async () => null,
    catalogEntry: (thread, project, options) => {
      catalogOptions.push(options);
      return {
        provider: "codex",
        threadId: thread.id,
        projectRoot: project.path,
        title: "Fallback",
      };
    },
    modelLabel: (model) => model,
    threadResponseTitle: () => "",
    confirmationKey: () => "codex:thread-1",
    expectedTitle: () => "",
    clearExpectedTitle() {},
    preferredTitle: (_appServerTitle, history) => history.currentTitle,
    pinnedTitle: () => "",
    setThreadName: async (...args) => titleWrites.push(args),
    reconcilePinnedTitle: (_provider, _threadId, title) => ({ title, changed: false }),
    savePinnedTitles: async () => {},
    saveState: async () => {},
  });

  const entries = await service.project([{
    id: "thread-1",
    cwd: "D:/Work",
    path: "thread-1.jsonl",
    discoverySource: "local-rollout",
  }]);

  assert.equal(entries[0].title, "Local title");
  assert.equal(catalogOptions[0].activeTurnId, null);
  assert.deepEqual(titleWrites, []);
});

test("Codex catalog projection forwards only an exact non-internal turn identity", async () => {
  const projectedOptions = [];
  const dependencies = {
    backfillPricing: async () => {},
    readTitleHistories: async () => new Map(),
    findProject: () => ({ path: "D:/Work" }),
    rememberRolloutPath() {},
    readActivity: async () => ({
      running: true,
      activeTurnIds: ["user-turn"],
      internalTurnIds: [],
      startedAtMsByTurnId: { "user-turn": 10 },
      lastActivityAtMs: 20,
      model: null,
    }),
    runForTask: () => null,
    selectActiveTurnId: () => "user-turn",
    capturedOwner: () => null,
    runtimeActive: async () => true,
    agentHubPid: () => 1,
    resolveOwner: async () => "vscode",
    catalogEntry: (_thread, _project, options) => {
      projectedOptions.push(options);
      return { provider: "codex", threadId: "thread-1", title: "Task" };
    },
    modelLabel: (model) => model,
    threadResponseTitle: () => "",
    confirmationKey: () => "codex:thread-1",
    expectedTitle: () => "",
    clearExpectedTitle() {},
    preferredTitle: () => "Task",
    pinnedTitle: () => "",
    setThreadName: async () => {},
    reconcilePinnedTitle: (_provider, _threadId, title) => ({ title, changed: false }),
    savePinnedTitles: async () => {},
    saveState: async () => {},
  };
  const service = new CodexCatalogProjectionService(dependencies);

  await service.project([{ id: "thread-1", cwd: "D:/Work", path: "thread-1.jsonl" }]);
  assert.equal(projectedOptions[0].activeTurnId, "user-turn");

  dependencies.readActivity = async () => ({
    running: true,
    activeTurnIds: [],
    internalTurnIds: ["probe-turn"],
    startedAtMsByTurnId: {},
    lastActivityAtMs: 30,
    model: null,
  });
  dependencies.selectActiveTurnId = () => "probe-turn";
  const internalService = new CodexCatalogProjectionService(dependencies);
  await internalService.project([{ id: "thread-1", cwd: "D:/Work", path: "thread-1.jsonl" }]);
  assert.equal(projectedOptions[1].activeTurnId, null);
});

test("Claude catalog projection keeps provider identity separate from stream identity", async () => {
  const service = new ClaudeCatalogProjectionService({
    audit: async () => {},
    findProject: () => ({ path: "D:/Work" }),
    applyManagedCancellation: (snapshot) => snapshot,
    catalogEntry: (snapshot, project) => ({
      provider: "claude", threadId: snapshot.sessionId, streamId: snapshot.streamId, projectRoot: project.path,
    }),
  });
  const entries = await service.project([{ sessionId: "session-1", streamId: "stream-1", cwd: "D:/Work" }]);
  assert.equal(entries[0].streamId, "stream-1");
  assert.equal(entries[0].threadId, "session-1");
  assert.equal(entries[0].titleAuthoritative, true);
});

test("Claude catalog projection does not wait for transcript audit", async () => {
  let releaseAudit;
  const auditStarted = new Promise((resolve) => {
    releaseAudit = () => resolve();
  });
  const service = new ClaudeCatalogProjectionService({
    audit: () => auditStarted,
    findProject: () => ({ path: "D:/Work" }),
    applyManagedCancellation: (snapshot) => snapshot,
    catalogEntry: (snapshot, project) => ({
      provider: "claude", threadId: snapshot.sessionId, projectRoot: project.path,
    }),
  });

  const entries = await service.project([{ sessionId: "session-1", cwd: "D:/Work" }]);

  assert.equal(entries.length, 1);
  releaseAudit();
});
