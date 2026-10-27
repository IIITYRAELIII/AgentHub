import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";

async function fixture(t, options = {}) {
  const f = await claimCustodyFixture(t, { unassigned: true, ...options });
  f.prepare.claim_custody.admission = "isolated-source-v1";
  f.runtime.capture = () => assert.fail("Unassigned isolation must not invent a retirement witness");
  f.runtime.assertRetired = f.runtime.capture;
  return f;
}

test("public unassigned custody preserves UNKNOWN and admits one declared successor from an independent base", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.prior.streamId, null);
  await f.catalog.updateStreamSettings(f.manager.id, { ...f.manager.settings, workingDirectory: path.join(f.root, "manager-only-source") });
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  const claimed = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(claimed.streamId, f.successor.id);
  assert.equal(claimed.revision, f.prior.revision + 1);
  assert.equal(f.prepares(), 0);
  const root = claimed.gitWorkspace.projectRoot;
  assert.notEqual(root, f.source.projectRoot);
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "accepted source\n");
  await assert.rejects(access(path.join(root, ".git/objects/info/alternates")), { code: "ENOENT" });
  assert.equal(await f.git(root, "rev-parse", "HEAD"), f.source.headCommit);
  assert.equal(await f.git(root, "rev-list", "--count", "HEAD"), await f.git(f.source.repositoryRoot, "rev-list", "--count", f.source.headCommit));
  assert.deepEqual(await f.hub.call("hub_task_claim", f.consume), JSON.parse(JSON.stringify(claimed)));
  const reopened = await f.open();
  assert.equal(reopened.tasks.task(f.prior.id).streamId, f.successor.id);
  assert.deepEqual(reopened.catalog.mcpOperation(f.original.requestId), f.original);
});

