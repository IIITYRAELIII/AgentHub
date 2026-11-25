import assert from "node:assert/strict";
import { execFile } from "node:child_process";

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { promisify } from "node:util";

import { assertReleaseCloneForPublication, TaskIntegrationGitService } from "../../../src/infrastructure/filesystem/task-integration-git.mjs";
import { canonicalPath } from "../../../src/infrastructure/filesystem/config.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { taskBranchName, taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";

import { measureTaskOperation, withTaskOperationTiming } from "../../../src/infrastructure/process/task-operation-timing.mjs";
import { withInterprocessLocks } from "../../../src/infrastructure/process/interprocess-lock.mjs";











const execFileAsync = promisify(execFile);


async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}



async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  const dataDir = path.join(root, "data");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await git(primary, "config", "core.autocrlf", "false");
  // core.autocrlf наследуется из системной конфигурации Windows; нормализация
  // делает рабочее дерево клона релиза детерминированным на всех платформах.
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n", "utf8");
  await mkdir(path.join(primary, ".team"));
  await mkdir(path.join(primary, "1C_ACCESS"));
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, "app.txt"), "main\n", "utf8");
  await writeFile(path.join(primary, ".team", "participant.json"), "team-main\n", "utf8");
  await writeFile(path.join(primary, "1C_ACCESS", "access.json"), "access-main\n", "utf8");
  await writeFile(path.join(primary, "AgentHub", "package.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23", packages: { "": { name: "agent-hub", version: "2026.8.23" } },
  }, null, 2)}\n`, "utf8");
  const baseCommit = await commit(primary, "main");
  await git(primary, "push", "-u", "origin", "main");
  const canonicalRoot = canonicalPath(root);
  const canonicalOrigin = canonicalPath(origin);
  const canonicalPrimary = canonicalPath(primary);
  const canonicalDataDir = canonicalPath(dataDir);
  const service = new TaskIntegrationGitService({ dataDir: canonicalDataDir });
  const prepare = service.prepareCandidate.bind(service);
  // Each native preparation pins the fixture's explicitly agreed local main.
  service.prepareCandidate = async (request) => prepare({
    approvedBaseCommit: await git(canonicalPrimary, "rev-parse", "main"), ...request,
  });
  return {
    root: canonicalRoot,
    origin: canonicalOrigin,
    primary: canonicalPrimary,
    dataDir: canonicalDataDir,
    baseCommit,
    service,
  };
}

async function taskResult({ root, primary }, context, {
  branch = "HUB-126-fixture", file = "feature.txt", content = "feature\n",
} = {}) {
  const taskRoot = path.join(root, `task-${branch.replaceAll(/[^a-z0-9]+/giu, "-")}`);
  await git(primary, "worktree", "add", "-b", branch, taskRoot, "main");
  context.after(() => git(primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  await mkdir(path.dirname(path.join(taskRoot, file)), { recursive: true });
  await writeFile(path.join(taskRoot, file), content, "utf8");
  return commit(taskRoot, branch);
}



async function registeredTaskBranch(setup, context, { taskId, startCommit, baseCommit = setup.baseCommit }) {
  const branch = taskBranchName(taskId, setup.primary);
  const taskRoot = path.join(setup.root, `task-${taskId}`);
  await git(setup.primary, "worktree", "add", "-b", branch, taskRoot, startCommit);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  await git(setup.primary, "update-ref",
    `refs/agent-hub/task-bases/${taskId}/${taskRepositoryKey(setup.primary)}`, baseCommit);
  return { branch, taskRoot };
}





















for (const binaryOnly of [false, true]) test(`PreRelease preserves ${binaryOnly ? "terminal binary patch delimiters" : "binary patch bytes and a trailing blank context line"}`, async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "z-final.txt"), "before\nunchanged\n\n", "utf8");
  await writeFile(path.join(setup.primary, "binary.bin"), Buffer.from([0, 255, 1, 2, 3]));
  await commit(setup.primary, "base with trailing blank line and binary");
  await git(setup.primary, "push", "origin", "main");
  const taskRoot = path.join(setup.root, "task-HUB-patch-bytes");
  await git(setup.primary, "worktree", "add", "-b", "HUB-patch-bytes", taskRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  if (!binaryOnly) await writeFile(path.join(taskRoot, "z-final.txt"), "after\nunchanged\n\n", "utf8");
  const binary = Buffer.from([0, 254, 128, 7, 9, 0]);
  await writeFile(path.join(taskRoot, "binary.bin"), binary);
  const resultCommit = await commit(taskRoot, "binary result");
  const request = { planRevision: "plan-raw-patch", projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-patch-bytes", taskRevision: 2, resultCommit }] };
  const candidate = await setup.service.prepareCandidate(request);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", `${candidate.preReleaseHead}^{tree}`),
    await git(taskRoot, "rev-parse", `${resultCommit}^{tree}`));
  const releasedText = await execFileAsync("git", ["show", `${candidate.preReleaseHead}:z-final.txt`], {
    cwd: candidate.releaseRoot, windowsHide: true,
  });
  assert.equal(releasedText.stdout, `${binaryOnly ? "before" : "after"}\nunchanged\n\n`);
  assert.deepEqual(await readFile(path.join(candidate.releaseRoot, "binary.bin")), binary);
  const retry = await setup.service.prepareCandidate(request);
  assert.equal(retry.reused, true);
  assert.equal(retry.preReleaseHead, candidate.preReleaseHead);
});

test("candidate requires the exact agreed local main and refuses a stale base after main advances", async (context) => {
  const setup = await fixture(context);
  const service = new TaskIntegrationGitService({ dataDir: setup.dataDir });
  const request = { planRevision: "pinned-base", projectRoot: setup.primary, frozenTasks: [] };
  await assert.rejects(service.prepareCandidate(request), /exact agreed local main and plan revision/u);
  const first = await service.prepareCandidate({ ...request, approvedBaseCommit: setup.baseCommit });
  await writeFile(path.join(setup.primary, "unreviewed.txt"), "unreviewed\n");
  const incoming = await commit(setup.primary, "unreviewed local and remote main");
  await git(setup.primary, "push", "origin", "main");
  await assert.rejects(service.prepareCandidate({ ...request, approvedBaseCommit: setup.baseCommit }),
    /exact agreed local main and plan revision/u);
  assert.equal((await service.frozenCandidate(setup.primary)).preReleaseHead, first.preReleaseHead);
  await assert.rejects(git(first.releaseRoot, "show", "PreRelease:unreviewed.txt"));
  assert.equal(await git(setup.primary, "rev-parse", "main"), incoming);
});

test("release candidate uses an independent clone and leaves a clean primary attached to main", async (context) => {
  const setup = await fixture(context);
  await taskResult(setup, context, { branch: "dev", file: "dev-only.txt", content: "must-not-release\n" });
  const resultCommit = await taskResult(setup, context);
  const before = {
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    head: await git(setup.primary, "rev-parse", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
  };

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-clean",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-clean", taskRevision: 3, resultCommit }],
  });

  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.equal(candidate.primaryPreserved, true);
  assert.equal(candidate.independentGitCommonDir, true);
  assert.notEqual(candidate.releaseGitCommonDir, candidate.primaryGitCommonDir);
  assert.equal(await git(candidate.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:feature.txt`), "feature");
  assert.equal(JSON.parse(await readFile(candidate.manifestFile, "utf8")).tasks[0].taskRevision, 3);
  await assert.rejects(git(candidate.releaseRoot, "cat-file", "-e", `${candidate.preReleaseHead}:dev-only.txt`));
  assert.equal((await assertReleaseCloneForPublication({ repositoryRoot: candidate.releaseRoot })).kind,
    "agent-hub-owned-release-clone");
  await assert.rejects(
    assertReleaseCloneForPublication({ repositoryRoot: setup.primary }),
    /requires an Agent Hub-owned independent release clone/u,
  );
});




