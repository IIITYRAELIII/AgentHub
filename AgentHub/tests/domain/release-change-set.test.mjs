import assert from "node:assert/strict";
import test from "node:test";

import {
  changeSetLogicalKey,
  frozenChangeSetManifest,
} from "../../src/domain/release-change-set.mjs";

test("REL-001 manifest freezes exact repository and file evidence", () => {
  const value = {
    revision: 2,
    repositories: [{
      projectRoot: "D:\\repo",
      baseRevision: "a".repeat(40),
      resultRevision: "b".repeat(40),
    }],
    files: [{
      projectRoot: "d:/repo",
      path: "src/app.mjs",
      operation: "modified",
      baseBlob: "c".repeat(40),
      resultBlob: "d".repeat(40),
      patchHash: "e".repeat(64),
    }],
  };
  const first = frozenChangeSetManifest(value);
  const repeated = frozenChangeSetManifest(value);

  assert.match(first.manifestHash, /^[a-f0-9]{64}$/u);
  assert.equal(first.manifestHash, repeated.manifestHash);
  assert.equal(first.repositories[0].projectRoot, "d:/repo");
  assert.equal(first.files[0].baseBlob, "c".repeat(40));
});

test("REL-001 freeze rejects empty or ambiguous evidence", () => {
  assert.throws(
    () => frozenChangeSetManifest({ revision: 1, repositories: [], files: [] }),
    /repository revisions/u,
  );
  assert.throws(
    () => frozenChangeSetManifest({
      revision: 1,
      repositories: [{
        projectRoot: "D:/repo",
        baseRevision: "a".repeat(40),
        resultRevision: "b".repeat(40),
      }],
      files: [{
        projectRoot: "D:/repo",
        path: "src/app.mjs",
        operation: "modified",
        baseBlob: "absent",
        resultBlob: "d".repeat(40),
      }],
    }),
    /modified file requires exact base and result blobs/u,
  );
});

test("Dashboard task identity takes precedence over portable ChangeSet identity", () => {
  assert.equal(changeSetLogicalKey({ taskId: "task-1", changeSetId: "change-1" }), "task:task-1");
  assert.equal(changeSetLogicalKey({ changeSetId: "change-1" }), "changeset:change-1");
});
