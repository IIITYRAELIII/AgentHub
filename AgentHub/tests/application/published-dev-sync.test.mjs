import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { ReleaseOperationFinalization } from "../../src/application/release-operation-finalization.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { executeRelease } from "../../release.mjs";
import { nativeMergeBaseFields } from "../../src/infrastructure/filesystem/native-release-merge.mjs";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function commit(root, message) {
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function fixture(t, { multipleBases = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pds-"));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary);
  await git(primary, "init", "-b", "main");
  await git(primary, "config", "core.autocrlf", "false");
  await writeFile(path.join(primary, "shared.txt"), "base\n");
  await writeFile(path.join(primary, "virtual-base.txt"), "original\n");
  const base = await commit(primary, "base");
  const common = [];
  if (multipleBases) {
    // Five independent results integrated in opposite orders. No intermediate
    // merge is common: Git must recursively combine all five true merge bases.
    for (let index = 0; index < 5; index++) {
      await git(primary, "checkout", "-b", `result-${index}`, base);
      await writeFile(path.join(primary, `selected-${index}.txt`), `result ${index}\n`);
      if (index === 0) await writeFile(path.join(primary, "virtual-base.txt"), "common selected value\n");
      common.push(await commit(primary, `selected result ${index}`));
    }
    await git(primary, "checkout", "main");
  }
  let fault = null, nativeEffects = 0, primaryChecks = 0, deliveries = 0;
  const databaseFile = path.join(root, "hub.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const boardStore = new TaskBoardStore({ databaseFile });
  const board = new TaskBoardService({ store: boardStore, workspaceCatalog: catalog });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Sync", settings: { workingDirectory: primary } }));
  const rmStream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } }));
  const reviewer = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Reviewer", settings: { model: "gpt-6.1-sol" } }));
  for (const [stream, thread] of [[rmStream, "rm-thread"], [reviewer, "reviewer-thread"]]) {
    await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: thread, streamId: stream.id }));
  }
  const selected = boardStore.create({ text: "Already published", bucket: "workspace", workspaceId: workspace.id });
  const publication = { generation: "durable-original-publication", repositories: [] };
  const taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication,
    recordTiming: () => {}, runCommand: async (args, options) => {
      const result = await runTaskGitCommand(args, options);
      const onDev = dev && path.resolve(options.cwd).toLowerCase() === path.resolve(dev.projectRoot).toLowerCase();
      if (onDev && args[0] === "update-ref") nativeEffects++;
      if (onDev && args[0] === fault && (fault !== "symbolic-ref" || args[1] === "HEAD")) {
        fault = null;
        throw new Error("lost actual owned Git reply");
      }
      return result;
    } });
  let dev;
  dev = await taskGit.prepareDev(primary);
  for (const result of common) await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@local.invalid",
    "merge", "--no-ff", "-m", "ordinary Test integration", result);
  if (multipleBases) await writeFile(path.join(dev.projectRoot, "virtual-base.txt"), "original\n");
  await writeFile(path.join(dev.projectRoot, "shared.txt"), "later Test\n");
  await writeFile(path.join(dev.projectRoot, "unselected.txt"), "preserve all later work\n");
  const before = await commit(dev.projectRoot, "later independent Test");
  await git(primary, "checkout", "-b", "published");
  for (const result of [...common].reverse()) await git(primary, "-c", "user.name=Test", "-c", "user.email=test@local.invalid",
    "merge", "--no-ff", "-m", "accepted result integration", result);
  await writeFile(path.join(primary, "shared.txt"), "published\n");
  await writeFile(path.join(primary, "published.txt"), "exact release\n");
  const published = await commit(primary, "published release");
  assert.deepEqual((await git(primary, "merge-base", "--all", before, published)).split(/\r?\n/u).sort(),
    multipleBases ? [...common].sort() : [base]);
  await git(primary, "checkout", "main");
  await git(primary, "update-ref", "refs/remotes/origin/main", published);
  await writeFile(path.join(primary, "private.txt"), "preserved primary bytes\n");
  const primaryIndex = await readFile(path.join(primary, ".git", "index"));
  publication.repositories = [{ root: primary, revision: published }];
  const releaseGit = { verifyPublishedPrimary: async () => {
    primaryChecks++;
    assert.equal(await git(primary, "rev-parse", "HEAD"), base);
    assert.equal(await git(primary, "rev-parse", "main"), base);
    assert.deepEqual(await readFile(path.join(primary, ".git", "index")), primaryIndex);
    return { status: "preserved" };
  } };
  const finalization = new ReleaseOperationFinalization({ taskBoard: {
    completeReleaseOperation: async () => ({ finalized: true, alreadyFinalized: deliveries++ > 0 }),
  }, taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit });
  const store = new ReleaseOperationStore({ dataDir });
  let composed = 0, validated = 0, publishedCount = 0;
  const callbacks = [];
  const operations = new ReleaseOperationService({ store, schedule: callback => callbacks.push(callback),
    // This fixture drives explicit originals; no timer may start unrelated work
    // after its private stores close. This does not change any operation budget.
    retryDelayMs: 3_600_000,
    processAlive: pid => pid === process.pid,
    compose: async () => { composed++; return {
      repositoryBases: [{ repositoryRoot: primary, baseCommit: base }],
      selectedResults: [{ taskId: selected.id, resultCommit: published, tree: await git(primary, "rev-parse", `${published}^{tree}`), acceptanceRevision: 1 }],
      candidates: [{ repositoryRoot: primary, releaseRoot: path.join(root, "frozen"), commit: published,
        tree: await git(primary, "rev-parse", `${published}^{tree}`), manifestHash: "a".repeat(64) }],
    }; },
    validate: async () => { validated++; return { status: "passed" }; },
    publishTarget: async () => { publishedCount++; return { status: "applied", revision: published }; },
    readTarget: async () => ({ status: "not_applied" }),
    finalize: input => finalization.finalize(input),
    synchronizePublishedDev: input => finalization.synchronizePublishedDev(input),
  });
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board,
    workLog: { threadTurns: () => [] }, attachmentDirectory: path.join(root, "attachments"), secret: "synthetic-sync",
    taskLifecycle: {}, taskGitWorkspaces: taskGit, releasePreflight: { preflight: () => assert.fail("no preparation") },
    releaseCompleter: { completeRelease: () => assert.fail("no publication") }, releaseOperations: operations,
    reconcilePendingOnStartup: false });
  hub.setStreamMessenger(async () => ({ accepted: true, pending: false }));
  const token = hub.contextToken({ provider: "codex", threadId: "rm-thread" });
  const ack = operations.start({ requestId: "original-release", workspaceId: workspace.id,
    streamId: rmStream.id, threadId: "rm-thread", authorization: { taskIds: [selected.id], validationMode: "full",
      approvedTargets: [{ targetId: "git", kind: "git", repositoryRoot: primary }] } });
  await callbacks.shift()();
  const original = operations.get(ack.operationId);
  assert.equal(original.operation.state, "waiting");
  assert.equal(original.operation.resumeState, "finalize");
  assert.equal(original.generations.length, 1);
  let sequence = 0;
  const request = async (overrides = {}) => {
    const current = operations.get(ack.operationId).operation;
    return { operation_id: ack.operationId, request_id: `sync-${++sequence}`,
      expected_revision: current.revision, expected_generation: 1,
      published_dev_sync: { projectRoot: primary, expectedDevCommit: before }, ...overrides };
  };
  const call = async input => {
    const requestFile = path.join(root, `request-${sequence}.json`);
    await writeFile(requestFile, JSON.stringify(input));
    return executeRelease({ action: "continue", requestFile, provider: "codex", threadId: "rm-thread", streamId: rmStream.id }, {
      openRuntime: async () => ({ service: hub, operations: {
        drain: () => assert.fail("native recovery must not wake/drain release"),
        drainAddressed: () => assert.fail("native recovery must not drain on a refusal"),
      }, close() {} }),
    });
  };
  const unchanged = async () => {
    assert.equal(await git(primary, "rev-parse", "HEAD"), base);
    assert.deepEqual(await readFile(path.join(primary, ".git", "index")), primaryIndex);
    assert.equal(await readFile(path.join(primary, "private.txt"), "utf8"), "preserved primary bytes\n");
    assert.equal(await readFile(path.join(dev.projectRoot, "unselected.txt"), "utf8"), "preserve all later work\n");
    assert.deepEqual(operations.get(ack.operationId).generations, original.generations);
    assert.deepEqual(operations.get(ack.operationId).operation.publicationEffects, original.operation.publicationEffects);
    assert.equal(operations.get(ack.operationId).operation.owner, null);
    assert.equal(callbacks.length, 0);
    assert.equal(composed, 1); assert.equal(validated, 1); assert.equal(publishedCount, 1);
  };
  t.after(async () => { boardStore.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { primary, dev, before, published, common, base, publication, operations, hub, catalog, token, ack, request, call,
    unchanged, taskGit, counters: () => ({ nativeEffects, primaryChecks, deliveries }), fault: value => { fault = value; }, callbacks };
}

async function ordinaryRecovery(t, options) {
  const f = await fixture(t, options);
  await assert.rejects(f.call(await f.request({ expected_revision: 0 })), /CAS/u);
  await assert.rejects(f.call(await f.request({ expected_generation: 2 })), /applied original/u);
  await assert.rejects(f.call(await f.request({ test_selection: { mode: "none", ids: [] } })), /exclusive/u);
  const foreignInput = await f.request();
  await assert.rejects(f.hub.call("hub_release_continue", { ...foreignInput,
    context_token: f.hub.contextToken({ provider: "codex", threadId: "reviewer-thread" }) }), /Release Manager/u);
  const refused = await f.call(await f.request());
  assert.equal(refused.devSynchronization.code, "RELEASE_NATIVE_MERGE_CONFLICT");
  assert.equal(await git(f.primary, "rev-parse", "dev"), f.before);
  const nativeRoot = refused.devSynchronization.nativeConflictRoot;
  const automaticTree = (await git(nativeRoot, "merge-tree", "--write-tree", "--name-only", "-z", f.before, f.published)
    .catch(error => String(error.stdout).trim())).split("\0")[0];
  const outside = async tree => (await git(nativeRoot, "ls-tree", "-r", tree)).split(/\r?\n/u)
    .filter(row => !row.endsWith("\tshared.txt"));
  if (options?.multipleBases) {
    const forced = (await git(nativeRoot, "merge-tree", "--write-tree", "--name-only", "-z",
      `--merge-base=${f.common[1]}`, f.before, f.published).catch(error => String(error.stdout).trim())).split("\0")[0];
    assert.equal(await git(nativeRoot, "show", `${automaticTree}:virtual-base.txt`), "original");
    assert.equal(await git(nativeRoot, "show", `${forced}:virtual-base.txt`), "common selected value",
      "one true base loses the later dev reversion, unlike Git's virtual base");
  }
  const journalFile = path.join(path.dirname(nativeRoot), "merge.json");
  const capture = JSON.parse(await readFile(journalFile, "utf8"));
  if (options?.multipleBases) {
    assert.deepEqual(capture.identity.mergeBases, [...f.common].sort());
    assert.equal(Object.hasOwn(capture.identity, "mergeBase"), false);
    // A changed complete set cannot enter even the private native sequencer.
    // The real Git result is untouched; only this fixture's observed response
    // drifts after the owning identity capture.
    const originalCommand = f.taskGit.runCommand;
    let baseReads = 0;
    f.taskGit.runCommand = async (args, commandOptions) => {
      const value = await originalCommand(args, commandOptions);
      if (args[0] === "merge-base" && args[1] === "--all" && ++baseReads > 1) return f.common.slice(0, 4).join("\n");
      return value;
    };
    await assert.rejects(f.call(await f.request()), /merge-base set changed/u);
    f.taskGit.runCommand = originalCommand;
    assert.equal(await git(f.primary, "rev-parse", "dev"), f.before);
    assert.deepEqual(JSON.parse(await readFile(journalFile, "utf8")), capture, "base-set refusal preserves original journal");
  } else {
    assert.equal(capture.identity.mergeBase, f.base);
    assert.equal(Object.hasOwn(capture.identity, "mergeBases"), false, "legacy scalar identity is unchanged");
  }
  await writeFile(path.join(nativeRoot, "shared.txt"), "later Test\npublished\n");
  await commit(nativeRoot, "reviewable complete conflict union");
  const generation = f.publication.generation;
  f.publication.generation = "unrelated-publication";
  const changedPublication = await f.call(await f.request());
  t.diagnostic(JSON.stringify({ changedPublication: changedPublication.devSynchronization }));
  assert.equal(changedPublication.devSynchronization.integrated, false);
  assert.equal(changedPublication.devSynchronization.code, "RELEASE_NATIVE_MERGE_CONFLICT");
  assert.equal(await git(f.primary, "rev-parse", "dev"), f.before);
  f.publication.generation = generation;
  const originalRead = f.taskGit.readPublication;
  let reads = 0;
  f.taskGit.readPublication = async () => ++reads < 3 ? f.publication : { ...f.publication, generation: "late-drift" };
  await assert.rejects(f.call(await f.request()), /publication provenance changed/u);
  f.taskGit.readPublication = originalRead;
  assert.equal(await git(f.primary, "rev-parse", "dev"), f.before);
  await writeFile(path.join(f.dev.projectRoot, "foreign.txt"), "keep\n");
  await assert.rejects(f.call(await f.request()), /dirty|changed|unsaved/u);
  await rm(path.join(f.dev.projectRoot, "foreign.txt")); // retire only this fixture's own foreign file
  // The normal pre-existing dirty guard leaves a diagnostic block; recover it
  // through its existing normal owner, never by deleting the block ourselves.
  await f.taskGit.prepareDev(f.primary);
  const successfulInput = await f.request();
  const result = await f.call(successfulInput);
  assert.equal(result.devSynchronization.integrated, true);
  const target = result.devSynchronization.headCommit;
  assert.deepEqual(await outside(target), await outside(automaticTree), "all clean mode/type/blob entries stay automatic");
  assert.equal(await readFile(path.join(f.dev.projectRoot, "virtual-base.txt"), "utf8"), "original\n");
  assert.equal(await git(f.primary, "show", "-s", "--format=%P", target), `${f.before} ${f.published}`);
  assert.equal(await readFile(path.join(f.dev.projectRoot, "shared.txt"), "utf8"), "later Test\npublished\n");
  for (let index = 0; index < f.common.length; index++) {
    assert.equal(await readFile(path.join(f.dev.projectRoot, `selected-${index}.txt`), "utf8"), `result ${index}\n`);
  }
  assert.equal(await readFile(path.join(f.dev.projectRoot, "published.txt"), "utf8"), "exact release\n");
  const reflog = await git(f.primary, "reflog", "show", "dev");
  assert.deepEqual(await f.call(successfulInput), result, "completed same outer receipt cannot repeat delivery");
  assert.equal((await f.call(await f.request())).devSynchronization.headCommit, target);
  assert.equal(await git(f.primary, "reflog", "show", "dev"), reflog);
  await f.unchanged();
  assert.equal(f.counters().deliveries, 1, "recovery must not repeat Task delivery");
  f.operations.continue(f.ack.operationId);
  await f.callbacks.shift()();
  const done = f.operations.get(f.ack.operationId);
  assert.equal(done.operation.state, "done");
  assert.equal(done.receipts.filter(item => item.stepId === "finalize").at(-1).effect.tasks.alreadyFinalized, true);
  assert.equal(f.counters().deliveries, 2);
}

test("published original native recovery needs no review envelope and preserves later Test and original finalize",
  { timeout: 120_000 }, t => ordinaryRecovery(t));
test("published five merge bases retain their native virtual base without a review approval",
  { timeout: 120_000 }, t => ordinaryRecovery(t, { multipleBases: true }));

for (const [stage, multipleBases] of [["checkout", false], ["update-ref", false], ["symbolic-ref", false], ["update-ref", true]]) {
  test(`published native original recovers lost ${stage} reply with one dev CAS${multipleBases ? " and five bases" : ""}`, { timeout: 120_000 }, async t => {
    const f = await fixture(t, { multipleBases });
    const refused = await f.call(await f.request());
    const root = refused.devSynchronization.nativeConflictRoot;
    await writeFile(path.join(root, "shared.txt"), "later Test\npublished\n");
    await commit(root, "exact union");
    const expectedCommit = await git(root, "rev-parse", "HEAD");
    f.fault(stage);
    const lostInput = await f.request();
    await assert.rejects(f.call(lostInput), /original effect readback/u);
    const originalUnknown = structuredClone(f.catalog.mcpOperation(lostInput.request_id));
    assert.equal(originalUnknown.status, "unknown");
    await assert.rejects(f.taskGit.prepareDev(f.primary), /original native effect readback/u);
    if (stage === "checkout") {
      await writeFile(path.join(f.dev.projectRoot, "foreign-after-effect.txt"), "foreign bytes\n");
      await assert.rejects(f.call(await f.request()), /foreign state retained/u);
      assert.equal(await readFile(path.join(f.dev.projectRoot, "foreign-after-effect.txt"), "utf8"), "foreign bytes\n");
      await rm(path.join(f.dev.projectRoot, "foreign-after-effect.txt"));
    }
    const result = await f.call(await f.request());
    assert.equal(result.devSynchronization.headCommit, expectedCommit);
    assert.equal(await git(f.dev.projectRoot, "symbolic-ref", "HEAD"), "refs/heads/dev");
    assert.equal(f.counters().nativeEffects, 1);
    assert.deepEqual(f.catalog.mcpOperation(lostInput.request_id), originalUnknown, "successful recovery cannot rewrite an old unknown receipt");
    await f.unchanged();
  });
}

test("native merge-base fields preserve scalar identity and reject ambiguous sets", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.deepEqual(nativeMergeBaseFields(a), { mergeBase: a });
  assert.deepEqual(nativeMergeBaseFields(`${b}\r\n${a}`), { mergeBases: [a, b] });
  for (const invalid of ["", "not-a-commit", `${a}\n${a}`, `${a}\n`, `${a}\n${b.slice(1)}`]) {
    assert.throws(() => nativeMergeBaseFields(invalid), /distinct full Git commit ids/u);
  }
});