const stableRecoveryValue = (value) => {
  if (Array.isArray(value)) return value.map(stableRecoveryValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableRecoveryValue(item)]));
};














































test("frozen candidate readback validates prepared manifest identity and request binding", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-readback",
    workspaceId: "workspace-1",
    preflightRequestId: "preflight-readback-1",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-readback", taskRevision: 3, baseCommit: setup.baseCommit, resultCommit,
    }],
  });

  const readback = await setup.service.frozenCandidate(setup.primary);

  assert.equal(readback.checkpointPhase, "prepared");
  assert.equal(readback.planRevision, "plan-readback");
  assert.equal(readback.preReleaseHead, candidate.preReleaseHead);
  assert.equal(readback.preflightRequestId, "preflight-readback-1");
  assert.equal(readback.manifest.workspaceId, "workspace-1");
  assert.equal(readback.manifest.preflightRequestId, "preflight-readback-1");
  assert.deepEqual(readback.manifest.taskIds, ["task-readback"]);
  assert.deepEqual(readback.manifest.tasks, [{
    taskId: "task-readback",
    taskRevision: 3,
    baseCommit: setup.baseCommit,
    resultCommit,
  }]);

  const mergeHeadFile = await git(candidate.releaseRoot, "rev-parse", "--git-path", "MERGE_HEAD");
  const mergePath = path.resolve(candidate.releaseRoot, mergeHeadFile);
  await writeFile(mergePath, `${resultCommit}\n`, "utf8");
  await assert.rejects(() => setup.service.frozenCandidate(setup.primary), /unfinished Git operation: MERGE_HEAD/u);
  await rm(mergePath);
  const rebasePath = path.resolve(candidate.releaseRoot, await git(candidate.releaseRoot, "rev-parse", "--git-path", "rebase-merge"));
  await mkdir(rebasePath);
  await assert.rejects(() => setup.service.frozenCandidate(setup.primary), /unfinished Git operation: rebase-merge/u);
  await rm(rebasePath, { recursive: true });
  assert.equal((await setup.service.frozenCandidate(setup.primary)).preReleaseHead, candidate.preReleaseHead);

  const checkpointBefore = JSON.parse(await readFile(readback.checkpointFile, "utf8"));
  await writeFile(readback.checkpointFile, `${JSON.stringify({
    ...checkpointBefore,
    preflightRequestId: "different-request",
  }, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => setup.service.frozenCandidate(setup.primary),
    /request identity disagrees/u,
  );
  await writeFile(readback.checkpointFile, `${JSON.stringify(checkpointBefore, null, 2)}\n`, "utf8");

  await writeFile(candidate.manifestFile, "{}\n", "utf8");
  await assert.rejects(
    () => setup.service.frozenCandidate(setup.primary),
    /manifest digest changed/u,
  );
});

test("request-bound prepared checkpoint is not usable after the final primary guard fails", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, {
    branch: "HUB-final-guard",
    file: "guard.txt",
    content: "guard\n",
  });

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-final-guard",
      workspaceId: "workspace-probe",
      preflightRequestId: "request-probe",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-guard", taskRevision: 4, resultCommit }],
      validateBeforeCommit: async () => {
        await git(setup.primary, "checkout", "--detach", setup.baseCommit);
      },
    }),
    /HEAD must remain attached to refs\/heads\/main/u,
  );

  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), setup.baseCommit);
  await assert.rejects(
    () => setup.service.frozenCandidate(setup.primary),
    /release checkpoint is incomplete/u,
  );
});

test("main review timing preserves post-budget phases, errors and privacy", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "sensitive-subject.txt"), "synthetic contents\n");
  const changed = await commit(setup.primary, "synthetic private subject");
  await git(setup.primary, "push", "origin", "main");
  const rows = [];
  const result = await withTaskOperationTiming({ operationId: "main-review-timing-original", record: row => rows.push(row) }, async () => {
    for (let i = 0; i < 513; i++) await measureTaskOperation("fixture-detail", () => undefined, { detail: true });
    return setup.service.inspectMainChanges({ projectRoot: setup.primary, publishedRevision: setup.baseCommit });
  });
  assert.equal(result.localMain, changed);
  assert.equal(result.commits[0].subject, "synthetic private subject");
  assert.equal(result.approvalRequired, true);
  const phases = ["primary", "lock", "owned", "clone", "workspace-fetch", "origin-fetch", "baseline-check", "ancestry", "revision-list", "disclosures", "final-primary"];
  for (const phase of phases) {
    const events = rows.filter(row => row.stage === `release:main-review:${phase}`);
    assert.deepEqual(events.map(row => row.phase), ["start", "end"]);
    assert.equal(events[1].outcome, "ok");
    assert.ok(events[1].durationMs >= 0);
    assert.ok(events.every(row => row.operationId === "main-review-timing-original"));
  }
  assert.equal(rows.find(row => row.stage === "release:main-review:disclosures" && row.phase === "end").commitCount, 1);
  assert.ok(rows.find(row => row.stage === "trace-summary").suppressedDetailSpans > 0);
  const serialized = JSON.stringify(rows);
  for (const secret of [setup.primary, "sensitive-subject.txt", "synthetic private subject", changed]) assert.ok(!serialized.includes(secret));
  const failures = [];
  const headBefore = await git(setup.primary, "rev-parse", "HEAD");
  await assert.rejects(withTaskOperationTiming({ operationId: "main-review-error-original", record: row => failures.push(row) }, async () => {
    for (let i = 0; i < 513; i++) await measureTaskOperation("fixture-detail", () => undefined, { detail: true });
    return setup.service.inspectMainChanges({ projectRoot: setup.primary, publishedRevision: "f".repeat(40) });
  }), error => {
    assert.match(error.message, /fatal:/u);
    assert.ok(error.message.includes("f".repeat(40)));
    assert.equal(error.cause, undefined);
    return true;
  });
  for (const phase of ["baseline-fetch", "owned", "lock"]) {
    assert.equal(failures.find(row => row.stage === `release:main-review:${phase}` && row.phase === "end").outcome, "error");
  }
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), headBefore);
});

test("main review timing separates held lock admission from owned work", { timeout: 30000 }, async (context) => {
  const setup = await fixture(context);
  const lock = path.join(setup.dataDir, "locks", `release-git-${taskRepositoryKey(setup.primary)}`);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const observed = Promise.withResolvers();
  let released = false;
  let earlyOwned = false;
  const rows = [];
  const holder = withInterprocessLocks([lock], async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let review;
  try {
    review = withTaskOperationTiming({ operationId: "main-review-held-original", record: row => {
      rows.push(row);
      if (row.stage === "release:main-review:lock" && row.phase === "start") observed.resolve();
      if (row.stage === "release:main-review:owned" && row.phase === "start" && !released) earlyOwned = true;
    } }, () => setup.service.inspectMainChanges({ projectRoot: setup.primary, publishedRevision: setup.baseCommit }));
    await observed.promise;
    assert.equal(rows.some(row => row.stage === "release:main-review:owned"), false);
    released = true;
    release.resolve();
    const result = await review;
    assert.equal(result.localMain, setup.baseCommit);
    assert.equal(earlyOwned, false);
    const end = phase => rows.find(row => row.stage === `release:main-review:${phase}` && row.phase === "end");
    assert.ok(end("lock").durationMs >= end("owned").durationMs);
    assert.equal(end("lock").outcome, "ok");
  } finally {
    released = true;
    release.resolve();
    await holder;
    if (review) await review.catch(() => {});
  }
});

test("main review discloses every commit since the last successful publication", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "AgentHub", "external.mjs"), "export const external = true;\n", "utf8");
  await git(setup.primary, "add", "AgentHub/external.mjs");
  await git(setup.primary,
    "-c", "user.name=External Author",
    "-c", "user.email=12345+external-user@users.noreply.github.com",
    "commit", "-m", "external runtime change");
  const externalCommit = await git(setup.primary, "rev-parse", "HEAD");
  await git(setup.primary, "push", "origin", "main");

  const pending = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
  });

  assert.equal(pending.localMain, externalCommit);
  assert.equal(pending.originMain, externalCommit);
  assert.equal(pending.approvalRequired, true);
  assert.equal(pending.commits.length, 1);
  assert.equal(pending.commits[0].commit, externalCommit);
  assert.equal(pending.commits[0].author.githubLogin, "external-user");
  assert.equal(pending.commits[0].committer.githubLogin, "external-user");
  assert.deepEqual(pending.commits[0].files, ["AgentHub/external.mjs"]);
  assert.deepEqual(pending.commits[0].impact, ["runtime"]);

  const approved = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
    approvedLocalMainCommit: externalCommit,
    approvedOriginMainCommit: externalCommit,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvalRequired, false);
});

test("main review preserves an old dirty primary while auditing newer origin main", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "local-only.txt"), "local\n", "utf8");
  const localCommit = await commit(setup.primary, "local main preserved");
  const remoteWriter = path.join(setup.root, "remote-writer");
  await git(setup.root, "clone", setup.origin, remoteWriter);
  context.after(() => rm(remoteWriter, { recursive: true, force: true }));
  await writeFile(path.join(remoteWriter, "remote-only.txt"), "remote\n", "utf8");
  const originCommit = await commit(remoteWriter, "origin main advanced");
  await git(remoteWriter, "push", "origin", "main");
  const dirtyBytes = Buffer.from("local synthetic access remains dirty\n", "utf8");
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), dirtyBytes);
  const before = {
    head: await git(setup.primary, "rev-parse", "HEAD"),
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
    access: await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")),
  };

  const pending = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
  });

  assert.equal(pending.localMain, localCommit);
  assert.equal(pending.originMain, originCommit);
  assert.equal(pending.diverged, true);
  assert.equal(pending.approvalRequired, true);
  assert.deepEqual(pending.commits.map((item) => item.commit).sort(), [localCommit, originCommit].sort());

  const approved = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
    approvedLocalMainCommit: localCommit,
    approvedOriginMainCommit: originCommit,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvalRequired, false);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), before.access);
});

test("main review accepts a preserved old primary when the published revision is newer origin main", async (context) => {
  const setup = await fixture(context);
  const localCommit = await git(setup.primary, "rev-parse", "HEAD");
  const remoteWriter = path.join(setup.root, "bookworm-origin-writer");
  await git(setup.root, "clone", setup.origin, remoteWriter);
  context.after(() => rm(remoteWriter, { recursive: true, force: true }));
  await writeFile(path.join(remoteWriter, "app.txt"), "published newer origin\n", "utf8");
  const publishedRevision = await commit(remoteWriter, "published revision newer than primary");
  await git(remoteWriter, "push", "origin", "main");
  await writeFile(path.join(setup.primary, "app.txt"), "old primary dirty bytes\n", "utf8");
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), "dirty access bytes\n", "utf8");
  const before = {
    head: await git(setup.primary, "rev-parse", "HEAD"),
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
    app: await readFile(path.join(setup.primary, "app.txt")),
    access: await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")),
  };

  const pending = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision,
  });

  assert.equal(pending.localMain, localCommit);
  assert.equal(pending.originMain, publishedRevision);
  assert.equal(pending.diverged, true);
  assert.equal(pending.localContainsPublished, false);
  assert.equal(pending.publishedContainsLocal, true);
  assert.equal(pending.originContainsPublished, true);
  assert.equal(pending.approvalRequired, true);
  assert.ok(pending.commits.some((item) => item.commit === publishedRevision && item.inLocalMain === false));

  const stale = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision,
    approvedLocalMainCommit: publishedRevision,
    approvedOriginMainCommit: publishedRevision,
  });
  assert.equal(stale.approvalRequired, true);

  const approved = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision,
    approvedLocalMainCommit: localCommit,
    approvedOriginMainCommit: publishedRevision,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvalRequired, false);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.deepEqual(await readFile(path.join(setup.primary, "app.txt")), before.app);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), before.access);
});

test("native candidate requires an explicit selected conflict resolution despite an effective dev resolution", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, {
    branch: "HUB-effective-1", file: "app.txt", content: "first\n",
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-effective-2", file: "app.txt", content: "second\n",
  });
  const devRoot = path.join(setup.root, "dev-effective");
  await git(setup.primary, "worktree", "add", "-b", "dev-effective", devRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", firstResult);
  const firstIntegration = await git(devRoot, "rev-parse", "HEAD");
  await assert.rejects(
    git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", secondResult),
  );
  await writeFile(path.join(devRoot, "app.txt"), "first + second\n", "utf8");
  await git(devRoot, "add", "app.txt");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-edit");
  const secondIntegration = await git(devRoot, "rev-parse", "HEAD");

  const request = {
    planRevision: "plan-effective-deltas",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-effective-1",
      taskRevision: 4,
      resultCommit: firstResult,
      integrations: [{ commit: firstIntegration, parent: setup.baseCommit, order: 1 }],
    }, {
      taskId: "task-effective-2",
      taskRevision: 6,
      resultCommit: secondResult,
      integrations: [{ commit: secondIntegration, parent: firstIntegration, order: 2 }],
    }],
  };
  await assert.rejects(setup.service.prepareCandidate(request), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT");
    return true;
  });
  assert.equal(await git(devRoot, "show", "HEAD:app.txt"), "first + second");
});

test("release candidate three-way applies an Await delta over a later non-overlapping main change", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "app.txt"), "task-base\nstable\nmain-base\n", "utf8");
  const taskBase = await commit(setup.primary, "task base");
  await git(setup.primary, "push", "origin", "main");
  const taskRoot = path.join(setup.root, "task-three-way");
  const devRoot = path.join(setup.root, "dev-three-way");
  await git(setup.primary, "worktree", "add", "-b", "HUB-three-way", taskRoot, taskBase);
  await git(setup.primary, "worktree", "add", "-b", "dev-three-way", devRoot, taskBase);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await writeFile(path.join(taskRoot, "app.txt"), "task-change\nstable\nmain-base\n", "utf8");
  const resultCommit = await commit(taskRoot, "task change");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", resultCommit);
  const integrationCommit = await git(devRoot, "rev-parse", "HEAD");
  await writeFile(path.join(setup.primary, "app.txt"), "task-base\nstable\nmain-change\n", "utf8");
  await commit(setup.primary, "main advances independently");
  await git(setup.primary, "push", "origin", "main");

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-three-way",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-three-way",
      taskRevision: 8,
      baseCommit: taskBase,
      resultCommit,
      integrations: [{ commit: integrationCommit, parent: taskBase, order: 1 }],
    }],
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:app.txt`),
    "task-change\nstable\nmain-change");
});

