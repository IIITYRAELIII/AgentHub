import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { claimCustodyFixture } from "../../fixtures/claim-custody-public-fixture.mjs";

test("existing CLI reads pending, UNKNOWN and terminal originals without executing or changing them", async t => {
  const f = await claimCustodyFixture(t, { databaseName: "journal.sqlite" });
  const config = path.join(f.root, "config.json"), argsFile = path.join(f.root, "read.json");
  await writeFile(config, JSON.stringify({ projectRoot: f.source.repositoryRoot, dataDir: f.root, components: { telegram: false } }));
  const run = (thread = `${f.manager.id}-thread`, stream = f.manager.id) => promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../../../task-operation-reconcile.mjs", import.meta.url)),
    "--read-arguments", argsFile, "--provider", "codex", "--thread", thread, "--stream", stream,
  ], { env: { ...process.env, AGENT_HUB_CONFIG: config }, windowsHide: true, encoding: "utf8" });
  const original = f.catalog.mcpOperation(f.original.requestId);
  await writeFile(argsFile, JSON.stringify({ operation_request_id: original.requestId, expected_arguments_hash: original.argumentsHash }));
  const unknown = await run(); assert.equal(unknown.stderr, "");
  assert.equal(JSON.parse(unknown.stdout).taskOperation.status, "unknown");
  assert.deepEqual(f.catalog.mcpOperation(original.requestId), original);
  await assert.rejects(run(`${f.prior.streamId}-thread`, f.prior.streamId), /identity or authority/);
  const args = { context_token: f.successorToken, request_id: "cli-readable-claim", task_id: f.prior.id, dependency_mode: "skip" };
  let release; const held = new Promise(resolve => { release = resolve; });
  const prepare = f.workspaces.prepareOwned.bind(f.workspaces);
  f.workspaces.prepareOwned = async (...values) => { await held; return prepare(...values); };
  const admission = await f.hub.submitTaskOperation("hub_task_claim", args);
  try {
    await writeFile(argsFile, JSON.stringify({ operation_request_id: args.request_id, expected_arguments_hash: admission.taskOperation.argumentsHash }));
    const pending = f.catalog.mcpOperation(args.request_id), read = JSON.parse((await run()).stdout);
    assert.equal(read.taskOperation.status, "pending"); assert.equal(read.taskOperation.active, false);
    assert.deepEqual(f.catalog.mcpOperation(args.request_id), pending);
  } finally { release(); }
  await f.hub.call("hub_task_claim", args);
  const terminal = f.catalog.mcpOperation(args.request_id), read = JSON.parse((await run()).stdout);
  assert.equal(read.taskOperation.status, "succeeded"); assert.equal(read.result.id, f.prior.id);
  assert.deepEqual(f.catalog.mcpOperation(args.request_id), terminal);
});
