// Retained pre-cutover checkpoint data for recovery tests. The caller supplies
// the synthetic historical Git tree; this fixture performs no composition.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";

export async function retainLegacyPreparedCandidate({ candidate, baseCommit,
  planRevision, tasks, tree, parents }) {
  const root = await realpath(candidate.releaseRoot);
  const relative = path.relative(await realpath(os.tmpdir()), root);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const git = (args, options = {}) => runTaskGitCommand(args, { ...options, cwd: root });
  assert.equal(await git(["rev-parse", `${tree}^{tree}`]), tree);
  const preReleaseHead = await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]),
    "-m", "retained historical candidate fixture"]);
  const oldManifest = JSON.parse(await readFile(candidate.manifestFile, "utf8"));
  const { compositionPolicy, merges, cutover, ...identity } = oldManifest;
  const manifest = { ...identity, projectionPolicy: "task-net-ancestry-v2",
    planRevision, baseCommit, tasks };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestHash = createHash("sha256").update(manifestText).digest("hex");
  const manifestFile = path.join(path.dirname(candidate.manifestFile), `${manifestHash}.json`);
  await writeFile(manifestFile, manifestText, { encoding: "utf8", flag: "wx" });
  const checkpoint = { schemaVersion: 2, phase: "prepared", netProjectedTaskIds: tasks.map(t => t.taskId),
    planRevision, manifestHash, manifestFile, baseCommit, preReleaseHead,
    updatedAt: "2026-08-23T00:00:00.000Z" };
  const checkpointFile = path.join(path.dirname(path.dirname(candidate.manifestFile)), "checkpoint.json");
  await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await git(["update-ref", "refs/heads/PreRelease", preReleaseHead, candidate.preReleaseHead]);
  await git(["read-tree", "--reset", "-u", preReleaseHead]);
  return { ...candidate, ...checkpoint, checkpointFile, manifest, frozenTasks: tasks };
}