test("failed PreRelease rebuild preserves the last good branch and checkpoint", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, {
    branch: "HUB-atomic-first", file: "app.txt", content: "first\n",
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-atomic-second", file: "app.txt", content: "second\n",
  });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-atomic-first",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit: firstResult }],
  });
  const checkpointFile = path.join(setup.dataDir, "release-repositories", path.basename(path.dirname(first.releaseRoot)), "checkpoint.json");
  const checkpointBefore = JSON.parse(await readFile(checkpointFile, "utf8"));

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-atomic-conflict",
      projectRoot: setup.primary,
      frozenTasks: [
        { taskId: "task-first", taskRevision: 2, resultCommit: firstResult },
        { taskId: "task-second", taskRevision: 3, resultCommit: secondResult },
      ],
    }),
    { code: "RELEASE_NATIVE_MERGE_CONFLICT" },
  );

  assert.equal(await git(first.releaseRoot, "rev-parse", "refs/heads/PreRelease"), first.preReleaseHead);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(first.releaseRoot, "status", "--porcelain=v1"), "");
  assert.deepEqual(JSON.parse(await readFile(checkpointFile, "utf8")), checkpointBefore);
});

test("candidate validation failure cannot replace the last good PreRelease", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, { branch: "HUB-cas-first" });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-cas-first",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit: firstResult }],
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-cas-second", file: "second.txt", content: "second\n",
  });

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-cas-stale",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-second", taskRevision: 4, resultCommit: secondResult }],
      validateBeforeCommit: async () => { throw new Error("release plan revision changed"); },
    }),
    /release plan revision changed/u,
  );

  assert.equal(await git(first.releaseRoot, "rev-parse", "refs/heads/PreRelease"), first.preReleaseHead);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(first.releaseRoot, "status", "--porcelain=v1"), "");
});









