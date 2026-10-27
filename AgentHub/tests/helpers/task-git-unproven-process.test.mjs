import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeTaskGitRepository, unprovenProcessTaskGit } from "./task-git-unproven-process.mjs";

test("unproven descendant fixture waits for readiness and releases mutation after guard refusals", {
  skip: process.platform !== "win32" ? "Windows taskkill contract" : false,
}, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-ready-"));
  let guarded;
  context.after(async () => {
    await guarded?.close();
    await rm(root, { recursive: true, force: true });
  });
  const repositoryRoot = path.join(root, "repository");
  await initializeTaskGitRepository(repositoryRoot);
  const taskId = "fixture-ready-task";
  guarded = await unprovenProcessTaskGit({ context, root: repositoryRoot,
    dataDir: path.join(root, "data"), taskId });
  const request = { taskId, projectRoot: repositoryRoot };
  await assert.rejects(guarded.service.prepare(request), /process tree stop is unproven/u);
  assert.equal(guarded.guardSeen(), true);
  assert.ok(Number(await readFile(path.join(repositoryRoot, "guard-child.pid"), "utf8")) > 0);
  await assert.rejects(access(guarded.staleMutation), { code: "ENOENT" });
  await assert.rejects(guarded.service.prepare(request), /unresolved process-tree guard requires operator proof/u);
  await assert.rejects(access(guarded.staleMutation), { code: "ENOENT" });
  assert.equal(await guarded.waitForStaleMutation(), "stale mutation attempted");
  assert.equal(await readFile(guarded.staleMutation, "utf8"), "stale mutation attempted");
  await guarded.proveAndRecover();
  const prepared = await guarded.service.prepare(request);
  assert.ok(prepared.projectRoot);
});

test("unproven descendant fixture closes the real child before cleanup after an early failure", {
  skip: process.platform !== "win32" ? "Windows taskkill contract" : false,
}, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-ready-"));
  let guarded;
  context.after(async () => {
    await guarded?.close();
    await rm(root, { recursive: true, force: true });
  });
  const repositoryRoot = path.join(root, "repository");
  await initializeTaskGitRepository(repositoryRoot);
  const taskId = "fixture-early-failure-task";
  guarded = await unprovenProcessTaskGit({ context, root: repositoryRoot,
    dataDir: path.join(root, "data"), taskId });
  await assert.rejects(guarded.service.prepare({ taskId, projectRoot: repositoryRoot }), /process tree stop is unproven/u);
  const pid = Number(await readFile(path.join(repositoryRoot, "guard-child.pid"), "utf8"));
  await assert.rejects(async () => {
    try { throw new Error("controlled early fixture failure"); }
    finally {
      await guarded.close();
      await rm(root, { recursive: true, force: true });
    }
  }, /controlled early fixture failure/u);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(access(root), { code: "ENOENT" });
});
