import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preparationEnvelope } from "../helpers/release-preparation-envelope.mjs";
import { readPreparationSourceClosure, validatePreparationEnvelope } from "../../src/application/release-preparation-admission.mjs";

test("preparation-only input requires exact bounded sets and no publication/selection arguments", () => {
  const value = preparationEnvelope();
  assert.deepEqual(validatePreparationEnvelope(value), value);
  for (const mutation of [
    (v) => { v.publish = true; }, (v) => { v.tasks.push(v.tasks[0]); },
    (v) => { delete v.repositories[0].approvedTree; },
    (v) => { v.tasks[0].rowRevision = -1; },
  ]) {
    const changed = structuredClone(value);
    mutation(changed);
    assert.throws(() => validatePreparationEnvelope(changed), { code: "RELEASE_PREPARATION_REJECTED" });
  }
});

test("preparation-only runtime closure detects added/changed source and excludes documentation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-preparation-closure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "owner.mjs"), "export const owner=1;");
  const first = await readPreparationSourceClosure(root);
  await writeFile(path.join(root, "REPORT.md"), "notes");
  assert.deepEqual(await readPreparationSourceClosure(root), first);
  await writeFile(path.join(root, "src", "owner.mjs"), "export const owner=2;");
  assert.notEqual((await readPreparationSourceClosure(root)).hash, first.hash);
  await symlink(path.join(root, "src"), path.join(root, "src", "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readPreparationSourceClosure(root), /link/);
});
