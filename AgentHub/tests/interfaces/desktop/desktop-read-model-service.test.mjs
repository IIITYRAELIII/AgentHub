import assert from "node:assert/strict";
import test from "node:test";
import { DesktopReadModelService } from "../../../src/interfaces/desktop/desktop-read-model-service.mjs";

function serviceFixture({ allowed = false, android = false } = {}) {
  const snapshots = [];
  const reads = [];
  const service = new DesktopReadModelService({
    snapshot: (params) => { snapshots.push(params); return params; },
    readStateStore: { markRead: (value) => { reads.push(value); return value; } },
    trustedDeviceUserId: (context) => context?.userId ? `user:${context.userId}` : "owner",
    hasAllowedUsers: () => allowed,
    androidEnabled: () => android,
    lastTaskMessage: () => ({ updatedAt: "2026-08-05T10:00:00.000Z", turnId: "turn-1" }),
  });
  return { service, snapshots, reads };
}

test("Desktop read model binds snapshots to the authenticated account", () => {
  const { service, snapshots } = serviceFixture();
  assert.deepEqual(service.snapshot({ accountId: "forged", value: 1 }, { userId: "42" }), {
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

test("Desktop read model records the latest completed answer", () => {
  const { service, reads } = serviceFixture();
  const entry = { provider: "codex", threadId: "thread-1" };
  assert.deepEqual(service.markTaskRead(entry), {
    accountId: "local",
    provider: "codex",
    threadId: "thread-1",
    answerAt: "2026-08-05T10:00:00.000Z",
    answerTurnId: "turn-1",
  });
  assert.equal(reads.length, 1);
});
