import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { HubMcpServer } from "../../src/interfaces/mcp/hub-mcp-server.mjs";
import { readReleaseToolPackage } from "../../src/infrastructure/process/release-tool-package.mjs";
import { resolveTestSelection } from "../../src/domain/test-selection.mjs";
import { releaseIdentitySha256, failedFirstComposeRecovery } from "../../src/domain/release-operation.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const inventory = Array.from({ length: 852 }, (_, i) => `tests/selected-${i}.test.mjs`);
const selected = count => ({ mode: "include", ids: inventory.slice(0, count) });

// SQLite, public HTTP, external022 and SAME receipt are real. These unit cases
// control only prepared/Git custody ports; the real Git owner is covered in
// prepared-release-boundary.test.mjs. No production release is invoked.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "first-amendment-"));
  const databaseFile = path.join(root, "catalog.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const workspace = catalog.createWorkspace({ name: "First amendment", settings: { releaseWorkflowEnabled: true } });
  const manager = catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } });
  const foreign = catalog.createStream({ workspaceId: workspace.id, name: "other RM", settings: { releaseManager: true } });
  catalog.bindThread({ provider: "codex", threadId: "original-rm", streamId: manager.id });
  catalog.bindThread({ provider: "codex", threadId: "foreign-rm", streamId: foreign.id });
  const tasks = new TaskBoardStore({ databaseFile });
  const board = new TaskBoardService({ store: tasks, workspaceCatalog: catalog });
  const metadata = async (name, text) => {
    const sourcePath = path.join(root, name), bytes = Buffer.from(text);
    await writeFile(sourcePath, bytes);
    return { sourcePath, byteLength: bytes.length, rawSha256: sha(bytes), canonicalSha256: sha(bytes) };
  };
  const oldNotes = await metadata("original.md", "# original thirteen\n");
  const newNotes = await metadata("current.md", "# current sixteen\n");
  const ids = Array.from({ length: 16 }, (_, i) => `task-${String(i).padStart(2, "0")}`);
  const results = ids.map(taskId => ({ taskId, resultCommit: `${taskId}-result`, acceptanceRevision: 2 }));
  const store = new ReleaseOperationStore({ dataDir: root, idFactory: () => "first-original" });
  const scheduled = [], control = { occupied: false, changed: false, late: null, reads: 0 };
  const bindings = [{ kind: "uncaptured-first-generation-v1", operationId: "first-original", generation: 1,
    repositoryRoot: root, generationRoot: path.join(root, "generation-one"), identitySha256: "e".repeat(64),
    preparedSource: { commit: "current-sixteen", tree: "current-tree", manifestHash: "current-manifest" } }];
  const service = new ReleaseOperationService({ store, ownerId: "synthetic-owner", schedule: fn => scheduled.push(fn),
    processAlive: pid => pid === process.pid,
    compose: async () => { throw new Error("release checkpoint clone is not an exact clean PreRelease checkout for phase prepared"); },
    inspectFirstCompose: async () => bindings,
    withTaskSelection: async ({ taskIds, firstCompose, commit }) => {
      assert.deepEqual(taskIds, ids);
      const validate = async () => {
        control.reads++;
        if (control.occupied) throw new Error("generation namespace occupied, partial or archived");
        if (control.changed) throw new Error("prepared authority changed");
        assert.equal(sha(await readFile(newNotes.sourcePath)), newNotes.rawSha256);
        await control.late?.();
      };
      await validate();
      return commit(results, validate, firstCompose ? bindings : null);
    },
    recoverFirstCompose: async ({ operation, recovery, validateBeforeCommit }) => {
      assert.deepEqual(recovery.candidates, bindings);
      assert.deepEqual(operation.testSelectionAmendments.at(-1).taskIds, ids);
      await validateBeforeCommit();
      return { repositoryBases: [{ repositoryRoot: root, baseCommit: "agreed" }], selectedResults: results,
        authorizedTaskIds: ids, sourceFingerprint: "verified-current-sixteen",
        candidates: [{ repositoryRoot: root, releaseRoot: path.join(root, "candidate"), generationRoot: path.join(root, "generation-one"),
          commit: "current-sixteen", tree: "current-tree", manifestHash: "current-manifest", baseCommit: "agreed" }] };
    },
    resolveTestPlans: async (candidates, selection) => candidates.map(candidate => ({ repositoryRoot: candidate.repositoryRoot,
      plan: resolveTestSelection(selection, inventory) })),
    reservePublication: ({ reserve }) => reserve(),
    validate: async () => { throw Object.assign(new Error("isolated validation boundary"), { code: "RELEASE_VALIDATION_FAILED" }); },
    publishTarget: () => assert.fail("publication"), readTarget: () => assert.fail("no frozen generation exists for target readback"),
    finalize: () => assert.fail("finalization") });
  const start = service.start({ requestId: "original-thirteen", workspaceId: workspace.id, streamId: manager.id, threadId: "original-rm",
    authorization: { taskIds: ids.slice(0,13), taskScope: "all_await", testSelection: selected(316), releaseMetadata: oldNotes,
      validationMode: "full", approvedTargets: [{ targetId: "public", kind: "git", repositoryRoot: root }] } });
  scheduled.shift()(); const before = await service.drain(start.operationId);
  assert.ok(failedFirstComposeRecovery(before));
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskLifecycle: {},
    releaseOperations: service, releasePreflight: { preflight: () => assert.fail('unused legacy preflight') },
    releaseCompleter: { completeRelease: () => assert.fail('unused legacy complete') }, workLog: { threadTurns: () => [] },
    attachmentDirectory: path.join(root, "attachments"), secret: "synthetic-first-amendment", reconcilePendingOnStartup: false });
  const token = hub.contextToken({ provider: "codex", threadId: "original-rm" });
  const args = { request_id: "explicit-sixteen-351", operation_id: start.operationId, expected_revision: before.operation.revision,
    expected_generation: 0, task_ids: ids, task_scope: "all_await", test_selection: selected(351), release_metadata: newNotes };
  t.after(async () => { while(scheduled.length) scheduled.shift()(); await service.drain(start.operationId);
    tasks.close(); catalog.close(); store.close?.(); await rm(root, { recursive:true,force:true }); });
  return { root, catalog, store, service, hub, token, args, before, scheduled, control, ids, newNotes,
    manager, foreign, workspace,
    options: { requestId: args.request_id, expectedRevision: args.expected_revision, expectedGeneration: 0,
      taskIds: ids, taskScope: "all_await", testSelection: args.test_selection, releaseMetadata: newNotes } };
}

