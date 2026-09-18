import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeContextMaintenanceService } from "../../../src/providers/claude/claude-context-maintenance-service.mjs";
import { ContextCompactionTracker } from "../../../src/providers/codex/context-compaction-tracker.mjs";
import { claudeCompactionEvent } from "../../../src/domain/claude-context-maintenance.mjs";

const THREAD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function service(overrides = {}) {
  const compactions = overrides.compactions ?? new ContextCompactionTracker();
  const launched = [];
  const instance = new ClaudeContextMaintenanceService({
    compactions,
    beginRun: async (input, target) => ({
      id: "run-1",
      provider: "claude",
      threadId: target.threadId,
      streamId: target.streamId ?? null,
      clientUserMessageId: target.clientUserMessageId,
      modelId: "claude-opus-5",
      prompt: input,
    }),
    launchTurn: async (run, input) => {
      run.turnId = "turn-1";
      launched.push({ run, input });
    },
    activeRun: () => null,
    ...overrides,
  });
  return { instance, compactions, launched };
}

const target = {
  provider: "claude",
  threadId: THREAD_ID,
  streamId: "stream-1",
  projectRoot: "C:/repo",
};

test("manual Claude compaction runs the CLI command as a maintenance turn", async () => {
  const { instance, compactions, launched } = service();
  const started = await instance.startManual(target, { beforePercent: 82 });
  assert.equal(started.accepted, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].input, "/compact");
  assert.equal(launched[0].run.claudeCompaction, true);
  assert.equal(launched[0].run.displayRequested, false);
  assert.match(String(launched[0].run.clientUserMessageId), /^agent-hub-claude-compaction:/u);
  const record = compactions.get(THREAD_ID);
  assert.equal(record.status, "running");
  assert.equal(record.origin, "manual");
  assert.equal(record.turnId, "turn-1");
  assert.equal(record.beforePercent, 82);
});

test("a busy Claude thread refuses compaction instead of queueing a second turn", async () => {
  const { instance, compactions, launched } = service({ activeRun: () => ({ id: "run-9" }) });
  const started = await instance.startManual(target);
  assert.equal(started.accepted, false);
  assert.equal(launched.length, 0);
  assert.equal(compactions.get(THREAD_ID), null);
});

test("a failed launch releases the compaction record", async () => {
  const { instance, compactions } = service({
    launchTurn: async () => { throw new Error("Claude Code не запустился"); },
  });
  await assert.rejects(() => instance.startManual(target), /не запустился/u);
  assert.equal(compactions.get(THREAD_ID).status, "failed");
});

test("the compaction boundary records the exact context before and after", () => {
  const { instance, compactions } = service();
  const run = {
    provider: "claude",
    threadId: THREAD_ID,
    turnId: "turn-1",
    streamId: "stream-1",
    claudeCompaction: true,
    claudeObservedModel: "claude-opus-5",
  };
  instance.observe(run, claudeCompactionEvent({ type: "system", subtype: "status", status: "compacting" }));
  assert.equal(compactions.get(THREAD_ID).status, "running");
  instance.observe(run, claudeCompactionEvent({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 500_000, post_tokens: 100_000 },
  }));
  const record = compactions.get(THREAD_ID);
  assert.equal(record.status, "completed");
  assert.equal(record.beforePercent, 50);
  assert.equal(record.afterPercent, 10);
  assert.equal(record.measurementStatus, "completed");
});

test("automatic compaction of Claude Code is recorded without a Hub request", () => {
  const { instance, compactions } = service();
  const run = {
    provider: "claude",
    threadId: THREAD_ID,
    turnId: "turn-7",
    streamId: "stream-1",
    claudeObservedModel: "claude-opus-5",
  };
  instance.observe(run, claudeCompactionEvent({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 900_000, post_tokens: 200_000 },
  }));
  const record = compactions.get(THREAD_ID);
  assert.equal(record.origin, "automatic");
  assert.equal(record.status, "completed");
  assert.equal(record.afterPercent, 20);
});

test("a reported compaction failure settles the record as failed", () => {
  const { instance, compactions } = service();
  const run = { provider: "claude", threadId: THREAD_ID, turnId: "turn-1", claudeCompaction: true };
  instance.observe(run, claudeCompactionEvent({ type: "system", subtype: "status", status: "compacting" }));
  instance.observe(run, claudeCompactionEvent({
    type: "system", subtype: "status", status: null, compact_result: "error",
  }));
  assert.equal(compactions.get(THREAD_ID).status, "failed");
});

test("a compaction turn that ends without a boundary is not reported as success", () => {
  const { instance, compactions } = service();
  const run = { provider: "claude", threadId: THREAD_ID, turnId: "turn-1", claudeCompaction: true };
  instance.observe(run, claudeCompactionEvent({ type: "system", subtype: "status", status: "compacting" }));
  instance.settleRun(run);
  assert.equal(compactions.get(THREAD_ID).status, "failed");
});

test("Claude measures its own context and never rotates the thread", () => {
  const { instance } = service();
  assert.equal(instance.measuresContextItself, true);
  assert.throws(() => instance.rotate(), /только для Codex/u);
  assert.throws(() => instance.rotateCompacted(), /только для Codex/u);
});
