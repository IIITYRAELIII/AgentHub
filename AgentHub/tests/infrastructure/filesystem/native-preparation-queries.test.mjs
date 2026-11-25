import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { assertNativeTaskHistories, nativeIntegrationRecordFile } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { interstreamAuditContentHash } from "../../../src/domain/interstream-message.mjs";
import { readNativeUpstreamAdoptions } from "../../../src/infrastructure/filesystem/native-upstream-adoption.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { assertInstalledLocalSourceBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { LOCAL_SOURCE_BASELINE_PROVENANCE, localSourceSelectionHash } from "../../../src/domain/release-base-provenance.mjs";
import { TaskIntegrationGitService } from "../../../src/infrastructure/filesystem/task-integration-git.mjs";
import { createContourExternalEffectsPort } from "../../../src/ports/contour-external-effects.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

const exec = promisify(execFile);
async function fixture(t, directory = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-queries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const git = async (args, options = {}) => {
    calls.push(args);
    const pending = exec("git", args, { cwd: root, encoding: "buffer", windowsHide: true });
    pending.child.stdin.end(options.input ?? "");
    const { stdout } = await pending;
    return options.rawOutput ? stdout : stdout.toString("utf8").trim();
  };
  await git(["init", "--initial-branch=main"]);
  const save = async (file, body) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  const commit = async () => {
    await git(["add", "-A"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "query fixture"]);
    return git(["rev-parse", "HEAD"]);
  };
  await save(directory ? `${directory}/entry.json` : "CHANGELOG.md",
    directory === "CHANGELOG.md" ? "agreed notes\n" : JSON.stringify({ version: "2.0.0" }));
  await save("nested/package.json", JSON.stringify({ version: "2.0.0", name: "fixture" }));
  const base = await commit();
  await save("code.txt", "selected result\n");
  const result = await commit();
  return { root, calls, git, save, commit, base, result };
}

for (const method of ["deriveInstalledLocalSourceBaselineForSelection", "validateLocalSourceBaseline"]) {
  test(`installed source contour policy excludes ${method} before authority access`, async t => {
    const f = await fixture(t), exclusions = [];
    const dataDir = path.join(f.root, ".git", "fixture-data");
    const service = new TaskIntegrationGitService({
      dataDir, environment: { LOCALAPPDATA: path.join(f.root, ".git", "fixture-local") },
      contourExternalEffects: createContourExternalEffectsPort(event => exclusions.push(event)),
      readPreparationAuthority: () => { throw new Error("unexpected preparation authority access"); },
      readPreparationOriginal: () => { throw new Error("unexpected original custody access"); },
    });
    await assert.rejects(service[method]({ projectRoot: f.root, planRevision: "fixture", tasks: [],
      publishedRevision: null, provenance: null }), { code: "CONTOUR_EXTERNAL_EFFECT_EXCLUDED" });
    assert.deepEqual(exclusions, [{ skipped: true, status: "excluded", reason: "test-contour-external-effect",
      kind: "release-git", operation: method, targets: [] }]);
    await assert.rejects(readFile(path.join(dataDir, "release-repositories")), { code: "ENOENT" });
    assert.equal(await f.git(["rev-parse", "HEAD"]), f.result);
    assert.equal(await f.git(["status", "--porcelain=v1"]), "");
  });
}

test("adoption namespace is read once per boundary and selected malformed refs never become cached absence", async t => {
  const f = await fixture(t), key = taskRepositoryKey(f.root);
  const tasks = Array.from({ length: 13 }, (_, i) => ({ taskId: `selected-${i}`, baseCommit: f.base, resultCommit: f.result }));
  const read = () => readNativeUpstreamAdoptions({ git: f.git, tasks, repositoryRoot: f.root, localMainCommit: f.base });
  const blob = await f.git(["hash-object", "-w", "--stdin"], { input: "{}\n" });
  await f.git(["update-ref", `refs/agent-hub/upstream-adoptions/unselected/${key}/${f.result}/${f.base}`, blob]);
  f.calls.length = 0;
  assert.deepEqual(await read(), []);
  assert.equal(f.calls.filter(args => args[0] === "for-each-ref").length, 1);
  const ref = `refs/agent-hub/upstream-adoptions/${tasks[0].taskId}/${key}/${f.result}/${f.base}/nested-invalid`;
  await f.git(["update-ref", ref, blob]);
  await assert.rejects(read(), /identity changed/u);
  await f.git(["update-ref", "-d", ref]);
  assert.deepEqual(await read(), []);
  tasks[0] = { ...tasks[0], resultCommit: f.base };
  const current = `refs/agent-hub/upstream-adoptions/${tasks[0].taskId}/${key}/${f.base}/${f.result}`;
  await f.git(["update-ref", current, blob]);
  await assert.rejects(read(), /identity changed/u);
});