test("an unmarked repository at the managed clone path is never adopted", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const releaseRoot = path.join(
    setup.dataDir,
    "release-repositories",
    taskRepositoryKey(setup.primary),
    "repository",
  );
  await mkdir(path.dirname(releaseRoot), { recursive: true });
  await git(path.dirname(releaseRoot), "clone", "--no-checkout", setup.primary, releaseRoot);

  await assert.rejects(
    setup.service.prepareCandidate({
      planRevision: "plan-unmarked",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-unmarked", taskRevision: 2, resultCommit }],
    }),
    /unmarked release repository requires explicit migration/u,
  );
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), setup.baseCommit);
});

test("startup audits a detached registered primary and linked holder with an empty data directory", async (context) => {
  const setup = await fixture(context);
  const legacyRoot = path.join(setup.root, "legacy-prerelease-holder");
  await git(setup.primary, "worktree", "add", "-b", "PreRelease", legacyRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", legacyRoot).catch(() => {}));
  await git(setup.primary, "checkout", "--detach", setup.baseCommit);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-1",
      registrationSource: "runtime_default",
      projectRoot: setup.primary,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].source, "registered_workspace");
  assert.equal(reconciliation.repositories[0].workspaceId, "workspace-1");
  assert.equal(reconciliation.repositories[0].registrationSource, "runtime_default");
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.match(reconciliation.repositories[0].reason, /attached to refs\/heads\/main/u);
  assert.equal(reconciliation.repositories[0].primary.branch, null);
  assert.ok(reconciliation.repositories[0].primary.legacyLinkedHolders.some(
    (item) => path.resolve(item.path) === path.resolve(legacyRoot),
  ));
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.match(await git(setup.primary, "worktree", "list", "--porcelain"), /legacy-prerelease-holder/u);
  await assert.rejects(stat(path.join(setup.dataDir, "release-repositories")), { code: "ENOENT" });
});

