import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LocalTaskSyncStore } from "../../../src/infrastructure/persistence/task-sync-store.mjs";
import { AsyncSqliteMutationQueue } from "../../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-history-contention-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const store = new LocalTaskSyncStore({ filePath: path.join(root, "task-sync.json"), databaseFile, ...options });
  await store.load();
  const blocker = new DatabaseSync(databaseFile);
  t.after(async () => { blocker.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, blocker };
}

const task = { provider: "codex", threadId: "original-thread", projectRoot: "D:/project", title: "Task" };

test("history, snapshots and catalog wait for SQLite without blocking timers or losing write order", async (t) => {
  const { store, blocker } = await fixture(t);
  blocker.exec("BEGIN IMMEDIATE");
  const catalog = store.recordCatalog([task], 100);
  const snapshot = store.recordSnapshot(task, { active: true, turnId: "original-turn", activityAtMs: 200 });
  const history = store.recordHistory(task, [{ id: "original-turn", prompt: "Question", answer: "Answer", completed: true }], { active: false }, 300);
  let saved = false;
  const save = store.save().then(() => { saved = true; });
  await delay(35);
  assert.equal(saved, false);
  assert.equal(store.catalog().length, 0);
  assert.ok(store.mutationDiagnostics().queued >= 3);
  blocker.exec("COMMIT");
  await Promise.all([catalog, snapshot, history, save]);
  assert.equal(store.history(task)[0].id, "original-turn");
  assert.equal(store.snapshot(task).active, false);
  assert.equal(blocker.prepare("SELECT COUNT(*) n FROM task_read_model_turns").get().n, 1);
  const metrics = store.mutationDiagnostics();
  assert.ok(metrics.retries > 0);
  assert.ok(metrics.maxQueueWaitMs > 0);
  assert.equal(metrics.queued, 0);
  assert.equal(metrics.oldestAgeMs, 0);
});

test("history contention exhaustion leaves projection unchanged and a later exact retry succeeds", async (t) => {
  const { store, blocker } = await fixture(t, { mutationTimeoutMs: 25 });
  blocker.exec("BEGIN IMMEDIATE");
  const turns = [{ id: "original-turn", prompt: "Question", answer: "Answer", completed: true }];
  await assert.rejects(store.recordHistory(task, turns), /database is locked/);
  assert.equal(store.history(task).length, 0);
  blocker.exec("COMMIT");
  await store.recordHistory(task, turns);
  await store.recordHistory(task, turns);
  assert.equal(store.history(task).length, 1);
});

test("unchanged catalog polling preserves the snapshot cache revision", async (t) => {
  const { store } = await fixture(t);
  await store.recordCatalog([task], 100);
  const revision = store.revision;
  await store.recordCatalog([task], 200);
  assert.equal(store.revision, revision);
  await store.recordHistory(task, [{ id: "turn", prompt: "Question", answer: "Answer", completed: true }]);
  assert.ok(store.revision > revision);
});

test("mutation queues expose waiting time separately and unrelated stores do not share a lane", async () => {
  const queue = new AsyncSqliteMutationQueue();
  const other = new AsyncSqliteMutationQueue();
  let release;
  const held = queue.run(() => new Promise((resolve) => { release = resolve; }));
  const order = [];
  const later = queue.run(() => { order.push("later"); });
  await delay(15);
  assert.equal(queue.diagnostics().queued, 2);
  assert.ok(queue.diagnostics().oldestAgeMs > 0);
  await other.run(() => order.push("other"));
  assert.deepEqual(order, ["other"]);
  release();
  await Promise.all([held, later]);
  assert.deepEqual(order, ["other", "later"]);
  assert.ok(queue.diagnostics().lastQueueWaitMs >= 10);
  assert.equal(queue.diagnostics().completed, 2);
});

test("queued history captures its original content before later live updates", async (t) => {
  const { store, blocker } = await fixture(t);
  const history = [{ id: "original-turn", prompt: "Original", answer: "First", completed: true }];
  blocker.exec("BEGIN IMMEDIATE");
  const pending = store.recordHistory(task, history);
  history[0].answer = "Changed while waiting";
  history.push({ id: "later-turn", prompt: "Later", answer: "Later", completed: true });
  await delay(20);
  blocker.exec("COMMIT");
  await pending;
  assert.equal(store.history(task).length, 1);
  assert.equal(store.history(task)[0].answer, "First");
});
