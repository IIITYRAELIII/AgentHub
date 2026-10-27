import { DatabaseSync } from "node:sqlite";
import * as releases from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { releaseIdentitySha256 } from "../../src/domain/release-operation.mjs";
import { runtimeDatabasePath } from "../../src/infrastructure/persistence/runtime-state-store.mjs";

// Seed the existing owner, generation and receipts, then preserve its partial
// publication shape. This is fixture SQL only, never an operational repair.
export function partialOwnGitPublication({ dataDir, repositoryRoot, localMainCommit, publishedRevision,
  commit, tree, sourceBaseCommit, taskId = "selected", workspaceId = "fixture", operationId = "own-partial" }) {
  const store = new releases.ReleaseOperationStore({ dataDir });
  const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot,
    approvedLocalMainCommit: localMainCommit, approvedOriginMainCommit: publishedRevision };
  const operation = store.create({ operationId, requestId: operationId, workspaceId,
    streamId: "executor", threadId: "thread", runnerVersion: "fixture",
    authorization: { taskIds: [taskId], approvedTargets: [target], validationMode: "focused" } }).operation;
  const tasks = [{ taskId, baseCommit: localMainCommit, resultCommit: sourceBaseCommit,
    acceptanceRevision: 2 }];
  const generation = store.putGeneration({ operationId: operation.operationId, generation: 1,
    repositoryBases: [{ repositoryRoot, baseCommit: sourceBaseCommit }], selectedResults: tasks,
    candidates: [{ repositoryRoot, releaseRoot: repositoryRoot, commit, tree, manifestHash: "a".repeat(64),
      manifest: { workspaceId, compositionPolicy: "main-selected-git-merge-v1", tasks,
        baseProvenance: { publishedBaseCommit: publishedRevision, agreedMainCommit: localMainCommit } } }],
    runnerVersion: "fixture" }).generation;
  const validate = store.beginStep({ operationId: operation.operationId, generation: 1,
    stepId: "validate", input: { candidate: generation.identitySha256 } }).receipt;
  store.finishStep(validate, { status: "applied", effect: { status: "passed" } });
  const publish = store.beginStep({ operationId: operation.operationId, generation: 1,
    stepId: `publish:${target.targetId}`, input: { candidate: generation.identitySha256, target } }).receipt;
  store.finishStep(publish, { status: "failed", effect: { status: "partial" }, error: new Error("runtime rolled back") });
  const before = store.get(operation.operationId);
  store.transition(operation.operationId, { state: "waiting", currentStep: "publish", resumeState: "publish",
    currentGeneration: 1, waitReason: { code: "external_condition", details: { recoveryHold: "preserved" } } },
  { expectedRevision: before.revision });
  const database = callback => {
    const db = new DatabaseSync(runtimeDatabasePath(dataDir));
    try { return callback(db); } finally { db.close(); }
  };
  return { store, generation, operationId: operation.operationId, target,
    read: input => releases.readOwnGitPublicationOrigin({ dataDir, ...input }),
    rows: () => database(db => JSON.stringify(["release_operations", "release_candidate_generations", "release_step_receipts"]
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()))),
    database,
    authorizationHash: releaseIdentitySha256(operation.authorization),
  };
}