test("history uses one metadata diff and retains equal-base object validation and fresh plan checks", async t => {
  const f = await fixture(t);
  const tasks = [{ taskId: "selected", baseCommit: f.base, resultCommit: f.result }];
  const check = () => assertNativeTaskHistories({ git: f.git, baseCommit: f.base, tasks });
  f.calls.length = 0;
  await check();
  assert.equal(f.calls.filter(args => args[0] === "diff").length, 1);
  assert.deepEqual(f.calls.filter(args => args[0] === "merge-base"), [["merge-base", "--is-ancestor", f.base, f.result]]);
  await f.save("nested/package.json", JSON.stringify({ version: "9.9.9" }));
  tasks[0] = { ...tasks[0], resultCommit: await f.commit() };
  await assert.rejects(check(), /package-version metadata/u);
  tasks[0] = { ...tasks[0], resultCommit: f.base };
  await check(); // Empty result still checks its commit object, never literal true.
  const missing = "a".repeat(40);
  await assert.rejects(assertNativeTaskHistories({ git: f.git, baseCommit: missing,
    tasks: [{ taskId: "missing", baseCommit: missing, resultCommit: missing }] }), /main-based result/u);
});

test("native absorption accepts only the exact published parent of the returned source Test", async t => {
  const f = await fixture(t);
  const tree = await f.git(["rev-parse", `${f.result}^{tree}`]);
  const commit = (name, ...parents) => f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]), "-m", name]);
  const published = await commit("published base", f.base);
  const devOnly = await commit("dev only", published);
  const foreign = await commit("unselected side", f.base);
  const survivor = await commit("survivor", published);
  const forward = await commit("returned source with published parent", f.result, published);
  const devMerge = await commit("returned source with dev parent", f.result, devOnly);
  const foreignMerge = await commit("returned source with foreign parent", f.result, foreign);
  const octopus = await commit("returned source with extra parent", f.result, published, foreign);
  const testDevCommit = await commit("retained source Test", devOnly, forward);
  const dataDir = path.join(f.root, ".git", "fixture-data");
  const databaseFile = path.join(dataDir, "journal.sqlite");
  new TaskBoardStore({ databaseFile }).close();
  const journal = new DatabaseSync(databaseFile);
  const tested = JSON.stringify({ task: { workflowStatus: "testing" },
    evidence: { resultCommit: forward, devHeadCommit: testDevCommit } });
  const returned = JSON.stringify({ evidence: { outcome: "returned_for_correction",
    acceptedResult: { resultCommit: forward } } });
  const put = journal.prepare(`INSERT INTO hub_task_lifecycle_outcomes
    (operation_id, task_id, kind, result_json, completed_at_ms) VALUES (?, 'source', 'workflow', ?, ?)`);
  put.run("test", tested, 1);
  put.run("return", returned, 2);
  journal.close();
  const hash = value => createHash("sha256").update(value).digest("hex");
  const retained = nativeIntegrationRecordFile(dataDir, "source", f.root, "test");
  await mkdir(path.dirname(retained), { recursive: true });
  const record = { version: 1, kind: "native-task-integration-v1", phase: "prepared", operationId: "test",
    target: testDevCommit, snapshot: { taskId: "source", headCommit: forward, repositoryRoot: f.root },
    nativeHistoryAuthority: { publishedMetadata: {
      commit: published, tree, repositoryRoot: f.root, generation: "original", recordHash: "d".repeat(64),
    } } };
  await writeFile(retained, JSON.stringify(record));
  const historyAuthority = { bases: [devOnly, foreign], metadataBases: [published],
    publishedHistoryBase: published, dataDir };
  const requestId = "returned-source-handoff";
  const origin = { workspaceId: "workspace", streamId: "stream", provider: "codex", sourceThreadId: "thread", requestId };
  const selection = async (resultCommit, priorCommit, { preserve = false, testOutcomeHash = hash(tested) } = {}) => {
    const sourceCommit = await commit("saved source", resultCommit);
    const absorptionCommit = await commit("survivor absorbs source", survivor, sourceCommit);
    const text = JSON.stringify({ version: 1, kind: "task-absorption-handoff-v1", workspaceId: origin.workspaceId,
      sourceTaskId: "source", sourceTaskRevision: 3, survivorTaskId: "survivor", baseCommit: f.base,
      ...(preserve ? { preservedSourceHead: await commit("later source", sourceCommit) } : {}),
      sourceCommit, sourceTree: tree, survivorParentCommit: survivor, absorptionCommit, saved: true, stopped: true });
    const priorResults = priorCommit ? [{ taskId: "source", projectRoot: f.root, resultCommit: priorCommit,
      testOperationId: "test", returnOperationId: "return", testRevision: 2, returnRevision: 3,
      testOutcomeHash, returnOutcomeHash: hash(returned) }] : undefined;
    const nativeAbsorptionInput = { requestId, text, origin, contentHash: interstreamAuditContentHash(text, { origin }),
      createdAtMs: 1, sourceTaskNumber: "HUB-source", sourceDescriptionSha256: "a".repeat(64), priorResults };
    return { taskId: "survivor", baseCommit: f.base, resultCommit: absorptionCommit, nativeAbsorptionInput };
  };
  const check = async (resultCommit, priorCommit = resultCommit, authority = historyAuthority,
    baseCommit = published, options) => assertNativeTaskHistories({ git: f.git, baseCommit,
    historyAuthority: authority, tasks: [await selection(resultCommit, priorCommit, options)] });
  await check(forward);
  await check(forward, forward, historyAuthority, f.base);
  const advanced = await commit("new publication", devOnly);
  const advancedAuthority = { ...historyAuthority, bases: [advanced], metadataBases: [advanced], publishedHistoryBase: advanced };
  await check(forward, forward, advancedAuthority, f.base);
  await check(forward, forward, historyAuthority, f.base, { preserve: true });
  await check(forward, forward, advancedAuthority, f.base, { preserve: true });
  await assert.rejects(check(forward, forward, advancedAuthority, f.base, { testOutcomeHash: "0".repeat(64) }),
    /immutable prior outcome changed/u);
  await assert.rejects(check(devMerge, devMerge, advancedAuthority, f.base), /explicit historical migration/u);
  await writeFile(retained, JSON.stringify({ ...record, target: devOnly }));
  await assert.rejects(check(forward, forward, advancedAuthority, f.base), /explicit historical migration/u);
  await writeFile(retained, JSON.stringify(record));
  await assert.rejects(check(forward, null), /explicit historical migration/u);
  await assert.rejects(check(forward, f.result), /explicit historical migration/u);
  await assert.rejects(check(forward, foreign), /prior result is not retained/u);
  await assert.rejects(check(forward, forward, { bases: [published, devOnly], metadataBases: [published] }),
    /explicit historical migration/u);
  for (const refused of [devMerge, foreignMerge, octopus]) {
    await assert.rejects(check(refused), /explicit historical migration/u);
  }

  const localAppData = path.join(f.root, ".git", "fixture-local");
  const remote = path.join(f.root, ".git", "fixture-origin.git");
  await f.git(["init", "--bare", "--initial-branch=main", remote]);
  await f.git(["remote", "add", "origin", remote]);
  await f.git(["checkout", "-B", "main", advanced]);
  await f.git(["push", "origin", "main"]);
  await f.save(".git/fixture-local/AgentHub/publication-state.json", JSON.stringify({
    generation: "advanced-publication", repositories: [{ root: f.root, revision: advanced }],
  }));
  const { nativeAbsorptionInput: absorptionInput, ...task } = await selection(forward, forward, { preserve: true });
  const descriptor = { kind: "native-task-integration-v1", taskId: task.taskId, operationId: "survivor-Test",
    expectedTaskRevision: 3, repositoryRoot: f.root, taskBaseCommit: f.base, taskCommit: task.resultCommit,
    devCommit: task.resultCommit, proofCommit: task.resultCommit, proofTree: tree, mainCommit: advanced,
    absorptionInput };
  const service = new TaskIntegrationGitService({ dataDir, environment: { ...process.env, LOCALAPPDATA: localAppData } });
  const request = { planRevision: "fresh-absorption-closure", projectRoot: f.root, workspaceId: "workspace",
    approvedBaseCommit: advanced, frozenTasks: [{ ...task, taskRevision: 4, selectedCompositionRequired: true,
      selectedComposition: { ...descriptor, descriptorHash: hash(JSON.stringify(descriptor)) } }] };
  const journalBefore = await readFile(databaseFile);
  const captureBefore = await readFile(retained);
  const refsBefore = await f.git(["show-ref"]);
  const proof = await service.validateCandidate(request);
  assert.equal(proof.status, "validated");
  assert.equal(proof.baseCommit, advanced);
  assert.deepEqual(proof.mergedTaskIds, [task.taskId]);
  await assert.rejects(readFile(service.releaseRepositoriesRoot), { code: "ENOENT" });
  assert.deepEqual(await readFile(databaseFile), journalBefore);
  assert.deepEqual(await readFile(retained), captureBefore);
  assert.equal(await f.git(["show-ref"]), refsBefore);
  assert.equal(await f.git(["status", "--porcelain"]), "");
});

