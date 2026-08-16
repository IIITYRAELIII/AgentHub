import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeCatalogProjectionService,
  CodexCatalogProjectionService,
} from "../../../src/providers/provider-catalog-services.mjs";

test("Codex local catalog projection never writes titles through App Server", async () => {
  const titleWrites = [];
  const service = new CodexCatalogProjectionService({
    backfillPricing: async () => {},
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
    catalogEntry: (thread, project) => ({
      provider: "codex",
      threadId: thread.id,
      projectRoot: project.path,
      title: "Fallback",
    }),
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
  assert.deepEqual(titleWrites, []);
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