test("startup counts a registered runtime root even when it is not a Git repository", async (context) => {
  const setup = await fixture(context);
  const runtimeRoot = path.join(setup.root, "runtime-default-project");
  await mkdir(runtimeRoot, { recursive: true });

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-runtime-default",
      registrationSource: "runtime_default",
      projectRoot: runtimeRoot,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].source, "registered_workspace");
  assert.equal(reconciliation.repositories[0].registrationSource, "runtime_default");
  assert.equal(reconciliation.repositories[0].projectRoot, runtimeRoot);
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.match(reconciliation.repositories[0].reason, /not a git repository/u);
});

test("startup rejects an orphan unmarked clone at the exact managed release path", async (context) => {
  const setup = await fixture(context);
  const releaseRoot = path.join(
    setup.dataDir,
    "release-repositories",
    taskRepositoryKey(setup.primary),
    "repository",
  );
  await mkdir(path.dirname(releaseRoot), { recursive: true });
  await git(path.dirname(releaseRoot), "clone", "--no-checkout", setup.primary, releaseRoot);
  const primaryBefore = {
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    head: await git(setup.primary, "rev-parse", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
    team: await readFile(path.join(setup.primary, ".team", "participant.json")),
    access: await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")),
  };
  const orphanBefore = {
    head: await git(releaseRoot, "rev-parse", "HEAD"),
    status: await git(releaseRoot, "status", "--porcelain=v1"),
  };

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-orphan-clone",
      registrationSource: "workspace_setting",
      projectRoot: setup.primary,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.equal(reconciliation.repositories[0].releaseRoot, releaseRoot);
  assert.equal(reconciliation.repositories[0].checkpointPresent, false);
  assert.match(reconciliation.repositories[0].reason, /orphan managed release repository/u);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), primaryBefore.branch);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), primaryBefore.head);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), primaryBefore.status);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), primaryBefore.team);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), primaryBefore.access);
  assert.equal(await git(releaseRoot, "rev-parse", "HEAD"), orphanBefore.head);
  assert.equal(await git(releaseRoot, "status", "--porcelain=v1"), orphanBefore.status);
  await assert.rejects(stat(path.join(path.dirname(releaseRoot), "checkpoint.json")), { code: "ENOENT" });
});

test("dirty primary bytes, retry checkpoint and legacy linked holder remain untouched", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const legacyRoot = path.join(setup.root, "legacy-prerelease-holder");
  await git(setup.primary, "worktree", "add", "-b", "PreRelease", legacyRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", legacyRoot).catch(() => {}));
  const teamBytes = Buffer.from("team-intentional-local\r\n", "utf8");
  const accessBytes = Buffer.from("access-intentional-local\r\n", "utf8");
  await writeFile(path.join(setup.primary, ".team", "participant.json"), teamBytes);
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), accessBytes);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");
  const request = {
    planRevision: "plan-dirty-retry",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-dirty", taskRevision: 2, resultCommit }],
  };

  const first = await setup.service.prepareCandidate(request);
  const retry = await setup.service.prepareCandidate(request);

  assert.equal(retry.reused, true);
  assert.equal(retry.preReleaseHead, first.preReleaseHead);
  assert.equal(retry.manifestHash, first.manifestHash);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), teamBytes);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), accessBytes);
  assert.ok(first.legacyLinkedHolders.some((item) => path.resolve(item.path) === path.resolve(legacyRoot)));
  assert.match(await git(setup.primary, "worktree", "list", "--porcelain"), /legacy-prerelease-holder/u);
  const manifest = JSON.parse(await readFile(first.manifestFile, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.tasks[0].taskId, "task-dirty");
  assert.equal(manifest.tasks[0].resultCommit, resultCommit);
  assert.equal(manifest.tasks[0].integrations.length, 0);
});





