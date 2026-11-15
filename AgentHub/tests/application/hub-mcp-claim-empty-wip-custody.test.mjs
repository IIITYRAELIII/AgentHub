import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";

async function fixture(t) {
  const f = await claimCustodyFixture(t, { emptyWip: true });
  f.prepare.claim_custody.admission = "isolated-source-v1";
  f.runtime.capture = () => assert.fail("Empty WIP cannot invent legacy retirement");
  f.runtime.assertRetired = f.runtime.capture;
  return f;
}

test("public empty-WIP managed custody preserves UNKNOWN and partial aliases for the exact successor", { timeout: 90000 }, async t => {
  let legacy;
  t.after(() => legacy?.close());
  const f = await fixture(t);
  // A partial dependency alias belongs to the preserved OLD ensure. It is not
  // WIP and must neither be followed/copied nor relabelled ready by recovery.
  const dependency = path.join(f.root, "partial-dependency");
  await mkdir(dependency);
  const partial = '{"status":"attaching","owner":"legacy-claim"}\n';
  await writeFile(path.join(dependency, "partial.json"), partial);
  const exclude = await f.git(f.source.projectRoot, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  await writeFile(exclude, "node_modules/\n");
  await symlink(dependency, path.join(f.source.projectRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  legacy = new DatabaseSync(path.join(f.root, "hub.sqlite"));
  const late = legacy.prepare("UPDATE hub_board_tasks SET stream_id='foreign' WHERE id=?");
  const settle = legacy.prepare("UPDATE hub_mcp_operations SET receipt_state='failed' WHERE request_id=?");
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  assert.throws(() => late.run(f.prior.id), /namespace authority/);
  assert.throws(() => settle.run(f.original.requestId), /Custody identity/);
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.consume, context_token: f.managerToken }), /Successor claim differs|another operation/);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  const result = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(result.streamId, f.successor.id);
  assert.equal(result.revision, f.prior.revision + 1);
  assert.equal(result.claimCustody.dependencyPreparation, "not-replayed");
  assert.equal(f.prepares(), 0);
  const root = result.gitWorkspace.projectRoot;
  assert.notEqual(root, f.source.projectRoot);
  assert.equal(await f.git(root, "rev-parse", "HEAD"), f.source.headCommit);
  assert.equal(await f.git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  for (const relative of ["WIP", "AgentHub/WIP", "node_modules", ".git/objects/info/alternates"]) {
    await assert.rejects(access(path.join(root, relative)), { code: "ENOENT" });
  }
  assert.equal(await readFile(path.join(f.source.projectRoot, "node_modules/partial.json"), "utf8"), partial);
  // The old source can still receive late work, but cannot reach the successor.
  await mkdir(path.join(f.source.projectRoot, "WIP"));
  await writeFile(path.join(f.source.projectRoot, "WIP/late.txt"), "late original evidence\n");
  assert.deepEqual(await f.hub.call("hub_task_claim", f.consume), JSON.parse(JSON.stringify(result)));
  const reopened = await f.open();
  assert.deepEqual(reopened.catalog.mcpOperation(f.original.requestId), f.original);
  assert.equal(reopened.tasks.task(f.prior.id).streamId, f.successor.id);
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "accepted source\n");
});

for (const variant of ["missing", "root-WIP", "nested-WIP", "mixed-case-Wip", "foreign-link", "dirty", "foreign", "CAS", "outcome"]) {
  test(`public empty-WIP prepare refuses ${variant} without transferring or changing original`, { timeout: 60000 }, async t => {
    const f = await fixture(t);
    const input = structuredClone(f.prepare);
    if (variant === "missing") delete input.claim_custody.source.wipPaths;
    if (variant === "root-WIP" || variant === "nested-WIP") {
      const directory = path.join(f.source.projectRoot, variant === "root-WIP" ? "WIP" : "AgentHub/WIP");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "unique.txt"), "must preserve\n");
    }
    if (variant === "mixed-case-Wip") await mkdir(path.join(f.source.projectRoot, "Wip"));
    if (variant === "foreign-link") {
      const external = path.join(f.root, "foreign");
      await mkdir(path.join(external, "WIP"), { recursive: true });
      await writeFile(await f.git(f.source.projectRoot, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"), "borrowed/\n");
      await symlink(external, path.join(f.source.projectRoot, "borrowed"), process.platform === "win32" ? "junction" : "dir");
    }
    if (variant === "dirty") await writeFile(path.join(f.source.projectRoot, "source.txt"), "unsaved source\n");
    if (variant === "foreign") input.claim_custody.expected_original.threadId += "-foreign";
    if (variant === "CAS") input.claim_custody.expected_task_revision += 1;
    if (variant === "outcome") await f.catalog.completeUnknownMcpOperation(f.original.requestId, {
      workspaceId: f.original.workspaceId, toolName: f.original.toolName,
      result: { accepted: true }, reconciliation: { source: "disposable authoritative outcome control" },
    });
    const original = f.catalog.mcpOperation(f.original.requestId);
    await assert.rejects(f.hub.call("hub_task_operation_reconcile", input));
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), original);
    assert.equal(f.catalog.claimCustodyNamespaceForTask(f.prior.id), null);
    assert.equal(f.prepares(), 0);
  });
}

for (const boundary of ["before-stage", "after-stage", "before-successor"]) {
  test(`public empty-WIP custody refuses late WIP ${boundary}`, { timeout: 90000 }, async t => {
    const f = await fixture(t);
    const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
    let target = f.source.projectRoot;
    if (boundary === "after-stage") {
      const stage = f.workspaces.stageIndependentClaimNamespaceOwned.bind(f.workspaces);
      f.workspaces.stageIndependentClaimNamespaceOwned = async args => {
        const result = await stage(args);
        await mkdir(path.join(target, "WIP"));
        return result;
      };
    } else if (boundary === "before-successor") {
      await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
      target = f.catalog.claimCustodyNamespaceForTask(f.prior.id).namespace.root;
      await mkdir(path.join(target, "WIP"));
      await assert.rejects(f.hub.call("hub_task_claim", f.consume), /WIP|snapshot/);
    } else await mkdir(path.join(target, "WIP"));
    if (boundary !== "before-successor") {
      await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /WIP/);
      assert.equal(f.catalog.claimCustodyNamespaceForTask(f.prior.id), null);
    }
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
    assert.equal(f.prepares(), 0);
  });
}
