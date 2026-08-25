import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MessageCommandLedgerStore } from "../../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { messageCommandFixture } from "../../fixtures/message-command-ledger.mjs";

function accept(store, sequence) {
  const command = messageCommandFixture({
    clientUserMessageId: `message-${sequence}`,
    itemId: `deferred-${sequence}`,
    fingerprint: `fingerprint-${sequence}`,
  });
  return { ...command, accepted: store.accept({ ...command, destination: "queued" }) };
}

test("message command projection scans only bounded active rows", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-ledger-active-"));
  const store = new MessageCommandLedgerStore({ dataDir, maxActiveCommands: 2 });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const first = accept(store, 1);
  const second = accept(store, 2);

  store.transition({
    clientUserMessageId: first.item.clientUserMessageId,
    expectedStates: ["queued"],
    state: "completed",
    result: { accepted: true, completed: true },
  });
  const projection = store.projectSnapshot({
    queuedInputs: [second.item],
    desktopMessageReceipts: [second.receipt],
  });

  assert.deepEqual(projection, { scanned: 1, changed: 1 });
  assert.equal(store.retentionStats().active, 1);
  assert.throws(() => {
    accept(store, 3);
    accept(store, 4);
  }, (error) => error.code === "MESSAGE_COMMAND_CAPACITY_EXHAUSTED");
});

test("terminal payload retention is bounded while exact retry tombstones remain", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-ledger-retention-"));
  let now = Date.parse("2026-08-25T10:00:00.000Z");
  const store = new MessageCommandLedgerStore({
    dataDir,
    now: () => ++now,
    maxActiveCommands: 10,
    terminalHotLimit: 2,
    terminalHotRetentionMs: 24 * 60 * 60 * 1_000,
    terminalArchiveLimit: 2,
    terminalArchiveBatch: 10,
  });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const commands = [];
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    const command = accept(store, sequence);
    commands.push(command);
    const transitioned = store.transition({
      clientUserMessageId: command.item.clientUserMessageId,
      expectedStates: ["queued"],
      state: "completed",
      result: {
        accepted: true,
        completed: true,
        provider: "codex",
        threadId: "thread-1",
        turnId: `turn-${sequence}`,
      },
    });
    assert.equal(transitioned.changed, true);
  }

  const stats = store.retentionStats();
  assert.equal(stats.active, 0);
  assert.ok(stats.hotTerminal <= 2);
  assert.ok(stats.archivedPayloads <= 2);
  assert.equal(stats.terminal, 5);
  assert.ok(stats.terminalTombstones >= 1);
  assert.equal(store.projectSnapshot({}).scanned, 0);
  for (const command of commands) {
    assert.equal(store.get(command.item.clientUserMessageId).state, "completed");
  }
  const oldest = store.get(commands[0].item.clientUserMessageId);
  assert.equal(oldest.item, null);
  const retry = store.accept({
    item: commands[0].item,
    destination: "queued",
    receipt: commands[0].receipt,
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.retryResult.completed, true);
  const idempotent = store.transition({
    clientUserMessageId: commands[0].item.clientUserMessageId,
    expectedStates: ["started"],
    state: "completed",
  });
  assert.equal(idempotent.idempotent, true);
  const stale = store.transition({
    clientUserMessageId: commands[0].item.clientUserMessageId,
    expectedStates: ["started"],
    state: "failed",
  });
  assert.equal(stale.conflict, true);
  assert.equal(stale.record.state, "completed");
});

test("provisional occupancy rekeys once and survives stale save plus restart", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-ledger-occupancy-"));
  let now = Date.parse("2026-08-25T12:00:00.000Z");
  let store = new MessageCommandLedgerStore({ dataDir, now: () => ++now });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const command = messageCommandFixture({
    clientUserMessageId: "message-provisional",
    fingerprint: "fingerprint-provisional",
    item: { streamId: "stream-1", provider: "codex", threadId: null },
  });
  const accepted = store.accept({ ...command, destination: "queued" });
  assert.equal(accepted.record.occupancyBinding, "provisional");
  assert.equal(accepted.record.item.queueOrder, accepted.record.acceptedAtMs);

  const bound = store.rekeyOccupancy({
    clientUserMessageId: command.item.clientUserMessageId,
    expectedOccupancyKey: accepted.record.occupancyKey,
    target: { ...command.item, threadId: "thread-1" },
  });
  assert.equal(bound.changed, true);
  assert.equal(bound.record.occupancyBinding, "exact");
  const repeated = store.rekeyOccupancy({
    clientUserMessageId: command.item.clientUserMessageId,
    expectedOccupancyKey: accepted.record.occupancyKey,
    target: { ...command.item, threadId: "thread-1" },
  });
  assert.equal(repeated.idempotent, true);
  const conflicting = store.rekeyOccupancy({
    clientUserMessageId: command.item.clientUserMessageId,
    target: { ...command.item, threadId: "thread-2" },
  });
  assert.equal(conflicting.conflict, true);

  store.projectSnapshot({
    queuedInputs: [command.item],
    desktopMessageReceipts: [command.receipt],
  });
  assert.equal(store.get(command.item.clientUserMessageId).item.threadId, "thread-1");
  store.close();
  store = new MessageCommandLedgerStore({ dataDir, now: () => ++now });

  const restored = store.get(command.item.clientUserMessageId);
  assert.equal(restored.occupancyBinding, "exact");
  assert.equal(restored.item.threadId, "thread-1");
  assert.equal(restored.item.queueOrder, accepted.record.acceptedAtMs);
});

test("snapshot promotes provisional occupancy when the run obtains its exact thread", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-ledger-run-binding-"));
  const store = new MessageCommandLedgerStore({ dataDir });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const command = messageCommandFixture({
    clientUserMessageId: "message-late-thread",
    fingerprint: "fingerprint-late-thread",
    item: { streamId: "stream-1", provider: "claude", threadId: null },
  });
  const accepted = store.accept({ ...command, destination: "queued" });

  store.projectSnapshot({
    activeRuns: [{
      clientUserMessageId: command.item.clientUserMessageId,
      streamId: "stream-1",
      provider: "claude",
      threadId: "thread-late",
      status: "running",
    }],
  });

  const bound = store.get(command.item.clientUserMessageId);
  assert.equal(bound.state, "started");
  assert.equal(bound.occupancyBinding, "exact");
  assert.notEqual(bound.occupancyKey, accepted.record.occupancyKey);
  assert.equal(bound.item.threadId, "thread-late");
  assert.equal(bound.item.queueOrder, accepted.record.acceptedAtMs);
});
