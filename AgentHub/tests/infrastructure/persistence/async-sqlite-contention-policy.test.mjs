import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AsyncSqliteMutationQueue } from "../../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs";

test("explicit no-retry contention preserves the original failure and the next queued write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-contention-policy-"));
  const file = path.join(root, "fixture.sqlite");
  const writer = new DatabaseSync(file);
  const blocker = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA busy_timeout=0; CREATE TABLE items(value TEXT)");
    blocker.exec("BEGIN IMMEDIATE");
    const queue = new AsyncSqliteMutationQueue();
    let calls = 0;
    let original;
    await assert.rejects(queue.run(() => {
      calls += 1;
      try { writer.prepare("INSERT INTO items VALUES (?)").run("refused"); }
      catch (error) { original = error; throw error; }
    }, { retryContention: false }), (error) => error === original && /locked|busy/iu.test(error.message));
    assert.equal(calls, 1);
    assert.equal(queue.diagnostics().retries, 0);
    blocker.exec("COMMIT");
    await queue.run(() => writer.prepare("INSERT INTO items VALUES (?)").run("next"));
    await queue.idle();
    assert.deepEqual(writer.prepare("SELECT value FROM items").all().map((row) => row.value), ["next"]);
    assert.equal(queue.diagnostics().failed, 1);
    assert.equal(queue.diagnostics().completed, 1);
  } finally {
    blocker.close();
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});
