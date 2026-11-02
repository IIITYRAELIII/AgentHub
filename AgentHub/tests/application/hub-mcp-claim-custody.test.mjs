import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TaskClaimCustodyRejectedError } from "../../src/domain/claim-forward-custody.mjs";
import { DatabaseSync } from "node:sqlite";
import { cloneJournalToTestContour } from "../../src/infrastructure/persistence/test-contour-data-clone.mjs";
import { claimCustodyFixture as fixture } from "../fixtures/claim-custody-public-fixture.mjs";

test("forward custody preserves legacy UNKNOWN and source while assigning through one ordinary claim", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  assert.equal(plan.kind, "claim-custody-plan");
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  f.retire();
  const fenced = await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  assert.equal(fenced.kind, "claim-custody-fence");
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  const claimed = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(claimed.streamId, f.successor.id);
  assert.equal(claimed.gitWorkspace.headCommit, f.source.headCommit);
  assert.equal(f.prepares(), 0);
  assert.equal(await readFile(path.join(f.source.projectRoot, "WIP/useful.txt"), "utf8"), "unfinished evidence\n");
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  const again = await f.hub.call("hub_task_claim", f.consume);
  assert.deepEqual(again, JSON.parse(JSON.stringify(claimed))); assert.equal(f.prepares(), 0);
});

async function fenced(f) {
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  f.retire(); await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  return plan;
}

test("fence refuses live legacy cohort; neither UNKNOWN nor Task is rewritten", async t => {
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /still alive/);
  assert.equal(f.catalog.claimCustodyForOriginal(f.original.requestId), null);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
});

test("late original after fence cannot enter prepare, update baseline, or settle its UNKNOWN", async t => {
  const f = await fixture(t); await fenced(f);
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.originalArgs, context_token: f.successorToken }), /future continuation was withdrawn/);
  await assert.rejects(f.tasks.claim({ id: f.prior.id, workspaceId: f.original.workspaceId, streamId: f.successor.id,
    provider: f.original.provider, threadId: f.original.threadId, turnId: "late-original", operationId: f.original.requestId,
    gitBaseline: f.source.gitBaseline }), /future continuation was withdrawn/);
  await assert.rejects(f.catalog.markMcpOperationUnknown(f.original.requestId, new Error("late")), /future continuation was withdrawn/);
  await assert.rejects(f.catalog.failUnknownMcpOperation(f.original.requestId, { workspaceId: f.original.workspaceId,
    toolName: "hub_task_claim", error: new Error("fake NO_EFFECT"), reconciliation: {} }), /future continuation was withdrawn/);
  assert.equal(f.prepares(), 0);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("two exact recovery intents have one durable winner and one assignment", async t => {
  const f = await fixture(t);
  const second = structuredClone(f.prepare); second.request_id = "custody-plan-second";
  second.claim_custody.successor_claim_request_id = "custody-successor-second";
  const firstPlan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  const secondPlan = await f.hub.call("hub_task_operation_reconcile", second);
  f.retire();
  const secondFence = { ...f.fence(secondPlan), request_id: "custody-fence-second",
    claim_custody: { action: "fence", plan_request_id: second.request_id, expected_plan_hash: secondPlan.planHash } };
  const outcomes = await Promise.allSettled([
    f.hub.call("hub_task_operation_reconcile", f.fence(firstPlan)),
    f.hub.call("hub_task_operation_reconcile", secondFence),
  ]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(x => x.status === "rejected").length, 1);
  const winner = outcomes.find(x => x.status === "fulfilled").value;
  const claimed = await f.hub.call("hub_task_claim", { ...f.consume,
    request_id: winner.successorClaimRequestId, forward_custody_request_id: winner.requestId });
  assert.equal(claimed.revision, f.prior.revision + 1); assert.equal(f.prepares(), 0);
});

for (const field of ["taskRevision", "caller", "hash", "source", "wip", "foreignRM"]) {
  test(`custody refuses stale ${field} pins without assignment`, async t => {
    const f = await fixture(t); const input = structuredClone(f.prepare);
    if (field === "taskRevision") input.claim_custody.expected_task_revision += 1;
    if (field === "caller") input.claim_custody.expected_original.threadId += "-foreign";
    if (field === "hash") input.claim_custody.expected_original.argumentsHash = "f".repeat(64);
    if (field === "source") input.claim_custody.source.headCommit = "f".repeat(40);
    if (field === "wip") await writeFile(path.join(f.source.projectRoot, "WIP/useful.txt"), "new evidence");
    if (field === "foreignRM") input.context_token = f.successorToken;
    await assert.rejects(f.hub.call("hub_task_operation_reconcile", input));
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
    assert.equal(f.prepares(), 0);
  });
}

