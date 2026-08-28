import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { verifyWorkspaceReleasePublication } from "../../../src/infrastructure/persistence/release-publication-verifier.mjs";

const workspaceRoot = path.resolve("D:/workspace");
const repositoryRoot = path.join(workspaceRoot, "Utilities");
const plan = {
  ready: [{
    projectRoot: workspaceRoot,
    files: ["Utilities/AgentHub/server.mjs", "Utilities/CHANGELOG.md"],
  }],
};

function dependencies(publicationRevision = "revision") {
  return {
    resolveRoots: async () => [repositoryRoot],
    status: async () => "",
    assertRevision: async () => "revision",
    readPackage: async () => ({ name: "agent-hub" }),
    readPublication: async () => ({
      revision: publicationRevision,
      publishedAt: "2026-08-14T00:00:00.000Z",
      mode: "changed",
    }),
  };
}

test("release verification resolves Agent Hub from declared nested-repository files", async () => {
  let statusArgs = null;
  const result = await verifyWorkspaceReleasePublication({ plan }, {
    ...dependencies(),
    status: async (args) => {
      statusArgs = args;
      return "";
    },
  });
  assert.deepEqual(result.repositories, [{ root: repositoryRoot, revision: "revision" }]);
  assert.equal(result.agentHubPublication.revision, "revision");
  assert.deepEqual(statusArgs, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    "AgentHub/server.mjs",
    "CHANGELOG.md",
  ]);
});

test("release verification rejects dirty frozen paths", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication({ plan }, {
      ...dependencies(),
      status: async () => " M AgentHub/server.mjs",
    }),
    /release paths are dirty/u,
  );
});

test("release verification rejects a nested Agent Hub revision that is not published", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication({ plan }, dependencies("older-revision")),
    /not the currently published Agent Hub revision/u,
  );
});

test("release verification uses published ancestry instead of dirty source clones", async () => {
  const cloneRoot = path.join(workspaceRoot, "Utilities-release-clone");
  const ancestry = [];
  const releasePlan = {
    candidates: [
      {
        frozenRepositories: [{ projectRoot: repositoryRoot, resultRevision: "task-a" }],
      },
      {
        frozenRepositories: [{ projectRoot: cloneRoot, resultRevision: "task-b" }],
      },
    ],
    ready: [
      { projectRoot: repositoryRoot, files: ["AgentHub/server.mjs"] },
      { projectRoot: cloneRoot, files: ["AgentHub/client.mjs"] },
    ],
  };
  const result = await verifyWorkspaceReleasePublication({
    expectedRevision: "published",
    plan: releasePlan,
  }, {
    ...dependencies("published"),
    resolveRoots: async (projectRoot) => [projectRoot],
    status: async () => {
      throw new Error("mutable source status must not be read after publication");
    },
    identifyRepository: async () => "origin:https://example.test/Utilities.git",
    assertAncestor: async (value) => ancestry.push(value),
  });

  assert.deepEqual(result.repositories, [{ root: repositoryRoot, revision: "published" }]);
  assert.deepEqual(ancestry, [
    { repositoryRoot, ancestor: "task-a", descendant: "published" },
    { repositoryRoot, ancestor: "task-b", descendant: "published" },
  ]);
});

test("release verification rejects a frozen Task revision outside published history", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication({
      expectedRevision: "published",
      plan: {
        candidates: [{
          frozenRepositories: [{ projectRoot: repositoryRoot, resultRevision: "not-integrated" }],
        }],
        ready: [{ projectRoot: repositoryRoot, files: ["AgentHub/server.mjs"] }],
      },
    }, {
      ...dependencies("published"),
      identifyRepository: async () => "origin:https://example.test/Utilities.git",
      assertAncestor: async () => {
        throw new Error("not an ancestor");
      },
    }),
    /frozen Task revision not-integrated is not contained in published revision published/u,
  );
});