test("generation zero public external022 amendment keeps original 13 to 16, manual316 to351 and exact replay", async t => {
  const f = await fixture(t);
  const server = new HubMcpServer({ service: f.hub, secret: "first-amendment-http", logger: { log() {},error() {} } });
  await server.start(); t.after(() => server.close());
  const tool = await readReleaseToolPackage(); assert.equal(tool.version, "0.2.2");
  const { HubClient, executeRelease } = await tool.module("src/hub-client.mjs");
  const client = new HubClient({ url: server.url, contextToken: f.token });
  const reply = await executeRelease(client, "continue", f.args, { wait: false });
  assert.equal(reply.accepted, true, JSON.stringify(reply));
  const captured = f.store.get(f.args.operation_id);
  assert.equal(captured.currentGeneration, 0, "admission is not a freeze");
  assert.deepEqual(captured.authorization, f.before.operation.authorization);
  const amended = captured.testSelectionAmendments[0];
  assert.equal(amended.firstComposeRecovery.priorGeneration, 0);
  assert.deepEqual(amended.taskIds, f.ids);
  assert.equal(amended.selection.ids.length, 351);
  assert.equal(f.before.operation.authorization.testSelection.ids.length, 316);
  const unchanged = await client.readReleaseOriginal(f.args);
  assert.equal(unchanged.originalCommand.status, "succeeded");
  assert.deepEqual(await client.call("continue", f.args), reply);
  f.scheduled.shift()(); const after = await f.service.drain(f.args.operation_id);
  assert.equal(after.operation.currentGeneration, 1, JSON.stringify(after.operation.lastError));
  assert.equal(after.operation.waitReason.code, "validation_failed");
  assert.equal(after.generations[0].testPlans[0].plan.selectedIds.length,351);
  assert.deepEqual(after.receipts.find(x=>x.stepId==="compose"&&x.attempt===1), f.before.receipts[0]);
  assert.equal(after.generations.length,1);
  // Addressed readback and exact replay do not run another amendment.
  const raw = f.catalog.mcpOperation(f.args.request_id);
  assert.equal(raw.status,"succeeded");
  assert.equal(f.store.get(f.args.operation_id).testSelectionAmendments.length,1);
  assert.deepEqual(await client.readReleaseOriginal(f.args), await client.readReleaseOriginal(f.args));
});

test("SAME UNKNOWN generation-zero public amendment preserves actor and lost admission ACK", async t => {
  const f=await fixture(t);
  const args={...f.args,context_token:f.token};
  f.catalog.beginMcpOperation({requestId:args.request_id,workspaceId:f.workspace.id,streamId:f.manager.id,
    provider:'codex',threadId:'original-rm',toolName:'hub_release_continue',argumentsHash:mcpArgumentsHash(args)});
  f.control.occupied=true;
  await assert.rejects(f.hub.call('hub_release_continue',args),/occupied/);
  const unknown=structuredClone(f.catalog.mcpOperation(args.request_id));
  assert.equal(unknown.status,'unknown');
  assert.deepEqual(f.store.snapshot(args.operation_id),f.before);
  const other=f.hub.contextToken({provider:'codex',threadId:'foreign-rm'});
  await assert.rejects(f.hub.call('hub_release_continue',{...args,context_token:other}),/another operation|authority|identity/);
  await assert.rejects(f.hub.call('hub_release_continue',{...args,test_selection:selected(350)}),/another operation/);
  f.control.occupied=false;
  const complete=f.catalog.completeUnknownMcpOperation.bind(f.catalog);
  f.catalog.completeUnknownMcpOperation=()=>{throw Error('controlled lost admission ACK');};
  await assert.rejects(f.hub.call('hub_release_continue',args),/reconciliation|lost admission ACK|persistence/i);
  assert.equal(f.store.get(args.operation_id).testSelectionAmendments.length,1);
  f.catalog.completeUnknownMcpOperation=complete;
  const result=await f.hub.call('hub_release_continue',args);
  assert.equal(result.accepted,true);
  assert.equal(result.operatorReconciliation.priorReceipt.error,unknown.error);
  assert.equal(f.catalog.mcpOperation(args.request_id).status,'succeeded');
  assert.equal(f.store.get(args.operation_id).testSelectionAmendments.length,1);
  assert.deepEqual(await f.hub.call('hub_release_continue',args),result);
});