test("an admitted original before fence is preserved and cannot be ignored by recovery", async t => {
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.tasks.claim({ id: f.prior.id, workspaceId: f.original.workspaceId, streamId: f.successor.id,
    provider: f.original.provider, threadId: f.original.threadId, turnId: "late-before-fence", operationId: f.original.requestId });
  const admitted = f.tasks.task(f.prior.id); f.retire();
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /revision changed/);
  assert.deepEqual(f.tasks.task(f.prior.id), admitted);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("busy owner guard remains active for forward consume; same identity can reopen when idle", async t => {
  const f = await fixture(t); await fenced(f); f.busy();
  await assert.rejects(f.hub.call("hub_task_claim", f.consume), /Previous executor became active/);
  assert.equal(f.catalog.mcpOperation(f.consume.request_id).status, "unknown");
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  f.idle(); const result = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(result.streamId, f.successor.id); assert.equal(f.prepares(), 0);
});

test("crash after writer commit before task.claimed event reopens exact binding without prepare or assignment", async t => {
  const f = await fixture(t); await fenced(f);
  f.tasks.recordEvent = async event => { if (event.type === "task.claimed") throw new Error("crash after claim commit before event/outer receipt"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.consume), /crash after claim commit/);
  const committed = f.tasks.task(f.prior.id);
  assert.equal(committed.streamId, f.successor.id);
  assert.equal(f.catalog.mcpOperation(f.consume.request_id).status, "unknown");
  const stores = await f.open(); const hub = f.service(stores);
  const token = hub.contextToken({ provider: "codex", threadId: f.original.threadId });
  const recovered = await hub.call("hub_task_claim", { ...f.consume, context_token: token });
  assert.equal(recovered.claimedTurnId, `${f.successor.id}-turn`);
  assert.equal(recovered.revision, committed.revision);
  assert.equal(f.prepares(), 0);
  assert.deepEqual(stores.catalog.mcpOperation(f.original.requestId), f.original);
  assert.equal(stores.catalog.mcpOperation(f.consume.request_id).status, "succeeded");
  assert.deepEqual(stores.tasks.task(f.prior.id), committed);
});

test("durable plan and fence survive lost replies, reopen, and startup without settling the historical original", async t => {
  const f = await fixture(t);
  const save = f.rawCatalog.checkpointClaimCustody.bind(f.rawCatalog);
  f.rawCatalog.checkpointClaimCustody = state => { save(state); throw new Error("lost stage reply after commit"); };
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  f.retire(); const fence = await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  const reopened = await f.open(); const hub = f.service(reopened, true);
  const token = hub.contextToken({ provider: "codex", threadId: f.original.threadId });
  const result = await hub.call("hub_task_claim", { ...f.consume, context_token: token });
  assert.equal(result.streamId, f.successor.id); assert.equal(f.prepares(), 0);
  assert.equal(reopened.catalog.claimCustodyForOriginal(f.original.requestId).requestId, fence.requestId);
  assert.deepEqual(reopened.catalog.mcpOperation(f.original.requestId), f.original);
});

for (const boundary of ["before-plan", "before-fence", "after-receipt"]) {
  test(`exact retry after crash ${boundary} commits only one custody assignment`, async t => {
    const f = await fixture(t);
    const save = f.rawCatalog.checkpointClaimCustody.bind(f.rawCatalog);
    let fault = true;
    f.rawCatalog.checkpointClaimCustody = state => {
      if (fault && ((boundary === "before-plan" && state.phase === "planned")
          || (boundary === "before-fence" && state.phase === "fenced"))) {
        fault = false; throw new Error(`crash ${boundary} commit`);
      }
      return save(state);
    };
    if (boundary === "before-plan") await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.prepare), /crash/);
    const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
    f.retire();
    if (boundary === "before-fence") await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /crash/);
    await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
    if (boundary === "after-receipt") {
      const complete = f.rawCatalog.completeMcpOperation.bind(f.rawCatalog);
      f.rawCatalog.completeMcpOperation = (...args) => { const result = complete(...args); if (fault) { fault = false; throw new Error("lost reply after receipt commit"); } return result; };
      await assert.rejects(f.hub.call("hub_task_claim", f.consume), /effect completed/);
    }
    const result = await f.hub.call("hub_task_claim", f.consume);
    assert.equal(result.revision, f.prior.revision + 1);
    assert.equal(result.streamId, f.successor.id); assert.equal(f.prepares(), 0);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  });
}