test("three selected results share only immutable metadata reads inside each fresh proof", async t => {
  const f = await fixture(t);
  await f.save("CHANGELOG.md", "published notes\n");
  await f.save("nested/package.json", JSON.stringify({ version: "3.0.0" }));
  const published = await f.commit();
  const tasks = [];
  for (let i = 0; i < 3; i++) {
    await f.git(["checkout", "--detach", published]);
    await f.save(`result-${i}.txt`, "selected\n");
    tasks.push({ taskId: `selected-${i}`, baseCommit: f.base, resultCommit: await f.commit() });
  }
  const authority = { bases: [published], metadataBases: [published], adoptions: [] };
  const check = () => assertNativeTaskHistories({ git: f.git, baseCommit: published, tasks, historyAuthority: authority });
  f.calls.length = 0;
  await check();
  assert.equal(f.calls.filter(args => args[0] === "cat-file" && args.includes("--batch")).length, 1);
  assert.equal(f.calls.filter(args => args.includes("ls-tree") && args.includes(published)).length, 1);
  assert.equal(f.calls.filter(args => args[0] === "merge-base" && args[2] === f.base && args[3] === published).length, 1);
  await f.save("nested/package.json", JSON.stringify({ version: "9.0.0" }));
  tasks[2] = { ...tasks[2], resultCommit: await f.commit() };
  f.calls.length = 0;
  await assert.rejects(check(), /selected-2 changes release-owned package-version metadata/u);
  assert.equal(f.calls.filter(args => args.includes("ls-tree") && args.includes(published)).length, 1);
});