// HUB-204: выбранная зависимость входит ровно один раз, невыбранная не входит.
async function dependencyFixture(setup, context, { selectDependency }) {
  const depRoot = path.join(setup.root, "task-dependency");
  await git(setup.primary, "worktree", "add", "-b", "HUB-dependency", depRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", depRoot).catch(() => {}));
  await writeFile(path.join(depRoot, "dependency.txt"), "dependency\n", "utf8");
  const dependencyResult = await commit(depRoot, "dependency");

  // The Task starts at agreed main and explicitly merges the selected dependency.
  const dependentRoot = path.join(setup.root, "task-dependent");
  await git(setup.primary, "worktree", "add", "-b", "HUB-dependent", dependentRoot, setup.baseCommit);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", dependentRoot).catch(() => {}));
  await git(dependentRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependencyResult);
  await writeFile(path.join(dependentRoot, "dependent.txt"), "dependent\n", "utf8");
  const dependentResult = await commit(dependentRoot, "dependent");

  const devRoot = path.join(setup.root, "dev-dependency");
  await git(setup.primary, "worktree", "add", "-b", "dev-dependency", devRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependencyResult);
  const dependencyIntegration = await git(devRoot, "rev-parse", "HEAD");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependentResult);
  const dependentIntegration = await git(devRoot, "rev-parse", "HEAD");

  const dependencyTask = {
    taskId: "task-dependency",
    taskRevision: 2,
    baseCommit: setup.baseCommit,
    resultCommit: dependencyResult,
    integrations: [{ commit: dependencyIntegration, parent: setup.baseCommit, order: 1 }],
  };
  const dependentTask = {
    taskId: "task-dependent",
    taskRevision: 3,
    baseCommit: setup.baseCommit,
    resultCommit: dependentResult,
    integrations: [{ commit: dependentIntegration, parent: dependencyIntegration, order: 2 }],
  };
  return { frozenTasks: selectDependency ? [dependencyTask, dependentTask] : [dependentTask] };
}

test("selected dependency and its dependent Task are each included exactly once", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: true });

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-dependency-selected",
    projectRoot: setup.primary,
    frozenTasks: scenario.frozenTasks,
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependency.txt`), "dependency");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependent.txt`), "dependent");
  const names = (await git(candidate.releaseRoot, "diff", "--name-only",
    setup.baseCommit, candidate.preReleaseHead)).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, ["dependency.txt", "dependent.txt"]);
});

test("real nested Task evidence projects the selected dependency once before its dependent changes", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "projection.txt"), "slot=base\n", "utf8");
  setup.baseCommit = await commit(setup.primary, "projection base");
  await git(setup.primary, "push", "origin", "main");

  const dependencyId = "20000000-0000-0000-0000-000000000003";
  const dependentId = "20000000-0000-0000-0000-000000000004";
  const releaseOwnerId = "20000000-0000-0000-0000-000000000016";
  const dependency = await registeredTaskBranch(setup, context, {
    taskId: dependencyId,
    startCommit: setup.baseCommit,
  });
  await writeFile(path.join(dependency.taskRoot, "projection.txt"), "slot=dependency\n", "utf8");
  const dependencyResult = await commit(dependency.taskRoot, "selected dependency");

  const dependent = await registeredTaskBranch(setup, context, {
    taskId: dependentId,
    startCommit: dependencyResult,
    baseCommit: setup.baseCommit,
  });
  await writeFile(path.join(dependent.taskRoot, "dependent.txt"), "dependent\n", "utf8");
  const dependentResult = await commit(dependent.taskRoot, "selected dependent");

  const taskGit = new TaskGitWorkspaceService({ dataDir: setup.dataDir });
  const dev = await taskGit.prepareDev(setup.primary);
  await writeFile(path.join(dev.projectRoot, "projection.txt"), "slot=dependency\n", "utf8");
  await writeFile(path.join(dev.projectRoot, "foreign.txt"), "must-not-release\n", "utf8");
  await commit(dev.projectRoot, "equivalent dependency with foreign context");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependencyResult);
  const dependencyIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  assert.equal(await git(dev.projectRoot, "diff", `${dependencyIntegration}^1`, dependencyIntegration), "");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependentResult);

  const releaseOwnerBase = await git(dev.projectRoot, "rev-parse", "HEAD");
  assert.notEqual(releaseOwnerBase, dependentResult);
  const releaseOwner = await registeredTaskBranch(setup, context, {
    taskId: releaseOwnerId,
    startCommit: dependentResult,
    baseCommit: setup.baseCommit,
  });
  await writeFile(path.join(releaseOwner.taskRoot, "projection.txt"), "slot=release-owner\n", "utf8");
  await writeFile(path.join(releaseOwner.taskRoot, "release-owner.txt"), "release-owner\n", "utf8");
  const releaseOwnerResult = await commit(releaseOwner.taskRoot, "dependent release owner");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", releaseOwnerResult);

  const tasks = [
    { taskId: dependencyId, taskRevision: 3, projectRoot: setup.primary,
      branch: dependency.branch, resultCommit: dependencyResult },
    { taskId: dependentId, taskRevision: 4, projectRoot: setup.primary,
      branch: dependent.branch, resultCommit: dependentResult },
    { taskId: releaseOwnerId, taskRevision: 16, projectRoot: setup.primary,
      branch: releaseOwner.branch, resultCommit: releaseOwnerResult },
  ];
  const evidence = await taskGit.releaseIntegrationEvidence({ projectRoot: setup.primary, tasks });
  const selectedDependency = evidence.tasks.find((task) => task.taskId === dependencyId);
  const selectedDependent = evidence.tasks.find((task) => task.taskId === dependentId);
  assert.deepEqual(selectedDependency.integrations.map((item) => item.commit), [dependencyIntegration]);
  assert.equal(selectedDependent.integrations.some((item) => item.commit === dependencyIntegration), false);

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-real-nested-evidence",
    projectRoot: setup.primary,
    frozenTasks: evidence.tasks,
  });
  assert.equal(JSON.parse(await readFile(candidate.manifestFile, "utf8")).compositionPolicy,
    "main-selected-git-merge-v1");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:projection.txt`),
    "slot=release-owner");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependent.txt`), "dependent");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:release-owner.txt`),
    "release-owner");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:foreign.txt`));
  const names = (await git(candidate.releaseRoot, "diff", "--name-only",
    setup.baseCommit, candidate.preReleaseHead)).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, ["dependent.txt", "projection.txt", "release-owner.txt"]);

  await assert.rejects(readFile(path.join(candidate.releaseRoot, "foreign.txt")));
});

