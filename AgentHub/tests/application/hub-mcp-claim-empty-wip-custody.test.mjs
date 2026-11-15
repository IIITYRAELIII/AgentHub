import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { createManagedTaskRun, TaskRunRegistry } from "../../src/domain/task-runs.mjs";
import { HubMcpServer } from "../../src/interfaces/mcp/hub-mcp-server.mjs";

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

async function ownClaimantFixture(t) {
  const f = await fixture(t);
  await f.tasks.claim({ id: f.prior.id, workspaceId: f.prior.workspaceId,
    streamId: f.successor.id, provider: "codex", threadId: `${f.successor.id}-thread`,
    turnId: "previous-claimant-turn", operationId: "prior-own-assignment", gitBaseline: f.source.gitBaseline });
  const prior = f.tasks.task(f.prior.id);
  f.prepare.claim_custody.expected_task_revision = prior.revision;
  f.prepare.claim_custody.expected_owner_stream_id = f.successor.id;
  f.hub.setActiveRuns(() => []);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  const current = createManagedTaskRun({ workspaceId: prior.workspaceId, streamId: f.successor.id,
    provider: "codex", threadId: `${f.successor.id}-thread`, turnId: "current-claimant-turn",
    projectRoot: f.source.projectRoot, status: "running" });
  return { ...f, prior, current };
}

test("same-owner custody resumes the SAME unknown successor through MCP with a full current run", { timeout: 60000 }, async t => {
  const f = await ownClaimantFixture(t);
  const server = new HubMcpServer({ service: f.hub, secret: "fixture-server", logger: { log() {}, error() {} } });
  await server.start();
  t.after(() => server.close());
  let rpcId = 0;
  const claim = async () => {
    const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call",
        params: { name: "hub_task_claim", arguments: f.consume } }) });
    assert.equal(response.status, 200);
    const rpc = await response.json();
    assert.equal(rpc.error, undefined);
    const receipt = rpc.result.structuredContent?.taskOperation;
    if (receipt) {
      // Current MCP acknowledges before execution; the source-baseline server
      // replies after it. Join the exact fixture-owned worker before readback.
      assert.equal(receipt.requestId, f.consume.request_id);
      assert.equal(typeof f.hub.joinSubmittedTaskOperation, "function");
      try { await f.hub.joinSubmittedTaskOperation(f.consume); } catch {}
    }
    return f.catalog.mcpOperation(f.consume.request_id);
  };
  const absent = await claim();
  assert.equal(absent.status, "unknown");
  assert.match(absent.error, /no exact active run/);
  const unknown = f.catalog.mcpOperation(f.consume.request_id);
  assert.equal(unknown.status, "unknown");
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  const runs = new TaskRunRegistry([f.current]);
  f.hub.setActiveRuns(() => runs.values());
  const reply = await claim();
  assert.equal(reply.status, "succeeded");
  const result = reply.result;
  assert.equal(result.claimedTurnId, f.current.turnId);
  assert.equal(result.streamId, f.current.streamId);
  assert.equal(result.revision, f.prior.revision + 1);
  assert.equal(result.claimCustody.dependencyPreparation, "not-replayed");
  const completed = f.catalog.mcpOperation(f.consume.request_id);
  assert.equal(completed.requestId, unknown.requestId);
  assert.equal(completed.argumentsHash, unknown.argumentsHash);
  assert.equal(completed.createdAtMs, unknown.createdAtMs);
  assert.equal(completed.status, "succeeded");
  assert.equal(f.prepares(), 0);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  const reopened = await f.open();
  const hub = f.service(reopened);
  hub.setActiveRuns(() => runs.values());
  assert.deepEqual(result.operatorReconciliation, { kind: "forward-claim-binding-reuse-v1", fenceRequestId: "custody-fence" });
  assert.deepEqual(await hub.call("hub_task_claim", f.consume), result);
  assert.equal(reopened.tasks.task(f.prior.id).revision, result.revision);
  assert.deepEqual(reopened.catalog.mcpOperation(f.original.requestId), f.original);
});