test("first generation failed boundary refuses active, UNKNOWN, partial, foreign and missing proof", async t => {
  const f=await fixture(t);
  for(const change of [
    x=>{x.operation.owner={ownerId:'active'};},x=>{x.operation.publicationEffects={publishStarted:true};},
    x=>{x.receipts[0].status='unknown';},x=>{x.receipts[0].status='intent';},
    x=>{x.receipts[0].effect={status:'partial'};},x=>{x.receipts[0].operationId='foreign';},
    x=>{x.receipts[0].input.authorization.approvedTargets[0].repositoryRoot='foreign';},
    x=>{x.generations.push({generation:1});},x=>{x.receipts=[];},
  ]) {const changed=structuredClone(f.before);change(changed);assert.equal(failedFirstComposeRecovery(changed),null);}
  assert.deepEqual(f.store.snapshot(f.args.operation_id),f.before);
});

test("a later failed generation-zero amended compose retains every earlier input and may amend again", async t => {
  const f=await fixture(t),recover=f.service.recoverFirstCompose;
  f.service.recoverFirstCompose=async()=>{throw Error('controlled failure still before physical capture');};
  assert.equal((await f.service.continue(f.args.operation_id,f.options)).accepted,true);
  f.scheduled.shift()();const failed=await f.service.drain(f.args.operation_id);
  assert.equal(failed.operation.currentGeneration,0);
  assert.equal(failed.operation.state,'failed');
  assert.ok(failedFirstComposeRecovery(failed));
  const earlier=structuredClone(failed.receipts);
  f.service.recoverFirstCompose=recover;
  const next={...f.options,requestId:'second-exact-amendment',expectedRevision:failed.operation.revision};
  assert.equal((await f.service.continue(f.args.operation_id,next)).accepted,true);
  f.scheduled.shift()();const done=await f.service.drain(f.args.operation_id);
  assert.equal(done.operation.currentGeneration,1,JSON.stringify(done.operation.lastError));
  assert.equal(done.operation.testSelectionAmendments.length,2);
  assert.deepEqual(done.receipts.filter(x=>x.stepId==='compose'&&x.attempt<3),earlier);
  assert.deepEqual(done.operation.authorization,f.before.operation.authorization);
});

test("generation zero amendment refuses missing scope, stale CAS, occupied custody, notes and authority drift", async t => {
  const f=await fixture(t);
  for(const patch of [{expectedRevision:1},{expectedGeneration:1},{taskScope:undefined},{taskIds:undefined},{testSelection:undefined},{releaseMetadata:undefined}]) {
    const result=await f.service.continue(f.args.operation_id,{...f.options,...patch}); assert.equal(result.accepted,false);
    assert.deepEqual(f.store.snapshot(f.args.operation_id),f.before);
  }
  for(const field of ['occupied','changed']) {
    f.control[field]=true;
    await assert.rejects(f.service.continue(f.args.operation_id,f.options),/occupied|authority changed/);
    f.control[field]=false; assert.deepEqual(f.store.snapshot(f.args.operation_id),f.before);
  }
  await writeFile(f.newNotes.sourcePath,'changed');
  await assert.rejects(f.service.continue(f.args.operation_id,f.options));
  assert.deepEqual(f.store.snapshot(f.args.operation_id),f.before);
});

test("generation zero amendment repeats failed receipt proof in SQLite CAS", async t => {
  const f=await fixture(t);
  const before=structuredClone(f.before);
  f.control.late=async()=> {
    if(f.control.reads<2)return;
    const db=new DatabaseSync(path.join(f.root,'runtime.sqlite'));
    try { const receipt=structuredClone(before.receipts[0]); receipt.status='unknown';
      db.prepare("UPDATE release_step_receipts SET status='unknown',receipt_json=? WHERE operation_id=? AND generation=1 AND step_id='compose'")
        .run(JSON.stringify(receipt),f.args.operation_id); }finally{db.close();}
  };
  await assert.rejects(f.service.continue(f.args.operation_id,f.options),/failed receipt changed/);
  assert.deepEqual(f.store.get(f.args.operation_id),before.operation);
  assert.equal(f.store.snapshot(f.args.operation_id).generations.length,0);
});