test("separately integrated current Tasks do not claim their shared historical integration", async (context) => {
  const setup = await fixture(context);
  const sharedRoot = path.join(setup.root, "task-shared-lineage");
  await git(setup.primary, "worktree", "add", "-b", "shared-lineage", sharedRoot, setup.baseCommit);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", sharedRoot).catch(() => {}));
  await writeFile(path.join(sharedRoot, "shared.txt"), "shared\n", "utf8");
  const sharedCommit = await commit(sharedRoot, "shared ancestor");

  const leftId = "30000000-0000-0000-0000-000000000001";
  const rightId = "30000000-0000-0000-0000-000000000002";
  const left = await registeredTaskBranch(setup, context, { taskId: leftId, startCommit: sharedCommit });
  const right = await registeredTaskBranch(setup, context, { taskId: rightId, startCommit: sharedCommit });
  await writeFile(path.join(left.taskRoot, "left.txt"), "left\n", "utf8");
  await writeFile(path.join(right.taskRoot, "right.txt"), "right\n", "utf8");
  const leftResult = await commit(left.taskRoot, "left result");
  const rightResult = await commit(right.taskRoot, "right result");

  const taskGit = new TaskGitWorkspaceService({ dataDir: setup.dataDir });
  const dev = await taskGit.prepareDev(setup.primary);
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", sharedCommit);
  const sharedIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", leftResult);
  const leftIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", rightResult);
  const rightIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");

  const evidence = await taskGit.releaseIntegrationEvidence({
    projectRoot: setup.primary,
    tasks: [
      { taskId: leftId, taskRevision: 1, projectRoot: setup.primary,
        branch: left.branch, resultCommit: leftResult },
      { taskId: rightId, taskRevision: 1, projectRoot: setup.primary,
        branch: right.branch, resultCommit: rightResult },
    ],
  });
  assert.deepEqual(evidence.tasks.map(task => task.integrations.map(entry => entry.commit)),
    [[leftIntegration], [rightIntegration]]);
  assert.equal(evidence.tasks.some(task => task.integrations.some(entry => entry.commit === sharedIntegration)), false);
});

test("an unselected dependency never reaches the release through its dependent Task", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: false });

  await assert.rejects(setup.service.prepareCandidate({
    planRevision: "plan-dependency-excluded",
    projectRoot: setup.primary,
    frozenTasks: scenario.frozenTasks,
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await git(setup.primary, "rev-parse", "main"), setup.baseCommit);
});





// This exercises finite real Git histories, not a latency contract. An overall
// stopwatch can cancel progressing Git work and start cleanup before it drains.
// Keep command-level failure handling and await the complete scenario instead.


test("prepared candidate natively composes an additional exact correction", async (context) => {
  const setup = await fixture(context);
  const staleResult = await taskResult(setup, context, {
    branch: "HUB-correction-stale", file: "AgentHub/shared.txt", content: "stale\n",
  });
  const staleTask = {
    taskId: "task-stale", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: staleResult,
    integrations: [{ commit: staleResult, parent: setup.baseCommit, order: 1 }],
  };
  const accepted = await setup.service.prepareCandidate({
    planRevision: "plan-correction-old", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask],
  });
  const correctionRoot = path.join(setup.root, "task-correction");
  await git(setup.primary, "worktree", "add", "-b", "HUB-correction", correctionRoot, staleResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", correctionRoot).catch(() => {}));
  await writeFile(path.join(correctionRoot, "AgentHub", "shared.txt"), "fixed\n");
  const correctionResult = await commit(correctionRoot, "exact correction");
  const correctionTask = {
    taskId: "task-correction", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: correctionResult,
    integrations: [{ commit: correctionResult, parent: staleResult, order: 2 }],
  };
  const refreshed = await setup.service.prepareCandidate({
    planRevision: "plan-correction-new", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask, correctionTask],
  });
  const manifest = JSON.parse(await readFile(refreshed.manifestFile, "utf8"));
  assert.equal(manifest.candidateReuse, undefined);
  assert.equal(manifest.compositionPolicy, "main-selected-git-merge-v1");
  assert.equal(manifest.tasks.find(task => task.taskId === correctionTask.taskId).resultCommit, correctionResult);
  assert.equal(await git(refreshed.releaseRoot, "show", `${refreshed.preReleaseHead}:AgentHub/shared.txt`), "fixed");
  assert.deepEqual((await git(refreshed.releaseRoot, "diff", "--name-only", accepted.preReleaseHead,
    refreshed.preReleaseHead)).split("\n").filter(Boolean), ["AgentHub/shared.txt"]);
});

