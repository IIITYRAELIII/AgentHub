import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFrozenReleasePublication, readPublicationReleasePlan } from "../../../src/infrastructure/process/frozen-release-publication.mjs";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";
import { releasePublicationBaseCommit } from "../../../src/domain/release-base-provenance.mjs";

const execute = promisify(execFile);

async function realGit(cwd, ...args) {
  return (await execute("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();
}

test("publication planning tolerates Git work beyond the interactive Desktop deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plan = { revision: "slow-plan" };
  const control = (action, params, options) => new Promise((resolve, reject) => {
    assert.equal(action, "read-workspace-release-plan");
    assert.equal(params.workspaceId, "workspace");
    assert.equal(options.runtimeRoot, "runtime");
    const timer = setTimeout(() => reject(new Error("Desktop control request timed out")), options.timeoutMs ?? 10_000);
    setTimeout(() => { clearTimeout(timer); resolve(plan); }, 11_000);
  });
  const result = readPublicationReleasePlan(control, "workspace", "runtime");
  t.mock.timers.tick(11_000);
  assert.equal(await result, plan);
});

function fixture(overrides = {}) {
  const root = path.resolve("test-release");
  const primaryRoot = path.resolve("test-primary");
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const manifest = Buffer.from(JSON.stringify({ primaryRoot, releaseRoot: root, planRevision: "plan", baseCommit: base, workspaceId: "workspace" }));
  const checkpoint = { planRevision: "plan", baseCommit: base, preReleaseHead: head, manifestHash: createHash("sha256").update(manifest).digest("hex") };
  const commands = [];
  const calls = [];
  let remote = overrides.remote ?? base;
  const identity = { revision: head, worktreeRoot: root, validationMode: "full", finalizationCommandId: "finalize-attempt-1" };
  const adapter = createFrozenReleasePublication({
    repositoryRoot: root,
    verifyClone: async () => ({ primaryRoot, releaseRoot: root }),
    read: async (file) => file.endsWith("checkpoint.json") ? JSON.stringify(checkpoint) : overrides.manifest ?? manifest,
    runGit: async (args, options) => {
      commands.push({ args, cwd: options.cwd });
      if (args[0] === "rev-parse") return args[1].startsWith("HEAD") ? head : remote;
      if (args[0] === "push") { remote = head; if (overrides.pushResponseLost) throw new Error("response lost"); }
      if (args[0] === "ls-remote") return `${remote}\trefs/heads/main`;
      return "";
    },
    control: async (action, params, options) => {
      calls.push({ action, params, options });
      if (action.startsWith("read-")) return { revision: overrides.plan ?? "plan", candidates: [{ gitReferences: [{ projectRoot: primaryRoot }] }] };
      return { finalization: { status: overrides.finalization ?? "completed" } };
    },
    readPlan: overrides.readPlan,
  });
  return { adapter, identity, commands, calls, checkpoint, primaryRoot };
}

test("frozen publication validates the manifest and pushes only its candidate with an exact lease", async () => {
  const f = fixture();
  f.identity.release = await f.adapter.prepare(f.identity);
  await f.adapter.publishGit(f.identity);
  assert.deepEqual(f.commands.find((c) => c.args[0] === "push").args, [
    "push", `--force-with-lease=refs/heads/main:${"a".repeat(40)}`, "origin", `${"b".repeat(40)}:refs/heads/main`,
  ]);
  assert.equal(f.commands.some((c) => c.cwd === f.primaryRoot), false);
  assert.ok(f.calls.filter((c) => c.action === "read-workspace-release-plan")
    .every((c) => c.options.timeoutMs === 120_000));
});

test("candidate plan reader fences prepare and pre-push without consulting stale installed planning", async () => {
  const planReads = [];
  const f = fixture({
    plan: "installed-stale-plan",
    readPlan: async (workspaceId) => {
      planReads.push(workspaceId);
      return { revision: "plan", candidates: [{ gitReferences: [{ projectRoot: path.resolve("test-primary") }] }] };
    },
  });
  f.identity.release = await f.adapter.prepare(f.identity);
  await f.adapter.publishGit(f.identity);
  assert.deepEqual(planReads, ["workspace", "workspace"]);
  assert.equal(f.calls.some((call) => call.action === "read-workspace-release-plan"), false);
});

test("a candidate plan drift between preparation and publication fails before push", async () => {
  let reads = 0;
  const f = fixture({ readPlan: async () => ({
    revision: ++reads === 1 ? "plan" : "changed-plan",
    candidates: [{ gitReferences: [{ projectRoot: path.resolve("test-primary") }] }],
  }) });
  f.identity.release = await f.adapter.prepare(f.identity);
  await assert.rejects(f.adapter.publishGit(f.identity), /plan changed/u);
  assert.equal(f.commands.some((command) => command.args[0] === "push"), false);
});

test("completion-only resume uses immutable release evidence without a pre-install plan read", async () => {
  const f = fixture({
    remote: "b".repeat(40),
    readPlan: async () => assert.fail("completion-only resume must not read a pre-install plan"),
  });
  f.identity.release = await f.adapter.prepare(f.identity, { completionOnly: true });
  assert.equal((await f.adapter.finalizePublication(f.identity)).status, "completed");
});

test("moved origin and changed plan fail before push", async () => {
  for (const options of [{ remote: "c".repeat(40) }, { plan: "other-plan" }]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.publishGit(f.identity), /changed/u);
    assert.equal(f.commands.some((c) => c.args[0] === "push"), false);
  }
});

