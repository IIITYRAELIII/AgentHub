import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bench = path.join(path.dirname(fileURLToPath(import.meta.url)), "journal-projection-coalescing.bench.mjs");

// Keeps the HUB-220 benchmark report honest on a tiny dataset: it must not count
// an error as a delivery, must exercise pending recovery before replaying a
// duplicate, and must report the source identity it was given.
test("benchmark report counts only real deliveries and recovers pending work before a duplicate replay", async () => {
  const commit = "0".repeat(40);
  const { stdout } = await promisify(execFile)(process.execPath, [
    bench, "--records", "60", "--facts", "120", "--live", "3", "--body-bytes", "256",
    "--barrier-ms", "200", "--source-commit", commit,
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  const report = JSON.parse(stdout.slice(stdout.indexOf("{")));

  assert.equal(report.sourceCommit, commit);
  assert.equal(report.sourceCommitOrigin, "argument");
  assert.match(report.sourceDigest, /^sha256:[0-9a-f]{64}$/u);

  const values = report.delivery.firstPassValues;
  assert.ok(values.some((value) => value?.error), "the injected failure must settle as an error");
  assert.equal(report.delivery.deliveredOnFirstPass, values.filter((value) => value?.projection === true).length);
  assert.ok(report.delivery.pendingAfterFirstPass > 0);
  assert.equal(report.delivery.pendingAfterRecovery, 0);
  assert.equal(report.delivery.duplicateReplay.revisionDelta, 0);
  assert.equal(report.delivery.duplicateReplay.recordDelta, 0);

  for (const [name, value] of Object.entries(report.correctness)) {
    if (typeof value === "boolean") assert.equal(value, true, name);
  }
});
