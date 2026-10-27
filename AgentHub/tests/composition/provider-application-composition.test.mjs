import assert from "node:assert/strict";
import test from "node:test";

import { providerApplicationFixture } from "../helpers/provider-application.fixture.mjs";

import { resumePostTurnWork } from "../../src/composition/provider-application-composition.mjs";

test("provider application shares current registries across MCP, completion, snapshots and catalog", async (t) => {
  const f = await providerApplicationFixture(t);
  const completion = f.inputs.createRunCompletionComposition;
  for (const name of ["createRunCompletionComposition", "createProviderSnapshotComposition", "createProviderOperationComposition", "createProviderStartupComposition"]) {
    assert.equal(f.inputs[name].taskRuns, f.runRegistry, name);
  }
  assert.deepEqual(f.mcp.activeRuns(), []);
  const run = { id: "original-run", provider: "codex", threadId: "thread-exact", status: "running" };
  f.runs.push(run);
  assert.deepEqual(f.mcp.activeRuns(), [run]);
  f.deferred.push({ id: "original-message", state: "queued" });
  assert.deepEqual(f.mcp.deferredInputs(), [{ id: "original-message", state: "queued" }]);
  assert.equal(completion.currentTarget().threadId, "thread-exact");
  await completion.saveState();
  const correction = f.inputs.createCodexObservabilityComposition.correctCommittedTerminal;
  assert.equal(correction({ turnId: "turn-exact", revision: 2 }), "corrected");
  assert.deepEqual(f.events, [["save"], ["correct", { turnId: "turn-exact", revision: 2 }]]);
});

test("pending runtime restart wakes deferred inputs before considering safe restart", async () => {
  const events = [];
  let finishMaintenance;
  const maintenance = new Promise((resolve) => { finishMaintenance = resolve; });

  assert.equal(resumePostTurnWork({
    maintenance,
    restartPending: true,
    wakeDeferredInputs: () => events.push("wake"),
    scheduleDeferredRestartIfReady: () => events.push("restart"),
  }), "deferred-inputs");
  assert.deepEqual(events, ["wake"]);

  finishMaintenance();
  await maintenance;
  await Promise.resolve();
  assert.deepEqual(events, ["wake", "restart"]);
});

test("completed turn wakes deferred inputs when restart is not pending", () => {
  const events = [];
  assert.equal(resumePostTurnWork({
    maintenance: Promise.resolve(),
    restartPending: false,
    wakeDeferredInputs: () => events.push("wake"),
    scheduleDeferredRestartIfReady: () => events.push("restart"),
  }), "deferred-inputs");
  assert.deepEqual(events, ["wake"]);
});
