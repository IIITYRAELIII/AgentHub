import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { verifyWorkspaceReleasePublication } from "../../../src/infrastructure/persistence/release-publication-verifier.mjs";

const repositoryRoot = path.resolve("D:/workspace/Utilities");
const frozenHead = "frozen-head";
const plan = {
  revision: "plan-1",
  candidates: [{ gitReferences: [{ projectRoot: repositoryRoot, resultCommit: "task-result" }] }],
  ready: [{ projectRoot: repositoryRoot, files: ["AgentHub/server.mjs"] }],
};

function request(overrides = {}) {
  return {
    plan,
    expectedRepositories: [{ projectRoot: repositoryRoot, revision: frozenHead }],
    frozenCandidates: [{
      repositoryRoot, planRevision: "plan-1", manifestHash: "manifest",
      baseCommit: "base", preReleaseHead: frozenHead,
    }],
    ...overrides,
  };
}

function dependencies(publication = {}) {
  return {
    resolveRoots: async () => [repositoryRoot],
    identifyRepository: async () => "origin:https://example.test/Utilities.git",
    readPublishedRevision: async () => frozenHead,
    assertTaskResult: async () => {},
    readPackage: async () => ({ name: "agent-hub" }),
    readPublication: async () => ({
      revision: frozenHead,
      generation: "generation-1",
      publishedAt: "2026-09-04T00:00:00.000Z",
      mode: "full",
      ...publication,
    }),
  };
}

test("release verification binds every repository to its exact frozen PreRelease head", async () => {
  const result = await verifyWorkspaceReleasePublication(request(), dependencies());
  assert.deepEqual(result.repositories, [{
    root: repositoryRoot, revision: frozenHead, planRevision: "plan-1", manifestHash: "manifest",
    baseCommit: "base", preReleaseHead: frozenHead,
  }]);
  assert.equal(result.agentHubPublication.generation, "generation-1");
});

test("release verification rejects omitted per-repository expected revision", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication(request({ expectedRepositories: [] }), dependencies()),
    /requires expected_revision for every repository/u,
  );
});

test("release verification rejects unrelated or selected-plus-extra published commits", async () => {
  for (const revision of ["unrelated", "frozen-head-plus-extra"]) {
    await assert.rejects(
      verifyWorkspaceReleasePublication(request({
        expectedRepositories: [{ projectRoot: repositoryRoot, revision }],
      }), dependencies({ revision })),
      /exactly equal frozen PreRelease head/u,
    );
  }
});

test("release verification rejects an extra expected repository", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication(request({
      expectedRepositories: [
        { projectRoot: repositoryRoot, revision: frozenHead },
        { projectRoot: "D:/other", revision: frozenHead },
      ],
    }), dependencies()),
    /unrelated repository/u,
  );
});

test("release verification rejects a checkpoint from another plan", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication(request({
      frozenCandidates: [{
        repositoryRoot, planRevision: "old-plan", manifestHash: "manifest",
        baseCommit: "base", preReleaseHead: frozenHead,
      }],
    }), dependencies()),
    /checkpoint does not match plan/u,
  );
});

test("release verification still proves every immutable Task result is contained", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication(request(), {
      ...dependencies(),
      assertTaskResult: async () => { throw new Error("not ancestor"); },
    }),
    /Task result commit task-result is not contained/u,
  );
});

test("release verification rejects missing durable publication generation", async () => {
  await assert.rejects(
    verifyWorkspaceReleasePublication(request(), dependencies({ generation: "" })),
    /publication generation is missing/u,
  );
});
