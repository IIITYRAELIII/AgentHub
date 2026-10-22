import test from "node:test";
import assert from "node:assert/strict";
import { TaskDiffStore } from "../../../src/infrastructure/persistence/task-diff-store.mjs";
import { createTaskStateWiring } from "../../../src/composition/task-state-wiring-composition.mjs";
import { CommandTraceService } from "../../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

function wiring(store, errors = []) {
  return createTaskStateWiring({ taskDiffs: store, logger: { error: (...args) => errors.push(args) } });
}

test("admission does not rewrite an already empty older diff or its eviction order", async () => {
  const writes = [];
  const store = new TaskDiffStore({filePath:"unused", limit:2,
    write: async (_file, body) => writes.push(JSON.parse(body))});
  await store.set("empty", "");
  await store.set("other", "retained");
  writes.length = 0;
  await wiring(store).persistTaskDiff("empty", "", {admission:true});
  assert.equal(writes.length, 0);
  assert.deepEqual([...store.values.keys()], ["empty", "other"]);
});

test("admission of a new Stream does not evict an unrelated cached diff", async () => {
  const writes = [];
  const store = new TaskDiffStore({filePath:"unused", limit:1,
    write: async (_file, body) => writes.push(JSON.parse(body))});
  await store.set("other", "retained"); writes.length = 0;
  await wiring(store).persistTaskDiff("new", "", {admission:true});
  assert.equal(writes.length, 0);
  assert.equal(store.get("other"), "retained");
});

test("an empty admission still observes the pending write's failure and retries dirty state", async () => {
  let reject;
  const gate = new Promise((_resolve, fail) => { reject = fail; });
  const error = Object.assign(new Error("fixture write failed"), {code:"EIO"});
  let attempts = 0;
  const store = new TaskDiffStore({filePath:"unused", write: async () => {
    if (++attempts === 2) await gate;
  }});
  await store.set("empty", "");
  const first = store.set("other", "latest");
  const firstFailure = assert.rejects(first, error);
  const errors = [];
  const admission = wiring(store, errors).persistTaskDiff("empty", "", {admission:true});
  const admissionFailure = assert.rejects(admission, error);
  await new Promise(resolve => setImmediate(resolve));
  reject(error);
  await Promise.all([firstFailure, admissionFailure]);
  assert.equal(errors.length, 1);
  await wiring(store).persistTaskDiff("empty", "", {admission:true});
  assert.equal(store.persistedRevision, store.revision);
  assert.equal(store.get("other"), "latest");
});

test("admission clears a real stale diff durably while retaining other keys and remembered updates", async () => {
  let disk;
  const store = new TaskDiffStore({filePath:"unused",
    write: async (_file, body) => { disk = JSON.parse(body); }});
  await store.set("thread", "stale");
  store.remember("other", "newest");
  await wiring(store).persistTaskDiff("thread", "", {admission:true});
  assert.deepEqual(disk, [["other", "newest"], ["thread", ""]]);
  assert.equal(store.persistedRevision, store.revision);
});

test("atomic write and failure traces survive reopening SQLite under the original command without payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub315-traces-"));
  const databaseFile = path.join(root, "traces.sqlite");
  const owner = new CommandTraceWorkerStore({databaseFile});
  let closed = false;
  try {
    await owner.initialize();
    const commandTrace = new CommandTraceService({store:owner, metadata:{releaseId:"fixture",instanceId:"fixture"}});
    const context = {commandTrace, commandId:"original-command", transport:"mcp"};
    const store = new TaskDiffStore({filePath:path.join(root,"task-diffs.json")});
    await store.set("private-key", "private-content", context);
    await store.clear("private-key", context);
    await store.clear("private-key", context);
    const failure = Object.assign(new Error("private-error-message"), {code:"EIO"});
    const failed = new TaskDiffStore({filePath:"private-path", write:async()=>{throw failure;}});
    await assert.rejects(failed.set("private-key","private-content",context), failure);
    await owner.close(); closed = true;
    const db = new DatabaseSync(databaseFile,{readOnly:true});
    try {
      const rows = db.prepare("SELECT * FROM command_trace_spans").all();
      assert.ok(rows.length < 100);
      assert.ok(rows.every(row => row.command_id === "original-command" && row.transport === "mcp"));
      for (const stage of ["encode","queue-wait","atomic-write","open","write","fsync","close","rename","directory-sync","settle","fence-wait"]) {
        const matching = rows.filter(row => row.stage === `task-diff-${stage}`);
        assert.ok(matching.some(row => row.outcome === "started"), stage);
        assert.ok(matching.some(row => row.outcome === "succeeded"), stage);
      }
      assert.ok(rows.some(row=>row.stage==="task-diff-atomic-write" && row.outcome==="failed"));
      for (const row of rows.filter(row=>row.outcome!=="started")) {
        const metadata = JSON.parse(row.metadata_json);
        assert.ok(rows.some(start=>start.outcome==="started"
          && JSON.parse(start.metadata_json).operationSpanId === metadata.operationSpanId));
      }
      assert.doesNotMatch(JSON.stringify(rows), /private-/u);
    } finally { db.close(); }
  } finally {
    if (!closed) await owner.close();
    await rm(root,{recursive:true,force:true});
  }
});

test("broken diagnostics cannot reject a successful diff write or conceal its failure", async () => {
  const context = {commandId:"original", commandTrace:{startBestEffortSpan(){throw new Error("diagnostics");}}};
  let writes = 0;
  const store = new TaskDiffStore({filePath:"unused",write:async()=>{writes++;}});
  await store.set("key","value",context);
  assert.equal(writes,1);
  store.write = async()=>{throw Object.assign(new Error("disk"),{code:"EIO"});};
  await assert.rejects(store.clear("key",context),{code:"EIO"});
});
