import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DurableCommandReceipts, commandFingerprint } from "./durable-command-receipts.mjs";

test("durable receipt reconciles a crash after the effect without repeating it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-durable-receipt-"));
  const file = path.join(root, "receipts.json");
  let sideEffects = 0;
  let effectStarted;
  const started = new Promise((resolve) => { effectStarted = resolve; });
  const first = new DurableCommandReceipts({ file });
  void first.execute({
    id: "command-1",
    fingerprint: commandFingerprint({ action: "send-message", params: { text: "private" } }),
    action: "send-message",
    effect: async () => {
      sideEffects += 1;
      effectStarted();
      await new Promise(() => {});
    },
  });
  await started;

  const restarted = new DurableCommandReceipts({ file, isProcessAlive: () => false });
  const result = await restarted.execute({
    id: "command-1",
    fingerprint: commandFingerprint({ action: "send-message", params: { text: "private" } }),
    action: "send-message",
    effect: async () => {
      sideEffects += 1;
      return { duplicated: true };
    },
    reconcile: async () => ({ resolved: true, result: { delivered: true } }),
  });
  assert.deepEqual(result, { delivered: true });
  assert.equal(sideEffects, 1);
  assert.deepEqual(await restarted.execute({
    id: "command-1",
    fingerprint: commandFingerprint({ action: "send-message", params: { text: "private" } }),
    action: "send-message",
    effect: async () => { throw new Error("must use cached result"); },
  }), { delivered: true });
  assert.doesNotMatch(await readFile(file, "utf8"), /private/u);
});

test("receipt capacity never evicts an unresolved effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-durable-pending-"));
  const file = path.join(root, "receipts.json");
  const receipts = new DurableCommandReceipts({ file, maxItems: 100, maxPending: 10 });
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  void receipts.execute({
    id: "unresolved",
    fingerprint: commandFingerprint({ action: "send-message", number: 0 }),
    action: "send-message",
    effect: async () => {
      started();
      await new Promise(() => {});
    },
  });
  await waiting;
  for (let index = 1; index <= 100; index += 1) {
    await receipts.execute({
      id: `completed-${index}`,
      fingerprint: commandFingerprint({ action: "read", index }),
      action: "read",
      effect: async () => ({ index }),
    });
  }
  let duplicate = false;
  const restarted = new DurableCommandReceipts({
    file, maxItems: 100, maxPending: 10, isProcessAlive: () => false,
  });
  const result = await restarted.execute({
    id: "unresolved",
    fingerprint: commandFingerprint({ action: "send-message", number: 0 }),
    action: "send-message",
    effect: async () => { duplicate = true; },
    reconcile: async () => ({ resolved: true, result: { delivered: true } }),
  });
  assert.deepEqual(result, { delivered: true });
  assert.equal(duplicate, false);
});

test("receipt refuses new effects rather than evicting unacknowledged results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-durable-results-"));
  const receipts = new DurableCommandReceipts({ file: path.join(root, "receipts.json"), maxItems: 100 });
  for (let index = 0; index < 100; index += 1) {
    await receipts.execute({
      id: `result-${index}`,
      fingerprint: commandFingerprint({ index }),
      action: "mutation",
      effect: async () => ({ index }),
    });
  }
  let started = false;
  await assert.rejects(
    receipts.execute({
      id: "must-not-evict",
      fingerprint: commandFingerprint({ index: 101 }),
      action: "mutation",
      effect: async () => { started = true; },
    }),
    /unacknowledged results/,
  );
  assert.equal(started, false);
  assert.equal(await receipts.forget("result-0"), true);
  assert.deepEqual(await receipts.execute({
    id: "after-ack",
    fingerprint: commandFingerprint({ index: 102 }),
    action: "mutation",
    effect: async () => ({ accepted: true }),
  }), { accepted: true });
});

