import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeTaskSnapshotService } from "./claude-task-snapshot-service.mjs";

test("Claude snapshot service clears an old cancellation after new activity", async () => {
  const cancelledTasks = new Map([["claude:session-1", 100]]);
  let saved = false;
  const service = new ClaudeTaskSnapshotService({
    readSession: async () => ({ sessionId: "session-1", cwd: "D:/workspace", modifiedAtMs: 200 }),
    findProject: () => ({ path: "D:/workspace" }),
    taskRunKey: () => "claude:session-1",
    activityAtMs: (snapshot) => snapshot.modifiedAtMs,
    activityState: () => "active",
    saveState: async () => { saved = true; },
    cancelledTasks,
  });
  const snapshot = await service.read("session-1");
  assert.equal(snapshot.active, true);
  assert.equal(cancelledTasks.size, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, true);
});

test("Claude snapshot service masks a cancelled transcript without newer activity", async () => {
  const service = new ClaudeTaskSnapshotService({
    readSession: async () => ({ sessionId: "session-1", cwd: "D:/workspace", modifiedAtMs: 100, active: true }),
    findProject: () => ({ path: "D:/workspace" }),
    taskRunKey: () => "claude:session-1",
    activityAtMs: (snapshot) => snapshot.modifiedAtMs,
    activityState: (snapshot) => snapshot.cancelled ? "inactive" : "active",
    saveState: async () => {},
    cancelledTasks: new Map([["claude:session-1", 100]]),
  });
  const snapshot = await service.read("session-1");
  assert.equal(snapshot.cancelled, true);
  assert.equal(snapshot.active, false);
});