test("lost Git push response reconciles the same revision without another push", async () => {
  const f = fixture({ pushResponseLost: true });
  await assert.rejects(f.adapter.publishGit(f.identity), /response lost/u);
  assert.equal((await f.adapter.publishGit(f.identity)).status, "already_published");
  assert.equal(f.commands.filter((c) => c.args[0] === "push").length, 1);
});

test("real isolated Git endpoint reconciles a lost push reply without a second external effect", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frozen-release-real-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "origin.git");
  const primaryRoot = path.join(root, "primary");
  const releaseRoot = path.join(root, "release", "repository");
  await realGit(root, "init", "--bare", "--initial-branch=main", remote);
  await realGit(root, "clone", remote, primaryRoot);
  await realGit(primaryRoot, "config", "user.name", "Agent Hub Test");
  await realGit(primaryRoot, "config", "user.email", "agent-hub@example.invalid");
  await writeFile(path.join(primaryRoot, "release.txt"), "base\n", "utf8");
  await realGit(primaryRoot, "add", "release.txt");
  await realGit(primaryRoot, "commit", "-m", "base");
  await realGit(primaryRoot, "push", "-u", "origin", "main");
  const baseCommit = await realGit(primaryRoot, "rev-parse", "HEAD");
  await mkdir(path.dirname(releaseRoot), { recursive: true });
  await realGit(path.dirname(releaseRoot), "clone", remote, releaseRoot);
  await realGit(releaseRoot, "config", "user.name", "Agent Hub Test");
  await realGit(releaseRoot, "config", "user.email", "agent-hub@example.invalid");
  await writeFile(path.join(releaseRoot, "release.txt"), "candidate\n", "utf8");
  await realGit(releaseRoot, "commit", "-am", "candidate");
  const candidateCommit = await realGit(releaseRoot, "rev-parse", "HEAD");
  const evidenceRoot = path.join(root, "release", "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const manifest = Buffer.from(JSON.stringify({
    primaryRoot, releaseRoot, workspaceId: "workspace", planRevision: "plan-real",
    baseCommit, publication: { head: candidateCommit },
  }));
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  await writeFile(path.join(evidenceRoot, `${manifestHash}.json`), manifest);
  await writeFile(path.join(root, "release", "checkpoint.json"), JSON.stringify({
    planRevision: "plan-real", baseCommit, preReleaseHead: candidateCommit, manifestHash,
  }));
  let pushes = 0;
  let loseReply = true;
  const adapter = createFrozenReleasePublication({
    repositoryRoot: releaseRoot,
    verifyClone: async () => ({ primaryRoot, releaseRoot }),
    readPlan: async () => ({
      revision: "plan-real",
      candidates: [{ gitReferences: [{ projectRoot: primaryRoot }] }],
    }),
    runGit: async (args, { cwd }) => {
      if (args[0] === "push") {
        pushes += 1;
        const result = await realGit(cwd, ...args);
        if (loseReply) {
          loseReply = false;
          throw new Error("injected lost push reply");
        }
        return result;
      }
      return realGit(cwd, ...args);
    },
    read: readFile,
  });
  const identity = {
    revision: candidateCommit,
    worktreeRoot: releaseRoot,
    workspaceId: "workspace",
    validationMode: "full",
  };
  await assert.rejects(adapter.publishGit(identity), /injected lost push reply/u);
  assert.equal(await realGit(remote, "rev-parse", "refs/heads/main"), candidateCommit);
  assert.equal((await adapter.publishGit(identity)).status, "already_published");
  assert.equal(pushes, 1);
});

test("corrupt immutable manifest is not accepted", async () => {
  const f = fixture({ manifest: Buffer.from("{}") });
  await assert.rejects(f.adapter.prepare(f.identity), /digest changed/u);
});

