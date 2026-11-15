import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { fixtureAllocation } from "../../helpers/fixture-allocation.mjs";
import { guardedPreparationGit } from "../../../src/infrastructure/filesystem/preparation-git-isolation.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const git = (cwd, ...args) => runTaskGitCommand(args, { cwd });

test("fresh actual Await and generation reuse owned inputs without duplicate history transport", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-producer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git"), primary = path.join(root, "primary");
  const dataDir = path.join(root, "data");
  await git(root, "init", "--bare", "-b", "main", origin);
  await mkdir(primary); await git(primary, "init", "-b", "main");
  await git(primary, "config", "core.autocrlf", "false");
  await git(primary, "remote", "add", "origin", origin);
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n*.bin -text\n");
  await writeFile(path.join(primary, "existing.bin"), randomBytes(512 * 1024));
  await writeFile(path.join(primary, "AgentHub", "package.json"), JSON.stringify({ name: "agent-hub", version: "2026.8.23" }));
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), JSON.stringify({ name: "agent-hub", version: "2026.8.23", packages: {} }));
  const commit = async message => {
    await git(primary, "add", ".");
    await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", message);
    return git(primary, "rev-parse", "HEAD");
  };
  const base = await commit("main");
  await git(primary, "push", "-u", "origin", "main");
  await git(primary, "checkout", "-b", "selected");
  await writeFile(path.join(primary, "selected.txt"), "exact selected body\n");
  const result = await commit("selected");
  await git(primary, "checkout", "main");
  const service = new ReleaseGitWorkspaceService({ dataDir,
    environment: { AGENT_HUB_ROOT: path.join(root, "runtime") } });
  const input = { workspaceId: "fixture", planRevision: "same-input",
    projectRoot: primary, approvedBaseCommit: base,
    frozenTasks: [{ taskId: "selected", taskRevision: 1, baseCommit: base, resultCommit: result }] };
  const initialAllocation = fixtureAllocation(dataDir);
  const candidate = await service.prepareCandidate(input);
  assert.equal(await git(candidate.releaseRoot, "show", "HEAD:selected.txt"), "exact selected body");
  assert.equal(await git(primary, "rev-parse", "HEAD"), base);
  assert.equal(await git(primary, "status", "--porcelain=v1"), "");
  const mergeParent = path.join(path.dirname(candidate.releaseRoot), "native-merges");
  const merges = await readdir(mergeParent);
  assert.equal(merges.length, 1);
  const capture = path.join(mergeParent, merges[0]);
  const transport = path.join(capture, "source.bundle");
  const oldTransport = await lstat(transport).catch(e => { if (e.code === "ENOENT") return null; throw e; });
  t.diagnostic(JSON.stringify({ fixtureHistoryB: 512 * 1024,
    freshAwaitFullBundleB: oldTransport?.size ?? 0, dependencyCopies: 0,
    createdAllocationB: fixtureAllocation(dataDir)?.uniqueAllocatedBytes - (initialAllocation?.uniqueAllocatedBytes ?? 0) }));
  assert.equal(oldTransport, null, "fresh Await must provision owned immutable inputs instead of packing a second full history");
  const validated = await service.validateCandidate(input);
  assert.equal(validated.tree, candidate.tree);
  const generation = await service.prepareGeneration({ ...input,
    operationId: "fixture-operation", generation: 1, freezePublication: false });
  await assert.rejects(readFile(path.join(generation.generationRoot, "source.bundle")), { code: "ENOENT" });
  assert.equal(await git(generation.releaseRoot, "show", "HEAD:selected.txt"), "exact selected body");
  assert.notEqual(await git(generation.releaseRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"), await git(primary, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  await assert.rejects(readFile(path.join(generation.releaseRoot, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  await git(generation.releaseRoot, "fsck", "--connectivity-only", "--no-dangling", result);
  await writeFile(path.join(generation.releaseRoot, "unique-untracked.txt"), "retain unique generation work");
  await service.discardGenerationCandidate(generation);
  await assert.rejects(lstat(generation.generationRoot), { code: "ENOENT" });
  const archived = path.join(dataDir, "release-generation-evidence", path.basename(generation.generationRoot));
  const receipts = (await readdir(archived)).filter(name => name.endsWith(".objects.json"));
  assert.equal(receipts.length >= 1, true);
  for (const name of receipts) {
    const receipt = JSON.parse(await readFile(path.join(archived, name)));
    assert.ok(receipt.archive.commit);
  }
  await git(candidate.releaseRoot, "fsck", "--connectivity-only", "--no-dangling", result);
});


test("invocation math retains unknown child and fences the same shared object pool", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-input-math-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary); await git(primary, "init", "-b", "main");
  await writeFile(path.join(primary, "input.txt"), "exact input"); await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "input");
  const commit = await git(primary, "rev-parse", "HEAD");
  const owner = new TaskGitWorkspaceService({ dataDir });
  let invoked = 0;
  const run = () => owner.withNativeRepositoryOwner({ sourceRoot: primary,
    repositoryRoot: path.join(root, "verification") }, ({ objects }) =>
    objects.withInputMath({ sourceRoot: primary, inputs: [commit] }, ({ repository }) =>
      guardedPreparationGit(async lease => {
        invoked++;
        const guard = await lease.beginProcessTreeGuard({ args: ["fixture-unproven-child"], cwd: repository });
        const error = Object.assign(new Error("controlled math child unknown"), { processTreeStopped: false });
        guard.markUnresolved(error);
        throw error;
      })));
  await assert.rejects(run(), /controlled math child unknown/u);
  assert.equal((await readdir(path.join(dataDir, "native-git-objects/math"))).some(name => name.startsWith("owned-")), true,
    "unproven child retains invocation input namespace");
  await assert.rejects(run()); assert.equal(invoked, 1);
});
