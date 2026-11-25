import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readManualTestContourOwnerLifecycle } from "../../src/runtime/test-contour-owner-lifecycle.mjs";
import { createOwnerRuntimeLifecycle } from "../helpers/owner-runtime-lifecycle.fixture.mjs";

const identity = { provider: "codex", threadId: "queued-owner-thread", turnId: "queued-owner-turn" };

for (const operation of ["removeActive", "recordTerminal"]) {
  test(`ordinary fixture ${operation} waits for a competing SQLite writer and then commits through its existing owner`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hub-queued-owner-"));
    let lifecycle, blocker, write, held = false;
    t.after(async () => {
      if (held) blocker.exec("ROLLBACK");
      await write?.catch(() => {});
      blocker?.close();
      await lifecycle?.close();
      await rm(root, { recursive: true, force: true });
    });
    lifecycle = await createOwnerRuntimeLifecycle(root, identity);
    // This raw transaction is intentional contention, not an ordinary fixture
    // mutation. The production writer must await it rather than bypass its queue.
    blocker = new DatabaseSync(path.join(root, "runtime.sqlite"));
    blocker.exec("BEGIN IMMEDIATE");
    held = true;
    const started = performance.now();
    let outcome = "pending";
    write = Promise.resolve().then(() => lifecycle[operation]());
    write.then(() => { outcome = "committed"; }, () => { outcome = "failed"; });
    // Advance dispatch, not an elapsed startup budget. While the external
    // transaction is held, the addressed write cannot commit on this database.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outcome, "pending", "ordinary fixture writes must wait in their owner, not fail directly with SQLITE_BUSY");
    blocker.exec("COMMIT");
    held = false;
    await write;
    assert.equal(outcome, "committed");
    const observed = await readManualTestContourOwnerLifecycle({ ...identity, runtimeDataDir: root });
    assert.equal(observed.state, operation === "removeActive" ? "unknown" : "terminal");
    assert.equal(observed.status, operation === "removeActive" ? null : "aborted");
    assert.equal(observed.identity.threadId, identity.threadId);
    assert.equal(observed.identity.turnId, identity.turnId);
    t.diagnostic(JSON.stringify({ requestId: `fixture-${operation}`, outcome, enqueueToCommitMs: performance.now() - started,
      qualification: "disposable external transaction; not production latency" }));
  });
}