test("completion uses saved manifest after Await checkpoint replacement and preserves command identity", async () => {
  const f = fixture({ remote: "b".repeat(40) });
  f.identity.release = await f.adapter.prepare(f.identity);
  f.checkpoint.planRevision = "later-plan";
  await assert.rejects(f.adapter.prepare(f.identity), /identity mismatch/u);
  assert.equal((await f.adapter.prepare(f.identity, { completionOnly: true })).planRevision, "plan");
  const result = await f.adapter.finalizePublication(f.identity);
  assert.equal(result.status, "completed");
  const call = f.calls.find((c) => c.action === "complete-workspace-release");
  assert.equal(call.params.expectedPlanRevision, "plan");
  assert.equal(call.options.commandId, "finalize-attempt-1");
  assert.deepEqual(f.commands.filter((c) => c.cwd === f.primaryRoot).map((c) => c.args[0]), ["fetch"]);
});

test("partial finalization is reported for continuation, not success", async () => {
  const f = fixture({ remote: "b".repeat(40), finalization: "retry_required" });
  f.identity.release = await f.adapter.prepare(f.identity);
  assert.equal((await f.adapter.finalizePublication(f.identity)).status, "retry_required");
});

test("release absent from origin cannot close Tasks", async () => {
  const f = fixture();
  f.identity.release = await f.adapter.prepare(f.identity);
  await assert.rejects(f.adapter.finalizePublication(f.identity), /missing from origin/u);
  assert.equal(f.calls.some((c) => c.action === "complete-workspace-release"), false);
});

function installedProvenance(base, origin, published, sourceTree = "f".repeat(40)) {
  const taskId = "synthetic-task", result = "d".repeat(40);
  return { schemaVersion: 1, kind: "installed-local-source-v1",
    publishedBaseCommit: published, agreedMainCommit: published, sourceBaseCommit: base,
    sourceBaseTree: sourceTree, sourcePatchSha256: "1".repeat(64),
    installedReleaseId: "synthetic-installed", installedManifestSha256: "2".repeat(64),
    planRevision: "synthetic-plan", selectionHash: "3".repeat(64),
    approvedOriginMainCommit: origin, adoptions: [{ taskId, resultCommit: result,
      recordRef: `refs/agent-hub/upstream-adoptions/${taskId}/${result}/${origin}`,
      recordHash: "4".repeat(40), adoptedCommit: origin, acceptedLocalMainCommit: published }] };
}

test("publication base uses only the sealed provenance and keeps local source separate", () => {
  const base = "a".repeat(40), origin = "b".repeat(40), published = "c".repeat(40);
  const p = installedProvenance(base, origin, published);
  assert.equal(releasePublicationBaseCommit({ baseCommit: base, baseProvenance: p }), origin);
  const plain = { ...p }; delete plain.approvedOriginMainCommit; delete plain.adoptions;
  assert.equal(releasePublicationBaseCommit({ baseCommit: base, baseProvenance: plain }), published);
  assert.equal(releasePublicationBaseCommit({ baseCommit: base }), base);
  assert.throws(() => releasePublicationBaseCommit({ baseCommit: published, baseProvenance: p }), /pins/u);
  assert.throws(() => releasePublicationBaseCommit({ baseCommit: base,
    baseProvenance: { ...p, approvedOriginMainCommit: published } }), /adoption pins/u);
  assert.throws(() => releasePublicationBaseCommit({ baseCommit: base,
    baseProvenance: { ...p, arbitraryAuthority: true } }), /exact installed/u);
});

