import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";

function fixture() {
  const root = path.resolve("fixture-repository");
  const tasks = [{ taskId: "task", taskRevision: 4, resultCommit: "result", projectRoot: root }];
  const state = {
    plan: { revision: "plan", ready: tasks, blocked: [] },
    candidate: {
      repositoryRoot: root, releaseRoot: path.join(root, "release"), checkpointPhase: "prepared",
      planRevision: "plan", baseCommit: "base", preReleaseHead: "candidate", tree: "tree", manifestHash: "manifest",
      manifest: { workspaceId: "workspace", planRevision: "plan", baseCommit: "base", tasks },
    },
    reads: 0,
  };
  const forbidden = () => assert.fail("preflight must not prepare dev, compose PreRelease or access the rolling contour");
  const service = new WorkspaceReleasePreflightService({
    releasePlanner: { plan: async () => state.plan },
    taskGitWorkspaces: { assertExplicitUpstreamAdoption: async () => {},
      releaseIntegrationEvidence: forbidden, prepareDev: forbidden, verifyReleaseResultsInDev: forbidden },
    releaseGitWorkspaces: {
      withAwaitTransition: async (_id, fn) => fn(), prepareCandidate: forbidden,
      inspectMainChanges: async () => ({ projectRoot: root, localMain: "base", originMain: "base", approvalRequired: false }),
      assertPrimaryInvariant: async () => ({ projectRoot: root, headCommit: "base" }),
      frozenCandidate: async () => { state.reads++; return structuredClone(state.candidate); },
    },
    readPublicationState: async () => ({ repositories: [{ root, revision: "base" }] }),
    resolveReleaseValidationSource: async () => ({ kind: "workspace-release-pipeline", projectRoot: root }),
  });
  const run = () => service.preflight({ workspaceId: "workspace", expectedPlanRevision: "plan" });
  return { root, state, service, run };
}

for (const phase of ["prepared", "frozen"]) test(`preflight reads ${phase} candidate unchanged on repeated requests`, async () => {
  const f = fixture(); f.state.candidate.checkpointPhase = phase;
  const before = structuredClone(f.state.candidate);
  const first = await f.run(); const second = await f.run();
  assert.equal(first.status, "ready"); assert.equal(second.status, "ready");
  assert.deepEqual(first.releaseCandidates, second.releaseCandidates);
  assert.deepEqual(f.state.candidate, before);
  assert.equal(first.testContour, undefined);
});

for (const [name, mutate, expected] of [
  ["plan", c => { c.planRevision = "old-plan"; }, /accepted release plan/u],
  ["Workspace", c => { c.manifest.workspaceId = "foreign"; }, /accepted release plan/u],
  ["result", c => { c.manifest.tasks[0].resultCommit = "old-result"; }, /accepted release plan/u],
  ["Task revision", c => { c.manifest.tasks[0].taskRevision--; }, /accepted release plan/u],
  ["extra Task", c => { c.manifest.tasks.push({ taskId: "foreign", taskRevision: 1, resultCommit: "extra" }); }, /accepted release plan/u],
  ["unreviewed base", c => { c.baseCommit = "new-origin"; c.manifest.baseCommit = "new-origin"; }, /reviewed main/u],
  ["unfinished freeze", c => { c.checkpointPhase = "freezing"; }, /unfinished operation/u],
]) test(`preflight rejects ${name} without rebuilding`, async () => {
  const f = fixture(); f.state.candidate = structuredClone(f.state.candidate);
  mutate(f.state.candidate); await assert.rejects(f.run, expected);
});

test("missing candidate is an error, never an implicit rebuild", async () => {
  const f = fixture(); f.service.releaseGitWorkspaces.frozenCandidate = async () => { throw new Error("release checkpoint is incomplete"); };
  await assert.rejects(f.run, /checkpoint is incomplete/u);
});

test("local main movement after audit cannot inherit approval", async () => {
  const f = fixture();
  f.service.releaseGitWorkspaces.assertPrimaryInvariant = async () => ({ projectRoot: f.root, headCommit: "unreviewed-main" });
  await assert.rejects(f.run, /reviewed local main changed/u);
  assert.equal(f.state.reads, 0);
});

for (const property of ["preReleaseHead", "tree", "manifestHash", "checkpointPhase"]) test(`preflight rejects ${property} movement during verification`, async () => {
  const f = fixture();
  f.service.resolveReleaseValidationSource = async () => {
    f.state.candidate[property] = "changed";
    return { kind: "workspace-release-pipeline", projectRoot: f.root };
  };
  await assert.rejects(f.run, /candidate changed during preflight/u);
});
