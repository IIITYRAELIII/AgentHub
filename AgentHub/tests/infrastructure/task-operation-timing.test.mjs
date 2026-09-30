import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { measureTaskOperation, withTaskOperationTiming } from "../../src/infrastructure/process/task-operation-timing.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("concurrent operations retain identity, original errors and bounded diagnostics", async () => {
  const events = [], gate = deferred(), started = deferred();
  const failure = new Error("private failure contents");
  const first = withTaskOperationTiming({ operationId: "first", taskId: "a", record: event => events.push(event) }, async () => {
    started.resolve();
    await gate.promise;
    for (let i = 0; i < 520; i += 1) await measureTaskOperation("git-child", () => i, { detail: true });
    throw failure;
  });
  const rejection = assert.rejects(first, error => error === failure);
  await started.promise;
  assert.equal(await withTaskOperationTiming({ operationId: "second", taskId: "b", record: event => events.push(event) },
    () => measureTaskOperation("snapshot", () => 42)), 42);
  gate.resolve(); await rejection;
  assert.equal(events.filter(event => event.stage === "git-child" && event.phase === "start").length, 512);
  assert.equal(events.find(event => event.operationId === "first" && event.stage === "trace-summary").suppressedDetailSpans, 8);
  assert.equal(events.find(event => event.operationId === "first" && event.stage === "workflow" && event.phase === "end").outcome, "error");
  assert.ok(events.filter(event => event.stage === "snapshot").every(event => event.operationId === "second" && event.taskId === "b"));
  assert.ok(!JSON.stringify(events).includes(failure.message));
  for (const event of events.filter(event => event.durationMs != null)) assert.ok(event.durationMs >= 0);
});

test("failed synchronous or asynchronous diagnostic sink cannot fail the operation", async () => {
  for (const record of [() => { throw new Error("sink"); }, () => Promise.reject(new Error("sink"))]) {
    assert.equal(await withTaskOperationTiming({ operationId: "sink-failure", record }, () => 12), 12);
  }
});

test("real child failures keep stderr out of timing and preserve the original rejection", async () => {
  const events = [];
  await assert.rejects(withTaskOperationTiming({ operationId: "child", record: event => events.push(event) },
    () => runTaskGitCommand(["-e", "process.stderr.write('PRIVATE_PAYLOAD');process.exit(7)"],
      { executable: process.execPath, commandLabel: "test-private-label" })), /PRIVATE_PAYLOAD/u);
  const child = events.find(event => event.stage === "git-child" && event.phase === "end");
  assert.equal(child.command, "external"); assert.equal(child.outcome, "error");
  assert.ok(!JSON.stringify(events).includes("PRIVATE"));
  assert.ok(!JSON.stringify(events).includes("test-private-label"));
});

test("real Task lock wait is separated from the protected operation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-task-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [], held = deferred(), release = deferred();
  const service = new TaskGitWorkspaceService({ dataDir: root, recordTiming: event => events.push(event) });
  const first = service.withTaskLock("same-task", async () => { held.resolve(); await release.promise; });
  await held.promise;
  const second = service.withOperationTrace({ operationId: "waiter", taskId: "same-task" },
    () => service.withTaskLock("same-task", () => "completed"));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event.stage === "lock" && event.phase === "start"));
  assert.ok(!events.some(event => event.stage === "lock-acquired"));
  release.resolve(); await first;
  assert.equal(await second, "completed");
  const acquired = events.find(event => event.stage === "lock-acquired");
  assert.equal(acquired.lockKind, "task"); assert.ok(acquired.waitMs > 0);
  assert.ok(events.some(event => event.stage === "workflow" && event.phase === "end" && event.outcome === "ok"));
});