test("real Git approved incoming publication preserves source, remote lease and lost-response identity", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "approved-publication-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "origin.git"), repo = path.join(root, "release", "repository");
  await realGit(root, "init", "--bare", "--initial-branch=main", remote);
  await mkdir(path.dirname(repo), { recursive: true });
  await realGit(root, "clone", remote, repo);
  await realGit(repo, "config", "user.name", "Synthetic Test");
  await realGit(repo, "config", "user.email", "synthetic@example.invalid");
  await writeFile(path.join(repo, "base"), "base");
  await realGit(repo, "add", "base"); await realGit(repo, "commit", "-m", "base");
  const published = await realGit(repo, "rev-parse", "HEAD");
  await realGit(repo, "push", "origin", "HEAD:main");
  await realGit(repo, "checkout", "-b", "local-source");
  await writeFile(path.join(repo, "local"), "retained");
  await realGit(repo, "add", "local"); await realGit(repo, "commit", "-m", "local repair");
  const base = await realGit(repo, "rev-parse", "HEAD");
  const tree = await realGit(repo, "rev-parse", "HEAD^{tree}");
  await realGit(repo, "checkout", "-b", "incoming", published);
  await writeFile(path.join(repo, "incoming"), "approved");
  await realGit(repo, "add", "incoming"); await realGit(repo, "commit", "-m", "incoming");
  const origin = await realGit(repo, "rev-parse", "HEAD");
  await realGit(repo, "push", "origin", "HEAD:main");
  await realGit(repo, "checkout", "local-source");
  await realGit(repo, "merge", "--no-edit", "incoming");
  const commit = await realGit(repo, "rev-parse", "HEAD");
  const provenance = installedProvenance(base, origin, published, tree);
  const manifest = { primaryRoot: repo, releaseRoot: repo, planRevision: "plan",
    workspaceId: "workspace", baseCommit: base, baseProvenance: provenance };
  let checkpoint = { planRevision: "plan", baseCommit: base, preReleaseHead: commit,
    baseProvenance: provenance, manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
  const identity = { revision: commit, worktreeRoot: repo, workspaceId: "workspace" };
  const calls = []; let lostReply = true;
  const adapter = createFrozenReleasePublication({ repositoryRoot: repo,
    verifyClone: async () => ({ primaryRoot: repo, releaseRoot: repo }),
    read: async file => file.endsWith("checkpoint.json") ? JSON.stringify(checkpoint) : Buffer.from(JSON.stringify(manifest)),
    readPlan: async () => ({ revision: "plan", candidates: [{ gitReferences: [{ projectRoot: repo }] }] }),
    runGit: async (args, { cwd }) => {
      calls.push(args);
      const result = await realGit(cwd, ...args);
      if (args[0] === "push" && lostReply) { lostReply = false; throw new Error("lost push reply"); }
      return result;
    },
  });
  const target = { targetId: "synthetic", repositoryRoot: repo };
  const generation = { generation: 1, identitySha256: "synthetic",
    candidates: [{ repositoryRoot: repo, releaseRoot: repo, baseCommit: base, commit, manifest }] };
  const readback = new ReleaseOperationPublication({ dataDir: path.join(root, "data"), runtimeRoot: root,
    environment: {}, readPublicationStateImpl: async () => null,
    publicationRunStoreFactory: () => ({ read: async () => null }), processAliveImpl: () => false });
  assert.equal((await readback.readback({ operation: { operationId: "synthetic" }, generation, target })).status, "not_applied");
  const injected = new ReleaseOperationPublication({ dataDir: path.join(root, "data"), runtimeRoot: root,
    readPublicationStateImpl: async () => null, publicationRunStoreFactory: () => ({ read: async () => null }),
    processAliveImpl: () => false, gitRemoteHeadImpl: async () => "e".repeat(40) });
  assert.equal((await injected.readback({ operation: { operationId: "synthetic" }, generation, target })).status, "unknown");
  checkpoint = { ...checkpoint, baseProvenance: undefined };
  await assert.rejects(adapter.prepare(identity), /provenance changed/u);
  checkpoint = { ...checkpoint, baseProvenance: provenance };
  identity.release = await adapter.prepare(identity);
  assert.equal(identity.release.baseCommit, base);
  assert.equal(identity.release.publicationBaseCommit, origin);
  await assert.rejects(adapter.publishGit(identity), /lost push reply/u);
  assert.equal(await realGit(remote, "rev-parse", "main"), commit);
  assert.equal((await adapter.publishGit(identity)).status, "already_published");
  const pushes = calls.filter(x => x[0] === "push");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][1], `--force-with-lease=refs/heads/main:${origin}`);
  assert.ok(calls.some(x => x[0] === "merge-base" && x[2] === base));
  assert.ok(calls.some(x => x[0] === "merge-base" && x[2] === origin));
  assert.equal(await readFile(path.join(repo, "local"), "utf8"), "retained");
  assert.equal(await readFile(path.join(repo, "incoming"), "utf8"), "approved");

  // Real fetch/push race: advance the isolated remote after fetch. Exact lease
  // must refuse, even though the candidate still contains both approved inputs.
  await realGit(remote, "update-ref", "refs/heads/main", origin, commit);
  const race = createFrozenReleasePublication({ repositoryRoot: repo,
    verifyClone: async () => ({ primaryRoot: repo, releaseRoot: repo }),
    read: async file => file.endsWith("checkpoint.json") ? JSON.stringify(checkpoint) : Buffer.from(JSON.stringify(manifest)),
    readPlan: async () => ({ revision: "plan", candidates: [{ gitReferences: [{ projectRoot: repo }] }] }),
    runGit: async (args, { cwd }) => {
      if (args[0] === "push") await realGit(remote, "update-ref", "refs/heads/main", published, origin);
      return realGit(cwd, ...args);
    },
  });
  await assert.rejects(race.publishGit(identity));
  assert.equal(await realGit(remote, "rev-parse", "main"), published);
  await assert.rejects(adapter.publishGit(identity), /origin\/main changed/u);
});
