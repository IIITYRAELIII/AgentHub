import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { publishChanged, runReleaseOperationCli } from "../../publish-changed.mjs";
import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";
import { createReleaseOperation } from "../../src/domain/release-operation.mjs";

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
      read: async (file) => file.endsWith("CHANGELOG.md")
        ? Buffer.from("release notes\r\n", "utf8")
        : JSON.stringify(file.endsWith("checkpoint.json") ? checkpoint : manifest),
      wait: async () => {},
      pollMs: 1,
    },
  };
}

test("publish:changed delegates one deterministic full release to ReleaseOperation", async () => {
  const f = fixture();
  const first = await runReleaseOperationCli([
    "--from", f.manifest.baseCommit, "--workspace", f.manifest.workspaceId,
    "--stream", "stream-1", "--thread", "thread-1", "--full-tests",
  ], f.options);
  assert.equal(first.operation.state, "done");
  assert.deepEqual(f.calls.map((call) => call.action), [
    "release-operation-run", "release-operation-get",
  ]);
  const admission = f.calls[0];
  assert.deepEqual(admission.params.taskIds, ["task-a", "task-b"]);
  assert.equal(admission.params.validationMode, "full");
  assert.equal(admission.params.streamId, "stream-1");
  assert.equal(admission.params.threadId, "thread-1");
  assert.equal(admission.params.releaseMetadata.sourcePath, path.join(f.repositoryRoot, "CHANGELOG.md"));
  assert.equal(admission.params.releaseMetadata.byteLength, Buffer.byteLength("release notes\r\n"));
  assert.notEqual(admission.params.releaseMetadata.rawSha256, admission.params.releaseMetadata.canonicalSha256);
  assert.equal(admission.params.approvedTargets[0].repositoryRoot, f.primaryRoot);
  assert.equal(admission.params.approvedTargets[0].approvedLocalMainCommit,
    f.manifest.baseProvenance.approvedLocalMainCommit);
  assert.equal(admission.options.commandId, admission.params.requestId);

  const requestId = admission.params.requestId;
  f.calls.length = 0;
  await runReleaseOperationCli(["--resume", "--from", f.manifest.baseCommit, "--workspace", f.manifest.workspaceId,
    "--stream", "stream-1", "--thread", "thread-1", "--full-tests"], f.options);
  assert.equal(f.calls[0].params.requestId, requestId);
  assert.equal(f.calls[0].options.commandId, requestId);
});

test("public CLI admits repository-scale release metadata through the command owner and domain", async () => {
  const f = fixture();
  const releaseNotes = Buffer.alloc(1_981_700, 0x61);
  let admitted = null;
  const commands = new ReleaseOperationCommandService({
    releaseOperations: {
      start: (input) => {
        admitted = createReleaseOperation({
          ...input,
          operationId: "operation-large-metadata",
          runnerVersion: "test-runner",
          createdAt: "2026-09-23T00:00:00.000Z",
        });
        return { accepted: true, operationId: admitted.operationId, state: admitted.state, revision: admitted.revision };
      },
      get: () => ({ operation: { ...admitted, state: "done", revision: 2 } }),
      continue: () => ({ accepted: true }),
    },
    workspaceCatalog: {
      workspace: () => ({ id: f.manifest.workspaceId }),
      hierarchy: () => [{
        id: f.manifest.workspaceId,
        streams: [{ id: "stream-1", threads: [{ threadId: "thread-1" }] }],
      }],
    },
    taskBoard: {
      task: (taskId) => ({ id: taskId, workspaceId: f.manifest.workspaceId }),
    },
  });
  const control = async (action, params) => {
    if (action === "release-operation-run") return commands.start(params);
    return commands.get(params);
  };
  await runReleaseOperationCli([
    "--from", f.manifest.baseCommit, "--workspace", f.manifest.workspaceId,
    "--stream", "stream-1", "--thread", "thread-1", "--full-tests",
  ], {
    ...f.options,
    control,
    read: async (file) => file.endsWith("CHANGELOG.md")
      ? releaseNotes
      : JSON.stringify(file.endsWith("checkpoint.json") ? f.checkpoint : f.manifest),
  });
  assert.equal(admitted.authorization.releaseMetadata.byteLength, releaseNotes.length);
  assert.equal(Buffer.byteLength(JSON.stringify(admitted.authorization), "utf8") < 1024 * 1024, true);
  assert.equal(admitted.streamId, "stream-1");
  assert.equal(admitted.threadId, "thread-1");
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
