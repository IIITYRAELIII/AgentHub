import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  MessageCommandLedgerStore,
  messageCommandLedgerPath,
} from "../../../src/infrastructure/persistence/message-command-ledger-store.mjs";
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

test("receipt-only legacy commands migrate to terminal tombstones", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-ledger-legacy-receipt-"));
  const store = new MessageCommandLedgerStore({ dataDir, maxActiveCommands: 1 });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const command = messageCommandFixture({
    clientUserMessageId: "legacy-dispatching",
    fingerprint: "legacy-dispatching-fingerprint",
    receipt: {
      result: {
        accepted: true,
        deferred: true,
        queued: true,
        dispatching: true,
        runId: "legacy-run",
        turnId: "legacy-turn",
      },
    },
  });

  assert.equal(store.migrateLegacy({ desktopMessageReceipts: [command.receipt] }), 1);
  assert.equal(store.activeCount(), 0);
  assert.equal(store.get(command.item.clientUserMessageId).state, "completed");
  const retry = store.accept({ ...command, destination: "queued" });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.retryResult.completed, true);
  assert.equal(store.activeCount(), 0);
});

test("startup repairs active legacy rows without payload and preserves real queue items", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-ledger-orphan-repair-"));
  let store = new MessageCommandLedgerStore({ dataDir, maxActiveCommands: 2 });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const live = accept(store, "live");
  store.close();

  const database = new DatabaseSync(messageCommandLedgerPath(dataDir));
  database.prepare(`
    INSERT INTO message_commands (
      client_user_message_id, fingerprint, state, destination,
      item_json, receipt_json, result_json, accepted_at_ms, updated_at_ms, revision
    ) VALUES (?, ?, 'dispatching', 'queued', NULL, ?, ?, ?, ?, 1)
  `).run(
    "legacy-orphan",
    "legacy-orphan-fingerprint",
    JSON.stringify({
      clientUserMessageId: "legacy-orphan",
      fingerprint: "legacy-orphan-fingerprint",
      result: { accepted: true, dispatching: true, runId: "old-run", turnId: "old-turn" },
    }),
    JSON.stringify({ accepted: true, dispatching: true, runId: "old-run", turnId: "old-turn" }),
    Date.parse("2026-08-08T12:00:00.000Z"),
    Date.parse("2026-08-08T12:00:00.000Z"),
  );
  database.close();

  store = new MessageCommandLedgerStore({ dataDir, maxActiveCommands: 2 });
  assert.equal(store.get("legacy-orphan").state, "completed");
  assert.equal(store.get("legacy-orphan").result.completed, true);
  assert.equal(store.get(live.item.clientUserMessageId).state, "queued");
  assert.equal(store.activeCount(), 1);
  assert.doesNotThrow(() => accept(store, "after-repair"));
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

test("a steered receipt closes the durable command and preserves retry identity", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-ledger-steer-"));
  const store = new MessageCommandLedgerStore({ dataDir });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const command = messageCommandFixture({
    clientUserMessageId: "message-steer",
    fingerprint: "fingerprint-steer",
    item: { provider: "codex", threadId: "thread-1", conflictKind: "message-steer" },
  });
  store.accept({ ...command, destination: "queued" });

  store.projectSnapshot({
    desktopMessageReceipts: [{
      ...command.receipt,
      result: {
        accepted: true,
        steered: true,
        turnId: "turn-1",
        clientUserMessageId: command.item.clientUserMessageId,
      },
    }],
  });

  assert.equal(store.get(command.item.clientUserMessageId).state, "completed");
  const retry = store.accept({ ...command, destination: "queued" });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.retryResult.steered, true);
  assert.equal(retry.retryResult.completed, true);
});
