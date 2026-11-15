import assert from "node:assert/strict";
import test from "node:test";
import { preparedAwaitAuthorization } from "../../src/application/release-operation-command-service.mjs";
import { createReleaseOperation, releaseApprovedTargets, restoreReleaseOperation } from "../../src/domain/release-operation.mjs";

const targets = [
  { targetId: "production", kind: "agent-hub-publication", environment: "production", repositoryRoot: "/fixture/AgentHub" },
  { targetId: "agent-hub-github-release", kind: "agent-hub-publication", environment: "github-release", repositoryRoot: "/fixture/AgentHub" },
];
const board = { releaseTasks: () => [{ id: "task-1", status: "open", workflowStatus: "awaiting_implementation" }],
  task: id => ({ id, workspaceId: "workspace" }) };
const resolve = approvedTargets => preparedAwaitAuthorization(board, "workspace", null,
  { validationMode: "full", approvedTargets });

test("new installed release admission records the common public installer in immutable authorization", () => {
  const authorization = resolve(targets)(null);
  assert.equal(authorization.runtimeInstallation, "public-package-v1");
  const operation = createReleaseOperation({ operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", requestId: "new-public-release",
    workspaceId: "workspace", streamId: "stream", threadId: "thread", runnerVersion: "fixture", authorization });
  assert.equal(operation.authorization.runtimeInstallation, "public-package-v1");
  assert.deepEqual(restoreReleaseOperation(JSON.parse(JSON.stringify(operation))), operation);
  const changed = structuredClone(operation);
  delete changed.authorization.runtimeInstallation;
  assert.equal(restoreReleaseOperation(changed), null);
});

test("new local release requires its separately approved public target for the same repository", () => {
  assert.throws(() => resolve([targets[0]])(null), /approved.*public.*target/iu);
  assert.throws(() => resolve([targets[0], { ...targets[1], repositoryRoot: "/foreign" }])(null), /approved.*public.*target/iu);
  assert.throws(() => resolve([targets[0], { ...targets[1], targetId: "foreign-target" }])(null), /approved.*public.*target/iu);
});

test("public package execution precedes a local target regardless of target identifier ordering", () => {
  const selected = [{ ...targets[0], targetId: "aaa-local" }, targets[1]];
  const operation = createReleaseOperation({ operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", requestId: "target-order",
    workspaceId: "workspace", streamId: "stream", threadId: "thread", runnerVersion: "fixture",
    authorization: resolve(selected)(null) });
  const original = JSON.stringify(operation.authorization);
  assert.deepEqual(releaseApprovedTargets(operation).map(target => target.targetId), ["agent-hub-github-release", "aaa-local"]);
  assert.equal(JSON.stringify(operation.authorization), original);
});

test("historical admissions and publication-only targets keep their original installer protocol", () => {
  const authorization = { taskIds: ["task-1"], validationMode: "full", approvedTargets: [targets[0]] };
  const original = { authorization };
  const replayed = resolve([targets[0]])(original);
  assert.deepEqual(replayed, authorization);
  assert.equal(Object.hasOwn(resolve([targets[1]])(null), "runtimeInstallation"), false);
  assert.equal(Object.hasOwn(resolve([{ targetId: "fixture", kind: "runtime" }])(null), "runtimeInstallation"), false);
});
