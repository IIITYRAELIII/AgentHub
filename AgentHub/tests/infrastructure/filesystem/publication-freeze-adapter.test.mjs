import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { freezePreparedPublication } from "../../../src/composition/publication-freeze.mjs";
test("publication freeze uses a fresh candidate plan and rejects drift before promotion", async () => {
  const repositoryRoot = path.resolve("release-candidate");
  const checkpoint = {
    manifestHash: "a".repeat(64), planRevision: "accepted-plan", preReleaseHead: "b".repeat(40),
  };
  const preparedManifest = { workspaceId: "workspace" };
  const frozenManifest = { publication: { releaseVersion: "2026.9.17" } };
  const reads = [];
  const read = async (file) => {
    reads.push(file);
    if (file.endsWith("checkpoint.json")) return JSON.stringify(checkpoint);
    if (file.endsWith(`${checkpoint.manifestHash}.json`)) return JSON.stringify(preparedManifest);
    if (file.endsWith("frozen.json")) return JSON.stringify(frozenManifest);
    if (file.endsWith("CHANGELOG.md")) return "release notes";
    throw new Error(`unexpected file: ${file}`);
  };
  const createReleaseWorkspace = () => ({
    freezePublicationCandidate: async (request) => {
      await request.validateBeforeCommit();
      return { manifestFile: path.join(repositoryRoot, "frozen.json") };
    },
  });
  const common = {
    repositoryRoot,
    read,
    assertClone: async () => ({
      releaseRoot: repositoryRoot,
      primaryRoot: path.resolve("primary"),
      managedRoot: path.resolve("managed", "release-repositories", "key"),
    }),
    createReleaseWorkspace,
    assertCleanTree: async () => {},
    assertCurrentRevision: async () => {},
  };
  assert.equal(await freezePreparedPublication({
    ...common, readPlan: async (workspaceId) => ({ workspaceId, revision: "accepted-plan" }),
  }), "2026.9.17");
  await assert.rejects(freezePreparedPublication({
    ...common, readPlan: async () => ({ revision: "installed-stale-plan" }),
  }), /plan changed before publication freeze/u);
  assert.ok(reads.some((file) => file.endsWith("CHANGELOG.md")));
});
