import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { claimCustodyFixture } from "../../fixtures/claim-custody-public-fixture.mjs";

test("existing CLI forwards authenticated cancellation and returns exact stopped readback without touching original history", async t => {
  const f = await claimCustodyFixture(t, { databaseName: "journal.sqlite" });
  f.retire();
  const input = { request_id: "first-explicit-cancel", task_id: f.prior.id,
    operation_request_id: f.original.requestId, original_arguments: f.originalArgs,
    expected_arguments_hash: f.original.argumentsHash, expected_task_revision: f.prior.revision,
    confirm_cancel: true };
  assert.equal((await f.hub.call("hub_task_operation_cancel", { ...input, context_token: f.managerToken })).phase, "stopped");
  const original = f.catalog.mcpOperation(f.original.requestId);
  const config = path.join(f.root, "config.json"), argsFile = path.join(f.root, "cancel.json");
  await writeFile(config, JSON.stringify({ projectRoot: f.source.repositoryRoot, dataDir: f.root,
    components: { telegram: false } }));
  await writeFile(argsFile, JSON.stringify({ ...input, request_id: "cli-stopped-readback" }));
  const run = (thread = `${f.manager.id}-thread`, stream = f.manager.id) => promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../../../task-operation-reconcile.mjs", import.meta.url)),
    "--cancel-arguments", argsFile, "--provider", "codex", "--thread", thread, "--stream", stream,
  ], { env: { ...process.env, AGENT_HUB_CONFIG: config }, windowsHide: true, encoding: "utf8" });
  const result = await run();
  assert.equal(result.stderr, ""); assert.equal(JSON.parse(result.stdout).phase, "stopped");
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), original);
  await writeFile(argsFile, JSON.stringify({ ...input, request_id: "cli-foreign-cancel" }));
  await assert.rejects(run(`${f.prior.streamId}-thread`, f.prior.streamId), /identity or authority/);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), original);
});
