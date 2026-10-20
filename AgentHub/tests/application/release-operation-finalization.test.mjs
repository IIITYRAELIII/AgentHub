import assert from "node:assert/strict";
import test from "node:test";
import { ReleaseOperationFinalization } from "../../src/application/release-operation-finalization.mjs";

test("durable finalization preserves primary, synchronizes dev and awaits canonical Task completion", async () => {
  let resolve, completed = false;
  const gate = new Promise(done => { resolve = done; });
  const calls = [];
  const service = new ReleaseOperationFinalization({
    releaseGitWorkspaces: { verifyPublishedPrimary: async () => { calls.push("primary"); return { status: "preserved" }; } },
    taskGitWorkspaces: { synchronizeMainIntoDev: async () => { calls.push("dev"); return { integrated: true }; } },
    taskBoard: { completeReleaseOperation: async () => { calls.push("tasks"); await gate; return { finalized: true }; } },
  });
  const pending = service.finalize({ operation: { workspaceId: "workspace", operationId: "original",
    authorization: { approvedTargets: [{ targetId: "production" }] },
    publicationEffects: { targets: { production: { status: "applied" } } } },
    generation: { generation: 1, selectedResults: [], candidates: [{ repositoryRoot: "/fixture", commit: "a".repeat(40) }] },
  }).then(result => { completed = true; return result; });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(calls, ["primary", "tasks"]);
  assert.equal(completed, false);
  resolve(); assert.deepEqual((await pending).tasks, { finalized: true });
  assert.deepEqual(calls, ["primary", "tasks", "dev"]);
});

test("verified delivery completes selected Tasks while dev conflict stays pending", async () => {
  let deliveries = 0, synchronized = false;
  const service = new ReleaseOperationFinalization({
    releaseGitWorkspaces: { verifyPublishedPrimary: async () => ({ status: "preserved" }) },
    taskGitWorkspaces: { synchronizeMainIntoDev: async () => ({ integrated: synchronized, reason: "foreign dev conflict" }) },
    taskBoard: { completeReleaseOperation: () => { deliveries += 1; return { finalized: true }; } },
  });
  const input = { operation: { authorization: { approvedTargets: [{ targetId: "production" }] },
    publicationEffects: { targets: {} } }, generation: { candidates: [{ repositoryRoot: "/fixture", commit: "a".repeat(40) }] } };
  await assert.rejects(service.finalize(input), /missing target effects/u);
  assert.equal(deliveries, 0);
  input.operation.publicationEffects.targets.production = { status: "applied" };
  await assert.rejects(service.finalize(input), error => {
    assert.equal(error.code, "RELEASE_EXTERNAL_CONDITION");
    assert.equal(error.finalization.status, "awaiting_dev_sync");
    assert.equal(error.finalization.tasks.finalized, true);
    assert.equal(error.finalization.repositories[0].dev.integrated, false);
    return true;
  });
  assert.equal(deliveries, 1);
  synchronized = true;
  assert.equal((await service.finalize(input)).status, "completed");
});

test("unverified primary cannot record Task delivery", async () => {
  const service = new ReleaseOperationFinalization({
    releaseGitWorkspaces: { verifyPublishedPrimary: async () => ({ status: "changed" }) },
    taskGitWorkspaces: { synchronizeMainIntoDev: () => assert.fail("unverified primary") },
    taskBoard: { completeReleaseOperation: () => assert.fail("unverified delivery") },
  });
  await assert.rejects(service.finalize({ operation: { authorization: { approvedTargets: [{ targetId: "production" }] },
    publicationEffects: { targets: { production: { status: "applied" } } } },
    generation: { candidates: [{ repositoryRoot: "/fixture", commit: "a".repeat(40) }] } }),
    { code: "RELEASE_EXTERNAL_CONDITION" });
});