test("same-owner custody refuses incomplete, foreign, ambiguous, second and queued work", { timeout: 60000 }, async t => {
  const f = await ownClaimantFixture(t);
  for (const change of [{ id: "" }, { workspaceId: "foreign" }, { streamId: "foreign" },
    { provider: "claude" }, { threadId: "old-thread" }, { turnId: "" }, { observer: true }]) {
    const invalid = { ...f.current, ...change };
    f.hub.setActiveRuns(() => [invalid]);
    await assert.rejects(f.hub.call("hub_task_claim", f.consume), /complete exact run identity|no exact active run/);
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  }
  for (const other of [{ ...f.current, id: "ambiguous", turnId: "second-turn" },
    { ...f.current, id: "foreign-run", provider: "claude", threadId: "other-thread", turnId: "other-turn" }]) {
    f.hub.setActiveRuns(() => [f.current, other]);
    await assert.rejects(f.hub.call("hub_task_claim", f.consume), /ambiguous active runs|Previous executor became active/);
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  }
  f.hub.setActiveRuns(() => [f.current]);
  for (const input of [{ streamId: f.successor.id }, { provider: "codex", threadId: f.current.threadId }]) {
    f.hub.setDeferredInputs(() => [input]);
    await assert.rejects(f.hub.call("hub_task_claim", f.consume), /Previous executor became active/);
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  }
  f.hub.setDeferredInputs(() => []);
  const result = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(result.revision, f.prior.revision + 1);
  assert.equal(result.claimedTurnId, f.current.turnId);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

for (const change of ["replacement", "same-object-turn", "queued"]) {
  test(`same-owner custody rechecks ${change} at the SQL assignment boundary`, { timeout: 60000 }, async t => {
    const f = await ownClaimantFixture(t);
    let current = f.current;
    f.hub.setActiveRuns(() => [current]);
    const claim = f.tasks.claim.bind(f.tasks);
    let once = true;
    f.tasks.claim = args => {
      if (once && args.forwardCustodyRequestId) {
        once = false;
        if (change === "replacement") current = { ...current, id: "new-run", turnId: "new-turn" };
        else if (change === "same-object-turn") current.turnId = "new-turn";
        else f.hub.setDeferredInputs(() => [{ streamId: current.streamId }]);
      }
      return claim(args);
    };
    await assert.rejects(f.hub.call("hub_task_claim", f.consume), /claimant run changed|Previous executor became active/);
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
    assert.equal(f.tasks.claimBindingForOperation(f.consume.request_id), null);
    f.hub.setDeferredInputs(() => []);
    const result = await f.hub.call("hub_task_claim", f.consume);
    assert.equal(result.claimedTurnId, current.turnId);
    assert.equal(result.revision, f.prior.revision + 1);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
    assert.equal(f.prepares(), 0);
  });
}

test("same-owner custody recovers the committed binding after event loss without another revision", { timeout: 60000 }, async t => {
  const f = await ownClaimantFixture(t);
  f.hub.setActiveRuns(() => [f.current]);
  const event = f.tasks.recordEvent;
  f.tasks.recordEvent = async () => { throw Error("lost custody assignment event"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.consume), /lost custody assignment event/);
  const assigned = f.tasks.task(f.prior.id);
  assert.equal(assigned.revision, f.prior.revision + 1);
  const bound = f.tasks.claimBindingForOperation(f.consume.request_id);
  assert.equal(bound.turnId, f.current.turnId);
  f.tasks.recordEvent = event;
  const reopened = await f.open();
  const hub = f.service(reopened);
  const next = { ...f.current, id: "reopened-run", turnId: "reopened-turn" };
  hub.setActiveRuns(() => [next]);
  const result = await hub.call("hub_task_claim", f.consume);
  assert.equal(result.claimedTurnId, bound.turnId);
  assert.equal(result.revision, assigned.revision);
  assert.deepEqual(reopened.tasks.claimBindingForOperation(f.consume.request_id), bound);
  assert.deepEqual(reopened.catalog.mcpOperation(f.original.requestId), f.original);
  assert.equal(f.prepares(), 0);
});
