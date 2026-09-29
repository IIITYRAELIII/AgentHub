import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFrozenReleasePublication, readPublicationReleasePlan } from "../../../src/infrastructure/process/frozen-release-publication.mjs";

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