test("queued former executor retains the general busy guard", async t => {
  const f = await fixture(t); await fenced(f);
  f.hub.setDeferredInputs(() => [{ provider: "codex", threadId: `${f.prior.streamId}-thread` }]);
  await assert.rejects(f.hub.call("hub_task_claim", f.consume), /Previous executor became active/);
  assert.equal(f.prepares(), 0); assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  f.hub.setDeferredInputs(() => []);
  const result = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(result.revision, f.prior.revision + 1);
});

test("stale Task after fencing cannot be silently rebound to a new CAS", async t => {
  const f = await fixture(t); await fenced(f);
  await f.tasks.update({ id: f.prior.id, title: f.prior.title, description: "new independent metadata" });
  const current = f.tasks.task(f.prior.id);
  await assert.rejects(f.hub.call("hub_task_claim", f.consume), /revision changed/);
  assert.deepEqual(f.tasks.task(f.prior.id), current); assert.equal(f.prepares(), 0);
});

test("same recovery ID with changed business args and foreign successor cannot consume authority", async t => {
  const f = await fixture(t); await fenced(f);
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.consume, context_token: f.managerToken }), /Successor claim differs/);
  const originalSuccessor = f.catalog.mcpOperation(f.consume.request_id);
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.consume, dependency_mode: "skip" }),
    { code: "TASK_CLAIM_CUSTODY_REJECTED" });
  assert.deepEqual(f.catalog.mcpOperation(f.consume.request_id), originalSuccessor);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior); assert.equal(f.prepares(), 0);
});


test("read-only RM preparation can run independently, but assignment rechecks the general busy guard at SQL commit", async t => {
  const f = await fixture(t); f.busy();
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  assert.deepEqual(f.tasks.task(f.prior.id),f.prior);
  f.retire(); await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  f.idle();
  const claim = f.rawTasks.claim.bind(f.rawTasks);
  f.rawTasks.claim = (...args) => { f.busy(); return claim(...args); };
  await assert.rejects(f.hub.call("hub_task_claim", f.consume), /before custody assignment commit/);
  assert.deepEqual(f.tasks.task(f.prior.id),f.prior);
  assert.equal(f.prepares(),0);
  f.rawTasks.claim = claim; f.idle();
  const result = await f.hub.call("hub_task_claim",f.consume);
  assert.equal(result.revision,f.prior.revision+1);
});

test("retirement committed with the fence remains valid after collector exit and process reopen", async t => {
  const f = await fixture(t); await fenced(f);
  f.runtime.assertRetired = async () => { throw new Error("collector exited after committed fence"); };
  const stores = await f.open();const hub = f.service(stores);
  const token = hub.contextToken({provider:"codex",threadId:f.original.threadId});
  const result = await hub.call("hub_task_claim",{...f.consume,context_token:token});
  assert.equal(result.streamId,f.successor.id);assert.equal(f.prepares(),0);
  assert.equal(result.claimCustody.dependencyPreparation,"not-replayed");
});


test("isolated contour clone preserves withdrawn UNKNOWN and custody without triggering a historical receipt mutation", async t => {
  const f = await fixture(t); await fenced(f);
  const destination = path.join(f.root,"isolated-contour","journal.sqlite");
  await cloneJournalToTestContour({ sourceDatabaseFile:path.join(f.root,"hub.sqlite"), destinationDatabaseFile:destination,
    projectRoot:path.join(f.root,"contour-project"), detachedGitRoot:path.join(f.root,"contour-detached"), model:"fixture" });
  const db = new DatabaseSync(destination,{readOnly:true});
  try {
    const row = db.prepare("SELECT receipt_state,result_json,error_text FROM hub_mcp_operations WHERE request_id = ?").get(f.original.requestId);
    assert.equal(row.receipt_state,"unknown");assert.equal(row.result_json,null);assert.equal(row.error_text,f.original.error);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId),f.original);
  } finally {db.close();}
});


test("a typed custody error after assignment cannot receive a pre-effect FAILED result", async t => {
  const f=await fixture(t);await fenced(f);
  f.tasks.recordEvent=async event=>{if(event.type==="task.claimed")throw new TaskClaimCustodyRejectedError("typed error AFTER assignment");};
  await assert.rejects(f.hub.call("hub_task_claim",f.consume),/AFTER assignment/);
  assert.equal(f.catalog.mcpOperation(f.consume.request_id).status,"unknown");
  assert.equal(f.tasks.task(f.prior.id).streamId,f.successor.id);
  const result=await f.hub.call("hub_task_claim",f.consume);
  assert.equal(result.revision,f.prior.revision+1);assert.equal(f.prepares(),0);
});
