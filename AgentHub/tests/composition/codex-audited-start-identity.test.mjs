import assert from "node:assert/strict";
import test from "node:test";
import { createCodexObservabilityComposition } from "../../src/composition/codex-observability-composition.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";

test("rollout audit cannot bind an old turn to a run awaiting provider acceptance", async () => {
  const taskRuns = new TaskRunRegistry();
  const run = { id: "new-run", provider: "codex", threadId: "thread", turnId: null,
    startedAt: "2026-10-28T02:56:24.949Z" };
  taskRuns.add(run);
  const observer = createCodexObservabilityComposition({
    config: { codexRolloutContext: { scanIntervalSeconds: 1 } }, taskRuns,
  });
  await observer.terminalAudit.onTurnStarted({ id: "thread" }, { path: process.cwd() }, {
    turnId: "old-turn", startedAt: "2026-10-15T19:24:58.461Z",
  });
  assert.equal(run.turnId, null);
  assert.equal(run.startedAt, "2026-10-28T02:56:24.949Z");
  assert.equal(observer.turnStarts.size, 1);
  run.turnId = "new-turn";
  taskRuns.reindex(run);
  await observer.terminalAudit.onTurnStarted({ id: "thread" }, { path: process.cwd() }, {
    turnId: "new-turn", startedAt: "2026-10-28T02:56:35.415Z",
  });
  assert.equal(run.startedAt, "2026-10-28T02:56:35.415Z");
  await observer.terminalAudit.onTurnStarted({ id: "other-thread" }, { path: process.cwd() }, {
    turnId: "new-turn", startedAt: "2026-10-15T19:24:58.461Z",
  });
  assert.equal(run.startedAt, "2026-10-28T02:56:35.415Z");
});