test("receipt refuses new effects when unresolved receipt capacity is exhausted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-durable-capacity-"));
  const receipts = new DurableCommandReceipts({ file: path.join(root, "receipts.json"), maxPending: 10 });
  const starts = [];
  for (let index = 0; index < 10; index += 1) {
    void receipts.execute({
      id: `stalled-${index}`,
      fingerprint: commandFingerprint({ index }),
      action: "mutate",
      effect: async () => {
        starts.push(index);
        await new Promise(() => {});
      },
    });
  }
  while (starts.length < 10) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(
    receipts.execute({
      id: "must-not-start",
      fingerprint: commandFingerprint({ index: 11 }),
      action: "mutate",
      effect: async () => { starts.push(11); },
    }),
    /capacity is exhausted/,
  );
  assert.deepEqual(starts.sort((left, right) => left - right), Array.from({ length: 10 }, (_, index) => index));
});

test("temporary reconciliation failure does not terminal-fail or replay the effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-durable-retry-"));
  const file = path.join(root, "receipts.json");
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const first = new DurableCommandReceipts({ file });
  void first.execute({
    id: "retryable",
    fingerprint: commandFingerprint({ action: "mutation" }),
    action: "mutation",
    effect: async () => {
      started();
      await new Promise(() => {});
    },
  });
  await waiting;
  let replayed = false;
  const restarted = new DurableCommandReceipts({ file, isProcessAlive: () => false });
  await assert.rejects(
    restarted.execute({
      id: "retryable",
      fingerprint: commandFingerprint({ action: "mutation" }),
      action: "mutation",
      effect: async () => { replayed = true; },
      reconcile: async () => ({ resolved: false, error: "temporary lookup outage" }),
    }),
    /temporary lookup outage/,
  );
  assert.equal(replayed, false);
  assert.deepEqual(await restarted.execute({
    id: "retryable",
    fingerprint: commandFingerprint({ action: "mutation" }),
    action: "mutation",
    effect: async () => { replayed = true; },
    reconcile: async () => ({ resolved: true, result: { recovered: true } }),
  }), { recovered: true });
  assert.equal(replayed, false);
});

test("separate receipt instances wait for a live effect owner and return its result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-durable-receipt-race-"));
  const file = path.join(root, "receipts.json");
  let sideEffects = 0;
  let effectStarted;
  const started = new Promise((resolve) => { effectStarted = resolve; });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = new DurableCommandReceipts({ file });
  const firstResult = first.execute({
    id: "command-1",
    fingerprint: "same-command",
    effect: async () => {
      sideEffects += 1;
      effectStarted();
      await blocked;
      return { delivered: true };
    },
  });
  await started;
  const second = new DurableCommandReceipts({ file });
  const secondResult = second.execute({
    id: "command-1",
    fingerprint: "same-command",
    effect: async () => {
      sideEffects += 1;
      return { duplicated: true };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  assert.deepEqual(await firstResult, { delivered: true });
  assert.deepEqual(await secondResult, { delivered: true });
  assert.equal(sideEffects, 1);
});

test("an old receipt with a live reused PID is reconciled after its maximum effect age", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-durable-receipt-pid-reuse-"));
  const file = path.join(root, "receipts.json");
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const first = new DurableCommandReceipts({ file });
  void first.execute({
    id: "old-command",
    fingerprint: "same-command",
    effect: async () => {
      started();
      await new Promise(() => {});
    },
  });
  await waiting;
  await new Promise((resolve) => setTimeout(resolve, 35));
  const restarted = new DurableCommandReceipts({
    file,
    isProcessAlive: () => true,
    effectWaitTimeoutMs: 25,
    effectMaxAgeMs: 25,
  });
  assert.deepEqual(await restarted.execute({
    id: "old-command",
    fingerprint: "same-command",
    effect: async () => { throw new Error("must reconcile"); },
    reconcile: async () => ({ resolved: true, result: { reconciled: true } }),
  }), { reconciled: true });
});
