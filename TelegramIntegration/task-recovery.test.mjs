import assert from "node:assert/strict";
import test from "node:test";

import { resolveTaskRecoveryAction, TASK_RECOVERY_ACTIONS as A } from "./task-recovery.mjs";

test("observer recovery distinguishes active, completed and unknown snapshots", () => {
  const run = { observer: true, provider: "codex" };
  assert.equal(resolveTaskRecoveryAction({ run, observerSnapshot: { active: true } }), A.OBSERVE);
  assert.equal(resolveTaskRecoveryAction({ run, observerSnapshot: { completed: true } }), A.FINISH_OBSERVED);
  assert.equal(resolveTaskRecoveryAction({ run, observerSnapshot: { activityUnknown: true } }), A.UNKNOWN_OBSERVED);
});

test("Claude output is reattached before declaring a local interruption", () => {
  assert.equal(resolveTaskRecoveryAction({
    run: { provider: "claude", claudeOutputPath: "run.jsonl" },
  }), A.ATTACH_CLAUDE);
  assert.equal(resolveTaskRecoveryAction({ run: { provider: "claude" } }), A.INTERRUPTED_LOCAL);
});

test("Codex recovery handles missing, approval, active and terminal turns", () => {
  const run = { provider: "codex", observer: false };
  assert.equal(resolveTaskRecoveryAction({ run, codexAvailable: true }), A.MISSING_CODEX_TURN);
  assert.equal(resolveTaskRecoveryAction({
    run, codexAvailable: true, codexTurn: { status: "inProgress" }, autoApprove: true, waitingOnApproval: true,
  }), A.RETRY_LOST_APPROVAL);
  assert.equal(resolveTaskRecoveryAction({
    run, codexAvailable: true, codexTurn: { status: "inProgress" },
  }), A.ATTACH_CODEX);
  assert.equal(resolveTaskRecoveryAction({
    run, codexAvailable: true, codexTurn: { status: "interrupted" }, restartRequested: true,
  }), A.DISMISS_RESTART_INTERRUPTION);
  assert.equal(resolveTaskRecoveryAction({
    run, codexAvailable: true, codexTurn: { status: "completed" },
  }), A.DELIVER_CODEX_RESULT);
});