test("operation lineage rejects an unrelated result and accepts a descendant net correction", async (context) => {
  const setup = await fixture(context);
  const neighborResult = await taskResult(setup, context, {
    branch: "HUB-lineage-neighbor", file: "AgentHub/neighbor.txt", content: "neighbor\n",
  });
  const oldResult = await taskResult(setup, context, {
    branch: "HUB-lineage-old", file: "AgentHub/selected.txt", content: "obsolete-r1\n",
  });
  const unrelatedResult = await taskResult(setup, context, {
    branch: "HUB-lineage-unrelated", file: "AgentHub/selected.txt", content: "unrelated-r2\n",
  });
  const neighborTask = {
    taskId: "task-neighbor", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: neighborResult,
    integrations: [{ commit: neighborResult, parent: setup.baseCommit, order: 1 }],
  };
  const unrelatedTask = {
    taskId: "task-owner", taskRevision: 2, baseCommit: setup.baseCommit, resultCommit: unrelatedResult,
    integrations: [{ commit: unrelatedResult, parent: setup.baseCommit, order: 2 }],
  };
  const unrelatedCandidate = await setup.service.prepareCandidate({
    planRevision: "plan-lineage-unrelated", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [neighborTask, unrelatedTask],
  });
  await assert.rejects(setup.service.assertSelectedResultLineage({
    candidate: unrelatedCandidate,
    previousSelectedResults: [{ taskId: "task-owner", resultCommit: oldResult }],
  }), (error) => {
    assert.equal(error.code, "RELEASE_RESULT_LINEAGE_MISMATCH");
    assert.equal(error.taskId, "task-owner");
    assert.equal(error.priorResultCommit, oldResult);
    assert.equal(error.resultCommit, unrelatedResult);
    return true;
  });

  const correctionRoot = path.join(setup.root, "task-lineage-correction");
  await git(setup.primary, "worktree", "add", "-b", "HUB-lineage-correction", correctionRoot, oldResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", correctionRoot).catch(() => {}));
  await writeFile(path.join(correctionRoot, "AgentHub", "selected.txt"), "corrected-r2\n", "utf8");
  const correctionResult = await commit(correctionRoot, "descendant correction");
  const correctionTask = {
    taskId: "task-owner", taskRevision: 3, baseCommit: setup.baseCommit, resultCommit: correctionResult,
    integrations: [
      { commit: oldResult, parent: setup.baseCommit, order: 1 },
      { commit: correctionResult, parent: oldResult, order: 2 },
    ],
  };
  const correctedCandidate = await setup.service.prepareCandidate({
    planRevision: "plan-lineage-corrected", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [neighborTask, correctionTask],
  });
  await assert.doesNotReject(setup.service.assertSelectedResultLineage({
    candidate: correctedCandidate,
    previousSelectedResults: [{ taskId: "task-owner", resultCommit: oldResult }],
  }));
  const corrected = await git(
    correctedCandidate.releaseRoot, "show", `${correctedCandidate.preReleaseHead}:AgentHub/selected.txt`,
  );
  assert.equal(corrected, "corrected-r2");
  assert.equal(corrected.includes("obsolete-r1"), false);
  assert.equal(await git(
    correctedCandidate.releaseRoot, "show", `${correctedCandidate.preReleaseHead}:AgentHub/neighbor.txt`,
  ), "neighbor");
});

test("prepared candidate rejects correction-owned publication metadata", async (context) => {
  const setup = await fixture(context);
  const staleResult = await taskResult(setup, context, {
    branch: "HUB-metadata-stale", file: "AgentHub/shared.txt", content: "stale\n",
  });
  const staleTask = {
    taskId: "task-stale", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: staleResult,
    integrations: [{ commit: staleResult, parent: setup.baseCommit, order: 1 }],
  };
  const accepted = await setup.service.prepareCandidate({
    planRevision: "plan-metadata-old", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask],
  });
  const correctionRoot = path.join(setup.root, "task-metadata-correction");
  await git(setup.primary, "worktree", "add", "-b", "HUB-metadata-correction", correctionRoot, staleResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", correctionRoot).catch(() => {}));
  await writeFile(path.join(correctionRoot, "AgentHub", "package.json"), "{\"version\":\"forbidden\"}\n");
  const correctionResult = await commit(correctionRoot, "forbidden release metadata correction");
  const correctionTask = {
    taskId: "task-correction", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: correctionResult,
    integrations: [{ commit: correctionResult, parent: staleResult, order: 2 }],
  };
  await assert.rejects(setup.service.prepareCandidate({
    planRevision: "plan-metadata-new", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask, correctionTask],
  }), /changes release-owned package-version metadata: AgentHub\/package\.json/);
  assert.equal(await git(accepted.releaseRoot, "rev-parse", "PreRelease"), accepted.preReleaseHead);
});



test("prepared readback retains integration evidence for exact native validation", async context => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const integrations = [{ commit: resultCommit, parent: setup.baseCommit, order: 7 }];
  const request = { projectRoot: setup.primary, workspaceId: "integration-readback",
    planRevision: "integration-readback-plan", approvedBaseCommit: setup.baseCommit,
    baseProvenance: { schemaVersion: 1, kind: "agreed-main-native-git-v1",
      publishedBaseCommit: setup.baseCommit, agreedMainCommit: setup.baseCommit },
    frozenTasks: [{ taskId: "integration-readback-task", taskRevision: 3,
      baseCommit: setup.baseCommit, resultCommit, integrations }] };
  const candidate = await setup.service.prepareCandidate(request);
  const checkpoint = await readFile(path.join(path.dirname(candidate.manifestFile), "..", "checkpoint.json"));
  const manifest = await readFile(candidate.manifestFile);
  const readback = await setup.service.frozenCandidate(setup.primary);
  assert.deepEqual(readback.manifest.tasks[0].integrations, integrations);
  const exact = { ...request, frozenTasks: readback.manifest.tasks };
  const validated = await setup.service.validateCandidate(exact);
  assert.equal(validated.status, "validated");
  assert.equal(validated.tree, readback.tree);
  for (const field of ["commit", "parent", "order"]) {
    const tasks = structuredClone(readback.manifest.tasks);
    tasks[0].integrations[0][field] = field === "order" ? 8 : "f".repeat(40);
    await assert.rejects(setup.service.validateCandidate({ ...request, frozenTasks: tasks }),
      { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  }
  assert.deepEqual(await readFile(candidate.manifestFile), manifest);
  assert.deepEqual(await readFile(path.join(path.dirname(candidate.manifestFile), "..", "checkpoint.json")), checkpoint);
  assert.equal((await setup.service.frozenCandidate(setup.primary)).preReleaseHead, candidate.preReleaseHead);
});
