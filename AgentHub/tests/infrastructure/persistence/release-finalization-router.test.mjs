import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("./release-finalization-router.fixture.mjs", import.meta.url));
const run = async (directory, mode) => {
  const { stdout } = await execute(process.execPath, [fixture, directory, mode], {
    windowsHide: true, timeout: 30_000, encoding: "utf8",
  });
  return JSON.parse(stdout.trim());
};

for (const [mode, code] of [["closure-crash", 23], ["ack-crash", 24]]) {
  test(`real Desktop router recovers ${mode} from exact canonical finalization`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hub-finalization-router-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await assert.rejects(run(directory, mode), (error) => error.code === code);
    const database = new DatabaseSync(path.join(directory, "receipts.sqlite"));
    try {
      const receipt = database.prepare("SELECT phase FROM durable_command_receipts WHERE id = ?")
        .get("stable-finalization-command");
      assert.equal(receipt?.phase, mode === "closure-crash" ? "effect-started" : undefined);
    } finally { database.close(); }
    const resumed = await run(directory, "resume");
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.finalization.status, "completed");
    assert.equal(resumed.result.releaseAlreadyCompleted, true);
    assert.equal(resumed.calls.includes("closure"), false);
    assert.equal(resumed.calls.includes("verify"), false);
    assert.equal(resumed.calls.includes("plan"), false);
    assert.equal(resumed.calls.includes("reconcile"), mode === "closure-crash");
    assert.equal(resumed.calls.includes("dev"), mode === "closure-crash");
    const replayed = await run(directory, "resume");
    assert.equal(replayed.result.finalization.status, "completed");
    assert.deepEqual(replayed.calls, []);
  });
}

test("interrupted unrelated Desktop mutation stays unknown and is never replayed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-finalization-generic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(run(directory, "generic-crash"), (error) => error.code === 25);
  const resumed = await run(directory, "generic-resume");
  assert.match(resumed.error, /Outcome of interrupted rename-workspace command is unknown/u);
  assert.deepEqual(resumed.calls, []);
});


test("known post-closure write failure returns retry-required instead of a poisoned failed receipt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-finalization-write-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await run(directory, "checkpoint-failure");
  assert.equal(first.error, undefined);
  assert.equal(first.result.finalization.status, "retry_required");
  const cached = await run(directory, "resume");
  assert.equal(cached.result.finalization.status, "retry_required");
  assert.deepEqual(cached.calls, []);
  const resumed = await run(directory, "new-attempt");
  assert.equal(resumed.result.finalization.status, "completed");
  assert.equal(resumed.calls.includes("closure"), false);
  assert.equal(resumed.calls.includes("verify"), false);
});
