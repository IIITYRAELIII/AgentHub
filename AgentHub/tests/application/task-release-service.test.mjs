import assert from "node:assert/strict";
import test from "node:test";

import { TaskReleaseService } from "../../src/application/task-release-service.mjs";

function evidence() {
  return {
    repositories: [{
      projectRoot: "D:/repo", baseRevision: "a".repeat(40), resultRevision: "b".repeat(40),
    }],
    files: [{
      projectRoot: "D:/repo", path: "src/app.mjs", operation: "modified",
      baseBlob: "c".repeat(40), resultBlob: "d".repeat(40), patchHash: "e".repeat(64),
    }],
  };
}

test("TaskReleaseService verifies before one CAS freeze", async () => {
  const calls = [];
  const taskBoard = {
    task: () => ({
      id: "task-1", workspaceId: "workspace-1", streamId: "stream-1", revision: 3,
    }),
    freezeTaskRelease: (id, payload) => { calls.push([id, payload]); return { id, frozenRevision: 4 }; },
  };
  const service = new TaskReleaseService({
    taskBoard,
    verifyFreezeEvidence: async (manifest) => ({ verifier: { name: "git" }, manifestHash: manifest.manifestHash }),
    buildTreeEvidence: async () => evidence(),
  });
  const frozen = await service.freeze({
    workspaceId: "workspace-1", actorStreamId: "stream-1", taskId: "task-1",
    expectedTaskRevision: 3, ...evidence(),
  });
  assert.equal(frozen.frozenRevision, 4);
  assert.equal(calls[0][1].expectedTaskRevision, 3);
  assert.match(calls[0][1].manifest.manifestHash, /^[a-f0-9]{64}$/u);
});

test("TaskReleaseService leaves storage untouched when verifier rejects", async () => {
  let writes = 0;
  const service = new TaskReleaseService({
    taskBoard: {
      task: () => ({ id: "task-1", workspaceId: "workspace-1", streamId: "stream-1", revision: 3 }),
      freezeTaskRelease: () => { writes += 1; },
    },
    verifyFreezeEvidence: async () => { throw new Error("blob mismatch"); },
    buildTreeEvidence: async () => evidence(),
  });
  await assert.rejects(() => service.freeze({
    workspaceId: "workspace-1", actorStreamId: "stream-1", taskId: "task-1",
    expectedTaskRevision: 3, ...evidence(),
  }), /blob mismatch/u);
  assert.equal(writes, 0);
});
