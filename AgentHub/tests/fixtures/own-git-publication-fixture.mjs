import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOwnGitPublicationOrigin } from "../../src/infrastructure/persistence/task-publication-history.mjs";
import { releaseIdentitySha256, restoreReleaseOperation } from "../../src/domain/legacy-task-publication-proof.mjs";
import { runtimeDatabasePath } from "../../src/infrastructure/persistence/runtime-state-store.mjs";

// Archived facts in a disposable test database. No release worker, state
// transition, publication action or application-store migration is available.
export function partialOwnGitPublication({ dataDir, repositoryRoot, localMainCommit, publishedRevision,
  commit, tree, sourceBaseCommit, taskId = "selected", workspaceId = "fixture", operationId = "own-partial" }) {
  const file = runtimeDatabasePath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const database = callback => { const db = new DatabaseSync(file); try { return callback(db); } finally { db.close(); } };
  const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot,
    approvedLocalMainCommit: localMainCommit, approvedOriginMainCommit: publishedRevision };
  const authorization = { taskIds: [taskId], approvedTargets: [target], validationMode: "focused" };
  const operation = restoreReleaseOperation({ operationId, requestId: operationId, workspaceId,
    streamId: "executor", threadId: "thread", runnerVersion: "fixture", state: "waiting",
    currentStep: "publish", currentGeneration: 1, revision: 4, createdAt: "2026-01-01T00:00:00.000Z",
    authorization: { ...authorization, fingerprint: releaseIdentitySha256(authorization) } });
  if (!operation) throw new Error("Invalid archived publication fixture");
  const tasks = [{ taskId, baseCommit: localMainCommit, resultCommit: sourceBaseCommit, acceptanceRevision: 2 }];
  const contents = { operationId, generation: 1, selectedResults: tasks,
    repositoryBases: [{ repositoryRoot, baseCommit: sourceBaseCommit }],
    candidates: [{ repositoryRoot, releaseRoot: repositoryRoot, commit, tree, manifestHash: "a".repeat(64),
      manifest: { workspaceId, compositionPolicy: "main-selected-git-merge-v1", tasks,
        baseProvenance: { publishedBaseCommit: publishedRevision, agreedMainCommit: localMainCommit } } }],
    runnerVersion: "fixture" };
  const generation = { ...contents, identitySha256: releaseIdentitySha256(contents) };
  const receipt = (stepId, status, input) => ({ operationId, generation: 1, stepId, attempt: 1,
    status, input, inputSha256: releaseIdentitySha256(input) });
  const validate = receipt("validate", "applied", { candidate: generation.identitySha256 });
  const publish = receipt("publish:production", "failed", { candidate: generation.identitySha256, target });
  database(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS release_operations(operation_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT, updated_at TEXT, operation_json TEXT);
      CREATE TABLE IF NOT EXISTS release_operation_tasks(operation_id TEXT, task_id TEXT);
      CREATE TABLE IF NOT EXISTS release_candidate_generations(operation_id TEXT, generation INTEGER, identity_sha256 TEXT, generation_json TEXT);
      CREATE TABLE IF NOT EXISTS release_step_receipts(operation_id TEXT, generation INTEGER, step_id TEXT, attempt INTEGER, status TEXT, receipt_json TEXT);`);
    db.prepare("INSERT INTO release_operations VALUES(?,?,?,?,?)").run(operationId, workspaceId, operation.state, operation.updatedAt, JSON.stringify(operation));
    db.prepare("INSERT INTO release_operation_tasks VALUES(?,?)").run(operationId, taskId);
    db.prepare("INSERT INTO release_candidate_generations VALUES(?,?,?,?)").run(operationId, 1, generation.identitySha256, JSON.stringify(generation));
    for (const r of [validate, publish]) db.prepare("INSERT INTO release_step_receipts VALUES(?,?,?,?,?,?)")
      .run(operationId, 1, r.stepId, 1, r.status, JSON.stringify(r));
  });
  return { generation, operationId, target, database, authorizationHash: releaseIdentitySha256(operation.authorization),
    read: input => readOwnGitPublicationOrigin({ dataDir, ...input }),
    rows: () => database(db => JSON.stringify(["release_operations", "release_candidate_generations", "release_step_receipts"]
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()))),
    store: { get: () => structuredClone(operation), latestStep: (_id, _generation, stepId) => structuredClone(stepId === "validate" ? validate : publish) } };
}
