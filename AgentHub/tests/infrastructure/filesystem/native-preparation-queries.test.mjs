import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertNativeTaskHistories } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { readNativeUpstreamAdoptions } from "../../../src/infrastructure/filesystem/native-upstream-adoption.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { assertInstalledLocalSourceBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { LOCAL_SOURCE_BASELINE_PROVENANCE, localSourceSelectionHash } from "../../../src/domain/release-base-provenance.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { createContourExternalEffectsPort } from "../../../src/ports/contour-external-effects.mjs";

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
    const service = new ReleaseGitWorkspaceService({
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
