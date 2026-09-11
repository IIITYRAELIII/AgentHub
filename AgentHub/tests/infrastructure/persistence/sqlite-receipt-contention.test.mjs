import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { SqliteDurableCommandReceipts } from "../../../src/infrastructure/persistence/sqlite-durable-command-receipts.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-receipt-contention-"));
  const file = path.join(root, "receipts.sqlite");
  const receipts = new SqliteDurableCommandReceipts({ file, ...options });
  await receipts.forget("initialize-schema");
  const blocker = new DatabaseSync(file);
  blocker.exec("PRAGMA busy_timeout = 0");
  t.after(async () => {
    blocker.close();
    await receipts.close();
    await rm(root, { recursive: true, force: true });
  });
  return { file, receipts, blocker };
}

function command(effect, extra = {}) {
  return { id: "original-command", fingerprint: "immutable-fingerprint", action: "send-message", effect, ...extra };
}

test("receipt admission waits asynchronously for SQLite and same-ID replay performs one effect", async (t) => {
  const { receipts, blocker } = await fixture(t);
  blocker.exec("BEGIN IMMEDIATE");
  let calls = 0;
  const request = command(async () => ({ calls: ++calls }));
  const first = receipts.execute(request);
  const duplicate = receipts.execute(request);
  await delay(35);
  assert.equal(calls, 0, "no effect before its durable ownership receipt");
  blocker.exec("COMMIT");
  assert.deepEqual(await first, { calls: 1 });
  assert.deepEqual(await duplicate, { calls: 1 });
  assert.deepEqual(await receipts.execute(request), { calls: 1 });
  assert.deepEqual({ ...blocker.prepare("SELECT id, fingerprint, phase FROM durable_command_receipts").get() }, {
    id: "original-command", fingerprint: "immutable-fingerprint", phase: "completed",
  });
  assert.equal(calls, 1);
});

test("busy receipt settlement retries only SQL while runtime timers continue", async (t) => {
  const { receipts, blocker } = await fixture(t);
  let calls = 0;
  let releaseStarted;
  const effectStarted = new Promise((resolve) => { releaseStarted = resolve; });
  const request = command(async () => {
    calls += 1;
    blocker.exec("BEGIN IMMEDIATE");
    releaseStarted();
    return { accepted: true };
  });
  const result = receipts.execute(request);
  await effectStarted;
  await delay(35);
  assert.equal(blocker.prepare("SELECT phase FROM durable_command_receipts").get().phase, "effect-started");
  blocker.exec("COMMIT");
  assert.deepEqual(await result, { accepted: true });
  assert.deepEqual(await receipts.execute(request), { accepted: true });
  assert.equal(calls, 1, "SQLite retry must never re-enter the external effect");
});

test("exhausted admission budget neither claims receipt nor runs effect; same identity can retry", async (t) => {
  const { receipts, blocker } = await fixture(t, { mutationTimeoutMs: 30 });
  blocker.exec("BEGIN IMMEDIATE");
  let calls = 0;
  const request = command(async () => ++calls);
  await assert.rejects(receipts.execute(request), (error) => {
    assert.match(error.message, /database is locked/iu);
    assert.equal(error.requestId, "original-command");
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM durable_command_receipts").get().count, 0);
  blocker.exec("COMMIT");
  assert.equal(await receipts.execute(request), 1);
  assert.equal(calls, 1);
});

test("exhausted settlement budget preserves unknown effect for exact reconciliation", async (t) => {
  const { receipts, blocker, file } = await fixture(t, { mutationTimeoutMs: 30 });
  let calls = 0;
  await assert.rejects(receipts.execute(command(async () => {
    calls += 1;
    blocker.exec("BEGIN IMMEDIATE");
    return { accepted: true };
  })), /database is locked/iu);
  const pending = blocker.prepare("SELECT * FROM durable_command_receipts").get();
  assert.equal(pending.id, "original-command");
  assert.equal(pending.fingerprint, "immutable-fingerprint");
  assert.equal(pending.phase, "effect-started");
  assert.equal(pending.result_json, null);
  assert.equal(pending.error, null);
  blocker.exec("COMMIT");
  const recovered = new SqliteDurableCommandReceipts({ file, isProcessAlive: () => false });
  try {
    assert.deepEqual(await recovered.execute(command(async () => {
      calls += 1;
      assert.fail("unknown effects cannot be replayed");
    }, { reconcile: async (record) => {
      assert.equal(record.id, "original-command");
      assert.equal(record.fingerprint, "immutable-fingerprint");
      return { resolved: true, result: { accepted: true } };
    } })), { accepted: true });
    assert.equal(blocker.prepare("SELECT phase FROM durable_command_receipts").get().phase, "reconciled");
    assert.equal(calls, 1);
  } finally {
    await recovered.close();
  }
});

test("receipt initialization under an existing WAL writer yields until schema is available", async (t) => {
  const { blocker, file } = await fixture(t);
  blocker.exec("BEGIN IMMEDIATE");
  const newcomer = new SqliteDurableCommandReceipts({ file });
  const request = newcomer.execute(command(async () => "ready"));
  await delay(35);
  blocker.exec("COMMIT");
  try {
    assert.equal(await request, "ready");
  } finally {
    await newcomer.close();
  }
});

test("an external effect can await another receipt without holding the SQL queue", { timeout: 2_000 }, async (t) => {
  const { receipts, blocker } = await fixture(t);
  const result = await receipts.execute(command(async () => receipts.execute({
    id: "independent-command",
    fingerprint: "independent-fingerprint",
    action: "nested-command",
    effect: async () => "both completed",
  })));
  assert.equal(result, "both completed");
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM durable_command_receipts WHERE phase = 'completed'").get().count, 2);
});

test("receipt close waits for an enqueued SQLite acknowledgement under contention", async (t) => {
  const { receipts, blocker } = await fixture(t);
  await receipts.execute(command(async () => "completed"));
  blocker.exec("BEGIN IMMEDIATE");
  const acknowledged = receipts.forget("original-command");
  let closed = false;
  const closing = receipts.close().then(() => { closed = true; });
  await delay(35);
  assert.equal(closed, false, "close cannot cut off accepted pending SQL");
  blocker.exec("COMMIT");
  assert.equal(await acknowledged, true);
  await closing;
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM durable_command_receipts").get().count, 0);
});

test("receipt close fence preserves the individual mutation failure and retained receipt", async (t) => {
  const { receipts, blocker } = await fixture(t, { mutationTimeoutMs: 30 });
  await receipts.execute(command(async () => "completed"));
  blocker.exec("BEGIN IMMEDIATE");
  const rejected = assert.rejects(receipts.forget("original-command"), /database is locked/iu);
  const closing = receipts.close();
  await rejected;
  await closing;
  assert.equal(blocker.prepare("SELECT phase FROM durable_command_receipts WHERE id = ?").get("original-command").phase, "completed");
  blocker.exec("COMMIT");
});
