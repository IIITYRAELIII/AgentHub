import assert from "node:assert/strict";
import test from "node:test";

import {
  frozenTaskReleaseManifest,
  normalizedTaskChangedFiles,
  taskReleasePlanRevision,
} from "../../src/domain/task-release-snapshot.mjs";

test("REL-001 Task manifest freezes stable exact repository evidence", () => {
  const manifest = frozenTaskReleaseManifest({
    revision: 2,
    repositories: [{
      projectRoot: "D:/repo", baseRevision: "a".repeat(40), resultRevision: "b".repeat(40),
    }],
    files: [{
      projectRoot: "D:/repo", path: "src/app.mjs", operation: "modified",
      baseBlob: "c".repeat(40), resultBlob: "d".repeat(40), patchHash: "e".repeat(64),
    }],
  });
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.manifestHash, frozenTaskReleaseManifest(manifest).manifestHash);
  assert.equal(manifest.files[0].path, "src/app.mjs");
});

test("REL-001 changedFiles reject observed migration candidates", () => {
  assert.throws(() => normalizedTaskChangedFiles([{
    projectRoot: "D:/repo", path: "src/app.mjs", operation: "observed",
  }]), /Invalid Task release operation: observed/u);
});

test("REL-001 release plan revision hashes task id, revision and manifest", () => {
  const first = taskReleasePlanRevision("workspace", [{
    id: "task-1", releaseRevision: 3, frozenRevision: 3, releaseManifestHash: "a".repeat(64),
  }]);
  const reordered = taskReleasePlanRevision("workspace", [{
    id: "task-1", releaseRevision: 3, frozenRevision: 3, releaseManifestHash: "a".repeat(64),
  }]);
  assert.equal(first, reordered);
  assert.notEqual(first, taskReleasePlanRevision("workspace", [{
    id: "task-1", releaseRevision: 4, frozenRevision: 4, releaseManifestHash: "b".repeat(64),
  }]));
});
