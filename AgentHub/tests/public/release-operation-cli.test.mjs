import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { publishChanged, runReleaseOperationCli } from "../../publish-changed.mjs";

function fixture() {
  const repositoryRoot = path.resolve("C:/owned/release");
  const primaryRoot = path.resolve("C:/workspace/primary");
  const checkpoint = {
    manifestHash: "a".repeat(64),
  };
  const manifest = {
    workspaceId: "workspace-1",
    planRevision: "plan-1",
    baseCommit: "b".repeat(40),
    baseProvenance: {
      approvedLocalMainCommit: "c".repeat(40),
      approvedOriginMainCommit: "d".repeat(40),
    },
    tasks: [{ taskId: "task-b" }, { taskId: "task-a" }],
  };
  const calls = [];
  const control = async (action, params, options) => {
    calls.push({ action, params, options });
    if (action === "release-operation-run") {
      return { accepted: true, operationId: "operation-1", state: "compose", revision: 1 };
    }
    return { operation: { operationId: "operation-1", state: "done", revision: 8 } };
  };
  return {
    repositoryRoot,
    primaryRoot,
    checkpoint,
    manifest,
    calls,
    control,
    options: {
      repositoryRoot,
      runtimeRoot: path.resolve("C:/runtime"),
      control,
      assertClone: async () => ({ primaryRoot }),
      read: async (file) => JSON.stringify(file.endsWith("checkpoint.json") ? checkpoint : manifest),
      wait: async () => {},
      pollMs: 1,
    },
  };
}

test("publish:changed delegates one deterministic full release to ReleaseOperation", async () => {
  const f = fixture();
  const first = await runReleaseOperationCli([
    "--from", f.manifest.baseCommit, "--workspace", f.manifest.workspaceId, "--full-tests",
  ], f.options);
  assert.equal(first.operation.state, "done");
  assert.deepEqual(f.calls.map((call) => call.action), [
    "release-operation-run", "release-operation-get",
  ]);
  const admission = f.calls[0];
  assert.deepEqual(admission.params.taskIds, ["task-a", "task-b"]);
  assert.equal(admission.params.validationMode, "full");
  assert.equal(admission.params.approvedTargets[0].repositoryRoot, f.primaryRoot);
  assert.equal(admission.params.approvedTargets[0].approvedLocalMainCommit,
    f.manifest.baseProvenance.approvedLocalMainCommit);
  assert.equal(admission.options.commandId, admission.params.requestId);

  const requestId = admission.params.requestId;
  f.calls.length = 0;
  await runReleaseOperationCli(["--resume", "--from", f.manifest.baseCommit, "--workspace", f.manifest.workspaceId, "--full-tests"], f.options);
  assert.equal(f.calls[0].params.requestId, requestId);
  assert.equal(f.calls[0].options.commandId, requestId);
});

test("publish:changed rejects legacy side-effect overrides before operation admission", async () => {
  const f = fixture();
  await assert.rejects(
    runReleaseOperationCli(["--skip-restart"], f.options),
    /legacy publication overrides are not supported/u,
  );
  assert.equal(f.calls.length, 0);
});

test("stable publication engine resolves revision and diff from the explicit candidate root", async () => {
  const candidateRoot = path.resolve("C:/owned/release-generation");
  const observed = [];
  await publishChanged(["--from", "base", "--skip-restart"], {
    repositoryRoot: candidateRoot,
    exclusive: (operation) => operation(),
    readState: async () => null,
    writeState: async () => {},
    revision: async (options) => { observed.push(["revision", options.cwd]); return "head"; },
    diff: async (from, options) => {
      observed.push(["diff", from, options.cwd]);
      return ["AgentHub/task-catalog.mjs"];
    },
    run: async () => {},
    readRuntimeStatus: async () => ({ current: "release-new", running: true }),
    restart: async () => assert.fail("restart must be skipped"),
  });
  assert.deepEqual(observed, [
    ["revision", candidateRoot],
    ["diff", "base", candidateRoot],
  ]);
});
