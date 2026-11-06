import assert from "node:assert/strict";
import test from "node:test";
import { DesktopReadModelService } from "../../../src/interfaces/desktop/desktop-read-model-service.mjs";
import { taskHasUnreadAnswer } from "../../../src/infrastructure/persistence/task-read-state-store.mjs";

function serviceFixture({ allowed = false, android = false, snapshot = null, cursor = null } = {}) {
  const snapshots = [];
  const reads = [];
  const service = new DesktopReadModelService({
    resolveReadTask: ({ provider, threadId }) => snapshot?.tasks?.find((task) => (
      task.provider === provider && task.threadId === threadId
    )),
    snapshot: ({ projectTask = (task) => task, ...params }) => {
      snapshots.push(params);
      return snapshot?.tasks ? { ...snapshot, tasks: snapshot.tasks.map(projectTask) } : snapshot ?? params;
    },
    readStateStore: {
      get: () => cursor,
      markRead: (value) => { reads.push(value); return value; },
    },
    trustedDeviceUserId: (context) => context?.userId ? `user:${context.userId}` : "owner",
    hasAllowedUsers: () => allowed,
    androidEnabled: () => android,
    lastTaskMessage: () => ({
      provider: "codex",
      threadId: "thread-1",
      updatedAt: "2026-08-05T10:00:00.000Z",
      turnId: "turn-1",
      terminalRevision: 2,
    }),
    hasUnread: taskHasUnreadAnswer,
  });
  return { service, snapshots, reads };
}

test("Desktop read model binds snapshots to the authenticated account", async () => {
  const { service, snapshots } = serviceFixture();
  assert.deepEqual(await service.snapshot({ accountId: "forged", value: 1 }, { userId: "42" }), {
    accountId: "user:42",
    value: 1,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(service.accountId(), "local");
});

test("Desktop read model uses the owner account for configured remote clients", () => {
  assert.equal(serviceFixture({ allowed: true }).service.accountId(), "owner");
  assert.equal(serviceFixture({ android: true }).service.accountId(), "owner");
});

test("Desktop read model records only the exact displayed final revision", async () => {
  const { service, reads } = serviceFixture({ snapshot: { tasks: [{
    provider: "codex",
    threadId: "thread-1",
  }] } });
  assert.deepEqual(await service.markTaskRead({ final: {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-old",
    revision: 1,
  } }), {
    marked: false,
    reason: "stale-final",
    latestFinal: {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      revision: 2,
      completedAt: "2026-08-05T10:00:00.000Z",
    },
  });
  assert.equal(reads.length, 0);
  const result = await service.markTaskRead({ final: {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    revision: 2,
  } });
  assert.equal(result.marked, true);
  assert.deepEqual(reads[0], {
    accountId: "local",
    provider: "codex",
    threadId: "thread-1",
    answerAt: "2026-08-05T10:00:00.000Z",
    answerTurnId: "turn-1",
    answerRevision: 2,
  });
  assert.equal(reads.length, 1);
});

test("Desktop read model keeps probes, measurements and unknown activity out of running", async () => {
  const tasks = [{
    provider: "codex",
    threadId: "thread-1",
    running: true,
    run: { turnId: "probe", operationKind: "probe" },
  }, {
    provider: "codex",
    threadId: "thread-2",
    running: true,
    run: { turnId: "measurement", observer: true },
    context: { usagePending: true },
  }, {
    provider: "codex",
    threadId: "thread-3",
    running: true,
    run: { turnId: "unknown" },
  }, {
    provider: "codex",
    threadId: "thread-4",
    running: true,
    run: { turnId: "user", clientUserMessageId: "client-1" },
  }];
  const { service } = serviceFixture({ snapshot: { tasks } });
  service.lastTaskMessage = () => null;
  const result = await service.snapshot();
  assert.deepEqual(result.tasks.map((task) => [task.running, task.activityUnknown, task.run?.operationKind]), [
    [false, false, undefined],
    [false, false, undefined],
    [false, true, undefined],
    [true, false, "user-turn"],
  ]);
});

test("Desktop read model terminal revision absorbs a late active snapshot", async () => {
  const { service } = serviceFixture({ snapshot: { tasks: [{
    provider: "codex",
    threadId: "thread-1",
    running: true,
    run: { turnId: "turn-1", clientUserMessageId: "client-1", progress: "late" },
  }] } });
  const [task] = (await service.snapshot()).tasks;
  assert.equal(task.running, false);
  assert.equal(task.run, null);
  assert.equal(task.latestFinal.revision, 2);
});

test("Desktop read model keeps a legacy final read after revision migration", async () => {
  const completedAt = "2026-08-24T20:37:30.206Z";
  const { service } = serviceFixture({
    snapshot: { tasks: [{ provider: "codex", threadId: "thread-1" }] },
    cursor: {
      answerAtMs: Date.parse(completedAt),
      answerTurnId: "turn-1",
      answerRevision: 0,
    },
  });
  service.lastTaskMessage = () => ({
    provider: "codex",
    threadId: "thread-1",
    updatedAt: completedAt,
    turnId: "turn-1",
  });
  const [task] = (await service.snapshot()).tasks;
  assert.equal(task.latestFinal.migrationGuard, "legacy-terminal-revision");
  assert.equal(task.unread, false);
});

test("Desktop read model does not revive stale unread without a canonical final", async () => {
  const { service } = serviceFixture({
    snapshot: { tasks: [{
      provider: "codex",
      threadId: "thread-1",
      unread: true,
    }] },
  });
  service.lastTaskMessage = () => null;
  const [task] = (await service.snapshot()).tasks;
  assert.equal(task.latestFinal, null);
  assert.equal(task.unread, false);
});