for (const directory of ["CHANGELOG.md", "package.json", "package-lock.json"]) {
  test(`combined diff retains literal root-directory ownership for ${directory}`, async t => {
    const f = await fixture(t, directory);
    await f.save(`${directory}/entry.json`, directory === "CHANGELOG.md" ? "invented Task notes\n" : JSON.stringify({ version: "9.9.9" }));
    const result = await f.commit();
    await assert.rejects(assertNativeTaskHistories({ git: f.git, baseCommit: f.base,
      tasks: [{ taskId: "directory", baseCommit: f.base, resultCommit: result }] }), /release-owned/u);
  });
}

test("installed source uses one binary-safe object batch and still refuses changed bytes, framing and current authority", async t => {
  const f = await fixture(t), digest = b => createHash("sha256").update(b).digest("hex");
  const origin = path.join(f.root, ".git", "fixture-origin");
  await f.git(["init", "--bare", "--initial-branch=main", origin]);
  await f.git(["remote", "add", "origin", origin]);
  await f.git(["push", "origin", "main"]);
  await f.git(["switch", "-c", "installed-source"]);
  const runtimeRoot = path.join(f.root, ".git", "fixture-runtime"), release = path.join(runtimeRoot, "releases", "repair");
  const files = [];
  for (let i = 0; i < 64; i++) {
    const relative = `files/${i}.bin`, bytes = Buffer.from(`binary-${i}\0\n0123456789 blob 999\n\u0416`);
    await f.save(`AgentHub/${relative}`, bytes);
    await mkdir(path.dirname(path.join(release, relative)), { recursive: true });
    await writeFile(path.join(release, relative), bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  const source = await f.commit(), tree = await f.git(["rev-parse", `${source}^{tree}`]);
  const manifest = Buffer.from(JSON.stringify({ releaseId: "repair", files }));
  await writeFile(path.join(release, "runtime-manifest.json"), manifest);
  const pointer = path.join(runtimeRoot, "current.json"), pointerBytes = Buffer.from(JSON.stringify({ current: "repair" }));
  await writeFile(pointer, pointerBytes);
  const provenance = { schemaVersion: 1, kind: LOCAL_SOURCE_BASELINE_PROVENANCE,
    publishedBaseCommit: f.result, agreedMainCommit: f.result, sourceBaseCommit: source, sourceBaseTree: tree,
    sourcePatchSha256: digest(await f.git(["diff", "--binary", "--full-index", "--no-renames", f.result, source], { rawOutput: true })),
    installedReleaseId: "repair", installedManifestSha256: digest(manifest), planRevision: "batch", selectionHash: localSourceSelectionHash([]) };
  const request = { provenance, git: f.git, primaryMainCommit: f.result, publishedRevision: f.result,
    planRevision: "batch", tasks: [], runtimeRoot };
  const started = performance.now();f.calls.length = 0;
  const result = await assertInstalledLocalSourceBaseline(request);
  const firstCalls = structuredClone(f.calls);
  console.log(JSON.stringify({ proof: "installed-source-64", elapsedMs: performance.now() - started,
    commands: firstCalls.length, show: firstCalls.filter(a => a[0] === "show").length,
    batches: firstCalls.filter(a => a[0] === "cat-file" && a.includes("--batch")).length }));
  assert.equal(result.runtimeFiles, 64);
  assert.equal(firstCalls.filter(a => a[0] === "show").length, 0);
  assert.equal(firstCalls.filter(a => a[0] === "cat-file" && a.includes("--batch")).length, 1);
  for (const corrupt of [b => b.subarray(0, b.length - 1), b => Buffer.concat([b, Buffer.from("foreign")]),
    b => { const out = Buffer.from(b); out[0] = out[0] === 97 ? 98 : 97; return out; },
    b => { const out = Buffer.from(b); out[out.indexOf(10) + 1] ^= 1; return out; }]) {
    await assert.rejects(assertInstalledLocalSourceBaseline({ ...request, git: async (args, options) => {
      const value = await f.git(args, options);
      return args[0] === "cat-file" && args.includes("--batch") ? corrupt(value) : value;
    } }), /Git source batch/u);
  }
  const target = path.join(release, files[0].path), saved = await readFile(target);
  await writeFile(target, Buffer.from("tampered"));
  await assert.rejects(assertInstalledLocalSourceBaseline(request), /installed bytes changed/u);
  await writeFile(target, saved);
  await writeFile(pointer, JSON.stringify({ current: "foreign" }));
  f.calls.length = 0;
  await assert.rejects(assertInstalledLocalSourceBaseline(request), /installed release changed/u);
  assert.equal(f.calls.filter(a => a[0] === "cat-file" && a.includes("--batch")).length, 0);
  await writeFile(pointer, pointerBytes);
  assert.equal((await assertInstalledLocalSourceBaseline(request)).runtimeFiles, 64);
  assert.deepEqual(await readFile(path.join(release, "runtime-manifest.json")), manifest);
  assert.deepEqual(await readFile(pointer), pointerBytes);
});