test("a discovered clean unassigned managed source preserves its full WIP instead of substituting main", { timeout: 90000 }, async t => {
  const f = await fixture(t, { prepared: true });
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  const claimed = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(await readFile(path.join(claimed.gitWorkspace.projectRoot, "WIP/useful.txt"), "utf8"), "unfinished evidence\n");
  assert.equal(await readFile(path.join(f.source.projectRoot, "WIP/useful.txt"), "utf8"), "unfinished evidence\n");
  assert.equal(f.prepares(), 0);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("late old Git prepare and cleanup only reach the old deterministic namespace", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  const namespace = f.catalog.claimCustodyNamespaceForTask(f.prior.id).namespace;
  const old = new TaskGitWorkspaceService({ dataDir: f.workspaces.dataDir, recordTiming: () => {},
    prepareDependencies: () => assert.fail("No dependency ensure is authorized") });
  const oldWorkspace = await old.prepare({ taskId: f.prior.id, taskNumber: f.prior.taskNumber, projectRoot: f.source.repositoryRoot });
  assert.notEqual(oldWorkspace.projectRoot, namespace.workspace.projectRoot);
  await writeFile(path.join(oldWorkspace.projectRoot, "source.txt"), "late old checkout\n");
  await old.cleanup(f.prior.id, { allowDirty: true });
  await assert.rejects(access(oldWorkspace.projectRoot), { code: "ENOENT" });
  assert.equal(await readFile(path.join(namespace.workspace.projectRoot, "source.txt"), "utf8"), "accepted source\n");
  const claimed = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(claimed.gitWorkspace.projectRoot, namespace.workspace.projectRoot);
  assert.equal(f.prepares(), 0);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("old open cached SQL cannot assign, overwrite, delete, publish a result, or settle the unassigned original after fence", { timeout: 90000 }, async t => {
  let legacy;
  t.after(() => legacy?.close());
  const f = await fixture(t);
  legacy = new DatabaseSync(path.join(f.root, "hub.sqlite"));
  const writes = [
    legacy.prepare("UPDATE hub_board_tasks SET stream_id='late' WHERE id=?"),
    legacy.prepare("UPDATE hub_board_tasks SET workflow_status='testing' WHERE id=?"),
    legacy.prepare("DELETE FROM hub_board_tasks WHERE id=?"),
    legacy.prepare("INSERT OR REPLACE INTO hub_task_git_references VALUES (?, 'late-root', 'late-branch', 'late-result', 1)"),
  ];
  const receipt = legacy.prepare("UPDATE hub_mcp_operations SET receipt_state='failed', error_text='fake NO_EFFECT' WHERE request_id=?");
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  for (const write of writes) assert.throws(() => write.run(f.prior.id), /namespace authority/);
  assert.throws(() => receipt.run(f.original.requestId), /Custody identity cannot be replaced/);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  const claimed = await f.hub.call("hub_task_claim", f.consume);
  for (const write of writes) assert.throws(() => write.run(f.prior.id), /namespace authority/);
  assert.equal(claimed.streamId, f.successor.id);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("a pre-fence committed Task-linked mutation without a revision bump is preserved and refuses takeover", { timeout: 90000 }, async t => {
  let legacy;
  t.after(() => legacy?.close());
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  legacy = new DatabaseSync(path.join(f.root, "hub.sqlite"));
  legacy.prepare(`INSERT INTO hub_task_work_log
    (id, task_id, provider, provider_thread_id, turn_id, operation_id, project_root, summary, status, changed_files_json, created_at_ms)
    VALUES ('late-work', ?, 'codex', 'late-thread', 'late-turn', 'late-operation', ?, 'late preserved evidence', 'succeeded', '[]', 1)`)
    .run(f.prior.id, f.source.repositoryRoot);
  assert.equal(f.tasks.task(f.prior.id).revision, f.prior.revision);
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /Task state.*changed before fence/);
  assert.equal(f.catalog.claimCustodyForOriginal(f.original.requestId), null);
  assert.equal(legacy.prepare("SELECT summary FROM hub_task_work_log WHERE id='late-work'").get().summary, "late preserved evidence");
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

for (const effect of ["root", "ref"]) {
  test(`discovered pre-fence ${effect} is preserved rather than replaced with registered main`, { timeout: 90000 }, async t => {
    const f = await fixture(t);
    const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
    let file;
    if (effect === "root") {
      file = path.join(f.workspaces.taskWorktreesRoot, f.prior.id, "WIP", "unfinished.txt");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "late discovered useful source\n");
    } else await f.git(f.source.repositoryRoot, "update-ref", `refs/heads/${f.source.branch}`, f.source.headCommit);
    await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /Discovered prior Task source/);
    if (file) assert.equal(await readFile(file, "utf8"), "late discovered useful source\n");
    else assert.equal(await f.git(f.source.repositoryRoot, "rev-parse", f.source.branch), f.source.headCommit);
    assert.equal(f.catalog.claimCustodyForOriginal(f.original.requestId), null);
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  });
}

for (const boundary of ["before-plan", "before-fence", "init", "fetch", "snapshot", "lost-stage-reply", "after-assignment"]) {
  test(`unassigned exact retry/reopen after ${boundary} never repeats prepare or assignment`, { timeout: 90000 }, async t => {
    const f = await fixture(t);
    let fault = true;
    const save = f.rawCatalog.checkpointClaimCustody.bind(f.rawCatalog);
    f.rawCatalog.checkpointClaimCustody = state => {
      if (fault && (boundary === "before-plan" && state.phase === "planned" || boundary === "before-fence" && state.phase === "fenced")) {
        fault = false; throw Error(`crash ${boundary}`);
      }
      const result = save(state);
      if (boundary === "lost-stage-reply") throw Error("lost committed stage reply");
      return result;
    };
    const run = f.workspaces.runCommand;
    f.workspaces.runCommand = async (args, options) => {
      const result = await run(args, options);
      if (fault && args[0] === boundary && options.cwd.includes("task-custody")) {
        fault = false; throw Error(`crash ${boundary}`);
      }
      return result;
    };
    const stage = f.workspaces.stageIndependentClaimNamespaceOwned.bind(f.workspaces);
    f.workspaces.stageIndependentClaimNamespaceOwned = async args => {
      const result = await stage(args);
      if (fault && boundary === "snapshot") { fault = false; throw Error("crash snapshot"); }
      return result;
    };
    if (boundary === "before-plan") await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.prepare), /crash/);
    const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
    if (["before-fence", "init", "fetch", "snapshot"].includes(boundary)) {
      await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /crash/);
      assert.equal(f.catalog.claimCustodyForOriginal(f.original.requestId), null);
    }
    await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
    if (boundary === "after-assignment") {
      f.tasks.recordEvent = async () => { throw Error("crash after assignment before event/receipt"); };
      await assert.rejects(f.hub.call("hub_task_claim", f.consume), /crash after assignment/);
    }
    const stores = await f.open();
    const workspaces = new TaskGitWorkspaceService({ dataDir: f.workspaces.dataDir, recordTiming: () => {},
      readClaimCustodyNamespace: id => stores.catalog.claimCustodyNamespaceForTask(id),
      prepareDependencies: () => assert.fail("Reopen cannot prepare dependencies") });
    const hub = f.service(stores, true, workspaces);
    const consume = { ...f.consume, context_token: hub.contextToken({ provider: "codex", threadId: f.original.threadId }) };
    const claimed = await hub.call("hub_task_claim", consume);
    assert.equal(claimed.revision, f.prior.revision + 1);
    const repeated = await hub.call("hub_task_claim", consume);
    const { operatorReconciliation: reconciliation, ...repeatedClaim } = repeated;
    const { operatorReconciliation: priorReconciliation, ...firstClaim } = claimed;
    assert.deepEqual(repeatedClaim, JSON.parse(JSON.stringify(firstClaim)));
    if (boundary === "after-assignment") assert.equal(reconciliation.kind, "forward-claim-binding-reuse-v1");
    assert.equal(stores.tasks.task(f.prior.id).revision, f.prior.revision + 1);
    assert.deepEqual(stores.catalog.mcpOperation(f.original.requestId), f.original);
    assert.equal(f.prepares(), 0);
  });
}

test("two unassigned intents have one winner and foreign or historical claims cannot consume it", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const second = structuredClone(f.prepare);
  second.request_id = "second-plan";
  second.claim_custody.successor_claim_request_id = "second-successor";
  const firstPlan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  const secondPlan = await f.hub.call("hub_task_operation_reconcile", second);
  const outcomes = await Promise.allSettled([
    f.hub.call("hub_task_operation_reconcile", f.fence(firstPlan)),
    f.hub.call("hub_task_operation_reconcile", { ...f.fence(secondPlan), request_id: "second-fence",
      claim_custody: { action: "fence", plan_request_id: second.request_id, expected_plan_hash: secondPlan.planHash } }),
  ]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const winner = outcomes.find(r => r.status === "fulfilled").value;
  const consume = { ...f.consume, request_id: winner.successorClaimRequestId, forward_custody_request_id: winner.requestId };
  await assert.rejects(f.hub.call("hub_task_claim", { ...consume, context_token: f.managerToken }), /Successor claim differs/);
  assert.equal(f.catalog.mcpOperation(consume.request_id), null, "foreign intake cannot occupy the declared successor ID");
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.originalArgs, context_token: f.successorToken }), /future continuation was withdrawn/);
  // A null prior owner does not make an unrelated deferred input its executor.
  f.hub.setDeferredInputs(() => [{ streamId: null, provider: "codex", threadId: "unrelated" }]);
  const claimed = await f.hub.call("hub_task_claim", consume);
  assert.equal(claimed.revision, f.prior.revision + 1);
  assert.equal(f.prepares(), 0);
});

for (const pin of ["owner", "revision", "caller", "hash", "source", "branch", "base", "wip", "admission"]) {
  test(`unassigned custody refuses stale or incomplete ${pin} without refreshing pins`, { timeout: 90000 }, async t => {
    const f = await fixture(t);
    const input = structuredClone(f.prepare);
    const e = input.claim_custody;
    if (pin === "owner") delete e.expected_owner_stream_id;
    if (pin === "revision") e.expected_task_revision += 1;
    if (pin === "caller") e.expected_original.threadId += "-foreign";
    if (pin === "hash") e.expected_original.argumentsHash = "f".repeat(64);
    if (pin === "source") e.source.headCommit = "f".repeat(40);
    if (pin === "branch") e.source.branch = "foreign";
    if (pin === "base") e.source.baseCommit = "f".repeat(40);
    if (pin === "wip") e.source.wipPaths = ["WIP"];
    if (pin === "admission") delete e.admission;
    await assert.rejects(f.hub.call("hub_task_operation_reconcile", input));
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
    assert.equal(f.prepares(), 0);
  });
}
