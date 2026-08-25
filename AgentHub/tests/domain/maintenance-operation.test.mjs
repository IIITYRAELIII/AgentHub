import assert from "node:assert/strict";
import test from "node:test";

import {
  createMaintenanceOperation,
  transitionMaintenanceOperation,
  unknownMaintenanceOutcome,
} from "../../src/domain/maintenance-operation.mjs";

test("maintenance identity is exact and is never a user turn", () => {
  const operation = createMaintenanceOperation({
    operationId: "operation-1",
    kind: "context-compaction",
    streamId: "stream-1",
    threadId: "thread-1",
    providerTurnId: "provider-turn-1",
    status: "running",
    phase: "compacting",
    createdAt: "2026-08-25T10:00:00.000Z",
  });

  assert.equal(operation.entityType, "maintenance-operation");
  assert.equal(operation.userTurn, false);
  assert.equal(operation.operationId, "operation-1");
  assert.equal(operation.streamId, "stream-1");
  assert.equal(operation.threadId, "thread-1");
  assert.equal(operation.providerTurnId, "provider-turn-1");
  assert.equal(Object.hasOwn(operation, "turnId"), false);
});

test("revision and status reject reordered or identity-changing events", () => {
  const started = createMaintenanceOperation({
    operationId: "operation-reorder",
    kind: "restart",
    streamId: "stream-1",
    threadId: "thread-1",
    status: "running",
    phase: "cutover",
  });
  const reconciled = unknownMaintenanceOutcome(started).operation;
  const stale = transitionMaintenanceOperation(reconciled, {
    status: "running",
    phase: "late-running",
  }, { expectedRevision: started.revision });
  const regression = transitionMaintenanceOperation(reconciled, {
    status: "running",
    phase: "late-running",
  }, { expectedRevision: reconciled.revision });

  assert.equal(reconciled.revision, 2);
  assert.equal(reconciled.status, "reconciling");
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale-revision");
  assert.equal(regression.applied, false);
  assert.equal(regression.reason, "status-regression");
  assert.throws(() => transitionMaintenanceOperation(reconciled, {
    streamId: "stream-other",
  }), /streamId is immutable/u);
});
