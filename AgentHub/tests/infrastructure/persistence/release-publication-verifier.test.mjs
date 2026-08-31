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

test("release verification checks immutable Task result commits instead of mutable source clones", async () => {
  const cloneRoot = path.join(workspaceRoot, "Utilities-release-clone");
  const comparisons = [];
  const releasePlan = {
    candidates: [
      {
        gitReferences: [{ projectRoot: repositoryRoot, resultCommit: "task-a" }],
      },
      {
        gitReferences: [{ projectRoot: cloneRoot, resultCommit: "task-b" }],
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
    assertTaskResult: async (value) => comparisons.push(value),
  });

  assert.deepEqual(result.repositories, [{ root: repositoryRoot, revision: "published" }]);
  assert.deepEqual(comparisons, [
    {
      repositoryRoot, taskRevision: "task-a", publishedRevision: "published",
    },
    {
      repositoryRoot, taskRevision: "task-b", publishedRevision: "published",
    },
  ]);
});

test("release verification rejects a Task result commit missing from the published revision", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication({
      expectedRevision: "published",
      plan: {
        candidates: [{
          gitReferences: [{ projectRoot: repositoryRoot, resultCommit: "not-integrated" }],
        }],
        ready: [{ projectRoot: repositoryRoot, files: ["AgentHub/server.mjs"] }],
      },
    }, {
      ...dependencies("published"),
      identifyRepository: async () => "origin:https://example.test/Utilities.git",
      assertTaskResult: async () => {
        throw new Error("not an ancestor");
      },
    }),
    /Task result commit not-integrated is not contained in published revision published/u,
  );
});

test("release verification uses the same commit ancestry check for resolved overlaps", async () => {
  const comparisons = [];
  const releasePlan = {
    candidates: [{
      gitReferences: [{ projectRoot: repositoryRoot, resultCommit: "task-a" }],
    }],
    ready: [{
      projectRoot: repositoryRoot,
      files: ["AgentHub/shared.mjs", "AgentHub/unique.mjs", "CHANGELOG.md"],
    }],
    conflicts: [{ projectRoot: repositoryRoot, file: "AgentHub/shared.mjs" }],
  };

  await verifyWorkspaceReleasePublication({
    expectedRevision: "published",
    plan: releasePlan,
    conflictsResolved: true,
  }, {
    ...dependencies("published"),
    identifyRepository: async () => "origin:https://example.test/Utilities.git",
    assertTaskResult: async (value) => comparisons.push(value),
  });

  assert.deepEqual(comparisons, [{
    repositoryRoot,
    taskRevision: "task-a",
    publishedRevision: "published",
  }]);
});
